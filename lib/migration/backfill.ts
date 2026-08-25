// Server-only. OPERATOR TOOLING. Reached only from scripts/.
import "server-only";

import { withTransaction, type TransactionClient } from "../db/pool";
import { DatabaseError, IdentityConflictError } from "../db/errors";
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

/**
 * What actually happened to the database.
 *
 * Counters alone are a lie without this. A run that aborted mid-transaction
 * still accumulated "created" counts before the failure, and PostgreSQL rolled
 * every one of them back — reporting those numbers under a "COMMITTED" heading
 * states something false about the state of the system of record.
 */
export type BackfillOutcome =
  /** Every write is durable. */
  | "committed"
  /** Writes executed, then were deliberately undone. Counters are a forecast. */
  | "dry-run"
  /** A failure aborted the transaction. NOTHING was written; counters are zero. */
  | "rolled-back"
  /** Refused before any provider call or write. Nothing happened at all. */
  | "refused";

export type BackfillReport = {
  dryRun: boolean;
  outcome: BackfillOutcome;
  /** Present when outcome is "refused" — why the run would not start. */
  refusedBecause?: string;
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

  const evidence: SourceEvidence = {
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
  };

  const emptyReport = (
    outcome: BackfillOutcome,
    refusedBecause?: string
  ): BackfillReport => ({
    dryRun: options.dryRun,
    outcome,
    ...(refusedBecause ? { refusedBecause } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    source: evidence,
    customers: { created: 0, existing: 0, failed: 0 },
    accounts: { created: 0, updated: 0, failed: 0, blocked: 0 },
    enrichment: { succeeded: 0, failed: 0 },
    skipped: [],
    failures: [],
    enrichmentFailures: [],
  });

  // ---- REFUSE ON AN INCOMPLETE SOURCE READ -------------------------------
  //
  // Before enrichment, before the transaction, before anything observable.
  // A scan that disagrees with the server's reported total means the dataset
  // moved underneath the walk, and a partial view of ownership is exactly how
  // a customer's account gets attached to the wrong person or dropped.
  //
  // Exiting non-zero AFTER writing is not a safeguard — the inconsistent rows
  // are already durable by then. The only useful refusal happens first.
  if (!evidence.complete) {
    return emptyReport(
      "refused",
      `source read was incomplete (users ${evidence.users.scanned}/${evidence.users.reportedTotal}, ` +
        `banks ${evidence.banks.scanned}/${evidence.banks.reportedTotal}); re-run when the source is stable`
    );
  }

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
      // EVERY enrichment failure blocks the ACCOUNT.
      //
      // Not only the ambiguous and non-USD ones. If the provider did not
      // positively confirm this account's currency, we do not know it — and
      // `currency` is NOT NULL with a CHECK of 'USD', so inserting means
      // asserting a fact nobody verified. An unreachable Item could be hiding
      // a CAD account.
      //
      // Nothing is lost: the link still exists in Appwrite, and a re-run once
      // the provider is reachable inserts it. The customer still migrates.
      enrichmentFailures.push({
        legacyBankDocumentId: account.legacyAppwriteBankDocumentId,
        code: outcome.code,
        reason: outcome.reason,
        blocked: true,
      });
      blocked += 1;
      continue;
    }

    enriched.push({
      account,
      metadata: outcome.metadata,
      currency: outcome.currency,
      metadataKnown: true,
    });
  }

  const report: BackfillReport = {
    dryRun: options.dryRun,
    // Provisional. Set to its final value only once the transaction's fate is
    // known — see the catch below.
    outcome: options.dryRun ? "dry-run" : "committed",
    startedAt,
    finishedAt: startedAt,
    source: evidence,
    customers: { created: 0, existing: 0, failed: 0 },
    accounts: { created: 0, updated: 0, failed: 0, blocked },
    enrichment: {
      succeeded: enriched.length,
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

    // NO PER-STATEMENT CATCH.
    //
    // Catching here and continuing was wrong twice over. PostgreSQL marks a
    // transaction ABORTED after the first failed statement, so every later
    // statement returns 25P02 and the extra "failures" are noise generated by
    // carrying on inside a dead transaction. And because the counters kept
    // accumulating, the run reported creations that COMMIT — executed as a
    // rollback — never made durable.
    //
    // The first error now propagates, withTransaction rolls back, and the
    // caller rebuilds the report from what is actually true: nothing.
    for (const customer of plan.customers) {
      const { row, created } = await deps.upsertCustomer(customer, client);
      customerIds.set(customer.appwriteUserDocumentId, row.id);
      if (created) report.customers.created += 1;
      else report.customers.existing += 1;
    }

    for (const { account, metadata, currency, metadataKnown } of enriched) {
      const customerId = customerIds.get(account.ownerUserDocumentId);
      if (!customerId) {
        // Not a database error — the mapper already decided this owner is not
        // migratable, so there is nothing to abort for. Record and move on.
        report.accounts.failed += 1;
        report.failures.push({
          kind: "account",
          id: account.legacyAppwriteBankDocumentId,
          reason: `owner ${account.ownerUserDocumentId} was not migrated`,
        });
        continue;
      }

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

    // Only EXPECTED failure modes become a report. A DatabaseError or an
    // IdentityConflictError means the migration hit something real and the
    // transaction rolled back; anything else — a TypeError, a bug in this file
    // — must keep propagating rather than being dressed up as a migration
    // outcome, or a programming error would exit 1 looking like bad data.
    if (!isExpectedFailure(error)) throw error;

    // The transaction aborted. PostgreSQL discarded every write, so the only
    // honest report is one that says so: zero creations, zero updates, and the
    // single failure that caused it. Returning the counters accumulated before
    // the abort would describe a database state that does not exist.
    return {
      ...report,
      outcome: "rolled-back",
      finishedAt: new Date().toISOString(),
      customers: { created: 0, existing: 0, failed: report.customers.failed + 1 },
      accounts: { created: 0, updated: 0, failed: report.accounts.failed, blocked },
      failures: [
        ...report.failures,
        { kind: "customer", id: "(transaction)", reason: describe(error) },
      ],
    };
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
/**
 * A cause chain as an array, outermost first, with a depth limit.
 *
 * An array rather than a generator because tsconfig sets no `target`, so
 * iterating a Generator needs --downlevelIteration.
 */
function chain(error: unknown): object[] {
  const out: object[] = [];
  let current = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if (typeof current === "object") out.push(current as object);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

/** Failures the migration knows how to report rather than crash on. */
function isExpectedFailure(error: unknown): boolean {
  for (const link of chain(error)) {
    if (link instanceof DatabaseError || link instanceof IdentityConflictError) {
      return true;
    }
  }
  return false;
}

function describe(error: unknown): string {
  // The transaction helper re-wraps what the body threw, so the OUTERMOST error
  // is a generic wrapper: name "Error", no code, no constraint. Taking the
  // first link with any readable field therefore produced the useless reason
  // "Error". Prefer the first link that carries an actual diagnostic, and fall
  // back to a bare name only when nothing in the chain has one.
  const links = chain(error);
  const diagnostic = links.find((link) => {
    const e = link as { code?: unknown; sqlState?: unknown; constraint?: unknown };
    return (
      typeof e.sqlState === "string" ||
      typeof e.code === "string" ||
      typeof e.constraint === "string"
    );
  });

  for (const link of diagnostic ? [diagnostic] : links) {
    const e = link as {
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
