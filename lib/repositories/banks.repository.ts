// Server-only. The single runtime storage boundary for bank credentials.
import "server-only";

import { randomUUID } from "node:crypto";
import { cache } from "react";

import type { Actor } from "../auth/actor";
import { InfrastructureError } from "../auth/errors";
import { decryptCredential, encryptCredential } from "../crypto/envelope";
import { withTransaction } from "../db/pool";
import { ensureBankingCustomer } from "../db/repositories/banking-customers.repository";
import {
  findOwnedStoredBankByAccountId,
  findOwnedStoredBankByPublicId,
  findStoredCounterpartyByAccountId,
  insertStoredBank,
  listOwnedStoredBanks,
  type StoredBankRow,
} from "../db/repositories/bank-records.repository";

export type BankRecord = {
  $id: string;
  accountId: string;
  bankId: string;
  accessToken: string;
  fundingSourceUrl: string;
  shareableId: string;
  userId: unknown;
} & Record<string, unknown>;

function decryptBankRecord(row: StoredBankRow): BankRecord {
  return {
    $id: row.public_id,
    accountId: row.external_account_id,
    bankId: row.provider_item_id,
    accessToken: decryptCredential(row.access_token, {
      recordId: row.credential_id,
      field: "accessToken",
    }),
    fundingSourceUrl: decryptCredential(row.funding_source_url, {
      recordId: row.credential_id,
      field: "fundingSourceUrl",
    }),
    shareableId: row.shareable_id,
    userId: { $id: row.owner_user_document_id },
  };
}

export async function getOwnedBanks(actor: Actor): Promise<BankRecord[]> {
  return readOwnedBanks(actor);
}

const readOwnedBanks = cache(async (actor: Actor): Promise<BankRecord[]> => {
  try {
    return (await listOwnedStoredBanks(actor)).map(decryptBankRecord);
  } catch (error) {
    throw new InfrastructureError("Failed to read linked bank records", { cause: error });
  }
});

export async function getOwnedBankByDocumentId(
  actor: Actor,
  documentId: string
): Promise<BankRecord | null> {
  return readOwnedBankByDocumentId(actor, documentId);
}

const readOwnedBankByDocumentId = cache(async (
  actor: Actor,
  documentId: string
): Promise<BankRecord | null> => {
  if (!documentId) return null;
  try {
    const row = await findOwnedStoredBankByPublicId(actor, documentId);
    return row ? decryptBankRecord(row) : null;
  } catch (error) {
    throw new InfrastructureError("Failed to read the linked bank record", { cause: error });
  }
});

export async function getOwnedBankByAccountId(
  actor: Actor,
  accountId: string
): Promise<BankRecord | null> {
  if (!accountId) return null;
  try {
    const row = await findOwnedStoredBankByAccountId(actor, accountId);
    return row ? decryptBankRecord(row) : null;
  } catch (error) {
    throw new InfrastructureError("Failed to read the linked bank record", { cause: error });
  }
}

/** Counterparty lookup is intentionally unowned; ambiguous ids resolve null. */
export async function findCounterpartyBankByAccountId(
  accountId: string
): Promise<BankRecord | null> {
  if (!accountId) return null;
  try {
    const row = await findStoredCounterpartyByAccountId(accountId);
    return row ? decryptBankRecord(row) : null;
  } catch (error) {
    throw new InfrastructureError("Failed to resolve the counterparty bank", { cause: error });
  }
}

export async function createBankForActor(
  actor: Actor,
  input: {
    bankId: string;
    accountId: string;
    accessToken: string;
    fundingSourceUrl: string;
    shareableId: string;
    displayName: string;
    officialName: string | null;
    mask: string | null;
    accountType: string;
    accountSubtype: string | null;
  }
): Promise<BankRecord> {
  const linkedAccountId = randomUUID();
  const credentialId = randomUUID();

  try {
    return await withTransaction(async (client) => {
      const { row: customer } = await ensureBankingCustomer(
        { appwriteAuthId: actor.authId, appwriteUserDocumentId: actor.userId },
        client
      );
      const stored = await insertStoredBank(
        {
          ...input,
          itemId: input.bankId,
          linkedAccountId,
          credentialId,
          customerId: customer.id,
          accessToken: encryptCredential(input.accessToken, {
            recordId: credentialId,
            field: "accessToken",
          }),
          fundingSourceUrl: encryptCredential(input.fundingSourceUrl, {
            recordId: credentialId,
            field: "fundingSourceUrl",
          }),
        },
        client
      );
      return decryptBankRecord(stored);
    });
  } catch (error) {
    throw new InfrastructureError("Failed to create the linked bank record", { cause: error });
  }
}
