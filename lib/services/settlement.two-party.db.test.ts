import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query, withTransaction } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import { claimTransfer, markSubmitted } from "../db/repositories/transfers.repository";
import {
  balanceOf,
  ensureCustomerAccount,
  entriesForTransfer,
  totalAcrossAllAccounts,
} from "../db/repositories/ledger.repository";
import { placeHold } from "../db/repositories/holds.repository";
import { handleDwollaWebhook } from "./settlement.service";

/**
 * THE TWO-PARTY ACCOUNTING MODEL, AGAINST A REAL SERVER.
 *
 * Settlement used to credit a single HOUSE account for every transfer, so a
 * recipient's ledger balance never reflected anything they received. The
 * interface showed a credit because it read the Appwrite transaction record,
 * not the ledger — and PostgreSQL could not become the system of record while
 * the ledger disagreed with what the user was shown.
 *
 * See docs/adr/0002-cutover-accounting-model.md.
 *
 * The house model is not deleted. Entries are immutable by trigger, so
 * transfers settled before this keep the shape they were given, and
 * `accounting_model` records which shape to expect. Those cases stay covered in
 * settlement.service.db.test.ts; this file covers the new one.
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
  return `33333333-3333-4333-8333-${String(keySeq).padStart(12, "0")}`;
};

const deliver = (resourceId: string, eventId: string) => {
  const rawBody = JSON.stringify({
    id: eventId,
    topic: "customer_transfer_completed",
    resourceId,
  });
  return handleDwollaWebhook({
    rawBody,
    signatureHeader: createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex"),
    secret: SECRET,
  });
};

/**
 * A submitted transfer between two enrolled customers.
 *
 * `toSelf` puts the same customer on both sides, which is a real case: one
 * person moving money between two banks they own.
 */
async function submittedTwoParty(options: {
  amountMinor?: number;
  providerTransferId?: string;
  toSelf?: boolean;
} = {}) {
  const amountMinor = options.amountMinor ?? 250_00;
  const providerTransferId = options.providerTransferId ?? "xfer-two-party";

  const { row: sender } = await upsertBankingCustomer({
    appwriteAuthId: `auth-sender-${providerTransferId}`,
    appwriteUserDocumentId: `doc-sender-${providerTransferId}`,
  });
  const recipient = options.toSelf
    ? sender
    : (
        await upsertBankingCustomer({
          appwriteAuthId: `auth-recipient-${providerTransferId}`,
          appwriteUserDocumentId: `doc-recipient-${providerTransferId}`,
        })
      ).row;

  const claimed = await claimTransfer({
    customerId: sender.id,
    idempotencyKey: nextKey(),
    requestFingerprint: `fp-${providerTransferId}`,
    amountMinor,
    currency: "USD",
    recipientUserDocumentId: recipient.appwrite_user_document_id,
    senderBankDocumentId: "bank-doc-sender",
    recipientBankDocumentId: "bank-doc-recipient",
    note: "two party",
    recipientCustomerId: recipient.id,
  });

  // The real orchestration reserves funds before calling the provider, so a
  // transfer that reaches `submitted` always carries an active hold.
  await withTransaction(async (client) => {
    const account = await ensureCustomerAccount(sender.id, client);
    await client.query(
      "UPDATE ledger_accounts SET credit_limit_minor = $2 WHERE id = $1",
      [account.id, String(amountMinor * 2)]
    );
    await placeHold(
      { accountId: account.id, transferId: claimed.row.id, amountMinor },
      client
    );
  });

  const row = await markSubmitted({ transferId: claimed.row.id, providerTransferId });
  return { row, sender, recipient, amountMinor };
}

const accountFor = async (customerId: string) =>
  (await ensureCustomerAccount(customerId)).id;

const settlementEntryCount = async () => {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = 'settlement'`
  );
  return Number(rows[0].n);
};

describe("an internal transfer credits the recipient", () => {
  it("posts sender debit and recipient credit, not a house credit", async () => {
    const { row, sender, recipient, amountMinor } = await submittedTwoParty();
    const before = await totalAcrossAllAccounts();

    const result = await deliver(row.provider_transfer_id!, "evt-two-party");
    expect(result.outcome).toBe("settled");

    const senderAccount = await accountFor(sender.id);
    const recipientAccount = await accountFor(recipient.id);
    const entries = await entriesForTransfer(row.id);

    expect(entries).toHaveLength(2);
    const byAccount = new Map(
      entries.map((e) => [e.account_id, Number(e.amount_minor)])
    );
    expect(byAccount.get(senderAccount)).toBe(-amountMinor);
    expect(byAccount.get(recipientAccount)).toBe(amountMinor);

    // CONSERVATION. Money moved between two accounts; none entered or left.
    expect(await totalAcrossAllAccounts()).toBe(before);
  });

  it("leaves the settlement account out of it entirely", async () => {
    const { row } = await submittedTwoParty({ providerTransferId: "xfer-no-house" });

    await deliver(row.provider_transfer_id!, "evt-no-house");

    expect(await settlementEntryCount()).toBe(0);
  });

  it("moves the recipient's balance by exactly the amount", async () => {
    const { row, recipient, amountMinor } = await submittedTwoParty({
      providerTransferId: "xfer-balance",
    });
    const recipientAccount = await accountFor(recipient.id);
    expect(await balanceOf(recipientAccount)).toBe(0);

    await deliver(row.provider_transfer_id!, "evt-balance");

    expect(await balanceOf(recipientAccount)).toBe(amountMinor);
  });

  it("records which model produced the entries", async () => {
    // Without this the ledger becomes unreadable after the change: two
    // transfers with identical rows would carry different entry shapes and
    // nothing would say why.
    const { row } = await submittedTwoParty({ providerTransferId: "xfer-provenance" });

    expect(row.accounting_model).toBe("internal_two_party");
    expect(row.recipient_customer_id).toBeTruthy();
  });
});

describe("a transfer between two banks the same customer owns", () => {
  it("nets to zero on one account without fabricating income", async () => {
    // There is ONE customer account per currency, not one per linked bank, so
    // this does not change the customer's aggregate internal position. Both
    // entries land on the same account and sum to zero.
    //
    // Skipping the posting would lose the record that money moved; crediting
    // anywhere else would invent income.
    const { row, sender } = await submittedTwoParty({
      providerTransferId: "xfer-self",
      toSelf: true,
    });
    const account = await accountFor(sender.id);

    await deliver(row.provider_transfer_id!, "evt-self");

    const entries = await entriesForTransfer(row.id);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.account_id === account)).toBe(true);
    expect(entries.reduce((sum, e) => sum + Number(e.amount_minor), 0)).toBe(0);
    expect(await balanceOf(account)).toBe(0);
    expect(await settlementEntryCount()).toBe(0);
  });
});

describe("replay is still one financial effect", () => {
  it("does not post a second pair when the same event arrives twice", async () => {
    const { row, recipient, amountMinor } = await submittedTwoParty({
      providerTransferId: "xfer-replay",
    });

    const first = await deliver(row.provider_transfer_id!, "evt-replay");
    const second = await deliver(row.provider_transfer_id!, "evt-replay");

    expect(first.outcome).toBe("settled");
    expect(second.outcome).toBe("duplicate");

    expect(await entriesForTransfer(row.id)).toHaveLength(2);
    expect(await balanceOf(await accountFor(recipient.id))).toBe(amountMinor);
  });
});
