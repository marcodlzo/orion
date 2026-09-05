// Server-only. One of the two approved homes for createAdminClient (the other
// being lib/appwrite.ts, the factory itself). The admin client bypasses every
// Appwrite permission rule, so every query it issues must be visible here
// rather than scattered across action modules.
import "server-only";

import { cache } from "react";
import { ID, Query } from "node-appwrite";

import { createAdminClient } from "../appwrite";
import { InfrastructureError } from "../auth/errors";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
} = process.env;

/**
 * A user-collection document as stored.
 *
 * Still the raw shape, PII included. Narrowing what leaves the server is the
 * DTO phase; this phase only controls WHO may reach it.
 */
export type UserRecord = Record<string, unknown> & {
  $id: string;
  userId: string;
  dwollaCustomerId?: string;
};

/**
 * Resolve the internal user record for an authenticated Appwrite account.
 *
 * Taking a raw identifier is safe here, and only here, because authId is read
 * from the verified session inside requireActor(). It never originates from the
 * browser. No other lookup in this codebase may accept an arbitrary user id.
 *
 * @returns the record, or null when the account has no internal user document
 * @throws InfrastructureError when the datastore cannot be reached
 */
// Share the document already read by requireActor with profile/DTO readers.
// This memo is discarded after the server render; writes are never memoized.
export const findUserByAuthId = cache(async function findUserByAuthId(
  authId: string
): Promise<UserRecord | null> {
  let documents: unknown[];
  try {
    const { database } = await createAdminClient();
    const result = await database.listDocuments(DATABASE_ID!, USER_COLLECTION_ID!, [
      Query.equal("userId", [authId]),
    ]);
    documents = result.documents;
  } catch (error) {
    throw new InfrastructureError("Failed to read the user collection", { cause: error });
  }

  return (documents[0] as UserRecord | undefined) ?? null;
});

/**
 * Create the internal user record that backs an Appwrite auth account.
 *
 * Called only from the signup flow, immediately after the auth account exists.
 *
 * DEFECT (not this phase): the caller passes the whole signup payload, which
 * includes ssn and dateOfBirth, and both are written in plaintext. Not storing
 * SSN at all is the DTO / data-minimisation phase.
 */
export async function createUserRecord(data: Record<string, unknown>): Promise<UserRecord> {
  try {
    const { database } = await createAdminClient();
    const created = await database.createDocument(
      DATABASE_ID!,
      USER_COLLECTION_ID!,
      ID.unique(),
      data
    );
    return created as unknown as UserRecord;
  } catch (error) {
    throw new InfrastructureError("Failed to create the user record", { cause: error });
  }
}
