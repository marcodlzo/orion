import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CHARACTERISATION TESTS — lib/actions/user.actions.ts
 *
 * ============================ READ THIS FIRST ============================
 * These tests assert what the code does TODAY, including behaviour the audit
 * classified as CONFIRMED CRITICAL. They are not a specification and they are
 * not requirements.
 *
 * Every test named DEFECT documents a live vulnerability. The authorization
 * milestone MUST make these tests fail, and each is then rewritten to assert
 * the secure behaviour described in its "AFTER" comment.
 *
 * If one of these starts failing and you did not intend to fix it, something
 * changed underneath you — investigate, do not "repair" the test.
 * Do NOT defend these assertions. Do NOT treat them as regressions to protect.
 * =========================================================================
 */

const cookieGet = vi.fn(() => ({ value: "session-for-alice" }));
const cookieSet = vi.fn();
const cookieDelete = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => ({ get: cookieGet, set: cookieSet, delete: cookieDelete }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Two separate users. Alice is the caller; Bob is the victim.
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
  dwollaCustomerUrl: "https://api-sandbox.dwolla.com/customers/dwolla-alice",
};

const BOB_USER_DOC = {
  $id: "user-doc-bob",
  userId: "auth-bob",
  email: "bob@example.com",
  firstName: "Bob",
  lastName: "Baker",
  ssn: "222-22-2222",
  dateOfBirth: "1985-05-05",
  address1: "2 Bob Street",
  dwollaCustomerId: "dwolla-bob",
  dwollaCustomerUrl: "https://api-sandbox.dwolla.com/customers/dwolla-bob",
};

const BOB_BANK_DOC = {
  $id: "bank-doc-bob",
  userId: BOB_USER_DOC,
  accountId: "plaid-account-bob",
  bankId: "plaid-item-bob",
  accessToken: "access-sandbox-bob-secret-token",
  fundingSourceUrl:
    "https://api-sandbox.dwolla.com/funding-sources/funding-bob",
  shareableId: "cGxhaWQtYWNjb3VudC1ib2I=",
};

const listDocuments = vi.fn();
const createDocument = vi.fn();

vi.mock("../appwrite", () => ({
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
  createSessionClient: async () => ({
    get account() {
      return { get: async () => ({ $id: "auth-alice" }) };
    },
  }),
}));

vi.mock("../plaid", () => ({ plaidClient: {} }));
vi.mock("./dwolla.actions", () => ({
  addFundingSource: vi.fn(),
  createDwollaCustomer: vi.fn(),
}));

import {
  getBank,
  getBankByAccountId,
  getBanks,
  getUserInfo,
} from "./user.actions";

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: "session-for-alice" });
});

describe("getBank — DEFECT: unauthenticated IDOR (audit S2, CRITICAL)", () => {
  it("DEFECT: returns another user's bank document from an id alone", async () => {
    listDocuments.mockResolvedValue({ documents: [BOB_BANK_DOC], total: 1 });

    // Alice asks for Bob's bank document id. Nothing stops her.
    const result = await getBank({ documentId: "bank-doc-bob" });

    expect(result.$id).toBe("bank-doc-bob");
    // AFTER the authorization milestone: this must throw NotFound, because
    // bank-doc-bob is not owned by the authenticated actor.
  });

  it("DEFECT: never reads the session cookie — there is no caller identity", async () => {
    listDocuments.mockResolvedValue({ documents: [BOB_BANK_DOC], total: 1 });

    await getBank({ documentId: "bank-doc-bob" });

    // This is the heart of the vulnerability: the action cannot know who is
    // calling it, because it never asks.
    expect(cookieGet).not.toHaveBeenCalled();
    // AFTER: requireActor() reads the session first, so this must be called.
  });

  it("DEFECT: leaks the Plaid access token and Dwolla funding-source URL", async () => {
    listDocuments.mockResolvedValue({ documents: [BOB_BANK_DOC], total: 1 });

    const result = await getBank({ documentId: "bank-doc-bob" });

    // A Plaid access token grants read access to the victim's balances,
    // transactions and account/routing details.
    expect(result.accessToken).toBe("access-sandbox-bob-secret-token");
    // A funding-source URL is all createTransfer needs to move money from it.
    expect(result.fundingSourceUrl).toContain("funding-bob");
    // AFTER: the response is a DTO. Neither field exists on it at all.
  });
});

describe("getBankByAccountId — DEFECT: IDOR via shareable id (audit S2/S10)", () => {
  it("DEFECT: resolves any account id to its full bank document", async () => {
    listDocuments.mockResolvedValue({ documents: [BOB_BANK_DOC], total: 1 });

    // shareableId is base64, so a recipient can decode it back to the raw
    // Plaid account id and call this directly.
    const result = await getBankByAccountId({ accountId: "plaid-account-bob" });

    expect(result.accessToken).toBe("access-sandbox-bob-secret-token");
    expect(cookieGet).not.toHaveBeenCalled();
    // AFTER: a counterparty lookup returns only what a sender legitimately
    // needs to address a transfer — never the counterparty's credentials.
  });

  it("returns null when the account id matches more than one bank", async () => {
    listDocuments.mockResolvedValue({
      documents: [BOB_BANK_DOC, BOB_BANK_DOC],
      total: 2,
    });

    expect(await getBankByAccountId({ accountId: "dupe" })).toBeNull();
  });
});

describe("getBanks — DEFECT: IDOR on the bank list (audit S4)", () => {
  it("DEFECT: lists any user's banks from a caller-supplied userId", async () => {
    listDocuments.mockResolvedValue({ documents: [BOB_BANK_DOC], total: 1 });

    const result = await getBanks({ userId: "user-doc-bob" });

    expect(result).toHaveLength(1);
    expect(cookieGet).not.toHaveBeenCalled();
    // AFTER: the userId parameter is deleted. The actor is derived from the
    // session and is the only identity the query can filter on.
  });
});

describe("getUserInfo — DEFECT: PII exposure (audit S3/S4, CRITICAL)", () => {
  it("DEFECT: returns any user's record including SSN and date of birth", async () => {
    listDocuments.mockResolvedValue({ documents: [BOB_USER_DOC], total: 1 });

    const result = await getUserInfo({ userId: "auth-bob" });

    expect(result.ssn).toBe("222-22-2222");
    expect(result.dateOfBirth).toBe("1985-05-05");
    expect(result.address1).toBe("2 Bob Street");
    expect(cookieGet).not.toHaveBeenCalled();
    // AFTER: SSN is not persisted at all, and the DTO carries no PII beyond
    // what the rendering component actually displays.
  });
});

describe("error handling — DEFECT: silent undefined propagation", () => {
  it("DEFECT: swallows a datastore failure and resolves undefined", async () => {
    listDocuments.mockRejectedValue(new Error("appwrite is down"));

    // Callers spread this result and crash somewhere unrelated, with a stack
    // trace that points nowhere near the real failure.
    await expect(getBank({ documentId: "bank-doc-alice" })).resolves.toBeUndefined();
    // AFTER: failures propagate as typed errors and are handled explicitly.
  });
});

describe("baseline — behaviour that should SURVIVE the authorization milestone", () => {
  it("queries the bank collection scoped by the requested document id", async () => {
    listDocuments.mockResolvedValue({ documents: [BOB_BANK_DOC], total: 1 });

    await getBank({ documentId: "bank-doc-bob" });

    expect(listDocuments).toHaveBeenCalledTimes(1);
    const [dbId, collectionId] = listDocuments.mock.calls[0];
    expect(dbId).toBe("test-db");
    expect(collectionId).toBe("test-banks");
  });

  it("returns a plain serializable object, not an Appwrite model instance", async () => {
    listDocuments.mockResolvedValue({ documents: [ALICE_USER_DOC], total: 1 });

    const result = await getUserInfo({ userId: "auth-alice" });

    expect(result).toEqual(JSON.parse(JSON.stringify(ALICE_USER_DOC)));
  });
});
