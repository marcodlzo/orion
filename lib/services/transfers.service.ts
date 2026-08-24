// Server-only. Owns the entire money-movement sequence.
//
// The browser submits an intent and receives a result. Everything between —
// authorising the source, resolving the recipient, obtaining provider funding
// sources, calling Dwolla, recording the transaction — happens here, where the
// caller cannot influence it.
//
// Previously the browser did all of this across four server actions and held
// both funding-source URLs. Possession of a funding-source URL is sufficient to
// move money from it, so that was an account-drain primitive.
import "server-only";

import { z } from "zod";

import type { Actor } from "../auth/actor";
import { createDwollaTransfer } from "../server/dwolla";
import {
  findCounterpartyBankByAccountId,
  getOwnedBankByDocumentId,
} from "../repositories/banks.repository";
import { NotFoundError } from "../repositories/errors";
import {
  createTransactionRecord,
  toLegacyTransactionAmount,
} from "../repositories/transactions.repository";
import { isPositive, tryParseUsd, type Money } from "../domain/money";
import type { TransferResultDTO } from "../dto/transfer.dto";

/**
 * Server-side validation of the transfer intent.
 *
 * The form's own zod schema exists for user feedback and is not a security
 * boundary — a caller can post whatever they like directly to the action.
 * This runs on the server, on every call.
 *
 * The amount arrives as a string because a form produces one, and is parsed to
 * exact minor units here. Nothing downstream sees the string.
 */
export const transferIntentSchema = z.object({
  senderBankId: z.string().trim().min(1, "Select an account to send from"),
  recipientReference: z.string().trim().min(1, "Enter a recipient reference"),
  /**
   * Parsed to exact minor units at the server boundary.
   *
   * A form produces a string, so the input is a string. It stops being one
   * immediately: everything downstream receives Money, and no float is ever
   * involved in deciding what to move.
   *
   * `.trim()` is input normalisation for a form value. parseUsd itself rejects
   * surrounding whitespace — leniency lives at the edge, not in the primitive.
   */
  amount: z
    .string()
    .trim()
    .transform((value, ctx): Money => {
      const money = tryParseUsd(value);
      if (!money) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Enter an amount such as 10 or 10.50",
        });
        return z.NEVER;
      }
      if (!isPositive(money)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Amount must be greater than zero",
        });
        return z.NEVER;
      }
      return money;
    }),
  note: z.string().trim().max(200).optional().default(""),
  /**
   * Recipient email as typed by the sender.
   *
   * UNVERIFIED display metadata. It is not used to resolve or authorise
   * anything — the recipient is resolved from recipientReference. It is stored
   * because the existing transaction schema has the column.
   */
  recipientEmail: z.string().trim().email().max(254).optional().default(""),
});

export type TransferIntent = z.input<typeof transferIntentSchema>;

/** Raised when the caller's intent is not usable. */
export class InvalidTransferIntentError extends Error {
  readonly code = "INVALID_TRANSFER_INTENT";
  readonly issues: string[];

  constructor(issues: string[]) {
    super("Transfer intent is not valid");
    this.name = "InvalidTransferIntentError";
    this.issues = issues;
    Object.setPrototypeOf(this, InvalidTransferIntentError.prototype);
  }
}

/**
 * Raised when Dwolla accepted the transfer but the local record could not be
 * written.
 *
 * This is deliberately NOT reported as a failure. The money movement was
 * submitted to the provider and cannot be undone by deleting a local row; a
 * fake rollback would be a lie. The caller must be told the transfer was
 * submitted and that our record is missing.
 *
 * Resolving this properly needs the provider reference persisted and a
 * reconciliation pass. Both are later milestones — see the schema note on
 * PROVIDER_REFERENCE_PERSISTENCE below.
 */
export class TransferSubmittedButNotRecordedError extends Error {
  readonly code = "TRANSFER_SUBMITTED_NOT_RECORDED";

  constructor(options?: { cause?: unknown }) {
    super(
      "The transfer was submitted to the provider but could not be recorded locally"
    );
    this.name = "TransferSubmittedButNotRecordedError";
    if (options?.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, TransferSubmittedButNotRecordedError.prototype);
  }
}

/**
 * BLOCKED ON DATASTORE SCHEMA.
 *
 * Dwolla returns a transfer URL and id. Without storing it, no local record can
 * ever be matched to a provider transfer, which makes reconciliation
 * structurally impossible.
 *
 * The Appwrite transaction collection currently has no attribute for it, and
 * Appwrite rejects a createDocument containing an unknown attribute, so writing
 * one would fail at runtime. Adding it requires a console change:
 *
 *   collection: transactions
 *   attribute:  providerTransferId   String(255)   optional
 *
 * Until that exists the reference is captured and deliberately dropped rather
 * than silently invented. It is NOT returned to the browser.
 */
export const PROVIDER_REFERENCE_PERSISTENCE = "blocked: schema lacks providerTransferId";

/** Decode the recipient reference without throwing on malformed input. */
function decodeRecipientReference(reference: string): string | null {
  try {
    // The shareable id is base64 of the Plaid account id. That is ADDRESSING
    // AND ENCODING, not encryption — anyone can decode one. Replacing it with
    // an opaque reference is its own milestone.
    const decoded = Buffer.from(reference, "base64").toString("utf8");
    if (!decoded || !/^[\w-]+$/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Appwrite relationships read back as the related document. */
function relatedUserId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as { $id?: unknown }).$id;
    if (typeof id === "string") return id;
  }
  return "";
}

/**
 * Move money from one of the actor's own accounts to a recipient.
 *
 * Sequence — every step server-side, in this order:
 *   1. validate the intent (the caller's zod schema is not a boundary)
 *   2. resolve the source bank AS OWNED by the actor; not owned -> NotFound
 *   3. resolve the recipient internally from the reference
 *   4. read both funding-source URLs, which never leave this function
 *   5. call Dwolla
 *   6. record the transaction from server-derived identities
 *   7. return a narrow DTO
 *
 * NOT IDEMPOTENT. Two calls create two transfers. Moving orchestration to the
 * server removes the browser's capability; it does not deduplicate requests.
 */
export async function executeTransfer(
  actor: Actor,
  rawIntent: unknown
): Promise<TransferResultDTO> {
  // 1. validate
  const parsed = transferIntentSchema.safeParse(rawIntent);
  if (!parsed.success) {
    throw new InvalidTransferIntentError(
      parsed.error.issues.map((issue) => issue.message)
    );
  }
  const intent = parsed.data;

  // 2. the source must belong to the actor. Ownership is part of the query, so
  //    another user's bank is never loaded.
  const sourceBank = await getOwnedBankByDocumentId(actor, intent.senderBankId);
  if (!sourceBank) {
    throw new NotFoundError("Bank not found");
  }

  // 3. resolve the recipient server-side. The browser never sees this record.
  const recipientAccountId = decodeRecipientReference(intent.recipientReference);
  if (!recipientAccountId) {
    throw new InvalidTransferIntentError(["Recipient reference is not valid"]);
  }

  const recipientBank = await findCounterpartyBankByAccountId(recipientAccountId);
  if (!recipientBank) {
    // Same response as a malformed reference: do not confirm whether a given
    // reference corresponds to a real account.
    throw new NotFoundError("Recipient not found");
  }

  if (recipientBank.$id === sourceBank.$id) {
    throw new InvalidTransferIntentError(["Cannot transfer to the same account"]);
  }

  // 4-5. Provider credentials are read and used here and never escape this
  //      function. They are not in the input, the output, any DTO, or any log.
  const providerResult = await createDwollaTransfer({
    sourceFundingSourceUrl: sourceBank.fundingSourceUrl,
    destinationFundingSourceUrl: recipientBank.fundingSourceUrl,
    // Money, not a string. The adapter decides Dwolla's wire format.
    amount: intent.amount,
  });

  // Captured but not persisted — see PROVIDER_REFERENCE_PERSISTENCE.
  void providerResult.transferId;

  // 6. Identities are server-derived. The caller supplies neither side.
  let record;
  try {
    record = await createTransactionRecord({
      name: intent.note || "Transfer",
      // Degraded to the legacy string column here and nowhere else.
      amount: toLegacyTransactionAmount(intent.amount),
      senderId: actor.userId,
      senderBankId: sourceBank.$id,
      receiverId: relatedUserId(recipientBank.userId),
      receiverBankId: recipientBank.$id,
      email: intent.recipientEmail,
    });
  } catch (error) {
    // Dwolla already accepted the transfer. Reporting failure here would tell
    // the user nothing happened, which is false.
    throw new TransferSubmittedButNotRecordedError({ cause: error });
  }

  // 7. narrow result
  return {
    transactionId: record.$id,
    // "submitted", never "completed": ACH settles asynchronously and this
    // application has no webhook or state machine to learn the outcome.
    status: "submitted",
  };
}
