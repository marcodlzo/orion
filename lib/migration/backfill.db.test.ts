import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closePool, getPool, query, withTransaction } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import {
  DatabaseUnavailableError,
  IdentityConflictError,
  TransactionOutcomeUnknownError,
} from "../db/errors";
import { backfillExitCode, formatBackfillReport } from "./report-format";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import {
  findLinkedAccountByLegacyDocumentId,
  upsertLinkedAccount,
} from "../db/repositories/linked-accounts.repository";
import type {
  LegacyBankDocument,
  LegacyUserDocument,
  SourceScan,
} from "./appwrite-source";
import { runBackfill, type BackfillDeps } from "./backfill";
import { MIGRATION_LOCK_KEY } from "./lock";
import { FALLBACK_METADATA, type EnrichmentOutcome } from "./enrichment";
import { defaultVerifyDeps, verifyMigration, type VerifyDeps } from "./verify";
import {
  findCustomerByAuthId,
  listBankingCustomers,
} from "../db/repositories/banking-customers.repository";
import { listLinkedAccounts } from "../db/repositories/linked-accounts.repository";

/**
 * THE BACKFILL AGAINST REAL POSTGRESQL.
 *
 * The fake-database suite proves the orchestration calls the right things in
 * the right order. It cannot prove what actually matters here: that dry run and
 * commit take the same path through real SQL, that constraints fire during a
 * dry run, that a re-run over partial state repairs exactly the gap, and that a
 * genuine constraint violation leaves the database in the state the report
 * claims. Only a real server can answer those.
 */

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query("TRUNCATE linked_accounts, banking_customers CASCADE");
});

const user = (n: number): LegacyUserDocument => ({
  $id: `user-doc-${n}`,
  userId: `auth-${n}`,
});

const bank = (
  n: number,
  owner: number,
  over: Partial<LegacyBankDocument> = {}
): LegacyBankDocument => ({
  $id: `bank-doc-${n}`,
  userId: `user-doc-${owner}`,
  accountId: `plaid-account-${n}`,
  bankId: `plaid-item-${n}`,
  accessToken: `access-sandbox-${n}`,
  ...over,
});

const scan = <T,>(documents: T[]): SourceScan<T> => ({
  documents,
  scanned: documents.length,
  reportedTotal: documents.length,
  pages: 1,
  complete: true,
  fingerprint: `fp-${documents.length}`,
});

const goodMetadata = (n: number): EnrichmentOutcome => ({
  ok: true,
  currency: "USD",
  metadata: {
    displayName: `Real Name ${n}`,
    officialName: `Official ${n}`,
    mask: String(1000 + n).slice(-4),
    accountType: "depository",
    accountSubtype: "checking",
  },
});

const providerDown: EnrichmentOutcome = {
  ok: false,
  code: "PROVIDER_ERROR",
  reason: "provider error: ITEM_LOGIN_REQUIRED",
  blocking: false,
  metadata: FALLBACK_METADATA,
  currency: null,
};

/** Real database, real repositories; only Appwrite and Plaid are substituted. */
function realDeps(
  users: LegacyUserDocument[],
  banks: LegacyBankDocument[],
  enrich: BackfillDeps["enrich"] = async ({ externalAccountId }) =>
    goodMetadata(Number(externalAccountId.split("-").pop()))
): BackfillDeps {
  return {
    readUsers: async () => scan(users),
    readBanks: async () => scan(banks),
    enrich,
    runInTransaction: withTransaction,
    acquireLock: async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    },
    upsertCustomer: upsertBankingCustomer,
    upsertAccount: upsertLinkedAccount,
  };
}

const snapshot = async () => ({
  customers: await listBankingCustomers(),
  accounts: await listLinkedAccounts(),
});

describe("dry run against real PostgreSQL", () => {
  const users = [user(1), user(2)];
  const banks = [bank(1, 1), bank(2, 2)];

  it("leaves zero persistent changes", async () => {
    const report = await runBackfill({ dryRun: true }, realDeps(users, banks));

    expect(report.customers.created).toBe(2);
    expect(report.accounts.created).toBe(2);

    // The report says it wrote four rows. The database says otherwise, which is
    // exactly the point.
    const after = await snapshot();
    expect(after.customers).toHaveLength(0);
    expect(after.accounts).toHaveLength(0);
  });

  it("predicts what committing produces from the same initial state", async () => {
    const dry = await runBackfill({ dryRun: true }, realDeps(users, banks));
    const wet = await runBackfill({ dryRun: false }, realDeps(users, banks));

    // Same counters, from the same starting state — a dry run whose numbers do
    // not survive the commit is worse than none.
    expect(wet.customers).toEqual(dry.customers);
    expect(wet.accounts).toEqual(dry.accounts);
    expect(wet.failures).toEqual(dry.failures);
    expect(wet.skipped).toEqual(dry.skipped);

    const after = await snapshot();
    expect(after.customers).toHaveLength(2);
    expect(after.accounts).toHaveLength(2);
  });

  it("executes real constraints during the dry run", async () => {
    // A bank pointing at a customer the plan does not migrate would be caught
    // by the mapper. This one gets past the mapper and must be caught by the
    // FOREIGN KEY — which only fires if the insert genuinely runs.
    const orphanDeps = realDeps([user(1)], [bank(1, 1)]);
    const spy = vi.fn(upsertBankingCustomer);

    const report = await runBackfill(
      { dryRun: true },
      {
        ...orphanDeps,
        upsertCustomer: spy,
        // Point the account at a customer id that does not exist.
        upsertAccount: async (input, client) =>
          upsertLinkedAccount(
            { ...input, customerId: "00000000-0000-4000-8000-000000000000" },
            client
          ),
      }
    );

    expect(spy).toHaveBeenCalled();
    // The FK genuinely fired during the dry run — proving the insert really
    // executed — and now aborts the transaction rather than being counted and
    // stepped over. 23503 is foreign_key_violation, raised by PostgreSQL.
    expect(report.outcome).toBe("rolled-back");
    expect(report.accounts.created).toBe(0);
    expect(report.failures[report.failures.length - 1].reason).toContain("23503");
  });

  it("rejects a genuinely duplicate natural key during a dry run", async () => {
    // Two DIFFERENT legacy documents describing the same (customer, account).
    // The mapper keeps one; if it ever stopped doing so, the unique index would
    // fire here — during the dry run, before any commit.
    const report = await runBackfill(
      { dryRun: true },
      realDeps([user(1)], [bank(1, 1), { ...bank(9, 1), accountId: "plaid-account-1" }])
    );

    expect(report.accounts.created).toBe(1);
    expect(report.skipped.map((s) => s.code)).toContain("DUPLICATE_OWNER_ACCOUNT");
  });
});

describe("partial progress and re-run", () => {
  const users = [user(1)];
  const banks = [bank(1, 1), bank(2, 1)];

  /** customer A migrated, account A1 migrated, account A2 absent. */
  async function seedPartialState() {
    const { row: customer } = await upsertBankingCustomer({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "user-doc-1",
    });
    const { row: a1 } = await upsertLinkedAccount({
      customerId: customer.id,
      legacyAppwriteBankDocumentId: "bank-doc-1",
      externalAccountId: "plaid-account-1",
      provider: "plaid",
      displayName: "Real Name 1",
      officialName: "Official 1",
      mask: "1001",
      accountType: "depository",
      accountSubtype: "checking",
      currency: "USD",
      metadataKnown: true,
    });
    return { customerId: customer.id, a1Id: a1.id };
  }

  it("inserts only the missing account and keeps existing ids", async () => {
    const seeded = await seedPartialState();

    const report = await runBackfill({ dryRun: false }, realDeps(users, banks));

    expect(report.customers).toMatchObject({ created: 0, existing: 1 });
    expect(report.accounts).toMatchObject({ created: 1, updated: 1, failed: 0 });

    const after = await snapshot();
    expect(after.customers).toHaveLength(1);
    expect(after.accounts).toHaveLength(2);

    // The UUIDs that already existed are the same UUIDs. Anything downstream
    // holding a reference to them keeps working.
    expect(after.customers[0].id).toBe(seeded.customerId);
    const a1 = after.accounts.find((a) => a.external_account_id === "plaid-account-1");
    expect(a1!.id).toBe(seeded.a1Id);
  });

  it("does not duplicate the account that was already present", async () => {
    await seedPartialState();

    await runBackfill({ dryRun: false }, realDeps(users, banks));

    const { rows } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM linked_accounts
        WHERE external_account_id = 'plaid-account-1'`
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("inserts nothing further on a second run", async () => {
    await seedPartialState();
    await runBackfill({ dryRun: false }, realDeps(users, banks));

    const before = await snapshot();
    const second = await runBackfill({ dryRun: false }, realDeps(users, banks));
    const after = await snapshot();

    expect(second.customers).toMatchObject({ created: 0, existing: 1 });
    expect(second.accounts).toMatchObject({ created: 0, updated: 2 });
    expect(after.customers.map((c) => c.id)).toEqual(before.customers.map((c) => c.id));
    expect(after.accounts.map((a) => a.id)).toEqual(before.accounts.map((a) => a.id));
  });

  it("preserves created_at across re-runs", async () => {
    await runBackfill({ dryRun: false }, realDeps(users, banks));
    const before = await snapshot();

    await runBackfill({ dryRun: false }, realDeps(users, banks));
    const after = await snapshot();

    // A rewritten created_at would destroy the only record of when a customer
    // was first migrated.
    expect(after.customers[0].created_at).toEqual(before.customers[0].created_at);
    expect(after.accounts[0].created_at).toEqual(before.accounts[0].created_at);
  });
});

describe("re-run during a provider outage", () => {
  const users = [user(1)];
  const banks = [bank(1, 1)];

  it("does NOT overwrite good metadata with placeholders", async () => {
    // First run: provider healthy.
    await runBackfill({ dryRun: false }, realDeps(users, banks));
    const before = await snapshot();
    expect(before.accounts[0].display_name).toBe("Real Name 1");

    // Second run: provider down. This is the destructive case — the naive
    // upsert wrote "Linked account" over a correct name.
    const report = await runBackfill(
      { dryRun: false },
      realDeps(users, banks, async () => providerDown)
    );

    const after = await snapshot();
    expect(after.accounts[0].display_name).toBe("Real Name 1");
    expect(after.accounts[0].official_name).toBe("Official 1");
    expect(after.accounts[0].mask).toBe("1001");
    expect(after.accounts[0].id).toBe(before.accounts[0].id);
    // The failure is still reported, not hidden by the preservation.
    expect(report.enrichmentFailures).toHaveLength(1);
  });

  it("inserts NO account when the provider never confirmed it", async () => {
    const report = await runBackfill(
      { dryRun: false },
      realDeps(users, banks, async () => providerDown)
    );

    const after = await snapshot();
    // CHANGED: a placeholder row asserted a currency nobody verified. The
    // customer migrates; the account waits for a provider that answers.
    expect(report.accounts.created).toBe(0);
    expect(report.accounts.blocked).toBe(1);
    expect(after.accounts).toHaveLength(0);
    expect(after.customers).toHaveLength(1);
  });

  it("inserts the account once the provider recovers", async () => {
    await runBackfill(
      { dryRun: false },
      realDeps(users, banks, async () => providerDown)
    );
    const blocked = await snapshot();
    expect(blocked.accounts).toHaveLength(0);
    expect(blocked.customers).toHaveLength(1);

    const recovered = await runBackfill({ dryRun: false }, realDeps(users, banks));
    const after = await snapshot();

    // The customer keeps its identity across the two runs.
    expect(recovered.customers).toMatchObject({ created: 0, existing: 1 });
    expect(after.customers[0].id).toBe(blocked.customers[0].id);
    expect(after.accounts[0].display_name).toBe("Real Name 1");
  });
});

describe("a real PostgreSQL failure", () => {
  it("reports the state the database actually holds", async () => {
    // A CHECK violation raised by the server, not a mocked rejection: currency
    // must be USD, and this run tries to write GBP.
    const users = [user(1)];
    const banks = [bank(1, 1)];

    const report = await runBackfill(
      { dryRun: false },
      {
        ...realDeps(users, banks),
        upsertAccount: async (input, client) =>
          upsertLinkedAccount({ ...input, currency: "GBP" }, client),
      }
    );

    // 23514 is check_violation, raised by PostgreSQL.
    expect(report.outcome).toBe("rolled-back");
    expect(report.failures[report.failures.length - 1].reason).toContain("23514");

    const after = await snapshot();
    // Reported state and persisted state now genuinely agree: both are zero.
    // Previously the report claimed creations that COMMIT — executed as a
    // rollback — had already discarded.
    expect(report.customers).toMatchObject({ created: 0, existing: 0 });
    expect(report.accounts).toMatchObject({ created: 0, updated: 0 });
    expect(after.customers).toHaveLength(0);
    expect(after.accounts).toHaveLength(0);
  });

  it("does not continue issuing statements on an aborted transaction", async () => {
    // Once a statement fails, PostgreSQL puts the transaction in an aborted
    // state and every later statement returns 25P02. If the loop kept going
    // without rollback or savepoint semantics, the SECOND account would report
    // 25P02 rather than its own error — a misleading report.
    const users = [user(1)];
    const banks = [bank(1, 1), bank(2, 1)];

    const report = await runBackfill(
      { dryRun: false },
      {
        ...realDeps(users, banks),
        upsertAccount: async (input, client) =>
          upsertLinkedAccount({ ...input, currency: "GBP" }, client),
      }
    );

    // CHANGED, and this is the point of the fix: the run stops at the FIRST
    // error, so there is no second statement issued inside a dead transaction
    // and therefore no 25P02 at all. Previously the report carried a real
    // 23514 followed by a derivative 25P02 that described nothing but our own
    // refusal to stop.
    const reasons = report.failures.map((f) => f.reason);
    expect(report.outcome).toBe("rolled-back");
    expect(reasons.filter((r) => r.includes("23514"))).toHaveLength(1);
    expect(reasons.some((r) => r.includes("25P02"))).toBe(false);

    const after = await snapshot();
    expect(after.customers).toHaveLength(0);
  });

  it("commits nothing when the transaction aborts", async () => {
    const report = await runBackfill(
      { dryRun: false },
      {
        ...realDeps([user(1), user(2)], [bank(1, 1)]),
        upsertAccount: async (input, client) =>
          upsertLinkedAccount({ ...input, currency: "GBP" }, client),
      }
    );

    // The previous version of this test asserted `created: 2` against zero
    // persisted rows and called that "atomic". Atomicity was never the problem
    // — the REPORT was, because it described rows PostgreSQL had thrown away.
    expect(report.outcome).toBe("rolled-back");
    expect(report.customers.created).toBe(0);
    expect(await snapshot()).toMatchObject({ customers: [], accounts: [] });
  });
});

describe("verification against real PostgreSQL", () => {
  const users = [user(1), user(2)];
  const banks = [bank(1, 1), bank(2, 2)];

  const verifyDeps = (
    u: LegacyUserDocument[] = users,
    b: LegacyBankDocument[] = banks
  ): VerifyDeps => ({
    readUsers: async () => scan(u),
    readBanks: async () => scan(b),
    readPostgres: async () => ({
      customers: await listBankingCustomers(),
      accounts: await listLinkedAccounts(),
      isolation: "repeatable read",
    }),
  });

  it("reports no drift after a successful commit", async () => {
    await runBackfill({ dryRun: false }, realDeps(users, banks));

    const report = await verifyMigration(verifyDeps());

    expect(report.drift).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("reports drift after a dry run, because a dry run writes nothing", async () => {
    await runBackfill({ dryRun: true }, realDeps(users, banks));

    const report = await verifyMigration(verifyDeps());

    expect(report.ok).toBe(false);
    expect(report.drift.map((d) => d.category)).toContain("missing-customer");
  });

  it("detects a new source record that has not been migrated yet", async () => {
    await runBackfill({ dryRun: false }, realDeps(users, banks));

    const report = await verifyMigration(
      verifyDeps([...users, user(3)], [...banks, bank(3, 3)])
    );

    expect(report.ok).toBe(false);
    expect(report.drift.map((d) => d.id)).toContain("user-doc-3");
  });

  it("flags an account still carrying placeholder metadata", async () => {
    // The backfill can no longer CREATE such a row — unverified accounts are
    // blocked. The detector still matters for rows written by an earlier
    // version of this tool, so it is exercised against a seeded one.
    await runBackfill({ dryRun: false }, realDeps(users, banks));
    // Pinned by document id, not by row order: `customers[0]` could be either
    // customer, and reusing bank-doc-1 under the wrong one collides with the
    // unique legacy bridge rather than exercising the placeholder detector.
    const customer = (await snapshot()).customers.find(
      (c) => c.appwrite_user_document_id === "user-doc-1"
    )!;

    await upsertLinkedAccount({
      customerId: customer.id,
      legacyAppwriteBankDocumentId: "bank-doc-1",
      externalAccountId: "plaid-account-1",
      provider: "plaid",
      displayName: FALLBACK_METADATA.displayName,
      officialName: null,
      mask: null,
      accountType: null,
      accountSubtype: null,
      currency: "USD",
      metadataKnown: true,
    });

    const report = await verifyMigration(verifyDeps());

    expect(report.drift.map((d) => d.category)).toContain("unenriched-account");
  });

  it("repairs nothing", async () => {
    await runBackfill({ dryRun: false }, realDeps(users, banks));
    // Drift the source: user 2 disappears from Appwrite.
    const before = await snapshot();

    const report = await verifyMigration(verifyDeps([user(1)], [bank(1, 1)]));

    expect(report.drift.map((d) => d.category)).toContain("orphan-customer");
    // The orphan is still there afterwards. A tool that deleted it would be
    // destroying financial history on its own initiative.
    expect(await snapshot()).toEqual(before);
  });
});

/**
 * CONCURRENT RERUNS, GENUINELY IN PARALLEL.
 *
 * A sequential rerun proves nothing about a race. Before the advisory lock,
 * two identical runs launched with Promise.all produced one success and one
 * 23505 on banking_customers_appwrite_user_document_id_key — the stored result
 * was correct, but an operator could not tell that failure from a real one.
 */
describe("concurrent reruns against real PostgreSQL", () => {
  const users = [user(1), user(2)];
  const banks = [bank(1, 1), bank(2, 2)];

  it("both runs succeed and neither reports a spurious failure", async () => {
    const [a, b] = await Promise.all([
      runBackfill({ dryRun: false }, realDeps(users, banks)),
      runBackfill({ dryRun: false }, realDeps(users, banks)),
    ]);

    expect(a.outcome).toBe("committed");
    expect(b.outcome).toBe("committed");
    expect(a.failures).toEqual([]);
    expect(b.failures).toEqual([]);
  });

  it("stores exactly one row per record regardless of the race", async () => {
    await Promise.all([
      runBackfill({ dryRun: false }, realDeps(users, banks)),
      runBackfill({ dryRun: false }, realDeps(users, banks)),
    ]);

    const after = await snapshot();
    expect(after.customers).toHaveLength(2);
    expect(after.accounts).toHaveLength(2);
  });

  it("exactly one of the two runs reports the creations", async () => {
    const [a, b] = await Promise.all([
      runBackfill({ dryRun: false }, realDeps(users, banks)),
      runBackfill({ dryRun: false }, realDeps(users, banks)),
    ]);

    // The lock serialises them, so one run creates and the other finds
    // everything already present. Both are honest reports of what they did.
    const created = [a, b].map((r) => r.customers.created).sort();
    const existing = [a, b].map((r) => r.customers.existing).sort();
    expect(created).toEqual([0, 2]);
    expect(existing).toEqual([0, 2]);
  });

  it("survives three at once", async () => {
    const reports = await Promise.all([
      runBackfill({ dryRun: false }, realDeps(users, banks)),
      runBackfill({ dryRun: false }, realDeps(users, banks)),
      runBackfill({ dryRun: false }, realDeps(users, banks)),
    ]);

    expect(reports.every((r) => r.outcome === "committed")).toBe(true);
    expect(reports.every((r) => r.failures.length === 0)).toBe(true);
    expect((await snapshot()).customers).toHaveLength(2);
  });

  it("a concurrent dry run does not corrupt a concurrent commit", async () => {
    const [dry, wet] = await Promise.all([
      runBackfill({ dryRun: true }, realDeps(users, banks)),
      runBackfill({ dryRun: false }, realDeps(users, banks)),
    ]);

    expect(dry.outcome).toBe("dry-run");
    expect(wet.outcome).toBe("committed");

    // The dry run rolled back whatever it wrote; the commit's rows stand.
    const after = await snapshot();
    expect(after.customers).toHaveLength(2);
    expect(after.accounts).toHaveLength(2);
  });
});

describe("source fingerprint against real PostgreSQL", () => {
  const users = [user(1)];
  const banks = [bank(1, 1)];

  it("refuses to commit a dataset the dry run did not approve", async () => {
    const dry = await runBackfill({ dryRun: true }, realDeps(users, banks));

    // The source grew between the dry run and the commit.
    const report = await runBackfill(
      { dryRun: false, expectSourceFingerprint: dry.source.fingerprint },
      realDeps([...users, user(2)], [...banks, bank(2, 2)])
    );

    expect(report.outcome).toBe("refused");
    expect(await snapshot()).toMatchObject({ customers: [], accounts: [] });
  });

  it("commits the dataset the dry run did approve", async () => {
    const dry = await runBackfill({ dryRun: true }, realDeps(users, banks));

    const report = await runBackfill(
      { dryRun: false, expectSourceFingerprint: dry.source.fingerprint },
      realDeps(users, banks)
    );

    expect(report.outcome).toBe("committed");
    expect((await snapshot()).customers).toHaveLength(1);
  });
});

/**
 * THE ADVERSARIAL CASES, AGAINST PRODUCTION withTransaction.
 *
 * The previous round of these used a fake transaction wrapper whose error
 * semantics differed from production — which is exactly how a test claiming
 * "a TypeError still throws" passed while production converted it into a
 * QueryFailedError and reported it as migration data.
 */
describe("transaction semantics, production withTransaction", () => {
  const users = [user(1)];
  const banks = [bank(1, 1)];

  it("propagates a programming defect unchanged", async () => {
    await expect(
      runBackfill(
        { dryRun: false },
        {
          ...realDeps(users, banks),
          upsertCustomer: async () => {
            throw new TypeError("programming defect");
          },
        }
      )
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("does not convert a programming defect into a rolled-back report", async () => {
    const outcome = await runBackfill(
      { dryRun: false },
      {
        ...realDeps(users, banks),
        upsertAccount: async () => {
          throw new TypeError("programming defect");
        },
      }
    ).then(
      (report) => report.outcome,
      () => "threw"
    );

    expect(outcome).toBe("threw");
    expect(await snapshot()).toMatchObject({ customers: [], accounts: [] });
  });

  it("still rolls back after a programming defect", async () => {
    await runBackfill(
      { dryRun: false },
      {
        ...realDeps(users, banks),
        upsertAccount: async () => {
          throw new TypeError("programming defect");
        },
      }
    ).catch(() => undefined);

    // The customer write really executed before the throw. PostgreSQL must
    // still have discarded it.
    expect((await snapshot()).customers).toHaveLength(0);
  });

  it("reports an account CHECK violation as an ACCOUNT failure, with its id", async () => {
    const report = await runBackfill(
      { dryRun: false },
      {
        ...realDeps(users, banks),
        upsertAccount: async (input, client) =>
          upsertLinkedAccount({ ...input, currency: "GBP" }, client),
      }
    );

    // It used to say `customer (transaction)` for every failure, sending an
    // operator to look at the wrong record.
    expect(report.outcome).toBe("rolled-back");
    expect(report.failures[report.failures.length - 1]).toMatchObject({
      kind: "account",
      id: "bank-doc-1",
    });
    expect(report.accounts.failed).toBe(1);
    expect(report.customers.failed).toBe(0);
  });

  it("reports a customer conflict as a CUSTOMER failure, with its id", async () => {
    await upsertBankingCustomer({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "some-other-document",
    });

    const report = await runBackfill({ dryRun: false }, realDeps(users, banks));

    expect(report.failures[report.failures.length - 1]).toMatchObject({
      kind: "customer",
      id: "user-doc-1",
    });
    expect(report.customers.failed).toBe(1);
    expect(report.accounts.failed).toBe(0);
  });

  it("classifies an unreachable database as not-started, never as rolled-back", async () => {
    const report = await runBackfill(
      { dryRun: false },
      {
        ...realDeps(users, banks),
        runInTransaction: async () => {
          // Nothing connected, no BEGIN was issued, no rollback occurred.
          throw new DatabaseUnavailableError("connection refused");
        },
      }
    );

    // Saying "rolled back" would describe an event that never happened.
    expect(report.outcome).toBe("not-started");
    expect(report.customers.failed).toBe(0);
    expect(report.accounts.failed).toBe(0);
  });

  it("reports an ambiguous COMMIT as unknown, not as a rollback", async () => {
    const report = await runBackfill(
      { dryRun: false },
      {
        ...realDeps(users, banks),
        runInTransaction: async () => {
          // withTransaction raises this when COMMIT itself fails: PostgreSQL
          // may have applied the transaction and lost the acknowledgement.
          throw new TransactionOutcomeUnknownError();
        },
      }
    );

    expect(report.outcome).toBe("unknown");
  });
});

describe("rejected conflicts are non-destructive", () => {
  it("leaves every metadata column and updated_at untouched", async () => {
    const { row: c } = await upsertBankingCustomer({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "user-doc-1",
    });

    const base = {
      customerId: c.id,
      externalAccountId: "plaid-account-1",
      provider: "plaid" as const,
      currency: "USD",
      metadataKnown: true,
    };

    const { row: before } = await upsertLinkedAccount({
      ...base,
      legacyAppwriteBankDocumentId: "bank-original",
      displayName: "Original Name",
      officialName: "Original Official",
      mask: "0000",
      accountType: "depository",
      accountSubtype: "checking",
    });

    // NOT inside a transaction: the repository is callable without one, and
    // "throws" must not mean "throws, having already mutated the row".
    await expect(
      upsertLinkedAccount({
        ...base,
        legacyAppwriteBankDocumentId: "bank-different",
        displayName: "MUTATED BY REJECTED WRITE",
        officialName: "Mutated Official",
        mask: "9999",
        accountType: "credit",
        accountSubtype: "savings",
      })
    ).rejects.toBeInstanceOf(IdentityConflictError);

    const after = await findLinkedAccountByLegacyDocumentId("bank-original");

    expect(after).toMatchObject({
      id: before.id,
      legacy_appwrite_bank_document_id: "bank-original",
      display_name: "Original Name",
      official_name: "Original Official",
      mask: "0000",
      account_type: "depository",
      account_subtype: "checking",
    });
    expect(after!.updated_at).toEqual(before.updated_at);
  });

  it("leaves the customer row untouched on a rejected identity conflict", async () => {
    const { row: before } = await upsertBankingCustomer({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "user-doc-1",
    });

    await expect(
      upsertBankingCustomer({
        appwriteAuthId: "auth-1",
        appwriteUserDocumentId: "user-doc-DIFFERENT",
      })
    ).rejects.toBeInstanceOf(IdentityConflictError);

    const after = await findCustomerByAuthId("auth-1");
    expect(after).toMatchObject({
      id: before.id,
      appwrite_user_document_id: "user-doc-1",
    });
    expect(after!.updated_at).toEqual(before.updated_at);
  });
});

/**
 * A LOST COMMIT ACKNOWLEDGEMENT.
 *
 * The work really commits; only the acknowledgement is lost. Zeroing the
 * counters here is not caution — it is a factual claim contradicted by the rows
 * sitting in the database.
 */
describe("ambiguous COMMIT against real PostgreSQL", () => {
  const users = [user(1)];
  const banks = [bank(1, 1)];

  /** Runs the real work, lets it commit, then loses the acknowledgement. */
  const lostAck = (): BackfillDeps => ({
    ...realDeps(users, banks),
    runInTransaction: async (fn) => {
      await withTransaction(fn);
      // Committed. The client never found out.
      throw new TransactionOutcomeUnknownError();
    },
  });

  it("leaves the rows durable", async () => {
    await runBackfill({ dryRun: false }, lostAck());

    const after = await snapshot();
    expect(after.customers).toHaveLength(1);
    expect(after.accounts).toHaveLength(1);
  });

  it("does NOT claim zero creations while the rows exist", async () => {
    const report = await runBackfill({ dryRun: false }, lostAck());

    expect(report.outcome).toBe("unknown");
    // The previous builder zeroed every counter for any non-success outcome,
    // so this reported "0 created" against a database holding both rows.
    expect(report.customers.created).toBe(1);
    expect(report.accounts.created).toBe(1);
  });

  it("attributes the failure to the TRANSACTION, not to a record", async () => {
    const report = await runBackfill({ dryRun: false }, lostAck());

    const failure = report.failures[report.failures.length - 1];
    expect(failure.kind).toBe("transaction");
    expect(failure.id).toBe("(commit)");
  });

  it("labels the counters as attempted in operator output", async () => {
    const report = await runBackfill({ dryRun: false }, lostAck());
    const lines = formatBackfillReport(report).join("\n");

    expect(lines).toContain("OUTCOME UNKNOWN");
    expect(lines).toContain("ATTEMPTED — durability unknown");
    expect(lines).toContain("may all be there");
  });

  it("exits non-zero so nothing treats it as success", async () => {
    const report = await runBackfill({ dryRun: false }, lostAck());

    expect(backfillExitCode(report)).toBe(1);
  });

  it("is safe to re-run once the operator has looked", async () => {
    await runBackfill({ dryRun: false }, lostAck());

    const second = await runBackfill({ dryRun: false }, realDeps(users, banks));

    // The upserts are idempotent, so recovery is an ordinary re-run.
    expect(second.outcome).toBe("committed");
    expect(second.customers).toMatchObject({ created: 0, existing: 1 });
    expect((await snapshot()).customers).toHaveLength(1);
  });
});

describe("programming defects thrown before the callback", () => {
  it("propagates rather than posing as not-started", async () => {
    await expect(
      runBackfill(
        { dryRun: false },
        {
          ...realDeps([user(1)], [bank(1, 1)]),
          runInTransaction: async () => {
            // Never reaches the callback, so `started` stays false — which used
            // to be reported as an infrastructure outcome regardless of cause.
            throw new TypeError("helper defect");
          },
        }
      )
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("still reports a genuine connection failure as not-started", async () => {
    const report = await runBackfill(
      { dryRun: false },
      {
        ...realDeps([user(1)], [bank(1, 1)]),
        runInTransaction: async () => {
          throw new DatabaseUnavailableError("connection refused");
        },
      }
    );

    expect(report.outcome).toBe("not-started");
  });
});

describe("verification reads one consistent snapshot", () => {
  it("never sees a backfill halfway through", async () => {
    const users = [user(1), user(2), user(3)];
    const banks = [bank(1, 1), bank(2, 2), bank(3, 3)];

    // The verifier waits on the migration advisory lock and reads both tables
    // in one REPEATABLE READ transaction, so a concurrent backfill cannot tear
    // the comparison into "accounts whose customer does not exist".
    const [, report] = await Promise.all([
      runBackfill({ dryRun: false }, realDeps(users, banks)),
      verifyMigration({
        readUsers: async () => scan(users),
        readBanks: async () => scan(banks),
        readPostgres: defaultVerifyDeps.readPostgres,
      }),
    ]);

    // The verifier legitimately runs either BEFORE the backfill (everything
    // missing) or AFTER it (nothing missing). What it must never do is run
    // THROUGH it and see a mixture.
    const missingCustomers = report.drift.filter(
      (d) => d.category === "missing-customer"
    ).length;
    const missingAccounts = report.drift.filter(
      (d) => d.category === "missing-account"
    ).length;

    const allMissing =
      missingCustomers === users.length && missingAccounts === banks.length;
    const noneMissing = missingCustomers === 0 && missingAccounts === 0;

    expect(
      allMissing || noneMissing,
      `torn read: ${missingCustomers}/${users.length} customers and ` +
        `${missingAccounts}/${banks.length} accounts missing`
    ).toBe(true);

    // And never an account whose customer is absent — the shape a torn read
    // produces when the two tables are queried as separate statements.
    expect(report.drift.filter((d) => d.category === "orphan-account")).toEqual([]);
  });

  it("carries the source digest it verified against", async () => {
    await runBackfill({ dryRun: false }, realDeps([user(1)], [bank(1, 1)]));

    const report = await verifyMigration({
      readUsers: async () => scan([user(1)]),
      readBanks: async () => scan([bank(1, 1)]),
      readPostgres: defaultVerifyDeps.readPostgres,
    });

    expect(report.legacy.scan.fingerprint).toBeTruthy();
    expect(report.ok).toBe(true);
  });
});

/**
 * The verifier's snapshot guarantees, asserted BEHAVIOURALLY.
 *
 * A racing "did it tear?" test cannot prove this: with a small dataset the
 * interleaving that tears simply may not occur, so removing the isolation level
 * leaves it green. These ask PostgreSQL directly instead.
 */
describe("verifier snapshot mechanics", () => {
  it("runs at REPEATABLE READ, as PostgreSQL reports it", async () => {
    const level = await withTransaction(
      async (client) => {
        const { rows } = await client.query<{ level: string }>(
          "SELECT current_setting('transaction_isolation') AS level"
        );
        return rows[0].level;
      },
      { isolation: "repeatable read" }
    );

    expect(level).toBe("repeatable read");
  });

  it("still defaults to read committed when isolation is not requested", async () => {
    const level = await withTransaction(async (client) => {
      const { rows } = await client.query<{ level: string }>(
        "SELECT current_setting('transaction_isolation') AS level"
      );
      return rows[0].level;
    });

    expect(level).toBe("read committed");
  });

  it("BLOCKS while a migration holds the advisory lock", async () => {
    const holder = await getPool().connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);

    let settled = false;
    const read = defaultVerifyDeps.readPostgres().then((r) => {
      settled = true;
      return r;
    });

    // Long enough that an unsynchronised reader would have finished.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      settled,
      "verifier read completed while a migration held the lock"
    ).toBe(false);

    await holder.query("COMMIT");
    holder.release();

    await read;
    expect(settled).toBe(true);
  });

  it("returns both tables from the same read", async () => {
    await runBackfill({ dryRun: false }, realDeps([user(1)], [bank(1, 1)]));

    const pg = await defaultVerifyDeps.readPostgres();

    expect(pg.customers).toHaveLength(1);
    expect(pg.accounts).toHaveLength(1);
    // The account's customer is present in the SAME snapshot — the pairing a
    // torn read breaks.
    expect(pg.accounts[0].customer_id).toBe(pg.customers[0].id);
  });

  it("reports the isolation level PostgreSQL actually gave it", async () => {
    const pg = await defaultVerifyDeps.readPostgres();

    // Asked of the server, not asserted from the call site — so removing the
    // isolation option changes this value rather than leaving a stale label.
    expect(pg.isolation).toBe("repeatable read");
  });

  it("surfaces that isolation in the verification report", async () => {
    const report = await verifyMigration({
      readUsers: async () => scan([]),
      readBanks: async () => scan([]),
      readPostgres: defaultVerifyDeps.readPostgres,
    });

    expect(report.postgres.isolation).toBe("repeatable read");
  });
});

describe("conflict reporting names both sides", () => {
  it("puts the stored and incoming bridges in the operator report", async () => {
    await upsertBankingCustomer({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "an-older-document",
    });

    const report = await runBackfill(
      { dryRun: false },
      realDeps([user(1)], [bank(1, 1)])
    );

    const reason = report.failures[report.failures.length - 1].reason;

    // "IdentityConflictError" alone sent the operator to the database to find
    // out what it was conflicting WITH. Both values are ids they already have.
    expect(reason).toContain("stored=an-older-document");
    expect(reason).toContain("incoming=user-doc-1");
  });

  it("keeps the conflict reason free of row data", async () => {
    await upsertBankingCustomer({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "an-older-document",
    });

    const report = await runBackfill(
      { dryRun: false },
      realDeps([user(1)], [bank(1, 1)])
    );

    const reason = report.failures[report.failures.length - 1].reason;
    expect(reason).not.toContain("access-sandbox");
    expect(reason).not.toContain("orion_dev_password");
  });
});
