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

export type SkippedRecord = {
  kind: "user" | "bank";
  id: string;
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
 * Build the full migration plan.
 *
 * Nothing is dropped silently. A record that cannot be mapped is reported in
 * `skipped` with a reason, so the operator sees exactly what will not migrate
 * and why — a backfill that quietly ignores malformed rows is how a customer
 * discovers their account is missing.
 */
export function planMigration(
  users: readonly LegacyUserDocument[],
  banks: readonly LegacyBankDocument[]
): MappingResult {
  const customers: CustomerPlan[] = [];
  const accounts: LinkedAccountPlan[] = [];
  const skipped: SkippedRecord[] = [];

  const knownUserDocumentIds = new Set<string>();
  const seenAuthIds = new Map<string, string>();

  for (const user of users) {
    const documentId = text(user.$id);
    const authId = text(user.userId);

    if (!documentId) {
      skipped.push({ kind: "user", id: "(no $id)", reason: "missing document id" });
      continue;
    }
    if (!authId) {
      // A user document with no auth account cannot be signed into. It is a
      // partial-signup artefact, not a customer.
      skipped.push({
        kind: "user",
        id: documentId,
        reason: "missing userId (Appwrite auth account id)",
      });
      continue;
    }

    const existing = seenAuthIds.get(authId);
    if (existing) {
      // Two user documents sharing one auth account. The target's unique
      // constraint would reject the second; report it rather than let the
      // backfill fail halfway through.
      skipped.push({
        kind: "user",
        id: documentId,
        reason: `duplicate auth id ${authId}, already claimed by ${existing}`,
      });
      continue;
    }

    seenAuthIds.set(authId, documentId);
    knownUserDocumentIds.add(documentId);
    customers.push({
      appwriteAuthId: authId,
      appwriteUserDocumentId: documentId,
    });
  }

  const seenOwnerAccount = new Set<string>();

  for (const bank of banks) {
    const documentId = text(bank.$id);
    const owner = resolveOwnerUserDocumentId(bank.userId);
    const externalAccountId = text(bank.accountId);
    const accessToken = text(bank.accessToken);

    if (!documentId) {
      skipped.push({ kind: "bank", id: "(no $id)", reason: "missing document id" });
      continue;
    }
    if (!owner) {
      skipped.push({
        kind: "bank",
        id: documentId,
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
        reason: `owner ${owner} has no migratable user record`,
      });
      continue;
    }
    if (!externalAccountId) {
      skipped.push({
        kind: "bank",
        id: documentId,
        reason: "missing accountId",
      });
      continue;
    }

    const naturalKey = `${owner}::${externalAccountId}`;
    if (seenOwnerAccount.has(naturalKey)) {
      // The same provider account linked twice by one customer. The target's
      // unique constraint forbids it; the first occurrence wins.
      skipped.push({
        kind: "bank",
        id: documentId,
        reason: `duplicate account ${externalAccountId} for owner ${owner}`,
      });
      continue;
    }
    seenOwnerAccount.add(naturalKey);

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
