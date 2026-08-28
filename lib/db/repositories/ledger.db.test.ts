import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query, withTransaction } from "../pool";
import { ConstraintViolationError } from "../errors";
import { requireTestDatabase } from "../test-database";
import { upsertBankingCustomer } from "./banking-customers.repository";
import {
  balanceOf,
  ensureCustomerAccount,
  ensureSettlementAccount,
  entriesForTransaction,
  entriesForTransfer,
  postTransaction,
  totalAcrossAllAccounts,
} from "./ledger.repository";

/**
 * THE LEDGER INVARIANTS, AGAINST A REAL SERVER.
 *
 * Balance, conservation, immutability and atomicity are enforced by the schema,
 * so these assert the DATABASE rejects violations — not that a repository
 * remembered to check. A repository check protects only the paths that call it.
 *
 * Entry COUNTS are asserted alongside balances throughout: a double post can
 * leave a perfectly correct net balance.
 */

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query(
    `TRUNCATE ledger_entries, ledger_transactions, ledger_accounts,
              transfers, linked_accounts, banking_customers CASCADE`
  );
});

async function seedCustomer(n = 1): Promise<string> {
  const { row } = await upsertBankingCustomer({
    appwriteAuthId: `auth-${n}`,
    appwriteUserDocumentId: `user-doc-${n}`,
  });
  return row.id;
}

/** Two accounts, ready to move money between. */
async function seedAccounts() {
  const customerId = await seedCustomer();
  const customer = await ensureCustomerAccount(customerId);
  const settlement = await ensureSettlementAccount();
  return { customerId, customer, settlement };
}

/** Post a balanced pair: `amount` debited from a, credited to b. */
function pair(a: string, b: string, amountMinor: number) {
  return [
    { accountId: a, amountMinor },
    { accountId: b, amountMinor: -amountMinor },
  ];
}

describe("accounts", () => {
  it("creates a customer account on first use and finds it afterwards", async () => {
    const customerId = await seedCustomer();

    const first = await ensureCustomerAccount(customerId);
    const second = await ensureCustomerAccount(customerId);

    expect(second.id).toBe(first.id);
    expect(second.kind).toBe("customer");
  });

  it("creates exactly one settlement account", async () => {
    const first = await ensureSettlementAccount();
    const second = await ensureSettlementAccount();

    expect(second.id).toBe(first.id);
    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger_accounts WHERE kind = 'settlement'"
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("has NO balance column — balance is derived, never stored", async () => {
    const { rows } = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ledger_accounts'`
    );
    // A stored balance is a second source of truth that drifts silently.
    expect(rows.map((r) => r.column_name)).not.toContain("balance");
  });

  it("refuses a customer account with no owner", async () => {
    await expect(
      query(
        "INSERT INTO ledger_accounts (customer_id, kind) VALUES (NULL, 'customer')"
      )
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("refuses a settlement account WITH an owner", async () => {
    const customerId = await seedCustomer();

    await expect(
      query(
        "INSERT INTO ledger_accounts (customer_id, kind) VALUES ($1, 'settlement')",
        [customerId]
      )
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });
});

describe("INVARIANT: balanced entries", () => {
  it("accepts a posting whose entries sum to zero", async () => {
    const { customer, settlement } = await seedAccounts();

    const { transactionId } = await withTransaction((client) =>
      postTransaction(
        { description: "deposit", lines: pair(customer.id, settlement.id, 50_00) },
        client
      )
    );

    const entries = await entriesForTransaction(transactionId);
    expect(entries).toHaveLength(2);
    const sum = entries.reduce((n, e) => n + Number(e.amount_minor), 0);
    expect(sum).toBe(0);
  });

  it("REJECTS a posting that does not balance", async () => {
    const { customer, settlement } = await seedAccounts();

    await expect(
      withTransaction((client) =>
        postTransaction(
          {
            description: "unbalanced",
            lines: [
              { accountId: customer.id, amountMinor: 50_00 },
              { accountId: settlement.id, amountMinor: -49_00 },
            ],
          },
          client
        )
      )
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("REJECTS a single-sided posting", async () => {
    const { customer } = await seedAccounts();

    // Double entry means at least two sides, even if one line summed to zero
    // would technically balance.
    await expect(
      withTransaction((client) =>
        postTransaction(
          {
            description: "one-sided",
            lines: [{ accountId: customer.id, amountMinor: 50_00 }],
          },
          client
        )
      )
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("REJECTS a zero-amount entry", async () => {
    const { customer, settlement } = await seedAccounts();

    await expect(
      withTransaction((client) =>
        postTransaction(
          {
            description: "noise",
            lines: [
              { accountId: customer.id, amountMinor: 0 },
              { accountId: settlement.id, amountMinor: 0 },
            ],
          },
          client
        )
      )
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("accepts a balanced posting with more than two lines", async () => {
    const { customer, settlement } = await seedAccounts();
    const other = await ensureCustomerAccount(await seedCustomer(2));

    const { transactionId } = await withTransaction((client) =>
      postTransaction(
        {
          description: "split",
          lines: [
            { accountId: settlement.id, amountMinor: 100_00 },
            { accountId: customer.id, amountMinor: -60_00 },
            { accountId: other.id, amountMinor: -40_00 },
          ],
        },
        client
      )
    );

    expect(await entriesForTransaction(transactionId)).toHaveLength(3);
  });
});

describe("INVARIANT: atomicity", () => {
  it("a rejected posting leaves ZERO partial entries", async () => {
    const { customer, settlement } = await seedAccounts();

    await withTransaction((client) =>
      postTransaction(
        {
          description: "unbalanced",
          lines: [
            { accountId: customer.id, amountMinor: 50_00 },
            { accountId: settlement.id, amountMinor: -1_00 },
          ],
        },
        client
      )
    ).catch(() => undefined);

    // The first line really was inserted before the deferred check fired. It
    // must not survive.
    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger_entries"
    );
    expect(Number(rows[0].count)).toBe(0);
    expect(await balanceOf(customer.id)).toBe(0);
  });

  it("leaves no orphaned transaction row either", async () => {
    const { customer, settlement } = await seedAccounts();

    await withTransaction((client) =>
      postTransaction(
        {
          description: "unbalanced",
          lines: [
            { accountId: customer.id, amountMinor: 5 },
            { accountId: settlement.id, amountMinor: -4 },
          ],
        },
        client
      )
    ).catch(() => undefined);

    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger_transactions"
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});

describe("INVARIANT: conservation", () => {
  it("an internal transfer leaves total money unchanged", async () => {
    const { customer, settlement } = await seedAccounts();
    const other = await ensureCustomerAccount(await seedCustomer(2));

    // Fund the customer first.
    await withTransaction((client) =>
      postTransaction(
        { description: "fund", lines: pair(customer.id, settlement.id, 100_00) },
        client
      )
    );
    const before = await totalAcrossAllAccounts();

    await withTransaction((client) =>
      postTransaction(
        { description: "internal", lines: pair(other.id, customer.id, 30_00) },
        client
      )
    );

    expect(await totalAcrossAllAccounts()).toBe(before);
    expect(await balanceOf(customer.id)).toBe(70_00);
    expect(await balanceOf(other.id)).toBe(30_00);
  });

  it("total across all accounts is always zero", async () => {
    const { customer, settlement } = await seedAccounts();

    for (const amount of [10_00, 250, 7, 99_99]) {
      await withTransaction((client) =>
        postTransaction(
          { description: `move ${amount}`, lines: pair(customer.id, settlement.id, amount) },
          client
        )
      );
    }

    // Every posting balances, so the whole ledger nets to nothing. A non-zero
    // total means an entry exists outside a balanced pair.
    expect(await totalAcrossAllAccounts()).toBe(0);
  });

  it("balances are exact at the cent across many small postings", async () => {
    const { customer, settlement } = await seedAccounts();

    for (let i = 0; i < 100; i += 1) {
      await withTransaction((client) =>
        postTransaction(
          { description: `cent ${i}`, lines: pair(customer.id, settlement.id, 1) },
          client
        )
      );
    }

    // 100 x 1 minor unit. A float ledger drifts here; integers do not.
    expect(await balanceOf(customer.id)).toBe(100);
    expect(await balanceOf(settlement.id)).toBe(-100);
  });
});

describe("INVARIANT: immutability", () => {
  it("REJECTS an update to a posted entry", async () => {
    const { customer, settlement } = await seedAccounts();
    const { entries } = await withTransaction((client) =>
      postTransaction(
        { description: "posted", lines: pair(customer.id, settlement.id, 10_00) },
        client
      )
    );

    await expect(
      query("UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1", [entries[0].id])
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("REJECTS a delete of a posted entry", async () => {
    const { customer, settlement } = await seedAccounts();
    const { entries } = await withTransaction((client) =>
      postTransaction(
        { description: "posted", lines: pair(customer.id, settlement.id, 10_00) },
        client
      )
    );

    await expect(
      query("DELETE FROM ledger_entries WHERE id = $1", [entries[0].id])
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("leaves the balance untouched after a rejected mutation", async () => {
    const { customer, settlement } = await seedAccounts();
    const { entries } = await withTransaction((client) =>
      postTransaction(
        { description: "posted", lines: pair(customer.id, settlement.id, 10_00) },
        client
      )
    );

    await query("UPDATE ledger_entries SET amount_minor = 999 WHERE id = $1", [
      entries[0].id,
    ]).catch(() => undefined);

    expect(await balanceOf(customer.id)).toBe(10_00);
  });
});

describe("INVARIANT: compensation", () => {
  it("a reversal creates opposing entries and leaves the originals intact", async () => {
    const { customer, settlement } = await seedAccounts();
    const original = await withTransaction((client) =>
      postTransaction(
        { description: "original", lines: pair(customer.id, settlement.id, 40_00) },
        client
      )
    );

    await withTransaction((client) =>
      postTransaction(
        { description: "reversal", lines: pair(settlement.id, customer.id, 40_00) },
        client
      )
    );

    // Originals still there, balance restored, and BOTH postings visible.
    expect(await entriesForTransaction(original.transactionId)).toHaveLength(2);
    expect(await balanceOf(customer.id)).toBe(0);

    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger_entries"
    );
    expect(Number(rows[0].count)).toBe(4);
  });
});

describe("INVARIANT: idempotence — one posting per transfer", () => {
  async function seedTransfer(customerId: string): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO transfers (
         customer_id, idempotency_key, request_fingerprint,
         state, amount_minor, currency
       )
       VALUES ($1, '11111111-1111-4111-8111-111111111111', 'fp', 'requested', 2500, 'USD')
       RETURNING id`,
      [customerId]
    );
    return rows[0].id;
  }

  it("REJECTS a second posting for the same transfer", async () => {
    const { customerId, customer, settlement } = await seedAccounts();
    const transferId = await seedTransfer(customerId);

    await withTransaction((client) =>
      postTransaction(
        {
          description: "transfer",
          transferId,
          lines: pair(customer.id, settlement.id, 25_00),
        },
        client
      )
    );

    // The last defence against a double post, below every application layer.
    await expect(
      withTransaction((client) =>
        postTransaction(
          {
            description: "transfer again",
            transferId,
            lines: pair(customer.id, settlement.id, 25_00),
          },
          client
        )
      )
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("a rejected second posting adds no entries", async () => {
    const { customerId, customer, settlement } = await seedAccounts();
    const transferId = await seedTransfer(customerId);

    await withTransaction((client) =>
      postTransaction(
        { description: "transfer", transferId, lines: pair(customer.id, settlement.id, 25_00) },
        client
      )
    );

    await withTransaction((client) =>
      postTransaction(
        { description: "again", transferId, lines: pair(customer.id, settlement.id, 25_00) },
        client
      )
    ).catch(() => undefined);

    // Entry COUNT, not just balance: a double post can net out correctly.
    expect(await entriesForTransfer(transferId)).toHaveLength(2);
    expect(await balanceOf(customer.id)).toBe(25_00);
  });

  it("allows many postings that are NOT tied to a transfer", async () => {
    const { customer, settlement } = await seedAccounts();

    for (let i = 0; i < 3; i += 1) {
      await withTransaction((client) =>
        postTransaction(
          { description: `adjustment ${i}`, lines: pair(customer.id, settlement.id, 100) },
          client
        )
      );
    }

    // UNIQUE permits many NULLs, which is what house adjustments need.
    expect(await balanceOf(customer.id)).toBe(300);
  });
});

describe("concurrency", () => {
  it("parallel postings all land, and the ledger still nets to zero", async () => {
    const { customer, settlement } = await seedAccounts();

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withTransaction((client) =>
          postTransaction(
            { description: `parallel ${i}`, lines: pair(customer.id, settlement.id, 5_00) },
            client
          )
        )
      )
    );

    expect(await balanceOf(customer.id)).toBe(40_00);
    expect(await totalAcrossAllAccounts()).toBe(0);
    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger_entries"
    );
    expect(Number(rows[0].count)).toBe(16);
  });

  it("only one of two parallel postings for one transfer survives", async () => {
    const { customerId, customer, settlement } = await seedAccounts();
    const { rows } = await query<{ id: string }>(
      `INSERT INTO transfers (
         customer_id, idempotency_key, request_fingerprint,
         state, amount_minor, currency
       )
       VALUES ($1, '22222222-2222-4222-8222-222222222222', 'fp', 'requested', 2500, 'USD')
       RETURNING id`,
      [customerId]
    );
    const transferId = rows[0].id;

    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        withTransaction((client) =>
          postTransaction(
            { description: "race", transferId, lines: pair(customer.id, settlement.id, 25_00) },
            client
          )
        )
      )
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await entriesForTransfer(transferId)).toHaveLength(2);
  });
});
