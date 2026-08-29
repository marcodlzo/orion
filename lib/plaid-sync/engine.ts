/**
 * The transactionsSync loop.
 *
 * PURE, over injected ports. No Plaid SDK types, no database, no network — so
 * every pagination case, including the ones a sandbox will not reproduce on
 * demand, is testable directly. The defects this replaces were all in six lines
 * of loop, which is precisely the kind of code that needs to be tested without
 * a provider attached.
 *
 * WHAT WAS WRONG BEFORE, and what each rule here exists to prevent:
 *
 *   no cursor sent      the same first page returned forever, so `has_more`
 *                       never became false — an infinite loop
 *   assignment, not     `transactions = page.added` discarded every page but
 *   accumulation        the last one
 *   `added` only        modified transactions never updated; removed ones
 *                       stayed forever
 *   nothing persisted   every call re-fetched the item's entire history
 */

/** One page of changes, already translated out of the provider's dialect. */
export type SyncPage = {
  added: readonly SyncedTransaction[];
  modified: readonly SyncedTransaction[];
  /** Plaid sends only an id for a retraction; that is all this needs. */
  removed: readonly string[];
  nextCursor: string;
  hasMore: boolean;
};

/** A transaction in internal terms. No provider type reaches past here. */
export type SyncedTransaction = {
  transactionId: string;
  accountId: string;
  /** Integer minor units. Converted once, at the adapter edge. */
  amountMinor: number;
  isoCurrency: string;
  postedDate: string;
  name: string;
  merchantName: string | null;
  pending: boolean;
};

export type SyncChanges = {
  added: SyncedTransaction[];
  modified: SyncedTransaction[];
  removed: string[];
  /** The cursor to store, once the changes above are durably applied. */
  cursor: string;
  pagesFetched: number;
};

export type FetchPage = (cursor: string | null) => Promise<SyncPage>;

/**
 * A page count no legitimate sync reaches.
 *
 * NOT a substitute for the cursor guard below — it is the backstop for a
 * provider that advances the cursor every page while never setting
 * `has_more: false`. Without it the only thing between this loop and an
 * unbounded run against a paid API is the provider behaving.
 */
export const MAX_PAGES = 500;

export class SyncStalledError extends Error {
  readonly code = "SYNC_STALLED";
  constructor(message: string) {
    super(message);
    this.name = "SyncStalledError";
    Object.setPrototypeOf(this, SyncStalledError.prototype);
  }
}

export class SyncTooLongError extends Error {
  readonly code = "SYNC_TOO_LONG";
  constructor(message: string) {
    super(message);
    this.name = "SyncTooLongError";
    Object.setPrototypeOf(this, SyncTooLongError.prototype);
  }
}

/**
 * Walk every page of changes since `startCursor`.
 *
 * Returns what to apply; APPLIES NOTHING. The caller writes the changes and the
 * cursor in one transaction — saving the cursor first loses data permanently,
 * and saving it separately afterwards reprocesses. Keeping this function unable
 * to write is what makes that impossible to get wrong here.
 *
 * `startCursor` is null for an item that has never synced, which is how Plaid is
 * asked for the full history.
 */
export async function collectChanges(
  fetchPage: FetchPage,
  startCursor: string | null,
  options: { maxPages?: number } = {}
): Promise<SyncChanges> {
  const maxPages = options.maxPages ?? MAX_PAGES;

  const added: SyncedTransaction[] = [];
  const modified: SyncedTransaction[] = [];
  const removed: string[] = [];

  let cursor = startCursor;
  let pagesFetched = 0;
  let hasMore = true;

  while (hasMore) {
    if (pagesFetched >= maxPages) {
      throw new SyncTooLongError(
        `sync exceeded ${maxPages} pages; refusing to continue`
      );
    }

    const page = await fetchPage(cursor);
    pagesFetched += 1;

    // ACCUMULATE. The original assigned here, so only the final page survived.
    added.push(...page.added);
    modified.push(...page.modified);
    removed.push(...page.removed);

    // THE GUARD THAT MAKES TERMINATION A PROPERTY OF THIS CODE rather than of
    // the provider's good behaviour. An unchanged cursor with more pages
    // promised is the exact shape of the original infinite loop, and looping
    // again on it would re-fetch the same page forever while the arrays above
    // grow without bound.
    if (page.hasMore && page.nextCursor === cursor) {
      throw new SyncStalledError(
        "provider reported more pages but did not advance the cursor"
      );
    }

    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }

  if (cursor === null || cursor === "") {
    // Plaid returns a usable cursor on every page, including the first page of
    // an item with no history. An empty one would be stored as "sync from the
    // beginning of nothing", so it is refused rather than written.
    throw new SyncStalledError("provider returned no usable cursor");
  }

  return { added, modified, removed, cursor, pagesFetched };
}

/**
 * Fold a page set into the net effect per transaction.
 *
 * WITHIN ONE SYNC a transaction can be added and then modified, or added and
 * then removed, across different pages — Plaid does not promise otherwise.
 * Applying the raw lists in order would work only if the applier happens to
 * process them in the right sequence; folding first makes the outcome
 * independent of that.
 *
 * A removal wins over anything earlier in the same run: the provider's last word
 * about a transaction is that it is gone.
 */
export function foldChanges(changes: SyncChanges): {
  upserts: SyncedTransaction[];
  removals: string[];
} {
  // Array.from rather than spreading a Set: tsconfig sets no `target`, so tsc
  // defaults below ES2015 and iterator spread would need --downlevelIteration.
  const removals = Array.from(new Set(changes.removed));
  const byId = new Map<string, SyncedTransaction>();

  for (const transaction of changes.added.concat(changes.modified)) {
    // Later wins: `modified` follows `added`, and a second modification follows
    // the first.
    byId.set(transaction.transactionId, transaction);
  }

  for (const id of removals) byId.delete(id);

  return { upserts: Array.from(byId.values()), removals };
}
