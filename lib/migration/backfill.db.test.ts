import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closePool, query, withTransaction } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import { upsertLinkedAccount } from "../db/repositories/linked-accounts.repository";
import type {
  LegacyBankDocument,
  LegacyUserDocument,
  SourceScan,
} from "./appwrite-source";
import { runBackfill, type BackfillDeps } from "./backfill";
import { FALLBACK_METADATA, type EnrichmentOutcome } from "./enrichment";
import { verifyMigration, type VerifyDeps } from "./verify";
import {
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
    listCustomers: listBankingCustomers,
    listAccounts: listLinkedAccounts,
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
    const [customer] = (await snapshot()).customers;

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
