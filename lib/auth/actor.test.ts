import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  ActorNotProvisionedError,
  InfrastructureError,
  UnauthorizedError,
} from "./errors";

/**
 * requireActor() — the single authentication primitive.
 *
 * Unlike the characterisation tests elsewhere in this repo, these assert
 * intended behaviour. They must not be relaxed.
 *
 * The load-bearing assertion is E: an infrastructure failure must NOT be
 * reported as "unauthorized". Collapsing the two hides an outage behind a login
 * screen and teaches callers that every failure means "log in again".
 */

const cookieGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () => ({ get: cookieGet, set: vi.fn(), delete: vi.fn() }),
}));

const accountGet = vi.fn();
const listDocuments = vi.fn();

vi.mock("../appwrite", () => ({
  createSessionClient: async () => ({
    get account() {
      return { get: accountGet };
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

import { requireActor } from "./actor";

const USER_DOCUMENT = {
  $id: "user-doc-alice",
  userId: "auth-alice",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Anderson",
  ssn: "111-11-1111",
  dateOfBirth: "1990-01-01",
  address1: "1 Alice Way",
  city: "Springfield",
  dwollaCustomerId: "dwolla-alice",
  dwollaCustomerUrl: "https://api-sandbox.dwolla.com/customers/dwolla-alice",
};

/** Appwrite signals auth failures with HTTP 401. */
const appwriteError = (code: number, type = "") =>
  Object.assign(new Error(`appwrite ${code}`), { code, type });

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: "a-valid-session-secret" });
  accountGet.mockResolvedValue({ $id: "auth-alice" });
  listDocuments.mockResolvedValue({ documents: [USER_DOCUMENT], total: 1 });
});

describe("A. valid session", () => {
  it("returns the actor resolved from the session", async () => {
    const actor = await requireActor();

    expect(actor).toEqual({
      authId: "auth-alice",
      userId: "user-doc-alice",
      dwollaCustomerId: "dwolla-alice",
    });
  });

  it("resolves userId from the document id, not the userId field", async () => {
    const actor = await requireActor();

    // The naming trap: the document's `userId` FIELD holds the auth id, while
    // its `$id` is what the bank collection's relationship points at. Ownership
    // checks must compare against $id.
    expect(actor.userId).toBe(USER_DOCUMENT.$id);
    expect(actor.authId).toBe(USER_DOCUMENT.userId);
  });

  it("queries the user collection by the session's auth id", async () => {
    await requireActor();

    expect(listDocuments).toHaveBeenCalledTimes(1);
    const [dbId, collectionId] = listDocuments.mock.calls[0];
    expect(dbId).toBe(process.env.APPWRITE_DATABASE_ID);
    expect(collectionId).toBe(process.env.APPWRITE_USER_COLLECTION_ID);
  });
});

describe("B. missing cookie", () => {
  it("throws UnauthorizedError", async () => {
    cookieGet.mockReturnValue(undefined);

    await expect(requireActor()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws UnauthorizedError when the cookie is present but empty", async () => {
    cookieGet.mockReturnValue({ value: "" });

    await expect(requireActor()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("does not touch the datastore when there is no session", async () => {
    cookieGet.mockReturnValue(undefined);

    await expect(requireActor()).rejects.toThrow();
    expect(accountGet).not.toHaveBeenCalled();
    expect(listDocuments).not.toHaveBeenCalled();
  });
});

describe("C. invalid or expired session", () => {
  it("throws UnauthorizedError on a 401 from Appwrite", async () => {
    accountGet.mockRejectedValue(appwriteError(401, "user_unauthorized"));

    await expect(requireActor()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("does not reach the user collection with an invalid session", async () => {
    accountGet.mockRejectedValue(appwriteError(401));

    await expect(requireActor()).rejects.toThrow();
    expect(listDocuments).not.toHaveBeenCalled();
  });
});

describe("D. authenticated account with no internal user record", () => {
  it("throws ActorNotProvisionedError rather than fabricating an actor", async () => {
    listDocuments.mockResolvedValue({ documents: [], total: 0 });

    await expect(requireActor()).rejects.toBeInstanceOf(ActorNotProvisionedError);
  });

  it("throws when the record has no Dwolla customer id", async () => {
    const { dwollaCustomerId, ...withoutDwolla } = USER_DOCUMENT;
    listDocuments.mockResolvedValue({ documents: [withoutDwolla], total: 1 });

    // Reachable in practice: signUp creates the auth account, the Dwolla
    // customer and the user document with no transaction around them.
    await expect(requireActor()).rejects.toBeInstanceOf(ActorNotProvisionedError);
  });

  it("is NOT reported as unauthorized", async () => {
    listDocuments.mockResolvedValue({ documents: [], total: 0 });

    await expect(requireActor()).rejects.not.toBeInstanceOf(UnauthorizedError);
  });
});

describe("E. infrastructure failure must not masquerade as unauthorized", () => {
  it("throws InfrastructureError when the user lookup fails", async () => {
    listDocuments.mockRejectedValue(new Error("appwrite is down"));

    await expect(requireActor()).rejects.toBeInstanceOf(InfrastructureError);
    await expect(requireActor()).rejects.not.toBeInstanceOf(UnauthorizedError);
  });

  it("throws InfrastructureError on a 500 from the auth provider", async () => {
    accountGet.mockRejectedValue(appwriteError(500));

    await expect(requireActor()).rejects.toBeInstanceOf(InfrastructureError);
    await expect(requireActor()).rejects.not.toBeInstanceOf(UnauthorizedError);
  });

  it("throws InfrastructureError on a network-level failure", async () => {
    accountGet.mockRejectedValue(new TypeError("fetch failed"));

    await expect(requireActor()).rejects.toBeInstanceOf(InfrastructureError);
  });

  it("preserves the original failure as the cause", async () => {
    const original = new Error("connection reset");
    listDocuments.mockRejectedValue(original);

    await expect(requireActor()).rejects.toMatchObject({ cause: original });
  });
});

describe("F. the actor carries identity only", () => {
  it("exposes exactly three fields", async () => {
    const actor = await requireActor();

    expect(Object.keys(actor).sort()).toEqual([
      "authId",
      "dwollaCustomerId",
      "userId",
    ]);
  });

  it("carries no PII or provider credential from the source document", async () => {
    const actor = await requireActor();
    const serialised = JSON.stringify(actor);

    for (const forbidden of [
      "ssn",
      "dateOfBirth",
      "address1",
      "city",
      "email",
      "firstName",
      "lastName",
      "dwollaCustomerUrl",
    ]) {
      expect(actor).not.toHaveProperty(forbidden);
    }

    // Values, not just keys — a renamed field would still be a leak.
    expect(serialised).not.toContain("111-11-1111");
    expect(serialised).not.toContain("1990-01-01");
    expect(serialised).not.toContain("alice@example.com");
    expect(serialised).not.toContain("1 Alice Way");
  });
});
