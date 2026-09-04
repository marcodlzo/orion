import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Money } from "../domain/money";
import type { BankRecord } from "../repositories/banks.repository";
import type { TransactionRecord } from "../repositories/transactions.repository";
import { closePool, query } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import { executeTransfer } from "./transfers.service";

/**
 * ENROLMENT ON THE REQUEST PATH, AGAINST A REAL SERVER.
 *
 * The defect this suite exists for: nothing in the application ever created a
 * `banking_customers` row. It was written only by `npm run db:backfill`, so a
 * user who signed up after the last backfill was permanently unable to transfer
 * — the service refused with "not enrolled for transfers yet" and no amount of
 * retrying helped. Every unit test passed throughout, because they all seeded
 * the customer themselves.
 *
 * That is the shape of bug a mocked database cannot show. "The row is created
 * exactly once under concurrency" is a property of a unique constraint, and
 * "enrolment and the claim commit together" is a property of a transaction.
 *
 * Appwrite and Dwolla are the only fakes. They are the process boundaries this
 * suite is not testing; PostgreSQL is what is under test and is real.
 */

const ACTOR = {
  authId: "auth-new-user",
  userId: "userdoc-new-user",
  dwollaCustomerId: "dwolla-new-user",
} as const;

const SOURCE_BANK: BankRecord = {
  $id: "bank-source",
  accountId: "acct-source",
  bankId: "item-source",
  accessToken: "access-source",
  fundingSourceUrl: "https://api-sandbox.dwolla.invalid/funding-sources/source",
  shareableId: "c2hhcmUtc291cmNl",
  userId: { $id: ACTOR.userId },
};

const RECIPIENT_BANK: BankRecord = {
  $id: "bank-recipient",
  accountId: "acct-recipient",
  bankId: "item-recipient",
  accessToken: "access-recipient",
  fundingSourceUrl: "https://api-sandbox.dwolla.invalid/funding-sources/dest",
  shareableId: "c2hhcmUtcmVjaXBpZW50",
  userId: { $id: "userdoc-recipient" },
};

/**
 * Declared through vi.hoisted because vi.mock is lifted above the imports.
 *
 * A plain `const` would still be in its temporal dead zone when the factory
 * runs during module resolution, so the suite would die with a ReferenceError
 * before a single assertion. Top-level await would sidestep the ordering, but
 * this tsconfig targets below ES2022 and rejects it.
 */
const stub = vi.hoisted(() => ({
  getOwnedBankByDocumentId: vi.fn(),
  findCounterpartyBankByAccountId: vi.fn(),
  createDwollaTransfer: vi.fn(),
  createTransactionRecord: vi.fn(),
}));

vi.mock("../repositories/banks.repository", () => ({
  getOwnedBankByDocumentId: stub.getOwnedBankByDocumentId,
  findCounterpartyBankByAccountId: stub.findCounterpartyBankByAccountId,
}));

vi.mock("../server/dwolla", () => ({
  createDwollaTransfer: stub.createDwollaTransfer,
}));

vi.mock("../repositories/transactions.repository", () => ({
  createTransactionRecord: stub.createTransactionRecord,
  // Not faked: the real conversion, so an amount that reached the legacy column
  // wrong would show up here rather than being hidden by a stub.
  toLegacyTransactionAmount: (money: Money) => (money.amountMinor / 100).toFixed(2),
}));

/**
 * A distinct provider reference per call, because the real provider issues one.
 *
 * A fixed id looks harmless and is not: `provider_transfer_id` is UNIQUE, so a
 * stub that returns the same value twice makes the second transfer fail on a
 * constraint that exists to catch exactly the opposite problem — the same
 * provider transfer being recorded twice.
 */
let providerSeq = 0;

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
  vi.clearAllMocks();

  stub.getOwnedBankByDocumentId.mockResolvedValue(SOURCE_BANK);
  stub.findCounterpartyBankByAccountId.mockResolvedValue(RECIPIENT_BANK);
  stub.createTransactionRecord.mockResolvedValue({
    $id: "txn-1",
    $createdAt: new Date().toISOString(),
  } satisfies Partial<TransactionRecord> as TransactionRecord);

  // Re-armed per test, not set once: clearAllMocks drops implementations set
  // through mockResolvedValue, and a stub returning undefined would fail these
  // tests somewhere unrelated to what they assert.
  stub.createDwollaTransfer.mockImplementation(async () => {
    providerSeq += 1;
    return {
      transferUrl: `https://api-sandbox.dwolla.invalid/transfers/xfer-${providerSeq}`,
      transferId: `xfer-${providerSeq}`,
    };
  });
});

let keySeq = 0;
const nextKey = () => {
  keySeq += 1;
  return `22222222-2222-4222-8222-${String(keySeq).padStart(12, "0")}`;
};

/** The reference a sender pastes: base64 of the recipient's account id. */
const reference = Buffer.from(RECIPIENT_BANK.accountId).toString("base64");

function intent(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: nextKey(),
    senderBankId: SOURCE_BANK.$id,
    recipientReference: reference,
    amount: "5.00",
    note: "test transfer",
    recipientEmail: "recipient@example.invalid",
    ...over,
  };
}

async function customerRows() {
  const { rows } = await query<{
    id: string;
    appwrite_auth_id: string;
    appwrite_user_document_id: string;
    updated_at: Date;
  }>("SELECT * FROM banking_customers ORDER BY created_at, id");
  return rows;
}

describe("a customer who has never transferred", () => {
  it("is enrolled by their first transfer instead of being refused", async () => {
    // THE REGRESSION. Before this change the row did not exist, nothing in the
    // application created it, and this call threw
    // "This account is not enrolled for transfers yet" forever.
    expect(await customerRows()).toHaveLength(0);

    const result = await executeTransfer(ACTOR, intent());

    expect(result.status).toBe("submitted");
    expect(result.replayed).toBe(false);

    // Enrolled exactly once, from the session's identifiers.
    const customers = await customerRows();
    expect(customers).toHaveLength(1);
    expect(customers[0].appwrite_auth_id).toBe(ACTOR.authId);
    expect(customers[0].appwrite_user_document_id).toBe(ACTOR.userId);

    // The financial effect, not the response: one transfer owned by that
    // customer, and one hold reserving the money.
    const { rows: transfers } = await query<{ customer_id: string; state: string }>(
      "SELECT customer_id, state FROM transfers"
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0].customer_id).toBe(customers[0].id);
    expect(transfers[0].state).toBe("submitted");

    const { rows: holds } = await query<{
      amount_minor: string;
      state: string;
      resolved_at: Date | null;
    }>("SELECT amount_minor, state, resolved_at FROM ledger_holds");
    expect(holds).toHaveLength(1);
    // Exact minor units: $5.00 is 500, never 5 and never 5.0.
    expect(holds[0].amount_minor).toBe("500");
    expect(holds[0].state).toBe("active");
    expect(holds[0].resolved_at).toBeNull();
  });

  it("takes both identifiers from the session, never from the intent", async () => {
    // A caller who can name the row they are enrolled as can attach their
    // transfers to somebody else's customer. The intent carries these fields
    // precisely so that ignoring them is asserted rather than assumed.
    await executeTransfer(
      ACTOR,
      intent({
        appwriteAuthId: "auth-somebody-else",
        appwriteUserDocumentId: "userdoc-somebody-else",
        customerId: "00000000-0000-4000-8000-000000000000",
      })
    );

    const customers = await customerRows();
    expect(customers).toHaveLength(1);
    expect(customers[0].appwrite_auth_id).toBe(ACTOR.authId);
    expect(customers[0].appwrite_user_document_id).toBe(ACTOR.userId);
  });

  it("enrols once across many transfers", async () => {
    await executeTransfer(ACTOR, intent());
    await executeTransfer(ACTOR, intent());
    await executeTransfer(ACTOR, intent());

    expect(await customerRows()).toHaveLength(1);
    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM transfers"
    );
    expect(rows[0].count).toBe("3");
  });

  it("enrols once when two first transfers arrive together", async () => {
    // GENUINELY PARALLEL. Both calls find no customer, both insert, and the
    // unique constraint on appwrite_auth_id decides. A sequential loop would
    // prove nothing about the window between the read and the write.
    const results = await Promise.allSettled([
      executeTransfer(ACTOR, intent()),
      executeTransfer(ACTOR, intent()),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);

    // One identity, two transfers. A second customer row would mean the same
    // person holds two independent balances and two independent credit limits.
    expect(await customerRows()).toHaveLength(1);
    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM transfers"
    );
    expect(rows[0].count).toBe("2");
  });
});

describe("a customer who is already enrolled", () => {
  it("is reused, not rewritten", async () => {
    const { row: seeded } = await upsertBankingCustomer({
      appwriteAuthId: ACTOR.authId,
      appwriteUserDocumentId: ACTOR.userId,
    });

    await executeTransfer(ACTOR, intent());

    const customers = await customerRows();
    expect(customers).toHaveLength(1);
    expect(customers[0].id).toBe(seeded.id);

    // MUTATION GUARD. Enrolment reads before it writes. Replacing that with a
    // bare upsert still passes every assertion above, because ON CONFLICT DO
    // UPDATE returns the same id — but it fires the updated_at trigger on every
    // transfer, and the column stops meaning "when this identity last changed".
    expect(customers[0].updated_at).toEqual(seeded.updated_at);
  });
});

describe("identity collisions", () => {
  it("refuses, and moves no money, when the auth id is bridged elsewhere", async () => {
    // The same login already maps to a DIFFERENT user document. Enrolling over
    // it would attach this transfer to the wrong person's ledger.
    await upsertBankingCustomer({
      appwriteAuthId: ACTOR.authId,
      appwriteUserDocumentId: "userdoc-someone-else",
    });

    await expect(executeTransfer(ACTOR, intent())).rejects.toThrow();

    // ATOMICITY. Enrolment shares the claim's transaction, so a refusal leaves
    // no transfer, no hold, and no second customer row.
    expect(await customerRows()).toHaveLength(1);
    const { rows: transfers } = await query("SELECT id FROM transfers");
    expect(transfers).toHaveLength(0);
    const { rows: holds } = await query("SELECT id FROM ledger_holds");
    expect(holds).toHaveLength(0);

    // And nothing reached the provider.
    expect(stub.createDwollaTransfer).not.toHaveBeenCalled();
  });
});

describe("enrolment does not weaken what was already proven", () => {
  it("still replays a repeated key to one financial effect", async () => {
    const fixed = intent();

    const first = await executeTransfer(ACTOR, fixed);
    const second = await executeTransfer(ACTOR, fixed);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe("submitted");

    // NOT asserting that the two calls return the same transactionId. They do
    // not: a fresh call returns the Appwrite transaction document id, a replay
    // returns the PostgreSQL transfer id. That is a real inconsistency in the
    // result DTO, and it is deliberately left alone here rather than pinned as
    // correct — this suite is about enrolment, and asserting the current
    // behaviour would make it harder to fix.
    //
    // One transfer, one hold, ONE provider call — however many times it is sent.
    const { rows: transfers } = await query("SELECT id FROM transfers");
    expect(transfers).toHaveLength(1);
    const { rows: holds } = await query("SELECT id FROM ledger_holds");
    expect(holds).toHaveLength(1);
    expect(stub.createDwollaTransfer).toHaveBeenCalledTimes(1);
    expect(await customerRows()).toHaveLength(1);
  });
});
