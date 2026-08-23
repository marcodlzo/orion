// Server-only. Reads raw transaction documents via the admin client. Consumed
// by lib/server/banks.ts only; never called from a client component, so it is
// not a server action.
//
// Moved verbatim from lib/actions/transaction.actions.ts. Behaviour is
// unchanged, including the unpaginated reads, which are catalogued as a defect
// and addressed by a later milestone rather than here.
import "server-only";

import { Query } from "node-appwrite";

import { createAdminClient } from "../appwrite";
import { parseStringify } from "../utils";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_TRANSACTION_COLLECTION_ID: TRANSACTION_COLLECTION_ID,
} = process.env;

export const getTransactionsByBankId = async ({bankId}: getTransactionsByBankIdProps) => {
  try {
    const { database } = await createAdminClient();

    const senderTransactions = await database.listDocuments(
      DATABASE_ID!,
      TRANSACTION_COLLECTION_ID!,
      [Query.equal('senderBankId', bankId)],
    )

    const receiverTransactions = await database.listDocuments(
      DATABASE_ID!,
      TRANSACTION_COLLECTION_ID!,
      [Query.equal('receiverBankId', bankId)],
    );

    const transactions = {
      total: senderTransactions.total + receiverTransactions.total,
      documents: [
        ...senderTransactions.documents,
        ...receiverTransactions.documents,
      ]
    }

    return parseStringify(transactions);
  } catch (error) {
    console.log(error);
  }
}
