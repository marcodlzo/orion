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

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_TRANSACTION_COLLECTION_ID: TRANSACTION_COLLECTION_ID,
} = process.env;

export const createTransaction = async (transaction: CreateTransactionProps) => {
  try {
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
