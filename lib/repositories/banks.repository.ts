// Server-only. Approved home for createAdminClient.
import "server-only";

import { ID, Query } from "node-appwrite";

import type { Actor } from "../auth/actor";
import { createAdminClient } from "../appwrite";
import { InfrastructureError } from "../auth/errors";
import {
  decryptCredential,
  encryptCredential,
  isEncrypted,
} from "../crypto/envelope";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

/**
 * A bank-collection document, AS THE APPLICATION SEES IT.
 *
 * `accessToken` and `fundingSourceUrl` are plaintext HERE AND ONLY HERE — in
 * memory, after this module decrypted them. At rest they are AES-256-GCM
 * ciphertext bound to the record they belong to.
 *
 * The type is unchanged on purpose. Every caller already treats these two fields
 * as credentials that must not cross to the browser, and making them a different
 * type would have meant touching every one of those call sites to gain nothing:
 * the protection is that the plaintext no longer exists at rest, not that it is
 * spelled differently in memory.
 */
export type BankRecord = {
  $id: string;
  accountId: string;
  bankId: string;
  accessToken: string;
  fundingSourceUrl: string;
  shareableId: string;
  /**
   * Appwrite relationship to the user document. Reads back as the related
   * document, not a string, which is why it is not typed as one — the ambient
   * `Bank` type claims `userId: string` and is wrong about it.
   */
  userId: unknown;
} & Record<string, unknown>;

/**
 * OWNERSHIP MODEL — read this before changing a query in this file.
 *
 * The bank collection's `userId` is an Appwrite relationship pointing at a USER
 * DOCUMENT, so it holds USER.$id.
 *
 * The user document ALSO has a field literally named `userId`, and that one
 * holds the Appwrite AUTH ACCOUNT id.
 *
 * Actor carries both: `actor.userId` is USER.$id, `actor.authId` is the auth
 * account id.
 *
 * Bank ownership therefore compares against actor.userId. Using actor.authId
 * would not error — it would silently match nothing, which reads as "user has
 * no banks" rather than as a bug. A regression test pins this specifically.
 */
const ownedBy = (actor: Actor) => Query.equal("userId", [actor.userId]);

/**
 * Decrypt the two credential fields on a stored document.
 *
 * TOLERATES PLAINTEXT, DELIBERATELY AND TEMPORARILY. Records written before the
 * encryption backfill still hold plaintext, and refusing to read them would take
 * every existing user's account down at deploy time rather than at migration
 * time. `scripts/encrypt-credentials.ts` converts them, and
 * `npm run credentials:verify` reports how many remain — the number that must
 * reach zero before this tolerance is removed.
 *
 * It is NOT a fallback for a decryption failure. A value that IS encrypted and
 * fails to decrypt raises, because that means a wrong key, a tampered store, or
 * a ciphertext moved between records — and quietly returning it would hand the
 * caller ciphertext to use as a token.
 */
function decryptBankRecord(document: unknown): BankRecord {
  const record = document as BankRecord;

  const read = (field: "accessToken" | "fundingSourceUrl"): string => {
    const stored = record[field];
    if (typeof stored !== "string" || stored === "") return "";
    if (!isEncrypted(stored)) return stored;
    return decryptCredential(stored, { recordId: record.$id, field });
  };

  return {
    ...record,
    accessToken: read("accessToken"),
    fundingSourceUrl: read("fundingSourceUrl"),
  };
}

/**
 * OWNED — every bank belonging to the authenticated actor.
 *
 * Takes no user identifier. There is deliberately no way to ask for somebody
 * else's list.
 */
export async function getOwnedBanks(actor: Actor): Promise<BankRecord[]> {
  try {
    const { database } = await createAdminClient();
    const result = await database.listDocuments(DATABASE_ID!, BANK_COLLECTION_ID!, [
      ownedBy(actor),
    ]);
    return result.documents.map(decryptBankRecord);
  } catch (error) {
    throw new InfrastructureError("Failed to read the bank collection", { cause: error });
  }
}

/**
 * OWNED — one bank belonging to the actor, by document id.
 *
 * The ownership predicate is part of the query, not a comparison performed
 * after fetching. A record the actor does not own is never loaded into memory,
 * so it cannot be leaked by a later refactor that forgets the check.
 *
 * @returns the record, or null when it does not exist OR is not owned. The
 *          caller must not distinguish the two.
 */
export async function getOwnedBankByDocumentId(
  actor: Actor,
  documentId: string
): Promise<BankRecord | null> {
  if (!documentId) return null;

  try {
    const { database } = await createAdminClient();
    const result = await database.listDocuments(DATABASE_ID!, BANK_COLLECTION_ID!, [
      Query.equal("$id", [documentId]),
      ownedBy(actor),
    ]);
    return result.documents[0] ? decryptBankRecord(result.documents[0]) : null;
  } catch (error) {
    throw new InfrastructureError("Failed to read the bank collection", { cause: error });
  }
}

/**
 * OWNED — one bank belonging to the actor, by Plaid account id.
 *
 * Use this for the actor's own accounts. For addressing somebody else's account
 * as a transfer recipient, use findCounterpartyBankByAccountId and read the
 * warning attached to it.
 */
export async function getOwnedBankByAccountId(
  actor: Actor,
  accountId: string
): Promise<BankRecord | null> {
  if (!accountId) return null;

  try {
    const { database } = await createAdminClient();
    const result = await database.listDocuments(DATABASE_ID!, BANK_COLLECTION_ID!, [
      Query.equal("accountId", [accountId]),
      ownedBy(actor),
    ]);
    return result.documents[0] ? decryptBankRecord(result.documents[0]) : null;
  } catch (error) {
    throw new InfrastructureError("Failed to read the bank collection", { cause: error });
  }
}

/**
 * COUNTERPARTY — deliberately NOT ownership scoped.
 *
 * Resolving a transfer recipient means reading a bank the actor does not own;
 * that is the whole point of paying somebody. Scoping this by ownership would
 * break transfers, so the exception is named rather than hidden.
 *
 * RESIDUAL RISK, unresolved in this phase:
 *  - it returns the full record, including the recipient's Plaid access token
 *    and Dwolla funding-source URL. Narrowing the response is the DTO phase.
 *  - `accountId` reaches it from the browser, decoded from a "shareable id"
 *    that is only base64. Any authenticated user can decode a shared id and
 *    call this. Removing the browser's need to resolve a recipient at all is
 *    the transfer-orchestration phase.
 *
 * Do not treat the existence of this function as approval to add more
 * unscoped lookups.
 */
export async function findCounterpartyBankByAccountId(
  accountId: string
): Promise<BankRecord | null> {
  if (!accountId) return null;

  try {
    const { database } = await createAdminClient();
    const result = await database.listDocuments(DATABASE_ID!, BANK_COLLECTION_ID!, [
      Query.equal("accountId", [accountId]),
    ]);
    // Preserved from the original implementation: an ambiguous match resolves
    // to nothing rather than picking one arbitrarily.
    if (result.total !== 1) return null;
    return result.documents[0] ? decryptBankRecord(result.documents[0]) : null;
  } catch (error) {
    throw new InfrastructureError("Failed to read the bank collection", { cause: error });
  }
}

/**
 * OWNED WRITE — link a bank to the authenticated actor.
 *
 * The owner is taken from the actor, never from the caller. Previously the
 * browser supplied the user id and could file a bank under another account.
 */
export async function createBankForActor(
  actor: Actor,
  input: {
    bankId: string;
    accountId: string;
    accessToken: string;
    fundingSourceUrl: string;
    shareableId: string;
  }
): Promise<BankRecord> {
  // THE ID IS GENERATED HERE, BEFORE THE WRITE, because the ciphertext is bound
  // to it. Letting the store assign one would mean encrypting against an id that
  // does not exist yet, and binding to nothing is the same as not binding.
  const documentId = ID.unique();

  try {
    const { database } = await createAdminClient();
    const created = await database.createDocument(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      documentId,
      {
        userId: actor.userId,
        ...input,
        // ENCRYPTED AT REST. Possession of a funding-source URL is sufficient to
        // move money and an access token grants read access to the account, so
        // neither may sit in plaintext in a document store — where a backup, a
        // console session or a leaked admin key exposes every one of them at
        // once.
        accessToken: encryptCredential(input.accessToken, {
          recordId: documentId,
          field: "accessToken",
        }),
        fundingSourceUrl: encryptCredential(input.fundingSourceUrl, {
          recordId: documentId,
          field: "fundingSourceUrl",
        }),
      }
    );

    // Returned decrypted, so the caller sees what it passed in rather than
    // having to know this happened.
    return { ...(created as unknown as BankRecord), ...input };
  } catch (error) {
    throw new InfrastructureError("Failed to create the bank record", { cause: error });
  }
}
