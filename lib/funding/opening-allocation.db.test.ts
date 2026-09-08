import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query, withTransaction } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import {
  balanceOf,
  ensureCustomerAccount,
  ensureOpeningEquityAccount,
  totalAcrossAllAccounts,
} from "../db/repositories/ledger.repository";
import { allocateOpening } from "./opening-allocation";

/**
 * THE ONLY CODE THAT CREATES MONEY, tested against a real server.
 *
 * Everything else in this system moves money that already exists. This posts a
 * credit with no corresponding debit from another customer, which is exactly
 * why the equity account and the uniqueness guard matter: without them a
 * re-run mints funds and nothing notices.
 */

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

let seq = 0;
async function customer() {
  seq += 1;
  const { row } = await upsertBankingCustomer({
    appwriteAuthId: `auth-alloc-${seq}`,
    appwriteUserDocumentId: `doc-alloc-${seq}`,
  });
  return row;
}

describe("allocating an opening balance", () => {
  it("credits the customer and debits equity, summing to zero", async () => {
    const c = await customer();

    const outcome = await withTransaction((client) =>
      allocateOpening(
        { customerId: c.id, amountMinor: 100_00, sourceReference: `snap:${c.id}` },
        client
      )
    );

    expect(outcome.kind).toBe("posted");

    const account = await ensureCustomerAccount(c.id);
    const equity = await ensureOpeningEquityAccount();

    expect(await balanceOf(account.id)).toBe(100_00);
    expect(await balanceOf(equity.id)).toBe(-100_00);

    // The system as a whole created nothing: the credit is matched by an
    // explicit claim against equity, which is what makes it auditable.
    expect(await totalAcrossAllAccounts()).toBe(0);
  });

  it("NEVER touches the settlement account", async () => {
    // Settlement is money in flight to and from the provider. Seeded capital
    // landing there would destroy the one balance whose job is to say how much
    // is genuinely moving.
    const c = await customer();
    await withTransaction((client) =>
      allocateOpening(
        { customerId: c.id, amountMinor: 50_00, sourceReference: `snap:${c.id}` },
        client
      )
    );

    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'settlement'`
    );
    expect(rows[0].n).toBe("0");
  });

  it("posts once for a source, however many times it runs", async () => {
    // THE GUARD THAT MATTERS. A re-run of a seeding script is normal; minting a
    // second opening balance because of one is not.
    const c = await customer();
    const reference = `snap:${c.id}`;

    const first = await withTransaction((client) =>
      allocateOpening({ customerId: c.id, amountMinor: 100_00, sourceReference: reference }, client)
    );
    const second = await withTransaction((client) =>
      allocateOpening({ customerId: c.id, amountMinor: 100_00, sourceReference: reference }, client)
    );

    expect(first.kind).toBe("posted");
    expect(second.kind).toBe("already-allocated");

    const account = await ensureCustomerAccount(c.id);
    expect(await balanceOf(account.id)).toBe(100_00);
    const { rows } = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ledger_transactions WHERE kind = 'opening_allocation'"
    );
    expect(rows[0].n).toBe("1");
  });

  it("lets the database decide uniqueness, not the read above it", async () => {
    // Two allocations racing the same reference both see no existing row. The
    // unique index is what makes exactly one of them land.
    const c = await customer();
    const reference = `snap:${c.id}`;

    const results = await Promise.allSettled([
      withTransaction((client) =>
        allocateOpening({ customerId: c.id, amountMinor: 100_00, sourceReference: reference }, client)
      ),
      withTransaction((client) =>
        allocateOpening({ customerId: c.id, amountMinor: 100_00, sourceReference: reference }, client)
      ),
    ]);

    const posted = results.filter(
      (r) => r.status === "fulfilled" && r.value.kind === "posted"
    );
    expect(posted).toHaveLength(1);

    const account = await ensureCustomerAccount(c.id);
    expect(await balanceOf(account.id)).toBe(100_00);
  });

  it("refuses a non-positive amount", async () => {
    // Zero posts nothing; a negative is a withdrawal wearing the wrong name.
    const c = await customer();

    for (const amountMinor of [0, -1, 1.5]) {
      await expect(
        withTransaction((client) =>
          allocateOpening(
            { customerId: c.id, amountMinor, sourceReference: `snap:${c.id}:${amountMinor}` },
            client
          )
        )
      ).rejects.toThrow();
    }

    const { rows } = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ledger_transactions"
    );
    expect(rows[0].n).toBe("0");
  });

  it("refuses an allocation that names no source", async () => {
    const c = await customer();

    await expect(
      withTransaction((client) =>
        allocateOpening({ customerId: c.id, amountMinor: 100_00, sourceReference: "  " }, client)
      )
    ).rejects.toThrow();
  });

  it("is distinguishable from a settlement forever", async () => {
    // "How did this customer come to have money" is the first question a
    // reconciler and an auditor both ask. The kind answers it without needing
    // to infer anything from the amount or the date.
    const c = await customer();
    await withTransaction((client) =>
      allocateOpening(
        { customerId: c.id, amountMinor: 100_00, sourceReference: `snap:${c.id}` },
        client
      )
    );

    const { rows } = await query<{ kind: string; source_reference: string | null; transfer_id: string | null }>(
      "SELECT kind, source_reference, transfer_id FROM ledger_transactions"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("opening_allocation");
    expect(rows[0].source_reference).toBe(`snap:${c.id}`);
    // An allocation belongs to no transfer, and the schema enforces it.
    expect(rows[0].transfer_id).toBeNull();
  });
});
