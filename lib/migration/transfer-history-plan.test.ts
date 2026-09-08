import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planTransferHistory } from "./transfer-history-plan";

const fixture = () => {
  const hash = createHash("sha256");
  for (const v of ["source-bank", "recipient-account", "500", "USD"]) hash.update(`${v.length}:${v};`);
  return {
    legacy: [{ $id: "legacy-1", name: "Rent", amount: "5.00", senderId: "alice", receiverId: "bob",
      senderBankId: "source-bank", receiverBankId: "recipient-bank", $createdAt: "2026-09-08T12:00:00Z" }],
    banks: [{ id: "source-bank", owner: "alice", accountId: "source-account" },
      { id: "recipient-bank", owner: "bob", accountId: "recipient-account" }],
    customers: [{ id: "customer-a", userDocumentId: "alice" }, { id: "customer-b", userDocumentId: "bob" }],
    transfers: [{ id: "transfer-1", customerId: "customer-a", fingerprint: hash.digest("hex").slice(0, 32),
      amountMinor: "500", currency: "USD", state: "settled" }],
  };
};
describe("legacy history matching preflight", () => {
  it("matches a unique intent using both identities and exact minor units", () => {
    expect(planTransferHistory(fixture())).toEqual({ matches: [{ legacyId: "legacy-1", transferId: "transfer-1",
      recipientCustomerId: "customer-b" }], issues: [] });
  });
  it("does not choose between repeated identical payments by timestamp", () => {
    const input = fixture(); input.transfers.push({ ...input.transfers[0], id: "transfer-2" });
    const result = planTransferHistory(input);
    expect(result.matches).toEqual([]);
    expect(result.issues).toContainEqual({ id: "legacy-1", code: "AMBIGUOUS" });
  });
  it("does not map two legacy documents to one financial effect", () => {
    const input = fixture(); input.legacy.push({ ...input.legacy[0], $id: "legacy-2" });
    const result = planTransferHistory(input);
    expect(result.matches).toEqual([]);
    expect(result.issues.filter(i => i.code === "AMBIGUOUS")).toHaveLength(2);
  });
  it("refuses a bank whose stored owner contradicts the transaction", () => {
    const input = fixture(); input.banks[1].owner = "mallory";
    expect(planTransferHistory(input).issues).toContainEqual({ id: "legacy-1", code: "MISSING_IDENTITY" });
  });
  it("refuses a missing recipient bridge", () => {
    const input = fixture(); input.customers.pop();
    expect(planTransferHistory(input).matches).toEqual([]);
  });
  it("does not match a different amount or currency despite a matching digest", () => {
    for (const over of [{ amountMinor: "501" }, { currency: "EUR" }]) {
      const input = fixture(); Object.assign(input.transfers[0], over);
      expect(planTransferHistory(input).issues).toContainEqual({ id: "legacy-1", code: "UNMATCHED" });
    }
  });
  it("refuses invalid money instead of rounding", () => {
    const input = fixture(); input.legacy[0].amount = "5.001";
    expect(planTransferHistory(input).issues).toContainEqual({ id: "legacy-1", code: "INVALID_SOURCE" });
  });
  it("reports durable submitted transfers missing legacy history", () => {
    const input = fixture(); input.legacy = [];
    expect(planTransferHistory(input).issues).toEqual([{ id: "transfer-1", code: "MISSING_HISTORY" }]);
  });
});
