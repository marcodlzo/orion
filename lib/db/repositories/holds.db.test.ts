import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, getPool, query, withTransaction } from "../pool";
import { ConstraintViolationError } from "../errors";
import { requireTestDatabase } from "../test-database";
import { CUSTOMER_CREDIT_LIMIT_MINOR } from "../../domain/limits";
import { upsertBankingCustomer } from "./banking-customers.repository";
import { claimTransfer, markSubmitted } from "./transfers.repository";
import {
  ensureCustomerAccount,
  ensureSettlementAccount,
  postTransaction,
} from "./ledger.repository";
import {
  activeHoldTotal,
  availableBalanceOf,
  captureHold,
  findHoldByTransfer,
  placeHold,
  releaseHold,
} from "./holds.repository";

/**
 * HOLDS AND AVAILABLE BALANCE, AGAINST A REAL SERVER.
 *
 * The property that matters here — two requests cannot both spend the same
 * money — is a property of row locking under real transaction isolation. A
 * sequential loop, or a mocked client, proves nothing about it: every one of
 * these would pass against an implementation with no lock at all.
 */

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query(
    `TRUNCATE ledger_holds, ledger_entries, ledger_transactions, ledger_accounts,
              provider_webhook_events, transfers, linked_accounts,
              banking_customers CASCADE`
  );
});

/**
 * SQLSTATEs, so a rejection test says WHICH guard fired.
 *
 * The classified error deliberately carries no driver message — a PostgreSQL
 * error quotes the offending row — so `toBeInstanceOf(ConstraintViolationError)`
 * alone cannot tell a trigger from a CHECK from a unique index. SQLSTATE is
 * documented as safe to log and distinguishes them.
 */
const RESTRICT_VIOLATION = "23001"; // a guard trigger raised
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

/** Assert the write was rejected by the specific guard named by `sqlState`. */
async function expectRejectedBy(
  promise: Promise<unknown>,
  sqlState: string
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ConstraintViolationError);
  const error = await promise.catch((e: unknown) => e);
  expect((error as ConstraintViolationError).sqlState).toBe(sqlState);
}

/** A customer with a ledger account whose limit is set for the case at hand. */
async function seedAccount(creditLimitMinor: number, n = 1) {
  const { row: customer } = await upsertBankingCustomer({
    appwriteAuthId: `auth-${n}`,
    appwriteUserDocumentId: `doc-${n}`,
  });
  const account = await ensureCustomerAccount(customer.id);

  await query("UPDATE ledger_accounts SET credit_limit_minor = $2 WHERE id = $1", [
    account.id,
    String(creditLimitMinor),
  ]);

  return { customerId: customer.id, accountId: account.id };
}

/** A claimed transfer, which is what a hold attaches to. */
async function seedTransfer(customerId: string, amountMinor: number) {
  const claim = await claimTransfer({
    customerId,
    idempotencyKey: randomUUID(),
    requestFingerprint: `fp-${randomUUID()}`,
    amountMinor,
    currency: "USD",
  });
  return claim.row.id;
}

describe("available balance is not the ledger balance", () => {
  it("a hold reduces available without touching the ledger balance", async () => {
    // THE DISTINCTION THIS MILESTONE EXISTS FOR. Settlement takes days; if the
    // only number in the system were the ledger balance, every request in that
    // window would see money that is already committed.
    const { customerId, accountId } = await seedAccount(100_00);
    const transferId = await seedTransfer(customerId, 30_00);

    const before = await withTransaction((c) => availableBalanceOf(accountId, c));
    expect(before).toBe(100_00);

    await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 30_00 }, c)
    );

    const after = await withTransaction(async (c) => ({
      available: await availableBalanceOf(accountId, c),
      held: await activeHoldTotal(accountId, c),
    }));

    expect(after.available).toBe(70_00);
    expect(after.held).toBe(30_00);

    // The LEDGER balance is untouched: nothing has moved yet. A hold is a
    // reservation, not a posting.
    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger_entries WHERE account_id = $1",
      [accountId]
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("a released hold gives the availability back", async () => {
    const { customerId, accountId } = await seedAccount(100_00);
    const transferId = await seedTransfer(customerId, 40_00);

    await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 40_00 }, c)
    );
    await withTransaction((c) => releaseHold(transferId, c));

    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(
      100_00
    );
    expect(await withTransaction((c) => activeHoldTotal(accountId, c))).toBe(0);
  });

  it("a captured hold does NOT give availability back — the entries carry it", async () => {
    // Capture means the money moved. Returning the availability as well would
    // credit the customer twice: once by releasing the reservation, once by
    // never having posted the debit.
    const { customerId, accountId } = await seedAccount(100_00);
    const transferId = await seedTransfer(customerId, 40_00);

    await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 40_00 }, c)
    );

    await withTransaction(async (c) => {
      await captureHold(transferId, c);
      const settlement = await ensureSettlementAccount(c);
      await postTransaction(
        {
          description: "settled",
          transferId,
          lines: [
            { accountId, amountMinor: -40_00 },
            { accountId: settlement.id, amountMinor: 40_00 },
          ],
        },
        c
      );
    });

    const after = await withTransaction(async (c) => ({
      available: await availableBalanceOf(accountId, c),
      held: await activeHoldTotal(accountId, c),
    }));

    // Availability is still 60_00 — but now because the money is GONE, not
    // because it is reserved.
    expect(after.available).toBe(60_00);
    expect(after.held).toBe(0);
  });
});

describe("solvency", () => {
  it("refuses a hold that exceeds what is available, and writes nothing", async () => {
    const { customerId, accountId } = await seedAccount(50_00);
    const transferId = await seedTransfer(customerId, 60_00);

    const outcome = await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 60_00 }, c)
    );

    expect(outcome).toEqual({
      kind: "insufficient",
      availableMinor: 50_00,
      requestedMinor: 60_00,
    });

    // NO PARTIAL EFFECT: no hold row, no entries.
    expect(await withTransaction((c) => findHoldByTransfer(transferId, c))).toBeNull();
    expect(await withTransaction((c) => activeHoldTotal(accountId, c))).toBe(0);
  });

  it("allows a hold for exactly the available amount", async () => {
    // An off-by-one here is the difference between a customer being able to
    // commit everything they have and being permanently short by one cent.
    const { customerId, accountId } = await seedAccount(50_00);
    const transferId = await seedTransfer(customerId, 50_00);

    const outcome = await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 50_00 }, c)
    );

    expect(outcome.kind).toBe("placed");
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(0);
  });

  it("refuses the cent above the available amount", async () => {
    const { customerId, accountId } = await seedAccount(50_00);
    const transferId = await seedTransfer(customerId, 50_01);

    const outcome = await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 50_01 }, c)
    );

    expect(outcome.kind).toBe("insufficient");
  });

  it("counts existing holds against the next request", async () => {
    const { customerId, accountId } = await seedAccount(100_00);
    const first = await seedTransfer(customerId, 60_00);
    const second = await seedTransfer(customerId, 60_00);

    const a = await withTransaction((c) =>
      placeHold({ accountId, transferId: first, amountMinor: 60_00 }, c)
    );
    const b = await withTransaction((c) =>
      placeHold({ accountId, transferId: second, amountMinor: 60_00 }, c)
    );

    expect(a.kind).toBe("placed");
    expect(b.kind).toBe("insufficient");
  });
});

describe("simultaneous spending", () => {
  it("BLOCKS a second hold until the first transaction commits", async () => {
    // DETERMINISTIC, not a race. Two Promise.all calls can interleave in an
    // order that happens to be safe even with no lock at all, so a passing
    // parallel test is not by itself evidence of serialisation. This holds the
    // first transaction open and asserts the second CANNOT conclude.
    const { customerId, accountId } = await seedAccount(100_00);
    const first = await seedTransfer(customerId, 60_00);
    const second = await seedTransfer(customerId, 60_00);

    const holder = await getPool().connect();
    try {
      await holder.query("BEGIN");
      const placed = await placeHold(
        { accountId, transferId: first, amountMinor: 60_00 },
        holder
      );
      expect(placed.kind).toBe("placed");

      // Uncommitted. A second request must not be able to decide anything yet:
      // whether the money is available depends on whether this commits.
      let settled = false;
      const blocked = withTransaction((c) =>
        placeHold({ accountId, transferId: second, amountMinor: 60_00 }, c)
      ).then((outcome) => {
        settled = true;
        return outcome;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        settled,
        "the second hold decided while the first was still uncommitted"
      ).toBe(false);

      await holder.query("COMMIT");
      holder.release();

      // And when it unblocks it sees the COMMITTED world, not the stale one it
      // read before blocking.
      expect(await blocked).toMatchObject({
        kind: "insufficient",
        availableMinor: 40_00,
        requestedMinor: 60_00,
      });
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      throw error;
    }
  });

  it("two concurrent requests cannot both commit funds that only cover one", async () => {
    const { customerId, accountId } = await seedAccount(100_00);
    const first = await seedTransfer(customerId, 60_00);
    const second = await seedTransfer(customerId, 60_00);

    const [a, b] = await Promise.all([
      withTransaction((c) =>
        placeHold({ accountId, transferId: first, amountMinor: 60_00 }, c)
      ),
      withTransaction((c) =>
        placeHold({ accountId, transferId: second, amountMinor: 60_00 }, c)
      ),
    ]);

    expect([a.kind, b.kind].sort()).toEqual(["insufficient", "placed"]);

    // The assertion that matters is on the ACCOUNT, not on the return values:
    // exactly one reservation exists and the limit was never exceeded.
    expect(await withTransaction((c) => activeHoldTotal(accountId, c))).toBe(60_00);
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(40_00);
  });

  it("ten concurrent requests against funds for five commit exactly five", async () => {
    const { customerId, accountId } = await seedAccount(100_00);
    const transferIds = [];
    for (let i = 0; i < 10; i += 1) {
      transferIds.push(await seedTransfer(customerId, 20_00));
    }

    const outcomes = await Promise.all(
      transferIds.map((transferId) =>
        withTransaction((c) =>
          placeHold({ accountId, transferId, amountMinor: 20_00 }, c)
        )
      )
    );

    expect(outcomes.filter((o) => o.kind === "placed")).toHaveLength(5);
    expect(outcomes.filter((o) => o.kind === "insufficient")).toHaveLength(5);

    expect(await withTransaction((c) => activeHoldTotal(accountId, c))).toBe(100_00);
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(0);
  });
});

describe("one hold per transfer", () => {
  it("a second attempt for the same transfer finds the existing hold", async () => {
    // A re-drive of an in-flight transfer must not reserve the money twice —
    // that would refuse a transfer the customer can actually afford.
    const { customerId, accountId } = await seedAccount(100_00);
    const transferId = await seedTransfer(customerId, 40_00);

    const first = await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 40_00 }, c)
    );
    const second = await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 40_00 }, c)
    );

    expect(first.kind).toBe("placed");
    expect(second.kind).toBe("existing");
    expect(await withTransaction((c) => activeHoldTotal(accountId, c))).toBe(40_00);
  });

  it("the database refuses a second hold row even if the code tries", async () => {
    const { customerId, accountId } = await seedAccount(100_00);
    const transferId = await seedTransfer(customerId, 10_00);

    await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 10_00 }, c)
    );

    await expect(
      query(
        `INSERT INTO ledger_holds (account_id, transfer_id, amount_minor)
         VALUES ($1, $2, $3)`,
        [accountId, transferId, "1000"]
      )
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });
});

describe("the hold state machine is enforced by the database", () => {
  const activeHold = async () => {
    const { customerId, accountId } = await seedAccount(100_00);
    const transferId = await seedTransfer(customerId, 10_00);
    const outcome = await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 10_00 }, c)
    );
    if (outcome.kind !== "placed") throw new Error("setup failed");
    return { holdId: outcome.row.id, transferId, accountId };
  };

  it("rejects an amount being rewritten after the fact", async () => {
    const { holdId } = await activeHold();

    await expectRejectedBy(
      query("UPDATE ledger_holds SET amount_minor = 1 WHERE id = $1", [holdId]),
      RESTRICT_VIOLATION
    );
  });

  it("rejects a hold being moved to another account", async () => {
    const { holdId } = await activeHold();
    const other = await seedAccount(100_00, 2);

    await expectRejectedBy(
      query("UPDATE ledger_holds SET account_id = $2 WHERE id = $1", [
        holdId,
        other.accountId,
      ]),
      RESTRICT_VIOLATION
    );
  });

  it("rejects deletion outright", async () => {
    const { holdId } = await activeHold();

    await expectRejectedBy(
      query("DELETE FROM ledger_holds WHERE id = $1", [holdId]),
      RESTRICT_VIOLATION
    );
  });

  it("will not reopen a captured hold", async () => {
    // A captured hold that could go back to active would let money already
    // spent be reserved again.
    const { holdId, transferId } = await activeHold();
    await withTransaction((c) => captureHold(transferId, c));

    await expectRejectedBy(
      query("UPDATE ledger_holds SET state = 'active', resolved_at = NULL WHERE id = $1", [
        holdId,
      ]),
      RESTRICT_VIOLATION
    );
  });

  it("will not capture a hold that was already released", async () => {
    const { transferId } = await activeHold();
    await withTransaction((c) => releaseHold(transferId, c));

    // No row matches, so nothing changes — the state machine is the WHERE
    // clause, not an `if`.
    expect(await withTransaction((c) => captureHold(transferId, c))).toBeNull();

    const hold = await withTransaction((c) => findHoldByTransfer(transferId, c));
    expect(hold?.state).toBe("released");
  });

  it("requires a resolved timestamp exactly when the hold is resolved", async () => {
    const { holdId } = await activeHold();

    await expectRejectedBy(
      query("UPDATE ledger_holds SET state = 'captured' WHERE id = $1", [holdId]),
      CHECK_VIOLATION
    );
  });
});

describe("credit limits are a decision, not a default", () => {
  it("gives a new customer account the standing policy limit", async () => {
    const { row: customer } = await upsertBankingCustomer({
      appwriteAuthId: "auth-policy",
      appwriteUserDocumentId: "doc-policy",
    });
    const account = await ensureCustomerAccount(customer.id);

    expect(Number(account.credit_limit_minor)).toBe(CUSTOMER_CREDIT_LIMIT_MINOR);
  });

  it("does not rewrite a limit that was deliberately changed", async () => {
    const { customerId, accountId } = await seedAccount(7_00);

    // A later transfer calls ensureCustomerAccount again.
    const again = await ensureCustomerAccount(customerId);

    expect(again.id).toBe(accountId);
    expect(Number(again.credit_limit_minor)).toBe(7_00);
  });

  it("pins the house account to no credit at all", async () => {
    const settlement = await ensureSettlementAccount();
    expect(Number(settlement.credit_limit_minor)).toBe(0);

    await expectRejectedBy(
      query("UPDATE ledger_accounts SET credit_limit_minor = 1 WHERE id = $1", [
        settlement.id,
      ]),
      CHECK_VIOLATION
    );
  });

  it("refuses a hold on the house account", async () => {
    // Nothing should ever place one, and if something does it must fail rather
    // than draw on an allowance nobody granted.
    const { customerId } = await seedAccount(100_00);
    const settlement = await ensureSettlementAccount();
    const transferId = await seedTransfer(customerId, 1_00);

    const outcome = await withTransaction((c) =>
      placeHold({ accountId: settlement.id, transferId, amountMinor: 1_00 }, c)
    );

    expect(outcome.kind).toBe("insufficient");
  });

  it("refuses a negative limit", async () => {
    const { accountId } = await seedAccount(100_00);

    await expectRejectedBy(
      query("UPDATE ledger_accounts SET credit_limit_minor = -1 WHERE id = $1", [
        accountId,
      ]),
      CHECK_VIOLATION
    );
  });
});

describe("holds attach to real transfers", () => {
  it("refuses a hold for a transfer that does not exist", async () => {
    const { accountId } = await seedAccount(100_00);

    await expectRejectedBy(
      withTransaction((c) =>
        placeHold({ accountId, transferId: randomUUID(), amountMinor: 1_00 }, c)
      ),
      FOREIGN_KEY_VIOLATION
    );
  });

  it("survives the transfer moving to submitted", async () => {
    const { customerId, accountId } = await seedAccount(100_00);
    const transferId = await seedTransfer(customerId, 25_00);

    await withTransaction((c) =>
      placeHold({ accountId, transferId, amountMinor: 25_00 }, c)
    );
    await markSubmitted({ transferId, providerTransferId: "xfer-hold" });

    // Still reserved: acceptance is not settlement, and the money is still
    // committed until the provider says otherwise.
    const hold = await withTransaction((c) => findHoldByTransfer(transferId, c));
    expect(hold?.state).toBe("active");
    expect(await withTransaction((c) => availableBalanceOf(accountId, c))).toBe(75_00);
  });
});
