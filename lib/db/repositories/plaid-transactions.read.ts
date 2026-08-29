// Server-only. READS of synced Plaid transactions, for display.
//
// SEPARATE FROM plaid-items.repository.ts ON PURPOSE. That module advances a
// stored cursor, and a render path that can advance sync state lets two
// concurrent page loads race the same Item. This module contains reads and
// nothing else, so it can be reachable from a request while the writer stays
// operator-only. An architecture test asserts it issues no write.
//
// SCOPING IS THE CALLER'S JOB AND MUST BE DONE FIRST. `plaid_account_id` is a
// Plaid identifier with no owner recorded against it here — ownership lives in
// the Appwrite bank documents. Every function below takes account ids that the
// caller has ALREADY proven belong to the actor, via the ownership-scoped bank
// queries. Passing an unverified id from a request would be an IDOR.
import "server-only";

import type { PoolClient } from "pg";

import { query } from "../pool";
import { toDatabaseError } from "../errors";
import type { PlaidTransactionRow } from "./plaid-items.repository";

async function run<T extends Record<string, unknown>>(
  client: PoolClient | undefined,
  text: string,
  params: readonly unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  if (!client) return query<T>(text, params);
  try {
    const result = await client.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/** How many rows a single display read may return. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Transactions for accounts the caller has already proven the actor owns.
 *
 * Takes a LIST of account ids because an Item owns many accounts and a user owns
 * many Items — the previous code showed one account per bank and called it the
 * whole picture.
 *
 * WHAT ACTUALLY MAKES AN EMPTY LIST SAFE: `= ANY($1::text[])`. An empty array
 * matches no rows, verified against a real server — so a user with no linked
 * accounts gets nothing rather than everything.
 *
 * The early return below is an OPTIMISATION, not the guarantee, and is
 * deliberately not credited with one. Removing it does not change the result,
 * which a mutation confirmed. It is kept because a query that cannot match is
 * still a round trip. Note the guarantee is a property of THIS comparison: a
 * hand-built `IN (...)` list would collapse to `IN ()` and be a syntax error, and
 * a string-interpolated filter could vanish entirely — which is why the array
 * form is used rather than assembled SQL.
 */
export async function listTransactionsForOwnedAccounts(
  ownedAccountIds: readonly string[],
  options: { limit?: number } = {},
  client?: PoolClient
): Promise<PlaidTransactionRow[]> {
  if (ownedAccountIds.length === 0) return [];

  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const { rows } = await run<PlaidTransactionRow>(
    client,
    `SELECT * FROM plaid_transactions
      WHERE plaid_account_id = ANY($1::text[])
        AND removed_at IS NULL
      ORDER BY posted_date DESC, plaid_transaction_id
      LIMIT $2`,
    [[...ownedAccountIds], limit]
  );
  return rows;
}

/**
 * Whether an Item has ever synced, and whether it is healthy.
 *
 * The UI needs this to tell "no transactions" apart from "this bank connection
 * is broken" and from "nothing has run yet" — three states that look identical
 * as an empty list, and the reason a dead link can go unnoticed for months.
 */
export type ItemSyncStatus = {
  itemId: string;
  status: "healthy" | "login_required" | "error";
  everSynced: boolean;
  lastSyncedAt: Date | null;
};

export async function readSyncStatus(
  itemIds: readonly string[],
  client?: PoolClient
): Promise<ItemSyncStatus[]> {
  if (itemIds.length === 0) return [];

  const { rows } = await run<{
    item_id: string;
    status: ItemSyncStatus["status"];
    cursor: string | null;
    last_synced_at: Date | null;
  }>(
    client,
    `SELECT item_id, status, cursor, last_synced_at
       FROM plaid_items
      WHERE item_id = ANY($1::text[])`,
    [[...itemIds]]
  );

  return rows.map((row) => ({
    itemId: row.item_id,
    status: row.status,
    everSynced: row.cursor !== null,
    lastSyncedAt: row.last_synced_at,
  }));
}
