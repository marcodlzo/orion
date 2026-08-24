/**
 * Legacy Appwrite documents → PostgreSQL rows.
 *
 * Pure. No I/O, no clients, no environment. The riskiest part of a migration is
 * deciding what maps to what, so that decision lives somewhere it can be tested
 * exhaustively without a database or a provider.
 *
 * WHAT IS DELIBERATELY NOT MAPPED
 *   accessToken, fundingSourceUrl, processorToken  provider credentials; the
 *     schema has no column for them, and moving plaintext secrets into a new
 *     datastore is not a security improvement
 *   ssn, dateOfBirth, address, city, state, postalCode  the target is an
 *     identity mapping, not a second profile store
 *   dwollaCustomerId, dwollaCustomerUrl  provider identity, out of scope
 *   shareableId  no column; the recipient-reference scheme is being replaced
 *   balances  there is no balance column, on purpose
 */

import type {
  LegacyBankDocument,
  LegacyUserDocument,
} from "./appwrite-source";

export type CustomerPlan = {
  appwriteAuthId: string;
  appwriteUserDocumentId: string;
};

export type LinkedAccountPlan = {
  /** The user DOCUMENT id this account belongs to; resolved to a UUID later. */
  ownerUserDocumentId: string;
  legacyAppwriteBankDocumentId: string;
  externalAccountId: string;
  provider: "plaid";
  /** The Plaid access token, used ONLY to enrich metadata. Never persisted. */
  accessTokenForEnrichment: string;
};

export type SkipCode =
  | "MISSING_DOCUMENT_ID"
  | "MISSING_AUTH_ID"
  | "DUPLICATE_AUTH_ID"
  | "MISSING_OWNER"
  | "OWNER_NOT_MIGRATABLE"
  | "MISSING_ACCOUNT_ID"
  | "DUPLICATE_OWNER_ACCOUNT";

export type SkippedRecord = {
  kind: "user" | "bank";
  id: string;
  code: SkipCode;
  reason: string;
};

export type MappingResult = {
  customers: CustomerPlan[];
  accounts: LinkedAccountPlan[];
  skipped: SkippedRecord[];
};

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Resolve the owning user-document id from a bank record.
 *
 * `userId` on the bank collection is an Appwrite relationship. Depending on how
 * the document was read it comes back either as the related document or as a
 * bare id string, so both shapes are handled rather than assumed.
 *
 * Note the trap this codebase has hit before: the related USER document's own
 * `userId` FIELD holds the AUTH account id, while its `$id` is the document id.
 * Bank ownership points at `$id`.
 */
export function resolveOwnerUserDocumentId(userId: unknown): string {
  if (typeof userId === "string") return userId.trim();
  if (userId && typeof userId === "object") {
    const id = (userId as { $id?: unknown }).$id;
    if (typeof id === "string") return id.trim();
  }
  return "";
}

/**
 * Order-independence.
 *
 * Appwrite returns documents in whatever order the query produced, and that
 * order is not a promise. If the winner of a conflict were "whichever arrived
 * first", the same dataset could migrate differently on two runs — and the
 * difference would be invisible, because both runs would report success.
 *
 * So the source is sorted by document id before anything is decided, and the
 * conflict rule is stated out loud: LOWEST DOCUMENT ID WINS. It is arbitrary,
 * but it is stable, reproducible, and reported. The losing record is never
 * dropped silently; it is skipped with the winner named, so a human can decide
 * whether the tie-break picked the right one.
 */
const byDocumentId = <T extends { $id: string }>(docs: readonly T[]): T[] =>
  [...docs].sort((a, b) => text(a.$id).localeCompare(text(b.$id)));

/**
 * Build the full migration plan.
 *
 * Nothing is dropped silently. A record that cannot be mapped is reported in
 * `skipped` with a code and a reason, so the operator sees exactly what will
 * not migrate and why — a backfill that quietly ignores malformed rows is how a
 * customer discovers their account is missing.
 *
 * Pure and deterministic: the same documents in any order produce the same
 * plan, including the same skips.
 */
export function planMigration(
  users: readonly LegacyUserDocument[],
  banks: readonly LegacyBankDocument[]
): MappingResult {
  const customers: CustomerPlan[] = [];
  const accounts: LinkedAccountPlan[] = [];
  const skipped: SkippedRecord[] = [];

  const knownUserDocumentIds = new Set<string>();
  const authIdOwner = new Map<string, string>();

  for (const user of byDocumentId(users)) {
    const documentId = text(user.$id);
    const authId = text(user.userId);

    if (!documentId) {
      skipped.push({
        kind: "user",
        id: "(no $id)",
        code: "MISSING_DOCUMENT_ID",
        reason: "missing document id",
      });
      continue;
    }
    if (!authId) {
      // A user document with no auth account cannot be signed into. It is a
      // partial-signup artefact, not a customer.
      skipped.push({
        kind: "user",
        id: documentId,
        code: "MISSING_AUTH_ID",
        reason: "missing userId (Appwrite auth account id)",
      });
      continue;
    }

    const winner = authIdOwner.get(authId);
    if (winner) {
      // Two user documents sharing one auth account. The target's unique index
      // would reject the second. Because the input is sorted, `winner` is the
      // lowest document id regardless of the order Appwrite returned.
      skipped.push({
        kind: "user",
        id: documentId,
        code: "DUPLICATE_AUTH_ID",
        reason: `auth id ${authId} is also claimed by ${winner}; kept ${winner} (lowest document id) and skipped this one`,
      });
      continue;
    }

    authIdOwner.set(authId, documentId);
    knownUserDocumentIds.add(documentId);
    customers.push({
      appwriteAuthId: authId,
      appwriteUserDocumentId: documentId,
    });
  }

  const ownerAccountWinner = new Map<string, string>();

  for (const bank of byDocumentId(banks)) {
    const documentId = text(bank.$id);
    const owner = resolveOwnerUserDocumentId(bank.userId);
    const externalAccountId = text(bank.accountId);
    const accessToken = text(bank.accessToken);

    if (!documentId) {
      skipped.push({
        kind: "bank",
        id: "(no $id)",
        code: "MISSING_DOCUMENT_ID",
        reason: "missing document id",
      });
      continue;
    }
    if (!owner) {
      skipped.push({
        kind: "bank",
        id: documentId,
        code: "MISSING_OWNER",
        reason: "missing or unreadable owner relationship",
      });
      continue;
    }
    if (!knownUserDocumentIds.has(owner)) {
      // Orphan: the foreign key would reject it. Usually a bank whose user was
      // deleted, or a user that was itself skipped above.
      skipped.push({
        kind: "bank",
        id: documentId,
        code: "OWNER_NOT_MIGRATABLE",
        reason: `owner ${owner} has no migratable user record`,
      });
      continue;
    }
    if (!externalAccountId) {
      skipped.push({
        kind: "bank",
        id: documentId,
        code: "MISSING_ACCOUNT_ID",
        reason: "missing accountId",
      });
      continue;
    }

    // Scoped to the OWNER, deliberately. Two different customers linking the
    // same provider account is a joint account and is allowed by both this
    // mapper and the schema's (customer, provider, account) unique index. Only
    // the same customer linking it twice is a duplicate.
    const naturalKey = `${owner}::${externalAccountId}`;
    const winner = ownerAccountWinner.get(naturalKey);
    if (winner) {
      skipped.push({
        kind: "bank",
        id: documentId,
        code: "DUPLICATE_OWNER_ACCOUNT",
        reason: `owner ${owner} already links account ${externalAccountId} via ${winner}; kept ${winner} (lowest document id) and skipped this one`,
      });
      continue;
    }
    ownerAccountWinner.set(naturalKey, documentId);

    accounts.push({
      ownerUserDocumentId: owner,
      legacyAppwriteBankDocumentId: documentId,
      externalAccountId,
      provider: "plaid",
      accessTokenForEnrichment: accessToken,
    });
  }

  return { customers, accounts, skipped };
}
