// Server-only. Runs a Plaid transaction sync for one Item and stores the result.
//
// BACKGROUND / OPERATOR ONLY, and unreachable from any request path. Sync used
// to run during SSR of `/`, adding blocking Plaid calls to every page load; that
// coupling is the defect being removed, so this deliberately does not become
// callable from a page. It is driven by scripts/plaid-sync.ts today and is the
// natural target for a Plaid webhook later.
import "server-only";

import { plaidClient } from "../plaid";
import {
  applySync,
  ensurePlaidItem,
  recordItemFailure,
} from "../db/repositories/plaid-items.repository";
import { classifyPlaidError, toSyncPage } from "./adapter";
import {
  collectChanges,
  foldChanges,
  type FetchPage,
  type SyncPage,
} from "./engine";

export type SyncOutcome =
  | {
      status: "synced";
      itemId: string;
      pagesFetched: number;
      upserted: number;
      removed: number;
    }
  | {
      status: "login_required" | "error";
      itemId: string;
      /** Provider error CODE. Never a provider message. */
      errorCode: string;
    };

export type SyncDeps = {
  /** Injected so the engine can be driven without a network or credentials. */
  fetchPage: (accessToken: string) => FetchPage;
};

/**
 * The real Plaid call.
 *
 * `cursor` is omitted rather than sent as null on the first sync: Plaid treats
 * an absent cursor as "the whole history", and an explicit null is not the same
 * request.
 */
export const defaultSyncDeps: SyncDeps = {
  fetchPage: (accessToken: string) => async (cursor: string | null) => {
    const response = await plaidClient.transactionsSync(
      cursor === null
        ? { access_token: accessToken }
        : { access_token: accessToken, cursor }
    );
    return toSyncPage(response.data as unknown as Record<string, unknown>);
  },
};

/**
 * Sync one Item.
 *
 * ORDER, AND WHY:
 *
 *   1. register the item and read its stored cursor
 *   2. walk every page from that cursor, accumulating
 *   3. fold the pages into a net effect per transaction
 *   4. write the changes AND the cursor in ONE transaction
 *
 * Step 4 is the one that matters. The cursor is a promise that everything before
 * it has been stored; writing it separately from the data breaks that promise in
 * whichever direction the crash happens to fall.
 *
 * A provider failure does NOT advance or clear the cursor. The next run resumes
 * from exactly where the last successful one stopped.
 *
 * The access token is a parameter and never leaves this function. It is not
 * stored, not logged, and not part of any outcome returned to a caller.
 */
export async function syncPlaidItem(
  input: { itemId: string; accessToken: string },
  deps: SyncDeps = defaultSyncDeps
): Promise<SyncOutcome> {
  const item = await ensurePlaidItem(input.itemId);

  let changes;
  try {
    changes = await collectChanges(
      deps.fetchPage(input.accessToken),
      item.cursor
    );
  } catch (error) {
    // An Item that needs re-linking is a state, not an exception to swallow.
    // Swallowing it makes a dead bank connection look exactly like an account
    // with no new activity, which is how one rots unnoticed for months.
    const health = classifyPlaidError(error);
    if (health.status === "healthy") {
      // Not a provider error — a stalled cursor or an oversized page run. Still
      // recorded against the item so it is visible, and still not fatal to the
      // caller's other items.
      const code =
        error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "SYNC_FAILED";
      await recordItemFailure({
        itemId: input.itemId,
        status: "error",
        errorCode: code,
      });
      return { status: "error", itemId: input.itemId, errorCode: code };
    }

    await recordItemFailure({
      itemId: input.itemId,
      status: health.status,
      errorCode: health.code,
    });
    return {
      status: health.status,
      itemId: input.itemId,
      errorCode: health.code,
    };
  }

  const { upserts, removals } = foldChanges(changes);

  const applied = await applySync({
    itemId: input.itemId,
    upserts,
    removals,
    cursor: changes.cursor,
  });

  return {
    status: "synced",
    itemId: input.itemId,
    pagesFetched: changes.pagesFetched,
    upserted: applied.upserted,
    removed: applied.removed,
  };
}

export type { SyncPage };
