import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import {
  createBankForActor,
  getOwnedBankByAccountId,
  getOwnedBankByDocumentId,
  getOwnedBanks,
} from "./banks.repository";

const ALICE = { authId: "auth-bank-alice", userId: "userdoc-bank-alice", dwollaCustomerId: "dwolla-alice" };
const BOB = { authId: "auth-bank-bob", userId: "userdoc-bank-bob", dwollaCustomerId: "dwolla-bob" };

beforeAll(() => requireTestDatabase());
afterAll(() => closePool());
beforeEach(async () => {
  await query(
    `TRUNCATE transfer_state_transitions, ledger_holds, ledger_entries,
              ledger_transactions, ledger_accounts, provider_webhook_events,
              transfers, linked_account_credentials, linked_accounts,
              banking_customers CASCADE`
  );
});

describe("PostgreSQL bank credential boundary", () => {
  it("creates encrypted rows and keeps ownership in every owned query", async () => {
    const created = await createBankForActor(ALICE, {
      bankId: "item-alice",
      accountId: "account-alice",
      accessToken: "synthetic-access-value",
      fundingSourceUrl: "https://funding.example.invalid/alice",
      shareableId: "share-alice",
      displayName: "Alice Checking",
      officialName: "Alice Checking Account",
      mask: "1234",
      accountType: "depository",
      accountSubtype: "checking",
    });

    expect(created.accessToken).toBe("synthetic-access-value");
    expect((await getOwnedBanks(ALICE)).map((b) => b.$id)).toEqual([created.$id]);
    await expect(getOwnedBanks(BOB)).resolves.toEqual([]);
    await expect(getOwnedBankByDocumentId(BOB, created.$id)).resolves.toBeNull();
    await expect(getOwnedBankByAccountId(BOB, "account-alice")).resolves.toBeNull();

    const { rows } = await query<{ access_token: string; funding_source_url: string }>(
      "SELECT access_token, funding_source_url FROM linked_account_credentials"
    );
    expect(rows[0].access_token).not.toContain("synthetic-access-value");
    expect(rows[0].funding_source_url).not.toContain("funding.example.invalid");
  });

  it("refuses plaintext in the credential table", async () => {
    await createBankForActor(ALICE, {
      bankId: "item-plain",
      accountId: "account-plain",
      accessToken: "synthetic-access-value",
      fundingSourceUrl: "https://funding.example.invalid/plain",
      shareableId: "share-plain",
      displayName: "Plaintext Test",
      officialName: null,
      mask: null,
      accountType: "depository",
      accountSubtype: "checking",
    });
    await query("UPDATE linked_account_credentials SET access_token = 'plaintext-is-a-fault'");
    await expect(getOwnedBanks(ALICE)).rejects.toThrow();
  });
});
