// Server-only. OPERATOR TOOLING. Reached only from scripts/.
import "server-only";

import { withTransaction, type TransactionClient } from "../db/pool";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import { upsertLinkedAccount } from "../db/repositories/linked-accounts.repository";
import {
  readAllLegacyBanks,
  readAllLegacyUsers,
  type LegacyBankDocument,
  type LegacyUserDocument,
} from "./appwrite-source";
import {
  fetchAccountMetadata,
  type AccountMetadata,
  type EnrichmentOutcome,
} from "./enrichment";
import { planMigration, type LinkedAccountPlan, type SkippedRecord } from "./mapping";

export type BackfillFailure = {
  kind: "customer" | "account";
  id: string;
  reason: string;
};

export type BackfillReport = {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  source: { users: number; banks: number };
  customers: { created: number; existing: number; failed: number };
  accounts: { created: number; updated: number; failed: number };
  enrichment: { succeeded: number; failed: number };
  skipped: SkippedRecord[];
  failures: BackfillFailure[];
  enrichmentFailures: { legacyBankDocumentId: string; reason: string }[];
};

/** Injectable so the orchestration is testable without Appwrite, Plaid or a DB. */
export type BackfillDeps = {
  readUsers: () => Promise<LegacyUserDocument[]>;
  readBanks: () => Promise<LegacyBankDocument[]>;
  enrich: (input: {
    accessToken: string;
    externalAccountId: string;
  }) => Promise<EnrichmentOutcome>;
  runInTransaction: <T>(fn: (client: TransactionClient) => Promise<T>) => Promise<T>;
  upsertCustomer: typeof upsertBankingCustomer;
  upsertAccount: typeof upsertLinkedAccount;
};

export const defaultDeps: BackfillDeps = {
  readUsers: readAllLegacyUsers,
  readBanks: readAllLegacyBanks,
  enrich: fetchAccountMetadata,
  runInTransaction: withTransaction,
  upsertCustomer: upsertBankingCustomer,
  upsertAccount: upsertLinkedAccount,
};

/** Raised to force a rollback once a dry run has finished its work. */
class DryRunRollback extends Error {
  readonly report: BackfillReport;
  constructor(report: BackfillReport) {
    super("dry run complete; rolling back");
    this.report = report;
  }
}

/**
 * Copy the legacy Appwrite dataset into PostgreSQL.
 *
 * DRY RUN IS A REAL TRANSACTION THAT ROLLS BACK. It is not a simulation that
 * skips the writes: every insert actually executes, so every foreign key,
 * unique index and check constraint is exercised against the real data. A dry
 * run that only prints a plan would happily report success for a dataset the
 * database would reject.
 *
 * The whole backfill runs in ONE transaction. Either the entire legacy dataset
 * lands or none of it does; a half-migrated financial dataset is worse than an
 * un-migrated one because it is no longer obvious which store is authoritative.
 *
 * IDEMPOTENT. Re-running is safe and expected — after a provider outage, after
 * fixing a mapping bug. Existing rows are updated, not duplicated.
 *
 * Enrichment happens BEFORE the transaction opens. Holding a database
 * transaction open across dozens of network calls to Plaid would keep locks for
 * the duration of the slowest provider response.
 */
export async function runBackfill(
  options: { dryRun: boolean },
  deps: BackfillDeps = defaultDeps
): Promise<BackfillReport> {
  const startedAt = new Date().toISOString();

  const [users, banks] = await Promise.all([deps.readUsers(), deps.readBanks()]);
  const plan = planMigration(users, banks);

  // --- provider enrichment, outside the transaction -----------------------
  const enrichmentFailures: BackfillReport["enrichmentFailures"] = [];
  const enriched: {
    account: LinkedAccountPlan;
    metadata: AccountMetadata;
    enrichedOk: boolean;
  }[] = [];
  for (const account of plan.accounts) {
    const outcome = await deps.enrich({
      accessToken: account.accessTokenForEnrichment,
      externalAccountId: account.externalAccountId,
    });
    if (!outcome.ok) {
      enrichmentFailures.push({
        legacyBankDocumentId: account.legacyAppwriteBankDocumentId,
        reason: outcome.reason,
      });
    }
    enriched.push({ account, metadata: outcome.metadata, enrichedOk: outcome.ok });
  }

  const report: BackfillReport = {
    dryRun: options.dryRun,
    startedAt,
    finishedAt: startedAt,
    source: { users: users.length, banks: banks.length },
    customers: { created: 0, existing: 0, failed: 0 },
    accounts: { created: 0, updated: 0, failed: 0 },
    enrichment: {
      succeeded: enriched.filter((e) => e.enrichedOk).length,
      failed: enrichmentFailures.length,
    },
    skipped: plan.skipped,
    failures: [],
    enrichmentFailures,
  };

  const work = async (client: TransactionClient) => {
    // user document id -> PostgreSQL customer UUID
    const customerIds = new Map<string, string>();

    for (const customer of plan.customers) {
      try {
        const { row, created } = await deps.upsertCustomer(customer, client);
        customerIds.set(customer.appwriteUserDocumentId, row.id);
        if (created) report.customers.created += 1;
        else report.customers.existing += 1;
      } catch (error) {
        report.customers.failed += 1;
        report.failures.push({
          kind: "customer",
          id: customer.appwriteUserDocumentId,
          reason: describe(error),
        });
      }
    }

    for (const { account, metadata } of enriched) {
      const customerId = customerIds.get(account.ownerUserDocumentId);
      if (!customerId) {
        report.accounts.failed += 1;
        report.failures.push({
          kind: "account",
          id: account.legacyAppwriteBankDocumentId,
          reason: `owner ${account.ownerUserDocumentId} was not migrated`,
        });
        continue;
      }

      try {
        const { created } = await deps.upsertAccount(
          {
            customerId,
            legacyAppwriteBankDocumentId: account.legacyAppwriteBankDocumentId,
            externalAccountId: account.externalAccountId,
            provider: account.provider,
            displayName: metadata.displayName,
            officialName: metadata.officialName,
            mask: metadata.mask,
            accountType: metadata.accountType,
            accountSubtype: metadata.accountSubtype,
          },
          client
        );
        if (created) report.accounts.created += 1;
        else report.accounts.updated += 1;
      } catch (error) {
        report.accounts.failed += 1;
        report.failures.push({
          kind: "account",
          id: account.legacyAppwriteBankDocumentId,
          reason: describe(error),
        });
      }
    }

    report.finishedAt = new Date().toISOString();

    if (options.dryRun) {
      // Everything above really executed. Undo it.
      throw new DryRunRollback(report);
    }
    return report;
  };

  try {
    return await deps.runInTransaction(work);
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    // withTransaction wraps the thrown error, so unwrap one level.
    const cause = (error as { cause?: unknown })?.cause;
    if (cause instanceof DryRunRollback) return cause.report;
    throw error;
  }
}

/**
 * A short, safe description of a failure.
 *
 * Deliberately not the whole error: a database error message can quote the row
 * that violated a constraint, and a provider error can echo the request.
 */
function describe(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; constraint?: unknown; name?: unknown };
    const parts = [
      typeof e.name === "string" ? e.name : undefined,
      typeof e.code === "string" ? e.code : undefined,
      typeof e.constraint === "string" ? e.constraint : undefined,
    ].filter(Boolean);
    if (parts.length) return parts.join(" / ");
  }
  return "unknown failure";
}
