// Server-only. The single runtime storage boundary for bank credentials.
import "server-only";

import { randomUUID } from "node:crypto";
import { cache } from "react";

/**
 * Per-render memoisation that DEGRADES OUTSIDE A RENDER.
 *
 * `cache` exists only in React's server runtime. Next aliases `react` to that
 * build, so it is a function inside the application — but an operator script is
 * plain Node, where the standard package exports no `cache` and importing this
 * module died with "cache is not a function" before reaching any query.
 *
 * That mattered once the bank store moved to PostgreSQL: scripts that need a
 * DECRYPTED credential must come through this boundary, because it is the only
 * place decryption happens. Making them reimplement it would put a second
 * reader of the keyring in `scripts/`, which is exactly what the single-boundary
 * rule exists to prevent.
 *
 * Falling back to the function itself is correct rather than a compromise:
 * outside a request there is no request to scope a memo to, and an operator
 * script runs one pass and exits.
 */
const perRender: <T extends (...args: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? cache : (fn) => fn;

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
  listAllStoredBanks,
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

/**
 * EVERY bank, decrypted, scoped to nobody. OPERATOR TOOLING ONLY.
 *
 * `npm run plaid:sync` has to visit each Plaid Item once, and after the Phase 4
 * cutover the credentials it needs live here. It read the Appwrite collection
 * until that stopped being written, at which point the sweep silently found no
 * banks for anything linked since.
 *
 * It lives at THIS boundary rather than in the script because decryption
 * happens in exactly one place. Giving an operator script the keyring instead
 * would be a second reader of `CREDENTIAL_ENCRYPTION_KEYS`, which is the thing
 * that would let a caller get the record binding wrong and silently disable the
 * protection against a moved ciphertext.
 *
 * NEVER call this from a request path. It returns every customer's provider
 * credentials; an actor-scoped read is `getOwnedBanks`. An architecture test
 * asserts only `scripts/` reaches it.
 */
export async function listAllBanksForOperator(): Promise<BankRecord[]> {
  try {
    return (await listAllStoredBanks()).map(decryptBankRecord);
  } catch (error) {
    throw new InfrastructureError("Failed to read linked bank records", { cause: error });
  }
}

export async function getOwnedBanks(actor: Actor): Promise<BankRecord[]> {
  return readOwnedBanks(actor);
}

const readOwnedBanks = perRender(async (actor: Actor): Promise<BankRecord[]> => {
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

const readOwnedBankByDocumentId = perRender(async (
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
