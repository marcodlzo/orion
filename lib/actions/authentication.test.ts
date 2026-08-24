import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ACTION AUTHENTICATION — ordering proofs.
 *
 * These assert that an unauthenticated caller reaches no privileged
 * collaborator: no admin-client query, no Plaid call, no Dwolla call.
 *
 * The failure mode being guarded against is subtle and common:
 *
 *     const bank = await database.listDocuments(...)   // privileged work
 *     const actor = await requireActor();              // check afterwards
 *
 * That "has an auth check" by inspection and is still wide open. Asserting the
 * collaborator was never invoked is the only way to prove ordering.
 *
 * These are NOT ownership tests. An authenticated caller may still reach
 * another user's data — see user.actions.test.ts.
 */

// vi.mock factories are hoisted above ordinary const declarations, so any spy
// a factory references directly must be created with vi.hoisted() or it is
// still in the temporal dead zone when the factory runs.
const {
  cookieGet,
  accountGet,
  listDocuments,
  createDocument,
  linkTokenCreate,
  itemPublicTokenExchange,
  dwollaPost,
  findUserByAuthId,
  createBankForActor,
} = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  accountGet: vi.fn(),
  listDocuments: vi.fn(),
  createDocument: vi.fn(),
  linkTokenCreate: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  dwollaPost: vi.fn(),
  findUserByAuthId: vi.fn(),
  createBankForActor: vi.fn(),
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

vi.mock("../plaid", () => ({
  plaidClient: {
    linkTokenCreate,
    itemPublicTokenExchange,
    accountsGet: vi.fn(),
    processorTokenCreate: vi.fn(),
  },
}));

vi.mock("../server/dwolla", () => ({
  dwollaClient: { post: dwollaPost },
  addFundingSource: vi.fn(),
  createDwollaCustomer: vi.fn(),
}));

// The user lookup moved behind the repository boundary.
vi.mock("../repositories/users.repository", () => ({
  findUserByAuthId,
  createUserRecord: vi.fn(),
}));
vi.mock("../repositories/banks.repository", () => ({
  createBankForActor,
  findCounterpartyBankByAccountId: vi.fn().mockResolvedValue(null),
  getOwnedBankByDocumentId: vi.fn().mockResolvedValue(null),
  getOwnedBanks: vi.fn().mockResolvedValue([]),
}));

import {
  createLinkToken,
  exchangePublicToken,
  getBankForLegacyTransfer,
  getCounterpartyBankForLegacyTransfer,
  getLoggedInUser,
  logoutAccount,
} from "./user.actions";
import { createTransaction } from "./transaction.actions";
import { createTransfer } from "./dwolla.actions";
import { InfrastructureError } from "../auth/errors";

const ALICE = {
  $id: "user-doc-alice",
  userId: "auth-alice",
  dwollaCustomerId: "dwolla-alice",
};

/** Give the request a valid session that resolves to Alice. */
function authenticate() {
  cookieGet.mockReturnValue({ value: "a-valid-session-secret" });
  accountGet.mockResolvedValue({ $id: "auth-alice" });
  findUserByAuthId.mockResolvedValue(ALICE);
}

/** No session cookie at all — the anonymous caller. */
const beAnonymous = () => cookieGet.mockReturnValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  beAnonymous();
});

const noPrivilegedWorkHappened = () => {
  expect(listDocuments, "admin read must not run").not.toHaveBeenCalled();
  expect(createDocument, "admin write must not run").not.toHaveBeenCalled();
  expect(linkTokenCreate, "Plaid must not be called").not.toHaveBeenCalled();
  expect(itemPublicTokenExchange, "Plaid must not be called").not.toHaveBeenCalled();
  expect(dwollaPost, "Dwolla must not be called").not.toHaveBeenCalled();
};

describe("anonymous callers reach no privileged collaborator", () => {
  it("getBank", async () => {
    await expect(getBankForLegacyTransfer({ documentId: "bank-doc-bob" })).rejects.toThrow();
    noPrivilegedWorkHappened();
  });

  it("getBankByAccountId", async () => {
    await expect(getCounterpartyBankForLegacyTransfer({ accountId: "plaid-account-bob" })).rejects.toThrow();
    noPrivilegedWorkHappened();
  });

  it("createLinkToken", async () => {
    await createLinkToken();
    noPrivilegedWorkHappened();
  });

  it("exchangePublicToken", async () => {
    await exchangePublicToken({ publicToken: "public-sandbox-token" });
    noPrivilegedWorkHappened();
  });

  it("createTransaction", async () => {
    await expect(createTransaction({
      name: "fabricated",
      amount: "100.00",
      senderId: "user-doc-bob",
      senderBankId: "bank-doc-bob",
      receiverId: "user-doc-mallory",
      receiverBankId: "bank-doc-mallory",
      email: "mallory@example.com",
    })).rejects.toThrow();
    noPrivilegedWorkHappened();
  });

  it("createTransfer — money movement must never be anonymous", async () => {
    await createTransfer({
      sourceFundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/victim",
      destinationFundingSourceUrl: "https://api-sandbox.dwolla.com/funding-sources/attacker",
      amount: "500.00",
    });
    noPrivilegedWorkHappened();
  });

  it("logoutAccount", async () => {
    await logoutAccount();
    noPrivilegedWorkHappened();
  });

  it("getLoggedInUser resolves null rather than throwing", async () => {
    // The root layout relies on null to redirect to /sign-in.
    await expect(getLoggedInUser()).resolves.toBeNull();
    expect(findUserByAuthId).not.toHaveBeenCalled();
  });
});

describe("getLoggedInUser distinguishes outage from logged-out", () => {
  it("rethrows an infrastructure failure instead of reporting null", async () => {
    cookieGet.mockReturnValue({ value: "a-valid-session-secret" });
    accountGet.mockResolvedValue({ $id: "auth-alice" });
    findUserByAuthId.mockRejectedValue(
      new InfrastructureError("appwrite is down")
    );

    // Reporting null here would send a user to a login screen that cannot work
    // either, and hide the outage.
    await expect(getLoggedInUser()).rejects.toBeInstanceOf(InfrastructureError);
  });
});

describe("identity is no longer accepted from the caller", () => {
  it("createLinkToken takes no arguments", () => {
    expect(createLinkToken.length).toBe(0);
  });

  it("exchangePublicToken accepts only a public token", async () => {
    authenticate();
    itemPublicTokenExchange.mockRejectedValue(new Error("stop here"));

    // A caller-supplied user object is ignored: the extra property is not part
    // of the parameter type and nothing reads it.
    await exchangePublicToken({
      publicToken: "public-sandbox-token",
      // @ts-expect-error identity must not be accepted from the caller
      user: { $id: "user-doc-bob", dwollaCustomerId: "dwolla-bob" },
    });

    // Authentication ran and Plaid was reached with the session's identity.
    expect(itemPublicTokenExchange).toHaveBeenCalledTimes(1);
  });
});
