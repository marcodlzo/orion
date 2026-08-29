import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";

import { ConstraintViolationError, toDatabaseError } from "./errors";
import { requireTestDatabase } from "./test-database";

/**
 * SCHEMA INTEGRATION TESTS — real PostgreSQL, no mocks.
 *
 * A mocked database proves nothing about a schema. Constraints, foreign keys,
 * check constraints and column types either exist in the server or they do
 * not, and only the server can answer.
 *
 * These run against TEST_DATABASE_URL, a separate database, because they
 * truncate tables.
 *
 * They FAIL rather than skip when the database is absent. A schema suite that
 * skips reports green while proving nothing, which is worse than no suite.
 */

let pool: Pool;

beforeAll(async () => {
  // Requires TEST_DATABASE_URL and never falls back to DATABASE_URL: this file
  // truncates tables, so it must not be able to guess a target.
  const connectionString = requireTestDatabase();
  pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 });

  // Fail loudly and early if migrations have not been applied.
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('banking_customers','linked_accounts')`
  );
  if (rows.length !== 2) {
    throw new Error(
      "Schema is missing. Run `npm run db:migrate` against TEST_DATABASE_URL first."
    );
  }
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // RESTART IDENTITY is unnecessary (UUID keys) but CASCADE is required: the
  // FK is ON DELETE RESTRICT, so linked_accounts must go first.
  await pool.query("TRUNCATE linked_accounts, banking_customers CASCADE");
});

async function insertCustomer(
  authId = "auth-1",
  documentId = "user-doc-1"
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO banking_customers (appwrite_auth_id, appwrite_user_document_id)
     VALUES ($1, $2) RETURNING id`,
    [authId, documentId]
  );
  return rows[0].id;
}

const linkedAccountValues = (customerId: string, overrides: Record<string, unknown> = {}) => ({
  customer_id: customerId,
  legacy_appwrite_bank_document_id: null,
  external_account_id: "plaid-account-1",
  provider: "plaid",
  display_name: "Plaid Checking",
  official_name: "Plaid Gold Standard Checking",
  mask: "0000",
  account_type: "depository",
  account_subtype: "checking",
  currency: "USD",
  ...overrides,
});

async function insertLinkedAccount(
  customerId: string,
  overrides: Record<string, unknown> = {}
) {
  const v = linkedAccountValues(customerId, overrides);
  const keys = Object.keys(v);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  return pool.query(
    `INSERT INTO linked_accounts (${keys.join(", ")}) VALUES (${placeholders}) RETURNING id`,
    Object.values(v)
  );
}

/** Run a statement expected to fail, and classify the failure. */
async function expectConstraintViolation(run: () => Promise<unknown>) {
  const error = await run().then(
    () => null,
    (e: unknown) => toDatabaseError(e)
  );
  expect(error, "expected the write to be rejected").not.toBeNull();
  expect(error).toBeInstanceOf(ConstraintViolationError);
  return error as ConstraintViolationError;
}

describe("A. migrations applied to an empty database", () => {
  it("created both tables", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    );
    const names = rows.map((r) => r.table_name);

    expect(names).toContain("banking_customers");
    expect(names).toContain("linked_accounts");
  });

  it("created NO holds or stored-balance tables — those are later phases", () => {
    return pool
      .query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      )
      .then(({ rows }) => {
        const names = rows.map((r) => r.table_name);
        // Tables leave this list as their milestone lands: `transfers` in the
        // idempotency phase, `ledger_*` in the ledger phase. What remains is
        // genuinely absent, and a shell created early invites premature
        // coupling.
        //
        // `balances` stays absent PERMANENTLY, not until a later phase: a
        // stored balance is a second source of truth that drifts from the
        // entries silently. Balance is derived.
        //
        // `idempotency_keys` stays absent deliberately too — the key lives ON
        // the transfer, because there the key IS the transfer's identity.
        for (const forbidden of [
          "balances",
          "holds",
          "idempotency_keys",
        ]) {
          expect(names).not.toContain(forbidden);
        }
      });
  });

  it("created the transfers and ledger tables", () => {
    return pool
      .query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      )
      .then(({ rows }) => {
        const names = rows.map((r) => r.table_name);
        for (const expected of [
          "transfers",
          "ledger_accounts",
          "ledger_transactions",
          "ledger_entries",
        ]) {
          expect(names).toContain(expected);
        }
      });
  });
});

describe("B. banking customer insertion", () => {
  it("inserts and returns a generated UUID", async () => {
    const id = await insertCustomer();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("defaults both timestamps", async () => {
    await insertCustomer();
    const { rows } = await pool.query<{ created_at: Date; updated_at: Date }>(
      "SELECT created_at, updated_at FROM banking_customers"
    );

    expect(rows[0].created_at).toBeInstanceOf(Date);
    expect(rows[0].updated_at).toBeInstanceOf(Date);
  });

  it("rejects a blank identifier", async () => {
    await expectConstraintViolation(() => insertCustomer("   ", "user-doc-blank"));
  });
});

describe("C. duplicate appwrite_auth_id rejected", () => {
  it("raises a unique violation", async () => {
    await insertCustomer("auth-dup", "user-doc-a");

    const error = await expectConstraintViolation(() =>
      insertCustomer("auth-dup", "user-doc-b")
    );

    expect(error.sqlState).toBe("23505");
    expect(error.constraint).toBe("banking_customers_appwrite_auth_id_key");
  });
});

describe("D. duplicate appwrite_user_document_id rejected", () => {
  it("raises a unique violation", async () => {
    await insertCustomer("auth-a", "user-doc-dup");

    const error = await expectConstraintViolation(() =>
      insertCustomer("auth-b", "user-doc-dup")
    );

    expect(error.constraint).toBe(
      "banking_customers_appwrite_user_document_id_key"
    );
  });
});

describe("E. linked account requires a valid customer", () => {
  it("rejects an unknown customer id", async () => {
    const error = await expectConstraintViolation(() =>
      insertLinkedAccount("00000000-0000-4000-8000-000000000000")
    );

    expect(error.sqlState).toBe("23503"); // foreign_key_violation
  });

  it("accepts a real customer id", async () => {
    const customerId = await insertCustomer();
    const { rowCount } = await insertLinkedAccount(customerId);

    expect(rowCount).toBe(1);
  });
});

describe("F. deleting a referenced customer is RESTRICTed", () => {
  it("refuses to delete a customer that still has linked accounts", async () => {
    const customerId = await insertCustomer();
    await insertLinkedAccount(customerId);

    // Deliberate policy: financial records must never vanish as a side effect
    // of removing a customer row. CASCADE here would silently destroy history.
    const error = await expectConstraintViolation(() =>
      pool.query("DELETE FROM banking_customers WHERE id = $1", [customerId])
    );

    expect(error.sqlState).toBe("23503");
  });

  it("allows deletion once the linked accounts are gone", async () => {
    const customerId = await insertCustomer();
    await insertLinkedAccount(customerId);
    await pool.query("DELETE FROM linked_accounts WHERE customer_id = $1", [customerId]);

    const { rowCount } = await pool.query(
      "DELETE FROM banking_customers WHERE id = $1",
      [customerId]
    );
    expect(rowCount).toBe(1);
  });
});

describe("G. unsupported currency rejected", () => {
  it.each(["EUR", "GBP", "usd", "XXX"])("rejects %s", async (currency) => {
    const customerId = await insertCustomer();

    const error = await expectConstraintViolation(() =>
      insertLinkedAccount(customerId, { currency })
    );

    expect(error.sqlState).toBe("23514"); // check_violation
  });

  it("accepts USD", async () => {
    const customerId = await insertCustomer();
    const { rowCount } = await insertLinkedAccount(customerId, { currency: "USD" });

    expect(rowCount).toBe(1);
  });

  it("rejects an unsupported provider", async () => {
    const customerId = await insertCustomer();

    await expectConstraintViolation(() =>
      insertLinkedAccount(customerId, { provider: "dwolla" })
    );
  });
});

describe("H. duplicate provider account for the same customer rejected", () => {
  it("raises a unique violation on (customer, provider, external account)", async () => {
    const customerId = await insertCustomer();
    await insertLinkedAccount(customerId, { external_account_id: "plaid-account-x" });

    const error = await expectConstraintViolation(() =>
      insertLinkedAccount(customerId, { external_account_id: "plaid-account-x" })
    );

    expect(error.constraint).toBe(
      "linked_accounts_customer_provider_account_key"
    );
  });

  it("permits the same external account for a DIFFERENT customer", async () => {
    // Two people can legitimately link the same joint account.
    const a = await insertCustomer("auth-a", "user-doc-a");
    const b = await insertCustomer("auth-b", "user-doc-b");

    await insertLinkedAccount(a, { external_account_id: "shared-account" });
    const { rowCount } = await insertLinkedAccount(b, {
      external_account_id: "shared-account",
    });

    expect(rowCount).toBe(1);
  });

  it("rejects reusing one legacy Appwrite bank document", async () => {
    const a = await insertCustomer("auth-a", "user-doc-a");
    const b = await insertCustomer("auth-b", "user-doc-b");

    await insertLinkedAccount(a, { legacy_appwrite_bank_document_id: "bank-doc-1" });

    // Makes a migration rerun unable to duplicate a legacy record.
    const error = await expectConstraintViolation(() =>
      insertLinkedAccount(b, { legacy_appwrite_bank_document_id: "bank-doc-1" })
    );
    expect(error.constraint).toBe("linked_accounts_legacy_bank_document_key");
  });

  it("permits many rows with no legacy document id", async () => {
    const customerId = await insertCustomer();
    await insertLinkedAccount(customerId, { external_account_id: "a" });
    const { rowCount } = await insertLinkedAccount(customerId, {
      external_account_id: "b",
    });

    // UNIQUE allows repeated NULLs in PostgreSQL, which is what post-cutover
    // accounts need.
    expect(rowCount).toBe(1);
  });
});

describe("I. nullable display metadata", () => {
  it("accepts null official_name, mask, type and subtype", async () => {
    const customerId = await insertCustomer();

    const { rowCount } = await insertLinkedAccount(customerId, {
      official_name: null,
      mask: null,
      account_type: null,
      account_subtype: null,
    });

    expect(rowCount).toBe(1);
  });

  it("still requires a display name", async () => {
    const customerId = await insertCustomer();

    await expectConstraintViolation(() =>
      insertLinkedAccount(customerId, { display_name: "   " })
    );
  });
});

describe("J. no provider-credential columns exist", () => {
  it("neither table has a column resembling a provider secret", async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'`
    );
    const columns = rows.map((r) => `${r.table_name}.${r.column_name}`);

    // PostgreSQL is not encryption. Moving plaintext credentials into a new
    // datastore is not a security improvement, so they were never migrated.
    for (const secret of [
      "access_token",
      "accesstoken",
      "funding_source_url",
      "fundingsourceurl",
      "processor_token",
      "processortoken",
      "dwolla_customer_url",
      "secret",
      "password",
      "ssn",
      "date_of_birth",
    ]) {
      const offenders = columns.filter((c) => c.toLowerCase().endsWith(`.${secret}`));
      expect(offenders, `${secret} must not exist`).toEqual([]);
    }
  });
});

describe("K. no authoritative balance column exists", () => {
  it("linked_accounts carries no balance of any kind", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'linked_accounts'`
    );
    const columns = rows.map((r) => r.column_name.toLowerCase());

    // A balance here would be a second source of truth competing with the
    // ledger that does not exist yet. Provider balances are display data.
    for (const forbidden of [
      "balance",
      "current_balance",
      "available_balance",
      "amount",
      "amount_minor",
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it("no table in the schema has a balance column", async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%balance%'`
    );

    expect(rows).toEqual([]);
  });
});

describe("L. timestamps are timezone aware", () => {
  it("every table uses timestamptz, not timestamp", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('created_at', 'updated_at')
        ORDER BY table_name, column_name`
    );

    // Asserting the COUNT as well as the type is what stops a new table
    // slipping in with untyped timestamps. It has to be updated deliberately
    // each time the schema grows, which is the point.
    //
    // banking_customers, linked_accounts, transfers, ledger_accounts,
    // plaid_items: two each. ledger_transactions and ledger_entries are
    // append-only, so they carry created_at only. plaid_transactions records
    // when it was FIRST SEEN rather than created, so it contributes updated_at
    // alone.
    expect(rows.length).toBe(13);
    for (const row of rows) {
      // `timestamp without time zone` silently reinterprets values by server
      // locale, which for financial records is a correctness bug.
      expect(
        row.data_type,
        `${row.table_name}.${row.column_name}`
      ).toBe("timestamp with time zone");
    }
  });

  it("no column anywhere is a naive timestamp, whatever it is called", async () => {
    // THE HOLE THE COUNT ABOVE DOES NOT CLOSE. It only inspects columns named
    // created_at or updated_at, so a table whose timestamps are named for their
    // meaning — received_at, placed_at, occurred_at, settled_at, first_seen_at —
    // was never type-checked at all. Three tables added since that guard was
    // written fell straight through it.
    //
    // This one asks the schema the question directly: is anything, anywhere, a
    // timestamp without a time zone?
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
    }>(
      // `pgmigrations` is node-pg-migrate's own bookkeeping, created by the
      // tool and not part of this schema. Excluded BY NAME rather than by a
      // pattern, so a table of ours can never be excused by accident.
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name <> 'pgmigrations'
          AND data_type = 'timestamp without time zone'
        ORDER BY table_name, column_name`
    );

    expect(
      rows.map((r) => `${r.table_name}.${r.column_name}`),
      "naive timestamps reinterpret by server locale"
    ).toEqual([]);
  });

  it("advances updated_at on update, via the database not the application", async () => {
    const customerId = await insertCustomer();
    const before = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM banking_customers WHERE id = $1",
      [customerId]
    );

    await pool.query("SELECT pg_sleep(0.01)");
    await pool.query(
      "UPDATE banking_customers SET appwrite_auth_id = $2 WHERE id = $1",
      [customerId, "auth-renamed"]
    );

    const after = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM banking_customers WHERE id = $1",
      [customerId]
    );

    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(
      before.rows[0].updated_at.getTime()
    );
  });
});

describe("money column contract", () => {
  it("no floating-point column exists anywhere in the schema", async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('real', 'double precision')`
    );

    // When monetary columns arrive they will be BIGINT minor units. A float
    // column is how a ledger silently loses cents.
    expect(rows).toEqual([]);
  });
});
