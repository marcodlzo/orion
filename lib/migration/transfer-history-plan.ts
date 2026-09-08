import "server-only";
import { createHash } from "node:crypto";
import { tryParseUsd } from "../domain/money";

export type LegacyTransfer = {
  $id: string; name: string; amount: string; senderId: string; receiverId: string;
  senderBankId: string; receiverBankId: string; $createdAt: string;
};
type BankIdentity = { id: string; owner: string; accountId: string };
type CustomerIdentity = { id: string; userDocumentId: string };
type DurableTransfer = {
  id: string; customerId: string; fingerprint: string; amountMinor: string;
  currency: string; state: string;
};
export type HistoryMatch = { legacyId: string; transferId: string; recipientCustomerId: string };
export type HistoryIssue = { id: string; code: "INVALID_SOURCE" | "MISSING_IDENTITY" | "UNMATCHED" | "AMBIGUOUS" | "MISSING_HISTORY" };

/** Read-only planning, never a decision to rewrite a transfer or post money.
 * A fingerprint identifies an intent, not one execution: identical payments
 * with different idempotency keys must be reported as ambiguous.
 */
export function planTransferHistory(input: {
  legacy: readonly LegacyTransfer[];
  banks: readonly BankIdentity[];
  customers: readonly CustomerIdentity[];
  transfers: readonly DurableTransfer[];
}): { matches: HistoryMatch[]; issues: HistoryIssue[] } {
  const issues: HistoryIssue[] = [];
  const candidates: HistoryMatch[] = [];
  for (const old of input.legacy) {
    const amount = tryParseUsd(old.amount);
    if (!amount || amount.amountMinor <= 0 || !old.name || !Number.isFinite(Date.parse(old.$createdAt))) {
      issues.push({ id: old.$id, code: "INVALID_SOURCE" }); continue;
    }
    const senders = input.banks.filter(b => b.id === old.senderBankId && b.owner === old.senderId);
    const recipients = input.banks.filter(b => b.id === old.receiverBankId && b.owner === old.receiverId);
    const senderCustomers = input.customers.filter(c => c.userDocumentId === old.senderId);
    const recipientCustomers = input.customers.filter(c => c.userDocumentId === old.receiverId);
    if (senders.length !== 1 || recipients.length !== 1 || senderCustomers.length !== 1 || recipientCustomers.length !== 1) {
      issues.push({ id: old.$id, code: "MISSING_IDENTITY" }); continue;
    }
    const hash = createHash("sha256");
    for (const value of [senders[0].id, recipients[0].accountId, String(amount.amountMinor), amount.currency]) {
      hash.update(`${value.length}:${value};`);
    }
    const fingerprint = hash.digest("hex").slice(0, 32);
    const matches = input.transfers.filter(t => t.customerId === senderCustomers[0].id &&
      t.fingerprint === fingerprint && t.amountMinor === String(amount.amountMinor) && t.currency === amount.currency);
    if (matches.length !== 1) {
      issues.push({ id: old.$id, code: matches.length ? "AMBIGUOUS" : "UNMATCHED" }); continue;
    }
    candidates.push({ legacyId: old.$id, transferId: matches[0].id, recipientCustomerId: recipientCustomers[0].id });
  }
  const matches = candidates.filter(candidate => {
    if (candidates.filter(c => c.transferId === candidate.transferId).length === 1) return true;
    issues.push({ id: candidate.legacyId, code: "AMBIGUOUS" });
    return false;
  });
  for (const transfer of input.transfers) {
    if (["submitted", "settled", "reversed", "returned"].includes(transfer.state) &&
      !matches.some(m => m.transferId === transfer.id)) issues.push({ id: transfer.id, code: "MISSING_HISTORY" });
  }
  return { matches, issues };
}
