// Server-only. OPERATOR TOOLING — seeds a customer's opening ledger balance.
//
// ============================== READ THIS ==============================
// This module CREATES MONEY in the ledger. Nothing else in the application
// does. It is an operator action, run deliberately, and it must never be
// reachable from a request path — an architecture test enforces that.
//
// WHAT IT IS NOT. It is not a deposit, and it must never be described as one.
// A Plaid balance says what the EXTERNAL bank holds for that customer; it is
// not money Orion received. Crediting the ledger with it as though a deposit
// occurred would be the exact class of lie this project exists to avoid.
//
// What it IS: an explicit opening allocation, booked against an equity account,
// carrying the snapshot it came from, and distinguishable forever by its
// transaction kind. When real funding exists — a confirmed inbound transfer —
// it uses the same source-reference mechanism with a provider reference, and a
// reconciler can tell the two apart without guessing.
//
// See docs/adr/0002-cutover-accounting-model.md.
// =======================================================================
import "server-only";

import type { TransactionClient } from "../db/pool";
import {
  ensureCustomerAccount,
  ensureOpeningEquityAccount,
  postTransaction,
} from "../db/repositories/ledger.repository";

export type OpeningAllocation = {
  customerId: string;
  /** Exact integer minor units. Never a float, at any point in this path. */
  amountMinor: number;
  /**
   * The reviewed snapshot this came from.
   *
   * Durable and unique. A unique index refuses a second posting with the same
   * reference, so a re-run cannot double-credit somebody — the database
   * decides, not the control flow below.
   */
  sourceReference: string;
};

export type AllocationOutcome =
  | { kind: "posted"; transactionId: string }
  /** This exact source has already been allocated. Not an error; a re-run. */
  | { kind: "already-allocated" };

/**
 * Credit a customer's opening balance, once.
 *
 * The equity account takes the matching debit, so entries sum to zero and the
 * settlement account is untouched. Mixing seeded capital into settlement would
 * destroy the one balance whose job is to say how much is genuinely in flight.
 */
export async function allocateOpening(
  input: OpeningAllocation,
  client: TransactionClient
): Promise<AllocationOutcome> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    // A zero allocation posts nothing and a negative one is a withdrawal
    // wearing the wrong name. Both are refused rather than interpreted.
    throw new Error("An opening allocation must be a positive integer amount");
  }
  if (!input.sourceReference.trim()) {
    throw new Error("An opening allocation must name its source");
  }

  const existing = await client.query(
    "SELECT id FROM ledger_transactions WHERE source_reference = $1",
    [input.sourceReference]
  );
  if (existing.rows[0]) return { kind: "already-allocated" };

  const customer = await ensureCustomerAccount(input.customerId, client);
  const equity = await ensureOpeningEquityAccount(client);

  const { transactionId } = await postTransaction(
    {
      description: `opening allocation ${input.sourceReference}`,
      kind: "opening_allocation",
      sourceReference: input.sourceReference,
      lines: [
        { accountId: customer.id, amountMinor: input.amountMinor },
        { accountId: equity.id, amountMinor: -input.amountMinor },
      ],
    },
    client
  );

  return { kind: "posted", transactionId };
}
