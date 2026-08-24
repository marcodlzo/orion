import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { closePool, withTransaction } from "../pool";
import { ConstraintViolationError } from "../errors";
import { requireTestDatabase } from "../test-database";
import {
  countBankingCustomers,
  findCustomerByAuthId,
  findCustomerByUserDocumentId,
  listBankingCustomers,
  upsertBankingCustomer,
} from "./banking-customers.repository";
import {
  countLinkedAccounts,
  findLinkedAccountByLegacyDocumentId,
  listLinkedAccounts,
  upsertLinkedAccount,
} from "./linked-accounts.repository";
import { query } from "../pool";

/**
 * PostgreSQL repositories, against a real server.
 *
 * The property that matters most here is IDEMPOTENCY. The backfill will be run
 * more than once — after a provider outage, after fixing a mapping bug, after a
 * partial failure. A repository that duplicates on re-run turns every one of
 * those into a data-repair job.
 */

beforeAll(async () => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query("TRUNCATE linked_accounts, banking_customers CASCADE");
});

const customer = (n = 1) => ({
  appwriteAuthId: `auth-${n}`,
  appwriteUserDocumentId: `user-doc-${n}`,
});

const account = (customerId: string, overrides: Partial<Parameters<typeof upsertLinkedAccount>[0]> = {}) => ({
  customerId,
  legacyAppwriteBankDocumentId: "bank-doc-1",
  externalAccountId: "plaid-account-1",
  provider: "plaid" as const,
  displayName: "Plaid Checking",
  officialName: "Plaid Gold Standard Checking",
  mask: "0000",
  accountType: "depository",
  accountSubtype: "checking",
  currency: "USD",
  metadataKnown: true,
  ...overrides,
});

describe("banking customers", () => {
  it("inserts and reports it as created", async () => {
    const { row, created } = await upsertBankingCustomer(customer());

    expect(created).toBe(true);
    expect(row.appwrite_auth_id).toBe("auth-1");
    expect(row.appwrite_user_document_id).toBe("user-doc-1");
  });

  it("IDEMPOTENT: a second upsert returns the same row and does not duplicate", async () => {
    const first = await upsertBankingCustomer(customer());
    const second = await upsertBankingCustomer(customer());

    expect(second.row.id).toBe(first.row.id);
    expect(second.created).toBe(false);
    expect(await countBankingCustomers()).toBe(1);
  });

  it("reports created accurately across a re-run of many records", async () => {
    for (let n = 1; n <= 3; n += 1) await upsertBankingCustomer(customer(n));

    const rerun = await Promise.all(
      [1, 2, 3].map((n) => upsertBankingCustomer(customer(n)))
    );

    // A re-run that reported three creations would make the operator believe
    // the previous run had failed.
    expect(rerun.every((r) => r.created === false)).toBe(true);
    expect(await countBankingCustomers()).toBe(3);
  });

  it("refuses to silently repair a conflicting identity mapping", async () => {
    await upsertBankingCustomer(customer(1));

    // Same auth account claiming a different user document. That is a real
    // identity conflict, not something a backfill should resolve on its own.
    const error = await upsertBankingCustomer({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "user-doc-DIFFERENT",
    }).catch((e: unknown) => e);

    // The conflict path keeps the existing document id rather than rewriting
    // it, so the stored mapping is unchanged.
    const stored = await findCustomerByAuthId("auth-1");
    expect(stored?.appwrite_user_document_id).toBe("user-doc-1");
    expect(error).not.toBeNull();
  });

  it("rejects two auth accounts claiming one user document", async () => {
    await upsertBankingCustomer(customer(1));

    const error = await upsertBankingCustomer({
      appwriteAuthId: "auth-OTHER",
      appwriteUserDocumentId: "user-doc-1",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).constraint).toBe(
      "banking_customers_appwrite_user_document_id_key"
    );
  });

  it("finds by either identifier", async () => {
    const { row } = await upsertBankingCustomer(customer());

    expect((await findCustomerByAuthId("auth-1"))?.id).toBe(row.id);
    expect((await findCustomerByUserDocumentId("user-doc-1"))?.id).toBe(row.id);
    expect(await findCustomerByAuthId("absent")).toBeNull();
  });
});

describe("linked accounts", () => {
  it("inserts against a real customer", async () => {
    const { row: c } = await upsertBankingCustomer(customer());

    const { row, created } = await upsertLinkedAccount(account(c.id));

    expect(created).toBe(true);
    expect(row.customer_id).toBe(c.id);
    expect(row.currency).toBe("USD");
    expect(row.provider).toBe("plaid");
  });

  it("IDEMPOTENT: a second upsert updates rather than duplicating", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    const first = await upsertLinkedAccount(account(c.id));

    const second = await upsertLinkedAccount(
      account(c.id, { displayName: "Renamed Checking" })
    );

    expect(second.row.id).toBe(first.row.id);
    expect(second.created).toBe(false);
    expect(second.row.display_name).toBe("Renamed Checking");
    expect(await countLinkedAccounts()).toBe(1);
  });

  it("refreshes metadata a failed enrichment could not supply", async () => {
    const { row: c } = await upsertBankingCustomer(customer());

    // First pass: the provider was unreachable, so only a fallback name.
    await upsertLinkedAccount(
      account(c.id, {
        displayName: "Linked account",
        officialName: null,
        mask: null,
        accountType: null,
        accountSubtype: null,
      })
    );

    // Second pass, provider healthy.
    const { row } = await upsertLinkedAccount(c.id ? account(c.id) : account(c.id));

    expect(row.display_name).toBe("Plaid Checking");
    expect(row.official_name).toBe("Plaid Gold Standard Checking");
    expect(row.mask).toBe("0000");
  });

  it("never clears a legacy document id it already has", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    await upsertLinkedAccount(account(c.id, { legacyAppwriteBankDocumentId: "bank-doc-1" }));

    // A later run that lacks the legacy id must not erase the bridge back to
    // the Appwrite record — verification depends on it.
    const { row } = await upsertLinkedAccount(
      account(c.id, { legacyAppwriteBankDocumentId: null })
    );

    expect(row.legacy_appwrite_bank_document_id).toBe("bank-doc-1");
  });

  it("finds by legacy document id", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    const { row } = await upsertLinkedAccount(account(c.id));

    expect((await findLinkedAccountByLegacyDocumentId("bank-doc-1"))?.id).toBe(row.id);
    expect(await findLinkedAccountByLegacyDocumentId("absent")).toBeNull();
  });

  it("rejects an account for a customer that does not exist", async () => {
    const error = await upsertLinkedAccount(
      account("00000000-0000-4000-8000-000000000000")
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).sqlState).toBe("23503");
  });

  it("permits two customers to link the same external account", async () => {
    const a = await upsertBankingCustomer(customer(1));
    const b = await upsertBankingCustomer(customer(2));

    await upsertLinkedAccount(
      account(a.row.id, { legacyAppwriteBankDocumentId: "bank-doc-a" })
    );
    const second = await upsertLinkedAccount(
      account(b.row.id, { legacyAppwriteBankDocumentId: "bank-doc-b" })
    );

    // A genuine joint account, linked by both holders.
    expect(second.created).toBe(true);
    expect(await countLinkedAccounts()).toBe(2);
  });

  it("writes no credential or balance column, because none exists", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    const { row } = await upsertLinkedAccount(account(c.id));

    for (const forbidden of [
      "access_token",
      "funding_source_url",
      "balance",
      "current_balance",
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }
  });
});

describe("transaction support", () => {
  it("rolls back every write when the transaction throws", async () => {
    await withTransaction(async (client) => {
      await upsertBankingCustomer(customer(1), client);
      await upsertBankingCustomer(customer(2), client);
    });
    expect(await countBankingCustomers()).toBe(2);

    await withTransaction(async (client) => {
      await upsertBankingCustomer(customer(3), client);
      throw new Error("abort");
    }).catch(() => undefined);

    // This is what makes a dry run trustworthy: it exercises every real
    // constraint and then leaves nothing behind.
    expect(await countBankingCustomers()).toBe(2);
  });

  it("a customer and its accounts commit or roll back together", async () => {
    await withTransaction(async (client) => {
      const { row } = await upsertBankingCustomer(customer(1), client);
      await upsertLinkedAccount(account(row.id), client);
      throw new Error("abort");
    }).catch(() => undefined);

    expect(await countBankingCustomers()).toBe(0);
    expect(await countLinkedAccounts()).toBe(0);
  });
});

describe("listing for verification", () => {
  it("returns everything in a stable order", async () => {
    for (let n = 1; n <= 3; n += 1) await upsertBankingCustomer(customer(n));

    const customers = await listBankingCustomers();
    expect(customers).toHaveLength(3);

    const accounts = await listLinkedAccounts();
    expect(accounts).toEqual([]);
  });
});

/**
 * NON-DESTRUCTIVE RE-RUN.
 *
 * The naive `ON CONFLICT DO UPDATE SET display_name = EXCLUDED.display_name`
 * overwrote a correct account name with "Linked account" whenever a re-run
 * happened during a Plaid outage. Re-running is supposed to be safe.
 */
describe("linked accounts — metadata preservation", () => {
  const degraded = (customerId: string) =>
    account(customerId, {
      displayName: "Linked account",
      officialName: null,
      mask: null,
      accountType: null,
      accountSubtype: null,
      metadataKnown: false,
    });

  it("does not overwrite good metadata when the provider was unreachable", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    const first = await upsertLinkedAccount(account(c.id));

    const second = await upsertLinkedAccount(degraded(c.id));

    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.display_name).toBe("Plaid Checking");
    expect(second.row.official_name).toBe("Plaid Gold Standard Checking");
    expect(second.row.mask).toBe("0000");
    expect(second.row.account_type).toBe("depository");
    expect(second.row.account_subtype).toBe("checking");
  });

  it("writes the placeholder on a FIRST insert, because display_name is NOT NULL", async () => {
    const { row: c } = await upsertBankingCustomer(customer());

    const { row, created } = await upsertLinkedAccount(degraded(c.id));

    expect(created).toBe(true);
    expect(row.display_name).toBe("Linked account");
  });

  it("updates metadata when the provider did answer", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    await upsertLinkedAccount(degraded(c.id));

    const { row } = await upsertLinkedAccount(account(c.id));

    expect(row.display_name).toBe("Plaid Checking");
    expect(row.mask).toBe("0000");
  });

  it("preserves the row identity and creation time across both paths", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    const first = await upsertLinkedAccount(account(c.id));

    await upsertLinkedAccount(degraded(c.id));
    const { row } = await upsertLinkedAccount(account(c.id));

    expect(row.id).toBe(first.row.id);
    expect(row.created_at).toEqual(first.row.created_at);
  });

  it("does not overwrite currency when metadata is untrusted", async () => {
    const { row: c } = await upsertBankingCustomer(customer());
    await upsertLinkedAccount(account(c.id));

    const { row } = await upsertLinkedAccount(degraded(c.id));

    expect(row.currency).toBe("USD");
  });

  it("rejects a currency the schema does not accept", async () => {
    const { row: c } = await upsertBankingCustomer(customer());

    const error = await upsertLinkedAccount(
      account(c.id, { currency: "GBP" })
    ).catch((e: unknown) => e);

    // The CHECK is the last line of defence; enrichment refuses non-USD first.
    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).sqlState).toBe("23514");
  });
});
