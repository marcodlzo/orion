import type { SyncedTransaction } from "../plaid-sync/engine";

/**
 * Read DTO for transaction history.
 *
 * ALLOWLIST. This phase does not redesign the financial model — the history
 * remains a display log, not a ledger. It only controls what leaves the server.
 */

/**
 * One row as TransactionsTable renders it.
 *
 * Derived from actual usage: id, name, date, amount, type, paymentChannel and
 * category are read; `status` is derived client-side from `date`.
 *
 * Dropped because no rendering path reads them:
 *   accountId, pending, image, and every raw Appwrite metadata field
 *
 * DEFECT (not this phase): `amount` is a number here because Plaid supplies one
 * and the stored transfer amount is a string. Money is not integer minor units
 * anywhere yet.
 */
export type TransactionDTO = {
  id: string;
  name: string;
  date: string;
  amount: number;
  type: string;
  paymentChannel: string;
  category: string;
};

export const TRANSACTION_DTO_FIELDS = [
  "id",
  "name",
  "date",
  "amount",
  "type",
  "paymentChannel",
  "category",
] as const;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const money = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

/**
 * Map an already-adapted Plaid transaction to the display DTO.
 *
 * Takes a SyncedTransaction, not a raw Plaid object: the provider's shape stops
 * at `lib/plaid-sync/adapter.ts`, and the conversion from Plaid's float dollars
 * to exact minor units happens there, once.
 *
 * `amount` is divided back to a decimal number ONLY here, at the display edge,
 * because TransactionsTable renders through the float `formatAmount`. That is
 * the last remaining float in this path and it belongs to the UI rebuild — the
 * stored value and everything upstream of this line are integer minor units.
 */
export function toTransactionDTOFromSync(
  transaction: SyncedTransaction
): TransactionDTO {
  return {
    id: transaction.transactionId,
    name: transaction.name,
    date: transaction.postedDate,
    amount: transaction.amountMinor / 100,
    type: transaction.pending ? "pending" : "posted",
    paymentChannel: transaction.pending ? "pending" : "posted",
    category: transaction.merchantName ?? "",
  };
}

/** Map a raw Plaid transaction to the display DTO. */
export function toTransactionDTOFromPlaid(transaction: unknown): TransactionDTO {
  const t = (transaction ?? {}) as Record<string, unknown>;
  const category = Array.isArray(t.category) ? str(t.category[0]) : "";

  return {
    id: str(t.transaction_id),
    name: str(t.name),
    date: str(t.date),
    amount: money(t.amount),
    type: str(t.payment_channel),
    paymentChannel: str(t.payment_channel),
    category,
  };
}

/**
 * Map a stored transfer record to the display DTO.
 *
 * `direction` is decided by the caller, which knows which bank is being viewed.
 */
export function toTransactionDTOFromRecord(
  record: unknown,
  direction: "debit" | "credit"
): TransactionDTO {
  const r = (record ?? {}) as Record<string, unknown>;

  return {
    id: str(r.$id),
    name: str(r.name),
    date: str(r.$createdAt),
    amount: money(r.amount),
    type: direction,
    paymentChannel: str(r.channel),
    category: str(r.category),
  };
}
