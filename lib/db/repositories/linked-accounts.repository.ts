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
  /** Resolved from provider data. The schema accepts only "USD". */
  currency: string;
  /**
   * Whether the metadata above came from the provider.
   *
   * FALSE means the provider was unreachable and the values are placeholders.
   * A placeholder is acceptable for a first insert (display_name is NOT NULL)
   * and NEVER acceptable as an update: overwriting a correct account name with
   * "Linked account" because Plaid happened to be down during a re-run is
   * destructive, and re-running is supposed to be safe.
   */
  metadataKnown: boolean;
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
 * NON-DESTRUCTIVE ON RE-RUN. Metadata is overwritten only when the caller says
 * it actually came from the provider (`metadataKnown`). When enrichment failed,
 * the existing row keeps every value it already had — a re-run during a Plaid
 * outage must not degrade correct data to placeholders. `id`, `created_at` and
 * the identity columns are never rewritten at all, so a customer's account
 * keeps its UUID across any number of runs.
 *
 * Only display metadata is ever updated. customer_id and external_account_id
 * are the identity of the row; a change there means the source data changed
 * underneath us, which the verify command reports rather than silently
 * absorbing.
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (customer_id, provider, external_account_id) DO UPDATE
       SET display_name =
             CASE WHEN $11 THEN EXCLUDED.display_name
                  ELSE linked_accounts.display_name END,
           official_name =
             CASE WHEN $11 THEN EXCLUDED.official_name
                  ELSE linked_accounts.official_name END,
           mask =
             CASE WHEN $11 THEN EXCLUDED.mask
                  ELSE linked_accounts.mask END,
           account_type =
             CASE WHEN $11 THEN EXCLUDED.account_type
                  ELSE linked_accounts.account_type END,
           account_subtype =
             CASE WHEN $11 THEN EXCLUDED.account_subtype
                  ELSE linked_accounts.account_subtype END,
           currency =
             CASE WHEN $11 THEN EXCLUDED.currency
                  ELSE linked_accounts.currency END,
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
      input.currency,
      input.metadataKnown,
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
