import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient, QueryResult } from "pg";

const poolDouble = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(async () => undefined),
  on: vi.fn(),
  query: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: vi.fn(() => poolDouble),
}));

import { DatabaseUnavailableError } from "./errors";
import { closePool, withLockedSnapshot, withTransaction } from "./pool";

const LOCK_KEY = 73_104;
const LOST_ACK = Object.assign(new Error("acknowledgement lost"), {
  code: "ECONNRESET",
});

function result(): QueryResult {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: 1,
    rows: [],
  };
}

function clientWith(
  execute: (text: string, params?: readonly unknown[]) => Promise<QueryResult>
) {
  const query = vi.fn(execute);
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  poolDouble.connect.mockResolvedValueOnce(client);
  return { client, query, release };
}

function expectDestroyed(release: ReturnType<typeof vi.fn>) {
  expect(release).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledWith(expect.any(Error));
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://pool-state-test.invalid/orion_test";
});

afterEach(async () => {
  await closePool();
});

describe("withLockedSnapshot uncertain connection state", () => {
  it("destroys the client when advisory-lock acquisition is not acknowledged", async () => {
    const callback = vi.fn();
    const { query, release } = clientWith(async (text) => {
      expect(text).toBe("SELECT pg_advisory_lock($1)");
      throw LOST_ACK;
    });

    await expect(withLockedSnapshot(LOCK_KEY, callback)).rejects.toBeInstanceOf(
      DatabaseUnavailableError
    );

    expect(query).toHaveBeenCalledWith("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    expect(callback).not.toHaveBeenCalled();
    expectDestroyed(release);
  });

  it("destroys the client when BEGIN is not acknowledged, even after unlock succeeds", async () => {
    const callback = vi.fn();
    const statements: string[] = [];
    const { release } = clientWith(async (text) => {
      statements.push(text);
      if (text === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        throw LOST_ACK;
      }
      return result();
    });

    await expect(withLockedSnapshot(LOCK_KEY, callback)).rejects.toBeInstanceOf(
      DatabaseUnavailableError
    );

    expect(statements).toEqual([
      "SELECT pg_advisory_lock($1)",
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT pg_advisory_unlock($1)",
    ]);
    expect(callback).not.toHaveBeenCalled();
    expectDestroyed(release);
  });
});

describe("withTransaction uncertain BEGIN state", () => {
  it("destroys the client when BEGIN is not acknowledged", async () => {
    const callback = vi.fn();
    const { query, release } = clientWith(async (text) => {
      expect(text).toBe("BEGIN");
      throw LOST_ACK;
    });

    await expect(withTransaction(callback)).rejects.toBeInstanceOf(
      DatabaseUnavailableError
    );

    expect(query).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
    expectDestroyed(release);
  });
});
