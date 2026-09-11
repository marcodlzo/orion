/**
 * Sync Plaid transactions for every linked Item.
 *
 *   npm run plaid:sync
 *
 * OFF THE RENDER PATH, WHICH IS THE POINT. Sync used to run during SSR of `/`,
 * adding blocking Plaid calls to every page load and re-fetching each item's
 * entire history because no cursor was ever persisted. This is where it belongs:
 * a job that advances a stored cursor, applies added/modified/removed atomically,
 * and can be re-run safely if it fails halfway.
 *
 * DRIVEN FROM APPWRITE, because that is still where a bank link lives. The item
 * id is the bank document's `bankId`; `plaid_items` rows are created by this run
 * rather than assumed to exist.
 *
 * ACCESS TOKENS ARE STILL STORED UNENCRYPTED IN APPWRITE. That is a separate,
 * unscheduled milestone and this does not change it. What this file guarantees
 * is narrower and worth stating exactly: a token is read, passed to one function,
 * and never stored, returned, or printed. No line this script emits is built
 * from a scope that holds one.
 *
 * Exit codes:  0 all items healthy   1 an item needs attention   2 the run failed
 */
import { closePool } from "../lib/db/pool";
import { describeThrown } from "../lib/migration/report-format";
// The sanctioned unscoped reader. It reads every bank document with the admin
// client and scopes nothing — correct for an operator sweep, and the reason this
// file may import it while no request path may.
import { listAllBanksForOperator } from "../lib/repositories/banks.repository";
import { syncPlaidItem } from "../lib/plaid-sync/sync";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--item-id" || !/^[\w-]+$/.test(args[1]))) {
    console.error("Usage: npm run plaid:sync -- [--item-id ITEM_ID]");
    return 2;
  }
  const selectedItem = args[1];
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }

  // FROM POSTGRESQL. This read the Appwrite collection until the Phase 4
  // cutover stopped writing it, at which point the sweep silently found no
  // banks for anything linked since — a sweep reporting "nothing to sync"
  // looks identical to a sweep with nothing to do.
  //
  // No completeness check is needed any more. The Appwrite read paginated and
  // could return half a collection while reporting the full total, which is
  // what that guard existed for. One SQL statement either returns the rows or
  // raises.
  const scan = { documents: await listAllBanksForOperator() };

  if (scan.documents.length === 0) {
    console.log("No linked banks. Nothing to sync.");
    return 0;
  }

  // An Item can back several bank documents — one per linked account — and the
  // cursor belongs to the ITEM, not the account. Syncing the same item once per
  // account would walk the same pages repeatedly and race its own cursor.
  const byItem = new Map<string, string>();
  for (const bank of scan.documents) {
    const itemId = typeof bank.bankId === "string" ? bank.bankId.trim() : "";
    const accessToken =
      typeof bank.accessToken === "string" ? bank.accessToken.trim() : "";
    if (!itemId || !accessToken || (selectedItem && selectedItem !== itemId)) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, accessToken);
  }

  if (selectedItem && byItem.size === 0) {
    console.error("The selected Item has no linked bank with a usable credential.");
    return 2;
  }
  const skipped = selectedItem ? 0 : scan.documents.length - byItem.size;
  let needsAttention = 0;

  const itemIds = Array.from(byItem.keys());
  for (const itemId of itemIds) {
    const outcome = await syncPlaidItem({
      itemId,
      accessToken: byItem.get(itemId)!,
    });

    if (outcome.status === "synced") {
      console.log(
        `${itemId}  synced   pages=${outcome.pagesFetched} ` +
          `upserted=${outcome.upserted} removed=${outcome.removed}`
      );
    } else {
      // The provider's error CODE only. A Plaid error message echoes the
      // request, and the request carries the access token.
      console.log(
        `${itemId}  ${outcome.status}  ${outcome.errorCode}` +
          (outcome.status === "login_required"
            ? "  — the user must re-link this bank"
            : "")
      );
      needsAttention += 1;
    }
  }

  console.log("");
  console.log(
    `${itemIds.length} item(s) from ${scan.documents.length} bank document(s); ` +
      `${needsAttention} needing attention.`
  );
  if (skipped > 0) {
    // Named rather than dropped: a bank document with no item id or no token is
    // one whose data is silently going stale.
    console.log(
      `${skipped} bank document(s) contributed no syncable item (duplicate item, missing id, or missing token).`
    );
  }

  return needsAttention > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(describeThrown(error));
    await closePool();
    process.exit(2);
  });
