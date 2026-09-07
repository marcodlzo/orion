import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actor } from "../auth/actor";

/**
 * LINKING A BANK, AGAINST A REAL SERVER.
 *
 * `linkBankForActor` is the third request path that writes to PostgreSQL, and
 * it landed without a test. That is the same shape as the enrolment defect: a
 * code path nothing exercises, which was permanently broken for every new user
 * while the whole suite stayed green.
 *
 * What it does is write to TWO stores that cannot share a transaction — the
 * bank document in Appwrite, and its mirror row in PostgreSQL. Everything
 * interesting here is about what happens between those two writes, which is
 * exactly what a mocked database cannot show.
 *
 * Appwrite is the only fake. PostgreSQL is real and is what is under test.
 */

const { createBankForActor, getOwnedBankByAccountId } = vi.hoisted(() => ({
  createBankForActor: vi.fn(),
  getOwnedBankByAccountId: vi.fn(),
}));

vi.mock("../repositories/banks.repository", () => ({
  createBankForActor,
  getOwnedBankByAccountId,
}));

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

/** The Appwrite document createBankForActor would have written. */
const bankDocument = (overrides: Record<string, unknown> = {}) => ({
  $id: "bank-doc-1",
  userId: { $id: ACTOR.userId },
  ...INPUT,
  ...overrides,
});

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query(
    `TRUNCATE transfer_state_transitions, ledger_holds, ledger_entries,
              ledger_transactions, ledger_accounts,
              provider_webhook_events, transfers, linked_accounts,
              banking_customers CASCADE`
  );
  vi.clearAllMocks();
  getOwnedBankByAccountId.mockResolvedValue(null);
  createBankForActor.mockResolvedValue(bankDocument());
});

async function linkedRows() {
  const { rows } = await query<Record<string, unknown>>(
    "SELECT * FROM linked_accounts ORDER BY created_at, id"
  );
  return rows;
}

describe("linking mirrors the bank into PostgreSQL", () => {
  it("creates the customer and the linked account on a first link", async () => {
    expect(await linkedRows()).toHaveLength(0);

    const bank = await linkBankForActor(ACTOR, INPUT, METADATA);

    expect(bank.$id).toBe("bank-doc-1");

    // Enrolment happens here too, from the session's identifiers, so a user who
    // links before they ever transfer is already bridged.
    const { rows: customers } = await query<{
      id: string;
      appwrite_auth_id: string;
      appwrite_user_document_id: string;
    }>("SELECT * FROM banking_customers");
    expect(customers).toHaveLength(1);
    expect(customers[0].appwrite_auth_id).toBe(ACTOR.authId);
    expect(customers[0].appwrite_user_document_id).toBe(ACTOR.userId);

    const rows = await linkedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].customer_id).toBe(customers[0].id);
    expect(rows[0].external_account_id).toBe("acct-1");
    expect(rows[0].legacy_appwrite_bank_document_id).toBe("bank-doc-1");
    expect(rows[0].display_name).toBe("Plaid Checking");
    expect(rows[0].mask).toBe("0000");
    expect(String(rows[0].currency).trim()).toBe("USD");
  });

  it("NEVER copies a credential into PostgreSQL", async () => {
    // The whole point of keeping credentials in one store. A mirror row that
    // carried an access token would double the exposure rather than reduce it,
    // and it would sit outside the encryption boundary that protects the
    // original.
    await linkBankForActor(ACTOR, INPUT, METADATA);

    const rows = await linkedRows();
    const serialised = JSON.stringify(rows);

    expect(serialised).not.toContain(INPUT.accessToken);
    expect(serialised).not.toContain(INPUT.fundingSourceUrl);
    expect(serialised).not.toContain("funding.example.invalid");

    // And no column exists that could hold one. Asserted by name so that adding
    // "accessToken for convenience" fails here rather than in review.
    const { rows: columns } = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'linked_accounts'`
    );
    const names = columns.map((c) => c.column_name.toLowerCase());
    for (const forbidden of ["access_token", "funding_source_url", "secret", "token"]) {
      expect(names, `linked_accounts must not hold ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is idempotent: relinking the same account does not duplicate the row", async () => {
    await linkBankForActor(ACTOR, INPUT, METADATA);

    // A retry finds the account already owned and reuses the document rather
    // than creating a second bank.
    getOwnedBankByAccountId.mockResolvedValue(bankDocument());
    await linkBankForActor(ACTOR, INPUT, METADATA);

    expect(await linkedRows()).toHaveLength(1);
    expect(createBankForActor).toHaveBeenCalledTimes(1);
  });

  it("repairs a missing mirror without creating a second bank document", async () => {
    // The two stores cannot share a transaction, so this state is reachable:
    // the Appwrite document exists and the PostgreSQL row does not. A retry
    // must fill the gap rather than duplicate the bank.
    getOwnedBankByAccountId.mockResolvedValue(bankDocument());
    expect(await linkedRows()).toHaveLength(0);

    await linkBankForActor(ACTOR, INPUT, METADATA);

    expect(createBankForActor).not.toHaveBeenCalled();
    expect(await linkedRows()).toHaveLength(1);
  });
});

describe("refusals", () => {
  it("refuses an account already linked under a different Item", async () => {
    // The same account id arriving on a different Item means the mapping is
    // ambiguous. Linking anyway would attach one account to two Items.
    getOwnedBankByAccountId.mockResolvedValue(bankDocument({ bankId: "item-other" }));

    await expect(linkBankForActor(ACTOR, INPUT, METADATA)).rejects.toThrow();

    expect(await linkedRows()).toHaveLength(0);
    expect(createBankForActor).not.toHaveBeenCalled();
  });

  it("refuses a non-USD account before writing anything", async () => {
    // The schema accepts only USD, so a row for anything else cannot exist.
    // Refusing BEFORE the Appwrite write is what keeps the two stores from
    // diverging by design rather than by luck.
    await expect(
      linkBankForActor(ACTOR, INPUT, { ...METADATA, currency: "EUR" })
    ).rejects.toThrow();

    expect(createBankForActor).not.toHaveBeenCalled();
    expect(await linkedRows()).toHaveLength(0);
  });

  it("refuses an account whose currency the provider did not report", async () => {
    // Plaid returns null when it does not know. Treating unknown as USD would
    // write a currency nobody confirmed onto a money record.
    await expect(
      linkBankForActor(ACTOR, INPUT, { ...METADATA, currency: null })
    ).rejects.toThrow();

    expect(createBankForActor).not.toHaveBeenCalled();
    expect(await linkedRows()).toHaveLength(0);
  });

  it("does not leak a driver error when the mirror fails", async () => {
    // A REAL fault, injected through a real constraint:
    // linked_accounts_external_account_id_not_blank. An oversized id does not
    // work here — PostgreSQL TEXT has no length limit, so the first attempt at
    // this test passed by writing the row successfully.
    //
    // A constraint violation quotes the offending row, and this row carries an
    // account id and a display name. The message must not travel.
    createBankForActor.mockResolvedValue(bankDocument({ accountId: "   " }));

    const error = await linkBankForActor(ACTOR, INPUT, METADATA).catch((e) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("acct-1");
    expect(error.message).not.toContain("Plaid Checking");
    expect(error.message).not.toMatch(/constraint|violates|duplicate key/i);
  });
});

describe("two customers", () => {
  it("keeps each actor's linked accounts separate", async () => {
    await linkBankForActor(ACTOR, INPUT, METADATA);

    const other: Actor = {
      authId: "auth-other",
      userId: "userdoc-other",
      dwollaCustomerId: "dwolla-other",
    };
    getOwnedBankByAccountId.mockResolvedValue(null);
    createBankForActor.mockResolvedValue(
      bankDocument({ $id: "bank-doc-2", accountId: "acct-2", userId: { $id: other.userId } })
    );

    await linkBankForActor(other, { ...INPUT, accountId: "acct-2" }, METADATA);

    const rows = await linkedRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.customer_id)).size).toBe(2);
  });
});
