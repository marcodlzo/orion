import { describe, expect, it } from "vitest";

import type { BankingCustomerRow } from "../db/repositories/banking-customers.repository";
import type { LinkedAccountRow } from "../db/repositories/linked-accounts.repository";
import type { LegacyBankDocument, LegacyUserDocument } from "./appwrite-source";
import { verifyMigration, type VerifyDeps } from "./verify";

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

const customerRow = (over: Partial<BankingCustomerRow> = {}): BankingCustomerRow =>
  ({
    id: "uuid-customer-1",
    appwrite_auth_id: "auth-1",
    appwrite_user_document_id: "user-doc-1",
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  }) as BankingCustomerRow;

const accountRow = (over: Partial<LinkedAccountRow> = {}): LinkedAccountRow =>
  ({
    id: "uuid-account-1",
    customer_id: "uuid-customer-1",
    legacy_appwrite_bank_document_id: "bank-doc-1",
    external_account_id: "plaid-account-1",
    provider: "plaid",
    display_name: "Plaid Checking",
    official_name: null,
    mask: "0000",
    account_type: "depository",
    account_subtype: "checking",
    currency: "USD",
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  }) as LinkedAccountRow;

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    readUsers: async () => [user()],
    readBanks: async () => [bank()],
    listCustomers: async () => [customerRow()],
    listAccounts: async () => [accountRow()],
    ...over,
  };
}

describe("verifyMigration — a matching migration", () => {
  it("reports no drift", async () => {
    const report = await verifyMigration(deps());

    expect(report.ok).toBe(true);
    expect(report.drift).toHaveLength(0);
  });

  it("reports the counts on both sides", async () => {
    const report = await verifyMigration(deps());

    expect(report.legacy).toEqual({
      users: 1,
      banks: 1,
      migratable: { customers: 1, accounts: 1 },
    });
    expect(report.postgres).toEqual({ customers: 1, accounts: 1 });
  });

  it("does not count a source record that was never migratable as drift", async () => {
    // A user document with no auth account cannot be signed into and is not a
    // customer. Its absence from PostgreSQL is correct, not missing data.
    const report = await verifyMigration(
      deps({
        readUsers: async () => [user(), user({ $id: "partial", userId: "" })],
        readBanks: async () => [bank()],
      })
    );

    expect(report.ok).toBe(true);
    expect(report.skippedBySource).toBe(1);
  });
});

describe("verifyMigration — missing data", () => {
  it("flags a customer that never landed", async () => {
    const report = await verifyMigration(
      deps({ listCustomers: async () => [], listAccounts: async () => [] })
    );

    expect(report.ok).toBe(false);
    expect(report.drift).toEqual([
      {
        category: "missing-customer",
        id: "user-doc-1",
        detail: expect.stringContaining("auth-1"),
      },
      {
        category: "missing-account",
        id: "bank-doc-1",
        detail: expect.stringContaining("not in PostgreSQL"),
      },
    ]);
  });

  it("flags an account whose customer landed but the account did not", async () => {
    const report = await verifyMigration(deps({ listAccounts: async () => [] }));

    expect(report.drift).toEqual([
      {
        category: "missing-account",
        id: "bank-doc-1",
        detail: expect.stringContaining("plaid-account-1"),
      },
    ]);
  });

  it("counts one drift entry per missing account, not one per customer", async () => {
    const report = await verifyMigration(
      deps({
        readBanks: async () => [
          bank({ $id: "bank-a", accountId: "acct-a" }),
          bank({ $id: "bank-b", accountId: "acct-b" }),
        ],
        listAccounts: async () => [],
      })
    );

    expect(report.drift).toHaveLength(2);
    expect(report.drift.map((d) => d.id)).toEqual(["bank-a", "bank-b"]);
  });
});

describe("verifyMigration — orphans", () => {
  it("flags a PostgreSQL customer with no source document", async () => {
    const report = await verifyMigration(
      deps({
        listCustomers: async () => [
          customerRow(),
          customerRow({
            id: "uuid-ghost",
            appwrite_auth_id: "auth-deleted",
            appwrite_user_document_id: "doc-deleted",
          }),
        ],
      })
    );

    expect(report.drift).toEqual([
      {
        category: "orphan-customer",
        id: "uuid-ghost",
        detail: expect.stringContaining("auth-deleted"),
      },
    ]);
  });

  it("flags a PostgreSQL account with no source document", async () => {
    const report = await verifyMigration(
      deps({
        listAccounts: async () => [
          accountRow(),
          accountRow({ id: "uuid-ghost", external_account_id: "acct-deleted" }),
        ],
      })
    );

    expect(report.drift).toEqual([
      {
        category: "orphan-account",
        id: "uuid-ghost",
        detail: expect.stringContaining("acct-deleted"),
      },
    ]);
  });

  it("reports orphans rather than repairing them", async () => {
    // Read-only by construction: the deps carry no writer at all, so there is
    // nothing the verifier could call even if it wanted to. Deleting a customer
    // row because Appwrite no longer has the document would destroy financial
    // history on a tool's initiative.
    const verifyDeps = deps({
      listCustomers: async () => [customerRow({ appwrite_auth_id: "auth-deleted" })],
    });

    expect(Object.keys(verifyDeps).sort()).toEqual([
      "listAccounts",
      "listCustomers",
      "readBanks",
      "readUsers",
    ]);

    const before = await verifyMigration(verifyDeps);
    const after = await verifyMigration(verifyDeps);
    expect(after.drift).toEqual(before.drift);
  });
});

describe("verifyMigration — mismatches", () => {
  it("flags a customer bridged to the wrong user document", async () => {
    const report = await verifyMigration(
      deps({
        listCustomers: async () => [
          customerRow({ appwrite_user_document_id: "some-other-doc" }),
        ],
        // The account's owner lookup goes by document id, so it also drifts.
        listAccounts: async () => [],
      })
    );

    expect(report.drift[0]).toMatchObject({
      category: "mismatched-customer",
      id: "auth-1",
    });
  });

  it("flags an account bridged to the wrong legacy document", async () => {
    const report = await verifyMigration(
      deps({
        listAccounts: async () => [
          accountRow({ legacy_appwrite_bank_document_id: "bank-doc-other" }),
        ],
      })
    );

    expect(report.drift).toEqual([
      {
        category: "mismatched-account",
        id: "bank-doc-1",
        detail: expect.stringContaining("bank-doc-other"),
      },
    ]);
  });

  it("flags an account that was never bridged at all", async () => {
    const report = await verifyMigration(
      deps({
        listAccounts: async () => [
          accountRow({ legacy_appwrite_bank_document_id: null }),
        ],
      })
    );

    expect(report.drift[0].detail).toContain("nothing");
  });
});

describe("verifyMigration — degraded enrichment", () => {
  it("flags an account still carrying placeholder metadata", async () => {
    const report = await verifyMigration(
      deps({ listAccounts: async () => [accountRow({ display_name: "Linked account" })] })
    );

    // Not corruption — the provider was unreachable during the backfill — but
    // it must be visible, because a re-run fixes it and nothing else will.
    expect(report.ok).toBe(false);
    expect(report.drift[0]).toMatchObject({
      category: "unenriched-account",
      id: "bank-doc-1",
    });
  });
});

describe("verifyMigration — independence from the backfill", () => {
  it("re-derives what should exist from the source", async () => {
    // A verifier reading the backfill's own report could only confirm the
    // backfill agrees with itself. Here the source is changed underneath a
    // PostgreSQL state that was previously correct, and the drift appears.
    const pg = {
      listCustomers: async () => [customerRow()],
      listAccounts: async () => [accountRow()],
    };

    const matching = await verifyMigration(deps(pg));
    expect(matching.ok).toBe(true);

    const afterNewSignup = await verifyMigration(
      deps({
        ...pg,
        readUsers: async () => [user(), user({ $id: "user-doc-2", userId: "auth-2" })],
      })
    );

    expect(afterNewSignup.ok).toBe(false);
    expect(afterNewSignup.drift[0]).toMatchObject({
      category: "missing-customer",
      id: "user-doc-2",
    });
  });

  it("does not treat a joint account as drift", async () => {
    const report = await verifyMigration(
      deps({
        readUsers: async () => [
          user({ $id: "doc-a", userId: "auth-a" }),
          user({ $id: "doc-b", userId: "auth-b" }),
        ],
        readBanks: async () => [
          bank({ $id: "bank-a", userId: "doc-a", accountId: "shared" }),
          bank({ $id: "bank-b", userId: "doc-b", accountId: "shared" }),
        ],
        listCustomers: async () => [
          customerRow({
            id: "uuid-a",
            appwrite_auth_id: "auth-a",
            appwrite_user_document_id: "doc-a",
          }),
          customerRow({
            id: "uuid-b",
            appwrite_auth_id: "auth-b",
            appwrite_user_document_id: "doc-b",
          }),
        ],
        listAccounts: async () => [
          accountRow({
            id: "uuid-acct-a",
            customer_id: "uuid-a",
            external_account_id: "shared",
            legacy_appwrite_bank_document_id: "bank-a",
          }),
          accountRow({
            id: "uuid-acct-b",
            customer_id: "uuid-b",
            external_account_id: "shared",
            legacy_appwrite_bank_document_id: "bank-b",
          }),
        ],
      })
    );

    expect(report.drift).toHaveLength(0);
  });
});

describe("verifyMigration — report shape", () => {
  it("carries no provider credential into the report", async () => {
    const report = await verifyMigration(
      deps({
        readBanks: async () => [bank({ accessToken: "access-sandbox-must-not-appear" })],
        listAccounts: async () => [],
      })
    );

    expect(JSON.stringify(report)).not.toContain("access-sandbox-must-not-appear");
  });

  it("is ok only when the drift list is empty", async () => {
    const clean = await verifyMigration(deps());
    const dirty = await verifyMigration(deps({ listAccounts: async () => [] }));

    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(false);
    expect(dirty.drift.length).toBeGreaterThan(0);
  });
});
