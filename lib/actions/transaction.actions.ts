"use server";

import { requireActor } from "../auth/actor";
import { getOwnedBankByDocumentId } from "../repositories/banks.repository";
import { NotFoundError } from "../repositories/errors";
import { createTransactionRecord } from "../repositories/transactions.repository";
import { parseStringify } from "../utils";

/**
 * PROTECTED — partially hardened.
 *
 * WHAT IS NOW ENFORCED
 *  - the caller is authenticated
 *  - `senderBankId` must be a bank the actor actually owns; otherwise
 *    NotFoundError and nothing is written
 *  - `senderId` is derived from the session and the caller's value is ignored,
 *    so a record cannot claim somebody else sent the money
 *
 * WHAT IS STILL BROKEN — do not read the checks above as "safe"
 *  - `receiverId`, `receiverBankId`, `amount` and `name` are still whatever the
 *    caller sends
 *  - nothing ties this record to an actual money movement. An authenticated
 *    user can still call this directly and fabricate history crediting or
 *    debiting a counterparty, provided they name one of their own banks as the
 *    sender
 *  - `amount` remains a string, and no ledger entry is produced
 *
 * The real fix is not another check here. It is deleting this endpoint and
 * writing the record inside a server-owned transfer, which is the
 * orchestration phase.
 */
export const createTransaction = async (transaction: CreateTransactionProps) => {
  const actor = await requireActor();

  // The sending side must belong to the caller.
  const senderBank = await getOwnedBankByDocumentId(actor, transaction.senderBankId);
  if (!senderBank) throw new NotFoundError("Sender bank not found");

  const created = await createTransactionRecord({
    ...transaction,
    // Session wins over anything the caller supplied.
    senderId: actor.userId,
    senderBankId: senderBank.$id,
  });

  return parseStringify(created);
}
