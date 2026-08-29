// Server-only. Plaid sync state and the transactions it produces.
//
// OPERATOR/BACKGROUND ONLY. Sync is not a request-path activity: driving it from
// a page render is the defect this milestone removes, not a pattern to preserve.
// The import-boundary suite keeps this unreachable from any action, component or
// route.
import "server-only";

import type { PoolClient } from "pg";

import { query, withTransaction } from "../pool";
import { toDatabaseError } from "../errors";
import type { SyncedTransaction } from "../../plaid-sync/engine";

export type PlaidItemStatus = "healthy" | "login_required" | "error";

export type PlaidItemRow = {
  id: string;
  item_id: string;
  cursor: string | null;
  status: PlaidItemStatus;
  last_error_code: string | null;
  last_synced_at: Date | null;
  last_cursor_at: Date | null;
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
};

export type PlaidTransactionRow = {
  id: string;
  item_id: string;
  plaid_transaction_id: string;
  plaid_account_id: string;
  amount_minor: string;
  iso_currency: string;
  posted_date: string;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  removed_at: Date | null;
  first_seen_at: Date;
  updated_at: Date;
};

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

/** Register an item, or find it. The cursor is never reset by this. */
export async function ensurePlaidItem(
  itemId: string,
  client?: PoolClient
): Promise<PlaidItemRow> {
  const inserted = await run<PlaidItemRow>(
    client,
    `INSERT INTO plaid_items (item_id)
     VALUES ($1)
     ON CONFLICT (item_id) DO NOTHING
     RETURNING *`,
    [itemId]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await run<PlaidItemRow>(
    client,
    "SELECT * FROM plaid_items WHERE item_id = $1",
    [itemId]
  );
  if (!existing.rows[0]) {
    throw new Error(`plaid item ${itemId} conflicted but could not be read`);
  }
  return existing.rows[0];
}

export async function findPlaidItem(
  itemId: string,
  client?: PoolClient
): Promise<PlaidItemRow | null> {
  const { rows } = await run<PlaidItemRow>(
    client,
    "SELECT * FROM plaid_items WHERE item_id = $1",
    [itemId]
  );
  return rows[0] ?? null;
}

export async function listPlaidItems(
  client?: PoolClient
): Promise<PlaidItemRow[]> {
  const { rows } = await run<PlaidItemRow>(
    client,
    "SELECT * FROM plaid_items ORDER BY created_at, item_id",
    []
  );
  return rows;
}

/**
 * Write a sync's changes and its cursor, ATOMICALLY.
 *
 * THIS IS THE WHOLE POINT OF THE FUNCTION. The two orderings that seem
 * reasonable are both wrong:
 *
 *   cursor first, then rows   a crash between them loses those transactions
 *                             PERMANENTLY — the next sync asks for changes after
 *                             a cursor whose data was never stored
 *   rows first, then cursor   a crash between them reprocesses on the next run,
 *                             which is survivable only because the upsert below
 *                             is idempotent — but it is still a promise resting
 *                             on the wrong thing
 *
 * One transaction, or none. A failure leaves the cursor exactly where it was and
 * the next run redoes the same work, which is safe because every write here is
 * keyed on the provider's own transaction id.
 */
export async function applySync(
  input: {
    itemId: string;
    upserts: readonly SyncedTransaction[];
    removals: readonly string[];
    cursor: string;
  },
  client?: PoolClient
): Promise<{ upserted: number; removed: number }> {
  const write = async (c: PoolClient) => {
    let upserted = 0;
    for (const transaction of input.upserts) {
      const { rowCount } = await run(
        c,
        `INSERT INTO plaid_transactions (
           item_id, plaid_transaction_id, plaid_account_id, amount_minor,
           iso_currency, posted_date, name, merchant_name, pending
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (plaid_transaction_id) DO UPDATE SET
           plaid_account_id = EXCLUDED.plaid_account_id,
           amount_minor     = EXCLUDED.amount_minor,
           iso_currency     = EXCLUDED.iso_currency,
           posted_date      = EXCLUDED.posted_date,
           name             = EXCLUDED.name,
           merchant_name    = EXCLUDED.merchant_name,
           pending          = EXCLUDED.pending,
           -- A transaction the provider sends again is present again. Without
           -- this, a retraction followed by a re-add would leave a row the
           -- provider believes in and this store treats as deleted.
           removed_at       = NULL`,
        [
          input.itemId,
          transaction.transactionId,
          transaction.accountId,
          String(transaction.amountMinor),
          transaction.isoCurrency,
          transaction.postedDate,
          transaction.name,
          transaction.merchantName,
          transaction.pending,
        ]
      );
      upserted += rowCount;
    }

    // SOFT DELETE. A retraction is a fact worth keeping: a row that vanishes
    // leaves nothing to explain why a balance changed.
    let removed = 0;
    if (input.removals.length > 0) {
      const { rowCount } = await run(
        c,
        `UPDATE plaid_transactions
            SET removed_at = now()
          WHERE plaid_transaction_id = ANY($1::text[])
            AND removed_at IS NULL`,
        [[...input.removals]]
      );
      removed = rowCount;
    }

    // The cursor moves LAST, in the same transaction as everything above.
    await run(
      c,
      `UPDATE plaid_items
          SET cursor = $2,
              last_synced_at = now(),
              last_cursor_at = now(),
              status = 'healthy',
              last_error_code = NULL,
              consecutive_failures = 0
        WHERE item_id = $1`,
      [input.itemId, input.cursor]
    );

    return { upserted, removed };
  };

  return client ? write(client) : withTransaction(write);
}

/**
 * Record that an item is not working.
 *
 * The CURSOR IS NOT TOUCHED. A failed sync must resume from exactly where the
 * last successful one stopped; moving or clearing the cursor here would either
 * skip changes or re-fetch an entire history because of a transient error.
 */
export async function recordItemFailure(
  input: {
    itemId: string;
    status: Exclude<PlaidItemStatus, "healthy">;
    errorCode: string;
  },
  client?: PoolClient
): Promise<PlaidItemRow> {
  const { rows } = await run<PlaidItemRow>(
    client,
    `UPDATE plaid_items
        SET status = $2,
            last_error_code = $3,
            consecutive_failures = consecutive_failures + 1
      WHERE item_id = $1
      RETURNING *`,
    [input.itemId, input.status, input.errorCode]
  );
  if (!rows[0]) throw new Error(`plaid item ${input.itemId} not found`);
  return rows[0];
}

/** Transactions for one account, newest first. Retracted ones excluded. */
export async function listTransactionsForAccount(
  plaidAccountId: string,
  options: { limit?: number } = {},
  client?: PoolClient
): Promise<PlaidTransactionRow[]> {
  const { rows } = await run<PlaidTransactionRow>(
    client,
    `SELECT * FROM plaid_transactions
      WHERE plaid_account_id = $1 AND removed_at IS NULL
      ORDER BY posted_date DESC, plaid_transaction_id
      LIMIT $2`,
    [plaidAccountId, options.limit ?? 100]
  );
  return rows;
}

/** Including retracted ones — for reconciliation, not for display. */
export async function findPlaidTransaction(
  plaidTransactionId: string,
  client?: PoolClient
): Promise<PlaidTransactionRow | null> {
  const { rows } = await run<PlaidTransactionRow>(
    client,
    "SELECT * FROM plaid_transactions WHERE plaid_transaction_id = $1",
    [plaidTransactionId]
  );
  return rows[0] ?? null;
}
