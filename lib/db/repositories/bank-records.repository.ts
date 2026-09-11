// Server-only. Raw PostgreSQL persistence for linked banks and ciphertext.
import "server-only";

import type { PoolClient } from "pg";
import type { Actor } from "../../auth/actor";
import { query } from "../pool";
import { toDatabaseError } from "../errors";

export type StoredBankRow = {
  linked_account_id: string;
  credential_id: string;
  public_id: string;
  owner_user_document_id: string;
  external_account_id: string;
  provider_item_id: string;
  shareable_id: string;
  access_token: string;
  funding_source_url: string;
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

const SELECT = `SELECT
  a.id AS linked_account_id,
  k.id AS credential_id,
  COALESCE(a.legacy_appwrite_bank_document_id, a.id::text) AS public_id,
  c.appwrite_user_document_id AS owner_user_document_id,
  a.external_account_id,
  a.provider_item_id,
  a.shareable_id,
  k.access_token,
  k.funding_source_url
FROM linked_accounts a
JOIN banking_customers c ON c.id = a.customer_id
JOIN linked_account_credentials k ON k.linked_account_id = a.id`;

const ownership = `c.appwrite_auth_id = $1
  AND c.appwrite_user_document_id = $2`;

export async function listOwnedStoredBanks(actor: Actor): Promise<StoredBankRow[]> {
  const { rows } = await run<StoredBankRow>(
    undefined,
    `${SELECT} WHERE ${ownership} ORDER BY a.created_at, a.id`,
    [actor.authId, actor.userId]
  );
  return rows;
}

export async function findOwnedStoredBankByPublicId(
  actor: Actor,
  publicId: string
): Promise<StoredBankRow | null> {
  const { rows } = await run<StoredBankRow>(
    undefined,
    `${SELECT} WHERE ${ownership}
       AND COALESCE(a.legacy_appwrite_bank_document_id, a.id::text) = $3
     LIMIT 1`,
    [actor.authId, actor.userId, publicId]
  );
  return rows[0] ?? null;
}

export async function findOwnedStoredBankByAccountId(
  actor: Actor,
  accountId: string
): Promise<StoredBankRow | null> {
  const { rows } = await run<StoredBankRow>(
    undefined,
    `${SELECT} WHERE ${ownership} AND a.external_account_id = $3 LIMIT 1`,
    [actor.authId, actor.userId, accountId]
  );
  return rows[0] ?? null;
}

export async function findStoredCounterpartyByAccountId(
  accountId: string
): Promise<StoredBankRow | null> {
  const { rows } = await run<StoredBankRow>(
    undefined,
    `${SELECT} WHERE a.external_account_id = $1 ORDER BY a.id LIMIT 2`,
    [accountId]
  );
  return rows.length === 1 ? rows[0] : null;
}

export async function insertStoredBank(
  input: {
    linkedAccountId: string;
    credentialId: string;
    customerId: string;
    accountId: string;
    itemId: string;
    shareableId: string;
    accessToken: string;
    fundingSourceUrl: string;
    displayName: string;
    officialName: string | null;
    mask: string | null;
    accountType: string;
    accountSubtype: string | null;
  },
  client: PoolClient
): Promise<StoredBankRow> {
  await run(
    client,
    `INSERT INTO linked_accounts (
       id, customer_id, legacy_appwrite_bank_document_id, external_account_id,
       provider, provider_item_id, shareable_id, display_name, official_name,
       mask, account_type, account_subtype, currency
     ) VALUES ($1, $2, NULL, $3, 'plaid', $4, $5, $6, $7, $8, $9, $10, 'USD')`,
    [
      input.linkedAccountId, input.customerId, input.accountId, input.itemId,
      input.shareableId, input.displayName, input.officialName, input.mask,
      input.accountType, input.accountSubtype,
    ]
  );
  await run(
    client,
    `INSERT INTO linked_account_credentials
       (id, linked_account_id, access_token, funding_source_url)
     VALUES ($1, $2, $3, $4)`,
    [input.credentialId, input.linkedAccountId, input.accessToken, input.fundingSourceUrl]
  );

  const { rows } = await run<StoredBankRow>(
    client,
    `${SELECT} WHERE a.id = $1`,
    [input.linkedAccountId]
  );
  return rows[0];
}
