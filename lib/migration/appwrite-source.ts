// Server-only. OPERATOR TOOLING — reads the entire legacy dataset.
//
// ============================== READ THIS ==============================
// Every function here is DELIBERATELY UNSCOPED. It reads all users and all
// bank documents, ignoring ownership entirely.
//
// That is correct for a backfill and catastrophic anywhere else. A migration
// is an operator action performed once against the whole dataset; it has no
// "current user" because it is not serving a request.
//
// Therefore:
//   - this module is NEVER imported by a server action
//   - this module is NEVER imported by anything client-reachable
//   - it is reached only from scripts/ run by an operator
//
// An architecture test enforces all three. If you find yourself wanting one of
// these functions inside a request path, you want an actor-scoped repository
// instead — see lib/repositories/.
// =======================================================================
import "server-only";

import { Query } from "node-appwrite";

import { createAdminClient } from "../appwrite";
import { InfrastructureError } from "../auth/errors";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

/** Appwrite's maximum page size. */
const PAGE_SIZE = 100;

export type LegacyUserDocument = {
  $id: string;
  userId: string;
  [key: string]: unknown;
};

export type LegacyBankDocument = {
  $id: string;
  /** Relationship: reads back as the related user document, or as a string id. */
  userId: unknown;
  accountId: string;
  bankId: string;
  accessToken: string;
  shareableId?: string;
  [key: string]: unknown;
};

/**
 * Read an entire collection, one page at a time.
 *
 * Cursor pagination, not offset. Offset pagination silently skips or repeats
 * rows when the underlying set changes between pages, which during a migration
 * means quietly losing a customer's account.
 */
async function readAll<T extends { $id: string }>(
  collectionId: string,
  label: string
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;

  try {
    const { database } = await createAdminClient();

    for (;;) {
      const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
      if (cursor) queries.push(Query.cursorAfter(cursor));

      const page = await database.listDocuments(DATABASE_ID!, collectionId, queries);
      const documents = page.documents as unknown as T[];
      out.push(...documents);

      if (documents.length < PAGE_SIZE) break;

      const next = documents[documents.length - 1]?.$id;
      // Guard against a cursor that fails to advance: without this a provider
      // quirk becomes an infinite loop that fills memory.
      if (!next || next === cursor) break;
      cursor = next;
    }
  } catch (error) {
    throw new InfrastructureError(`Failed to read the ${label} collection`, {
      cause: error,
    });
  }

  return out;
}

/** UNSCOPED. Every user document. Operator tooling only. */
export function readAllLegacyUsers(): Promise<LegacyUserDocument[]> {
  return readAll<LegacyUserDocument>(USER_COLLECTION_ID!, "user");
}

/** UNSCOPED. Every bank document. Operator tooling only. */
export function readAllLegacyBanks(): Promise<LegacyBankDocument[]> {
  return readAll<LegacyBankDocument>(BANK_COLLECTION_ID!, "bank");
}
