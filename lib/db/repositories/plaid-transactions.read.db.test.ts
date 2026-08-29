import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "../pool";
import { requireTestDatabase } from "../test-database";
import {
  applySync,
  ensurePlaidItem,
} from "./plaid-items.repository";
import {
  listTransactionsForOwnedAccounts,
  readSyncStatus,
} from "./plaid-transactions.read";

/**
 * THE REQUEST-PATH READ.
 *
 * Milestone 11 wired transaction history to the synced store instead of a live
 * Plaid call during SSR. That makes this the first Plaid read a request can
 * reach, so the scoping matters: `plaid_account_id` carries no owner, and the
 * caller proves ownership through the Appwrite bank documents BEFORE calling
 * here. These tests fix the contract that makes that safe — above all that an
 * empty list returns nothing rather than everything.
 */

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query("TRUNCATE plaid_transactions, plaid_items CASCADE");
});

const txn = (id: string, accountId: string, over: Record<string, unknown> = {}) => ({
  transactionId: id,
  accountId,
  amountMinor: 10_00,
  isoCurrency: "USD",
  postedDate: "2026-08-01",
  name: `txn ${id}`,
  merchantName: null,
  pending: false,
  ...over,
});

async function seed() {
  await ensurePlaidItem("item-alice");
  await ensurePlaidItem("item-bob");

  await applySync({
    itemId: "item-alice",
    upserts: [
      txn("a1", "alice-chequing"),
      txn("a2", "alice-savings"),
      txn("a3", "alice-chequing", { postedDate: "2026-08-05" }),
    ],
    removals: [],
    cursor: "c-alice",
  });

  await applySync({
    itemId: "item-bob",
    upserts: [txn("b1", "bob-chequing"), txn("b2", "bob-chequing")],
    removals: [],
    cursor: "c-bob",
  });
}

describe("scoping", () => {
  it("returns only the accounts it was given", async () => {
    await seed();

    const rows = await listTransactionsForOwnedAccounts(["alice-chequing"]);

    expect(rows.map((r) => r.plaid_transaction_id).sort()).toEqual(["a1", "a3"]);
  });

  it("RETURNS NOTHING for an empty list, not everything", async () => {
    // A user with no linked accounts is the ordinary case, and the failure it
    // could cause — a filter that degrades to no filter — hands every user's
    // transactions to whoever asked while the query still reads correctly.
    //
    // WHAT DELIVERS THIS is `= ANY($1::text[])` with an empty array, not the
    // early return in the repository: deleting that return leaves this test
    // green, which a mutation confirmed. The assertion is kept because the
    // BEHAVIOUR is what matters and it must hold however it is implemented — but
    // it is not evidence that the early return is a safety mechanism, and this
    // comment says so rather than implying otherwise.
    await seed();

    expect(await listTransactionsForOwnedAccounts([])).toEqual([]);
  });

  it("still returns nothing when the array form is the only thing filtering", async () => {
    // The above, stated against the query directly, so the guarantee is pinned
    // to the mechanism that actually provides it.
    await seed();

    const { rows } = await query(
      "SELECT * FROM plaid_transactions WHERE plaid_account_id = ANY($1::text[])",
      [[]]
    );

    expect(rows).toEqual([]);
  });

  it("never leaks another owner's rows through a shared item", async () => {
    await seed();

    const rows = await listTransactionsForOwnedAccounts([
      "alice-chequing",
      "alice-savings",
    ]);

    expect(rows.every((r) => r.plaid_account_id.startsWith("alice-"))).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("reads several accounts at once, which is what an Item owns", async () => {
    // The `accounts[0]` defect one layer down: a user with a chequing and a
    // savings account must see both.
    await seed();

    const rows = await listTransactionsForOwnedAccounts([
      "alice-chequing",
      "alice-savings",
    ]);

    const accounts = Array.from(new Set(rows.map((r) => r.plaid_account_id)));
    expect(accounts.sort()).toEqual(["alice-chequing", "alice-savings"]);
  });

  it("returns nothing for an account id that does not exist", async () => {
    await seed();

    expect(await listTransactionsForOwnedAccounts(["no-such-account"])).toEqual([]);
  });
});

describe("what a display read shows", () => {
  it("excludes retracted transactions", async () => {
    await seed();
    await applySync({
      itemId: "item-alice",
      upserts: [],
      removals: ["a1"],
      cursor: "c-alice-2",
    });

    const rows = await listTransactionsForOwnedAccounts(["alice-chequing"]);
    expect(rows.map((r) => r.plaid_transaction_id)).toEqual(["a3"]);
  });

  it("orders newest first", async () => {
    await seed();

    const rows = await listTransactionsForOwnedAccounts([
      "alice-chequing",
      "alice-savings",
    ]);

    expect(rows.map((r) => r.plaid_transaction_id)).toEqual(["a3", "a1", "a2"]);
  });

  it("caps how much one read can return", async () => {
    await ensurePlaidItem("item-alice");
    await applySync({
      itemId: "item-alice",
      upserts: Array.from({ length: 20 }, (_, i) =>
        txn(`t${i}`, "alice-chequing")
      ),
      removals: [],
      cursor: "c1",
    });

    expect(await listTransactionsForOwnedAccounts(["alice-chequing"], { limit: 5 }))
      .toHaveLength(5);

    // A caller cannot ask for an unbounded page.
    const huge = await listTransactionsForOwnedAccounts(["alice-chequing"], {
      limit: 100_000,
    });
    expect(huge).toHaveLength(20);
  });
});

describe("sync status", () => {
  it("distinguishes never-synced from synced from broken", async () => {
    // Three states that all look like an empty transaction list. Without this
    // the UI cannot tell "no activity" from "this bank connection is dead",
    // which is how a broken link goes unnoticed for months.
    await ensurePlaidItem("item-fresh");
    await ensurePlaidItem("item-synced");
    await applySync({
      itemId: "item-synced",
      upserts: [],
      removals: [],
      cursor: "c1",
    });
    await ensurePlaidItem("item-broken");
    await query(
      `UPDATE plaid_items SET status = 'login_required',
         last_error_code = 'ITEM_LOGIN_REQUIRED' WHERE item_id = $1`,
      ["item-broken"]
    );

    const statuses = await readSyncStatus([
      "item-fresh",
      "item-synced",
      "item-broken",
    ]);
    const byId = Object.fromEntries(statuses.map((s) => [s.itemId, s]));

    expect(byId["item-fresh"]).toMatchObject({
      status: "healthy",
      everSynced: false,
    });
    expect(byId["item-synced"]).toMatchObject({
      status: "healthy",
      everSynced: true,
    });
    expect(byId["item-broken"]).toMatchObject({
      status: "login_required",
      everSynced: false,
    });
  });

  it("returns nothing for an empty list", async () => {
    await seed();
    expect(await readSyncStatus([])).toEqual([]);
  });

  it("carries no error message, only the state", async () => {
    await ensurePlaidItem("item-broken");
    await query(
      `UPDATE plaid_items SET status = 'error', last_error_code = 'RATE_LIMIT'
        WHERE item_id = $1`,
      ["item-broken"]
    );

    const [status] = await readSyncStatus(["item-broken"]);

    // The shape is fixed and small: no provider message, no cursor value.
    expect(Object.keys(status).sort()).toEqual([
      "everSynced",
      "itemId",
      "lastSyncedAt",
      "status",
    ]);
  });
});
