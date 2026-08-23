"use server";

// Only createTransaction remains a server action: it is invoked directly from
// PaymentTransferForm.tsx, a client component.
//
// It is currently unauthenticated and unvalidated, which means transaction
// history can be fabricated by any caller. That is catalogued and addressed by
// the authorization milestone; nothing about its behaviour changes here.
//
// getTransactionsByBankId was never called from a client component and now
// lives in lib/server/transactions.ts.

import { ID } from "node-appwrite";

import { createAdminClient } from "../appwrite";
import { parseStringify } from "../utils";
import { requireActor } from "../auth/actor";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_TRANSACTION_COLLECTION_ID: TRANSACTION_COLLECTION_ID,
} = process.env;

/**
 * PROTECTED — authenticated, NOT yet authorized.
 *
 * An anonymous caller can no longer write transaction records. That closes the
 * unauthenticated-write hole.
 *
 * STILL VULNERABLE: every field is taken from the caller, including senderId,
 * receiverId, senderBankId, receiverBankId and amount. An authenticated user
 * can still fabricate history naming any two parties. Deriving the sender from
 * the actor and validating the rest belongs to the ownership and transfer
 * phases.
 */
export const createTransaction = async (transaction: CreateTransactionProps) => {
  try {
    await requireActor();

    const { database } = await createAdminClient();

    const newTransaction = await database.createDocument(
      DATABASE_ID!,
      TRANSACTION_COLLECTION_ID!,
      ID.unique(),
      {
        channel: 'online',
        category: 'Transfer',
        ...transaction
      }
    )

    return parseStringify(newTransaction);
  } catch (error) {
    console.log(error);
  }
}
