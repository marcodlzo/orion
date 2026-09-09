import { describe, it, expect, vi, beforeEach } from "vitest";

import { NotFoundError } from "../repositories/errors";
import { IdentityConflictError } from "../db/errors";
import { UnauthorizedError } from "../auth/errors";
import {
  InvalidTransferIntentError,
  InsufficientAvailableFundsError,
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
 * IDEMPOTENCY IS PROVEN HERE, in `K. idempotency`, by replaying the request and
 * asserting one financial effect — never by observing that a key row exists.
 *
 * The Appwrite transaction write is GONE as of the history cutover, so a
 * transfer is recorded once, in PostgreSQL, before the provider is called.
 */

const {
  cookieGet,
  accountGet,
  findUserByAuthId,
  getOwnedBankByDocumentId,
  findCounterpartyBankByAccountId,
  createTransactionRecord,
  createDwollaTransfer,
  findCustomerByAuthId,
  upsertBankingCustomer,
  ensureBankingCustomer,
  claimTransfer,
  markSubmitted,
  markFailed,
  ensureCustomerAccount,
  placeHold,
  releaseHold,
  callOrder,
} = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  accountGet: vi.fn(),
  findUserByAuthId: vi.fn(),
  getOwnedBankByDocumentId: vi.fn(),
  findCounterpartyBankByAccountId: vi.fn(),
  createTransactionRecord: vi.fn(),
  createDwollaTransfer: vi.fn(),
  findCustomerByAuthId: vi.fn(),
  upsertBankingCustomer: vi.fn(),
  ensureBankingCustomer: vi.fn(),
  claimTransfer: vi.fn(),
  markSubmitted: vi.fn(),
  markFailed: vi.fn(),
  ensureCustomerAccount: vi.fn(),
  placeHold: vi.fn(),
  releaseHold: vi.fn(),
  /** Records the order money-affecting steps ran in. */
  callOrder: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: cookieGet, set: vi.fn(), delete: vi.fn() }),
  headers: () => new Headers(),
}));
/**
 * The rate limiter, always under its limit.
 *
 * A FAITHFUL FAKE: the real repository returns the hit count AFTER recording,
 * and the service compares that against the rule. Returning 1 is "first attempt
 * in this window", which is what these tests assume.
 *
 * Stubbing it is required, not cosmetic. The limiter FAILS CLOSED, so without a
 * fake every action here refuses with RateLimiterUnavailableError before
 * reaching the behaviour under test.
 */
vi.mock("../db/repositories/rate-limits.repository", () => ({
  recordAttempt: vi.fn(async () => 1),
  attemptsIn: vi.fn(async () => 0),
  sweepExpiredCounters: vi.fn(async () => 0),
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
vi.mock("../db/repositories/banking-customers.repository", () => ({
  findCustomerByAuthId,
  upsertBankingCustomer,
  ensureBankingCustomer,
  findCustomerByUserDocumentId: vi.fn(),
  countBankingCustomers: vi.fn(),
  listBankingCustomers: vi.fn(),
}));
vi.mock("../db/repositories/transfers.repository", () => ({
  claimTransfer,
  markSubmitted,
  markFailed,
  findTransferByProviderId: vi.fn(),
  listTransfersForCustomer: vi.fn(),
}));
// The transaction wrapper is replaced with one that simply runs the callback.
// It is NOT pretending to be transactional: atomicity is a property of a real
// server and is asserted in the .db.test suites. What this file proves is the
// ORDER and the CONDITIONS — that a hold is placed before the provider is
// called, and that a refusal stops the sequence.
vi.mock("../db/pool", () => ({
  withTransaction: <T,>(fn: (client: unknown) => Promise<T>) => fn({}),
  query: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  readMoneyMinor: vi.fn(),
}));
vi.mock("../db/repositories/ledger.repository", () => ({
  ensureCustomerAccount,
  ensureSettlementAccount: vi.fn(),
  postTransaction: vi.fn(),
  balanceOf: vi.fn(),
  totalAcrossAllAccounts: vi.fn(),
  entriesForTransaction: vi.fn(),
  entriesForTransfer: vi.fn(),
}));
vi.mock("../db/repositories/holds.repository", () => ({
  placeHold,
  releaseHold,
  captureHold: vi.fn(),
  activeHoldTotal: vi.fn(),
  availableBalanceOf: vi.fn(),
  findHoldByTransfer: vi.fn(),
}));
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

/** One per submission attempt; the browser resends it unchanged on retry. */
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const VALID_INTENT = {
  idempotencyKey: KEY,
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
  // Already enrolled, which is every call after a customer's first. Enrolment
  // itself — creating the row, and refusing a bridge that names a different
  // user document — is a property of a unique constraint and is proven against
  // a real server in transfers.service.db.test.ts. What this file proves is
  // that the service asks for it with SESSION values, inside the claim's
  // transaction.
  ensureBankingCustomer.mockResolvedValue({
    row: {
      id: "pg-customer-alice",
      appwrite_auth_id: "auth-alice",
      appwrite_user_document_id: "user-doc-alice",
    },
    created: false,
  });
  // A fresh claim: this call owns the attempt and nothing has been sent yet.
  claimTransfer.mockResolvedValue({
    kind: "claimed",
    row: { id: "pg-transfer-1", state: "requested" },
  });
  markSubmitted.mockResolvedValue({ id: "pg-transfer-1", state: "submitted" });
  markFailed.mockResolvedValue({ id: "pg-transfer-1", state: "failed" });
  ensureCustomerAccount.mockResolvedValue({ id: "pg-account-alice" });
  callOrder.length = 0;
  placeHold.mockImplementation(async () => {
    callOrder.push("placeHold");
    return { kind: "placed", row: { id: "pg-hold-1", state: "active" } };
  });
  releaseHold.mockImplementation(async () => {
    callOrder.push("releaseHold");
    return { id: "pg-hold-1", state: "released" };
  });
  createDwollaTransfer.mockImplementation(async () => {
    callOrder.push("provider");
    return {
      transferUrl: "https://api-sandbox.dwolla.invalid/transfers/transfer-1",
      transferId: "transfer-1",
    };
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
      // Travels with the request: Dwolla returns the original transfer rather
      // than creating a second one if this call is ever repeated.
      idempotencyKey: KEY,
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

    // ASSERTED ON THE CLAIM, not on an Appwrite document. The second write is
    // gone with the history cutover, so the parties are recorded once — in
    // PostgreSQL, BEFORE the provider is called, rather than in a second store
    // afterwards.
    const claimed = claimTransfer.mock.calls[0][0];
    expect(claimed).toMatchObject({
      senderBankDocumentId: "bank-doc-alice",   // the owned source
      recipientUserDocumentId: "user-doc-bob",  // the resolved recipient
      recipientBankDocumentId: "bank-doc-bob",
      // EXACT MINOR UNITS, not the legacy decimal string. That degradation
      // existed only for the Appwrite column and went with it.
      amountMinor: 2500,
      currency: "USD",
    });
    // The actor owns the row; the caller's forged sender is nowhere in it.
    expect(claimed.customerId).toBe("pg-customer-alice");
    expect(JSON.stringify(claimed)).not.toContain("mallory");
    expect(claimed).not.toHaveProperty("sourceFundingSourceUrl");
    expect(claimed).not.toHaveProperty("fundingSourceUrl");
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
      idempotencyKey: KEY,
    });
  });

  it.each([
    ["10", 1000],
    ["10.5", 1050],
    ["0.01", 1],
    ["1000.99", 100099],
  ])(
    "form string %s becomes %d minor units, to the provider and to storage",
    async (input, minor) => {
      await initiateTransfer({ ...VALID_INTENT, amount: input });

      expect(createDwollaTransfer.mock.calls[0][0].amount).toEqual({
        amountMinor: minor,
        currency: "USD",
      });
      // STRONGER THAN IT WAS. This used to assert a decimal STRING reaching the
      // Appwrite column, which was the one place money was degraded on its way
      // to storage. It is integer minor units the whole way now.
      expect(claimTransfer.mock.calls[0][0].amountMinor).toBe(minor);
    }
  );
});

describe("H. provider failure", () => {
  it("marks the transfer failed and releases the hold when Dwolla rejects it", async () => {
    createDwollaTransfer.mockRejectedValue(new Error("dwolla rejected"));

    await expect(initiateTransfer(VALID_INTENT)).rejects.toThrow();

    // The claim is DELIBERATELY still there — it was committed before the
    // provider was called, which is what makes a retry safe. What must happen
    // is an explicit terminal state and the reservation given back, rather
    // than an abandoned row quietly consuming the customer's allowance.
    expect(markFailed).toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
  });
});

describe("I. provider succeeded but the local write failed", () => {
  it("reports the partial failure instead of claiming nothing happened", async () => {
    // THE CAUSE CHANGED, THE INVARIANT DID NOT. This used to inject a failing
    // Appwrite write; there is no local write after the provider call any more.
    // What remains is the genuinely unrecoverable case: Dwolla accepts and
    // returns NO reference, so the transfer can never be matched to a provider
    // record.
    createDwollaTransfer.mockResolvedValue({ transferUrl: null, transferId: null });

    const error = await initiateTransfer(VALID_INTENT).catch((e: unknown) => e);

    // Money moved. Reporting a plain failure would tell the user it did not.
    expect(error).toBeInstanceOf(TransferSubmittedButNotRecordedError);
    expect(createDwollaTransfer).toHaveBeenCalledTimes(1);
    // NOT marked failed — that would claim nothing happened — and NOT given a
    // placeholder reference, which would defeat the unique index. The claim
    // stays `requested`, which is what the unresolved-attempt index surfaces.
    expect(markFailed).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  it("does not put provider credentials into the error", async () => {
    createDwollaTransfer.mockResolvedValue({ transferUrl: null, transferId: null });

    const error = await initiateTransfer(VALID_INTENT).catch((e: unknown) => e);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;

    expect(text).not.toContain("funding-sources");
    expect(text).not.toContain("REDACTED-ALICE-ACCESS-TOKEN");
  });
});

describe("J. the returned DTO", () => {
  it("has exactly the allowlisted shape", async () => {
    const result = await initiateTransfer(VALID_INTENT);

    expect(result).toEqual({
      transactionId: "pg-transfer-1",
      status: "submitted",
      // A fresh submission, not a replay. The client has to be able to tell.
      replayed: false,
    });
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
      "https://api-sandbox.dwolla.invalid/transfers/transfer-1",
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

// The "NOT IDEMPOTENT" characterisation test stood here. It asserted the
// pre-Phase-7 behaviour — two calls, two provider transfers — and its own
// AFTER note said it would be replaced when idempotency landed. It has been:
// `K. idempotency` below proves the real behaviour by REPLAY, which is the only
// way that proves anything. Removing a defect test whose milestone has landed is
// the intended lifecycle, not a loss of coverage.

/**
 * IDEMPOTENCY, AT THE ENDPOINT.
 *
 * Asserted by REPLAY — issuing the request again and checking there is one
 * financial effect — never by observing that a key row exists. A key table can
 * be perfectly populated while the provider was called twice.
 */
describe("K. idempotency", () => {
  it("REPLAY: a resolved key returns the original result and calls no provider", async () => {
    claimTransfer.mockResolvedValue({
      kind: "replayed",
      row: { id: "pg-transfer-1", state: "submitted" },
    });

    const result = await initiateTransfer(VALID_INTENT);

    // The assertion that matters: zero provider calls, not "a row was found".
    expect(createDwollaTransfer).not.toHaveBeenCalled();
    expect(createTransactionRecord).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
    expect(result.status).toBe("submitted");
  });

  it("REPLAY of a failed attempt reports failed, not submitted", async () => {
    claimTransfer.mockResolvedValue({
      kind: "replayed",
      row: { id: "pg-transfer-1", state: "failed" },
    });

    const result = await initiateTransfer(VALID_INTENT);

    // Answering "submitted" for an attempt that failed would tell the user
    // money is moving when it is not.
    expect(result.status).toBe("failed");
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });

  it("claims the key BEFORE calling the provider", async () => {
    const order: string[] = [];
    claimTransfer.mockImplementation(async () => {
      order.push("claim");
      return { kind: "claimed", row: { id: "pg-transfer-1", state: "requested" } };
    });
    createDwollaTransfer.mockImplementation(async () => {
      order.push("provider");
      return { transferUrl: "https://dwolla.invalid/transfers/t-1", transferId: "t-1" };
    });

    await initiateTransfer(VALID_INTENT);

    // The ordering IS the mechanism. A claim made after the call leaves exactly
    // the gap the key exists to close.
    expect(order).toEqual(["claim", "provider"]);
  });

  it("sends the caller's key to the provider unchanged", async () => {
    await initiateTransfer(VALID_INTENT);

    expect(createDwollaTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: KEY })
    );
  });

  it("records the provider reference that used to be discarded", async () => {
    await initiateTransfer(VALID_INTENT);

    expect(markSubmitted).toHaveBeenCalledWith(
      { transferId: "pg-transfer-1", providerTransferId: "transfer-1" },
      // In a transaction, so the audit trail can record the cause. Outside one
      // there is nothing to scope the cause to and the most important
      // transition a transfer makes would be logged as 'unrecorded'.
      expect.anything()
    );
  });

  it("an in-flight claim re-drives the provider with the same key", async () => {
    // A previous attempt died between claiming and hearing back. Re-sending is
    // safe precisely because the key goes with it.
    claimTransfer.mockResolvedValue({
      kind: "in-flight",
      row: { id: "pg-transfer-1", state: "requested" },
    });

    await initiateTransfer(VALID_INTENT);

    expect(createDwollaTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: KEY })
    );
  });

  it("CONFLICT: the same key with a different payload is refused", async () => {
    claimTransfer.mockRejectedValue(
      new IdentityConflictError({
        field: "transfers.idempotency_key",
        stored: "fp-original",
        incoming: "fp-different",
      })
    );

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(
      IdentityConflictError
    );
    // Never silently replayed and never silently accepted.
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before doing anything", async () => {
    await expect(
      initiateTransfer({ ...VALID_INTENT, idempotencyKey: "not-a-uuid" })
    ).rejects.toBeInstanceOf(InvalidTransferIntentError);

    expect(claimTransfer).not.toHaveBeenCalled();
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });

  it("rejects a missing key", async () => {
    const { idempotencyKey, ...withoutKey } = VALID_INTENT;
    void idempotencyKey;

    await expect(initiateTransfer(withoutKey)).rejects.toBeInstanceOf(
      InvalidTransferIntentError
    );
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });

  it("marks the attempt failed when the provider rejects it", async () => {
    createDwollaTransfer.mockRejectedValue(new Error("provider said no"));

    await expect(initiateTransfer(VALID_INTENT)).rejects.toThrow();

    // An explicit terminal state, not an abandoned `requested` row. The second
    // argument is the transaction client: the failure and the release of the
    // hold happen together, so asserting it is present is part of the point.
    expect(markFailed).toHaveBeenCalledWith(
      {
        transferId: "pg-transfer-1",
        failureCode: "PROVIDER_REJECTED",
        // The audit trail records WHY, not just that the state changed.
        cause: "provider-rejected",
      },
      expect.anything()
    );
  });

  it("RESERVES THE FUNDS BEFORE CALLING THE PROVIDER", async () => {
    // The ordering is the mechanism, exactly as it is for the idempotency
    // claim. A hold placed after the provider call reserves nothing: by then
    // the money is already moving, and a concurrent request has already been
    // let through on a view of the account that was never true.
    await initiateTransfer(VALID_INTENT);

    expect(callOrder).toEqual(["placeHold", "provider"]);
  });

  it("refuses when the funds are not available, and never reaches the provider", async () => {
    placeHold.mockResolvedValue({
      kind: "insufficient",
      availableMinor: 5_00,
      requestedMinor: 10_00,
    });

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(
      InsufficientAvailableFundsError
    );

    // NO PROVIDER CALL AT ALL. Nothing is in motion to unwind.
    expect(createDwollaTransfer).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
    expect(createTransactionRecord).not.toHaveBeenCalled();
  });

  it("records an explicit failure for a refused transfer rather than abandoning it", async () => {
    // The key stays claimed and the transfer reaches a terminal state, so a
    // retry with the same key is answered from the record instead of running
    // the same check again.
    placeHold.mockResolvedValue({
      kind: "insufficient",
      availableMinor: 5_00,
      requestedMinor: 10_00,
    });

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(
      InsufficientAvailableFundsError
    );

    expect(markFailed).toHaveBeenCalledWith(
      {
        transferId: "pg-transfer-1",
        failureCode: "INSUFFICIENT_AVAILABLE_FUNDS",
        cause: "insufficient-funds",
      },
      expect.anything()
    );
  });

  it("releases the reservation when the provider rejects the transfer", async () => {
    createDwollaTransfer.mockImplementation(async () => {
      callOrder.push("provider");
      throw new Error("provider said no");
    });

    await expect(initiateTransfer(VALID_INTENT)).rejects.toThrow();

    // Held, then released — money that never moved does not go on consuming
    // this customer's available balance.
    expect(callOrder).toEqual(["placeHold", "provider", "releaseHold"]);
    expect(releaseHold).toHaveBeenCalledWith("pg-transfer-1", expect.anything());
  });

  it("does not reserve funds a second time on replay", async () => {
    // A replayed key is answered from the record. Placing another hold would
    // reserve the money twice and could refuse a transfer the customer can
    // afford.
    claimTransfer.mockResolvedValue({
      kind: "replayed",
      row: { id: "pg-transfer-1", state: "submitted" },
    });

    const result = await initiateTransfer(VALID_INTENT);

    expect(result).toMatchObject({ replayed: true });
    expect(placeHold).not.toHaveBeenCalled();
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });

  it("does not record a provider reference it never received", async () => {
    // Dwolla accepted but returned no location header. Money may have moved
    // and there is nothing to reconcile it against.
    createDwollaTransfer.mockResolvedValue({ transferUrl: null, transferId: null });

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(
      TransferSubmittedButNotRecordedError
    );

    expect(markSubmitted).not.toHaveBeenCalled();
    // NOT marked failed: that would claim nothing happened.
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("enrols the customer from the session, inside the claim's transaction", async () => {
    // BEHAVIOUR DELIBERATELY REVERSED. This used to assert a refusal for a
    // customer with no bridge row, on the reasoning that a missing row meant an
    // unmigrated customer whose transfer could not be reconciled. That held
    // while `npm run db:backfill` was the only writer of the table — and it
    // meant every user who signed up after the last backfill was permanently
    // unable to transfer, because nothing in the application ever created the
    // row.
    //
    // The refusal is not a safety property being given up. Both identifiers are
    // read from the verified session, so this writes exactly what the backfill
    // would have written for the same user.
    ensureBankingCustomer.mockResolvedValue({
      row: {
        id: "pg-customer-alice",
        appwrite_auth_id: "auth-alice",
        appwrite_user_document_id: "user-doc-alice",
      },
      created: true,
    });

    await expect(initiateTransfer(VALID_INTENT)).resolves.toMatchObject({
      status: "submitted",
    });

    // The SESSION's identifiers, and a transaction client rather than the pool:
    // enrolling on its own connection would commit a bridge row for a transfer
    // that then failed to claim.
    expect(ensureBankingCustomer).toHaveBeenCalledWith(
      {
        appwriteAuthId: "auth-alice",
        appwriteUserDocumentId: "user-doc-alice",
      },
      expect.anything()
    );
    expect(claimTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "pg-customer-alice" }),
      expect.anything()
    );
  });

  it("moves no money when enrolment refuses an identity collision", async () => {
    // The bridge maps this login to somebody else's user document. The
    // repository refuses; what matters here is that the refusal stops the
    // sequence rather than being absorbed.
    ensureBankingCustomer.mockRejectedValue(
      new IdentityConflictError({
        field: "banking_customers.appwrite_auth_id=auth-alice",
        stored: "user-doc-someone-else",
        incoming: "user-doc-alice",
      })
    );

    await expect(initiateTransfer(VALID_INTENT)).rejects.toBeInstanceOf(
      IdentityConflictError
    );

    expect(claimTransfer).not.toHaveBeenCalled();
    expect(placeHold).not.toHaveBeenCalled();
    expect(createDwollaTransfer).not.toHaveBeenCalled();
  });

  it("derives the customer from the session, never from the caller", async () => {
    await initiateTransfer({
      ...VALID_INTENT,
      customerId: "pg-customer-mallory",
    } as never);

    // The extra key is stripped by the schema; the claim uses the actor's own
    // customer id.
    expect(claimTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "pg-customer-alice" }),
      // Claimed inside a transaction — the same one that reserves the funds.
      expect.anything()
    );
  });

  it("fingerprints server-resolved values, not the raw request", async () => {
    await initiateTransfer(VALID_INTENT);
    const first = claimTransfer.mock.calls[0][0].requestFingerprint;

    vi.clearAllMocks();
    authenticateAlice();
    getOwnedBankByDocumentId.mockResolvedValue(ALICE_BANK);
    findCounterpartyBankByAccountId.mockResolvedValue(BOB_BANK);
    // Already enrolled, which is every call after a customer's first. Enrolment
  // itself — creating the row, and refusing a bridge that names a different
  // user document — is a property of a unique constraint and is proven against
  // a real server in transfers.service.db.test.ts. What this file proves is
  // that the service asks for it with SESSION values, inside the claim's
  // transaction.
  ensureBankingCustomer.mockResolvedValue({
    row: {
      id: "pg-customer-alice",
      appwrite_auth_id: "auth-alice",
      appwrite_user_document_id: "user-doc-alice",
    },
    created: false,
  });
    claimTransfer.mockResolvedValue({
      kind: "claimed",
      row: { id: "pg-transfer-1", state: "requested" },
    });
    markSubmitted.mockResolvedValue({ id: "pg-transfer-1", state: "submitted" });
    createDwollaTransfer.mockResolvedValue({
      transferUrl: "https://dwolla.invalid/transfers/dwolla-transfer-1",
      transferId: "dwolla-transfer-1",
    });
    createTransactionRecord.mockResolvedValue({ $id: "tx-doc-1" });

    // Same transfer, cosmetically different input: a different note and a
    // differently-spelled amount that parses to the same minor units.
    await initiateTransfer({ ...VALID_INTENT, amount: "25", note: "Something else" });
    const second = claimTransfer.mock.calls[0][0].requestFingerprint;

    // Neither the note nor the string form is part of what moves money.
    expect(second).toBe(first);
  });

  it("a different amount produces a different fingerprint", async () => {
    await initiateTransfer(VALID_INTENT);
    const first = claimTransfer.mock.calls[0][0].requestFingerprint;

    await initiateTransfer({ ...VALID_INTENT, amount: "26.00" });
    const second = claimTransfer.mock.calls[1][0].requestFingerprint;

    // Otherwise one key could move two different sums.
    expect(second).not.toBe(first);
  });
});
