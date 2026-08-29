import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query, withTransaction } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import {
  claimTransfer,
  markSubmitted,
  type TransferRow,
} from "../db/repositories/transfers.repository";
import {
  entriesForTransfer,
  findReversalOf,
  findSettlementPosting,
  totalAcrossAllAccounts,
} from "../db/repositories/ledger.repository";
import { transitionsForTransfer } from "../db/repositories/transfers.repository";
import { findWebhookEvent } from "../db/repositories/webhook-events.repository";
import {
  availableBalanceOf,
  findHoldByTransfer,
  placeHold,
} from "../db/repositories/holds.repository";
import { ensureCustomerAccount } from "../db/repositories/ledger.repository";
import { handleDwollaWebhook } from "./settlement.service";

/**
 * SETTLEMENT, AGAINST A REAL SERVER.
 *
 * The properties here cannot be shown with a mocked database. "Applied exactly
 * once" is a property of a unique index under concurrency; "the state change and
 * the ledger posting are atomic" is a property of a transaction. A fake would
 * assert that the test's own bookkeeping works.
 *
 * Every assertion is about OBSERVABLE FINANCIAL EFFECT — the transfer's state
 * and the entries that exist — never about the handler having been reached.
 */

const SECRET = "webhook-test-secret";

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query(
    `TRUNCATE transfer_state_transitions, ledger_holds, ledger_entries,
              ledger_transactions, ledger_accounts,
              provider_webhook_events, transfers, linked_accounts,
              banking_customers CASCADE`
  );
});

let keySeq = 0;
const nextKey = () => {
  keySeq += 1;
  return `11111111-1111-4111-8111-${String(keySeq).padStart(12, "0")}`;
};

/** A transfer that has been accepted by the provider and is awaiting settlement. */
async function submittedTransfer(
  amountMinor = 250_00,
  providerTransferId = "xfer-1"
): Promise<TransferRow> {
  const { row: customer } = await upsertBankingCustomer({
    appwriteAuthId: `auth-${providerTransferId}`,
    appwriteUserDocumentId: `doc-${providerTransferId}`,
  });

  const claimed = await claimTransfer({
    customerId: customer.id,
    idempotencyKey: nextKey(),
    requestFingerprint: `fp-${providerTransferId}`,
    amountMinor,
    currency: "USD",
  });

  // The real orchestration reserves the funds before calling the provider, so a
  // transfer that reaches `submitted` always carries an active hold. Settlement
  // tests that skipped this step would be testing a state the system cannot
  // actually be in.
  await withTransaction(async (client) => {
    const account = await ensureCustomerAccount(customer.id, client);
    // ON THE SAME CLIENT. The account row is not committed yet, so a separate
    // connection would update zero rows and silently leave the policy default.
    await client.query(
      "UPDATE ledger_accounts SET credit_limit_minor = $2 WHERE id = $1",
      [account.id, String(amountMinor * 2)]
    );
    await placeHold(
      { accountId: account.id, transferId: claimed.row.id, amountMinor },
      client
    );
  });

  return markSubmitted({
    transferId: claimed.row.id,
    providerTransferId,
  });
}

/** The ledger account behind a transfer's customer. */
async function accountFor(customerId: string): Promise<string> {
  const account = await ensureCustomerAccount(customerId);
  return account.id;
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt-1",
    topic: "customer_transfer_completed",
    resourceId: "xfer-1",
    ...over,
  });

/** Deliver a correctly signed event. */
const deliver = (rawBody: string) =>
  handleDwollaWebhook({
    rawBody,
    signatureHeader: createHmac("sha256", SECRET)
      .update(rawBody, "utf8")
      .digest("hex"),
    secret: SECRET,
  });

const stateOf = async (id: string) => {
  const { rows } = await query<{ state: string; settled_at: Date | null }>(
    "SELECT state, settled_at FROM transfers WHERE id = $1",
    [id]
  );
  return rows[0];
};

const ledgerTransactionCount = async () => {
  const { rows } = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM ledger_transactions",
    []
  );
  return Number(rows[0].count);
};

describe("an unverified delivery", () => {
  it("changes nothing and is not acknowledged", async () => {
    const transfer = await submittedTransfer();

    const result = await handleDwollaWebhook({
      rawBody: body(),
      signatureHeader: "0".repeat(64),
      secret: SECRET,
    });

    expect(result).toEqual({ outcome: "rejected-signature", accepted: false });

    // THE POINT OF THE TEST. Anyone can post to this endpoint claiming a
    // transfer settled; nothing about the world may change because they did.
    expect((await stateOf(transfer.id)).state).toBe("submitted");
    expect(await findWebhookEvent("evt-1")).toBeNull();
    expect(await ledgerTransactionCount()).toBe(0);
  });

  it("changes nothing when the secret is not configured", async () => {
    const transfer = await submittedTransfer();
    const raw = body();

    const result = await handleDwollaWebhook({
      rawBody: raw,
      signatureHeader: createHmac("sha256", SECRET).update(raw).digest("hex"),
      secret: undefined,
    });

    expect(result.accepted).toBe(false);
    expect((await stateOf(transfer.id)).state).toBe("submitted");
    expect(await ledgerTransactionCount()).toBe(0);
  });
});

describe("settlement", () => {
  it("moves the transfer to settled and posts a balanced pair", async () => {
    const transfer = await submittedTransfer(250_00);

    const result = await deliver(body());
    expect(result).toEqual({ outcome: "settled", accepted: true });

    const after = await stateOf(transfer.id);
    expect(after.state).toBe("settled");
    // A terminal state carries WHEN it became terminal, so nothing downstream
    // has to derive a settlement time from a clock.
    expect(after.settled_at).toBeInstanceOf(Date);

    const entries = await entriesForTransfer(transfer.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => Number(e.amount_minor)).sort((a, b) => a - b)).toEqual([
      -250_00, 250_00,
    ]);

    // CONSERVATION. Money moved between accounts; none was created.
    expect(await totalAcrossAllAccounts()).toBe(0);
  });

  it("posts exactly one transaction per settled transfer", async () => {
    const transfer = await submittedTransfer();
    await deliver(body());

    expect(await ledgerTransactionCount()).toBe(1);
    expect(await entriesForTransfer(transfer.id)).toHaveLength(2);
  });
});

describe("a redelivered event", () => {
  it("is applied ONCE — the second delivery changes nothing", async () => {
    // The scenario the whole deduplication mechanism exists for. Dwolla retries,
    // and a retry is indistinguishable from a first delivery at the HTTP layer.
    const transfer = await submittedTransfer(120_00);

    const first = await deliver(body());
    const settledAt = (await stateOf(transfer.id)).settled_at;

    const second = await deliver(body());

    expect(first.outcome).toBe("settled");
    expect(second).toEqual({ outcome: "duplicate", accepted: true });

    // ONE financial effect, not two. Asserted on the ledger, not on a flag:
    // a deduplication table can be perfectly populated while the money moved
    // twice.
    expect(await ledgerTransactionCount()).toBe(1);
    expect(await entriesForTransfer(transfer.id)).toHaveLength(2);
    expect(await totalAcrossAllAccounts()).toBe(0);

    const after = await stateOf(transfer.id);
    expect(after.state).toBe("settled");
    // Unchanged, not rewritten with a second settlement time.
    expect(after.settled_at?.getTime()).toBe(settledAt?.getTime());
  });

  it("is applied once even when both deliveries arrive at the same moment", async () => {
    // Two concurrent transactions inserting the same event id: the unique index
    // decides, not the handler's control flow. Sequential redelivery would pass
    // against an implementation that merely checks-then-inserts.
    const transfer = await submittedTransfer(75_00);

    const [a, b] = await Promise.all([deliver(body()), deliver(body())]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["duplicate", "settled"]);

    expect(await ledgerTransactionCount()).toBe(1);
    expect(await entriesForTransfer(transfer.id)).toHaveLength(2);
    expect(await totalAcrossAllAccounts()).toBe(0);
  });

  it("COMPENSATES a failure reported after settlement rather than ignoring it", async () => {
    // This used to assert the event was discarded as already-terminal. That was
    // the gap Milestone 9 closes: a provider reporting failure or return AFTER
    // settlement is the normal shape of ACH, and ignoring it leaves the ledger
    // insisting money moved that has since come back.
    const transfer = await submittedTransfer(90_00);

    await deliver(body({ id: "evt-a", topic: "customer_transfer_completed" }));
    const late = await deliver(
      body({ id: "evt-b", topic: "customer_transfer_failed" })
    );

    expect(late).toEqual({ outcome: "reversed", accepted: true });

    const { rows } = await query<{ state: string }>(
      "SELECT state FROM transfers WHERE id = $1",
      [transfer.id]
    );
    expect(rows[0].state).toBe("reversed");

    // Compensated, not corrected: the settlement posting stands and a second,
    // opposing one exists beside it.
    expect(await entriesForTransfer(transfer.id)).toHaveLength(4);
    expect(await totalAcrossAllAccounts()).toBe(0);

    const event = await findWebhookEvent("evt-b");
    expect(event?.outcome).toBe("reversed");
    expect(event?.processed_at).toBeInstanceOf(Date);
  });

  it("IS already-terminal when there is genuinely nothing left to do", async () => {
    // A settlement claimed for a transfer that already failed. There is no
    // posting to compensate and no legal transition, so the event is recorded
    // and changes nothing.
    const transfer = await submittedTransfer(90_00);

    await deliver(body({ id: "evt-fail", topic: "customer_transfer_failed" }));
    const late = await deliver(
      body({ id: "evt-late-settle", topic: "customer_transfer_completed" })
    );

    expect(late).toEqual({ outcome: "already-terminal", accepted: true });

    const { rows } = await query<{ state: string }>(
      "SELECT state FROM transfers WHERE id = $1",
      [transfer.id]
    );
    expect(rows[0].state).toBe("failed");
    expect(await ledgerTransactionCount()).toBe(0);

    const event = await findWebhookEvent("evt-late-settle");
    expect(event?.outcome).toBe("already-terminal");
  });
});

describe("a provider failure", () => {
  it("reaches an explicit failed state and posts nothing", async () => {
    const transfer = await submittedTransfer();

    const result = await deliver(body({ topic: "customer_transfer_failed" }));
    expect(result).toEqual({ outcome: "failed", accepted: true });

    const { rows } = await query<{ state: string; failure_code: string | null }>(
      "SELECT state, failure_code FROM transfers WHERE id = $1",
      [transfer.id]
    );
    expect(rows[0].state).toBe("failed");

    // A fixed vocabulary, never a provider message: those quote the request,
    // and a Dwolla request carries funding-source URLs.
    expect(rows[0].failure_code).toBe("PROVIDER_FAILED");

    // Nothing was ever posted for this transfer, so there is nothing to
    // compensate. The ledger learns about a transfer only when it settles.
    expect(await entriesForTransfer(transfer.id)).toHaveLength(0);
    expect(await ledgerTransactionCount()).toBe(0);
  });

  it("records a return with its timestamp", async () => {
    const transfer = await submittedTransfer();

    const result = await deliver(body({ topic: "customer_transfer_returned" }));
    expect(result.outcome).toBe("returned");

    const { rows } = await query<{ state: string; returned_at: Date | null }>(
      "SELECT state, returned_at FROM transfers WHERE id = $1",
      [transfer.id]
    );
    expect(rows[0].state).toBe("returned");
    expect(rows[0].returned_at).toBeInstanceOf(Date);
    expect(await ledgerTransactionCount()).toBe(0);
  });
});

describe("events this system cannot act on", () => {
  it("records an unmapped topic and changes nothing", async () => {
    const transfer = await submittedTransfer();

    const result = await deliver(body({ id: "evt-x", topic: "customer_created" }));
    expect(result).toEqual({ outcome: "ignored-topic", accepted: true });

    expect((await stateOf(transfer.id)).state).toBe("submitted");
    expect((await findWebhookEvent("evt-x"))?.outcome).toBe("ignored-topic");
  });

  it("records an event for a transfer it has never seen", async () => {
    // Exactly the shape a reconciliation gap takes: the provider believes in a
    // transfer this system has no record of. Accepted so it is not redelivered
    // forever, but written down so it is findable.
    const result = await deliver(body({ id: "evt-y", resourceId: "xfer-unknown" }));

    expect(result).toEqual({ outcome: "unknown-transfer", accepted: true });
    expect((await findWebhookEvent("evt-y"))?.outcome).toBe("unknown-transfer");
    expect(await ledgerTransactionCount()).toBe(0);
  });

  it("will not settle a transfer that was never submitted", async () => {
    // A transfer still in `requested` was never accepted by the provider, so no
    // event can legitimately say it settled. `settled` must be unreachable from
    // anywhere but `submitted`.
    const { row: customer } = await upsertBankingCustomer({
      appwriteAuthId: "auth-req",
      appwriteUserDocumentId: "doc-req",
    });
    const claimed = await claimTransfer({
      customerId: customer.id,
      idempotencyKey: nextKey(),
      requestFingerprint: "fp-req",
      amountMinor: 10_00,
      currency: "USD",
    });

    // Give it a provider reference WITHOUT advancing the state, which is the
    // only way an event could find it at all.
    await query("UPDATE transfers SET provider_transfer_id = $2 WHERE id = $1", [
      claimed.row.id,
      "xfer-req",
    ]);

    const result = await deliver(body({ id: "evt-z", resourceId: "xfer-req" }));

    expect(result).toEqual({ outcome: "already-terminal", accepted: true });
    expect((await stateOf(claimed.row.id)).state).toBe("requested");
    expect(await ledgerTransactionCount()).toBe(0);
  });

  it("acknowledges an unparseable body without recording it", async () => {
    const result = await deliver("this is not json");

    expect(result).toEqual({ outcome: "malformed", accepted: true });
    expect(await ledgerTransactionCount()).toBe(0);
  });
});

describe("holds are resolved with the transfer", () => {
  it("CAPTURES the hold when the transfer settles", async () => {
    const transfer = await submittedTransfer(80_00);

    await deliver(body());

    const hold = await withTransaction((c) => findHoldByTransfer(transfer.id, c));
    expect(hold?.state).toBe("captured");
    expect(hold?.resolved_at).toBeInstanceOf(Date);

    // Availability does NOT come back on capture: the money moved, and the
    // entries now carry it. Limit 160_00, ledger balance -80_00, nothing held.
    const accountId = await accountFor(transfer.customer_id);
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(80_00);
  });

  it("RELEASES the hold when the provider reports a failure", async () => {
    // A failed transfer whose hold stayed active would permanently reduce what
    // this customer can commit, for money that never moved.
    const transfer = await submittedTransfer(80_00);

    await deliver(body({ topic: "customer_transfer_failed" }));

    const hold = await withTransaction((c) => findHoldByTransfer(transfer.id, c));
    expect(hold?.state).toBe("released");

    // Fully restored: no entries were posted, and nothing is reserved.
    const accountId = await accountFor(transfer.customer_id);
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(160_00);
  });

  it("RELEASES the hold when the transfer is returned", async () => {
    const transfer = await submittedTransfer(80_00);

    await deliver(body({ topic: "customer_transfer_returned" }));

    const hold = await withTransaction((c) => findHoldByTransfer(transfer.id, c));
    expect(hold?.state).toBe("released");
    const accountId = await accountFor(transfer.customer_id);
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(160_00);
  });

  it("does not resolve the hold twice on a redelivery", async () => {
    const transfer = await submittedTransfer(80_00);

    await deliver(body());
    const first = await withTransaction((c) => findHoldByTransfer(transfer.id, c));

    await deliver(body());
    const second = await withTransaction((c) => findHoldByTransfer(transfer.id, c));

    expect(second?.state).toBe("captured");
    // Unchanged, not re-stamped with a second resolution time.
    expect(second?.resolved_at?.getTime()).toBe(first?.resolved_at?.getTime());
  });
});

describe("a return that arrives AFTER settlement", () => {
  // The ordinary shape of an ACH return: the transfer completed days ago and
  // the money is now being taken back. Treating this as a stale out-of-order
  // event is how a returned transfer silently keeps money it no longer has.

  it("reverses the transfer instead of ignoring the event", async () => {
    const transfer = await submittedTransfer(140_00);
    await deliver(body({ id: "evt-settle" }));

    const result = await deliver(
      body({ id: "evt-return", topic: "customer_transfer_returned" })
    );

    expect(result).toEqual({ outcome: "reversed", accepted: true });

    const { rows } = await query<{ state: string; reversed_at: Date | null }>(
      "SELECT state, reversed_at FROM transfers WHERE id = $1",
      [transfer.id]
    );
    expect(rows[0].state).toBe("reversed");
    expect(rows[0].reversed_at).toBeInstanceOf(Date);
  });

  it("posts COMPENSATING entries and leaves the settlement posting intact", async () => {
    const transfer = await submittedTransfer(140_00);
    await deliver(body({ id: "evt-settle" }));

    const settlementPosting = await findSettlementPosting(transfer.id);
    const settledEntries = await entriesForTransfer(transfer.id);
    expect(settledEntries).toHaveLength(2);

    await deliver(body({ id: "evt-return", topic: "customer_transfer_returned" }));

    // Four entries: two that happened, two that undid them. The originals are
    // the same rows — they record something that genuinely occurred.
    const after = await entriesForTransfer(transfer.id);
    expect(after).toHaveLength(4);
    expect(after.filter((e) => settledEntries.some((o) => o.id === e.id))).toHaveLength(2);

    const reversal = await findReversalOf(settlementPosting!.id);
    expect(reversal?.kind).toBe("reversal");

    // Net zero across the transfer, and conservation across the ledger.
    expect(after.reduce((sum, e) => sum + Number(e.amount_minor), 0)).toBe(0);
    expect(await totalAcrossAllAccounts()).toBe(0);
  });

  it("reverses ONCE however many times the return is redelivered", async () => {
    const transfer = await submittedTransfer(140_00);
    await deliver(body({ id: "evt-settle" }));

    const first = await deliver(
      body({ id: "evt-return", topic: "customer_transfer_returned" })
    );
    const replay = await deliver(
      body({ id: "evt-return", topic: "customer_transfer_returned" })
    );
    // A DIFFERENT event making the same claim — deduplication by event id does
    // not help here, so the reversal itself has to be idempotent.
    const another = await deliver(
      body({ id: "evt-return-2", topic: "customer_transfer_returned" })
    );

    expect(first.outcome).toBe("reversed");
    expect(replay.outcome).toBe("duplicate");
    expect(another.outcome).toBe("already-terminal");

    expect(await entriesForTransfer(transfer.id)).toHaveLength(4);
    expect(await totalAcrossAllAccounts()).toBe(0);
  });

  it("records the whole lifecycle in the audit trail", async () => {
    const transfer = await submittedTransfer(140_00);
    await deliver(body({ id: "evt-settle" }));
    await deliver(body({ id: "evt-return", topic: "customer_transfer_returned" }));

    const trail = await transitionsForTransfer(transfer.id);

    expect(trail.map((r) => r.to_state)).toEqual([
      "requested",
      "submitted",
      "settled",
      "reversed",
    ]);
    expect(trail[trail.length - 1].cause).toBe("provider-event");
  });

  it("leaves the captured hold captured", async () => {
    // The hold was consumed when the money moved. A reversal returns the money
    // through the ledger; it does not un-capture a reservation, which would
    // credit the customer a second time.
    const transfer = await submittedTransfer(140_00);
    await deliver(body({ id: "evt-settle" }));
    await deliver(body({ id: "evt-return", topic: "customer_transfer_returned" }));

    const hold = await withTransaction((c) => findHoldByTransfer(transfer.id, c));
    expect(hold?.state).toBe("captured");

    // Availability is back to the full limit — restored by the compensating
    // entries, not by releasing the hold.
    const accountId = await accountFor(transfer.customer_id);
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(280_00);
  });

  it("does not reverse a transfer that only reached submitted", async () => {
    const transfer = await submittedTransfer(140_00);

    const result = await deliver(
      body({ id: "evt-return", topic: "customer_transfer_returned" })
    );

    // The ordinary terminal path, not a reversal: nothing was ever posted.
    expect(result.outcome).toBe("returned");
    expect(await entriesForTransfer(transfer.id)).toHaveLength(0);
  });
});

describe("atomicity of the settlement effect", () => {
  it("never records an event as processed without its effect", async () => {
    // The failure this guards: marking the event processed in one transaction
    // and applying it in another. A crash between them either loses the event
    // or replays it. Both are asserted here by checking that the event row and
    // the ledger agree.
    const transfer = await submittedTransfer(310_00);
    await deliver(body());

    const event = await findWebhookEvent("evt-1");
    expect(event?.processed_at).toBeInstanceOf(Date);
    expect(event?.outcome).toBe("settled");

    expect((await stateOf(transfer.id)).state).toBe("settled");
    expect(await entriesForTransfer(transfer.id)).toHaveLength(2);
  });

  it("rolls the state change back when the posting fails", async () => {
    // Drive a failure INSIDE the transaction, after the state change, and check
    // the transfer is still `submitted` afterwards. If the two were in separate
    // transactions this would leave a settled transfer with no entries — a
    // transfer the system believes completed and the ledger has never heard of.
    const transfer = await submittedTransfer(44_00);

    // The balance trigger is DEFERRABLE INITIALLY DEFERRED, so an unbalanced
    // posting fails at COMMIT — the hardest moment for the effect to be atomic.
    await query(
      `CREATE OR REPLACE FUNCTION orion_test_break_entries() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'induced failure';
       END $$`
    );
    await query(
      `CREATE TRIGGER orion_test_break_entries
         BEFORE INSERT ON ledger_entries
         FOR EACH ROW EXECUTE FUNCTION orion_test_break_entries()`
    );

    try {
      await expect(deliver(body())).rejects.toThrow();
    } finally {
      await query("DROP TRIGGER IF EXISTS orion_test_break_entries ON ledger_entries");
      await query("DROP FUNCTION IF EXISTS orion_test_break_entries()");
    }

    // Everything the transaction did is gone: the state change, and the claim
    // on the event id — so the redelivery that follows can be applied properly.
    expect((await stateOf(transfer.id)).state).toBe("submitted");
    expect(await findWebhookEvent("evt-1")).toBeNull();
    expect(await ledgerTransactionCount()).toBe(0);

    // The hold rolled back with everything else: still reserved, because the
    // transfer is still in flight. A capture that survived a rolled-back
    // settlement would free money the ledger never recorded moving.
    const heldAfterFailure = await withTransaction((c) =>
      findHoldByTransfer(transfer.id, c)
    );
    expect(heldAfterFailure?.state).toBe("active");

    // And the redelivery does apply.
    const retry = await deliver(body());
    expect(retry.outcome).toBe("settled");
    expect(await entriesForTransfer(transfer.id)).toHaveLength(2);
    expect(await totalAcrossAllAccounts()).toBe(0);
  });
});
