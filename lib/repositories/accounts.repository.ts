// Server-only. Approved home for createAdminClient.
//
// This is the Appwrite *auth* store, not the document database. It is separated
// from the document repositories because it is the only place the admin client
// is used for identity operations rather than data access, and because signIn
// and signUp are the two intentionally anonymous entry points — the code they
// reach should be small and obvious.
import "server-only";

import { ID } from "node-appwrite";

import { createAdminClient } from "../appwrite";
import { InfrastructureError } from "../auth/errors";

export type AuthAccount = { $id: string };
export type AuthSession = { secret: string; userId: string };

/**
 * Create an Appwrite auth account.
 *
 * Failures are left to the caller to interpret: a duplicate email is a user
 * error, not an outage, and this layer cannot reliably tell them apart from
 * Appwrite's response alone. The signup flow already treats any failure as
 * "signup failed", which is preserved.
 */
export async function createAuthAccount(input: {
  email: string;
  password: string;
  name: string;
}): Promise<AuthAccount> {
  const { account } = await createAdminClient();
  return (await account.create(
    ID.unique(),
    input.email,
    input.password,
    input.name
  )) as unknown as AuthAccount;
}

/**
 * Exchange credentials for a session.
 *
 * Deliberately does NOT wrap failures in InfrastructureError: a wrong password
 * is the expected outcome here, and reporting it as an outage would be wrong.
 * The caller decides.
 */
export async function createEmailPasswordSession(
  email: string,
  password: string
): Promise<AuthSession> {
  const { account } = await createAdminClient();
  return (await account.createEmailPasswordSession(
    email,
    password
  )) as unknown as AuthSession;
}

/** Kept so InfrastructureError is available to future operations here. */
export { InfrastructureError };
