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

import { createHash } from "node:crypto";

import { Query } from "node-appwrite";

import { createAdminClient } from "../appwrite";
import { decryptCredential, isEncrypted } from "../crypto/envelope";
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
  /**
   * Digest of exactly what was read.
   *
   * A dry run and the commit that follows it re-read Appwrite independently, so
   * "the dry run looked fine" says nothing about the dataset actually
   * committed. Counts do not help — a delete and an insert between the two runs
   * leaves the count identical. This is what an operator can carry from one to
   * the other and have checked.
   */
  fingerprint: string;
};

/**
 * Digest a set of documents by identity and last-modified time.
 *
 * `$updatedAt` is what makes an in-place edit visible; without it two different
 * datasets of the same size and ids would digest identically. Documents are
 * already walked in `$id` order, so the digest is stable across runs.
 */
function fingerprintOf(documents: readonly { $id: string }[]): string {
  const hash = createHash("sha256");
  for (const doc of documents) {
    const updatedAt = (doc as { $updatedAt?: unknown }).$updatedAt;
    if (typeof updatedAt !== "string" || !updatedAt) {
      // Without it the digest cannot see an in-place edit: two different
      // datasets with the same ids would hash identically, and the whole point
      // is to detect exactly that. Refuse rather than emit a digest that
      // silently proves less than it appears to.
      throw new Error(
        `document ${doc.$id} has no $updatedAt; cannot fingerprint the source`
      );
    }
    // Length-prefixed, so no separator can be forged from field contents and
    // the file stays plain text. An earlier version used literal NUL and SOH
    // bytes as delimiters, which made git treat this source file as binary and
    // stopped it being diffable.
    hash.update(`${doc.$id.length}:${doc.$id}|${updatedAt.length}:${updatedAt};`);
  }
  return hash.digest("hex").slice(0, 32);
}

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
  let fingerprint: string;
  try {
    fingerprint = fingerprintOf(out);
  } catch (error) {
    // Same vocabulary as every other failure to read this collection: the
    // caller cannot use a scan it cannot fingerprint.
    throw new InfrastructureError(`Failed to read the ${label} collection`, {
      cause: error,
    });
  }

  return {
    documents: out,
    scanned: out.length,
    reportedTotal,
    pages,
    complete: out.length === reportedTotal,
    fingerprint,
  };
}

/** UNSCOPED. Every user document. Operator tooling only. */
export function readAllLegacyUsers(): Promise<SourceScan<LegacyUserDocument>> {
  return readAll<LegacyUserDocument>(USER_COLLECTION_ID!, "user");
}

/**
 * UNSCOPED. Every bank document. Operator tooling only.
 *
 * DECRYPTS THE CREDENTIALS, because this reader goes around
 * `banks.repository.ts` — which is where encryption and decryption live — and
 * would otherwise hand ciphertext to callers as if it were an access token.
 *
 * That is not hypothetical: the first backfill run after credentials were
 * encrypted passed ciphertext to Plaid and every account came back
 * INVALID_ACCESS_TOKEN. The backfill refused to migrate them rather than
 * inventing metadata, which is why it surfaced as a blocked migration instead
 * of a corrupted one.
 *
 * Plaintext values are tolerated for records written before the encryption
 * migration, on the same terms as the repository: a value that IS encrypted and
 * fails to decrypt raises rather than being passed along.
 */
export async function readAllLegacyBanks(): Promise<SourceScan<LegacyBankDocument>> {
  const scan = await readAll<LegacyBankDocument>(BANK_COLLECTION_ID!, "bank");

  return {
    ...scan,
    documents: scan.documents.map((bank) => ({
      ...bank,
      accessToken: readCredential(bank, "accessToken"),
      fundingSourceUrl: readCredential(bank, "fundingSourceUrl"),
    })),
  };
}

function readCredential(
  bank: LegacyBankDocument,
  field: "accessToken" | "fundingSourceUrl"
): string {
  const stored = bank[field];
  if (typeof stored !== "string" || stored === "") return "";
  if (!isEncrypted(stored)) return stored;
  return decryptCredential(stored, { recordId: bank.$id, field });
}
