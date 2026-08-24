import { describe, expect, it, vi } from "vitest";

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
    "runInTransaction" | "upsertCustomer" | "upsertAccount"
  > = {
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
        // withTransaction re-wraps what the body threw; mirror that so the
        // unwrapping in runBackfill is genuinely exercised.
        throw new Error("transaction failed", { cause: error });
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

  it("does not swallow a genuine failure as if it were the rollback", async () => {
    const db = fakeDatabase();

    await expect(
      runBackfill(
        { dryRun: true },
        deps({
          ...db.deps,
          runInTransaction: async () => {
            throw new Error("connection lost");
          },
        })
      )
    ).rejects.toThrow("connection lost");
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

    // An expired Plaid Item must not cost the customer their account record.
    expect(report.accounts.created).toBe(1);
    expect(report.enrichment).toEqual({ succeeded: 0, failed: 1 });
    expect(db.committed.accounts[0].displayName).toBe(FALLBACK_METADATA.displayName);
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
        blocked: false,
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
          throw Object.assign(
            new Error('duplicate key value violates unique constraint — Key (external_account_id)=(plaid-account-1) already exists'),
            { name: "ConstraintViolationError", code: "23505", constraint: "linked_accounts_customer_id_provider_external_account_id_key" }
          );
        },
      })
    );

    expect(report.accounts.failed).toBe(1);
    const [failure] = report.failures;
    expect(failure).toMatchObject({ kind: "account", id: "bank-doc-1" });
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
          throw new Error("nope");
        },
        upsertAccount,
      })
    );

    expect(upsertAccount).not.toHaveBeenCalled();
    expect(report.accounts.failed).toBe(1);
    expect(report.failures[1].reason).toContain("was not migrated");
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
describe("runBackfill — degraded enrichment on re-run", () => {
  const degraded = {
    ok: false as const,
    code: "PROVIDER_ERROR" as const,
    reason: "provider error: ITEM_LOGIN_REQUIRED",
    blocking: false,
    metadata: FALLBACK_METADATA,
    currency: null,
  };

  it("tells the repository the metadata is not trustworthy", async () => {
    const db = fakeDatabase();

    await runBackfill(
      { dryRun: false },
      deps({ ...db.deps, enrich: async () => degraded })
    );

    // metadataKnown false is what stops the repository overwriting good values.
    expect(db.committed.accounts[0].metadataKnown).toBe(false);
  });

  it("marks metadata trustworthy when the provider answered", async () => {
    const db = fakeDatabase();

    await runBackfill({ dryRun: false }, deps({ ...db.deps }));

    expect(db.committed.accounts[0].metadataKnown).toBe(true);
  });

  it("still migrates the account", async () => {
    const report = await runBackfill(
      { dryRun: false },
      deps({ enrich: async () => degraded })
    );

    // An expired Plaid Item must not cost the customer their account record.
    expect(report.accounts.created).toBe(1);
    expect(report.accounts.blocked).toBe(0);
  });
});

/**
 * BLOCKING ENRICHMENT FAILURES.
 *
 * Some failures must not produce a row at all, because writing one would mean
 * inventing a fact.
 */
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
          throw Object.assign(
            new Error(
              `insert failed for row (access_token=${ACCESS_TOKEN}) on ` +
                `postgresql://orion:${DB_PASSWORD}@localhost:5432/orion`
            ),
            { name: "ConstraintViolationError", code: "23505", constraint: "some_key" }
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
          throw new Error("connection failed");
        },
      })
    ).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(thrown).toBeInstanceOf(Error);
    assertClean(thrown!.message, "error message");
    assertClean(thrown!.stack ?? "", "error stack");
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
