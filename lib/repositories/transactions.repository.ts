// Server-only. Approved home for createAdminClient.
import "server-only";

import { ID, Query } from "node-appwrite";

import type { Actor } from "../auth/actor";
import { createAdminClient } from "../appwrite";
import { InfrastructureError } from "../auth/errors";
import { toDecimalString, type Money } from "../domain/money";
import { getOwnedBankByDocumentId } from "./banks.repository";
import { NotFoundError } from "./errors";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_TRANSACTION_COLLECTION_ID: TRANSACTION_COLLECTION_ID,
} = process.env;

/**
 * TRANSITIONAL — how Money is written through the existing Appwrite schema.
 *
 * The transaction collection's `amount` is a String attribute holding a decimal
 * like "25.00". That is the legacy shape and this phase does not migrate it;
 * changing an Appwrite attribute type requires a console migration and would
 * rewrite existing rows.
 *
 * The domain is NOT shaped by that constraint. Money stays integer minor units
 * everywhere inside the application, and this single function is the only place
 * it degrades to a decimal string. When PostgreSQL becomes the banking store it
 * will hold canonical minor units and this adapter disappears.
 *
 * Uses the exact formatter, so no float is involved in producing it.
 */
export function toLegacyTransactionAmount(money: Money): string {
  return toDecimalString(money);
}

export type TransactionRecord = {
  $id: string;
  $createdAt: string;
  name: string;
  /** DEFECT (not this phase): money stored as a string, not integer minor units. */
  amount: string;
  channel: string;
  category: string;
  senderId: string;
  senderBankId: string;
  receiverId: string;
  receiverBankId: string;
  email: string;
} & Record<string, unknown>;

/**
 * OWNED — transactions for a bank the actor owns.
 *
 * Ownership is proven BEFORE the transaction query runs. If the bank is not the
 * actor's, this throws and the transaction collection is never touched — a
 * caller cannot use a failed lookup to infer anything about another user's
 * history. A collaborator-ordering test pins that.
 *
 * The transaction rows themselves are matched on bank id in both directions,
 * because a bank appears as sender on some rows and receiver on others.
 *
 * @throws NotFoundError        bank missing or not owned
 * @throws InfrastructureError  datastore unreachable
 */
export async function getTransactionsForOwnedBank(
  actor: Actor,
  bankId: string
): Promise<{ total: number; documents: TransactionRecord[] }> {
  const bank = await getOwnedBankByDocumentId(actor, bankId);
  if (!bank) {
    throw new NotFoundError("Bank not found");
  }

  try {
    const { database } = await createAdminClient();

    const [sent, received] = await Promise.all([
      database.listDocuments(DATABASE_ID!, TRANSACTION_COLLECTION_ID!, [
        Query.equal("senderBankId", bankId),
      ]),
      database.listDocuments(DATABASE_ID!, TRANSACTION_COLLECTION_ID!, [
        Query.equal("receiverBankId", bankId),
      ]),
    ]);

    // DEFECT (not this phase): both reads are unpaginated, so Appwrite's
    // default page size silently caps the result while `total` reports the
    // true count. Pagination belongs with the ledger work.
    return {
      total: sent.total + received.total,
      documents: [
        ...sent.documents,
        ...received.documents,
      ] as unknown as TransactionRecord[],
    };
  } catch (error) {
    throw new InfrastructureError("Failed to read the transaction collection", {
      cause: error,
    });
  }
}

/**
 * Write a transaction record.
 *
 * The caller is responsible for having proven that the actor owns the sending
 * side. This does not and cannot validate the counterparty fields.
 *
 * DEFECT (not this phase): receiverId and receiverBankId are still whatever the
 * caller supplied, and nothing ties this record to an actual money movement, so
 * history remains forgeable by an authenticated user. Both are fixed by moving
 * transaction creation inside a server-owned transfer, which is the
 * orchestration phase.
 */
export async function createTransactionRecord(
  data: Record<string, unknown>
): Promise<TransactionRecord> {
  try {
    const { database } = await createAdminClient();
    const created = await database.createDocument(
      DATABASE_ID!,
      TRANSACTION_COLLECTION_ID!,
      ID.unique(),
      { channel: "online", category: "Transfer", ...data }
    );
    return created as unknown as TransactionRecord;
  } catch (error) {
    throw new InfrastructureError("Failed to create the transaction record", {
      cause: error,
    });
  }
}
