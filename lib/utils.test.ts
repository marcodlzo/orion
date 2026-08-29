import { describe, it, expect } from "vitest";

import {
  encryptId,
  decryptId,
  extractCustomerIdFromUrl,
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

/**
 * formatAmount's characterisation tests are GONE, because Milestone 11 landed
 * and took the function with them. They
 * documented a float formatter that displayed $1.01 for a stored 1.00499…, so
 * a rendered column would not sum to the stored total.
 *
 * Its replacement, formatMinorUnits, takes exact integer minor units and is
 * asserted in lib/domain/money.test.ts — including the cases these tests
 * existed to record.
 */

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

/**
 * getTransactionStatus's characterisation tests are GONE, because Milestone 11
 * landed and the function with them. They asserted "Processing" under two days
 * and "Success" after — a status derived from a clock. Real status now lives on
 * the TransactionDTO and comes from the provider's pending flag or the transfer
 * state machine, and is asserted in lib/dto/dto.test.ts.
 *
 * That is the intended lifecycle: a DEFECT test is replaced by a real invariant
 * test when its milestone lands, never relaxed to keep passing.
 */

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
