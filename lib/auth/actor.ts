// Server-only. Reads the session cookie and resolves identity using the admin
// client. Must never be reachable from a client component.
import "server-only";

import { Query } from "node-appwrite";
import { cookies } from "next/headers";

import { createAdminClient, createSessionClient } from "../appwrite";
import {
  ActorNotProvisionedError,
  InfrastructureError,
  UnauthorizedError,
} from "./errors";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
} = process.env;

export const SESSION_COOKIE = "appwrite-session";

/**
 * The authenticated caller's identity — and nothing else.
 *
 * This is an authorization identity, not a user profile. It carries only what
 * is needed to answer "who is calling?" and to scope a later ownership check.
 *
 * Deliberately absent: ssn, dateOfBirth, address, email, name, Plaid access
 * tokens, funding-source URLs, and the raw Appwrite document. Anything that
 * needs a profile field should fetch it explicitly and deliberately, so the
 * read is visible at the call site rather than smuggled in on the actor.
 */
export type Actor = {
  /** Appwrite auth account id. Identifies the login, not the app-side record. */
  readonly authId: string;
  /**
   * Appwrite user-collection DOCUMENT id.
   *
   * This is the value the bank collection's `userId` relationship points at,
   * so it is the id every ownership check in Phase 3 will compare against.
   * Note the naming trap: the user document's own `userId` FIELD holds authId.
   */
  readonly userId: string;
  /** Dwolla customer id. Required for any funding-source or transfer work. */
  readonly dwollaCustomerId: string;
};

/**
 * Appwrite signals an auth failure with HTTP 401, or 404 on a deleted session.
 * Anything else — 5xx, a network error, a thrown TypeError — is infrastructure
 * and must not be reported as "not authenticated".
 */
function isAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const type = (error as { type?: unknown }).type;
  if (code === 401) return true;
  if (typeof type === "string" && /unauthoriz|user_session|session_not_found|user_jwt_invalid/i.test(type)) {
    return true;
  }
  // createSessionClient throws a plain Error when the cookie is absent.
  return error instanceof Error && error.message === "No session";
}

/**
 * Resolve the authenticated actor from the current request's session.
 *
 * Takes no parameters, by design. Identity is never supplied by the caller —
 * accepting a userId, an accountId or a user object is what made every action
 * in this application impersonatable.
 *
 * Sequence:
 *   1. read the session cookie; absent -> UnauthorizedError
 *   2. resolve the Appwrite auth account from that session
 *      (401 -> UnauthorizedError, anything else -> InfrastructureError)
 *   3. look up the internal user document by auth id
 *      (query failure -> InfrastructureError)
 *   4. no document, or no Dwolla customer id -> ActorNotProvisionedError
 *   5. return only the three identity fields
 *
 * @throws UnauthorizedError          no usable session
 * @throws ActorNotProvisionedError   session valid, internal identity missing
 * @throws InfrastructureError        could not determine identity
 */
export async function requireActor(): Promise<Actor> {
  // 1. session cookie
  const session = cookies().get(SESSION_COOKIE);
  if (!session?.value) {
    throw new UnauthorizedError("No session cookie present");
  }

  // 2. authenticated Appwrite account
  let authId: string;
  try {
    const { account } = await createSessionClient();
    const result = await account.get();
    authId = result.$id;
  } catch (error) {
    if (isAuthFailure(error)) {
      throw new UnauthorizedError("Session is invalid or expired", { cause: error });
    }
    throw new InfrastructureError("Failed to resolve the authenticated account", {
      cause: error,
    });
  }

  if (!authId) {
    throw new UnauthorizedError("Session resolved to no account");
  }

  // 3. internal user document
  let documents: Array<Record<string, unknown>>;
  try {
    const { database } = await createAdminClient();
    const result = await database.listDocuments(DATABASE_ID!, USER_COLLECTION_ID!, [
      Query.equal("userId", [authId]),
    ]);
    documents = result.documents as unknown as Array<Record<string, unknown>>;
  } catch (error) {
    // The caller may be perfectly authenticated; we simply could not look them
    // up. Reporting this as unauthorized would hide an outage behind a login.
    throw new InfrastructureError("Failed to resolve the internal user record", {
      cause: error,
    });
  }

  // 4. explicit failure rather than a fabricated actor
  const userDocument = documents[0];
  if (!userDocument) {
    throw new ActorNotProvisionedError();
  }

  const userId = typeof userDocument.$id === "string" ? userDocument.$id : "";
  const dwollaCustomerId =
    typeof userDocument.dwollaCustomerId === "string" ? userDocument.dwollaCustomerId : "";

  if (!userId) {
    throw new ActorNotProvisionedError("Internal user record has no document id");
  }
  if (!dwollaCustomerId) {
    throw new ActorNotProvisionedError("Internal user record has no Dwolla customer id");
  }

  // 5. minimal identity only
  return { authId, userId, dwollaCustomerId };
}
