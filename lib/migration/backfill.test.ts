import { describe, expect, it, vi } from "vitest";

import { ConstraintViolationError, DatabaseUnavailableError } from "../db/errors";
import type { TransactionClient } from "../db/pool";
import type {
  BankingCustomerInput,
  BankingCustomerRow,
} from "../db/repositories/banking-customers.repository";
import type {
  LinkedAccountInput,
  LinkedAccountRow,
} from "../db/repositories/linked-accounts.repository";
import type {
  LegacyBankDocument,
  LegacyUserDocument,
  SourceScan,
} from "./appwrite-source";
import { runBackfill, type BackfillDeps } from "./backfill";
import { FALLBACK_METADATA } from "./enrichment";

/** A complete source read, the shape the reader returns when nothing was lost. */
const scan = <T,>(documents: T[], over: Partial<SourceScan<T>> = {}): SourceScan<T> => ({
  documents,
  scanned: documents.length,
  reportedTotal: documents.length,
  pages: 1,
  complete: true,
  fingerprint: "fp-test",
  ...over,
});

const user = (over: Partial<LegacyUserDocument> = {}): LegacyUserDocument => ({
  $id: "user-doc-1",
  userId: "auth-1",
  ...over,
});

const bank = (over: Partial<LegacyBankDocument> = {}): LegacyBankDocument => ({
  $id: "bank-doc-1",
  userId: "user-doc-1",
  accountId: "plaid-account-1",
  bankId: "plaid-item-1",
  accessToken: "access-sandbox-1",
  ...over,
});

/**
 * An in-memory stand-in for PostgreSQL.
 *
 * Enough to observe what the orchestration DOES — what it writes, in what
 * order, and whether a rollback discards it. Constraint behaviour is proven
 * against the real database in repositories.db.test.ts; duplicating it here
 * against a fake would only prove the fake agrees with itself.
 */
type CustomerWrite = Pick<
  BankingCustomerRow,
  "id" | "appwrite_auth_id" | "appwrite_user_document_id"
>;
type AccountWrite = LinkedAccountInput & { id: string };

const CLIENT = {} as TransactionClient;

function fakeDatabase() {
  const committed = { customers: [] as CustomerWrite[], accounts: [] as AccountWrite[] };
  let staged = { customers: [] as CustomerWrite[], accounts: [] as AccountWrite[] };
  let nextId = 1;
  const counts = { commits: 0, rollbacks: 0 };

  const deps: Pick<
    BackfillDeps,
    "runInTransaction" | "acquireLock" | "upsertCustomer" | "upsertAccount"
  > = {
    acquireLock: async () => undefined,
    runInTransaction: async <T,>(
      fn: (client: TransactionClient) => Promise<T>
    ): Promise<T> => {
      staged = { customers: [], accounts: [] };
      try {
        const result = await fn(CLIENT);
        committed.customers.push(...staged.customers);
        committed.accounts.push(...staged.accounts);
        counts.commits += 1;
        return result;
      } catch (error) {
        staged = { customers: [], accounts: [] };
        counts.rollbacks += 1;
        // Mirrors production EXACTLY: withTransaction rethrows what the
        // callback threw, unchanged. The previous fake wrapped it, which is why
        // a test claiming "a TypeError still throws" passed while production
        // converted that TypeError into a QueryFailedError and reported it as a
        // migration outcome. A fake whose error semantics differ from the real
        // thing tests the fake.
        throw error;
      }
    },

    upsertCustomer: async (input: BankingCustomerInput) => {
      const existing = staged.customers.find(
        (c) => c.appwrite_auth_id === input.appwriteAuthId
      );
      if (existing) return { row: existing as BankingCustomerRow, created: false };
      const row: CustomerWrite = {
        id: `uuid-${nextId++}`,
        appwrite_auth_id: input.appwriteAuthId,
        appwrite_user_document_id: input.appwriteUserDocumentId,
      };
      staged.customers.push(row);
      return { row: row as BankingCustomerRow, created: true };
    },

    upsertAccount: async (input: LinkedAccountInput) => {
      const row: AccountWrite = { id: `uuid-${nextId++}`, ...input };
      staged.accounts.push(row);
      return { row: row as unknown as LinkedAccountRow, created: true };
    },
  };

  return { committed, counts, deps };
}

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  const db = fakeDatabase();
  return {
    readUsers: async () => scan([user()]),
    readBanks: async () => scan([bank()]),
    enrich: async () => ({
      ok: true,
      currency: "USD",
      metadata: {
        displayName: "Plaid Checking",
        officialName: "Plaid Gold Standard 0% Interest Checking",
        mask: "0000",
        accountType: "depository",
        accountSubtype: "checking",
      },
    }),
    ...db.deps,
    ...over,
  };
}

describe("runBackfill — a committing run", () => {
  it("writes one customer and one account", async () => {
    const db = fakeDatabase();
    const report = await runBackfill({ dryRun: false }, deps({ ...db.deps }));

    expect(report.customers).toEqual({ created: 1, existing: 0, failed: 0 });
    expect(report.accounts).toEqual({ created: 1, updated: 0, failed: 0, blocked: 0 });
    expect(report.failures).toHaveLength(0);
    expect(db.committed.customers).toHaveLength(1);
    expect(db.committed.accounts).toHaveLength(1);
  });

  it("links the account to the customer's PostgreSQL uuid, not its Appwrite id", async () => {
    const db = fakeDatabase();
    await runBackfill({ dryRun: false }, deps({ ...db.deps }));

    const customer = db.committed.customers[0];
    const account = db.committed.accounts[0];

    expect(account.customerId).toBe(customer.id);
    expect(account.customerId).not.toBe("user-doc-1");
    expect(account.customerId).not.toBe("auth-1");
  });

  it("keeps the bridge back to the legacy document", async () => {
    const db = fakeDatabase();
    await runBackfill({ dryRun: false }, deps({ ...db.deps }));

    // Without this the two stores cannot be reconciled after the fact.
    expect(db.committed.accounts[0].legacyAppwriteBankDocumentId).toBe("bank-doc-1");
    expect(db.committed.customers[0].appwrite_user_document_id).toBe("user-doc-1");
  });

  it("persists no provider credential", async () => {
    const db = fakeDatabase();
    await runBackfill(
      { dryRun: false },
      deps({
        ...db.deps,
        readBanks: async () => scan([
          bank({
            accessToken: "access-sandbox-must-not-persist",
            processorToken: "processor-must-not-persist",
            fundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/x",
          }),
        ]),
      })
    );

    const written = JSON.stringify(db.committed);
    expect(written).not.toContain("access-sandbox-must-not-persist");
    expect(written).not.toContain("processor-must-not-persist");
    expect(written).not.toContain("funding-sources");
  });

  it("persists no balance", async () => {
    const db = fakeDatabase();
    await runBackfill(
      { dryRun: false },
      deps({
        ...db.deps,
        readBanks: async () => scan([bank({ currentBalance: 4210.55 })]),
      })
    );

    expect(JSON.stringify(db.committed)).not.toContain("4210");
  });

  it("reports an already-present customer as existing, not created", async () => {
    const db = fakeDatabase();
    const report = await runBackfill(
      { dryRun: false },
      deps({
        ...db.deps,
        upsertCustomer: async (input: BankingCustomerInput) => ({
          row: {
            id: "uuid-existing",
            appwrite_auth_id: input.appwriteAuthId,
            appwrite_user_document_id: input.appwriteUserDocumentId,
          } as BankingCustomerRow,
          created: false,
        }),
      })
    );

    expect(report.customers).toMatchObject({ created: 0, existing: 1 });
  });
});

describe("runBackfill — dry run", () => {
  it("reports exactly what a real run would do", async () => {
    const dry = fakeDatabase();
    const wet = fakeDatabase();

    const dryReport = await runBackfill({ dryRun: true }, deps({ ...dry.deps }));
    const wetReport = await runBackfill({ dryRun: false }, deps({ ...wet.deps }));

    expect(dryReport.customers).toEqual(wetReport.customers);
    expect(dryReport.accounts).toEqual(wetReport.accounts);
    expect(dryReport.skipped).toEqual(wetReport.skipped);
    expect(dryReport.failures).toEqual(wetReport.failures);
  });

  it("really executes the writes, then rolls them back", async () => {
    const db = fakeDatabase();
    const upsertCustomer = vi.fn(db.deps.upsertCustomer);
    const upsertAccount = vi.fn(db.deps.upsertAccount);

    await runBackfill(
      { dryRun: true },
      deps({ ...db.deps, upsertCustomer, upsertAccount })
    );

    // The distinction that matters: a dry run that skipped the inserts would
    // report success for a dataset the database would reject.
    expect(upsertCustomer).toHaveBeenCalledTimes(1);
    expect(upsertAccount).toHaveBeenCalledTimes(1);
    expect(db.committed.customers).toHaveLength(0);
    expect(db.committed.accounts).toHaveLength(0);
  });

  it("marks the report as a dry run", async () => {
    const report = await runBackfill({ dryRun: true }, deps());
    expect(report.dryRun).toBe(true);
  });

  it("classifies a failure before BEGIN as not-started, not a rollback", async () => {
    const db = fakeDatabase();

    const report = await runBackfill(
      { dryRun: true },
      deps({
        ...db.deps,
        runInTransaction: async () => {
          throw new DatabaseUnavailableError("connection lost");
        },
      })
    );

    // "not-started" and "rolled-back" are different facts. Nothing was
    // attempted here, as opposed to attempted and undone.
    expect(report.outcome).toBe("not-started");
    expect(report.customers.created).toBe(0);
  });
});

describe("runBackfill — degraded provider", () => {
  it("still migrates the account when enrichment fails", async () => {
    const db = fakeDatabase();
    const report = await runBackfill(
      { dryRun: false },
      deps({
        ...db.deps,
        enrich: async () => ({
          ok: false,
          code: "PROVIDER_ERROR" as const,
          reason: "provider error: ITEM_LOGIN_REQUIRED",
          blocking: false,
          metadata: FALLBACK_METADATA,
          currency: null,
        }),
      })
    );

    // CHANGED: an unverified account is no longer written. Plaid did not
    // confirm the currency, and `currency` is NOT NULL with a CHECK of 'USD',
    // so inserting would assert a fact nobody checked. Nothing is lost -- the
    // link is still in Appwrite and a re-run inserts it once Plaid answers.
    expect(report.accounts.created).toBe(0);
    expect(report.accounts.blocked).toBe(1);
    expect(report.enrichment).toEqual({ succeeded: 0, failed: 1 });
    expect(db.committed.accounts).toHaveLength(0);
    // The customer still migrates.
    expect(report.customers.created).toBe(1);
  });

  it("names every account it could not enrich", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        enrich: async () => ({
          ok: false,
          code: "PROVIDER_ERROR" as const,
          reason: "provider error: ITEM_LOGIN_REQUIRED",
          blocking: false,
          metadata: FALLBACK_METADATA,
          currency: null,
        }),
      })
    );

    expect(report.enrichmentFailures).toEqual([
      {
        legacyBankDocumentId: "bank-doc-1",
        code: "PROVIDER_ERROR",
        reason: "provider error: ITEM_LOGIN_REQUIRED",
        blocked: true,
      },
    ]);
  });

  it("enriches before opening the transaction", async () => {
    const order: string[] = [];
    const db = fakeDatabase();

    await runBackfill(
      { dryRun: false },
      deps({
        enrich: async () => {
          order.push("enrich");
          return { ok: true as const, currency: "USD", metadata: FALLBACK_METADATA };
        },
        runInTransaction: <T,>(fn: (client: TransactionClient) => Promise<T>) => {
          order.push("transaction");
          return db.deps.runInTransaction(fn);
        },
        upsertCustomer: db.deps.upsertCustomer,
        upsertAccount: db.deps.upsertAccount,
      })
    );

    // Holding a transaction open across provider calls keeps locks for the
    // duration of the slowest response.
    expect(order).toEqual(["enrich", "transaction"]);
  });

  it("passes the specific account id to the provider, not just the item", async () => {
    const enrich = vi.fn(async () => ({ ok: true as const, currency: "USD", metadata: FALLBACK_METADATA }));

    await runBackfill({ dryRun: false }, deps({ enrich }));

    expect(enrich).toHaveBeenCalledWith({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-1",
    });
  });
});

describe("runBackfill — failures", () => {
  it("records a write failure without leaking the failing row", async () => {
    const db = fakeDatabase();
    const report = await runBackfill(
      { dryRun: false },
      deps({
        ...db.deps,
        upsertAccount: async () => {
          // A real ConstraintViolationError, as toDatabaseError produces --
          // not a duck-typed stand-in. The message deliberately quotes the
          // offending row, the way a driver does.
          throw new ConstraintViolationError(
            "duplicate key value violates unique constraint — Key (external_account_id)=(plaid-account-1) already exists",
            { sqlState: "23505", constraint: "linked_accounts_customer_id_provider_external_account_id_key" }
          );
        },
      })
    );

    // CHANGED: the first database error now aborts the transaction instead of
    // being caught and counted. Nothing was committed, so every creation
    // counter is zero and the single recorded failure is the cause.
    expect(report.outcome).toBe("rolled-back");
    expect(report.customers.created).toBe(0);
    expect(report.accounts.created).toBe(0);
    // The failure names the record that actually failed. It used to say
    // `customer (transaction)` for everything, including this account.
    const failure = report.failures[report.failures.length - 1];
    expect(failure.kind).toBe("account");
    expect(failure.id).toBe("bank-doc-1");
    // The reason carries the classification, never the driver's message — a
    // constraint error quotes the offending row back at you.
    expect(failure.reason).toBe(
      "ConstraintViolationError / 23505 / linked_accounts_customer_id_provider_external_account_id_key"
    );
    expect(failure.reason).not.toContain("plaid-account-1");
  });

  it("does not attempt an account whose customer failed to write", async () => {
    const upsertAccount = vi.fn();
    const report = await runBackfill(
      { dryRun: false },
      deps({
        upsertCustomer: async () => {
          throw new ConstraintViolationError("nope", { sqlState: "23505" });
        },
        upsertAccount,
      })
    );

    // STRONGER than before. Previously the customer failure was caught and the
    // run limped on to the account loop, which then reported a second,
    // derivative failure. Now the first database error aborts the transaction
    // outright, so the account is never attempted and the report says plainly
    // that nothing was written.
    expect(upsertAccount).not.toHaveBeenCalled();
    expect(report.outcome).toBe("rolled-back");
    expect(report.customers).toMatchObject({ created: 0, existing: 0 });
    expect(report.accounts).toMatchObject({ created: 0, updated: 0 });
    expect(report.failures[report.failures.length - 1].reason).toContain("23505");
  });

  it("carries the mapping's skips through to the report", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        readUsers: async () => scan([user({ $id: "user-doc-1", userId: "" })]),
        readBanks: async () => scan([bank()]),
      })
    );

    expect(report.skipped).toHaveLength(2);
    expect(report.customers.created).toBe(0);
    expect(report.accounts.created).toBe(0);
  });

  it("counts the source it actually read", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        readUsers: async () => scan([
          user({ $id: "a", userId: "auth-a" }),
          user({ $id: "b", userId: "auth-b" }),
        ]),
        readBanks: async () => scan([
          bank({ $id: "bank-a", userId: "a" }),
          bank({ $id: "bank-b", userId: "b" }),
          bank({ $id: "bank-c", userId: "ghost" }),
        ]),
      })
    );

    expect(report.source.users.scanned).toBe(2);
    expect(report.source.banks.scanned).toBe(3);
    expect(report.source.complete).toBe(true);
  });
});

describe("runBackfill — idempotency", () => {
  it("creates nothing new on a second run over the same source", async () => {
    // The repositories upsert; re-running after a provider outage or a mapping
    // fix must be safe, not duplicating a customer's accounts.
    // Survives across both runs, the way the real tables do.
    const customers = new Map<string, CustomerWrite>();
    const accounts = new Map<string, AccountWrite>();

    const shared: Partial<BackfillDeps> = {
      upsertCustomer: async (input: BankingCustomerInput) => {
        const existing = customers.get(input.appwriteAuthId);
        if (existing) return { row: existing as BankingCustomerRow, created: false };
        const row: CustomerWrite = {
          id: `customer-${customers.size + 1}`,
          appwrite_auth_id: input.appwriteAuthId,
          appwrite_user_document_id: input.appwriteUserDocumentId,
        };
        customers.set(input.appwriteAuthId, row);
        return { row: row as BankingCustomerRow, created: true };
      },
      upsertAccount: async (input: LinkedAccountInput) => {
        const key = `${input.customerId}::${input.externalAccountId}`;
        const existing = accounts.get(key);
        if (existing) {
          return { row: existing as unknown as LinkedAccountRow, created: false };
        }
        const row: AccountWrite = { id: `account-${accounts.size + 1}`, ...input };
        accounts.set(key, row);
        return { row: row as unknown as LinkedAccountRow, created: true };
      },
      runInTransaction: <T,>(fn: (client: TransactionClient) => Promise<T>) => fn(CLIENT),
    };

    const first = await runBackfill({ dryRun: false }, deps(shared));
    const second = await runBackfill({ dryRun: false }, deps(shared));

    expect(first.customers.created).toBe(1);
    expect(first.accounts.created).toBe(1);
    expect(second.customers).toMatchObject({ created: 0, existing: 1 });
    expect(second.accounts).toMatchObject({ created: 0, updated: 1 });
    expect(second.failures).toHaveLength(0);
  });
});

/**
 * NO NETWORK INSIDE THE TRANSACTION.
 *
 * Asserting call order is weak — it passes if the calls merely happen to be
 * ordered. These tests make the boundary observable: the enrichment fake knows
 * whether a transaction is open and records a violation if it is ever called
 * while one is.
 */
describe("runBackfill — the network/transaction boundary", () => {
  function boundaryProbe() {
    let open = false;
    const violations: string[] = [];
    const db = fakeDatabase();

    return {
      violations,
      committed: db.committed,
      deps: {
        enrich: async () => {
          if (open) violations.push("enrich called while a transaction was open");
          return { ok: true as const, currency: "USD", metadata: FALLBACK_METADATA };
        },
        runInTransaction: async <T,>(fn: (c: TransactionClient) => Promise<T>) => {
          open = true;
          try {
            return await db.deps.runInTransaction(fn);
          } finally {
            open = false;
          }
        },
        upsertCustomer: db.deps.upsertCustomer,
        upsertAccount: db.deps.upsertAccount,
      },
    };
  }

  it("makes no provider call while a transaction is open", async () => {
    const probe = boundaryProbe();

    await runBackfill({ dryRun: false }, deps(probe.deps));

    expect(probe.violations).toEqual([]);
  });

  it("holds the boundary for many accounts, not just one", async () => {
    // With a single account the ordering could be luck. With several, an
    // enrichment call moved inside the write loop would land in the transaction.
    const probe = boundaryProbe();
    const users = Array.from({ length: 5 }, (_, i) =>
      user({ $id: `u-${i}`, userId: `auth-${i}` })
    );
    const banks = Array.from({ length: 5 }, (_, i) =>
      bank({ $id: `b-${i}`, userId: `u-${i}`, accountId: `acct-${i}` })
    );

    const report = await runBackfill(
      { dryRun: false },
      deps({
        ...probe.deps,
        readUsers: async () => scan(users),
        readBanks: async () => scan(banks),
      })
    );

    expect(report.accounts.created).toBe(5);
    expect(probe.violations).toEqual([]);
  });

  it("holds the boundary during a dry run too", async () => {
    const probe = boundaryProbe();

    await runBackfill({ dryRun: true }, deps(probe.deps));

    expect(probe.violations).toEqual([]);
  });

  it("finishes every provider call before the transaction begins", async () => {
    const order: string[] = [];
    const db = fakeDatabase();

    await runBackfill(
      { dryRun: false },
      deps({
        readUsers: async () => scan([user({ $id: "u-1", userId: "auth-1" })]),
        readBanks: async () =>
          scan([
            bank({ $id: "b-1", userId: "u-1", accountId: "a-1" }),
            bank({ $id: "b-2", userId: "u-1", accountId: "a-2" }),
          ]),
        enrich: async () => {
          order.push("enrich");
          return { ok: true as const, currency: "USD", metadata: FALLBACK_METADATA };
        },
        runInTransaction: <T,>(fn: (c: TransactionClient) => Promise<T>) => {
          order.push("BEGIN");
          return db.deps.runInTransaction(fn);
        },
        upsertCustomer: db.deps.upsertCustomer,
        upsertAccount: db.deps.upsertAccount,
      })
    );

    expect(order).toEqual(["enrich", "enrich", "BEGIN"]);
  });
});

/**
 * SOURCE EVIDENCE.
 *
 * "Migrated 12 customers" is equally true of a complete read and of one that
 * stopped after the first page. The report carries the numbers that tell them
 * apart.
 */
describe("runBackfill — source evidence", () => {
  it("reports scanned, total and pages for both collections", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        readUsers: async () => scan([user()], { pages: 3 }),
        readBanks: async () => scan([bank()], { pages: 2 }),
      })
    );

    expect(report.source.users).toEqual({
      scanned: 1,
      reportedTotal: 1,
      pages: 3,
      complete: true,
    });
    expect(report.source.banks.pages).toBe(2);
    expect(report.source.complete).toBe(true);
  });

  it("marks the whole run incomplete when either collection was short", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        readBanks: async () =>
          scan([bank()], { reportedTotal: 40, complete: false }),
      })
    );

    expect(report.source.banks.complete).toBe(false);
    expect(report.source.complete).toBe(false);
  });
});

/**
 * RE-RUN SAFETY FOR METADATA.
 *
 * Idempotency is not only "the row count did not change". A re-run during a
 * provider outage must not degrade correct data to placeholders.
 */
describe("runBackfill — enrichment must positively verify the account", () => {
  const degraded = {
    ok: false as const,
    code: "PROVIDER_ERROR" as const,
    reason: "provider error: ITEM_LOGIN_REQUIRED",
    blocking: false,
    metadata: FALLBACK_METADATA,
    currency: null,
  };

  it("writes no account when the provider did not answer", async () => {
    const db = fakeDatabase();

    const report = await runBackfill(
      { dryRun: false },
      deps({ ...db.deps, enrich: async () => degraded })
    );

    // `blocking: false` on the outcome is advisory; the backfill blocks every
    // unverified account regardless. An unreachable Item could be hiding a CAD
    // account, and there is no such thing as a partially-known currency.
    expect(db.committed.accounts).toHaveLength(0);
    expect(report.accounts).toMatchObject({ created: 0, blocked: 1 });
  });

  it("never hands the repository unverified metadata", async () => {
    const db = fakeDatabase();

    await runBackfill(
      { dryRun: false },
      deps({ ...db.deps, enrich: async () => degraded })
    );

    // The repository still supports metadataKnown=false as defence in depth,
    // but the backfill no longer reaches it: an unverified account is not
    // written at all.
    expect(db.committed.accounts.every((a) => a.metadataKnown)).toBe(true);
  });

  it("marks metadata trustworthy when the provider answered", async () => {
    const db = fakeDatabase();

    await runBackfill({ dryRun: false }, deps({ ...db.deps }));

    expect(db.committed.accounts[0].metadataKnown).toBe(true);
  });

  it("still migrates the customer that owned the blocked account", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({ enrich: async () => degraded })
    );

    expect(report.customers.created).toBe(1);
  });

  it("inserts the account on a later run once the provider answers", async () => {
    const db = fakeDatabase();

    await runBackfill({ dryRun: false }, deps({ ...db.deps, enrich: async () => degraded }));
    expect(db.committed.accounts).toHaveLength(0);

    const recovered = await runBackfill({ dryRun: false }, deps({ ...db.deps }));

    expect(recovered.accounts.created).toBe(1);
  });
});

describe("runBackfill — blocked accounts", () => {
  const blocking = (code: "AMBIGUOUS_PROVIDER_ACCOUNT" | "UNSUPPORTED_CURRENCY") => ({
    ok: false as const,
    code,
    reason: `blocked: ${code}`,
    blocking: true,
    metadata: FALLBACK_METADATA,
    currency: code === "UNSUPPORTED_CURRENCY" ? "CAD" : null,
  });

  it("writes no row for an ambiguous provider match", async () => {
    const db = fakeDatabase();

    const report = await runBackfill(
      { dryRun: false },
      deps({ ...db.deps, enrich: async () => blocking("AMBIGUOUS_PROVIDER_ACCOUNT") })
    );

    expect(db.committed.accounts).toHaveLength(0);
    expect(report.accounts).toMatchObject({ created: 0, blocked: 1 });
  });

  it("writes no row for a non-USD account", async () => {
    const db = fakeDatabase();

    const report = await runBackfill(
      { dryRun: false },
      deps({ ...db.deps, enrich: async () => blocking("UNSUPPORTED_CURRENCY") })
    );

    // Relabelling a CAD account as USD to satisfy the CHECK constraint would
    // put a false fact in the system of record.
    expect(db.committed.accounts).toHaveLength(0);
    expect(report.accounts.blocked).toBe(1);
  });

  it("reports a blocked account distinctly from a degraded one", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({ enrich: async () => blocking("UNSUPPORTED_CURRENCY") })
    );

    expect(report.enrichmentFailures[0]).toMatchObject({
      code: "UNSUPPORTED_CURRENCY",
      blocked: true,
    });
  });

  it("still migrates the customer that owned the blocked account", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({ enrich: async () => blocking("UNSUPPORTED_CURRENCY") })
    );

    expect(report.customers.created).toBe(1);
  });

  it("passes the provider's currency through when it is usable", async () => {
    const db = fakeDatabase();

    await runBackfill({ dryRun: false }, deps({ ...db.deps }));

    expect(db.committed.accounts[0].currency).toBe("USD");
  });
});

/**
 * SECRET TAINT.
 *
 * Unique sentinels, one per surface, so a leak names its own source. "There is
 * no access_token column" is not proof: the value could still reach a report,
 * an error message, or a log line.
 */
describe("runBackfill — secret containment", () => {
  const ACCESS_TOKEN = "SENTINEL-access-token-7c21ab";
  const FUNDING_URL = "https://sentinel.invalid/funding-sources/de44f1";
  const PROCESSOR = "SENTINEL-processor-token-90ffce";
  const DB_PASSWORD = "SENTINEL-db-password-1a2b3c";

  const sentinels = [ACCESS_TOKEN, FUNDING_URL, PROCESSOR, DB_PASSWORD];

  const taintedBank = () =>
    bank({
      accessToken: ACCESS_TOKEN,
      fundingSourceUrl: FUNDING_URL,
      processorToken: PROCESSOR,
    });

  const assertClean = (subject: unknown, label: string) => {
    const text = typeof subject === "string" ? subject : JSON.stringify(subject);
    for (const secret of sentinels) {
      expect(text ?? "", `${label} leaked a sentinel`).not.toContain(secret);
    }
  };

  it("keeps sentinels out of a successful run's report and writes", async () => {
    const db = fakeDatabase();

    const report = await runBackfill(
      { dryRun: false },
      deps({ ...db.deps, readBanks: async () => scan([taintedBank()]) })
    );

    assertClean(report, "report");
    assertClean(db.committed, "database");
  });

  it("keeps sentinels out of a dry run's report", async () => {
    const report = await runBackfill(
      { dryRun: true },
      deps({ readBanks: async () => scan([taintedBank()]) })
    );

    assertClean(report, "dry-run report");
  });

  it("keeps sentinels out of a provider failure's report", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        readBanks: async () => scan([taintedBank()]),
        enrich: async () => ({
          ok: false as const,
          code: "PROVIDER_ERROR" as const,
          // A real Plaid error echoes the request; the reason must not.
          reason: "provider error: INVALID_ACCESS_TOKEN",
          blocking: false,
          metadata: FALLBACK_METADATA,
          currency: null,
        }),
      })
    );

    assertClean(report, "degraded report");
  });

  it("keeps sentinels out of a database failure's report", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        readBanks: async () => scan([taintedBank()]),
        upsertAccount: async () => {
          // A driver error quotes the offending row and the connection string.
          throw new ConstraintViolationError(
            `insert failed for row (access_token=${ACCESS_TOKEN}) on ` +
              `postgresql://orion:${DB_PASSWORD}@localhost:5432/orion`,
            { sqlState: "23505", constraint: "some_key" }
          );
        },
      })
    );

    assertClean(report, "failure report");
    // Only the classification survives, never the driver's message.
    expect(report.failures[0].reason).toBe(
      "ConstraintViolationError / 23505 / some_key"
    );
  });

  it("adds no secret of its own when a run aborts", async () => {
    const thrown = await runBackfill(
      { dryRun: false },
      deps({
        readBanks: async () => scan([taintedBank()]),
        runInTransaction: async () => {
          throw new DatabaseUnavailableError(
            `could not connect to postgresql://orion:${DB_PASSWORD}@localhost/orion`
          );
        },
      })
    ).then(
      (report) => report,
      (e: unknown) => e as Error
    );

    // An infrastructure failure is now classified into a report rather than
    // thrown, so the sentinel check runs against what an operator actually
    // sees. The driver's message is never copied into it.
    assertClean(JSON.stringify(thrown), "aborted report");
  });

  it("keeps sentinels out of the report when the source read was short", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({
        readBanks: async () =>
          scan([taintedBank()], { reportedTotal: 9, complete: false }),
      })
    );

    assertClean(report, "incomplete-scan report");
  });
});

/**
 * REFUSAL ON AN INCOMPLETE SOURCE READ.
 *
 * The defect this replaces: `complete: false` was recorded in the report and
 * the run carried on writing, with the CLI exiting non-zero only afterwards.
 * By then the inconsistent rows were durable. A source deletion mid-pagination
 * could therefore commit a target that no source ever matched.
 */
describe("runBackfill — refuses an incomplete source read", () => {
  const shortRead = async () => scan([bank()], { reportedTotal: 40, complete: false });

  it("writes nothing and opens no transaction", async () => {
    const db = fakeDatabase();
    let transactionsOpened = 0;
    const runInTransaction = <T,>(fn: (c: TransactionClient) => Promise<T>) => {
      transactionsOpened += 1;
      return db.deps.runInTransaction(fn);
    };
    const upsertCustomer = vi.fn(db.deps.upsertCustomer);
    const upsertAccount = vi.fn(db.deps.upsertAccount);

    const report = await runBackfill(
      { dryRun: false },
      deps({
        ...db.deps,
        readBanks: shortRead,
        runInTransaction,
        upsertCustomer,
        upsertAccount,
      })
    );

    expect(report.outcome).toBe("refused");
    expect(transactionsOpened).toBe(0);
    expect(upsertCustomer).not.toHaveBeenCalled();
    expect(upsertAccount).not.toHaveBeenCalled();
    expect(db.committed.customers).toHaveLength(0);
    expect(db.committed.accounts).toHaveLength(0);
  });

  it("makes no provider call either", async () => {
    // Refusal happens before enrichment, so an incomplete read costs nothing
    // and leaks no access token to Plaid.
    const enrich = vi.fn(async () => ({
      ok: true as const,
      currency: "USD",
      metadata: FALLBACK_METADATA,
    }));

    await runBackfill({ dryRun: false }, deps({ readBanks: shortRead, enrich }));

    expect(enrich).not.toHaveBeenCalled();
  });

  it("refuses a dry run too", async () => {
    const report = await runBackfill({ dryRun: true }, deps({ readBanks: shortRead }));

    expect(report.outcome).toBe("refused");
  });

  it("refuses on an incomplete USER scan, not only banks", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({ readUsers: async () => scan([user()], { reportedTotal: 9, complete: false }) })
    );

    expect(report.outcome).toBe("refused");
  });

  it("says why, with the numbers", async () => {
    const report = await runBackfill({ dryRun: false }, deps({ readBanks: shortRead }));

    expect(report.refusedBecause).toContain("incomplete");
    expect(report.refusedBecause).toContain("40");
  });

  it("still proceeds when both scans are complete", async () => {
    const report = await runBackfill({ dryRun: false }, deps());

    expect(report.outcome).toBe("committed");
  });

  it("reports zero counters when refused", async () => {
    const report = await runBackfill({ dryRun: false }, deps({ readBanks: shortRead }));

    expect(report.customers).toEqual({ created: 0, existing: 0, failed: 0 });
    expect(report.accounts).toEqual({ created: 0, updated: 0, failed: 0, blocked: 0 });
  });
});

/**
 * HONEST OUTCOMES.
 *
 * The report must describe what happened to the DATABASE, not what the run
 * intended. Counters accumulated before an abort described rows PostgreSQL had
 * already discarded.
 */
describe("runBackfill — outcome reflects the database", () => {
  it("marks a committed run committed", async () => {
    const report = await runBackfill({ dryRun: false }, deps());
    expect(report.outcome).toBe("committed");
  });

  it("marks a dry run as a dry run, not committed", async () => {
    const report = await runBackfill({ dryRun: true }, deps());
    expect(report.outcome).toBe("dry-run");
    expect(report.customers.created).toBe(1); // a forecast, and labelled as one
  });

  it("zeroes every creation counter when the transaction aborts", async () => {
    const db = fakeDatabase();
    let calls = 0;

    const report = await runBackfill(
      { dryRun: false },
      deps({
        ...db.deps,
        readUsers: async () =>
          scan([user({ $id: "u-1", userId: "a-1" }), user({ $id: "u-2", userId: "a-2" })]),
        readBanks: async () => scan([]),
        upsertCustomer: async (input, client) => {
          calls += 1;
          if (calls === 2) {
            throw new ConstraintViolationError("boom", { sqlState: "23505" });
          }
          return db.deps.upsertCustomer(input, client);
        },
      })
    );

    // The first customer really was written before the abort. PostgreSQL threw
    // it away, so reporting "1 created" would describe a row that is not there.
    expect(report.outcome).toBe("rolled-back");
    expect(report.customers.created).toBe(0);
    expect(db.committed.customers).toHaveLength(0);
  });

  it("rethrows a programming error instead of dressing it as an outcome", async () => {
    // A bug in this file must not exit 1 looking like bad source data.
    const thrown = await runBackfill(
      { dryRun: false },
      deps({
        upsertCustomer: async () => {
          throw new TypeError("undefined is not a function");
        },
      })
    ).then(
      (report) => report,
      (e: unknown) => e
    );

    // withTransaction rethrows the callback's error UNCHANGED, so a programming
    // defect arrives here as itself and keeps propagating.
    expect(thrown).toBeInstanceOf(TypeError);
  });
});

/**
 * BINDING A DRY RUN TO WHAT IT APPROVED.
 *
 * Appwrite stays live, so a dry run reads dataset A and the commit that follows
 * independently reads whatever is there then. Counts cannot detect a change —
 * one delete plus one insert leaves them identical.
 */
describe("runBackfill — source fingerprint binding", () => {
  it("reports a fingerprint for the dataset it read", async () => {
    const report = await runBackfill({ dryRun: true }, deps());

    expect(report.source.fingerprint).toBeTruthy();
  });

  it("commits when the fingerprint still matches", async () => {
    const dry = await runBackfill({ dryRun: true }, deps());

    const wet = await runBackfill(
      { dryRun: false, expectSourceFingerprint: dry.source.fingerprint },
      deps()
    );

    expect(wet.outcome).toBe("committed");
  });

  it("REFUSES when the source moved since the dry run", async () => {
    const db = fakeDatabase();

    const report = await runBackfill(
      { dryRun: false, expectSourceFingerprint: "fp-from-an-older-dry-run" },
      deps({ ...db.deps })
    );

    expect(report.outcome).toBe("refused");
    expect(report.refusedBecause).toContain("source changed");
    expect(db.committed.customers).toHaveLength(0);
  });

  it("makes no provider call when it refuses on a changed source", async () => {
    const enrich = vi.fn(async () => ({
      ok: true as const,
      currency: "USD",
      metadata: FALLBACK_METADATA,
    }));

    await runBackfill(
      { dryRun: false, expectSourceFingerprint: "stale" },
      deps({ enrich })
    );

    expect(enrich).not.toHaveBeenCalled();
  });

  it("runs unbound when no fingerprint is supplied", async () => {
    // The flag is opt-in. Requiring it would make a first run impossible.
    const report = await runBackfill({ dryRun: false }, deps());

    expect(report.outcome).toBe("committed");
  });
});

/**
 * SERIALISING CONCURRENT MIGRATIONS.
 *
 * Two backfills at once both insert the same customer. ON CONFLICT arbitrates
 * only appwrite_auth_id, so the loser can still trip the unique index on
 * appwrite_user_document_id and report a 23505 that is nothing but a race with
 * itself.
 */
describe("runBackfill — migration lock", () => {
  it("takes the lock as the FIRST statement in the transaction", async () => {
    const order: string[] = [];
    const db = fakeDatabase();

    await runBackfill(
      { dryRun: false },
      deps({
        acquireLock: async () => {
          order.push("lock");
        },
        upsertCustomer: async (input, client) => {
          order.push("customer");
          return db.deps.upsertCustomer(input, client);
        },
        upsertAccount: db.deps.upsertAccount,
        runInTransaction: db.deps.runInTransaction,
      })
    );

    // A lock taken after the first write would leave a window in which two runs
    // both insert.
    expect(order[0]).toBe("lock");
  });

  it("takes the lock during a dry run too", async () => {
    const acquireLock = vi.fn(async () => undefined);

    await runBackfill({ dryRun: true }, deps({ acquireLock }));

    expect(acquireLock).toHaveBeenCalledTimes(1);
  });

  it("does not take the lock when the run is refused", async () => {
    const acquireLock = vi.fn(async () => undefined);

    await runBackfill(
      { dryRun: false },
      deps({
        acquireLock,
        readBanks: async () => scan([bank()], { reportedTotal: 40, complete: false }),
      })
    );

    expect(acquireLock).not.toHaveBeenCalled();
  });
});
