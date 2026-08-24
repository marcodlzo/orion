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
import type { LegacyBankDocument, LegacyUserDocument } from "./appwrite-source";
import { runBackfill, type BackfillDeps } from "./backfill";
import { FALLBACK_METADATA } from "./enrichment";

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
    readUsers: async () => [user()],
    readBanks: async () => [bank()],
    enrich: async () => ({
      ok: true,
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
    expect(report.accounts).toEqual({ created: 1, updated: 0, failed: 0 });
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
        readBanks: async () => [
          bank({
            accessToken: "access-sandbox-must-not-persist",
            processorToken: "processor-must-not-persist",
            fundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/x",
          }),
        ],
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
        readBanks: async () => [bank({ currentBalance: 4210.55 })],
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
          reason: "provider error: ITEM_LOGIN_REQUIRED",
          metadata: FALLBACK_METADATA,
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
          reason: "provider error: ITEM_LOGIN_REQUIRED",
          metadata: FALLBACK_METADATA,
        }),
      })
    );

    expect(report.enrichmentFailures).toEqual([
      {
        legacyBankDocumentId: "bank-doc-1",
        reason: "provider error: ITEM_LOGIN_REQUIRED",
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
          return { ok: true, metadata: FALLBACK_METADATA };
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
    const enrich = vi.fn(async () => ({ ok: true as const, metadata: FALLBACK_METADATA }));

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
        readUsers: async () => [user({ $id: "user-doc-1", userId: "" })],
        readBanks: async () => [bank()],
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
        readUsers: async () => [
          user({ $id: "a", userId: "auth-a" }),
          user({ $id: "b", userId: "auth-b" }),
        ],
        readBanks: async () => [
          bank({ $id: "bank-a", userId: "a" }),
          bank({ $id: "bank-b", userId: "b" }),
          bank({ $id: "bank-c", userId: "ghost" }),
        ],
      })
    );

    expect(report.source).toEqual({ users: 2, banks: 3 });
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
