import { describe, it, expect, vi, beforeEach } from "vitest";

import { NotFoundError } from "../repositories/errors";
import { UnauthorizedError } from "../auth/errors";
import {
  InvalidTransferIntentError,
  TransferSubmittedButNotRecordedError,
} from "../services/transfers.service";
import { TRANSFER_RESULT_DTO_FIELDS } from "../dto/transfer.dto";

/**
 * SERVER-OWNED TRANSFER ORCHESTRATION.
 *
 * The browser submits an intent and receives a narrow result. It never holds a
 * funding-source URL, never calls Dwolla, and never writes a transaction
 * record.
 *
 * These assert intended behaviour and must not be relaxed.
 *
 * WHAT THESE DO NOT PROVE: idempotency. Two calls create two transfers. Moving
 * orchestration to the server removed the browser's capability; it did not
 * deduplicate requests.
 */

const {
  cookieGet,
  accountGet,
  findUserByAuthId,
  getOwnedBankByDocumentId,
  findCounterpartyBankByAccountId,
  createTransactionRecord,
  createDwollaTransfer,
} = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  accountGet: vi.fn(),
  findUserByAuthId: vi.fn(),
  getOwnedBankByDocumentId: vi.fn(),
  findCounterpartyBankByAccountId: vi.fn(),
  createTransactionRecord: vi.fn(),
  createDwollaTransfer: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: cookieGet, set: vi.fn(), delete: vi.fn() }),
}));

vi.mock("../appwrite", () => ({
  createSessionClient: async () => ({
    get account() {
      return { get: accountGet };
    },
  }),
  createAdminClient: async () => ({
    get database() {
      return { listDocuments: vi.fn(), createDocument: vi.fn() };
    },
    get account() {
      return {};
    },
    get user() {
      return {};
    },
  }),
}));

vi.mock("../repositories/users.repository", () => ({
  findUserByAuthId,
  createUserRecord: vi.fn(),
}));
vi.mock("../repositories/banks.repository", () => ({
  getOwnedBankByDocumentId,
  findCounterpartyBankByAccountId,
  getOwnedBanks: vi.fn(),
  getOwnedBankByAccountId: vi.fn(),
  createBankForActor: vi.fn(),
}));
vi.mock("../repositories/transactions.repository", async () => {
  // The legacy amount adapter is real: these tests assert the exact decimal
  // string that reaches the datastore, so stubbing it would prove nothing.
  const { toDecimalString } = await import("../domain/money");
  return {
    createTransactionRecord,
    getTransactionsForOwnedBank: vi.fn(),
    toLegacyTransactionAmount: toDecimalString,
  };
});
vi.mock("../server/dwolla", () => ({
  createDwollaTransfer,
  dwollaClient: { post: vi.fn() },
  addFundingSource: vi.fn(),
  createDwollaCustomer: vi.fn(),
}));

import { initiateTransfer } from "./transfer.actions";

const ALICE = { $id: "user-doc-alice", userId: "auth-alice", dwollaCustomerId: "dwolla-alice" };

const ALICE_BANK = {
  $id: "bank-doc-alice",
  userId: { $id: "user-doc-alice" },
  accountId: "plaid-account-alice",
  bankId: "plaid-item-alice",
  accessToken: "REDACTED-ALICE-ACCESS-TOKEN",
  fundingSourceUrl: "https://api-sandbox.dwolla.invalid/funding-sources/alice",
  shareableId: "cGxhaWQtYWNjb3VudC1hbGljZQ==",
};

const BOB_BANK = {
  $id: "bank-doc-bob",
  userId: { $id: "user-doc-bob" },
  accountId: "plaid-account-bob",
  bankId: "plaid-item-bob",
  accessToken: "REDACTED-BOB-ACCESS-TOKEN",
  fundingSourceUrl: "https://api-sandbox.dwolla.invalid/funding-sources/bob",
  shareableId: "cGxhaWQtYWNjb3VudC1ib2I=",
};

/** base64 of "plaid-account-bob" — the reference Bob hands out. */
const BOB_REFERENCE = Buffer.from(BOB_BANK.accountId).toString("base64");

const VALID_INTENT = {
  senderBankId: "bank-doc-alice",
  recipientReference: BOB_REFERENCE,
  amount: "25.00",
  note: "Rent",
  recipientEmail: "bob@example.invalid",
};

function authenticateAlice() {
  cookieGet.mockReturnValue({ value: "session-for-alice" });
  accountGet.mockResolvedValue({ $id: "auth-alice" });
  findUserByAuthId.mockResolvedValue(ALICE);
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAlice();
  getOwnedBankByDocumentId.mockResolvedValue(ALICE_BANK);
  findCounterpartyBankByAccountId.mockResolvedValue(BOB_BANK);
  createDwollaTransfer.mockResolvedValue({
    transferUrl: "https://api-sandbox.dwolla.invalid/transfers/transfer-1",
    transferId: "transfer-1",
  });
  createTransactionRecord.mockResolvedValue({ $id: "tx-doc-1" });
});

describe("authentication", () => {
  it("an anonymous caller reaches no repository or provider", async () => {
    cookieGet.mockReturnValue(undefined);

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(getOwnedBankByDocumentId).not.toHaveBeenCalled();
    expect(findCounterpartyBankByAccountId).not.toHaveBeenCalled();
    expect(createDwollaTransfer).not.toHaveBeenCalled();
    expect(createTransactionRecord).not.toHaveBeenCalled();
  });
});

describe("E. source ownership", () => {
  it("Alice naming Bob's bank as the source raises NotFound and moves no money", async () => {
    // The repository is actor-scoped, so an unowned id resolves to nothing.
    getOwnedBankByDocumentId.mockResolvedValue(null);

    await expect(
      initiateTransfer({ ...VALID_INTENT, senderBankId: "bank-doc-bob" })
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(createDwollaTransfer).not.toHaveBeenCalled();
    expect(createTransactionRecord).not.toHaveBeenCalled();
  });

  it("resolves the source through the actor-scoped repository", async () => {
    await initiateTransfer(VALID_INTENT);

    const [actor, bankId] = getOwnedBankByDocumentId.mock.calls[0];
    expect(actor).toMatchObject({ userId: "user-doc-alice" });
    expect(bankId).toBe("bank-doc-alice");
  });
});

describe("F. recipient reference validation", () => {
  it("rejects a malformed reference without calling the provider", async () => {
    await expect(
      initiateTransfer({ ...VALID_INTENT, recipientReference: "!!!not-base64!!!" })
    ).rejects.toBeInstanceOf(InvalidTransferIntentError);

    expect(createDwollaTransfer).not.toHaveBeenCalled();
    expect(createTransactionRecord).not.toHaveBeenCalled();
  });

  it("raises NotFound when the reference resolves to no account", async () => {
    findCounterpartyBankByAccountId.mockResolvedValue(null);

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(NotFoundError);
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });

  it("refuses a transfer to the source account itself", async () => {
    findCounterpartyBankByAccountId.mockResolvedValue(ALICE_BANK);

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(
      InvalidTransferIntentError
    );
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });
});

describe("server-side amount validation", () => {
  const reject = async (amount: string) => {
    await expect(
      initiateTransfer({ ...VALID_INTENT, amount })
    ).rejects.toBeInstanceOf(InvalidTransferIntentError);
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  };

  // The form's zod schema is user feedback, not a boundary — a caller can post
  // straight to the action.
  it("rejects zero", () => reject("0"));
  it("rejects zero with decimals", () => reject("0.00"));
  it("rejects a negative amount", () => reject("-10.00"));
  it("rejects a non-numeric amount", () => reject("abcd"));
  it("rejects Infinity", () => reject("Infinity"));
  it("rejects NaN", () => reject("NaN"));
  it("rejects sub-cent precision", () => reject("10.005"));
  it("rejects an empty amount", () => reject(""));

  it("accepts a whole number", async () => {
    await initiateTransfer({ ...VALID_INTENT, amount: "10" });
    expect(createDwollaTransfer).toHaveBeenCalledTimes(1);
  });
});

describe("G. a valid transfer", () => {
  it("calls the provider exactly once, with server-resolved funding sources", async () => {
    await initiateTransfer(VALID_INTENT);

    expect(createDwollaTransfer).toHaveBeenCalledTimes(1);
    expect(createDwollaTransfer).toHaveBeenCalledWith({
      sourceFundingSourceUrl: ALICE_BANK.fundingSourceUrl,
      destinationFundingSourceUrl: BOB_BANK.fundingSourceUrl,
      // Exact minor units, not a string. The adapter serialises it.
      amount: { amountMinor: 2500, currency: "USD" },
    });
  });

  it("records identities derived from the server, not the caller", async () => {
    await initiateTransfer({
      ...VALID_INTENT,
      // A caller trying to forge both sides of the record.
      senderId: "user-doc-mallory",
      receiverId: "user-doc-mallory",
      senderBankId: "bank-doc-alice",
      receiverBankId: "bank-doc-mallory",
    } as unknown);

    const written = createTransactionRecord.mock.calls[0][0];
    expect(written).toMatchObject({
      senderId: "user-doc-alice",     // the actor
      senderBankId: "bank-doc-alice", // the owned source
      receiverId: "user-doc-bob",     // the resolved recipient
      receiverBankId: "bank-doc-bob",
      amount: "25.00",  // legacy string column, produced by the exact formatter
    });
    expect(written).not.toHaveProperty("sourceFundingSourceUrl");
    expect(written).not.toHaveProperty("fundingSourceUrl");
  });

  it("ignores funding-source URLs supplied by the caller", async () => {
    await initiateTransfer({
      ...VALID_INTENT,
      sourceFundingSourceUrl: "https://attacker.invalid/funding-sources/victim",
      destinationFundingSourceUrl: "https://attacker.invalid/funding-sources/attacker",
    } as unknown);

    // The schema strips unknown keys, and the service reads funding sources
    // from the records it resolved itself.
    expect(createDwollaTransfer).toHaveBeenCalledWith({
      sourceFundingSourceUrl: ALICE_BANK.fundingSourceUrl,
      destinationFundingSourceUrl: BOB_BANK.fundingSourceUrl,
      amount: { amountMinor: 2500, currency: "USD" },
    });
  });

  it.each([
    ["10", 1000, "10.00"],
    ["10.5", 1050, "10.50"],
    ["0.01", 1, "0.01"],
    ["1000.99", 100099, "1000.99"],
  ])(
    "form string %s becomes %d minor units and persists as %s",
    async (input, minor, persisted) => {
      await initiateTransfer({ ...VALID_INTENT, amount: input });

      expect(createDwollaTransfer.mock.calls[0][0].amount).toEqual({
        amountMinor: minor,
        currency: "USD",
      });
      expect(createTransactionRecord.mock.calls[0][0].amount).toBe(persisted);
    }
  );
});

describe("H. provider failure", () => {
  it("writes no transaction record when Dwolla rejects the transfer", async () => {
    createDwollaTransfer.mockRejectedValue(new Error("dwolla rejected"));

    await expect(initiateTransfer(VALID_INTENT)).rejects.toThrow();

    // A record here would be a transfer that never happened.
    expect(createTransactionRecord).not.toHaveBeenCalled();
  });
});

describe("I. provider succeeded but the local write failed", () => {
  it("reports the partial failure instead of claiming nothing happened", async () => {
    createTransactionRecord.mockRejectedValue(new Error("appwrite is down"));

    const error = await initiateTransfer(VALID_INTENT).catch((e: unknown) => e);

    // Dwolla already accepted the transfer. It cannot be undone by not writing
    // a row, and reporting a plain failure would tell the user their money did
    // not move when it did.
    expect(error).toBeInstanceOf(TransferSubmittedButNotRecordedError);
    expect(createDwollaTransfer).toHaveBeenCalledTimes(1);
  });

  it("does not put provider credentials into the error", async () => {
    createTransactionRecord.mockRejectedValue(new Error("appwrite is down"));

    const error = await initiateTransfer(VALID_INTENT).catch((e: unknown) => e);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;

    expect(text).not.toContain("funding-sources");
    expect(text).not.toContain("REDACTED-ALICE-ACCESS-TOKEN");
  });
});

describe("J. the returned DTO", () => {
  it("has exactly the allowlisted shape", async () => {
    const result = await initiateTransfer(VALID_INTENT);

    expect(result).toEqual({ transactionId: "tx-doc-1", status: "submitted" });
    expect(Object.keys(result).sort()).toEqual([...TRANSFER_RESULT_DTO_FIELDS].sort());
  });

  it("carries no provider credential or record", async () => {
    const wire = JSON.stringify(await initiateTransfer(VALID_INTENT));

    for (const forbidden of [
      "funding-sources",
      "REDACTED-ALICE-ACCESS-TOKEN",
      "REDACTED-BOB-ACCESS-TOKEN",
      "dwolla-alice",
      "plaid-account-bob",
      "transfer-1",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("says submitted, never completed — ACH settles asynchronously", async () => {
    const result = await initiateTransfer(VALID_INTENT);

    expect(result.status).toBe("submitted");
    // There is no webhook or state machine to learn the real outcome yet.
    expect(result.status).not.toBe("completed");
  });
});

describe("NOT IDEMPOTENT — tracked defect", () => {
  it("two calls create two provider transfers", async () => {
    await initiateTransfer(VALID_INTENT);
    await initiateTransfer(VALID_INTENT);

    // Server ownership removed the browser's capability to name funding
    // sources. It did NOT deduplicate requests. A retry, a second tab or a
    // replayed request still moves money twice.
    expect(createDwollaTransfer).toHaveBeenCalledTimes(2);
    expect(createTransactionRecord).toHaveBeenCalledTimes(2);
    // AFTER (idempotency milestone): the second call replays the first result
    // and the provider is called once.
  });
});
