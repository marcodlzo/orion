// Server-only. PostgreSQL write boundary for linked_accounts.
import "server-only";

import type { PoolClient } from "pg";

import { query } from "../pool";
import { toDatabaseError } from "../errors";

export type LinkedAccountRow = {
  id: string;
  customer_id: string;
  legacy_appwrite_bank_document_id: string | null;
  external_account_id: string;
  provider: string;
  display_name: string;
  official_name: string | null;
  mask: string | null;
  account_type: string | null;
  account_subtype: string | null;
  currency: string;
  created_at: Date;
  updated_at: Date;
};

export type LinkedAccountInput = {
  customerId: string;
  legacyAppwriteBankDocumentId: string | null;
  externalAccountId: string;
  provider: "plaid";
  displayName: string;
  officialName: string | null;
  mask: string | null;
  accountType: string | null;
  accountSubtype: string | null;
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

/**
 * Insert a linked account, or refresh its display metadata if already present.
 *
 * IDEMPOTENT. Conflict is resolved on (customer_id, provider,
 * external_account_id) — the natural key. Re-running the backfill after fixing
 * a provider outage updates the metadata it could not fetch the first time
 * rather than creating a second row.
 *
 * Only display metadata is updated on conflict. customer_id and
 * external_account_id are the identity of the row and are never rewritten; a
 * change there means the source data changed underneath us, which the verify
 * command reports rather than silently absorbing.
 *
 * Note what is absent: no accessToken, no fundingSourceUrl, no balance. Those
 * are not columns, so this cannot write them even by accident.
 */
export async function upsertLinkedAccount(
  input: LinkedAccountInput,
  client?: PoolClient
): Promise<{ row: LinkedAccountRow; created: boolean }> {
  const { rows } = await run<LinkedAccountRow & { inserted: boolean }>(
    client,
    `INSERT INTO linked_accounts (
       customer_id, legacy_appwrite_bank_document_id, external_account_id,
       provider, display_name, official_name, mask, account_type,
       account_subtype, currency
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD')
     ON CONFLICT (customer_id, provider, external_account_id) DO UPDATE
       SET display_name    = EXCLUDED.display_name,
           official_name   = EXCLUDED.official_name,
           mask            = EXCLUDED.mask,
           account_type    = EXCLUDED.account_type,
           account_subtype = EXCLUDED.account_subtype,
           legacy_appwrite_bank_document_id =
             COALESCE(linked_accounts.legacy_appwrite_bank_document_id,
                      EXCLUDED.legacy_appwrite_bank_document_id)
     RETURNING *, (xmax = 0) AS inserted`,
    [
      input.customerId,
      input.legacyAppwriteBankDocumentId,
      input.externalAccountId,
      input.provider,
      input.displayName,
      input.officialName,
      input.mask,
      input.accountType,
      input.accountSubtype,
    ]
  );

  const row = rows[0];
  return { row, created: row.inserted };
}

export async function findLinkedAccountByLegacyDocumentId(
  legacyId: string,
  client?: PoolClient
): Promise<LinkedAccountRow | null> {
  const { rows } = await run<LinkedAccountRow>(
    client,
    "SELECT * FROM linked_accounts WHERE legacy_appwrite_bank_document_id = $1",
    [legacyId]
  );
  return rows[0] ?? null;
}

export async function countLinkedAccounts(client?: PoolClient): Promise<number> {
  const { rows } = await run<{ count: string }>(
    client,
    "SELECT count(*)::text AS count FROM linked_accounts",
    []
  );
  return Number(rows[0].count);
}

/** Every linked account, for verification. Operator tooling only. */
export async function listLinkedAccounts(
  client?: PoolClient
): Promise<LinkedAccountRow[]> {
  const { rows } = await run<LinkedAccountRow>(
    client,
    "SELECT * FROM linked_accounts ORDER BY created_at, id",
    []
  );
  return rows;
}
