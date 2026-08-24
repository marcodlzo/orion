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
  toTransactionDTOFromPlaid,
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
      currentBalance: 110,
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
  it("maps a Plaid transaction to exactly the allowlisted shape", () => {
    const dto = toTransactionDTOFromPlaid({
      transaction_id: "plaid-tx-1",
      name: "Coffee",
      date: "2026-02-01",
      amount: 4.5,
      payment_channel: "in store",
      category: ["Food and Drink", "Coffee"],
      account_id: "plaid-account-1",
      pending: false,
      logo_url: "https://example.invalid/logo.png",
    });

    expect(dto).toEqual({
      id: "plaid-tx-1",
      name: "Coffee",
      date: "2026-02-01",
      amount: 4.5,
      type: "in store",
      paymentChannel: "in store",
      category: "Food and Drink",
    });
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
      amount: 1200,
      type: "debit",
      paymentChannel: "online",
      category: "Transfer",
    });
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
