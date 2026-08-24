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

import { getLoggedInUser } from "./user.actions";
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
