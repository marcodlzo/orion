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
import { consume } from "../services/rate-limit.service";
import { TRANSFER_BY_ACTOR } from "../rate-limit/policy";
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
 * IDEMPOTENT, as of the idempotency phase. The intent carries a client-generated
 * key, claimed in PostgreSQL and committed before Dwolla is called; a replay
 * returns the original result rather than moving money twice. This comment used
 * to say the opposite and was left behind when that landed.
 *
 * RATE LIMITED PER ACTOR, after authentication and before any work. Keying on
 * the session's identity rather than an address is what makes this limit
 * meaningful: an address is a request header and can be changed at will, while
 * the actor is resolved from the session cookie.
 *
 * This is a velocity control, NOT the solvency control. What stops a customer
 * committing more than they may is the hold taken under a row lock inside the
 * claim's transaction. This bounds how fast an authenticated session can try.
 */
export const initiateTransfer = async (
  intent: unknown
): Promise<TransferResultDTO> => {
  const actor = await requireActor();

  await consume(TRANSFER_BY_ACTOR, actor.authId);

  return executeTransfer(actor, intent);
};
