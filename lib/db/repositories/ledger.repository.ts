// Server-only. The internal ledger — PostgreSQL's system of record for money.
import "server-only";

import type { PoolClient } from "pg";

import { query, readMoneyMinor } from "../pool";
import { toDatabaseError } from "../errors";
import {
  CUSTOMER_CREDIT_LIMIT_MINOR,
  SETTLEMENT_CREDIT_LIMIT_MINOR,
} from "../../domain/limits";

export type LedgerAccountKind = "customer" | "settlement";

export type LedgerAccountRow = {
  id: string;
  customer_id: string | null;
  kind: LedgerAccountKind;
  currency: string;
  /** How far below zero available balance may go. A positive magnitude. */
  credit_limit_minor: string;
  created_at: Date;
  updated_at: Date;
};

export type LedgerTransactionKind = "settlement" | "reversal";

export type LedgerTransactionRow = {
  id: string;
  transfer_id: string | null;
  kind: LedgerTransactionKind;
  reverses_transaction_id: string | null;
  description: string;
  created_at: Date;
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
    `INSERT INTO ledger_accounts (customer_id, kind, currency, credit_limit_minor)
     VALUES (NULL, 'settlement', 'USD', $1)
     ON CONFLICT (currency) WHERE kind = 'settlement' DO NOTHING
     RETURNING *`,
    [String(SETTLEMENT_CREDIT_LIMIT_MINOR)]
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

/**
 * The customer's own account, created on first use.
 *
 * The conflict path deliberately does NOT rewrite `credit_limit_minor`. An
 * account that has been given a different limit keeps it; otherwise every
 * transfer would quietly reset a decision somebody made deliberately.
 */
export async function ensureCustomerAccount(
  customerId: string,
  client?: PoolClient
): Promise<LedgerAccountRow> {
  const { rows } = await run<LedgerAccountRow>(
    client,
    `INSERT INTO ledger_accounts (customer_id, kind, currency, credit_limit_minor)
     VALUES ($1, 'customer', 'USD', $2)
     ON CONFLICT (customer_id, currency) DO UPDATE
       SET customer_id = EXCLUDED.customer_id
     RETURNING *`,
    [customerId, String(CUSTOMER_CREDIT_LIMIT_MINOR)]
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
 * A transfer SETTLES at most once — a partial unique index on
 * `kind = 'settlement'` — which is what makes posting idempotent at the last
 * possible layer: a retry that reaches here despite the claim above it still
 * cannot double-post. A reversal posts against the same transfer and is itself
 * unique per original.
 */
export async function postTransaction(
  input: {
    description: string;
    transferId?: string | null;
    lines: readonly PostingLine[];
    /** Defaults to a settlement. A reversal must name what it reverses. */
    kind?: LedgerTransactionKind;
    reversesTransactionId?: string | null;
  },
  client: PoolClient
): Promise<{ transactionId: string; entries: LedgerEntryRow[] }> {
  const { rows: txnRows } = await run<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions
       (transfer_id, description, kind, reverses_transaction_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      input.transferId ?? null,
      input.description,
      input.kind ?? "settlement",
      input.reversesTransactionId ?? null,
    ]
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

/** The settlement posting for a transfer, if it has one. */
export async function findSettlementPosting(
  transferId: string,
  client?: PoolClient
): Promise<LedgerTransactionRow | null> {
  const { rows } = await run<LedgerTransactionRow>(
    client,
    `SELECT * FROM ledger_transactions
      WHERE transfer_id = $1 AND kind = 'settlement'`,
    [transferId]
  );
  return rows[0] ?? null;
}

/** The reversal of a posting, if it has been reversed. */
export async function findReversalOf(
  transactionId: string,
  client?: PoolClient
): Promise<LedgerTransactionRow | null> {
  const { rows } = await run<LedgerTransactionRow>(
    client,
    "SELECT * FROM ledger_transactions WHERE reverses_transaction_id = $1",
    [transactionId]
  );
  return rows[0] ?? null;
}

/**
 * Undo a posting by COMPENSATING it.
 *
 * NEW OPPOSING ENTRIES. The originals are not touched, and could not be: the
 * entry triggers reject UPDATE and DELETE, so this is the only mechanism the
 * schema permits. That is the point — a ledger you can edit is a ledger that
 * cannot tell you what happened.
 *
 * THE AMOUNTS ARE DERIVED FROM THE ORIGINAL ENTRIES, never supplied by the
 * caller. A reversal that computes its own figures can disagree with what it
 * claims to be undoing; one built by negating the rows it points at cannot.
 *
 * Returns null when the posting has already been reversed, so a redelivered
 * return is an ordinary no-op rather than an error. The unique constraint on
 * `reverses_transaction_id` is the real guarantee — this check just lets the
 * caller's transaction survive.
 */
export async function reverseTransaction(
  input: { transactionId: string; description: string },
  client: PoolClient
): Promise<{ transactionId: string; entries: LedgerEntryRow[] } | null> {
  const { rows: originals } = await run<LedgerTransactionRow>(
    client,
    "SELECT * FROM ledger_transactions WHERE id = $1",
    [input.transactionId]
  );
  const original = originals[0];
  if (!original) {
    throw new Error(`ledger transaction ${input.transactionId} does not exist`);
  }

  const alreadyReversed = await findReversalOf(input.transactionId, client);
  if (alreadyReversed) return null;

  const entries = await entriesForTransaction(input.transactionId, client);
  if (entries.length === 0) {
    throw new Error(`ledger transaction ${input.transactionId} has no entries`);
  }

  return postTransaction(
    {
      description: input.description,
      transferId: original.transfer_id,
      kind: "reversal",
      reversesTransactionId: original.id,
      lines: entries.map((entry) => ({
        accountId: entry.account_id,
        amountMinor: -readMoneyMinor(entry.amount_minor),
      })),
    },
    client
  );
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
