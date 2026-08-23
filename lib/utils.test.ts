import { describe, it, expect } from "vitest";

import {
  formatAmount,
  encryptId,
  decryptId,
  extractCustomerIdFromUrl,
  getTransactionStatus,
  countTransactionCategories,
  removeSpecialCharacters,
  authFormSchema,
} from "./utils";

/**
 * Unit tests for the shared utilities.
 *
 * Several of these pin behaviour the audit flagged as defective. Those are
 * marked DEFECT and state which milestone changes them. They exist so that
 * milestone can prove the behaviour changed, and so nobody "fixes" them by
 * accident in an unrelated change.
 *
 * A test marked DEFECT asserts what the code does today. It is NOT a
 * specification. Do not defend it.
 */

describe("formatAmount", () => {
  it("formats a whole number as USD with two decimals", () => {
    expect(formatAmount(1234)).toBe("$1,234.00");
  });

  it("formats zero", () => {
    expect(formatAmount(0)).toBe("$0.00");
  });

  it("formats a negative amount", () => {
    expect(formatAmount(-42.5)).toBe("-$42.50");
  });

  // DEFECT — money is a JS float here. 0.1 + 0.2 !== 0.3 in binary floating
  // point, and repeated arithmetic drifts. The money-primitives milestone
  // replaces this with integer minor units; when it does, this test is
  // replaced, not relaxed.
  it("DEFECT: accepts a float and inherits binary floating-point error", () => {
    expect(formatAmount(0.1 + 0.2)).toBe("$0.30"); // rounded away by the formatter
    expect(0.1 + 0.2).not.toBe(0.3); // the underlying value is still wrong
  });

  // DEFECT — the displayed amount is not the stored amount.
  //
  // Intl.NumberFormat rounds the shortest decimal that round-trips the double
  // ("1.005"), half-up, giving $1.01. But the value actually held in memory is
  // 1.00499999999999989342, which is strictly LESS than 1.005.
  //
  // So the UI shows a user $1.01 for a balance the system stores as ~1.00499.
  // Sum a column of these and the displayed total will not equal the stored
  // total. Reconciling against a rendered figure would drift.
  //
  // The fix is not a different formatter — it is integer minor units, so that
  // no sub-cent value can exist to be rounded. Money-primitives milestone.
  it("DEFECT: displays a cent the stored value does not contain", () => {
    expect(formatAmount(1.005)).toBe("$1.01");
    expect(1.005 < 1.005000000000001).toBe(true);
    expect(Number("1.005".padEnd(1)) > 1.00499999999999989342).toBe(false);

    // 1.999 is stored ABOVE 1.999 and still displays as a clean $2.00.
    expect(formatAmount(1.999)).toBe("$2.00");
    expect(1.999.toFixed(20).startsWith("1.99900000000000011")).toBe(true);
  });
});

describe("encryptId / decryptId", () => {
  it("round-trips a value", () => {
    expect(decryptId(encryptId("account-123"))).toBe("account-123");
  });

  // DEFECT — these are named for encryption but are base64 encoding. The
  // "shareable id" a user hands out is a reversible encoding of their raw
  // Plaid account_id. Renaming and replacing them is authorization-milestone
  // work; this test documents that anyone can decode it.
  it("DEFECT: is base64 encoding, not encryption — trivially reversible", () => {
    const plaidAccountId = "X7LMJkE5vnskJBxwPeXaUWDBxAyZXwi9DNEWJ";
    const shareable = encryptId(plaidAccountId);

    expect(shareable).toBe(Buffer.from(plaidAccountId).toString("base64"));
    expect(Buffer.from(shareable, "base64").toString()).toBe(plaidAccountId);
  });
});

describe("extractCustomerIdFromUrl", () => {
  it("returns the last path segment of a Dwolla customer URL", () => {
    expect(
      extractCustomerIdFromUrl(
        "https://api-sandbox.dwolla.com/customers/1f8d2c3b-0000-4a1b-9c2d-ab0011223344"
      )
    ).toBe("1f8d2c3b-0000-4a1b-9c2d-ab0011223344");
  });

  // DEFECT — an unvalidated split().pop(). Any string produces a "customer id",
  // including one that is plainly not a Dwolla URL. A malformed provider
  // response becomes a silently wrong identifier rather than an error.
  it("DEFECT: returns garbage instead of throwing on a non-URL", () => {
    expect(extractCustomerIdFromUrl("not-a-url")).toBe("not-a-url");
    expect(extractCustomerIdFromUrl("")).toBe("");
    expect(extractCustomerIdFromUrl("https://example.com/customers/")).toBe("");
  });
});

describe("getTransactionStatus", () => {
  // DEFECT — status is derived from a clock, not from the provider. A transfer
  // that Dwolla rejected still reads "Success" once it is 48 hours old. The
  // transfer-state-machine milestone deletes this function.
  it("DEFECT: derives status from a timestamp, never from provider state", () => {
    const now = new Date();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    expect(getTransactionStatus(yesterday)).toBe("Processing");

    const lastWeek = new Date(now);
    lastWeek.setDate(now.getDate() - 7);
    // A failed, returned or cancelled transfer reports "Success" here.
    expect(getTransactionStatus(lastWeek)).toBe("Success");
  });
});

describe("countTransactionCategories", () => {
  it("counts and sorts categories by frequency, descending", () => {
    const result = countTransactionCategories([
      { category: "Food and Drink" },
      { category: "Travel" },
      { category: "Food and Drink" },
    ] as Transaction[]);

    expect(result).toEqual([
      { name: "Food and Drink", count: 2, totalCount: 3 },
      { name: "Travel", count: 1, totalCount: 3 },
    ]);
  });

  it("returns an empty array for no transactions", () => {
    expect(countTransactionCategories([])).toEqual([]);
  });

  it("tolerates a nullish input rather than throwing", () => {
    expect(
      countTransactionCategories(undefined as unknown as Transaction[])
    ).toEqual([]);
  });
});

describe("removeSpecialCharacters", () => {
  it("strips punctuation but keeps word characters and spaces", () => {
    expect(removeSpecialCharacters("Acme Corp. (Payroll) #42!")).toBe(
      "Acme Corp Payroll 42"
    );
  });
});

describe("authFormSchema", () => {
  const signUp = authFormSchema("sign-up");
  const signIn = authFormSchema("sign-in");

  it("requires the full profile on sign-up", () => {
    expect(signUp.safeParse({ email: "a@b.com", password: "hunter2!" }).success)
      .toBe(false);
  });

  it("requires only email and password on sign-in", () => {
    expect(
      signIn.safeParse({ email: "a@b.com", password: "hunter2!" }).success
    ).toBe(true);
  });

  it("rejects a password shorter than 8 characters", () => {
    expect(signIn.safeParse({ email: "a@b.com", password: "short" }).success)
      .toBe(false);
  });

  // DEFECT — an SSN is validated only as "at least 3 characters". The audit
  // found SSN is then stored in plaintext and serialized into the RSC payload.
  // The authorization milestone stops persisting it at all.
  it("DEFECT: accepts any 3+ character string as an SSN", () => {
    const base = {
      firstName: "Ada",
      lastName: "Lovelace",
      address1: "1 Analytical Way",
      city: "London",
      state: "CA",
      postalCode: "90210",
      dateOfBirth: "1815-12-10",
      email: "ada@example.com",
      password: "hunter2!",
    };

    expect(signUp.safeParse({ ...base, ssn: "abc" }).success).toBe(true);
    expect(signUp.safeParse({ ...base, ssn: "!!!" }).success).toBe(true);
  });
});
