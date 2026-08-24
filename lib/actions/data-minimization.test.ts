import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DATA MINIMISATION AT THE ACTION BOUNDARY.
 *
 * Two things are proved here:
 *
 *  1. Sensitive identity data submitted at signup reaches the provider that
 *     needs it and is never written to our datastore or returned to the
 *     browser.
 *
 *  2. The legacy transfer path STILL leaks provider credentials. That evidence
 *     is deliberately retained. Ordinary read paths being safe must not be
 *     mistaken for the credential boundary being finished.
 *
 * Fixtures use synthetic redacted values. Never put a real SSN in a test.
 */

const {
  cookieGet,
  cookieSet,
  accountGet,
  listDocuments,
  createAuthAccount,
  createEmailPasswordSession,
  createUserRecord,
  findUserByAuthId,
  createDwollaCustomer,
} = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  accountGet: vi.fn(),
  listDocuments: vi.fn(),
  createAuthAccount: vi.fn(),
  createEmailPasswordSession: vi.fn(),
  createUserRecord: vi.fn(),
  findUserByAuthId: vi.fn(),
  createDwollaCustomer: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: cookieGet, set: cookieSet, delete: vi.fn() }),
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
      return { listDocuments, createDocument: vi.fn() };
    },
    get account() {
      return {};
    },
    get user() {
      return {};
    },
  }),
}));

vi.mock("../plaid", () => ({ plaidClient: {} }));
vi.mock("../repositories/accounts.repository", () => ({
  createAuthAccount,
  createEmailPasswordSession,
}));
vi.mock("../repositories/users.repository", () => ({
  createUserRecord,
  findUserByAuthId,
}));
vi.mock("../server/dwolla", () => ({
  createDwollaCustomer,
  addFundingSource: vi.fn(),
}));

import * as userActions from "./user.actions";
import { signUp } from "./user.actions";

const SSN = "REDACTED-SSN";
const DOB = "REDACTED-DOB";

const SIGNUP_INPUT = {
  firstName: "Given",
  lastName: "Family",
  address1: "REDACTED-ADDRESS",
  city: "REDACTED-CITY",
  state: "ZZ",
  postalCode: "00000",
  dateOfBirth: DOB,
  ssn: SSN,
  email: "person@example.invalid",
  password: "correct horse battery",
};

beforeEach(() => {
  vi.clearAllMocks();
  createAuthAccount.mockResolvedValue({ $id: "auth-new" });
  createDwollaCustomer.mockResolvedValue(
    "https://api-sandbox.dwolla.invalid/customers/REDACTED-DWOLLA-ID"
  );
  createEmailPasswordSession.mockResolvedValue({
    secret: "session-secret",
    userId: "auth-new",
  });
  createUserRecord.mockImplementation(async (data: Record<string, unknown>) => ({
    $id: "user-doc-new",
    ...data,
  }));
});

describe("signup — SSN and date of birth are request scoped", () => {
  it("sends both to Dwolla, which genuinely requires them", async () => {
    await signUp(SIGNUP_INPUT);

    expect(createDwollaCustomer).toHaveBeenCalledTimes(1);
    const sentToDwolla = createDwollaCustomer.mock.calls[0][0];
    expect(sentToDwolla.ssn).toBe(SSN);
    expect(sentToDwolla.dateOfBirth).toBe(DOB);
  });

  it("FIXED: never writes SSN or date of birth to the datastore", async () => {
    await signUp(SIGNUP_INPUT);

    expect(createUserRecord).toHaveBeenCalledTimes(1);
    const persisted = createUserRecord.mock.calls[0][0];

    // BEFORE: the whole signup payload was spread into the document.
    expect(persisted).not.toHaveProperty("ssn");
    expect(persisted).not.toHaveProperty("dateOfBirth");
    expect(JSON.stringify(persisted)).not.toContain(SSN);
    expect(JSON.stringify(persisted)).not.toContain(DOB);
  });

  it("still persists what the application actually uses", async () => {
    await signUp(SIGNUP_INPUT);

    const persisted = createUserRecord.mock.calls[0][0];
    expect(persisted).toMatchObject({
      firstName: "Given",
      lastName: "Family",
      email: "person@example.invalid",
      userId: "auth-new",
      dwollaCustomerId: "REDACTED-DWOLLA-ID",
    });
  });

  it("FIXED: returns only the allowlisted DTO, never the created document", async () => {
    const result = await signUp(SIGNUP_INPUT);

    expect(result).toEqual({
      id: "user-doc-new",
      firstName: "Given",
      lastName: "Family",
      email: "person@example.invalid",
    });
  });

  it("does not put the signup payload into an error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createDwollaCustomer.mockRejectedValue(new Error("provider rejected"));

    await signUp(SIGNUP_INPUT);

    // BEFORE: console.error('Error', error) with a payload-bearing error.
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain(SSN);
    expect(logged).not.toContain(DOB);
    errorSpy.mockRestore();
  });
});

/**
 * The legacy transfer path is GONE.
 *
 * Phase 4A could only rename these honestly, because PaymentTransferForm needed
 * a funding-source URL to orchestrate the transfer in the browser. The server
 * now owns orchestration, so the actions that handed out provider credentials
 * no longer exist as endpoints at all.
 */
describe("legacy credential-leaking actions are removed", () => {
  it("no longer exports getBankForLegacyTransfer", () => {
    expect(userActions).not.toHaveProperty("getBankForLegacyTransfer");
  });

  it("no longer exports getCounterpartyBankForLegacyTransfer", () => {
    expect(userActions).not.toHaveProperty("getCounterpartyBankForLegacyTransfer");
  });

  it("exposes no action that returns a bank record", () => {
    // Every remaining export is auth, profile or bank-linking. None hands the
    // caller a record carrying accessToken or fundingSourceUrl.
    expect(Object.keys(userActions).sort()).toEqual([
      "createLinkToken",
      "exchangePublicToken",
      "getLoggedInUser",
      "logoutAccount",
      "signIn",
      "signUp",
    ]);
  });
});
