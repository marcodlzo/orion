// Server-only.
import "server-only";

import { query } from "./pool";
import { DatabaseUnavailableError, toDatabaseError } from "./errors";

export type DatabaseHealth = {
  healthy: true;
  /** Round-trip time in milliseconds. Useful, and reveals nothing sensitive. */
  latencyMs: number;
};

/**
 * Lightweight connectivity check.
 *
 * `SELECT 1` deliberately: it touches no table, so it cannot be affected by
 * schema state and cannot leak row data.
 *
 * Never returns or logs DATABASE_URL, and never returns a driver error object —
 * a connection error message contains the host, port and user.
 *
 * @throws DatabaseUnavailableError when the database cannot be reached
 */
export async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = Date.now();

  try {
    await query("SELECT 1");
  } catch (error) {
    const mapped = toDatabaseError(error);
    // Any failure to answer SELECT 1 is unavailability from a caller's point of
    // view, whatever the underlying SQLSTATE.
    throw new DatabaseUnavailableError("Database health check failed", {
      cause: mapped,
    });
  }

  return { healthy: true, latencyMs: Date.now() - startedAt };
}
