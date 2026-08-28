// Server-only. The internal ledger — PostgreSQL's system of record for money.
import "server-only";

import type { PoolClient } from "pg";

import { query, readMoneyMinor } from "../pool";
import { toDatabaseError } from "../errors";

export type LedgerAccountKind = "customer" | "settlement";

export type LedgerAccountRow = {
  id: string;
  customer_id: string | null;
  kind: LedgerAccountKind;
  currency: string;
  created_at: Date;
  updated_at: Date;
};

export type LedgerEntryRow = {
  id: string;
  transaction_id: string;
  account_id: string;
  /** BIGINT arrives as a string. Read it with readMoneyMinor, never Number(). */
  amount_minor: string;
  currency: string;
  created_at: Date;
};

/**
 * One side of a double-entry posting.
 *
 * Signed: positive debits, negative credits. The pair is what balances, and the
 * database checks that at COMMIT.
 */
export type PostingLine = {
  accountId: string;
  amountMinor: number;
};

async function run<T extends Record<string, unknown>>(
  client: PoolClient | undefined,
  text: string,
  params: readonly unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  if (!client) return query<T>(text, params);
  try {
    const result = await client.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/** The house account money moves through. Created once, then found. */
export async function ensureSettlementAccount(
  client?: PoolClient
): Promise<LedgerAccountRow> {
  const { rows } = await run<LedgerAccountRow>(
    client,
    `INSERT INTO ledger_accounts (customer_id, kind, currency)
     VALUES (NULL, 'settlement', 'USD')
     ON CONFLICT (currency) WHERE kind = 'settlement' DO NOTHING
     RETURNING *`,
    []
  );
  if (rows[0]) return rows[0];

  const existing = await run<LedgerAccountRow>(
    client,
    "SELECT * FROM ledger_accounts WHERE kind = 'settlement' AND currency = 'USD'",
    []
  );
  if (!existing.rows[0]) throw new Error("settlement account is missing");
  return existing.rows[0];
}

/** The customer's own account, created on first use. */
export async function ensureCustomerAccount(
  customerId: string,
  client?: PoolClient
): Promise<LedgerAccountRow> {
  const { rows } = await run<LedgerAccountRow>(
    client,
    `INSERT INTO ledger_accounts (customer_id, kind, currency)
     VALUES ($1, 'customer', 'USD')
     ON CONFLICT (customer_id, currency) DO UPDATE
       SET customer_id = EXCLUDED.customer_id
     RETURNING *`,
    [customerId]
  );
  return rows[0];
}

/**
 * Post one balanced transaction.
 *
 * ATOMIC BY CONSTRUCTION. Every line is inserted inside one transaction, and
 * the deferred balance trigger fires at COMMIT — so a posting that does not sum
 * to zero, or that has fewer than two lines, cannot be committed at all. The
 * caller cannot get half a posting in even by trying.
 *
 * `transferId` is UNIQUE on the transactions table, which is what makes posting
 * idempotent at the last possible layer: a retry that reaches here despite the
 * claim above it still cannot double-post.
 */
export async function postTransaction(
  input: {
    description: string;
    transferId?: string | null;
    lines: readonly PostingLine[];
  },
  client: PoolClient
): Promise<{ transactionId: string; entries: LedgerEntryRow[] }> {
  const { rows: txnRows } = await run<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (transfer_id, description)
     VALUES ($1, $2)
     RETURNING id`,
    [input.transferId ?? null, input.description]
  );
  const transactionId = txnRows[0].id;

  const entries: LedgerEntryRow[] = [];
  for (const line of input.lines) {
    const { rows } = await run<LedgerEntryRow>(
      client,
      `INSERT INTO ledger_entries (transaction_id, account_id, amount_minor, currency)
       VALUES ($1, $2, $3, 'USD')
       RETURNING *`,
      [transactionId, line.accountId, String(line.amountMinor)]
    );
    entries.push(rows[0]);
  }

  return { transactionId, entries };
}

/**
 * An account's balance, DERIVED.
 *
 * There is no balance column and there will not be one. A stored balance is a
 * second source of truth that drifts silently the moment anything goes wrong;
 * summing the entries cannot disagree with the entries.
 *
 * Read through readMoneyMinor so a value outside the exactly-representable
 * range fails loudly instead of rounding.
 */
export async function balanceOf(
  accountId: string,
  client?: PoolClient
): Promise<number> {
  const { rows } = await run<{ balance: string }>(
    client,
    `SELECT COALESCE(sum(amount_minor), 0)::text AS balance
       FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return readMoneyMinor(rows[0].balance);
}

/**
 * Every account's balance summed.
 *
 * CONSERVATION: this is zero for a ledger that only contains balanced
 * transactions, and stays zero however much money moves internally. A non-zero
 * total means entries exist that do not belong to a balanced pair, which the
 * schema is supposed to make impossible — so this is the assertion that proves
 * the schema is doing its job rather than assuming it.
 */
export async function totalAcrossAllAccounts(client?: PoolClient): Promise<number> {
  const { rows } = await run<{ total: string }>(
    client,
    "SELECT COALESCE(sum(amount_minor), 0)::text AS total FROM ledger_entries",
    []
  );
  return readMoneyMinor(rows[0].total);
}

/** Entries for one posting, oldest first. */
export async function entriesForTransaction(
  transactionId: string,
  client?: PoolClient
): Promise<LedgerEntryRow[]> {
  const { rows } = await run<LedgerEntryRow>(
    client,
    `SELECT * FROM ledger_entries
      WHERE transaction_id = $1 ORDER BY created_at, id`,
    [transactionId]
  );
  return rows;
}

/** Entries for one transfer, across whatever postings it produced. */
export async function entriesForTransfer(
  transferId: string,
  client?: PoolClient
): Promise<LedgerEntryRow[]> {
  const { rows } = await run<LedgerEntryRow>(
    client,
    `SELECT e.* FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.transfer_id = $1
      ORDER BY e.created_at, e.id`,
    [transferId]
  );
  return rows;
}
