import { describe, expect, it } from "vitest";

import type { LegacyBankDocument, LegacyUserDocument } from "./appwrite-source";
import { planMigration, resolveOwnerUserDocumentId } from "./mapping";

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

describe("resolveOwnerUserDocumentId", () => {
  it("reads a bare id string", () => {
    expect(resolveOwnerUserDocumentId("user-doc-1")).toBe("user-doc-1");
  });

  it("reads an expanded relationship document", () => {
    expect(resolveOwnerUserDocumentId({ $id: "user-doc-1", userId: "auth-1" })).toBe(
      "user-doc-1"
    );
  });

  it("takes $id, NOT the userId field, from an expanded document", () => {
    // The trap this codebase has hit before. The user document's userId FIELD
    // is the auth account id; bank ownership points at $id. Confusing them
    // silently reassigns every bank account to the wrong owner.
    const resolved = resolveOwnerUserDocumentId({
      $id: "user-doc-1",
      userId: "auth-1",
    });
    expect(resolved).toBe("user-doc-1");
    expect(resolved).not.toBe("auth-1");
  });

  it("returns empty for shapes it cannot read", () => {
    expect(resolveOwnerUserDocumentId(undefined)).toBe("");
    expect(resolveOwnerUserDocumentId(null)).toBe("");
    expect(resolveOwnerUserDocumentId(42)).toBe("");
    expect(resolveOwnerUserDocumentId({})).toBe("");
    expect(resolveOwnerUserDocumentId({ $id: 7 })).toBe("");
  });
});

describe("planMigration — customers", () => {
  it("maps the auth id and the document id to distinct fields", () => {
    const { customers } = planMigration([user()], []);

    expect(customers).toEqual([
      { appwriteAuthId: "auth-1", appwriteUserDocumentId: "user-doc-1" },
    ]);
  });

  it("skips a user document with no auth account", () => {
    const { customers, skipped } = planMigration(
      [user({ $id: "orphan", userId: "" })],
      []
    );

    expect(customers).toHaveLength(0);
    expect(skipped).toEqual([
      {
        kind: "user",
        id: "orphan",
        code: "MISSING_AUTH_ID",
        reason: expect.stringContaining("missing userId"),
      },
    ]);
  });

  it("skips the second of two user documents claiming one auth account", () => {
    const { customers, skipped } = planMigration(
      [user({ $id: "doc-a", userId: "auth-1" }), user({ $id: "doc-b", userId: "auth-1" })],
      []
    );

    // The target's unique index would reject the second. Reporting it here
    // means the operator sees it instead of the backfill dying halfway.
    expect(customers).toHaveLength(1);
    expect(customers[0].appwriteUserDocumentId).toBe("doc-a");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ kind: "user", id: "doc-b" });
    expect(skipped[0].code).toBe("DUPLICATE_AUTH_ID");
  });

  it("trims surrounding whitespace rather than migrating it", () => {
    const { customers } = planMigration(
      [user({ $id: "  doc-a  ", userId: "  auth-1  " })],
      []
    );

    expect(customers[0]).toEqual({
      appwriteAuthId: "auth-1",
      appwriteUserDocumentId: "doc-a",
    });
  });
});

describe("planMigration — accounts", () => {
  it("maps a bank document owned by a migratable user", () => {
    const { accounts, skipped } = planMigration([user()], [bank()]);

    expect(skipped).toHaveLength(0);
    expect(accounts).toEqual([
      {
        ownerUserDocumentId: "user-doc-1",
        legacyAppwriteBankDocumentId: "bank-doc-1",
        externalAccountId: "plaid-account-1",
        provider: "plaid",
        accessTokenForEnrichment: "access-sandbox-1",
      },
    ]);
  });

  it("resolves ownership through an expanded relationship", () => {
    const { accounts } = planMigration(
      [user()],
      [bank({ userId: { $id: "user-doc-1", userId: "auth-1" } })]
    );

    expect(accounts[0].ownerUserDocumentId).toBe("user-doc-1");
  });

  it("skips a bank whose owner was itself skipped", () => {
    // The user has no auth id, so it is not migrated; its bank would then
    // violate the foreign key. Both are reported.
    const { customers, accounts, skipped } = planMigration(
      [user({ $id: "user-doc-1", userId: "" })],
      [bank()]
    );

    expect(customers).toHaveLength(0);
    expect(accounts).toHaveLength(0);
    expect(skipped.map((s) => s.kind)).toEqual(["user", "bank"]);
    expect(skipped[1].reason).toContain("no migratable user record");
  });

  it("skips a bank pointing at a user that does not exist", () => {
    const { accounts, skipped } = planMigration([user()], [bank({ userId: "ghost" })]);

    expect(accounts).toHaveLength(0);
    expect(skipped[0].reason).toContain("ghost");
  });

  it("skips a bank with an unreadable owner relationship", () => {
    const { accounts, skipped } = planMigration([user()], [bank({ userId: null })]);

    expect(accounts).toHaveLength(0);
    expect(skipped[0].reason).toContain("missing or unreadable owner");
  });

  it("skips a bank with no provider account id", () => {
    const { accounts, skipped } = planMigration([user()], [bank({ accountId: "" })]);

    expect(accounts).toHaveLength(0);
    expect(skipped[0].reason).toContain("missing accountId");
  });

  it("keeps one of two links to the same account by the same owner", () => {
    const { accounts, skipped } = planMigration(
      [user()],
      [bank({ $id: "bank-a" }), bank({ $id: "bank-b" })]
    );

    expect(accounts).toHaveLength(1);
    expect(accounts[0].legacyAppwriteBankDocumentId).toBe("bank-a");
    expect(skipped[0]).toMatchObject({
      kind: "bank",
      id: "bank-b",
      code: "DUPLICATE_OWNER_ACCOUNT",
    });
    // The rule is named in the reason, not left for the reader to infer.
    expect(skipped[0].reason).toContain("bank-a");
    expect(skipped[0].reason).toContain("lowest document id");
  });

  it("allows two customers to link the same provider account", () => {
    // A joint account. The unique constraint is (customer, provider, account),
    // not (provider, account) — two people may genuinely share one account.
    const { accounts, skipped } = planMigration(
      [
        user({ $id: "doc-a", userId: "auth-a" }),
        user({ $id: "doc-b", userId: "auth-b" }),
      ],
      [
        bank({ $id: "bank-a", userId: "doc-a", accountId: "shared" }),
        bank({ $id: "bank-b", userId: "doc-b", accountId: "shared" }),
      ]
    );

    expect(accounts).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("still plans an account whose access token is missing", () => {
    // Enrichment will fail and the row gets placeholder metadata, but the link
    // itself is real data and must not be dropped for a provider's sake.
    const { accounts, skipped } = planMigration([user()], [bank({ accessToken: "" })]);

    expect(skipped).toHaveLength(0);
    expect(accounts[0].accessTokenForEnrichment).toBe("");
  });
});

describe("planMigration — what is deliberately not carried across", () => {
  const secretive = bank({
    accessToken: "access-sandbox-secret",
    shareableId: "c2hhcmVhYmxl",
    fundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/abc",
    processorToken: "processor-sandbox-secret",
  });

  it("puts no provider credential on the account plan beyond the enrichment token", () => {
    const { accounts } = planMigration([user()], [secretive]);
    const plan = accounts[0];

    expect(plan).not.toHaveProperty("fundingSourceUrl");
    expect(plan).not.toHaveProperty("processorToken");
    expect(plan).not.toHaveProperty("shareableId");
    expect(plan).not.toHaveProperty("bankId");
    // The one token that survives is named for its single purpose and is
    // consumed before the transaction opens; it has no column in the target.
    expect(Object.keys(plan)).toEqual([
      "ownerUserDocumentId",
      "legacyAppwriteBankDocumentId",
      "externalAccountId",
      "provider",
      "accessTokenForEnrichment",
    ]);
  });

  it("carries no PII from the user document", () => {
    const { customers } = planMigration(
      [
        user({
          ssn: "123-45-6789",
          dateOfBirth: "1990-01-01",
          address1: "1 Test Street",
          city: "Testville",
          postalCode: "12345",
          email: "person@example.invalid",
          firstName: "Test",
          lastName: "Person",
          dwollaCustomerId: "dwolla-1",
          dwollaCustomerUrl: "https://api-sandbox.dwolla.com/customers/dwolla-1",
        }),
      ],
      []
    );

    expect(Object.keys(customers[0])).toEqual([
      "appwriteAuthId",
      "appwriteUserDocumentId",
    ]);
  });

  it("carries no balance", () => {
    const { accounts } = planMigration(
      [user()],
      [bank({ currentBalance: 4210.55, availableBalance: 4000 })]
    );

    expect(JSON.stringify(accounts)).not.toContain("4210");
    expect(accounts[0]).not.toHaveProperty("currentBalance");
  });
});

describe("planMigration — reporting", () => {
  it("accounts for every input record exactly once", () => {
    const users = [
      user({ $id: "doc-a", userId: "auth-a" }),
      user({ $id: "doc-b", userId: "" }),
      user({ $id: "doc-c", userId: "auth-a" }),
    ];
    const banks = [
      bank({ $id: "bank-a", userId: "doc-a", accountId: "acct-1" }),
      bank({ $id: "bank-b", userId: "doc-b", accountId: "acct-2" }),
      bank({ $id: "bank-c", userId: "doc-a", accountId: "" }),
    ];

    const { customers, accounts, skipped } = planMigration(users, banks);

    // Nothing vanishes: mapped + skipped equals the input.
    expect(customers.length + accounts.length + skipped.length).toBe(
      users.length + banks.length
    );
  });

  it("gives every skip a non-empty reason", () => {
    const { skipped } = planMigration(
      [user({ $id: "", userId: "" })],
      [bank({ $id: "", userId: "" })]
    );

    expect(skipped).toHaveLength(2);
    for (const record of skipped) expect(record.reason.length).toBeGreaterThan(0);
  });

  it("is pure — the same input twice gives the same plan", () => {
    const users = [user()];
    const banks = [bank()];

    expect(planMigration(users, banks)).toEqual(planMigration(users, banks));
  });

  it("gives every skip a machine-readable code", () => {
    const { skipped } = planMigration(
      [user({ $id: "doc-a", userId: "" }), user({ $id: "doc-b", userId: "auth-b" })],
      [bank({ $id: "bank-x", userId: "ghost" }), bank({ $id: "bank-y", accountId: "" })]
    );

    // Prose is for humans; the code is what a script can branch on without
    // pattern-matching an English sentence that may be reworded.
    for (const record of skipped) {
      expect(record.code).toMatch(/^[A-Z_]+$/);
    }
  });

  it("does not mutate its inputs", () => {
    const users = [user()];
    const banks = [bank()];
    const before = JSON.stringify({ users, banks });

    planMigration(users, banks);

    expect(JSON.stringify({ users, banks })).toBe(before);
  });
});

/**
 * ORDER INDEPENDENCE.
 *
 * Appwrite does not promise a document order, and "whichever arrived first
 * wins" would let the same dataset migrate differently on two runs — with both
 * runs reporting success. Every conflict is therefore tested in every
 * permutation, and the accepted mapping and the reported conflicts must be
 * identical each time.
 */
describe("planMigration — determinism under permutation", () => {
  /** All orderings of a small array. */
  const permutations = <T,>(items: T[]): T[][] => {
    if (items.length <= 1) return [items];
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += 1) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([items[i], ...tail]);
    }
    return out;
  };

  it("enumerates the permutations it claims to test", () => {
    expect(permutations([1, 2, 3])).toHaveLength(6);
  });

  it("resolves duplicate auth ids identically in every order", () => {
    const users = [
      user({ $id: "doc-c", userId: "auth-1" }),
      user({ $id: "doc-a", userId: "auth-1" }),
      user({ $id: "doc-b", userId: "auth-1" }),
    ];

    const results = permutations(users).map((order) => planMigration(order, []));

    for (const result of results) {
      expect(result.customers).toEqual(results[0].customers);
      expect([...result.skipped].sort(bySkipId)).toEqual(
        [...results[0].skipped].sort(bySkipId)
      );
    }
    // And the winner is the stated rule, not an accident of input order.
    expect(results[0].customers[0].appwriteUserDocumentId).toBe("doc-a");
    expect(results[0].skipped.map((s) => s.id).sort()).toEqual(["doc-b", "doc-c"]);
  });

  it("resolves duplicate owner/account links identically in every order", () => {
    const banks = [
      bank({ $id: "bank-c" }),
      bank({ $id: "bank-a" }),
      bank({ $id: "bank-b" }),
    ];

    const results = permutations(banks).map((order) => planMigration([user()], order));

    for (const result of results) {
      expect(result.accounts).toEqual(results[0].accounts);
      expect([...result.skipped].sort(bySkipId)).toEqual(
        [...results[0].skipped].sort(bySkipId)
      );
    }
    expect(results[0].accounts[0].legacyAppwriteBankDocumentId).toBe("bank-a");
  });

  it("produces the same plan for a mixed dataset in every order", () => {
    const users = [
      user({ $id: "u-b", userId: "auth-2" }),
      user({ $id: "u-a", userId: "auth-1" }),
      user({ $id: "u-c", userId: "auth-1" }),
    ];
    const banks = [
      bank({ $id: "b-b", userId: "u-a", accountId: "acct-1" }),
      bank({ $id: "b-a", userId: "u-a", accountId: "acct-1" }),
      bank({ $id: "b-c", userId: "u-b", accountId: "acct-2" }),
    ];

    const baseline = planMigration(users, banks);

    for (const userOrder of permutations(users)) {
      for (const bankOrder of permutations(banks)) {
        const result = planMigration(userOrder, bankOrder);
        expect(result.customers).toEqual(baseline.customers);
        expect(result.accounts).toEqual(baseline.accounts);
        expect([...result.skipped].sort(bySkipId)).toEqual(
          [...baseline.skipped].sort(bySkipId)
        );
      }
    }
  });

  it("emits customers and accounts in a stable order", () => {
    const users = [
      user({ $id: "u-c", userId: "auth-c" }),
      user({ $id: "u-a", userId: "auth-a" }),
      user({ $id: "u-b", userId: "auth-b" }),
    ];

    const forward = planMigration(users, []);
    const reversed = planMigration([...users].reverse(), []);

    // Not merely equal as sets — equal as sequences, so a diff of two runs is
    // empty rather than a reshuffle.
    expect(forward.customers.map((c) => c.appwriteUserDocumentId)).toEqual([
      "u-a",
      "u-b",
      "u-c",
    ]);
    expect(reversed.customers).toEqual(forward.customers);
  });
});

const bySkipId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
