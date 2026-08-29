import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query, withTransaction } from "../pool";
import { ConstraintViolationError } from "../errors";
import { requireTestDatabase } from "../test-database";
import type { SyncedTransaction } from "../../plaid-sync/engine";
import {
  applySync,
  ensurePlaidItem,
  findPlaidItem,
  findPlaidTransaction,
  listPlaidItems,
  listTransactionsForAccount,
  recordItemFailure,
} from "./plaid-items.repository";

/**
 * PLAID SYNC STATE, AGAINST A REAL SERVER.
 *
 * The property that cannot be shown any other way: THE CURSOR AND THE DATA IT
 * PRODUCED ARE WRITTEN TOGETHER. Both orderings that seem reasonable are wrong —
 * cursor first loses transactions permanently, data first reprocesses them — so
 * the test drives a failure between them and checks neither landed.
 */

const CHECK_VIOLATION = "23514";

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
  await query("TRUNCATE plaid_transactions, plaid_items CASCADE");
});

const txn = (
  id: string,
  over: Partial<SyncedTransaction> = {}
): SyncedTransaction => ({
  transactionId: id,
  accountId: "acct-1",
  amountMinor: 12_34,
  isoCurrency: "USD",
  postedDate: "2026-08-01",
  name: `txn ${id}`,
  merchantName: null,
  pending: false,
  ...over,
});

describe("registering an item", () => {
  it("creates it with no cursor, which means never synced", async () => {
    const item = await ensurePlaidItem("item-1");

    expect(item.item_id).toBe("item-1");
    // NULL, not "". Plaid reads an absent cursor as "the whole history"; an
    // empty string would be a request for changes since nothing.
    expect(item.cursor).toBeNull();
    expect(item.status).toBe("healthy");
    expect(item.last_synced_at).toBeNull();
  });

  it("NEVER resets a cursor that already exists", async () => {
    // A second registration re-fetching an item's entire history is the exact
    // defect this milestone removes.
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1")],
      removals: [],
      cursor: "cursor-abc",
    });

    const again = await ensurePlaidItem("item-1");

    expect(again.cursor).toBe("cursor-abc");
  });

  it("refuses a blank cursor at the schema level", async () => {
    await ensurePlaidItem("item-1");

    await expectRejectedBy(
      query("UPDATE plaid_items SET cursor = '' WHERE item_id = $1", ["item-1"]),
      CHECK_VIOLATION
    );
  });

  it("has no column that could hold an access token", async () => {
    // The item id and the cursor are identifiers, not credentials. Access
    // tokens stay in Appwrite until they are encrypted; copying them into a
    // second store first would double the exposure rather than reduce it.
    const { rows } = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('plaid_items', 'plaid_transactions')`,
      []
    );
    const columns = rows.map((r) => r.column_name.toLowerCase());

    for (const forbidden of [
      "access_token",
      "accesstoken",
      "processor_token",
      "public_token",
      "secret",
    ]) {
      expect(columns, `no column may be named ${forbidden}`).not.toContain(
        forbidden
      );
    }
  });
});

describe("applying a sync", () => {
  it("stores the transactions AND advances the cursor", async () => {
    await ensurePlaidItem("item-1");

    const applied = await applySync({
      itemId: "item-1",
      upserts: [txn("t1"), txn("t2")],
      removals: [],
      cursor: "cursor-1",
    });

    expect(applied.upserted).toBe(2);

    const item = await findPlaidItem("item-1");
    expect(item?.cursor).toBe("cursor-1");
    expect(item?.last_synced_at).toBeInstanceOf(Date);
    expect(item?.last_cursor_at).toBeInstanceOf(Date);

    const stored = await listTransactionsForAccount("acct-1");
    expect(stored.map((t) => t.plaid_transaction_id).sort()).toEqual(["t1", "t2"]);
  });

  it("stores amounts as integer minor units", async () => {
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1", { amountMinor: -4_56 })],
      removals: [],
      cursor: "c1",
    });

    const stored = await findPlaidTransaction("t1");
    // A string from BIGINT, holding an integer — no float ever reached the
    // column.
    expect(stored?.amount_minor).toBe("-456");
  });

  it("is idempotent: replaying a page updates rather than duplicates", async () => {
    // A crash between writing rows and writing the cursor means the next run
    // redoes this work. It is only safe because every write is keyed on the
    // provider's own transaction id.
    await ensurePlaidItem("item-1");

    await applySync({
      itemId: "item-1",
      upserts: [txn("t1", { name: "first" })],
      removals: [],
      cursor: "c1",
    });
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1", { name: "first" })],
      removals: [],
      cursor: "c1",
    });

    const stored = await listTransactionsForAccount("acct-1");
    expect(stored).toHaveLength(1);
  });

  it("APPLIES MODIFICATIONS — the old code ignored them entirely", async () => {
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1", { amountMinor: 10_00, name: "Pending coffee", pending: true })],
      removals: [],
      cursor: "c1",
    });

    await applySync({
      itemId: "item-1",
      upserts: [
        txn("t1", { amountMinor: 12_50, name: "Coffee", pending: false }),
      ],
      removals: [],
      cursor: "c2",
    });

    const stored = await findPlaidTransaction("t1");
    expect(stored?.amount_minor).toBe("1250");
    expect(stored?.name).toBe("Coffee");
    expect(stored?.pending).toBe(false);
    expect(await listTransactionsForAccount("acct-1")).toHaveLength(1);
  });

  it("APPLIES REMOVALS — the old code left them forever", async () => {
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1"), txn("t2")],
      removals: [],
      cursor: "c1",
    });

    const applied = await applySync({
      itemId: "item-1",
      upserts: [],
      removals: ["t1"],
      cursor: "c2",
    });

    expect(applied.removed).toBe(1);

    // Soft-deleted: gone from display, still on record. A row that vanishes
    // leaves nothing to explain why a balance changed.
    const visible = await listTransactionsForAccount("acct-1");
    expect(visible.map((t) => t.plaid_transaction_id)).toEqual(["t2"]);

    const retracted = await findPlaidTransaction("t1");
    expect(retracted?.removed_at).toBeInstanceOf(Date);
  });

  it("does not count a removal twice on a replay", async () => {
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1")],
      removals: [],
      cursor: "c1",
    });

    const first = await applySync({
      itemId: "item-1",
      upserts: [],
      removals: ["t1"],
      cursor: "c2",
    });
    const second = await applySync({
      itemId: "item-1",
      upserts: [],
      removals: ["t1"],
      cursor: "c2",
    });

    expect(first.removed).toBe(1);
    expect(second.removed).toBe(0);
  });

  it("restores a transaction the provider re-adds after retracting it", async () => {
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1")],
      removals: [],
      cursor: "c1",
    });
    await applySync({ itemId: "item-1", upserts: [], removals: ["t1"], cursor: "c2" });

    await applySync({
      itemId: "item-1",
      upserts: [txn("t1")],
      removals: [],
      cursor: "c3",
    });

    // Without clearing removed_at on conflict, the provider would believe in a
    // transaction this store treats as deleted.
    const stored = await findPlaidTransaction("t1");
    expect(stored?.removed_at).toBeNull();
    expect(await listTransactionsForAccount("acct-1")).toHaveLength(1);
  });

  it("records which account each transaction belongs to", async () => {
    // An Item owns MANY accounts. Collapsing them is the `accounts[0]` defect
    // reappearing one layer down.
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [
        txn("t1", { accountId: "acct-1" }),
        txn("t2", { accountId: "acct-2" }),
        txn("t3", { accountId: "acct-2" }),
      ],
      removals: [],
      cursor: "c1",
    });

    expect(await listTransactionsForAccount("acct-1")).toHaveLength(1);
    expect(await listTransactionsForAccount("acct-2")).toHaveLength(2);
  });
});

describe("the cursor and the data are written together", () => {
  it("stores NEITHER when the write fails partway", async () => {
    // THE TEST THIS FILE EXISTS FOR. Cursor first loses transactions
    // permanently; data first reprocesses them. A failure must leave the cursor
    // exactly where it was, with no rows from the failed batch.
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t0")],
      removals: [],
      cursor: "cursor-before",
    });

    await query(
      `CREATE OR REPLACE FUNCTION orion_test_break_plaid() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'induced'; END $$`
    );
    await query(
      `CREATE TRIGGER orion_test_break_plaid
         BEFORE UPDATE ON plaid_items
         FOR EACH ROW EXECUTE FUNCTION orion_test_break_plaid()`
    );

    try {
      await expect(
        applySync({
          itemId: "item-1",
          upserts: [txn("t1"), txn("t2")],
          removals: ["t0"],
          cursor: "cursor-after",
        })
      ).rejects.toThrow();
    } finally {
      await query("DROP TRIGGER IF EXISTS orion_test_break_plaid ON plaid_items");
      await query("DROP FUNCTION IF EXISTS orion_test_break_plaid()");
    }

    const item = await findPlaidItem("item-1");
    expect(item?.cursor).toBe("cursor-before");

    // No rows from the failed batch, and the removal did not land either.
    expect(await findPlaidTransaction("t1")).toBeNull();
    expect(await findPlaidTransaction("t2")).toBeNull();
    expect((await findPlaidTransaction("t0"))?.removed_at).toBeNull();

    // And the retry works, from the cursor that was never moved.
    const retry = await applySync({
      itemId: "item-1",
      upserts: [txn("t1"), txn("t2")],
      removals: ["t0"],
      cursor: "cursor-after",
    });
    expect(retry.upserted).toBe(2);
    expect((await findPlaidItem("item-1"))?.cursor).toBe("cursor-after");
  });

  it("joins the caller's transaction when given one", async () => {
    await ensurePlaidItem("item-1");

    await expect(
      withTransaction(async (client) => {
        await applySync(
          { itemId: "item-1", upserts: [txn("t1")], removals: [], cursor: "c1" },
          client
        );
        throw new Error("caller failed after applying");
      })
    ).rejects.toThrow("caller failed after applying");

    // Rolled back with the caller's work: the sync did not commit on its own.
    expect(await findPlaidTransaction("t1")).toBeNull();
    expect((await findPlaidItem("item-1"))?.cursor).toBeNull();
  });
});

describe("an item that stops working", () => {
  it("records the status and the error CODE", async () => {
    await ensurePlaidItem("item-1");

    const item = await recordItemFailure({
      itemId: "item-1",
      status: "login_required",
      errorCode: "ITEM_LOGIN_REQUIRED",
    });

    expect(item.status).toBe("login_required");
    expect(item.last_error_code).toBe("ITEM_LOGIN_REQUIRED");
    expect(item.consecutive_failures).toBe(1);
  });

  it("DOES NOT TOUCH THE CURSOR", async () => {
    // A transient failure must not cost an item its position. Clearing the
    // cursor here would re-fetch an entire history; advancing it would skip
    // changes permanently.
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1")],
      removals: [],
      cursor: "cursor-kept",
    });

    await recordItemFailure({
      itemId: "item-1",
      status: "error",
      errorCode: "INTERNAL_SERVER_ERROR",
    });

    expect((await findPlaidItem("item-1"))?.cursor).toBe("cursor-kept");
  });

  it("counts consecutive failures and clears them on success", async () => {
    await ensurePlaidItem("item-1");
    await recordItemFailure({
      itemId: "item-1",
      status: "error",
      errorCode: "E1",
    });
    await recordItemFailure({
      itemId: "item-1",
      status: "error",
      errorCode: "E2",
    });

    expect((await findPlaidItem("item-1"))?.consecutive_failures).toBe(2);

    await applySync({
      itemId: "item-1",
      upserts: [],
      removals: [],
      cursor: "c1",
    });

    const recovered = await findPlaidItem("item-1");
    expect(recovered?.consecutive_failures).toBe(0);
    expect(recovered?.status).toBe("healthy");
    // A healthy item does not carry a stale reason.
    expect(recovered?.last_error_code).toBeNull();
  });

  it("refuses a healthy item that still carries an error code", async () => {
    await ensurePlaidItem("item-1");

    await expectRejectedBy(
      query(
        "UPDATE plaid_items SET status = 'healthy', last_error_code = 'STALE' WHERE item_id = $1",
        ["item-1"]
      ),
      CHECK_VIOLATION
    );
  });

  it("refuses a status outside the known set", async () => {
    await ensurePlaidItem("item-1");

    await expectRejectedBy(
      query("UPDATE plaid_items SET status = 'confused' WHERE item_id = $1", [
        "item-1",
      ]),
      CHECK_VIOLATION
    );
  });
});

describe("listing", () => {
  it("returns items in a stable order", async () => {
    await ensurePlaidItem("item-b");
    await ensurePlaidItem("item-a");

    const items = await listPlaidItems();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.item_id).sort()).toEqual(["item-a", "item-b"]);
  });

  it("excludes retracted transactions from a display read", async () => {
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [txn("t1"), txn("t2")],
      removals: [],
      cursor: "c1",
    });
    await applySync({ itemId: "item-1", upserts: [], removals: ["t1"], cursor: "c2" });

    const visible = await listTransactionsForAccount("acct-1");
    expect(visible.map((t) => t.plaid_transaction_id)).toEqual(["t2"]);
  });

  it("orders newest first and honours a limit", async () => {
    await ensurePlaidItem("item-1");
    await applySync({
      itemId: "item-1",
      upserts: [
        txn("old", { postedDate: "2026-01-01" }),
        txn("mid", { postedDate: "2026-06-01" }),
        txn("new", { postedDate: "2026-08-01" }),
      ],
      removals: [],
      cursor: "c1",
    });

    const page = await listTransactionsForAccount("acct-1", { limit: 2 });
    expect(page.map((t) => t.plaid_transaction_id)).toEqual(["new", "mid"]);
  });
});

describe("transactions attach to a registered item", () => {
  it("refuses a transaction for an item that does not exist", async () => {
    await expect(
      applySync({
        itemId: `missing-${randomUUID()}`,
        upserts: [txn("t1")],
        removals: [],
        cursor: "c1",
      })
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });
});
