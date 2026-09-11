import { describe, it, expect, vi, beforeEach } from "vitest";

import { NotFoundError } from "../repositories/errors";
import { InfrastructureError, UnauthorizedError } from "../auth/errors";
import { encryptCredential } from "../crypto/envelope";

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
  listStoredBanks,
} = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  accountGet: vi.fn(),
  listDocuments: vi.fn(),
  createDocument: vi.fn(),
  listStoredBanks: vi.fn(),
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
vi.mock("../db/repositories/bank-records.repository", () => ({
  listOwnedStoredBanks: listStoredBanks,
  findOwnedStoredBankByPublicId: vi.fn(),
  findOwnedStoredBankByAccountId: vi.fn(),
  findStoredCounterpartyByAccountId: vi.fn(),
  insertStoredBank: vi.fn(),
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

/**
 * Stored credentials are CIPHERTEXT, bound to their record id and field.
 *
 * Reads no longer tolerate a plaintext value, so a fixture carrying a bare
 * string is a document the datastore cannot produce and the repository
 * correctly refuses it.
 *
 * The plaintext is deliberately not token-shaped. An earlier version used
 * realistic `access-sandbox-…` strings; the crypto does not care about the
 * shape, and a codebase where "it is only a fixture" excuses a token-shaped
 * literal is one where a real token eventually lands the same way.
 */
const storedCredential = (
  recordId: string,
  field: "accessToken" | "fundingSourceUrl",
  value: string
) => encryptCredential(value, { recordId, field });

const ALICE_BANK_DOC = {
  $id: "bank-doc-alice",
  userId: { $id: "user-doc-alice" },
  accountId: "plaid-account-alice",
  bankId: "plaid-item-alice",
  accessToken: storedCredential("bank-doc-alice", "accessToken", "provider-credential-alice"),
  fundingSourceUrl: storedCredential(
    "bank-doc-alice",
    "fundingSourceUrl",
    "https://funding.example.invalid/sources/alice"
  ),
  shareableId: "cGxhaWQtYWNjb3VudC1hbGljZQ==",
};

const BOB_BANK_DOC = {
  $id: "bank-doc-bob",
  userId: { $id: "user-doc-bob" },
  accountId: "plaid-account-bob",
  bankId: "plaid-item-bob",
  accessToken: storedCredential("bank-doc-bob", "accessToken", "provider-credential-bob"),
  fundingSourceUrl: storedCredential(
    "bank-doc-bob",
    "fundingSourceUrl",
    "https://funding.example.invalid/sources/bob"
  ),
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
  listStoredBanks.mockImplementation(async (actor: { userId: string }) =>
    banks
      .filter((bank) => (bank.userId as { $id: string }).$id === actor.userId)
      .map((bank) => ({
        linked_account_id: `linked-${bank.$id}`,
        credential_id: bank.$id,
        public_id: bank.$id,
        owner_user_document_id: (bank.userId as { $id: string }).$id,
        external_account_id: bank.accountId,
        provider_item_id: bank.bankId,
        shareable_id: bank.shareableId,
        access_token: bank.accessToken,
        funding_source_url: bank.fundingSourceUrl,
      }))
  );

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

  it("REFUSES a credential stored as plaintext", async () => {
    // Reads used to tolerate an unencrypted value, for records written before
    // the encryption migration. That tolerance is gone now that
    // `npm run credentials:encrypt` reports every value encrypted, and this is
    // what stops it drifting back: re-adding it is PERMISSIVE, so every
    // encrypted fixture in this suite would keep passing and nothing else would
    // notice.
    //
    // A plaintext credential at rest is now a fault, not a legacy shape. It is
    // also indistinguishable from a value an attacker wrote directly into the
    // document store, which is precisely the thing encryption at rest exists to
    // make useless.
    authenticateAlice([
      { ...ALICE_BANK_DOC, accessToken: "provider-credential-in-the-clear" },
    ]);
    const actor = await requireActor();

    await expect(getOwnedBanks(actor)).rejects.toThrow();
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
