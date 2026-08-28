import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";

import { DatabaseUnavailableError } from "./errors";
import {
  closePool,
  getPool,
  withLockedSnapshot,
  withTransaction,
} from "./pool";
import { requireTestDatabase } from "./test-database";

const LOCK_KEY = 73_105;
const LOST_ACK = Object.assign(new Error("acknowledgement lost"), {
  code: "ECONNRESET",
});

beforeAll(() => {
  requireTestDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closePool();
});

async function dedicatedProbe(): Promise<Pool> {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
}

async function waitUntilLockIsFree(probe: Pool): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { rows } = await probe.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [LOCK_KEY]
    );
    if (rows[0].locked) {
      await probe.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitUntilBackendEnds(probe: Pool, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { rows } = await probe.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity WHERE pid = $1
       ) AS present`,
      [pid]
    );
    if (!rows[0].present) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function returnThisClientOnce(client: PoolClient) {
  const pool = getPool();
  return vi.spyOn(pool, "connect").mockImplementationOnce(async () => client);
}

describe("pool state after lost acknowledgements, real PostgreSQL", () => {
  it("ends a session that may have acquired the advisory lock", async () => {
    const pool = getPool();
    const client = await pool.connect();
    const probe = await dedicatedProbe();
    const release = vi.spyOn(client, "release");
    const query = vi.spyOn(client, "query");

    try {
      // Establish the exact dangerous state on a real backend. The injected
      // rejection below represents losing the acknowledgement for an
      // acquisition that the server did execute.
      await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
      query.mockRejectedValueOnce(LOST_ACK);
      returnThisClientOnce(client);

      await expect(withLockedSnapshot(LOCK_KEY, vi.fn())).rejects.toBeInstanceOf(
        DatabaseUnavailableError
      );

      expect(release).toHaveBeenCalledWith(expect.any(Error));
      expect(await waitUntilLockIsFree(probe)).toBe(true);
    } finally {
      query.mockRestore();
      if (release.mock.calls.length === 0) {
        client.release(new Error("test cleanup"));
      }
      await probe.end();
    }
  });

  it("ends a session that may be left inside a transaction after BEGIN", async () => {
    const pool = getPool();
    const client = await pool.connect();
    const probe = await dedicatedProbe();
    const { rows } = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid"
    );
    const pid = rows[0].pid;

    // A real open transaction is the state a lost BEGIN acknowledgement can
    // leave behind. The helper must never make this backend reusable.
    await client.query("BEGIN");
    const release = vi.spyOn(client, "release");
    const query = vi.spyOn(client, "query");

    try {
      query.mockRejectedValueOnce(LOST_ACK);
      returnThisClientOnce(client);

      await expect(withTransaction(vi.fn())).rejects.toBeInstanceOf(
        DatabaseUnavailableError
      );

      expect(release).toHaveBeenCalledWith(expect.any(Error));
      expect(await waitUntilBackendEnds(probe, pid)).toBe(true);
    } finally {
      query.mockRestore();
      if (release.mock.calls.length === 0) {
        client.release(new Error("test cleanup"));
      }
      await probe.end();
    }
  });
});
