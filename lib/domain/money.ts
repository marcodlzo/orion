/**
 * Exact money for a single-currency (USD) banking domain.
 *
 * REPRESENTATION: integer minor units (cents) in a JavaScript `number`.
 *
 * Why not a decimal float — the reason this module exists:
 *   0.1 + 0.2 === 0.30000000000000004
 * Binary floating point cannot represent most decimal fractions, so any sum of
 * money computed that way drifts. In a ledger that drift is unrecoverable.
 *
 * Why `number` and not `bigint`:
 *   Number.MAX_SAFE_INTEGER is 9,007,199,254,740,991 cents — about $90
 *   trillion. Every value this application will ever handle fits, and integer
 *   arithmetic below that bound is exact. `bigint` would buy nothing here and
 *   would cost real complexity: it does not survive JSON.stringify, so it
 *   cannot cross the RSC boundary or reach a provider payload without a custom
 *   serializer at every edge. Every constructor enforces Number.isSafeInteger,
 *   so the bound is checked rather than assumed.
 *
 * Why a literal "USD" and not an ISO currency string:
 *   This application is USD-only. A general currency type would imply exchange
 *   rates, per-currency rounding policy and mixed-currency arithmetic rules
 *   that have no requirements behind them yet. The literal type makes adding a
 *   second currency a deliberate, type-checked change rather than a silent one.
 *
 * This module is pure. It has no I/O, no secrets, and is safe to import from a
 * client component for formatting.
 */

export type Currency = "USD";

export type Money = {
  /** Whole cents. Always a safe integer. May be negative or zero. */
  readonly amountMinor: number;
  readonly currency: Currency;
};

/** Minor units per major unit for USD. */
export const USD_SCALE = 2;
const MINOR_PER_MAJOR = 100;

/**
 * Invalid monetary input.
 *
 * A validation failure, deliberately distinct from InfrastructureError,
 * UnauthorizedError and NotFoundError: bad money is the caller's problem, not
 * an outage, and must never be reported as one.
 */
export class InvalidMoneyError extends Error {
  readonly code = "INVALID_MONEY";

  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
    Object.setPrototypeOf(this, InvalidMoneyError.prototype);
  }
}

/**
 * Accepted decimal forms.
 *
 * Digits, optionally followed by a point and one or two digits. Nothing else.
 *
 * Rejected by construction, each for a reason:
 *   ""            no amount
 *   " 1.00 "      surrounding whitespace — see the note below
 *   "-1"          sign; negation is an operation, not a literal
 *   "+1"          same
 *   "1.001"       sub-cent precision cannot be represented and must not be
 *                 silently rounded into or out of existence
 *   "1e3"         scientific notation is not a monetary literal
 *   "$10"         currency symbol belongs to formatting
 *   "10,000"      thousands separators are locale-dependent
 *   ".5"          ambiguous; require the leading zero
 *   "1."          trailing point
 *   "NaN"         not a number
 *   "Infinity"    not an amount
 *
 * WHITESPACE IS REJECTED HERE, DELIBERATELY. This is the domain boundary and it
 * is strict. Trimming user input is normalisation and belongs to the input
 * adapter that receives the form value, so that leniency is visible at the edge
 * rather than baked into the primitive.
 */
const USD_DECIMAL = /^(\d{1,15})(?:\.(\d{1,2}))?$/;

/**
 * Parse a decimal string into exact minor units.
 *
 * The conversion is integer arithmetic on the digit substrings. It never
 * multiplies a parsed float by 100, which is the usual way sub-cent error is
 * introduced: `Number("1.15") * 100` is 114.99999999999999.
 *
 * @throws InvalidMoneyError
 */
export function parseUsd(input: string): Money {
  if (typeof input !== "string") {
    throw new InvalidMoneyError("Amount must be a string");
  }

  const match = USD_DECIMAL.exec(input);
  if (!match) {
    throw new InvalidMoneyError(
      `Not a valid USD amount: ${JSON.stringify(input)}`
    );
  }

  const [, whole, fraction = ""] = match;
  // "5" -> 50, "05" -> 5, "" -> 0. Padding, not arithmetic.
  const cents = Number(fraction.padEnd(USD_SCALE, "0"));
  const amountMinor = Number(whole) * MINOR_PER_MAJOR + cents;

  if (!Number.isSafeInteger(amountMinor)) {
    throw new InvalidMoneyError("Amount is too large to represent exactly");
  }

  return { amountMinor, currency: "USD" };
}

/** Non-throwing variant, for validators that collect issues. */
export function tryParseUsd(input: string): Money | null {
  try {
    return parseUsd(input);
  } catch {
    return null;
  }
}

/** Construct from minor units. */
export function usdFromMinor(amountMinor: number): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new InvalidMoneyError("Minor units must be a safe integer");
  }
  return { amountMinor, currency: "USD" };
}

export const ZERO_USD: Money = { amountMinor: 0, currency: "USD" };

export const isPositive = (money: Money): boolean => money.amountMinor > 0;
export const isZero = (money: Money): boolean => money.amountMinor === 0;

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    // Unreachable while Currency is the literal "USD". It exists so that
    // adding a second currency fails loudly rather than silently summing
    // unlike amounts.
    throw new InvalidMoneyError("Cannot combine different currencies");
  }
}

/**
 * Exact addition. No tolerance, no epsilon — integer addition is exact or it
 * overflows, and overflow throws.
 */
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const total = a.amountMinor + b.amountMinor;
  if (!Number.isSafeInteger(total)) {
    throw new InvalidMoneyError("Sum exceeds the exactly representable range");
  }
  return { amountMinor: total, currency: a.currency };
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amountMinor - b.amountMinor;
}

/**
 * Exact decimal string: 125075 -> "1250.75", 1 -> "0.01", 100 -> "1.00".
 *
 * Built by integer division and string padding. Never `amountMinor / 100`,
 * which reintroduces the float this module exists to avoid.
 *
 * Always emits exactly two decimal places, so the output is a canonical
 * monetary literal that parseUsd round-trips.
 */
export function toDecimalString(money: Money): string {
  const negative = money.amountMinor < 0;
  const abs = Math.abs(money.amountMinor);
  const whole = Math.trunc(abs / MINOR_PER_MAJOR);
  const cents = abs % MINOR_PER_MAJOR;
  return `${negative ? "-" : ""}${whole}.${String(cents).padStart(USD_SCALE, "0")}`;
}
