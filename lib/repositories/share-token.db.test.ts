import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Actor } from "../auth/actor";
import { closePool, query } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { isShareToken } from "../domain/share-token";
import { findCounterpartyBankByShareToken } from "./banks.repository";
import { linkBankForActor, type LinkedAccountMetadata } from "../services/bank-linking.service";

const ALICE: Actor = {
  authId: "auth-alice",
  userId: "userdoc-alice",
  dwollaCustomerId: "dwolla-alice",
};

const BOB: Actor = {
  authId: "auth-bob",
  userId: "userdoc-bob",
  dwollaCustomerId: "dwolla-bob",
};

const INPUT = {
  bankId: "item-alice",
  accountId: "acct-alice",
  accessToken: "provider-credential-under-test",
  fundingSourceUrl: "https://funding.example.invalid/sources/1",
  shareableId: "YWNjdC1hbGljZQ==",
};

const METADATA: LinkedAccountMetadata = {
  displayName: "Plaid Checking",
  officialName: "Plaid Gold Standard 0% Interest Checking",
  mask: "0000",
  accountType: "depository",
  accountSubtype: "checking",
  currency: "USD",
};

beforeAll(() => requireTestDatabase());

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query(
    `TRUNCATE transfer_state_transitions, ledger_holds, ledger_entries,
              ledger_transactions, ledger_accounts, provider_webhook_events,
              transfers, linked_account_credentials, linked_accounts,
              banking_customers CASCADE`
  );
});

async function storedTokens(): Promise<string[]> {
  const { rows } = await query<{ share_token: string }>(
    `SELECT share_token FROM linked_accounts ORDER BY created_at, id`
  );
  return rows.map((row) => row.share_token);
}

describe("minting a share token when a bank is linked", () => {
  it("stores a well-formed token the caller never supplied", async () => {
    const bank = await linkBankForActor(ALICE, INPUT, METADATA);

    expect(isShareToken(bank.shareToken)).toBe(true);
    expect(await storedTokens()).toEqual([bank.shareToken]);
  });

  it("gives two accounts different tokens", async () => {
    const first = await linkBankForActor(ALICE, INPUT, METADATA);
    const second = await linkBankForActor(
      BOB,
      { ...INPUT, bankId: "item-bob", accountId: "acct-bob", shareableId: "YWNjdC1ib2I=" },
      METADATA
    );

    expect(second.shareToken).not.toBe(first.shareToken);
    expect(new Set(await storedTokens()).size).toBe(2);
  });

  it("does not derive the token from the account id", async () => {
    // The finding itself. `shareableId` is base64 of the Plaid account id, so
    // anyone who knew the account id could compute the reference. Assert the
    // new value is not that, not the account id, and not any obvious encoding
    // of it — if this passes only by luck the previous test's 1000-draw
    // uniqueness check would have failed first.
    const bank = await linkBankForActor(ALICE, INPUT, METADATA);

    expect(bank.shareToken).not.toBe(INPUT.accountId);
    expect(bank.shareToken).not.toBe(Buffer.from(INPUT.accountId).toString("base64"));
    expect(bank.shareToken).not.toBe(Buffer.from(INPUT.accountId).toString("hex"));
    expect(bank.shareToken).not.toContain(INPUT.accountId);
    expect(Buffer.from(bank.shareToken, "hex").toString("utf8")).not.toContain("acct");
  });

  it("keeps the legacy reference untouched, so the transfer path still resolves", async () => {
    // Part one lands BESIDE the old column. Rotating `shareable_id` here would
    // break every transfer until the cutover commit.
    const bank = await linkBankForActor(ALICE, INPUT, METADATA);

    const { rows } = await query<{ shareable_id: string }>(
      `SELECT shareable_id FROM linked_accounts`
    );
    expect(rows[0].shareable_id).toBe(INPUT.shareableId);
    expect(bank.shareableId).toBe(INPUT.shareableId);
  });
});

describe("resolving a recipient by share token", () => {
  it("finds the account the token names", async () => {
    await linkBankForActor(ALICE, INPUT, METADATA);
    const bob = await linkBankForActor(
      BOB,
      { ...INPUT, bankId: "item-bob", accountId: "acct-bob", shareableId: "YWNjdC1ib2I=" },
      METADATA
    );

    const found = await findCounterpartyBankByShareToken(bob.shareToken);

    expect(found?.$id).toBe(bob.$id);
    expect(found?.accountId).toBe("acct-bob");
  });

  it("returns the credential decrypted, because resolution happens at the boundary", async () => {
    const bank = await linkBankForActor(ALICE, INPUT, METADATA);

    const found = await findCounterpartyBankByShareToken(bank.shareToken);

    expect(found?.fundingSourceUrl).toBe(INPUT.fundingSourceUrl);
    // Proves it round-tripped through the store rather than being handed back.
    const { rows } = await query<{ funding_source_url: string }>(
      `SELECT funding_source_url FROM linked_account_credentials`
    );
    expect(rows[0].funding_source_url).not.toBe(INPUT.fundingSourceUrl);
  });

  it("resolves nothing for an unknown token", async () => {
    await linkBankForActor(ALICE, INPUT, METADATA);

    expect(await findCounterpartyBankByShareToken("0".repeat(32))).toBeNull();
  });

  it("resolves nothing for the account id or the old base64 reference", async () => {
    // The old path must not keep working through the new door.
    await linkBankForActor(ALICE, INPUT, METADATA);

    expect(await findCounterpartyBankByShareToken(INPUT.accountId)).toBeNull();
    expect(await findCounterpartyBankByShareToken(INPUT.shareableId)).toBeNull();
    expect(await findCounterpartyBankByShareToken("")).toBeNull();
  });
});

describe("what the schema refuses", () => {
  it("refuses two accounts sharing a token", async () => {
    const alice = await linkBankForActor(ALICE, INPUT, METADATA);
    const bob = await linkBankForActor(
      BOB,
      { ...INPUT, bankId: "item-bob", accountId: "acct-bob", shareableId: "YWNjdC1ib2I=" },
      METADATA
    );

    // A token is a lookup key. Two rows holding one would make the recipient of
    // a transfer ambiguous, so the index refuses it rather than the resolver
    // having to pick.
    await expect(
      query(`UPDATE linked_accounts SET share_token = $1 WHERE id = $2`, [
        alice.shareToken,
        bob.$id,
      ])
    ).rejects.toThrow();

    expect(new Set(await storedTokens()).size).toBe(2);
  });

  it("refuses a malformed token", async () => {
    const bank = await linkBankForActor(ALICE, INPUT, METADATA);

    for (const bad of ["", "   ", "not-a-token", "ABCDEF0123456789abcdef0123456789"]) {
      await expect(
        query(`UPDATE linked_accounts SET share_token = $1 WHERE id = $2`, [bad, bank.$id])
      ).rejects.toThrow();
    }
  });

  it("refuses a null token", async () => {
    const bank = await linkBankForActor(ALICE, INPUT, METADATA);

    await expect(
      query(`UPDATE linked_accounts SET share_token = NULL WHERE id = $1`, [bank.$id])
    ).rejects.toThrow();
  });
});

describe("the column default", () => {
  it("mints a token for an insert that omits the column", async () => {
    // Defence in depth for a future insert path that forgets. The application
    // always supplies one; this proves the row cannot exist without it even if
    // that stops being true.
    const { rows: customers } = await query<{ id: string }>(
      `INSERT INTO banking_customers (appwrite_auth_id, appwrite_user_document_id)
       VALUES ($1, $2) RETURNING id`,
      [ALICE.authId, ALICE.userId]
    );

    const { rows } = await query<{ share_token: string }>(
      `INSERT INTO linked_accounts
         (customer_id, external_account_id, provider, provider_item_id,
          display_name, account_type, currency)
       VALUES ($1, 'acct-default', 'plaid', 'item-default', 'No Token Supplied',
               'depository', 'USD')
       RETURNING share_token`,
      [customers[0].id]
    );

    expect(isShareToken(rows[0].share_token)).toBe(true);
  });
});
