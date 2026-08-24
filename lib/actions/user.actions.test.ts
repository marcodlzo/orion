import { describe, it, expect, vi, beforeEach } from "vitest";

import { NotFoundError } from "../repositories/errors";
import { InfrastructureError, UnauthorizedError } from "../auth/errors";

/**
 * OWNERSHIP ENFORCEMENT.
 *
 * These previously asserted a live vulnerability: an authenticated user could
 * read any other user's bank by supplying its id. That is now closed, and these
 * assert the secure behaviour instead. They must not be relaxed.
 *
 * Alice is the authenticated caller throughout. Bob is the would-be victim.
 *
 * What is verified here is ACCESS CONTROL only. These say nothing about what
 * fields a response carries — Alice's own bank record still includes her Plaid
 * access token and Dwolla funding-source URL. Data minimisation is a separate
 * concern and a separate phase.
 */

const {
  cookieGet,
  accountGet,
  listDocuments,
  createDocument,
} = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  accountGet: vi.fn(),
  listDocuments: vi.fn(),
  createDocument: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: cookieGet, set: vi.fn(), delete: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../appwrite", () => ({
  createSessionClient: async () => ({
    get account() {
      return { get: accountGet, deleteSession: vi.fn() };
    },
  }),
  createAdminClient: async () => ({
    get database() {
      return { listDocuments, createDocument };
    },
    get account() {
      return { create: vi.fn(), createEmailPasswordSession: vi.fn() };
    },
    get user() {
      return {};
    },
  }),
}));

vi.mock("../plaid", () => ({ plaidClient: {} }));
vi.mock("../server/dwolla", () => ({
  addFundingSource: vi.fn(),
  createDwollaCustomer: vi.fn(),
}));

import {
  getBankForLegacyTransfer,
  getCounterpartyBankForLegacyTransfer,
  getLoggedInUser,
} from "./user.actions";
import { getOwnedBanks } from "../repositories/banks.repository";
import { requireActor } from "../auth/actor";

const ALICE_USER_DOC = {
  $id: "user-doc-alice",
  userId: "auth-alice",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Anderson",
  ssn: "111-11-1111",
  dateOfBirth: "1990-01-01",
  address1: "1 Alice Way",
  dwollaCustomerId: "dwolla-alice",
};

const ALICE_BANK_DOC = {
  $id: "bank-doc-alice",
  userId: { $id: "user-doc-alice" },
  accountId: "plaid-account-alice",
  bankId: "plaid-item-alice",
  accessToken: "access-sandbox-alice-token",
  fundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/funding-alice",
  shareableId: "cGxhaWQtYWNjb3VudC1hbGljZQ==",
};

const BOB_BANK_DOC = {
  $id: "bank-doc-bob",
  userId: { $id: "user-doc-bob" },
  accountId: "plaid-account-bob",
  bankId: "plaid-item-bob",
  accessToken: "access-sandbox-bob-secret-token",
  fundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/funding-bob",
  shareableId: "cGxhaWQtYWNjb3VudC1ib2I=",
};

const USER_COLLECTION = process.env.APPWRITE_USER_COLLECTION_ID;
const BANK_COLLECTION = process.env.APPWRITE_BANK_COLLECTION_ID;

/**
 * node-appwrite serialises each query to a JSON string such as
 * {"method":"equal","attribute":"userId","values":["user-doc-alice"]}.
 * Parsing them is exact; substring matching against them is not, because
 * JSON.stringify of the array escapes every quote.
 */
type ParsedQuery = { method: string; attribute: string; values: unknown[] };

function parseQueries(queries: unknown): ParsedQuery[] {
  if (!Array.isArray(queries)) return [];
  return queries.flatMap((q) => {
    try {
      return [JSON.parse(String(q)) as ParsedQuery];
    } catch {
      return [];
    }
  });
}

/** The value a query filters a given attribute on, if any. */
function filterValue(queries: unknown, attribute: string): string | undefined {
  const q = parseQueries(queries).find((x) => x.attribute === attribute);
  return q ? String(q.values[0]) : undefined;
}

/**
 * Alice is authenticated. The bank collection behaves like a real datastore:
 * it applies whatever predicates the query actually carries, so a query that
 * filters on the wrong attribute genuinely returns nothing rather than
 * accidentally passing.
 */
function authenticateAlice(banks = [ALICE_BANK_DOC, BOB_BANK_DOC]) {
  cookieGet.mockReturnValue({ value: "session-for-alice" });
  accountGet.mockResolvedValue({ $id: "auth-alice" });

  listDocuments.mockImplementation(
    async (_db: string, collectionId: string, queries: unknown[]) => {
      if (collectionId === USER_COLLECTION) {
        return { documents: [ALICE_USER_DOC], total: 1 };
      }

      const parsed = parseQueries(queries);
      const matched = banks.filter((bank) =>
        parsed.every((q) => {
          const expected = String(q.values[0]);
          if (q.attribute === "userId") {
            return (bank.userId as { $id: string }).$id === expected;
          }
          if (q.attribute === "$id") return bank.$id === expected;
          if (q.attribute === "accountId") return bank.accountId === expected;
          return true;
        })
      );

      return { documents: matched, total: matched.length };
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAlice();
});

describe("A. getBank — cross-owner access is denied", () => {
  it("FIXED: Alice reading Bob's bank id raises NotFound", async () => {
    // BEFORE: returned Bob's full document including his Plaid access token.
    await expect(getBankForLegacyTransfer({ documentId: "bank-doc-bob" })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it("Alice can still read her own bank", async () => {
    const bank = await getBankForLegacyTransfer({ documentId: "bank-doc-alice" });

    expect(bank.$id).toBe("bank-doc-alice");
  });

  it("a missing bank and an unowned bank are indistinguishable", async () => {
    const unowned = await getBankForLegacyTransfer({ documentId: "bank-doc-bob" }).catch((e: unknown) => e);
    const missing = await getBankForLegacyTransfer({ documentId: "does-not-exist" }).catch((e: unknown) => e);

    // Returning "forbidden" for an unowned record would confirm the id is real
    // and turn this action into an enumeration oracle.
    expect(unowned).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(unowned.message).toBe(missing.message);
  });

  it("scopes ownership inside the datastore query, not after fetching", async () => {
    await getBankForLegacyTransfer({ documentId: "bank-doc-alice" });

    const bankCall = listDocuments.mock.calls.find(
      (c: unknown[]) => c[1] === BANK_COLLECTION
    );
    expect(filterValue(bankCall?.[2], "$id")).toBe("bank-doc-alice");
    expect(filterValue(bankCall?.[2], "userId")).toBe("user-doc-alice");
  });
});

describe("D. ownership compares the correct identifier", () => {
  it("REGRESSION: filters on USER.$id, never the auth account id", async () => {
    await getBankForLegacyTransfer({ documentId: "bank-doc-alice" });

    const bankCall = listDocuments.mock.calls.find(
      (c: unknown[]) => c[1] === BANK_COLLECTION
    );

    // BANK.userId is a relationship to USER.$id. The user document ALSO has a
    // field named `userId` holding the auth account id. Comparing against
    // actor.authId would not error — it would silently match nothing, reading
    // as "this user has no banks" rather than as a bug.
    expect(filterValue(bankCall?.[2], "userId")).toBe("user-doc-alice");
    expect(filterValue(bankCall?.[2], "userId")).not.toBe("auth-alice");
  });

  it("getOwnedBanks scopes on USER.$id too", async () => {
    const actor = await requireActor();
    listDocuments.mockClear();

    await getOwnedBanks(actor);

    const call = listDocuments.mock.calls.find(
      (c: unknown[]) => c[1] === BANK_COLLECTION
    );
    expect(filterValue(call?.[2], "userId")).toBe("user-doc-alice");
    expect(filterValue(call?.[2], "userId")).not.toBe("auth-alice");
  });
});

describe("B. bank lists are actor scoped", () => {
  it("getOwnedBanks returns only the actor's banks", async () => {
    const actor = await requireActor();

    const banks = await getOwnedBanks(actor);

    expect(banks.map((b) => b.$id)).toEqual(["bank-doc-alice"]);
  });

  it("there is no identity parameter to supply", () => {
    // BEFORE: getBanks({ userId }) accepted any user id.
    // AFTER: the only argument is the actor itself.
    expect(getOwnedBanks.length).toBe(1);
  });
});

describe("E. datastore failure is not reported as NotFound", () => {
  it("raises InfrastructureError", async () => {
    listDocuments.mockImplementation(async (_db: string, collectionId: string) => {
      if (collectionId === USER_COLLECTION) {
        return { documents: [ALICE_USER_DOC], total: 1 };
      }
      throw new Error("appwrite is down");
    });

    const error = await getBankForLegacyTransfer({ documentId: "bank-doc-alice" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InfrastructureError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    // BEFORE: swallowed into console.log and resolved undefined.
  });
});

describe("F. unauthenticated callers fail before the repository runs", () => {
  it("getBank rejects and issues no query", async () => {
    cookieGet.mockReturnValue(undefined);

    await expect(getBankForLegacyTransfer({ documentId: "bank-doc-alice" })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(listDocuments).not.toHaveBeenCalled();
  });
});

describe("counterparty lookup — deliberately not ownership scoped", () => {
  it("resolves a bank the actor does NOT own, by design", async () => {
    // Paying somebody requires reading their bank. Scoping this by ownership
    // would break transfers entirely.
    const bank = await getCounterpartyBankForLegacyTransfer({ accountId: "plaid-account-bob" });

    expect(bank.$id).toBe("bank-doc-bob");
  });

  it("DEFECT: still returns the counterparty's provider credentials", async () => {
    const bank = await getCounterpartyBankForLegacyTransfer({ accountId: "plaid-account-bob" });

    // Access control cannot fix this — the recipient genuinely must be
    // readable. Narrowing the response is the DTO phase; removing the
    // browser's need to resolve a recipient is the orchestration phase.
    expect(bank.accessToken).toBe("access-sandbox-bob-secret-token");
    expect(bank.fundingSourceUrl).toContain("funding-bob");
    // AFTER (DTO phase): only addressing data, never credentials.
  });

  it("is still authenticated", async () => {
    cookieGet.mockReturnValue(undefined);

    await expect(
      getCounterpartyBankForLegacyTransfer({ accountId: "plaid-account-bob" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(listDocuments).not.toHaveBeenCalled();
  });
});

describe("getLoggedInUser — FIXED: only the allowlisted DTO crosses", () => {
  it("returns exactly the CurrentUserDTO shape", async () => {
    const user = await getLoggedInUser();

    // Allowlist, not blacklist: this fails if the shape widens by even one
    // field, which a per-field "expect(x).toBeUndefined()" would not catch.
    expect(user).toEqual({
      id: "user-doc-alice",
      firstName: "Alice",
      lastName: "Anderson",
      email: "alice@example.com",
    });
  });

  it("carries no identity or provider data from the source record", async () => {
    const user = await getLoggedInUser();
    const wire = JSON.stringify(user);

    // Runtime output, not just the type: a mapper that spreads the record
    // would satisfy TypeScript and still leak here.
    for (const value of [
      "111-11-1111",
      "1990-01-01",
      "1 Alice Way",
      "dwolla-alice",
    ]) {
      expect(wire).not.toContain(value);
    }
  });
});
