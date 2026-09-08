import { readMoneyMinor } from "../db/pool";
import type { PlaidTransactionRow } from "../db/repositories/plaid-items.repository";

/**
 * Read DTO for transaction history.
 *
 * ALLOWLIST. Controls what leaves the server, and — as of the UI rebuild — what
 * shape it leaves in.
 *
 * TWO DEFECTS CLOSED HERE:
 *
 *   amount was a float, straight from Plaid's JSON or from a string column, and
 *   the table rendered it through `formatAmount(amount: number)`. It is now
 *   exact integer minor units end to end, formatted at the point of display.
 *
 *   status was DERIVED FROM A CLOCK. `getTransactionStatus()` returned
 *   "Processing" if the date was under two days old and "Success" otherwise,
 *   regardless of what actually happened — a failed transfer displayed as
 *   Success after 48 hours. Status now comes from real state: the provider's
 *   `pending` flag for a bank transaction, and the transfer state machine for a
 *   transfer.
 */

/**
 * What a row actually is, not how old it is.
 *
 * `pending` and `posted` describe a bank's view of a transaction. The rest are
 * transfer states, which come from the state machine and never from arithmetic
 * on a date.
 */
export type TransactionStatus =
  | "pending"
  | "posted"
  | "submitted"
  | "settled"
  | "failed"
  | "returned"
  | "reversed";

/**
 * One row as TransactionsTable renders it.
 *
 * Derived from actual usage: id, name, date, amountMinor, direction, status,
 * paymentChannel and category are read.
 *
 * Dropped because no rendering path reads them:
 *   accountId, pending, image, and every raw Appwrite metadata field
 */
export type TransactionDTO = {
  id: string;
  name: string;
  date: string;
  /** EXACT INTEGER MINOR UNITS. Never a float, at any point in this path. */
  amountMinor: number;
  /** Which way the money went, from the viewing account's perspective. */
  direction: "debit" | "credit";
  /** Real state. Never computed from `date`. */
  status: TransactionStatus;
  paymentChannel: string;
  category: string;
};

export const TRANSACTION_DTO_FIELDS = [
  "id",
  "name",
  "date",
  "amountMinor",
  "direction",
  "status",
  "paymentChannel",
  "category",
] as const;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Plaid's sign convention to a direction the UI can render.
 *
 * POSITIVE MEANS MONEY LEFT THE ACCOUNT in Plaid's terms. That is the opposite
 * of the intuitive reading, and getting it backwards would show every payment as
 * income. The convention is translated exactly once, here, rather than being
 * carried into the UI where each reader would have to remember it.
 */
function directionFromPlaidAmount(amountMinor: number): "debit" | "credit" {
  return amountMinor >= 0 ? "debit" : "credit";
}

/** Map a stored Plaid transaction row to the display DTO. */
export function toTransactionDTOFromStore(
  row: PlaidTransactionRow
): TransactionDTO {
  // BIGINT arrives as a string. Number() is safe here only because the column
  // is bounded by the adapter's own safe-integer check on the way in.
  const amountMinor = Number(row.amount_minor);

  return {
    id: row.plaid_transaction_id,
    name: row.name,
    date: row.posted_date,
    amountMinor: Math.abs(amountMinor),
    direction: directionFromPlaidAmount(amountMinor),
    status: row.pending ? "pending" : "posted",
    paymentChannel: row.merchant_name ? "merchant" : "other",
    category: row.merchant_name ?? "",
  };
}

/**
 * Map a stored transfer record to the display DTO.
 *
 * `direction` is decided by the caller, which knows which bank is being viewed.
 * `status` is the transfer's own state when one is known — these rows come from
 * the legacy Appwrite collection, which has no state column, so a transfer whose
 * state is not supplied is shown as `submitted` rather than as a settlement
 * nobody confirmed.
 */
export function toTransactionDTOFromRecord(
  record: unknown,
  direction: "debit" | "credit",
  status: TransactionStatus = "submitted"
): TransactionDTO {
  const r = (record ?? {}) as Record<string, unknown>;

  return {
    id: str(r.$id),
    name: str(r.name),
    date: str(r.$createdAt),
    amountMinor: legacyAmountToMinor(r.amount),
    direction,
    status,
    paymentChannel: str(r.channel),
    category: str(r.category),
  };
}

/**
 * The legacy transfer amount, which is a STRING column holding decimal dollars.
 *
 * Parsed by digits rather than by `Number(value) * 100`, for the same reason the
 * Plaid adapter avoids that: the multiplication is fractionally low for many
 * values and truncation silently loses a cent.
 *
 * An unparseable value yields 0 rather than throwing. This is a display path for
 * historical rows written by the tutorial code, and taking the whole history
 * page down over one malformed legacy string would be a worse outcome than
 * showing it as zero — which is visibly wrong rather than quietly wrong.
 */
function legacyAmountToMinor(value: unknown): number {
  const raw = typeof value === "string" ? value.trim() : String(value ?? "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return 0;

  const [, sign, whole, fraction = "0"] = match;
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return 0;

  return sign ? -minor : minor;
}

/**
 * A transfer row from PostgreSQL, as history.
 *
 * Replaces `toTransactionDTOFromRecord`, which read the Appwrite transaction
 * collection. Both exist while the cutover verifies they agree; the Appwrite one
 * goes when the dual write does.
 *
 * DIRECTION IS A COMPARISON, NOT AN INFERENCE. The viewing bank is either the
 * sender or the recipient, and the row says which. The original code read the
 * first character of a formatted string, which broke the moment the formatter
 * changed.
 *
 * STATUS COMES FROM THE STATE MACHINE. Never from a clock. `requested` maps to
 * `pending` because that is what it is — claimed, with the provider call not yet
 * confirmed. Calling it `submitted` would assert something reached Dwolla that
 * may not have.
 */
export function toTransactionDTOFromTransfer(
  row: {
    id: string;
    state: string;
    amount_minor: string;
    note: string | null;
    sender_bank_document_id: string | null;
    recipient_bank_document_id: string | null;
    created_at: Date;
  },
  viewingBankDocumentId: string
): TransactionDTO {
  const direction: "debit" | "credit" =
    row.sender_bank_document_id === viewingBankDocumentId ? "debit" : "credit";

  return {
    id: row.id,
    // An empty note means the sender typed nothing. NULL means a row written
    // before the column existed. Both render as the same fallback, but only one
    // of them is a gap in the data.
    name: row.note && row.note.trim() ? row.note : "Transfer",
    date: row.created_at.toISOString(),
    // Exact integer minor units. `readMoneyMinor` refuses anything else rather
    // than coercing, which is what keeps a BIGINT from silently becoming a
    // float on the way to the screen.
    amountMinor: readMoneyMinor(row.amount_minor),
    direction,
    status: transferStateToStatus(row.state),
    // The legacy collection carried these; a transfer has no equivalent, and
    // inventing a category would be worse than an honest constant.
    paymentChannel: "online",
    category: "Transfer",
  };
}

/**
 * The state machine's vocabulary, mapped to what the table renders.
 *
 * Exhaustive on purpose. An unrecognised state is a new transfer state somebody
 * added without deciding how it should look, and showing it as `pending` is the
 * honest default: it says "in progress, not confirmed" rather than claiming an
 * outcome.
 */
function transferStateToStatus(state: string): TransactionStatus {
  switch (state) {
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "returned":
      return "returned";
    case "reversed":
      return "reversed";
    case "submitted":
      return "submitted";
    case "requested":
    default:
      return "pending";
  }
}
