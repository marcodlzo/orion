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

/**
 * Appwrite's maximum page size.
 *
 * Set explicitly, never left to the server default. Appwrite's default is 25;
 * relying on it means the page size can change under the migration without a
 * code change, and a smaller page is more round trips for the same data.
 */
export const PAGE_SIZE = 100;

/**
 * A hard ceiling on pages, so a pathological server cannot spin forever.
 * At PAGE_SIZE 100 this allows a million documents per collection — far beyond
 * anything this dataset will hold, and far short of an unbounded loop.
 */
const MAX_PAGES = 10_000;

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
 * Evidence that a read was COMPLETE, not merely that it returned something.
 *
 * `reportedTotal` is what Appwrite says the collection holds; `scanned` is what
 * was actually walked. A migration cannot claim completeness without both, and
 * a partial read that looks like a small dataset is the failure mode that
 * silently loses a customer's accounts.
 */
export type SourceScan<T> = {
  documents: T[];
  scanned: number;
  reportedTotal: number;
  pages: number;
  complete: boolean;
};

/**
 * Read an entire collection, one page at a time.
 *
 * Cursor pagination, not offset. Offset pagination silently skips or repeats
 * rows when the underlying set changes between pages, which during a migration
 * means quietly losing a customer's account.
 *
 * Non-progress THROWS. An earlier version broke out of the loop when the cursor
 * failed to advance, which converted a provider fault into a short read — the
 * caller then saw a small, well-formed dataset and had no way to tell it was
 * truncated. Partial source data must stop the migration, never feed it.
 */
async function readAll<T extends { $id: string }>(
  collectionId: string,
  label: string
): Promise<SourceScan<T>> {
  const out: T[] = [];
  const seenIds = new Set<string>();
  let cursor: string | undefined;
  let reportedTotal = 0;
  let pages = 0;

  try {
    const { database } = await createAdminClient();

    for (;;) {
      const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
      if (cursor) queries.push(Query.cursorAfter(cursor));

      const page = await database.listDocuments(DATABASE_ID!, collectionId, queries);
      const documents = page.documents as unknown as T[];
      pages += 1;
      reportedTotal = page.total ?? reportedTotal;

      for (const doc of documents) {
        // A repeated document means the cursor walked backwards or stalled.
        // Deduplicating silently would hide it; the count would look right
        // while the tail of the collection was never read.
        if (seenIds.has(doc.$id)) {
          throw new Error(
            `pagination returned document ${doc.$id} twice on page ${pages}`
          );
        }
        seenIds.add(doc.$id);
        out.push(doc);
      }

      if (documents.length < PAGE_SIZE) break;

      const next = documents[documents.length - 1]?.$id;
      if (!next) {
        throw new Error(`pagination could not derive a cursor from page ${pages}`);
      }
      if (next === cursor) {
        throw new Error(`pagination cursor did not advance past ${next}`);
      }
      if (pages >= MAX_PAGES) {
        throw new Error(`pagination exceeded ${MAX_PAGES} pages`);
      }
      cursor = next;
    }
  } catch (error) {
    throw new InfrastructureError(`Failed to read the ${label} collection`, {
      cause: error,
    });
  }

  if (out.length < reportedTotal) {
    // Appwrite reports the collection total on every page. Reading fewer means
    // the walk did not see everything, and a backfill on a short read would
    // report success while leaving customers behind. This is the failure the
    // whole scan record exists to catch, so it stops the run.
    throw new InfrastructureError(
      `Failed to read the ${label} collection: read ${out.length} of ${reportedTotal} documents`
    );
  }

  // Reading MORE than reported is not data loss — it happens when a document is
  // deleted mid-walk and the total shrinks. It is still evidence the source
  // moved underneath the migration, so it is recorded rather than thrown.
  return {
    documents: out,
    scanned: out.length,
    reportedTotal,
    pages,
    complete: out.length === reportedTotal,
  };
}

/** UNSCOPED. Every user document. Operator tooling only. */
export function readAllLegacyUsers(): Promise<SourceScan<LegacyUserDocument>> {
  return readAll<LegacyUserDocument>(USER_COLLECTION_ID!, "user");
}

/** UNSCOPED. Every bank document. Operator tooling only. */
export function readAllLegacyBanks(): Promise<SourceScan<LegacyBankDocument>> {
  return readAll<LegacyBankDocument>(BANK_COLLECTION_ID!, "bank");
}
