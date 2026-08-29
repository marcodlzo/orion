import { describe, it, expect } from "vitest";

import {
  CURRENT_USER_DTO_FIELDS,
  toCurrentUserDTO,
  type CurrentUserDTO,
} from "./user.dto";
import {
  ACCOUNT_SUMMARY_DTO_FIELDS,
  toAccountSummaryDTO,
} from "./bank.dto";
import {
  TRANSACTION_DTO_FIELDS,
  toTransactionDTOFromStore,
  toTransactionDTOFromRecord,
} from "./transaction.dto";

/**
 * DTO BOUNDARY.
 *
 * These are allowlist tests: each asserts the EXACT resulting object. A
 * per-field `expect(x.ssn).toBeUndefined()` would pass forever while a newly
 * added sensitive column leaked, because nobody remembers to add the new field
 * to the blacklist. `toEqual` fails the moment the shape widens.
 *
 * They also assert on the SERIALIZED output, because TypeScript describes what
 * a value should be, not what it is. A mapper that spread its input would
 * typecheck cleanly and still ship the whole record.
 *
 * Fixtures use synthetic redacted values. Never put a real SSN in a test.
 */

/** A user record as stored, including everything that must not escape. */
const RAW_USER = {
  $id: "user-doc-1",
  $createdAt: "2026-01-01T00:00:00.000Z",
  $updatedAt: "2026-01-01T00:00:00.000Z",
  $permissions: [],
  $databaseId: "db",
  $collectionId: "users",
  userId: "auth-1",
  email: "person@example.invalid",
  firstName: "Given",
  lastName: "Family",
  address1: "REDACTED-ADDRESS",
  city: "REDACTED-CITY",
  state: "ZZ",
  postalCode: "00000",
  dateOfBirth: "REDACTED-DOB",
  ssn: "REDACTED-SSN",
  dwollaCustomerId: "REDACTED-DWOLLA-ID",
  dwollaCustomerUrl: "https://api-sandbox.dwolla.invalid/customers/REDACTED-DWOLLA-ID",
};

/** A bank record as stored. Both credentials are present, as in production. */
const RAW_BANK = {
  $id: "bank-doc-1",
  $createdAt: "2026-01-01T00:00:00.000Z",
  $permissions: [],
  userId: { $id: "user-doc-1", ssn: "REDACTED-SSN" },
  accountId: "plaid-account-1",
  bankId: "plaid-item-1",
  accessToken: "REDACTED-PLAID-ACCESS-TOKEN",
  fundingSourceUrl: "https://api-sandbox.dwolla.invalid/funding-sources/REDACTED",
  shareableId: "cGxhaWQtYWNjb3VudC0x",
};

const RAW_PLAID_ACCOUNT = {
  account_id: "plaid-account-1",
  name: "Plaid Checking",
  official_name: "Plaid Gold Standard 0% Interest Checking",
  mask: "0000",
  type: "depository",
  subtype: "checking",
  balances: { current: 110, available: 100, iso_currency_code: "USD" },
};

/** Every value that must never appear in a client payload. */
const FORBIDDEN_VALUES = [
  "REDACTED-SSN",
  "REDACTED-DOB",
  "REDACTED-ADDRESS",
  "REDACTED-CITY",
  "REDACTED-DWOLLA-ID",
  "REDACTED-PLAID-ACCESS-TOKEN",
  "REDACTED",
];

const FORBIDDEN_KEYS = [
  "ssn",
  "dateOfBirth",
  "address1",
  "city",
  "state",
  "postalCode",
  "accessToken",
  "fundingSourceUrl",
  "dwollaCustomerId",
  "dwollaCustomerUrl",
];

/** Walk a serialized payload and collect any forbidden key at any depth. */
function forbiddenKeysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v) => forbiddenKeysIn(v, found));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(k)) found.push(k);
      forbiddenKeysIn(v, found);
    }
  }
  return found;
}

describe("CurrentUserDTO", () => {
  it("emits exactly the allowlisted shape", () => {
    expect(toCurrentUserDTO(RAW_USER)).toEqual({
      id: "user-doc-1",
      firstName: "Given",
      lastName: "Family",
      email: "person@example.invalid",
    });
  });

  it("declares the same fields it emits", () => {
    const dto = toCurrentUserDTO(RAW_USER) as CurrentUserDTO;
    expect(Object.keys(dto).sort()).toEqual([...CURRENT_USER_DTO_FIELDS].sort());
  });

  it("drops every sensitive field, by key and by value", () => {
    const wire = JSON.stringify(toCurrentUserDTO(RAW_USER));

    expect(forbiddenKeysIn(JSON.parse(wire))).toEqual([]);
    for (const value of FORBIDDEN_VALUES) {
      expect(wire).not.toContain(value);
    }
  });

  it("drops Appwrite metadata the UI never renders", () => {
    const dto = toCurrentUserDTO(RAW_USER) as Record<string, unknown>;
    for (const key of ["$createdAt", "$updatedAt", "$permissions", "$databaseId", "$collectionId", "userId"]) {
      expect(dto).not.toHaveProperty(key);
    }
  });

  it("cannot be widened by an unexpected field on the source record", () => {
    const withExtra = { ...RAW_USER, newSecretColumn: "REDACTED-SSN" };

    const wire = JSON.stringify(toCurrentUserDTO(withExtra));

    // The mapper names every field it copies, so tomorrow's column is excluded
    // by default rather than by somebody remembering to blacklist it.
    expect(wire).not.toContain("newSecretColumn");
    expect(wire).not.toContain("REDACTED-SSN");
  });

  it("returns null for a missing record rather than an empty shell", () => {
    expect(toCurrentUserDTO(null)).toBeNull();
    expect(toCurrentUserDTO(undefined)).toBeNull();
  });
});

describe("AccountSummaryDTO", () => {
  const dto = toAccountSummaryDTO({
    plaidAccount: RAW_PLAID_ACCOUNT,
    bank: RAW_BANK,
  });

  it("emits exactly the allowlisted shape", () => {
    expect(dto).toEqual({
      id: "plaid-account-1",
      appwriteItemId: "bank-doc-1",
      name: "Plaid Checking",
      officialName: "Plaid Gold Standard 0% Interest Checking",
      mask: "0000",
      type: "depository",
      subtype: "checking",
      // EXACT MINOR UNITS, converted at the adapter edge. This was a float
      // taken straight from Plaid's JSON and then summed across accounts, so
      // the representation error compounded once per linked account.
      currentBalanceMinor: 11000,
      shareableId: "cGxhaWQtYWNjb3VudC0x",
    });
  });

  it("declares the same fields it emits", () => {
    expect(Object.keys(dto).sort()).toEqual([...ACCOUNT_SUMMARY_DTO_FIELDS].sort());
  });

  it("NEVER carries the Plaid access token or the Dwolla funding-source URL", () => {
    const wire = JSON.stringify(dto);

    expect(dto).not.toHaveProperty("accessToken");
    expect(dto).not.toHaveProperty("fundingSourceUrl");
    expect(wire).not.toContain("REDACTED-PLAID-ACCESS-TOKEN");
    expect(wire).not.toContain("funding-sources");
  });

  it("does not carry the raw relationship document", () => {
    const wire = JSON.stringify(dto);

    // BANK.userId reads back as the whole related user document, SSN included.
    expect(dto).not.toHaveProperty("userId");
    expect(forbiddenKeysIn(JSON.parse(wire))).toEqual([]);
    expect(wire).not.toContain("REDACTED-SSN");
  });

  it("drops fields no rendering path reads", () => {
    for (const key of ["availableBalance", "institutionId", "bankId"]) {
      expect(dto).not.toHaveProperty(key);
    }
  });
});

describe("TransactionDTO", () => {
  const storeRow = (over: Record<string, unknown> = {}) => ({
    id: "row-1",
    item_id: "item-1",
    plaid_transaction_id: "plaid-tx-1",
    plaid_account_id: "plaid-account-1",
    amount_minor: "450",
    iso_currency: "USD",
    posted_date: "2026-02-01",
    name: "Coffee",
    merchant_name: "Blue Bottle",
    pending: false,
    removed_at: null,
    first_seen_at: new Date("2026-02-01T00:00:00.000Z"),
    updated_at: new Date("2026-02-01T00:00:00.000Z"),
    ...over,
  });

  it("maps a synced transaction to exactly the allowlisted shape", () => {
    const dto = toTransactionDTOFromStore(storeRow());

    expect(dto).toEqual({
      id: "plaid-tx-1",
      name: "Coffee",
      date: "2026-02-01",
      // EXACT MINOR UNITS, and the sign carried by direction rather than by
      // the number — a positive Plaid amount means money LEFT the account.
      amountMinor: 450,
      direction: "debit",
      // The provider's own flag, not the age of the row.
      status: "posted",
      paymentChannel: "merchant",
      category: "Blue Bottle",
    });
    expect(Object.keys(dto).sort()).toEqual([...TRANSACTION_DTO_FIELDS].sort());
  });

  it("reads Plaid's sign convention as a direction, not as a negative amount", () => {
    // Positive means money left the account. Getting this backwards would show
    // every payment as income, and every deposit as a charge.
    const outgoing = toTransactionDTOFromStore(
      storeRow({ amount_minor: "1250", name: "Payment", merchant_name: null })
    );
    const incoming = toTransactionDTOFromStore(
      storeRow({ amount_minor: "-1250", name: "Refund", merchant_name: null })
    );

    expect(outgoing.direction).toBe("debit");
    expect(incoming.direction).toBe("credit");
    // The magnitude is the same either way; only the direction differs.
    expect(outgoing.amountMinor).toBe(1250);
    expect(incoming.amountMinor).toBe(1250);
  });

  it("carries a pending transaction's real status", () => {
    const dto = toTransactionDTOFromStore(storeRow({ pending: true }));

    expect(dto.status).toBe("pending");
  });

  it("maps a stored row from the synced store", () => {
    const dto = toTransactionDTOFromStore({
      id: "row-1",
      item_id: "item-1",
      plaid_transaction_id: "plaid-tx-9",
      plaid_account_id: "acct-1",
      amount_minor: "-2599",
      iso_currency: "USD",
      posted_date: "2026-03-01",
      name: "Refund",
      merchant_name: null,
      pending: false,
      removed_at: null,
      first_seen_at: new Date("2026-03-01T00:00:00.000Z"),
      updated_at: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(dto).toEqual({
      id: "plaid-tx-9",
      name: "Refund",
      date: "2026-03-01",
      amountMinor: 2599,
      direction: "credit",
      status: "posted",
      paymentChannel: "other",
      category: "",
    });
    // The internal row id and the item id never leave the server.
    expect(dto).not.toHaveProperty("item_id");
    expect(Object.keys(dto).sort()).toEqual([...TRANSACTION_DTO_FIELDS].sort());
  });

  it("maps a stored transfer record and honours the caller's direction", () => {
    const dto = toTransactionDTOFromRecord(
      {
        $id: "tx-doc-1",
        $createdAt: "2026-02-02T10:00:00.000Z",
        name: "Rent",
        amount: "1200.00",
        channel: "online",
        category: "Transfer",
        senderBankId: "bank-doc-1",
        receiverBankId: "bank-doc-2",
        senderId: "user-doc-1",
        receiverId: "user-doc-2",
        email: "person@example.invalid",
      },
      "debit"
    );

    expect(dto).toEqual({
      id: "tx-doc-1",
      name: "Rent",
      date: "2026-02-02T10:00:00.000Z",
      // The legacy column is the STRING "1200.00". Parsed by digits, not by
      // Number(value) * 100, which is fractionally low for many values.
      amountMinor: 120000,
      direction: "debit",
      // A legacy row carries no state, so it is shown as submitted rather than
      // as a settlement nobody confirmed.
      status: "submitted",
      paymentChannel: "online",
      category: "Transfer",
    });
  });

  it("parses legacy decimal strings without float multiplication", () => {
    const amountOf = (amount: string) =>
      toTransactionDTOFromRecord(
        { $id: "t", $createdAt: "d", name: "n", amount, channel: "", category: "" },
        "debit"
      ).amountMinor;

    expect(amountOf("1200.00")).toBe(120000);
    expect(amountOf("0.01")).toBe(1);
    expect(amountOf("8.11")).toBe(811);
    expect(amountOf("104.06")).toBe(10406);
    // One decimal place is padded, not misread as one cent.
    expect(amountOf("5.5")).toBe(550);
    expect(amountOf("7")).toBe(700);
    // Unparseable legacy values render as zero rather than taking the page
    // down: visibly wrong beats quietly wrong.
    expect(amountOf("not money")).toBe(0);
    expect(amountOf("")).toBe(0);
  });

  it("drops counterparty identifiers the table never renders", () => {
    const dto = toTransactionDTOFromRecord(
      {
        $id: "tx-doc-1",
        $createdAt: "2026-02-02T10:00:00.000Z",
        name: "Rent",
        amount: "1200.00",
        channel: "online",
        category: "Transfer",
        senderBankId: "bank-doc-1",
        receiverBankId: "bank-doc-2",
        senderId: "user-doc-1",
        receiverId: "user-doc-2",
        email: "person@example.invalid",
      },
      "credit"
    );

    for (const key of ["senderId", "receiverId", "senderBankId", "receiverBankId", "email"]) {
      expect(dto).not.toHaveProperty(key);
    }
  });
});
