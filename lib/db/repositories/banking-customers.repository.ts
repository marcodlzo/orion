// Server-only. PostgreSQL write boundary for banking_customers.
//
// Separate from the lib/repositories directory, which holds the Appwrite ones the
// application still uses.
//
// ONE function here is on the request path: ensureBankingCustomer, called by the
// transfer service to resolve — and if necessary create — the identity bridge
// for the session's actor. The rest exist for the backfill and the verifier.
// Full runtime cutover is still a later phase.
import "server-only";

import type { PoolClient } from "pg";

import { query } from "../pool";
import { IdentityConflictError, toDatabaseError } from "../errors";

export type BankingCustomerRow = {
  id: string;
  appwrite_auth_id: string;
  appwrite_user_document_id: string;
  created_at: Date;
  updated_at: Date;
};

export type BankingCustomerInput = {
  appwriteAuthId: string;
  appwriteUserDocumentId: string;
};

/** Run against a transaction client when given one, otherwise the pool. */
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

/**
 * Insert a customer, or return the existing row if it is already there.
 *
 * IDEMPOTENT BY CONSTRUCTION. A backfill that cannot be re-run safely is a
 * one-shot operation with no recovery path: any partial failure would leave the
 * operator choosing between duplicating rows and hand-editing production data.
 *
 * ON CONFLICT targets appwrite_auth_id. The DO UPDATE is a deliberate no-op
 * write of the same value rather than DO NOTHING, because DO NOTHING returns no
 * row and the caller needs the id.
 *
 * A record whose auth id matches but whose document id DIFFERS raises
 * IdentityConflictError.
 *
 * The unique index on appwrite_user_document_id does not catch this, contrary
 * to what this comment used to claim: the conflict path never attempts to write
 * the differing value, so nothing is violated. The upsert simply kept the
 * stored bridge and reported `created: false`, and the caller had no way to
 * tell that from an ordinary re-run. A later run could then attach accounts
 * using an identity mapping the database says belongs to another document.
 */
export async function upsertBankingCustomer(
  input: BankingCustomerInput,
  client?: PoolClient
): Promise<{ row: BankingCustomerRow; created: boolean }> {
  const { rows } = await run<BankingCustomerRow & { inserted: boolean }>(
    client,
    `INSERT INTO banking_customers (appwrite_auth_id, appwrite_user_document_id)
     VALUES ($1, $2)
     ON CONFLICT (appwrite_auth_id) DO UPDATE
       SET appwrite_auth_id = EXCLUDED.appwrite_auth_id
       WHERE banking_customers.appwrite_user_document_id
             = EXCLUDED.appwrite_user_document_id
     RETURNING *, (xmax = 0) AS inserted`,
    [input.appwriteAuthId, input.appwriteUserDocumentId]
  );

  // A mismatched document id now updates NO row and returns nothing, so the
  // conflict is detected without the statement having touched the record.
  const row = rows[0];

  if (!row) {
    const existing = await run<BankingCustomerRow>(
      client,
      "SELECT * FROM banking_customers WHERE appwrite_auth_id = $1",
      [input.appwriteAuthId]
    );
    throw new IdentityConflictError({
      field: `banking_customers.appwrite_auth_id=${input.appwriteAuthId}`,
      stored: existing.rows[0]?.appwrite_user_document_id ?? "(unknown)",
      incoming: input.appwriteUserDocumentId,
    });
  }

  // xmax = 0 distinguishes a genuine INSERT from an UPDATE taken by the
  // conflict path. Without it a re-run would report every row as newly created.
  return { row, created: row.inserted };
}

/**
 * The customer for this identity, creating the bridge row on first use.
 *
 * WHY THIS EXISTS. Nothing in the application ever wrote this table — only
 * `npm run db:backfill` did. A user who signed up after the last backfill had
 * no row, and the transfer path refused them with "not enrolled for transfers
 * yet" forever. A registration flow that produces an account which cannot
 * transact is a defect, not a migration boundary.
 *
 * Callers must pass identifiers resolved from the SESSION. Nothing here can
 * check that, which is why the only caller is the transfer service immediately
 * after `requireActor()`: an identifier taken from a request body would let a
 * caller enrol as somebody else.
 *
 * Reads before writing, so the ordinary path takes no write. The upsert's
 * ON CONFLICT is a no-op UPDATE, which would fire the updated_at trigger on
 * every transfer and leave that column meaning "last transfer" rather than
 * "last identity change".
 */
export async function ensureBankingCustomer(
  input: BankingCustomerInput,
  client?: PoolClient
): Promise<{ row: BankingCustomerRow; created: boolean }> {
  const existing = await findCustomerByAuthId(input.appwriteAuthId, client);

  if (existing) {
    // READING FIRST SKIPS THE UPSERT'S COLLISION CHECK, so it is repeated here.
    // Without it the row is returned on auth id alone, and a bridge mapping
    // this login to a DIFFERENT user document would be used anyway — attaching
    // a transfer, its hold and its ledger entries to an identity the caller
    // does not correspond to.
    //
    // Not something to reconcile in passing: both values are authoritative in
    // their own store, and money must not move while which one is right is an
    // open question.
    if (existing.appwrite_user_document_id !== input.appwriteUserDocumentId) {
      throw new IdentityConflictError({
        field: `banking_customers.appwrite_auth_id=${input.appwriteAuthId}`,
        stored: existing.appwrite_user_document_id,
        incoming: input.appwriteUserDocumentId,
      });
    }
    return { row: existing, created: false };
  }

  // The gap between the read and the write is safe rather than merely unlikely:
  // two concurrent first transfers both see nothing, both insert, and the
  // unique constraint on appwrite_auth_id decides — the loser takes the
  // ON CONFLICT path and receives the winner's row instead of raising.
  return upsertBankingCustomer(input, client);
}

export async function findCustomerByAuthId(
  appwriteAuthId: string,
  client?: PoolClient
): Promise<BankingCustomerRow | null> {
  const { rows } = await run<BankingCustomerRow>(
    client,
    "SELECT * FROM banking_customers WHERE appwrite_auth_id = $1",
    [appwriteAuthId]
  );
  return rows[0] ?? null;
}

export async function findCustomerByUserDocumentId(
  appwriteUserDocumentId: string,
  client?: PoolClient
): Promise<BankingCustomerRow | null> {
  const { rows } = await run<BankingCustomerRow>(
    client,
    "SELECT * FROM banking_customers WHERE appwrite_user_document_id = $1",
    [appwriteUserDocumentId]
  );
  return rows[0] ?? null;
}

export async function countBankingCustomers(client?: PoolClient): Promise<number> {
  const { rows } = await run<{ count: string }>(
    client,
    "SELECT count(*)::text AS count FROM banking_customers",
    []
  );
  return Number(rows[0].count);
}

/** Every customer, for verification. Operator tooling only. */
export async function listBankingCustomers(
  client?: PoolClient
): Promise<BankingCustomerRow[]> {
  const { rows } = await run<BankingCustomerRow>(
    client,
    "SELECT * FROM banking_customers ORDER BY created_at, id",
    []
  );
  return rows;
}
