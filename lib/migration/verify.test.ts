import { describe, expect, it } from "vitest";

import type { BankingCustomerRow } from "../db/repositories/banking-customers.repository";
import type { LinkedAccountRow } from "../db/repositories/linked-accounts.repository";
import type {
  LegacyBankDocument,
  LegacyUserDocument,
  SourceScan,
} from "./appwrite-source";
import { verifyMigration, type VerifyDeps } from "./verify";

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

/**
 * PostgreSQL is read as ONE snapshot, so the fake supplies it as one value.
 * Overrides name the tables directly for readability.
 */
function deps(
  over: Partial<VerifyDeps> & {
    customers?: () => Promise<BankingCustomerRow[]>;
    accounts?: () => Promise<LinkedAccountRow[]>;
  } = {}
): VerifyDeps {
  const { customers, accounts, ...rest } = over;
  return {
    readUsers: async () => scan([user()]),
    readBanks: async () => scan([bank()]),
    readPostgres: async () => ({
      customers: customers ? await customers() : [customerRow()],
      accounts: accounts ? await accounts() : [accountRow()],
      isolation: "repeatable read",
    }),
    ...rest,
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

    expect(report.legacy).toMatchObject({
      users: 1,
      banks: 1,
      migratable: { customers: 1, accounts: 1 },
    });
    expect(report.postgres).toMatchObject({ customers: 1, accounts: 1 });
  });

  it("FAILS when a source record was skipped, rather than reporting no drift", async () => {
    // The defect this replaces: a skipped record was merely counted, and the
    // verifier then said "No drift" and exited 0. A duplicate auth id or a
    // dropped bank link is not a match between the two stores — it is a record
    // that did not migrate.
    const report = await verifyMigration(
      deps({
        readUsers: async () => scan([user(), user({ $id: "partial", userId: "" })]),
        readBanks: async () => scan([bank()]),
      })
    );

    expect(report.ok).toBe(false);
    expect(report.skippedBySource).toBe(1);
    expect(report.drift).toContainEqual({
      category: "unmigrated-source-record",
      id: "user partial",
      detail: expect.stringContaining("MISSING_AUTH_ID"),
    });
  });

  it("passes only once an operator explicitly acknowledges that record", async () => {
    const withPartial = deps({
      readUsers: async () => scan([user(), user({ $id: "partial", userId: "" })]),
      readBanks: async () => scan([bank()]),
    });

    // Acknowledgement is a deliberate, recorded act — not a default. "The
    // mapper skipped it" and "a human agreed it should be skipped" are
    // different facts, and only the second justifies a green verification.
    const acknowledged = await verifyMigration(withPartial, {
      acknowledged: ["MISSING_AUTH_ID:partial"],
    });

    expect(acknowledged.ok).toBe(true);
    expect(acknowledged.skippedBySource).toBe(1);
  });

  it("does not let acknowledging one code hide a different one", async () => {
    const report = await verifyMigration(
      deps({
        readUsers: async () => scan([user(), user({ $id: "dupe", userId: "auth-1" })]),
        readBanks: async () => scan([bank()]),
      }),
      { acknowledged: ["MISSING_AUTH_ID:partial"] }
    );

    expect(report.ok).toBe(false);
    expect(report.drift.some((d) => d.detail.includes("DUPLICATE_AUTH_ID"))).toBe(true);
  });
});

describe("verifyMigration — missing data", () => {
  it("flags a customer that never landed", async () => {
    const report = await verifyMigration(
      deps({ customers: async () => [], accounts: async () => [] })
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
    const report = await verifyMigration(deps({ accounts: async () => [] }));

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
        readBanks: async () => scan([
          bank({ $id: "bank-a", accountId: "acct-a" }),
          bank({ $id: "bank-b", accountId: "acct-b" }),
        ]),
        accounts: async () => [],
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
        customers: async () => [
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
        accounts: async () => [
          accountRow(),
          accountRow({
            id: "uuid-ghost",
            external_account_id: "acct-deleted",
            legacy_appwrite_bank_document_id: "bank-doc-deleted",
          }),
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
      customers: async () => [customerRow({ appwrite_auth_id: "auth-deleted" })],
    });

    expect(Object.keys(verifyDeps).sort()).toEqual([
      "readBanks",
      "readPostgres",
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
        customers: async () => [
          customerRow({ appwrite_user_document_id: "some-other-doc" }),
        ],
        // The account's owner lookup goes by document id, so it also drifts.
        accounts: async () => [],
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
        accounts: async () => [
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
        accounts: async () => [
          accountRow({ legacy_appwrite_bank_document_id: null }),
        ],
      })
    );

    expect(report.drift[0].detail).toContain("nothing");
  });
});

describe("verifyMigration — duplicate PostgreSQL bridges", () => {
  it("reports every duplicated customer bridge with its multiplicity", async () => {
    const report = await verifyMigration(
      deps({
        customers: async () => [
          customerRow({ id: "uuid-customer-3" }),
          customerRow({ id: "uuid-customer-1" }),
          customerRow({ id: "uuid-customer-2" }),
        ],
      })
    );

    expect(report.ok).toBe(false);
    expect(report.drift).toEqual([
      {
        category: "duplicate-customer",
        id: "auth auth-1",
        detail:
          "3 PostgreSQL rows share this bridge: uuid-customer-1, uuid-customer-2, uuid-customer-3",
      },
      {
        category: "duplicate-customer",
        id: "user document user-doc-1",
        detail:
          "3 PostgreSQL rows share this bridge: uuid-customer-1, uuid-customer-2, uuid-customer-3",
      },
    ]);
  });

  it("reports every duplicated account bridge with its multiplicity", async () => {
    const report = await verifyMigration(
      deps({
        accounts: async () => [
          accountRow({ id: "uuid-account-3" }),
          accountRow({ id: "uuid-account-1" }),
          accountRow({ id: "uuid-account-2" }),
        ],
      })
    );

    expect(report.ok).toBe(false);
    expect(report.drift).toEqual([
      {
        category: "duplicate-account",
        id: "natural key (uuid-customer-1, plaid, plaid-account-1)",
        detail:
          "3 PostgreSQL rows share this bridge: uuid-account-1, uuid-account-2, uuid-account-3",
      },
      {
        category: "duplicate-account",
        id: "legacy bank document bank-doc-1",
        detail:
          "3 PostgreSQL rows share this bridge: uuid-account-1, uuid-account-2, uuid-account-3",
      },
    ]);
  });
});

describe("verifyMigration — degraded enrichment", () => {
  it("flags an account still carrying placeholder metadata", async () => {
    const report = await verifyMigration(
      deps({ accounts: async () => [accountRow({ display_name: "Linked account" })] })
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
      customers: async () => [customerRow()],
      accounts: async () => [accountRow()],
    };

    const matching = await verifyMigration(deps(pg));
    expect(matching.ok).toBe(true);

    const afterNewSignup = await verifyMigration(
      deps({
        ...pg,
        readUsers: async () => scan([user(), user({ $id: "user-doc-2", userId: "auth-2" })]),
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
        readUsers: async () => scan([
          user({ $id: "doc-a", userId: "auth-a" }),
          user({ $id: "doc-b", userId: "auth-b" }),
        ]),
        readBanks: async () => scan([
          bank({ $id: "bank-a", userId: "doc-a", accountId: "shared" }),
          bank({ $id: "bank-b", userId: "doc-b", accountId: "shared" }),
        ]),
        customers: async () => [
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
        accounts: async () => [
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
        readBanks: async () => scan([bank({ accessToken: "access-sandbox-must-not-appear" })]),
        accounts: async () => [],
      })
    );

    expect(JSON.stringify(report)).not.toContain("access-sandbox-must-not-appear");
  });

  it("is ok only when the drift list is empty", async () => {
    const clean = await verifyMigration(deps());
    const dirty = await verifyMigration(deps({ accounts: async () => [] }));

    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(false);
    expect(dirty.drift.length).toBeGreaterThan(0);
  });
});

/**
 * A verification over a partial source read is not a verification.
 *
 * Every record the walk missed looks exactly like a PostgreSQL row with no
 * source — an orphan. The verifier would then report drift it invented, or
 * worse, report `ok` because the small source happened to match a small target.
 */
describe("verifyMigration — source completeness", () => {
  it("is not ok when the user scan was short", async () => {
    const report = await verifyMigration(
      deps({
        readUsers: async () =>
          scan([user()], { scanned: 1, reportedTotal: 90, complete: false }),
      })
    );

    expect(report.ok).toBe(false);
    expect(report.drift).toContainEqual({
      category: "incomplete-source-scan",
      id: "users",
      detail: expect.stringContaining("90"),
    });
  });

  it("is not ok when the bank scan was short", async () => {
    const report = await verifyMigration(
      deps({
        readBanks: async () =>
          scan([bank()], { reportedTotal: 12, complete: false }),
      })
    );

    expect(report.ok).toBe(false);
    expect(report.drift.some((d) => d.category === "incomplete-source-scan")).toBe(true);
  });

  it("carries the scan evidence into the report", async () => {
    const report = await verifyMigration(
      deps({
        readUsers: async () => scan([user()], { pages: 4 }),
        readBanks: async () => scan([bank()], { pages: 2 }),
      })
    );

    expect(report.legacy.scan).toMatchObject({
      users: { scanned: 1, reportedTotal: 1, pages: 4 },
      banks: { scanned: 1, reportedTotal: 1, pages: 2 },
      complete: true,
    });
    // Ties a green verification to the dataset it actually saw.
    expect(report.legacy.scan.fingerprint).toBeTruthy();
  });

  it("still reports ordinary drift alongside an incomplete scan", async () => {
    const report = await verifyMigration(
      deps({
        readUsers: async () =>
          scan([user()], { reportedTotal: 5, complete: false }),
        accounts: async () => [],
      })
    );

    const categories = report.drift.map((d) => d.category);
    expect(categories).toContain("incomplete-source-scan");
    expect(categories).toContain("missing-account");
  });
});

/**
 * The verifier re-derives expectations from the source. It never reads the
 * backfill's counters, so it can contradict a backfill that reported success.
 */
describe("verifyMigration — independence, stated concretely", () => {
  it("takes no backfill report as input", () => {
    // Structural, not behavioural: there is no parameter through which a
    // backfill's bookkeeping could reach the verifier.
    const verifyDeps = deps();
    expect(Object.keys(verifyDeps).sort()).toEqual([
      "readBanks",
      "readPostgres",
      "readUsers",
    ]);
  });

  it("detects a customer the backfill would have reported as written", async () => {
    // The backfill's own counters would say "1 created". PostgreSQL disagrees.
    const report = await verifyMigration(deps({ customers: async () => [] }));

    expect(report.ok).toBe(false);
    expect(report.drift.map((d) => d.category)).toContain("missing-customer");
  });

  it("detects an identity bridge pointing at the wrong document", async () => {
    const report = await verifyMigration(
      deps({
        customers: async () => [
          customerRow({ appwrite_user_document_id: "someone-else" }),
        ],
        accounts: async () => [],
      })
    );

    expect(report.drift.map((d) => d.category)).toContain("mismatched-customer");
  });
});

/**
 * THE VERIFIER'S NATURAL KEY MUST MATCH THE SCHEMA'S UNIQUE INDEX.
 *
 * The index is `(customer_id, provider, external_account_id)`. If the verifier
 * keys on anything narrower, its "duplicate" and "orphan" conclusions describe a
 * different database than the one PostgreSQL is enforcing.
 *
 * `provider` currently has a CHECK of 'plaid', so no fixture distinguishes the
 * two keyings by accident — which is precisely why dropping `provider` from the
 * key left every other test green.
 */
describe("verifyMigration — natural key composition", () => {
  it("does NOT treat two providers on one account as a duplicate", () => {
    return verifyMigration(
      deps({
        accounts: async () => [
          accountRow({ id: "uuid-plaid" }),
          accountRow({
            id: "uuid-other",
            provider: "dwolla",
            legacy_appwrite_bank_document_id: "bank-doc-other",
          }),
        ],
      })
    ).then((report) => {
      // Same customer, same external account, different provider — three
      // columns, so two distinct rows under the schema's index.
      const duplicates = report.drift.filter((d) => d.category === "duplicate-account");
      expect(duplicates).toEqual([]);
    });
  });

  it("still reports a genuine duplicate within one provider", async () => {
    const report = await verifyMigration(
      deps({
        accounts: async () => [
          accountRow({ id: "uuid-a" }),
          accountRow({ id: "uuid-b", legacy_appwrite_bank_document_id: "bank-doc-b" }),
        ],
      })
    );

    const duplicates = report.drift.filter((d) => d.category === "duplicate-account");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].id).toContain("plaid");
  });

  it("names the provider in the duplicate's natural key", async () => {
    const report = await verifyMigration(
      deps({
        accounts: async () => [
          accountRow({ id: "uuid-a" }),
          accountRow({ id: "uuid-b", legacy_appwrite_bank_document_id: "bank-doc-b" }),
        ],
      })
    );

    // An operator reading this has to be able to find the rows. Omitting the
    // provider would make the identifier ambiguous the moment a second one
    // exists.
    expect(report.drift.find((d) => d.category === "duplicate-account")!.id).toBe(
      "natural key (uuid-customer-1, plaid, plaid-account-1)"
    );
  });
});

/**
 * ORPHANS ARE COUNTED PER ROW, NOT PER KEY.
 *
 * The orphan scan walks every PostgreSQL row. Walking the deduplicated index
 * instead would report N rows sharing a key as a single orphan, so an operator
 * cleaning up would delete one row and believe the drift was resolved.
 */
describe("verifyMigration — orphan multiplicity", () => {
  it("reports every orphaned row, not one per natural key", async () => {
    const report = await verifyMigration(
      deps({
        accounts: async () => [
          accountRow(),
          accountRow({
            id: "uuid-orphan-1",
            external_account_id: "acct-gone",
            legacy_appwrite_bank_document_id: "bank-gone-1",
          }),
          accountRow({
            id: "uuid-orphan-2",
            external_account_id: "acct-gone",
            legacy_appwrite_bank_document_id: "bank-gone-2",
          }),
        ],
      })
    );

    const orphans = report.drift.filter((d) => d.category === "orphan-account");
    expect(orphans).toHaveLength(2);
    expect(orphans.map((o) => o.id).sort()).toEqual(["uuid-orphan-1", "uuid-orphan-2"]);
  });

  it("reports the shared key as a duplicate as well", async () => {
    const report = await verifyMigration(
      deps({
        accounts: async () => [
          accountRow(),
          accountRow({
            id: "uuid-orphan-1",
            external_account_id: "acct-gone",
            legacy_appwrite_bank_document_id: "bank-gone-1",
          }),
          accountRow({
            id: "uuid-orphan-2",
            external_account_id: "acct-gone",
            legacy_appwrite_bank_document_id: "bank-gone-2",
          }),
        ],
      })
    );

    // Both facts are true and an operator needs both: two rows to remove, and
    // the reason they collided.
    expect(
      report.drift.filter((d) => d.category === "duplicate-account")
    ).toHaveLength(1);
  });
});
