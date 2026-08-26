// Server-only. OPERATOR TOOLING. Reached only from scripts/.
import "server-only";

import { withTransaction, type TransactionClient } from "../db/pool";
import {
  DatabaseError,
  IdentityConflictError,
  TransactionOutcomeUnknownError,
} from "../db/errors";
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
import { MIGRATION_LOCK_KEY } from "./lock";
import { planMigration, type LinkedAccountPlan, type SkippedRecord } from "./mapping";

export type BackfillFailure = {
  /**
   * `transaction` is not a record kind — it is the transaction itself failing,
   * as a failed COMMIT does. Attributing that to the last customer sent an
   * operator to look at a row that had nothing wrong with it.
   */
  kind: "customer" | "account" | "transaction";
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
  /**
   * Digest of the exact dataset this run read.
   *
   * A dry run and the commit that follows it re-read Appwrite independently.
   * Carrying this value from one to the other — via --expect-source — is what
   * turns "the dry run looked fine" into a statement about the dataset actually
   * committed.
   */
  fingerprint: string;
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
  /** A failure aborted the transaction and PostgreSQL rolled it back. */
  | "rolled-back"
  /** The transaction never started (no connection, or BEGIN failed). */
  | "not-started"
  /**
   * COMMIT failed. Whether the writes are durable is UNKNOWN and cannot be
   * determined from here — inspect the database before re-running.
   *
   * Counters on an `unknown` report are ATTEMPTED, not durable. Zeroing them
   * would be as false as claiming them: the rows may well be there.
   */
  | "unknown"
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
  /** Serialises concurrent migrations. See MIGRATION_LOCK_KEY. */
  acquireLock: (client: TransactionClient) => Promise<void>;
  upsertCustomer: typeof upsertBankingCustomer;
  upsertAccount: typeof upsertLinkedAccount;
};


export const defaultDeps: BackfillDeps = {
  readUsers: readAllLegacyUsers,
  readBanks: readAllLegacyBanks,
  enrich: fetchAccountMetadata,
  runInTransaction: withTransaction,
  acquireLock: async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
  },
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
  options: { dryRun: boolean; expectSourceFingerprint?: string },
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
    fingerprint: `${userScan.fingerprint}.${bankScan.fingerprint}`,
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

  // ---- REFUSE WHEN THE SOURCE MOVED SINCE THE APPROVED DRY RUN ------------
  //
  // Appwrite stays live throughout, so a dry run approves dataset A and the
  // commit could apply dataset B. Counts cannot detect that — one delete plus
  // one insert leaves them identical.
  if (
    options.expectSourceFingerprint &&
    options.expectSourceFingerprint !== evidence.fingerprint
  ) {
    return emptyReport(
      "refused",
      `source changed since the approved dry run (expected ${options.expectSourceFingerprint}, found ${evidence.fingerprint})`
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
  //
  // Which record is mid-flight, so a failure can name it. Without this the
  // report said "customer (transaction)" for every failure, including a
  // linked-account CHECK violation.
  let current: { kind: "customer" | "account"; id: string } | null = null;
  let started = false;

  const work = async (client: TransactionClient) => {
    started = true;
    // FIRST statement in the transaction. Held until commit or rollback, so a
    // concurrent backfill waits here instead of racing into a unique-violation
    // on an index the ON CONFLICT arbiter does not cover.
    await deps.acquireLock(client);

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
      current = { kind: "customer", id: customer.appwriteUserDocumentId };
      const { row, created } = await deps.upsertCustomer(customer, client);
      customerIds.set(customer.appwriteUserDocumentId, row.id);
      if (created) report.customers.created += 1;
      else report.customers.existing += 1;
    }

    for (const { account, metadata, currency, metadataKnown } of enriched) {
      current = { kind: "account", id: account.legacyAppwriteBankDocumentId };
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

    current = null;
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

    // A COMMIT that failed leaves the durable outcome genuinely unknown. Saying
    // "rolled back" here would assert something nobody can know.
    if (error instanceof TransactionOutcomeUnknownError) {
      // DELIBERATELY NOT failedReport(). That builder zeroes every counter,
      // which is a factual claim — and here it is a claim that can be, and has
      // been, contradicted by the database: a lost COMMIT acknowledgement
      // leaves the rows durable. The counters are kept and labelled attempted.
      return {
        ...report,
        outcome: "unknown",
        finishedAt: new Date().toISOString(),
        failures: [
          ...report.failures,
          { kind: "transaction", id: "(commit)", reason: describe(error) },
        ],
      };
    }

    // Reached the database but never opened the transaction: no connection, or
    // BEGIN itself failed. Nothing was written because nothing was attempted —
    // which is a different fact from "we wrote and undid it".
    //
    // The DatabaseError requirement matters: a TypeError thrown by the
    // transaction helper BEFORE it invoked the callback also leaves `started`
    // false, and reporting that as an infrastructure outcome hid a programming
    // defect just as the callback path used to.
    if (!started && error instanceof DatabaseError) {
      return failedReport("not-started", error, current);
    }

    // Only EXPECTED failure modes become a report. A DatabaseError or an
    // IdentityConflictError means the migration hit something real and the
    // transaction rolled back; anything else — a TypeError, a bug in this file
    // — must keep propagating rather than being dressed up as a migration
    // outcome, or a programming error would exit 1 looking like bad data.
    //
    // withTransaction now rethrows the callback's error UNCHANGED, so this
    // check sees what was actually thrown. It previously saw a QueryFailedError
    // that the transaction helper had wrapped around a TypeError.
    if (!isExpectedFailure(error)) throw error;

    return failedReport("rolled-back", error, current);
  }

  /**
   * A report describing a run that wrote nothing durable.
   *
   * The failure names the operation that actually failed. Hardcoding
   * `kind: "customer"` and `id: "(transaction)"` told an operator to go looking
   * at the wrong record — a linked-account CHECK violation was reported as a
   * customer failure with no usable identifier.
   */
  function failedReport(
    outcome: BackfillOutcome,
    error: unknown,
    operation: { kind: "customer" | "account"; id: string } | null
  ): BackfillReport {
    return {
      ...report,
      outcome,
      finishedAt: new Date().toISOString(),
      customers: {
        created: 0,
        existing: 0,
        failed: operation?.kind === "customer" ? 1 : 0,
      },
      accounts: {
        created: 0,
        updated: 0,
        failed: operation?.kind === "account" ? 1 : report.accounts.failed,
        blocked,
      },
      failures: [
        ...report.failures,
        {
          kind: operation?.kind ?? "customer",
          id: operation?.id ?? "(transaction)",
          reason: describe(error),
        },
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
  // An identity conflict is the one failure where the STORED value is the whole
  // point: "this bridge is already claimed" is useless without saying by what.
  // Both sides are ids the operator already has access to, not row data.
  for (const link of chain(error)) {
    if (link instanceof IdentityConflictError) {
      return `IdentityConflictError / stored=${link.stored} / incoming=${link.incoming}`;
    }
  }

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
