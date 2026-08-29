/**
 * The Plaid adapter edge.
 *
 * Provider types stop here. Everything past this file speaks internal terms, so
 * the ledger, the engine and the repositories never learn Plaid's dialect —
 * which is what stops a provider response shape from becoming a domain type, the
 * way `Account` and `Transaction` already did in `types/index.d.ts`.
 *
 * PURE. Takes plain objects shaped like a Plaid response and returns internal
 * ones. No SDK import, no network, so every conversion — including the money
 * conversion, which is the one that can silently lose a cent — is testable
 * directly.
 */

import type { SyncPage, SyncedTransaction } from "./engine";

/** Only the fields this system acts on. The rest of the payload is ignored. */
export type PlaidTransactionLike = {
  transaction_id?: unknown;
  account_id?: unknown;
  amount?: unknown;
  iso_currency_code?: unknown;
  unofficial_currency_code?: unknown;
  date?: unknown;
  name?: unknown;
  merchant_name?: unknown;
  pending?: unknown;
};

export type PlaidSyncResponseLike = {
  added?: unknown;
  modified?: unknown;
  removed?: unknown;
  next_cursor?: unknown;
  has_more?: unknown;
};

export class PlaidResponseError extends Error {
  readonly code = "PLAID_RESPONSE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "PlaidResponseError";
    Object.setPrototypeOf(this, PlaidResponseError.prototype);
  }
}

/**
 * The largest amount that survives the conversion below exactly.
 *
 * A double holds integers exactly to 2^53; multiplying by 100 first means the
 * safe input is a hundredth of that. Anything larger is refused rather than
 * rounded, because a silently wrong amount is worse than a failed sync.
 */
const MAX_ABS_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * Plaid's JSON number to exact integer minor units.
 *
 * THE HONEST PROBLEM: by the time this runs, the HTTP body has already been
 * through JSON.parse, so the provider's original decimal text is gone and only a
 * double remains. `12.34` is not exactly representable, and `amount * 100` is
 * 1233.9999999999998 for some values — `Math.trunc` of that loses a cent, and
 * even `Math.round` is not safe in general because the error can exceed half a
 * unit for large magnitudes.
 *
 * `toFixed(2)` rounds the double to the nearest cent using the decimal
 * representation, which is exactly the recovery wanted here: Plaid reports
 * currency amounts to two places, so the nearest cent IS the value it sent. The
 * digits are then parsed as integers, so no float multiplication happens at all.
 *
 * Refusing is the alternative to guessing: a non-finite amount, or one too large
 * to be exact, raises rather than being coerced.
 */
export function toMinorUnits(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new PlaidResponseError("transaction amount is not a finite number");
  }
  if (Math.abs(amount) > MAX_ABS_MINOR / 100) {
    throw new PlaidResponseError("transaction amount is too large to convert exactly");
  }

  // Sign handled separately so the digit split below never sees a "-".
  const negative = amount < 0 || Object.is(amount, -0);
  const [whole, fraction] = Math.abs(amount).toFixed(2).split(".");

  const minor = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(minor)) {
    throw new PlaidResponseError("transaction amount is too large to convert exactly");
  }

  // Normalised: -0 is a valid double but a nonsensical amount, and it
  // serialises as "-0" into SQL and JSON.
  if (minor === 0) return 0;
  return negative ? -minor : minor;
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlaidResponseError(`transaction ${field} is missing`);
  }
  return value.trim();
};

/** An ISO date, as Plaid sends it. Validated, never parsed into a Date here. */
function requireDate(value: unknown): string {
  const raw = requireString(value, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new PlaidResponseError("transaction date is not an ISO date");
  }
  return raw;
}

export function toSyncedTransaction(
  raw: PlaidTransactionLike
): SyncedTransaction {
  // Plaid reports one or the other; an account in an unofficial currency still
  // has amounts, and defaulting a missing code to USD would mislabel them.
  const currency =
    typeof raw.iso_currency_code === "string" && raw.iso_currency_code.trim()
      ? raw.iso_currency_code.trim()
      : typeof raw.unofficial_currency_code === "string" &&
          raw.unofficial_currency_code.trim()
        ? raw.unofficial_currency_code.trim()
        : null;

  if (!currency) {
    throw new PlaidResponseError("transaction has no currency code");
  }

  return {
    transactionId: requireString(raw.transaction_id, "transaction_id"),
    accountId: requireString(raw.account_id, "account_id"),
    amountMinor: toMinorUnits(raw.amount),
    isoCurrency: currency,
    postedDate: requireDate(raw.date),
    name: requireString(raw.name, "name"),
    merchantName:
      typeof raw.merchant_name === "string" && raw.merchant_name.trim()
        ? raw.merchant_name.trim()
        : null,
    pending: raw.pending === true,
  };
}

/** A retraction carries only an id. */
function toRemovedId(raw: unknown): string {
  if (raw && typeof raw === "object" && "transaction_id" in raw) {
    return requireString(
      (raw as { transaction_id?: unknown }).transaction_id,
      "transaction_id"
    );
  }
  throw new PlaidResponseError("removed entry has no transaction_id");
}

const asArray = (value: unknown, field: string): unknown[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PlaidResponseError(`${field} is not a list`);
  }
  return value;
};

/**
 * One Plaid response to one internal page.
 *
 * `has_more` is compared to `true` rather than coerced: a missing field must not
 * read as "keep going", and a truthy string must not either.
 */
export function toSyncPage(response: PlaidSyncResponseLike): SyncPage {
  const nextCursor = response.next_cursor;
  if (typeof nextCursor !== "string") {
    throw new PlaidResponseError("response has no next_cursor");
  }

  return {
    added: asArray(response.added, "added").map((t) =>
      toSyncedTransaction(t as PlaidTransactionLike)
    ),
    modified: asArray(response.modified, "modified").map((t) =>
      toSyncedTransaction(t as PlaidTransactionLike)
    ),
    removed: asArray(response.removed, "removed").map(toRemovedId),
    nextCursor,
    hasMore: response.has_more === true,
  };
}

/**
 * What a Plaid error means for the Item.
 *
 * An Item stops working for reasons only the user can resolve. Swallowing that
 * makes a broken link indistinguishable from an account with no new activity —
 * which is how a bank connection silently rots for months.
 *
 * The CODE is kept and the message is discarded: a Plaid error message echoes
 * the request, and the request carries the access token.
 */
export type ItemHealth =
  | { status: "healthy" }
  | { status: "login_required"; code: string }
  | { status: "error"; code: string };

const RELINK_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "ITEM_LOCKED",
  "USER_PERMISSION_REVOKED",
  "USER_INPUT_TIMEOUT",
  "PENDING_EXPIRATION",
]);

export function classifyPlaidError(error: unknown): ItemHealth {
  const code = plaidErrorCode(error);
  if (!code) return { status: "error", code: "UNKNOWN" };
  if (RELINK_CODES.has(code)) return { status: "login_required", code };
  return { status: "error", code };
}

/**
 * Dig the error code out of an axios-shaped Plaid failure.
 *
 * Only the code. Never `error_message`, never `display_message`, and never the
 * request config — which is where the access token lives.
 */
export function plaidErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;

  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (data && typeof data === "object") {
    const code = (data as { error_code?: unknown }).error_code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }

  const direct = (error as { error_code?: unknown }).error_code;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  return null;
}
