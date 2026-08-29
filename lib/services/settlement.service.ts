// Server-only. Applies verified provider events to the transfer lifecycle.
import "server-only";

import { withTransaction, type TransactionClient } from "../db/pool";
import {
  claimWebhookEvent,
  markEventProcessed,
} from "../db/repositories/webhook-events.repository";
import {
  findTransferByProviderId,
  markReversed,
  markTerminal,
} from "../db/repositories/transfers.repository";
import {
  ensureCustomerAccount,
  ensureSettlementAccount,
  findSettlementPosting,
  postTransaction,
  reverseTransaction,
} from "../db/repositories/ledger.repository";
import { captureHold, releaseHold } from "../db/repositories/holds.repository";
import {
  digestPayload,
  parseDwollaEvent,
  transferOutcomeForTopic,
  verifyDwollaSignature,
} from "../server/dwolla-webhook";

/**
 * What handling an event did.
 *
 * Every outcome is a fixed token, never a provider message: those echo the
 * request, and a Dwolla request carries funding-source URLs.
 */
export type SettlementOutcome =
  | "rejected-signature"
  | "malformed"
  | "duplicate"
  | "ignored-topic"
  | "unknown-transfer"
  | "already-terminal"
  | "settled"
  | "failed"
  | "returned"
  | "reversed";

export type SettlementResult = {
  outcome: SettlementOutcome;
  /** Whether the caller should answer 2xx. */
  accepted: boolean;
};

export type SettlementDeps = {
  runInTransaction: <T>(fn: (client: TransactionClient) => Promise<T>) => Promise<T>;
};

export const defaultSettlementDeps: SettlementDeps = {
  runInTransaction: withTransaction,
};

/**
 * Handle one Dwolla webhook delivery.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *
 *   1. verify the signature over the RAW body — before parsing anything
 *   2. parse
 *   3. claim the event id, which deduplicates redeliveries
 *   4. apply the state change and the ledger posting IN ONE TRANSACTION
 *   5. mark the event processed, in that same transaction
 *
 * Steps 4 and 5 share a transaction so an event can never be recorded as
 * processed while its effect rolled back, nor applied twice because the marking
 * failed. Splitting them is the classic way a webhook handler ends up either
 * losing an event or replaying one.
 *
 * ALWAYS ACCEPTS (2xx) once the signature verifies, including for events it
 * ignores. A non-2xx tells Dwolla to redeliver, and asking to be re-sent an
 * event we have correctly decided to ignore is an infinite loop with extra
 * steps. A bad signature is the exception: that is not a delivery to
 * acknowledge.
 */
export async function handleDwollaWebhook(
  input: {
    rawBody: string;
    signatureHeader: string | null;
    secret: string | undefined;
  },
  deps: SettlementDeps = defaultSettlementDeps
): Promise<SettlementResult> {
  // 1. SIGNATURE FIRST. Anyone can post here claiming a transfer settled.
  const verified = verifyDwollaSignature(input);
  if (!verified.ok) {
    return { outcome: "rejected-signature", accepted: false };
  }

  // 2. Only now is the body worth reading.
  const event = parseDwollaEvent(input.rawBody);
  if (!event) {
    // Accepted: redelivering a body that will never parse achieves nothing.
    return { outcome: "malformed", accepted: true };
  }

  const digest = digestPayload(input.rawBody);
  const outcome = transferOutcomeForTopic(event.topic);

  return deps.runInTransaction(async (client) => {
    // 3. DEDUPLICATE. The unique index decides, not this control flow: two
    //    concurrent deliveries of one event race here.
    const claim = await claimWebhookEvent(
      { providerEventId: event.id, topic: event.topic, payloadDigest: digest },
      client
    );
    if (claim.kind === "duplicate") {
      return { outcome: "duplicate", accepted: true };
    }

    // Dwolla emits many topics this application has no opinion about. Record
    // that it arrived; change nothing.
    if (!outcome) {
      await markEventProcessed(
        { eventId: claim.row.id, outcome: "ignored-topic" },
        client
      );
      return { outcome: "ignored-topic", accepted: true };
    }

    if (!event.resourceId) {
      await markEventProcessed(
        { eventId: claim.row.id, outcome: "unknown-transfer" },
        client
      );
      return { outcome: "unknown-transfer", accepted: true };
    }

    const transfer = await findTransferByProviderId(event.resourceId, client);
    if (!transfer) {
      // A transfer this system never recorded. Accepted and noted rather than
      // retried forever — but visible, because it is exactly the shape a
      // reconciliation gap takes.
      await markEventProcessed(
        { eventId: claim.row.id, outcome: "unknown-transfer" },
        client
      );
      return { outcome: "unknown-transfer", accepted: true };
    }

    // 4. Apply. markTerminal only moves a `submitted` row, so a redelivered or
    //    out-of-order event cannot rewrite a terminal state.
    const updated = await markTerminal(
      {
        transferId: transfer.id,
        outcome,
        failureCode: outcome === "settled" ? null : `PROVIDER_${outcome.toUpperCase()}`,
      },
      client
    );

    if (!updated) {
      // NOT NECESSARILY OUT OF ORDER. An ACH return arrives days after
      // settlement, so `settled` + a return event is the ordinary shape of a
      // transfer being taken back — not a stale event to discard. Treating it
      // as already-terminal is how a returned transfer silently keeps money it
      // no longer has.
      if (outcome === "returned" || outcome === "failed") {
        const reversal = await reverseSettledTransfer(
          { transferId: transfer.id, outcome },
          client
        );
        if (reversal) {
          await markEventProcessed(
            { eventId: claim.row.id, outcome: "reversed" },
            client
          );
          return { outcome: "reversed", accepted: true };
        }
      }

      await markEventProcessed(
        { eventId: claim.row.id, outcome: "already-terminal" },
        client
      );
      return { outcome: "already-terminal", accepted: true };
    }

    // SETTLEMENT IS WHERE MONEY BECOMES OURS TO RECORD. Acceptance was not
    // enough; this is the first point the ledger is entitled to say the funds
    // moved. The posting is in the same transaction as the state change, so a
    // settled transfer without entries — or entries without a settled transfer
    // — cannot exist.
    //
    // A failed or returned transfer posts NOTHING here, because nothing was
    // ever posted to compensate: the ledger only learns about a transfer when
    // it settles. Compensating entries belong to the reversal milestone, on top
    // of a settled posting.
    if (outcome === "settled") {
      // The hold did its job: the money it reserved is now carried by real
      // entries. Captured in the same transaction that posts them, so the
      // reservation and the movement can never disagree.
      await captureHold(updated.id, client);

      const customer = await ensureCustomerAccount(updated.customer_id, client);
      const settlement = await ensureSettlementAccount(client);
      const amountMinor = Number(updated.amount_minor);

      await postTransaction(
        {
          description: `transfer ${updated.id} settled`,
          transferId: updated.id,
          lines: [
            { accountId: customer.id, amountMinor: -amountMinor },
            { accountId: settlement.id, amountMinor },
          ],
        },
        client
      );
    }

    // The money never moved. Give the reservation back, in the same
    // transaction as the terminal state — otherwise a failed transfer would go
    // on consuming the customer's available balance indefinitely.
    if (outcome === "failed" || outcome === "returned") {
      await releaseHold(updated.id, client);
    }

    // 5. Same transaction as the effect above.
    await markEventProcessed({ eventId: claim.row.id, outcome }, client);

    return { outcome, accepted: true };
  });
}

/**
 * Take back a transfer that had already settled.
 *
 * COMPENSATION, NOT CORRECTION. The original entries stay exactly as they are —
 * they record something that genuinely happened — and a new opposing posting
 * records the money coming back. The ledger's own triggers make this the only
 * possibility: entries cannot be updated or deleted.
 *
 * The state change and the compensating posting are in the CALLER'S
 * transaction, so a transfer marked `reversed` whose money was never returned
 * cannot exist.
 *
 * Returns null when there is nothing to reverse — the transfer was not settled,
 * or its posting has already been compensated — so a redelivery is a no-op.
 */
async function reverseSettledTransfer(
  input: { transferId: string; outcome: "returned" | "failed" },
  client: TransactionClient
): Promise<boolean> {
  const posting = await findSettlementPosting(input.transferId, client);
  if (!posting) return false;

  const reversal = await reverseTransaction(
    {
      transactionId: posting.id,
      description: `transfer ${input.transferId} reversed`,
    },
    client
  );
  if (!reversal) return false;

  const updated = await markReversed(
    {
      transferId: input.transferId,
      failureCode: `PROVIDER_${input.outcome.toUpperCase()}`,
    },
    client
  );

  // The posting was compensated but the transfer was not `settled`. Nothing
  // sensible follows from that, and committing half of it would leave opposing
  // entries with no state change to explain them.
  if (!updated) {
    throw new Error(
      `transfer ${input.transferId} had a settlement posting but was not settled`
    );
  }

  return true;
}
