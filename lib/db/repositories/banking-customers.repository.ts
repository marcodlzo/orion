// Server-only. PostgreSQL write boundary for banking_customers.
//
// Separate from the lib/repositories directory, which holds the Appwrite ones the
// application still uses. Nothing in the application calls these yet — they
// exist for the backfill. Runtime cutover is a later phase.
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
