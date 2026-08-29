import { describe, expect, it } from "vitest";

import {
  classifyPlaidError,
  plaidErrorCode,
  PlaidResponseError,
  toMinorUnits,
  toSyncPage,
  toSyncedTransaction,
} from "./adapter";

/**
 * THE ADAPTER EDGE.
 *
 * Two things are proven here. That Plaid's float dollars become exact integer
 * minor units — the conversion where a cent disappears silently and nothing ever
 * reports it. And that a provider error yields a CODE and nothing else: a Plaid
 * error message echoes the request, and the request carries the access token.
 */

describe("money conversion", () => {
  it("converts the ordinary cases exactly", () => {
    expect(toMinorUnits(0)).toBe(0);
    expect(toMinorUnits(1)).toBe(100);
    expect(toMinorUnits(12.34)).toBe(1234);
    expect(toMinorUnits(0.01)).toBe(1);
    expect(toMinorUnits(999.99)).toBe(99999);
  });

  it("is honest about what a double can and cannot recover", () => {
    // A JSON number is already a double by the time this runs, so the decimal
    // text Plaid sent is gone. `1.005` parses to 1.00499999999999989342 — below
    // the decimal it was written as — and the nearest cent to the value that
    // ACTUALLY ARRIVED is 1.00.
    //
    // This is not a rounding bug to fix; it is the limit of the input, and the
    // test records it rather than asserting a value the code could only produce
    // by inventing precision it does not have. Plaid sends currency amounts to
    // two places, where the question does not arise.
    expect((1.005).toFixed(20)).toBe("1.00499999999999989342");
    expect(toMinorUnits(1.005)).toBe(100);
  });

  it("does not lose a cent to floating point", () => {
    // `Math.trunc(amount * 100)` is the natural-looking implementation and it is
    // wrong: several of these multiply to something fractionally below the
    // integer, and truncation takes a cent off silently and forever.
    const cases: Array<[number, number]> = [
      [12.34, 1234],
      [4.35, 435],
      // 8.115 as a double is 8.11500000000000021316 — just ABOVE the decimal,
      // so the nearest cent is 8.12. Truncation would give 811.
      [8.115, 812],
      [16.08, 1608],
      [1.13, 113],
      [1.15, 115],
      [0.29, 29],
      [0.57, 57],
      [1.79, 179],
      [10.04, 1004],
      [104.06, 10406],
    ];

    for (const [input, expected] of cases) {
      expect(toMinorUnits(input), `${input} should be ${expected}`).toBe(expected);
    }
  });

  it("handles negatives, which Plaid uses for money arriving", () => {
    expect(toMinorUnits(-12.34)).toBe(-1234);
    expect(toMinorUnits(-0.01)).toBe(-1);
    expect(toMinorUnits(-0)).toBe(0);
  });

  it("returns an integer for every case, never a float", () => {
    for (const value of [0.1, 0.2, 1.005, -8.115, 123.455, 99.995]) {
      expect(Number.isSafeInteger(toMinorUnits(value))).toBe(true);
    }
  });

  it("REFUSES rather than guesses at a value it cannot convert exactly", () => {
    // A silently wrong amount is worse than a failed sync: the sync can be
    // re-run, the wrong number cannot be noticed.
    expect(() => toMinorUnits(Number.NaN)).toThrow(PlaidResponseError);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow(PlaidResponseError);
    expect(() => toMinorUnits("12.34")).toThrow(PlaidResponseError);
    expect(() => toMinorUnits(null)).toThrow(PlaidResponseError);
    expect(() => toMinorUnits(undefined)).toThrow(PlaidResponseError);
    expect(() => toMinorUnits(Number.MAX_SAFE_INTEGER)).toThrow(PlaidResponseError);
  });
});

describe("translating a transaction", () => {
  const raw = {
    transaction_id: "txn-1",
    account_id: "acct-1",
    amount: 12.34,
    iso_currency_code: "USD",
    date: "2026-08-01",
    name: "Coffee",
    merchant_name: "Blue Bottle",
    pending: false,
  };

  it("keeps only the fields this system acts on", () => {
    expect(toSyncedTransaction(raw)).toEqual({
      transactionId: "txn-1",
      accountId: "acct-1",
      amountMinor: 1234,
      isoCurrency: "USD",
      postedDate: "2026-08-01",
      name: "Coffee",
      merchantName: "Blue Bottle",
      pending: false,
    });
  });

  it("drops everything else the provider sent", () => {
    // Provider types stop here. A payload field that is not translated cannot
    // become a domain field by accident later.
    const result = toSyncedTransaction({
      ...raw,
      location: { address: "1 Main St" },
      payment_meta: { reference_number: "abc" },
      account_owner: "Someone",
    } as Record<string, unknown>);

    expect(Object.keys(result).sort()).toEqual([
      "accountId",
      "amountMinor",
      "isoCurrency",
      "merchantName",
      "name",
      "pending",
      "postedDate",
      "transactionId",
    ]);
  });

  it("falls back to the unofficial currency code", () => {
    const result = toSyncedTransaction({
      ...raw,
      iso_currency_code: null,
      unofficial_currency_code: "XBT",
    });

    expect(result.isoCurrency).toBe("XBT");
  });

  it("refuses a transaction with no currency rather than assuming USD", () => {
    // Defaulting would mislabel every amount on a non-USD account.
    expect(() =>
      toSyncedTransaction({ ...raw, iso_currency_code: null })
    ).toThrow(PlaidResponseError);
  });

  it("refuses incomplete transactions", () => {
    for (const missing of ["transaction_id", "account_id", "name"] as const) {
      expect(() =>
        toSyncedTransaction({ ...raw, [missing]: undefined })
      ).toThrow(PlaidResponseError);
    }
  });

  it("refuses a date that is not an ISO date", () => {
    expect(() => toSyncedTransaction({ ...raw, date: "01/08/2026" })).toThrow(
      PlaidResponseError
    );
  });

  it("treats a missing pending flag as not pending", () => {
    expect(toSyncedTransaction({ ...raw, pending: undefined }).pending).toBe(false);
    expect(toSyncedTransaction({ ...raw, pending: "yes" }).pending).toBe(false);
    expect(toSyncedTransaction({ ...raw, pending: true }).pending).toBe(true);
  });
});

describe("translating a page", () => {
  const txn = {
    transaction_id: "t",
    account_id: "a",
    amount: 1,
    iso_currency_code: "USD",
    date: "2026-08-01",
    name: "n",
  };

  it("reads all three change lists and the cursor", () => {
    const page = toSyncPage({
      added: [txn],
      modified: [{ ...txn, transaction_id: "t2" }],
      removed: [{ transaction_id: "t3" }],
      next_cursor: "c1",
      has_more: true,
    });

    expect(page.added.map((t) => t.transactionId)).toEqual(["t"]);
    expect(page.modified.map((t) => t.transactionId)).toEqual(["t2"]);
    expect(page.removed).toEqual(["t3"]);
    expect(page.nextCursor).toBe("c1");
    expect(page.hasMore).toBe(true);
  });

  it("treats missing lists as empty", () => {
    const page = toSyncPage({ next_cursor: "c1", has_more: false });

    expect(page.added).toEqual([]);
    expect(page.modified).toEqual([]);
    expect(page.removed).toEqual([]);
  });

  it("only continues on has_more === true", () => {
    // A missing field must not read as "keep going", and neither must a truthy
    // string — both would restart the infinite loop this milestone removed.
    expect(toSyncPage({ next_cursor: "c" }).hasMore).toBe(false);
    expect(toSyncPage({ next_cursor: "c", has_more: "true" }).hasMore).toBe(false);
    expect(toSyncPage({ next_cursor: "c", has_more: 1 }).hasMore).toBe(false);
    expect(toSyncPage({ next_cursor: "c", has_more: true }).hasMore).toBe(true);
  });

  it("refuses a response with no cursor", () => {
    expect(() => toSyncPage({ has_more: false })).toThrow(PlaidResponseError);
  });

  it("refuses a removal with no id", () => {
    expect(() =>
      toSyncPage({ removed: [{}], next_cursor: "c", has_more: false })
    ).toThrow(PlaidResponseError);
  });
});

describe("provider errors", () => {
  const plaidError = (code: string) => ({
    response: {
      data: {
        error_code: code,
        error_message:
          "the access token access-sandbox-abc-123 is no longer valid",
        display_message: "Please reconnect your account",
      },
      config: { data: '{"access_token":"access-sandbox-abc-123"}' },
    },
  });

  it("extracts the CODE and nothing else", () => {
    // The message and the request config both carry the access token. Only the
    // code is ever read.
    expect(plaidErrorCode(plaidError("ITEM_LOGIN_REQUIRED"))).toBe(
      "ITEM_LOGIN_REQUIRED"
    );
  });

  it("returns a code that contains no token, whatever the payload held", () => {
    const code = plaidErrorCode(plaidError("ITEM_LOGIN_REQUIRED"));

    expect(code).not.toContain("access-sandbox");
    expect(code).not.toContain("access_token");
  });

  it("classifies the errors that need the user to re-link", () => {
    for (const code of [
      "ITEM_LOGIN_REQUIRED",
      "ITEM_LOCKED",
      "USER_PERMISSION_REVOKED",
      "PENDING_EXPIRATION",
    ]) {
      expect(classifyPlaidError(plaidError(code))).toEqual({
        status: "login_required",
        code,
      });
    }
  });

  it("classifies everything else as an error, never as healthy", () => {
    // A swallowed provider error makes a dead bank connection look exactly like
    // an account with no new activity, which is how one rots for months.
    expect(classifyPlaidError(plaidError("INTERNAL_SERVER_ERROR"))).toEqual({
      status: "error",
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(classifyPlaidError(new Error("socket hang up"))).toEqual({
      status: "error",
      code: "UNKNOWN",
    });
    expect(classifyPlaidError(null)).toEqual({ status: "error", code: "UNKNOWN" });
  });

  it("reads a code from a bare error object too", () => {
    expect(plaidErrorCode({ error_code: "RATE_LIMIT" })).toBe("RATE_LIMIT");
  });

  it("returns null when there is no code to read", () => {
    expect(plaidErrorCode(new Error("boom"))).toBeNull();
    expect(plaidErrorCode(undefined)).toBeNull();
    expect(plaidErrorCode({ response: { data: {} } })).toBeNull();
  });
});
