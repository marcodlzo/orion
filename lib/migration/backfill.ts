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
  type SourceScan,
} from "./appwrite-source";
import {
  fetchAccountMetadata,
  type AccountMetadata,
  type EnrichmentFailureCode,
  type EnrichmentOutcome,
} from "./enrichment";
import { planMigration, type LinkedAccountPlan, type SkippedRecord } from "./mapping";

export type BackfillFailure = {
  kind: "customer" | "account";
  id: string;
  reason: string;
};

/**
 * Evidence that the source was read completely.
 *
 * Counts alone prove nothing — "migrated 12 customers" is equally true of a
 * complete read and of a paginated read that stopped after one page. These are
 * the numbers that make the difference visible.
 */
export type SourceEvidence = {
  users: { scanned: number; reportedTotal: number; pages: number; complete: boolean };
  banks: { scanned: number; reportedTotal: number; pages: number; complete: boolean };
  complete: boolean;
};

export type BackfillReport = {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  source: SourceEvidence;
  customers: { created: number; existing: number; failed: number };
  accounts: { created: number; updated: number; failed: number; blocked: number };
  enrichment: { succeeded: number; failed: number };
  skipped: SkippedRecord[];
  failures: BackfillFailure[];
  enrichmentFailures: {
    legacyBankDocumentId: string;
    code: EnrichmentFailureCode;
    reason: string;
    /** True when the account was NOT migrated at all. */
    blocked: boolean;
  }[];
};

/** Injectable so the orchestration is testable without Appwrite, Plaid or a DB. */
export type BackfillDeps = {
  readUsers: () => Promise<SourceScan<LegacyUserDocument>>;
  readBanks: () => Promise<SourceScan<LegacyBankDocument>>;
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

type EnrichedAccount = {
  account: LinkedAccountPlan;
  metadata: AccountMetadata;
  currency: string;
  metadataKnown: boolean;
};

/**
 * Copy the legacy Appwrite dataset into PostgreSQL.
 *
 * DRY RUN IS THE REAL WRITE PATH. There is no second validation-only algorithm:
 * dry run and commit execute the identical repository calls inside an identical
 * transaction, and differ only in whether it ends with COMMIT or ROLLBACK.
 * Every foreign key, unique index and check constraint therefore executes
 * against the real data during a dry run. A separate "validation" path would be
 * a model of the write path, and a model can be wrong in exactly the way that
 * matters.
 *
 * The whole backfill runs in ONE transaction. Either the entire legacy dataset
 * lands or none of it does; a half-migrated financial dataset is worse than an
 * un-migrated one because it is no longer obvious which store is authoritative.
 *
 * IDEMPOTENT. Re-running is safe and expected — after a provider outage, after
 * fixing a mapping bug. Existing rows keep their UUIDs and their identity
 * columns; only metadata the provider actually returned is refreshed.
 *
 * NO NETWORK INSIDE THE TRANSACTION. Every Plaid call completes before BEGIN.
 * Holding a transaction open across dozens of provider round trips keeps locks
 * for the duration of the slowest response, and a provider timeout would then
 * become a database problem.
 */
export async function runBackfill(
  options: { dryRun: boolean },
  deps: BackfillDeps = defaultDeps
): Promise<BackfillReport> {
  const startedAt = new Date().toISOString();

  // ---- phase 1: read the source, completely ------------------------------
  const [userScan, bankScan] = await Promise.all([deps.readUsers(), deps.readBanks()]);
  const plan = planMigration(userScan.documents, bankScan.documents);

  // ---- phase 2: provider enrichment, entirely outside the transaction ----
  const enrichmentFailures: BackfillReport["enrichmentFailures"] = [];
  const enriched: EnrichedAccount[] = [];
  let blocked = 0;

  for (const account of plan.accounts) {
    const outcome = await deps.enrich({
      accessToken: account.accessTokenForEnrichment,
      externalAccountId: account.externalAccountId,
    });

    if (!outcome.ok) {
      enrichmentFailures.push({
        legacyBankDocumentId: account.legacyAppwriteBankDocumentId,
        code: outcome.code,
        reason: outcome.reason,
        blocked: outcome.blocking,
      });

      if (outcome.blocking) {
        // An ambiguous provider match or a non-USD account. Migrating it would
        // require inventing a fact — which of several accounts was meant, or
        // that a CAD balance is USD. Refuse the row.
        blocked += 1;
        continue;
      }
    }

    enriched.push({
      account,
      metadata: outcome.metadata,
      currency: outcome.ok ? outcome.currency : "USD",
      metadataKnown: outcome.ok,
    });
  }

  const report: BackfillReport = {
    dryRun: options.dryRun,
    startedAt,
    finishedAt: startedAt,
    source: {
      users: {
        scanned: userScan.scanned,
        reportedTotal: userScan.reportedTotal,
        pages: userScan.pages,
        complete: userScan.complete,
      },
      banks: {
        scanned: bankScan.scanned,
        reportedTotal: bankScan.reportedTotal,
        pages: bankScan.pages,
        complete: bankScan.complete,
      },
      complete: userScan.complete && bankScan.complete,
    },
    customers: { created: 0, existing: 0, failed: 0 },
    accounts: { created: 0, updated: 0, failed: 0, blocked },
    enrichment: {
      succeeded: enriched.filter((e) => e.metadataKnown).length,
      failed: enrichmentFailures.length,
    },
    skipped: plan.skipped,
    failures: [],
    enrichmentFailures,
  };

  // ---- phase 3: one transaction, no network ------------------------------
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

    for (const { account, metadata, currency, metadataKnown } of enriched) {
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
            currency,
            metadataKnown,
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
    const rollback = findDryRunRollback(error);
    if (rollback) return rollback.report;
    throw error;
  }
}

/**
 * Find the dry-run signal inside whatever the transaction helper threw.
 *
 * withTransaction wraps the body's error via toDatabaseError, and a driver can
 * wrap it again, so the chain is walked rather than one level unwrapped. The
 * depth limit stops a self-referential cause from looping.
 */
function findDryRunRollback(error: unknown): DryRunRollback | null {
  let current = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if (current instanceof DryRunRollback) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * A short, safe description of a failure.
 *
 * Deliberately not the whole error: a database error message can quote the row
 * that violated a constraint, and a provider error can echo the request.
 */
function describe(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as {
      code?: unknown;
      sqlState?: unknown;
      constraint?: unknown;
      name?: unknown;
    };
    // SQLSTATE first: it is the diagnostic part. Our own DatabaseError carries
    // its class code in `code` ("DB_CONSTRAINT_VIOLATION"), which merely repeats
    // the name, and keeps PostgreSQL's five-character code in `sqlState`. A raw
    // driver error puts the SQLSTATE in `code`, so both shapes resolve here.
    // Both fields are fixed vocabulary, never row data.
    const state =
      typeof e.sqlState === "string"
        ? e.sqlState
        : typeof e.code === "string"
          ? e.code
          : undefined;
    const parts = [
      typeof e.name === "string" ? e.name : undefined,
      state,
      typeof e.constraint === "string" ? e.constraint : undefined,
    ].filter(Boolean);
    if (parts.length) return parts.join(" / ");
  }
  return "unknown failure";
}
