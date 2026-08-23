import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CHARACTERISATION TESTS — ownership enforcement.
 *
 * ============================ READ THIS FIRST ============================
 * These assert what the code does TODAY, including behaviour the audit
 * classified as CONFIRMED CRITICAL. They are not a specification.
 *
 * Every test named DEFECT documents a live vulnerability. The repository /
 * ownership phase MUST make these fail, and each is then rewritten to assert
 * the secure behaviour in its "AFTER" comment.
 *
 * Do NOT defend these assertions. Do NOT treat a failure as a regression.
 * =========================================================================
 *
 * WHAT CHANGED IN THE AUTHENTICATION PHASE
 *
 * These were originally written as "unauthenticated IDOR": an anonymous caller
 * could read any record. That is no longer true — every action below now
 * resolves the caller from the session first, and an anonymous request reaches
 * no privileged collaborator (proved in authentication.test.ts).
 *
 * The remaining defect is narrower and still critical: ANY AUTHENTICATED USER
 * can pass ANY OTHER USER'S resource identifier and receive that record,
 * because no query is scoped to the caller. Alice is authenticated throughout
 * these tests; Bob is her victim.
 *
 * Authentication asks "who is calling?" and is answered. Authorization asks
 * "may they touch this?" and is not.
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

import { getBank, getBankByAccountId } from "./user.actions";
import { getBanks, getUserInfo } from "../server/users";

// Alice is the authenticated caller.
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

// Bob is the victim. Alice has no relationship to any of this.
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
};

const BOB_BANK_DOC = {
  $id: "bank-doc-bob",
  userId: BOB_USER_DOC,
  accountId: "plaid-account-bob",
  bankId: "plaid-item-bob",
  accessToken: "access-sandbox-bob-secret-token",
  fundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/funding-bob",
  shareableId: "cGxhaWQtYWNjb3VudC1ib2I=",
};

const USER_COLLECTION = process.env.APPWRITE_USER_COLLECTION_ID;
const BANK_COLLECTION = process.env.APPWRITE_BANK_COLLECTION_ID;

/**
 * Alice holds a valid session. The user collection resolves her identity; the
 * bank collection returns whatever the test seeds.
 */
function authenticateAliceAndSeedBank(bank: unknown = BOB_BANK_DOC, bankTotal = 1) {
  cookieGet.mockReturnValue({ value: "session-for-alice" });
  accountGet.mockResolvedValue({ $id: "auth-alice" });
  listDocuments.mockImplementation(async (_db: string, collectionId: string) => {
    if (collectionId === USER_COLLECTION) {
      return { documents: [ALICE_USER_DOC], total: 1 };
    }
    return { documents: bank === null ? [] : [bank], total: bankTotal };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAliceAndSeedBank();
});

describe("getBank — authentication is enforced", () => {
  it("FIXED: resolves the caller from the session before any admin read", async () => {
    // This assertion is inverted from its original form. It used to prove the
    // action never read the session cookie. It now proves it does.
    await getBank({ documentId: "bank-doc-bob" });

    expect(cookieGet).toHaveBeenCalled();
  });
});

describe("getBank — DEFECT: missing ownership enforcement (audit S2, CRITICAL)", () => {
  it("DEFECT: an authenticated user receives another user's bank document", async () => {
    // Alice is authenticated as herself and asks for Bob's bank document id.
    const result = await getBank({ documentId: "bank-doc-bob" });

    expect(result.$id).toBe("bank-doc-bob");
    // AFTER: throws NotFound — bank-doc-bob is not owned by the actor, and a
    // 404 rather than 403 avoids confirming the record exists.
  });

  it("DEFECT: the query is not scoped to the caller", async () => {
    await getBank({ documentId: "bank-doc-bob" });

    const bankCall = listDocuments.mock.calls.find(
      (c: unknown[]) => c[1] === BANK_COLLECTION
    );
    expect(bankCall).toBeDefined();

    // Nothing in the query mentions the authenticated actor, so the datastore
    // is asked for the record by id alone.
    expect(JSON.stringify(bankCall?.[2])).not.toContain("user-doc-alice");
    // AFTER: the query carries an equality on the actor's user id.
  });

  it("DEFECT: leaks the Plaid access token and Dwolla funding-source URL", async () => {
    const result = await getBank({ documentId: "bank-doc-bob" });

    // A Plaid access token grants read access to the victim's balances,
    // transactions and account/routing details.
    expect(result.accessToken).toBe("access-sandbox-bob-secret-token");
    // A funding-source URL is all createTransfer needs to move money from it.
    expect(result.fundingSourceUrl).toContain("funding-bob");
    // AFTER: the response is a DTO; neither field exists on it at all.
  });
});

describe("getBankByAccountId — DEFECT: missing ownership enforcement (audit S2/S10)", () => {
  it("DEFECT: any authenticated user resolves an account id to full credentials", async () => {
    // shareableId is base64, so a recipient can decode it back to the raw Plaid
    // account id and call this directly.
    const result = await getBankByAccountId({ accountId: "plaid-account-bob" });

    expect(result.accessToken).toBe("access-sandbox-bob-secret-token");
    // AFTER: a counterparty lookup returns only what a sender needs to address
    // a transfer — never the counterparty's credentials.
  });

  it("returns null when the account id matches more than one bank", async () => {
    authenticateAliceAndSeedBank(BOB_BANK_DOC, 2);

    expect(await getBankByAccountId({ accountId: "dupe" })).toBeNull();
  });
});

describe("getBanks — DEFECT: missing ownership enforcement (audit S4)", () => {
  it("DEFECT: lists any user's banks from a caller-supplied userId", async () => {
    // No longer remotely callable — it was internalised when the server-action
    // surface was shrunk. The defect that remains is that it trusts whatever
    // userId its caller passes, so a caller that derives that id from client
    // input still reads another user's banks.
    listDocuments.mockResolvedValue({ documents: [BOB_BANK_DOC], total: 1 });

    const result = await getBanks({ userId: "user-doc-bob" });

    expect(result).toHaveLength(1);
    // AFTER: the userId parameter is gone; the actor is the only identity the
    // query can filter on.
  });
});

describe("getUserInfo — DEFECT: missing ownership enforcement + PII (audit S3/S4)", () => {
  it("DEFECT: returns any user's record including SSN and date of birth", async () => {
    // Also no longer remotely callable. Two defects remain: it accepts an
    // arbitrary identifier, and it returns the raw document.
    listDocuments.mockResolvedValue({ documents: [BOB_USER_DOC], total: 1 });

    const result = await getUserInfo({ userId: "auth-bob" });

    expect(result.ssn).toBe("222-22-2222");
    expect(result.dateOfBirth).toBe("1985-05-05");
    expect(result.address1).toBe("2 Bob Street");
    // AFTER: SSN is not persisted at all, and the DTO carries no PII beyond
    // what the rendering component displays.
  });
});

describe("error handling — DEFECT: silent undefined propagation", () => {
  it("DEFECT: swallows a datastore failure and resolves undefined", async () => {
    listDocuments.mockImplementation(async (_db: string, collectionId: string) => {
      if (collectionId === USER_COLLECTION) {
        return { documents: [ALICE_USER_DOC], total: 1 };
      }
      throw new Error("appwrite is down");
    });

    // Callers spread this result and crash somewhere unrelated, with a stack
    // trace that points nowhere near the real failure.
    await expect(getBank({ documentId: "bank-doc-alice" })).resolves.toBeUndefined();
    // AFTER: failures propagate as typed errors and are handled explicitly.
  });
});

describe("baseline — behaviour that should SURVIVE the authorization phase", () => {
  it("queries the bank collection, not another one", async () => {
    await getBank({ documentId: "bank-doc-bob" });

    const bankCall = listDocuments.mock.calls.find(
      (c: unknown[]) => c[1] === BANK_COLLECTION
    );
    expect(bankCall).toBeDefined();
    expect(bankCall?.[0]).toBe(process.env.APPWRITE_DATABASE_ID);
  });

  it("returns a plain serializable object, not an Appwrite model instance", async () => {
    listDocuments.mockResolvedValue({ documents: [ALICE_USER_DOC], total: 1 });

    const result = await getUserInfo({ userId: "auth-alice" });

    expect(result).toEqual(JSON.parse(JSON.stringify(ALICE_USER_DOC)));
  });
});
