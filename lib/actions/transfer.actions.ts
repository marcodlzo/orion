"use server";

// The only money-movement endpoint.
//
// It replaces four browser-callable actions that together let the caller name
// arbitrary funding sources, move money between them, and then write whatever
// transaction record they liked:
//
//   getBankForLegacyTransfer              returned the sender's credentials
//   getCounterpartyBankForLegacyTransfer  returned the recipient's credentials
//   createTransfer                        accepted both funding-source URLs
//   createTransaction                     accepted both parties and the amount
//
// The browser now submits an intent and receives a narrow result. It never
// holds a provider capability.

import { requireActor } from "../auth/actor";
import { executeTransfer } from "../services/transfers.service";
import type { TransferResultDTO } from "../dto/transfer.dto";

/**
 * PROTECTED — authenticate, then hand the intent to the server-owned
 * orchestrator.
 *
 * The parameter is typed `unknown` on purpose. This is a public POST endpoint;
 * whatever arrives is untrusted until the service's server-side schema has
 * validated it. A typed parameter here would describe an expectation, not
 * enforce one.
 *
 * NOT IDEMPOTENT. Two calls create two transfers. Disabling the submit button
 * is UX, not a guarantee — a retry, a second tab, or a replayed request still
 * duplicates the money movement. That is the idempotency milestone.
 */
export const initiateTransfer = async (
  intent: unknown
): Promise<TransferResultDTO> => {
  const actor = await requireActor();

  return executeTransfer(actor, intent);
};
