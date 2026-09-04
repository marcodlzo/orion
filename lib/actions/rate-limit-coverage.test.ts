import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHICH ACTIONS CONSULT THE LIMITER, AND WHICH DELIBERATELY DO NOT.
 *
 * Every other rate-limit test proves the limiter works. None of them proves it
 * is WIRED UP: deleting `await consume(...)` from an action left all 667 tests
 * green, because each one either stubs the limiter or never reaches it. A
 * control nothing asserts the presence of is one refactor from being gone.
 *
 * The two exclusions are asserted as deliberately as the five inclusions. If
 * somebody later adds a limit to `logoutAccount`, this fails and makes them read
 * why it is absent — refusing to let a person end their session is a security
 * harm, not a control.
 *
 * Collaborators are stubbed to fail. That is not laziness: the limiter runs
 * BEFORE any of them, so a test that asserts it was consulted even when
 * everything downstream is broken is asserting the ordering too.
 */

const { recordAttempt, cookieGet, accountGet, findUserByAuthId } = vi.hoisted(
  () => ({
    recordAttempt: vi.fn(),
    cookieGet: vi.fn(),
    accountGet: vi.fn(),
    findUserByAuthId: vi.fn(),
  })
);

vi.mock("../db/repositories/rate-limits.repository", () => ({
  recordAttempt,
  attemptsIn: vi.fn(),
  sweepExpiredCounters: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: cookieGet, set: vi.fn(), delete: vi.fn() }),
  headers: () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
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
      return { listDocuments: vi.fn(), createDocument: vi.fn() };
    },
    get account() {
      return {};
    },
    get user() {
      return {};
    },
  }),
}));

vi.mock("../repositories/users.repository", () => ({
  findUserByAuthId,
  createUserRecord: vi.fn(async () => {
    throw new Error("stubbed: not reached in these tests");
  }),
}));
vi.mock("../repositories/accounts.repository", () => ({
  createAuthAccount: vi.fn(async () => {
    throw new Error("stubbed: not reached in these tests");
  }),
  createEmailPasswordSession: vi.fn(async () => {
    throw new Error("stubbed: not reached in these tests");
  }),
}));
vi.mock("../repositories/banks.repository", () => ({
  createBankForActor: vi.fn(),
  getOwnedBankByDocumentId: vi.fn(),
  findCounterpartyBankByAccountId: vi.fn(),
  getOwnedBanks: vi.fn(),
  getOwnedBankByAccountId: vi.fn(),
}));
vi.mock("../server/dwolla", () => ({
  createDwollaCustomer: vi.fn(async () => {
    throw new Error("stubbed: not reached in these tests");
  }),
  addFundingSource: vi.fn(),
  describeDwollaError: vi.fn(() => "stub"),
  createDwollaTransfer: vi.fn(),
  dwollaClient: { post: vi.fn() },
}));
vi.mock("@/lib/plaid", () => ({
  plaidClient: {
    linkTokenCreate: vi.fn(async () => {
      throw new Error("stubbed: not reached in these tests");
    }),
    itemPublicTokenExchange: vi.fn(async () => {
      throw new Error("stubbed: not reached in these tests");
    }),
  },
}));
vi.mock("../services/transfers.service", () => ({
  executeTransfer: vi.fn(async () => {
    throw new Error("stubbed: not reached in these tests");
  }),
}));

import {
  createLinkToken,
  exchangePublicToken,
  getLoggedInUser,
  logoutAccount,
  signIn,
  signUp,
} from "./user.actions";
import { initiateTransfer } from "./transfer.actions";

/** A session that resolves to a fully provisioned actor. */
function authenticate() {
  cookieGet.mockReturnValue({ value: "a-session-secret" });
  accountGet.mockResolvedValue({ $id: "auth-alice" });
  findUserByAuthId.mockResolvedValue({
    $id: "user-doc-alice",
    userId: "auth-alice",
    dwollaCustomerId: "dwolla-alice",
  });
}

/** Run an action, discarding whatever it does after the limiter. */
async function run(action: () => Promise<unknown>): Promise<void> {
  await action().catch(() => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Under the limit, so the limiter permits and the action proceeds to the
  // stubs that throw.
  recordAttempt.mockResolvedValue(1);
  authenticate();
});

describe("actions that must consult the limiter", () => {
  it("signIn, on two keys", async () => {
    await run(() => signIn({ email: "a@b.invalid", password: "pw" }));

    // Two rules: per-address and per-email. One alone is insufficient — a
    // per-address limit misses an attacker rotating addresses, and a per-email
    // limit misses one grinding a stuffing list of different addresses.
    expect(recordAttempt).toHaveBeenCalledTimes(2);
    const buckets = recordAttempt.mock.calls.map((c) => c[0].bucket as string);
    expect(buckets.some((b) => b.startsWith("signin:addr:"))).toBe(true);
    expect(buckets.some((b) => b.startsWith("signin:email:"))).toBe(true);
  });

  it("signUp", async () => {
    await run(() =>
      signUp({
        email: "a@b.invalid",
        password: "pw",
        firstName: "A",
        lastName: "B",
        address1: "1 Test St",
        city: "Testville",
        state: "CA",
        postalCode: "90210",
        dateOfBirth: "1990-01-01",
        ssn: "1234",
      } as never)
    );

    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(recordAttempt.mock.calls[0][0].bucket).toMatch(/^signup:addr:/);
  });

  it("createLinkToken", async () => {
    await run(() => createLinkToken());

    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(recordAttempt.mock.calls[0][0].bucket).toMatch(/^linktoken:actor:/);
  });

  it("exchangePublicToken", async () => {
    await run(() => exchangePublicToken({ publicToken: "public-sandbox-token" }));

    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(recordAttempt.mock.calls[0][0].bucket).toMatch(/^exchange:actor:/);
  });

  it("initiateTransfer", async () => {
    await run(() => initiateTransfer({}));

    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(recordAttempt.mock.calls[0][0].bucket).toMatch(/^transfer:actor:/);
  });
});

describe("actions that deliberately do not", () => {
  it("getLoggedInUser, because the layout calls it on every render", async () => {
    // A limit here would put a database write on the hot path of every page
    // view, and because the limiter fails closed, a PostgreSQL blip would
    // present as every signed-in user being logged out at once.
    await run(() => getLoggedInUser());

    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it("logoutAccount, because ending a session must not be refusable", async () => {
    // The one action whose failure leaves the caller worse off than not calling
    // it at all.
    await run(() => logoutAccount());

    expect(recordAttempt).not.toHaveBeenCalled();
  });
});

describe("the limited actions cannot swallow a refusal", () => {
  it("signIn propagates it instead of returning undefined", async () => {
    // signIn's catch logs and returns undefined. A limit consulted inside it
    // would be discarded, the caller would see an ordinary failed sign-in, and
    // the attacker would keep going. The limiter has to be what ends the
    // request, which is why it sits above the try.
    recordAttempt.mockResolvedValue(Number.MAX_SAFE_INTEGER);

    await expect(
      signIn({ email: "a@b.invalid", password: "pw" })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("signUp propagates it too", async () => {
    recordAttempt.mockResolvedValue(Number.MAX_SAFE_INTEGER);

    await expect(
      signUp({
        email: "a@b.invalid",
        password: "pw",
        firstName: "A",
        lastName: "B",
      } as never)
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("createLinkToken propagates it too", async () => {
    recordAttempt.mockResolvedValue(Number.MAX_SAFE_INTEGER);

    await expect(createLinkToken()).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});
