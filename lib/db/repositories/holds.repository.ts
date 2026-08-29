// Server-only. Funds committed but not yet moved.
//
// A hold is the difference between what an account HAS and what it may still
// commit. It is placed before the provider is called, reduces the available
// balance without touching the ledger balance, and is resolved in the same
// transaction as the transfer's terminal state.
import "server-only";

import type { PoolClient } from "pg";

import { readMoneyMinor } from "../pool";
import { toDatabaseError } from "../errors";

export type HoldState = "active" | "captured" | "released";

export type LedgerHoldRow = {
  id: string;
  account_id: string;
  transfer_id: string;
  /** A positive magnitude. A hold reserves; it does not move. */
  amount_minor: string;
  currency: string;
  state: HoldState;
  placed_at: Date;
  resolved_at: Date | null;
};

/**
 * What placing a hold did.
 *
 * `existing` is separated from `placed` for the same reason a replayed transfer
 * is separated from a claimed one: a re-drive of an in-flight transfer must find
 * the hold it already placed rather than reserving the money a second time.
 */
export type HoldOutcome =
  | { kind: "placed"; row: LedgerHoldRow }
  | { kind: "existing"; row: LedgerHoldRow }
  | {
      kind: "insufficient";
      /** What the account could still commit, in minor units. */
      availableMinor: number;
      requestedMinor: number;
    };

async function run<T extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  params: readonly unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  try {
    const result = await client.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/**
 * Reserve funds for a transfer, or refuse.
 *
 * REQUIRES A TRANSACTION, and takes a `PoolClient` rather than an optional one
 * to say so in the type. This is a read-then-write decision: it reads a balance
 * and the active holds, decides, and inserts. Run outside a transaction, each
 * statement would commit separately and the decision would be made on a view
 * that no longer holds by the time the insert lands.
 *
 * WHAT SERIALISES TWO SIMULTANEOUS REQUESTS: the `SELECT ... FOR UPDATE` on the
 * ACCOUNT row. It is not decoration and it is not the unique index — the index
 * on transfer_id stops one transfer being held twice, but two DIFFERENT
 * transfers by the same customer have no row in common except this one. Without
 * the lock both would read the same available balance under READ COMMITTED,
 * both would find it sufficient, and both would insert. This is proven by a test
 * that runs two transfers concurrently against funds that only cover one, and by
 * a mutation that removes FOR UPDATE and turns that test red.
 *
 * The account row is a lock target and nothing more: no balance is stored on it.
 * Locking a row to protect a value derived from other tables is deliberate —
 * the alternative, a stored balance to lock, is the second source of truth this
 * ledger exists to avoid.
 */
export async function placeHold(
  input: { accountId: string; transferId: string; amountMinor: number },
  client: PoolClient
): Promise<HoldOutcome> {
  // An existing hold for this transfer settles the question before any locking:
  // the money is already reserved.
  const existing = await run<LedgerHoldRow>(
    client,
    "SELECT * FROM ledger_holds WHERE transfer_id = $1",
    [input.transferId]
  );
  if (existing.rows[0]) return { kind: "existing", row: existing.rows[0] };

  // THE SERIALISATION POINT. Everything below reads a world this lock holds
  // still until the caller's transaction ends.
  const account = await run<{ id: string; credit_limit_minor: string }>(
    client,
    "SELECT id, credit_limit_minor FROM ledger_accounts WHERE id = $1 FOR UPDATE",
    [input.accountId]
  );
  if (!account.rows[0]) {
    throw new Error(`ledger account ${input.accountId} does not exist`);
  }

  const creditLimitMinor = readMoneyMinor(account.rows[0].credit_limit_minor);
  const availableMinor =
    (await balanceOf(input.accountId, client)) -
    (await activeHoldTotal(input.accountId, client)) +
    creditLimitMinor;

  if (input.amountMinor > availableMinor) {
    // REFUSED WITHOUT A PARTIAL EFFECT. No hold row, and — because the caller
    // has not reached the provider yet — no money in motion to unwind.
    return {
      kind: "insufficient",
      availableMinor,
      requestedMinor: input.amountMinor,
    };
  }

  const inserted = await run<LedgerHoldRow>(
    client,
    `INSERT INTO ledger_holds (account_id, transfer_id, amount_minor)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.accountId, input.transferId, String(input.amountMinor)]
  );

  return { kind: "placed", row: inserted.rows[0] };
}

/**
 * The money actually moved: the hold did its job and the entries now carry it.
 *
 * Only from `active`, in the WHERE clause. Returns null when nothing matched, so
 * a redelivered settlement is an ordinary no-op rather than an error.
 */
export async function captureHold(
  transferId: string,
  client: PoolClient
): Promise<LedgerHoldRow | null> {
  const { rows } = await run<LedgerHoldRow>(
    client,
    `UPDATE ledger_holds
        SET state = 'captured', resolved_at = now()
      WHERE transfer_id = $1 AND state = 'active'
      RETURNING *`,
    [transferId]
  );
  return rows[0] ?? null;
}

/**
 * The money never moved: give the reservation back.
 *
 * A failed transfer that leaves its hold active would permanently reduce what
 * the customer can commit, for a transfer that never happened. Released in the
 * same transaction as the failure, so there is no window in which the funds are
 * both unspent and unavailable.
 */
export async function releaseHold(
  transferId: string,
  client: PoolClient
): Promise<LedgerHoldRow | null> {
  const { rows } = await run<LedgerHoldRow>(
    client,
    `UPDATE ledger_holds
        SET state = 'released', resolved_at = now()
      WHERE transfer_id = $1 AND state = 'active'
      RETURNING *`,
    [transferId]
  );
  return rows[0] ?? null;
}

/** The ledger balance: what has actually moved. Derived, never stored. */
async function balanceOf(accountId: string, client: PoolClient): Promise<number> {
  const { rows } = await run<{ balance: string }>(
    client,
    `SELECT COALESCE(sum(amount_minor), 0)::text AS balance
       FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return readMoneyMinor(rows[0].balance);
}

/** Everything currently reserved on an account. */
export async function activeHoldTotal(
  accountId: string,
  client: PoolClient
): Promise<number> {
  const { rows } = await run<{ total: string }>(
    client,
    `SELECT COALESCE(sum(amount_minor), 0)::text AS total
       FROM ledger_holds WHERE account_id = $1 AND state = 'active'`,
    [accountId]
  );
  return readMoneyMinor(rows[0].total);
}

/**
 * What the account may still commit.
 *
 * AVAILABLE IS NOT THE LEDGER BALANCE. The ledger balance is what has moved;
 * available is what may still be committed — the balance, less what is already
 * reserved, plus the account's allowance. Conflating the two is how a customer
 * spends the same money twice: the second request reads a balance the first has
 * not yet changed, because settlement takes days.
 *
 * Derived on every read. There is no stored available balance and there will not
 * be one, for the same reason there is no stored balance.
 */
export async function availableBalanceOf(
  accountId: string,
  client: PoolClient
): Promise<number> {
  const account = await run<{ credit_limit_minor: string }>(
    client,
    "SELECT credit_limit_minor FROM ledger_accounts WHERE id = $1",
    [accountId]
  );
  if (!account.rows[0]) {
    throw new Error(`ledger account ${accountId} does not exist`);
  }

  return (
    (await balanceOf(accountId, client)) -
    (await activeHoldTotal(accountId, client)) +
    readMoneyMinor(account.rows[0].credit_limit_minor)
  );
}

/** One transfer's hold, whatever state it is in. */
export async function findHoldByTransfer(
  transferId: string,
  client: PoolClient
): Promise<LedgerHoldRow | null> {
  const { rows } = await run<LedgerHoldRow>(
    client,
    "SELECT * FROM ledger_holds WHERE transfer_id = $1",
    [transferId]
  );
  return rows[0] ?? null;
}
