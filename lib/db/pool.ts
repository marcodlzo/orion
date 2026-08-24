// Server-only. Holds DATABASE_URL, which contains credentials.
//
// PostgreSQL is the future banking system of record. Appwrite remains
// authentication infrastructure during migration. Nothing in the application
// reads or writes this database yet — see docs/adr/0001.
import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DatabaseUnavailableError, toDatabaseError } from "./errors";

/**
 * BIGINT and NUMERIC arrive as strings from node-postgres, deliberately: a
 * 64-bit integer does not fit a JavaScript number, so the driver refuses to
 * guess. Money will be stored as BIGINT minor units, and the adapter that reads
 * it must range-check before constructing a Money. See readMoneyMinor below.
 *
 * No parser override is registered. Silently coercing BIGINT to number here
 * would reintroduce exactly the precision loss the money primitive exists to
 * prevent.
 */

let pool: Pool | undefined;

/**
 * The shared connection pool.
 *
 * One pool per process, created lazily. A pool per request would exhaust
 * PostgreSQL's connection limit under any real load — each pool opens its own
 * sockets and never shares them.
 *
 * Sizing is deliberately conservative. Production numbers require load data
 * this application does not have; inventing them now would be a guess wearing a
 * configuration value's clothes.
 */
export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new DatabaseUnavailableError("DATABASE_URL is not configured");
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // A pool emits 'error' for idle clients dropped by the server. Without a
  // listener Node treats it as an unhandled error and terminates the process.
  pool.on("error", () => {
    // Intentionally silent: the message can name the failing statement. The
    // next acquisition surfaces a typed error to an actual caller.
  });

  return pool;
}

/**
 * Run a parameterised query.
 *
 * Intentionally NOT a generic `query(sqlFromCaller)` helper exposed to the
 * application. Purpose-specific repositories are the boundary application code
 * uses; this exists so those repositories, and the schema tests, have one place
 * that maps driver failures onto typed errors.
 *
 * Parameters are always bound, never interpolated.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount: number }> {
  try {
    const result = await getPool().query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/**
 * Run a function inside a single transaction on one client.
 *
 * Exists now because the reason PostgreSQL was chosen at all is multi-row
 * atomicity: a ledger posting has to write both sides or neither. Rollback on
 * any thrown error, always release the client.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect().catch((error) => {
    throw toDatabaseError(error);
  });

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; the original error is what matters.
    }
    throw toDatabaseError(error);
  } finally {
    client.release();
  }
}

/**
 * Safely narrow a BIGINT column into the Money representation's integer range.
 *
 * The driver returns BIGINT as a string. Anything outside Number.MAX_SAFE_INTEGER
 * cannot be represented exactly as a JavaScript number, so it is rejected rather
 * than silently rounded — an off-by-a-few-cents ledger is worse than a loud
 * failure.
 *
 * There are no monetary columns yet. This is the contract the ledger milestone
 * will use, defined now so it is not improvised later.
 */
export function readMoneyMinor(value: unknown): number {
  const raw = typeof value === "string" ? value : String(value);
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Not an integer minor-unit value: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Minor-unit value exceeds the exactly representable range");
  }
  return parsed;
}

/** Close the pool. For test teardown and graceful shutdown only. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}
