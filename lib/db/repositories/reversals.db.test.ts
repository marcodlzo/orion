import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query, withTransaction } from "../pool";
import { ConstraintViolationError } from "../errors";
import { requireTestDatabase } from "../test-database";
import { upsertBankingCustomer } from "./banking-customers.repository";
import {
  claimTransfer,
  markSubmitted,
  markTerminal,
  markReversed,
  transitionsForTransfer,
} from "./transfers.repository";
import {
  ensureCustomerAccount,
  ensureSettlementAccount,
  entriesForTransaction,
  entriesForTransfer,
  findReversalOf,
  findSettlementPosting,
  postTransaction,
  reverseTransaction,
  totalAcrossAllAccounts,
} from "./ledger.repository";

/**
 * REVERSALS AND THE AUDIT TRAIL, AGAINST A REAL SERVER.
 *
 * The invariant under test is COMPENSATION: a reversal creates new opposing
 * entries and never mutates or removes the originals. That is not enforced by
 * politeness — the entry triggers make an edit impossible — so these assert both
 * that compensation happens AND that the originals are untouched afterwards.
 */

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

async function expectRejectedBy(
  promise: Promise<unknown>,
  sqlState: string
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ConstraintViolationError);
  const error = await promise.catch((e: unknown) => e);
  expect((error as ConstraintViolationError).sqlState).toBe(sqlState);
}

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query(
    `TRUNCATE transfer_state_transitions, ledger_holds, ledger_entries,
              ledger_transactions, ledger_accounts, provider_webhook_events,
              transfers, linked_accounts, banking_customers CASCADE`
  );
});

/** A transfer that has settled, with its balanced posting on the ledger. */
async function settledTransfer(amountMinor = 100_00) {
  const { row: customer } = await upsertBankingCustomer({
    appwriteAuthId: `auth-${randomUUID()}`,
    appwriteUserDocumentId: `doc-${randomUUID()}`,
  });

  const claim = await claimTransfer({
    customerId: customer.id,
    idempotencyKey: randomUUID(),
    requestFingerprint: `fp-${randomUUID()}`,
    amountMinor,
    currency: "USD",
  });
  const transferId = claim.row.id;

  await markSubmitted({ transferId, providerTransferId: `xfer-${randomUUID()}` });
  await markTerminal({ transferId, outcome: "settled" });

  const posting = await withTransaction(async (client) => {
    const account = await ensureCustomerAccount(customer.id, client);
    const settlement = await ensureSettlementAccount(client);
    return postTransaction(
      {
        description: `transfer ${transferId} settled`,
        transferId,
        lines: [
          { accountId: account.id, amountMinor: -amountMinor },
          { accountId: settlement.id, amountMinor },
        ],
      },
      client
    );
  });

  const account = await ensureCustomerAccount(customer.id);
  const settlement = await ensureSettlementAccount();

  return {
    transferId,
    amountMinor,
    accountId: account.id,
    settlementId: settlement.id,
    transactionId: posting.transactionId,
  };
}

const balance = async (accountId: string) => {
  const { rows } = await query<{ balance: string }>(
    `SELECT COALESCE(sum(amount_minor), 0)::text AS balance
       FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return Number(rows[0].balance);
};

describe("INVARIANT: compensation", () => {
  it("creates opposing entries and leaves the originals untouched", async () => {
    const t = await settledTransfer(100_00);

    const originalEntries = await entriesForTransaction(t.transactionId);
    expect(originalEntries).toHaveLength(2);
    const originalIds = originalEntries.map((e) => e.id).sort();

    const reversal = await withTransaction((c) =>
      reverseTransaction(
        { transactionId: t.transactionId, description: "returned" },
        c
      )
    );
    expect(reversal).not.toBeNull();

    // The originals are BYTE-FOR-BYTE the same rows: same ids, same amounts.
    const afterOriginals = await entriesForTransaction(t.transactionId);
    expect(afterOriginals.map((e) => e.id).sort()).toEqual(originalIds);
    expect(afterOriginals.map((e) => e.amount_minor).sort()).toEqual(
      originalEntries.map((e) => e.amount_minor).sort()
    );

    // And a NEW posting exists that opposes them exactly.
    const reversalEntries = await entriesForTransaction(reversal!.transactionId);
    expect(reversalEntries).toHaveLength(2);
    expect(reversalEntries.map((e) => Number(e.amount_minor)).sort((a, b) => a - b))
      .toEqual([-100_00, 100_00]);

    // Four entries for this transfer now: two that happened, two that undid it.
    expect(await entriesForTransfer(t.transferId)).toHaveLength(4);
  });

  it("restores every balance it touched", async () => {
    const t = await settledTransfer(250_00);

    expect(await balance(t.accountId)).toBe(-250_00);
    expect(await balance(t.settlementId)).toBe(250_00);

    await withTransaction((c) =>
      reverseTransaction({ transactionId: t.transactionId, description: "r" }, c)
    );

    expect(await balance(t.accountId)).toBe(0);
    expect(await balance(t.settlementId)).toBe(0);

    // CONSERVATION holds throughout: reversal moves money back, it does not
    // create or destroy any.
    expect(await totalAcrossAllAccounts()).toBe(0);
  });

  it("derives the amounts from the original rather than trusting a caller", async () => {
    // A reversal that computes its own figures can disagree with what it claims
    // to undo. One built by negating the rows it points at cannot.
    const t = await settledTransfer(37_41);

    const reversal = await withTransaction((c) =>
      reverseTransaction({ transactionId: t.transactionId, description: "r" }, c)
    );

    const original = await entriesForTransaction(t.transactionId);
    const compensating = await entriesForTransaction(reversal!.transactionId);

    const byAccount = (entries: typeof original) =>
      Object.fromEntries(entries.map((e) => [e.account_id, Number(e.amount_minor)]));

    const before = byAccount(original);
    const after = byAccount(compensating);

    for (const accountId of Object.keys(before)) {
      expect(after[accountId]).toBe(-before[accountId]);
    }
  });

  it("reverses a posting at most once", async () => {
    const t = await settledTransfer();

    const first = await withTransaction((c) =>
      reverseTransaction({ transactionId: t.transactionId, description: "r" }, c)
    );
    const second = await withTransaction((c) =>
      reverseTransaction({ transactionId: t.transactionId, description: "r" }, c)
    );

    expect(first).not.toBeNull();
    // Null, not a second compensating posting — which would hand the money back
    // twice.
    expect(second).toBeNull();
    expect(await entriesForTransfer(t.transferId)).toHaveLength(4);
    expect(await balance(t.accountId)).toBe(0);
  });

  it("the database refuses a second reversal even if the code tries", async () => {
    const t = await settledTransfer();
    const reversal = await withTransaction((c) =>
      reverseTransaction({ transactionId: t.transactionId, description: "r" }, c)
    );
    expect(reversal).not.toBeNull();

    await expectRejectedBy(
      query(
        `INSERT INTO ledger_transactions
           (transfer_id, description, kind, reverses_transaction_id)
         VALUES ($1, 'sneaky', 'reversal', $2)`,
        [t.transferId, t.transactionId]
      ),
      UNIQUE_VIOLATION
    );
  });

  it("refuses to reverse a reversal", async () => {
    // Compensating a compensation is a re-settlement. Recording it as a
    // reversal would make the trail lie about which way the money went.
    const t = await settledTransfer();
    const reversal = await withTransaction((c) =>
      reverseTransaction({ transactionId: t.transactionId, description: "r" }, c)
    );

    await expectRejectedBy(
      query(
        `INSERT INTO ledger_transactions
           (transfer_id, description, kind, reverses_transaction_id)
         VALUES ($1, 'reverse the reversal', 'reversal', $2)`,
        [t.transferId, reversal!.transactionId]
      ),
      RESTRICT_VIOLATION
    );
  });

  it("still refuses a second SETTLEMENT for the same transfer", async () => {
    // Widening the constraint to allow reversals must not have opened the door
    // the original one was holding shut.
    const t = await settledTransfer();

    await expectRejectedBy(
      query(
        `INSERT INTO ledger_transactions (transfer_id, description, kind)
         VALUES ($1, 'second settlement', 'settlement')`,
        [t.transferId]
      ),
      UNIQUE_VIOLATION
    );
  });

  it("refuses a reversal that names nothing, and a settlement that names something", async () => {
    const t = await settledTransfer();

    await expectRejectedBy(
      query(
        `INSERT INTO ledger_transactions (transfer_id, description, kind)
         VALUES (NULL, 'unattached reversal', 'reversal')`,
        []
      ),
      CHECK_VIOLATION
    );

    await expectRejectedBy(
      query(
        `INSERT INTO ledger_transactions
           (transfer_id, description, kind, reverses_transaction_id)
         VALUES (NULL, 'settlement that reverses', 'settlement', $1)`,
        [t.transactionId]
      ),
      CHECK_VIOLATION
    );
  });
});

describe("the reversed transfer state", () => {
  it("moves a settled transfer to reversed and records when", async () => {
    const t = await settledTransfer();

    const updated = await markReversed({ transferId: t.transferId });

    expect(updated?.state).toBe("reversed");
    expect(updated?.reversed_at).toBeInstanceOf(Date);
    // It DID settle, and the record of when still stands. A reversal does not
    // pretend the settlement never happened.
    expect(updated?.settled_at).toBeInstanceOf(Date);
    expect(updated?.failure_code).toBe("PROVIDER_RETURNED");
  });

  it("will not reverse a transfer that never settled", async () => {
    const { row: customer } = await upsertBankingCustomer({
      appwriteAuthId: "auth-unsettled",
      appwriteUserDocumentId: "doc-unsettled",
    });
    const claim = await claimTransfer({
      customerId: customer.id,
      idempotencyKey: randomUUID(),
      requestFingerprint: "fp-unsettled",
      amountMinor: 10_00,
      currency: "USD",
    });
    await markSubmitted({
      transferId: claim.row.id,
      providerTransferId: "xfer-unsettled",
    });

    expect(await markReversed({ transferId: claim.row.id })).toBeNull();

    const { rows } = await query<{ state: string }>(
      "SELECT state FROM transfers WHERE id = $1",
      [claim.row.id]
    );
    expect(rows[0].state).toBe("submitted");
  });

  it("will not reverse the same transfer twice", async () => {
    const t = await settledTransfer();

    expect(await markReversed({ transferId: t.transferId })).not.toBeNull();
    expect(await markReversed({ transferId: t.transferId })).toBeNull();
  });

  it("finds the settlement posting and its reversal", async () => {
    const t = await settledTransfer();

    const posting = await findSettlementPosting(t.transferId);
    expect(posting?.id).toBe(t.transactionId);
    expect(posting?.kind).toBe("settlement");
    expect(await findReversalOf(t.transactionId)).toBeNull();

    await withTransaction((c) =>
      reverseTransaction({ transactionId: t.transactionId, description: "r" }, c)
    );

    const reversal = await findReversalOf(t.transactionId);
    expect(reversal?.kind).toBe("reversal");
    expect(reversal?.reverses_transaction_id).toBe(t.transactionId);

    // findSettlementPosting still returns the settlement, not the reversal.
    expect((await findSettlementPosting(t.transferId))?.id).toBe(t.transactionId);
  });
});

describe("the audit trail is written by the database", () => {
  it("records every transition in order, with its cause", async () => {
    const t = await settledTransfer();

    const trail = await transitionsForTransfer(t.transferId);

    expect(trail.map((r) => [r.from_state, r.to_state])).toEqual([
      [null, "requested"],
      ["requested", "submitted"],
      ["submitted", "settled"],
    ]);
  });

  it("records a transition made by hand, with no application involved", async () => {
    // THE POINT OF A TRIGGER. An audit trail the code appends to is complete
    // until somebody adds a path and forgets. This one cannot be bypassed —
    // not by a new code path, and not by psql.
    const t = await settledTransfer();

    await query(
      `UPDATE transfers SET state = 'reversed', reversed_at = now() WHERE id = $1`,
      [t.transferId]
    );

    const trail = await transitionsForTransfer(t.transferId);
    const last = trail[trail.length - 1];

    expect(last.from_state).toBe("settled");
    expect(last.to_state).toBe("reversed");
    // Nobody said why. Recorded as a visible gap rather than an invented reason.
    expect(last.cause).toBe("unrecorded");
  });

  it("records the cause a caller declares", async () => {
    const t = await settledTransfer();

    await withTransaction((c) => markReversed({ transferId: t.transferId }, c));

    const trail = await transitionsForTransfer(t.transferId);
    expect(trail[trail.length - 1]).toMatchObject({
      from_state: "settled",
      to_state: "reversed",
      cause: "provider-event",
    });
  });

  it("does not leak a declared cause onto the next transaction", async () => {
    // The cause is set with set_config(..., true) — transaction-local. If it
    // leaked, a later change on a recycled pooled connection would be logged
    // with somebody else's reason.
    const first = await settledTransfer();
    await withTransaction((c) => markReversed({ transferId: first.transferId }, c));

    const second = await settledTransfer();
    await query(
      `UPDATE transfers SET state = 'reversed', reversed_at = now() WHERE id = $1`,
      [second.transferId]
    );

    const trail = await transitionsForTransfer(second.transferId);
    expect(trail[trail.length - 1].cause).toBe("unrecorded");
  });

  it("writes no row when an update does not change the state", async () => {
    const t = await settledTransfer();
    const before = await transitionsForTransfer(t.transferId);

    await query("UPDATE transfers SET failure_code = 'NOTED' WHERE id = $1", [
      t.transferId,
    ]);

    expect(await transitionsForTransfer(t.transferId)).toHaveLength(before.length);
  });

  it("is append-only", async () => {
    const t = await settledTransfer();
    const trail = await transitionsForTransfer(t.transferId);
    const row = trail[0];

    await expectRejectedBy(
      query("UPDATE transfer_state_transitions SET cause = 'operator' WHERE id = $1", [
        row.id,
      ]),
      RESTRICT_VIOLATION
    );

    await expectRejectedBy(
      query("DELETE FROM transfer_state_transitions WHERE id = $1", [row.id]),
      RESTRICT_VIOLATION
    );
  });

  it("refuses a cause outside the known vocabulary", async () => {
    const t = await settledTransfer();

    await expectRejectedBy(
      query(
        `INSERT INTO transfer_state_transitions (transfer_id, from_state, to_state, cause)
         VALUES ($1, 'settled', 'reversed', 'because I said so')`,
        [t.transferId]
      ),
      CHECK_VIOLATION
    );
  });

  it("carries no actor identifier and no provider payload", async () => {
    // An audit trail is a place PII accumulates by default. This one records
    // what changed, not who asked — the columns simply do not exist.
    const { rows } = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'transfer_state_transitions'`,
      []
    );
    const columns = rows.map((r) => r.column_name).sort();

    expect(columns).toEqual([
      "cause",
      "from_state",
      "id",
      "occurred_at",
      "to_state",
      "transfer_id",
    ]);
  });
});
