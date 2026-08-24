import { describe, it, expect, afterEach } from "vitest";

import { checkDatabase } from "./health";
import { closePool } from "./pool";
import { DatabaseUnavailableError } from "./errors";

/**
 * Database health primitive, against a real server.
 *
 * The unhealthy case is exercised by pointing at a port nothing is listening
 * on, not by mocking the driver — the value of this function is entirely in how
 * it behaves when the network does something real.
 */

const originalUrl = process.env.DATABASE_URL;

afterEach(async () => {
  await closePool();
  process.env.DATABASE_URL = originalUrl;
});

describe("checkDatabase", () => {
  it("reports healthy against a reachable database", async () => {
    process.env.DATABASE_URL =
      process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    await closePool();

    const health = await checkDatabase();

    expect(health.healthy).toBe(true);
    expect(typeof health.latencyMs).toBe("number");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("raises DatabaseUnavailableError when the server is unreachable", async () => {
    await closePool();
    // Port 1 is reserved and nothing listens there.
    process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/absent";

    await expect(checkDatabase()).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });

  it("raises DatabaseUnavailableError when DATABASE_URL is absent", async () => {
    await closePool();
    delete process.env.DATABASE_URL;

    await expect(checkDatabase()).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });

  it("never leaks the connection string through the error", async () => {
    await closePool();
    process.env.DATABASE_URL =
      "postgresql://leaky_user:sup3r_s3cret@127.0.0.1:1/absent";

    const error: unknown = await checkDatabase().then(
      () => null,
      (e: unknown) => e
    );
    const asError = error as Error;
    const text = `${asError?.message ?? ""} ${asError?.stack ?? ""} ${JSON.stringify(error)}`;

    // A driver connection error names host, port and user; some include the
    // password when the URL is echoed back.
    expect(text).not.toContain("sup3r_s3cret");
    expect(text).not.toContain("leaky_user");
  });
});
