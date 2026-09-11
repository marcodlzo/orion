import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Actor } from "../auth/actor";
import { closePool, query } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { linkBankForActor, type LinkedAccountMetadata } from "./bank-linking.service";

const ACTOR: Actor = {
  authId: "auth-linker",
  userId: "userdoc-linker",
  dwollaCustomerId: "dwolla-linker",
};

const INPUT = {
  bankId: "item-1",
  accountId: "acct-1",
  accessToken: "provider-credential-under-test",
  fundingSourceUrl: "https://funding.example.invalid/sources/1",
  shareableId: "YWNjdC0x",
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

async function tableRows(table: "banking_customers" | "linked_accounts" | "linked_account_credentials") {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM ${table} ORDER BY created_at, id`
  );
  return rows;
}

describe("linking a bank in PostgreSQL", () => {
  it("creates both the customer bridge and linked account on a first link", async () => {
    const bank = await linkBankForActor(ACTOR, INPUT, METADATA);

    const customers = await tableRows("banking_customers");
    expect(customers).toHaveLength(1);
    expect(customers[0].appwrite_auth_id).toBe(ACTOR.authId);
    expect(customers[0].appwrite_user_document_id).toBe(ACTOR.userId);

    const accounts = await tableRows("linked_accounts");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: bank.$id,
      customer_id: customers[0].id,
      external_account_id: INPUT.accountId,
      provider_item_id: INPUT.bankId,
      display_name: METADATA.displayName,
      mask: METADATA.mask,
    });
    expect(String(accounts[0].currency).trim()).toBe("USD");
    expect(await tableRows("linked_account_credentials")).toHaveLength(1);
  });

  it("keeps credentials in linked_account_credentials and linked_accounts metadata-only", async () => {
    await linkBankForActor(ACTOR, INPUT, METADATA);

    const { rows } = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('linked_accounts', 'linked_account_credentials')`
    );
    const namesFor = (table: string) => rows
      .filter((row) => row.table_name === table)
      .map((row) => row.column_name.toLowerCase());
    const metadataColumns = namesFor("linked_accounts");
    const credentialColumns = namesFor("linked_account_credentials");

    expect(credentialColumns).toEqual(
      expect.arrayContaining(["linked_account_id", "access_token", "funding_source_url"])
    );
    expect(metadataColumns.filter((name) =>
      /credential|token|secret|funding_source/.test(name)
    )).toEqual([]);
  });

  it("does not duplicate the bank when the same account is linked again", async () => {
    const first = await linkBankForActor(ACTOR, INPUT, METADATA);
    const second = await linkBankForActor(ACTOR, INPUT, METADATA);

    expect(second.$id).toBe(first.$id);
    expect(await tableRows("banking_customers")).toHaveLength(1);
    expect(await tableRows("linked_accounts")).toHaveLength(1);
    expect(await tableRows("linked_account_credentials")).toHaveLength(1);
  });

  it("repairs a missing mirror on retry without creating a second bank record", async () => {
    // The customer bridge can already exist through enrolment or migration.
    // Retrying the bank link must reuse it and create exactly one bank record.
    const { rows: seededCustomers } = await query<{ id: string }>(
      `INSERT INTO banking_customers (appwrite_auth_id, appwrite_user_document_id)
       VALUES ($1, $2)
       RETURNING id`,
      [ACTOR.authId, ACTOR.userId]
    );

    const bank = await linkBankForActor(ACTOR, INPUT, METADATA);

    const customers = await tableRows("banking_customers");
    const accounts = await tableRows("linked_accounts");
    expect(customers).toHaveLength(1);
    expect(customers[0].id).toBe(seededCustomers[0].id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(bank.$id);
    expect(accounts[0].customer_id).toBe(seededCustomers[0].id);
    expect(await tableRows("linked_account_credentials")).toHaveLength(1);
  });
});

describe("linking refusals", () => {
  it("refuses an account already linked under a different Plaid Item", async () => {
    await linkBankForActor(ACTOR, { ...INPUT, bankId: "item-other" }, METADATA);

    await expect(linkBankForActor(ACTOR, INPUT, METADATA)).rejects.toThrow(
      "The existing account belongs to a different Item"
    );

    const accounts = await tableRows("linked_accounts");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].provider_item_id).toBe("item-other");
    expect(await tableRows("linked_account_credentials")).toHaveLength(1);
  });

  it("refuses a non-USD account before writing anything", async () => {
    await expect(
      linkBankForActor(ACTOR, INPUT, { ...METADATA, currency: "EUR" })
    ).rejects.toThrow("Only USD depository accounts can be linked");

    expect(await tableRows("banking_customers")).toHaveLength(0);
    expect(await tableRows("linked_accounts")).toHaveLength(0);
    expect(await tableRows("linked_account_credentials")).toHaveLength(0);
  });

  it("refuses an account whose currency the provider did not report", async () => {
    await expect(
      linkBankForActor(ACTOR, INPUT, { ...METADATA, currency: null })
    ).rejects.toThrow("Only USD depository accounts can be linked");

    expect(await tableRows("banking_customers")).toHaveLength(0);
    expect(await tableRows("linked_accounts")).toHaveLength(0);
    expect(await tableRows("linked_account_credentials")).toHaveLength(0);
  });

  it("does not leak the driver error when storing the bank fails", async () => {
    const error = await linkBankForActor(
      ACTOR,
      { ...INPUT, bankId: "   " },
      METADATA
    ).catch((caught) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    const databaseError = error.cause as Error;
    const driverError = databaseError.cause as Error & { detail?: string };
    expect(driverError.detail).toContain(INPUT.accountId);
    expect(driverError.detail).toContain(METADATA.displayName);
    expect(error.message).toBe("Failed to create the linked bank record");
    expect(error.message).not.toContain(INPUT.accountId);
    expect(error.message).not.toContain(METADATA.displayName);
    expect(error.message).not.toMatch(/constraint|violates|duplicate key/i);
    expect(await tableRows("banking_customers")).toHaveLength(0);
    expect(await tableRows("linked_accounts")).toHaveLength(0);
    expect(await tableRows("linked_account_credentials")).toHaveLength(0);
  });
});

describe("two actors", () => {
  it("keeps each actor's linked accounts separate", async () => {
    const other: Actor = {
      authId: "auth-other",
      userId: "userdoc-other",
      dwollaCustomerId: "dwolla-other",
    };

    const first = await linkBankForActor(ACTOR, INPUT, METADATA);
    const second = await linkBankForActor(
      other,
      { ...INPUT, bankId: "item-2" },
      { ...METADATA, displayName: "Other Checking" }
    );

    expect(second.$id).not.toBe(first.$id);
    const customers = await tableRows("banking_customers");
    const accounts = await tableRows("linked_accounts");
    expect(customers).toHaveLength(2);
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((row) => row.customer_id))).toEqual(
      new Set(customers.map((row) => row.id))
    );
    expect(await tableRows("linked_account_credentials")).toHaveLength(2);
  });
});
