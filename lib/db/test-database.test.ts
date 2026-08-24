import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireTestDatabase } from "./test-database";

/**
 * The guard that stands between the destructive integration suites and a
 * developer's database.
 *
 * It is tested harder than most helpers because its failure mode is silent and
 * permanent: the wrong answer here truncates real tables and the suite still
 * reports green.
 */

const saved = {
  test: process.env.TEST_DATABASE_URL,
  dev: process.env.DATABASE_URL,
};

const TEST_URL = "postgresql://orion:pw@localhost:5440/orion_test";
const DEV_URL = "postgresql://orion:pw@localhost:5440/orion";

beforeEach(() => {
  delete process.env.TEST_DATABASE_URL;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  if (saved.test === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = saved.test;
  if (saved.dev === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = saved.dev;
});

describe("requireTestDatabase", () => {
  it("points the pool at the test database", () => {
    process.env.TEST_DATABASE_URL = TEST_URL;

    expect(requireTestDatabase()).toBe(TEST_URL);
    expect(process.env.DATABASE_URL).toBe(TEST_URL);
  });

  it("throws when TEST_DATABASE_URL is unset", () => {
    expect(() => requireTestDatabase()).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("NEVER falls back to DATABASE_URL", () => {
    // The original bug. A developer with .env.local in their shell and no
    // TEST_DATABASE_URL would have had the destructive suites silently truncate
    // their development database — and pass while doing it.
    process.env.DATABASE_URL = DEV_URL;

    expect(() => requireTestDatabase()).toThrow(/TEST_DATABASE_URL is not set/);
    // And it must not have quietly adopted the dev URL on the way out.
    expect(process.env.DATABASE_URL).toBe(DEV_URL);
  });

  it("refuses when both variables name the same database", () => {
    // Setting both to the same value satisfies "TEST_DATABASE_URL is set" while
    // still pointing at the development database.
    process.env.TEST_DATABASE_URL = DEV_URL;
    process.env.DATABASE_URL = DEV_URL;

    expect(() => requireTestDatabase()).toThrow(/same database/);
  });

  it("sees through cosmetic differences when comparing targets", () => {
    // Different credentials, same host/port/database. Still the dev database.
    process.env.TEST_DATABASE_URL = "postgresql://someone:else@localhost:5440/orion";
    process.env.DATABASE_URL = DEV_URL;

    expect(() => requireTestDatabase()).toThrow(/same database/);
  });

  it("refuses a database whose name does not end in _test", () => {
    process.env.TEST_DATABASE_URL = "postgresql://orion:pw@localhost:5440/production";

    expect(() => requireTestDatabase()).toThrow(/does not end in _test/);
  });

  it("accepts a differently-hosted test database", () => {
    process.env.TEST_DATABASE_URL = "postgresql://ci:ci@db:5432/orion_test";
    process.env.DATABASE_URL = DEV_URL;

    expect(() => requireTestDatabase()).not.toThrow();
  });

  it("does not put the connection string in the error it throws", () => {
    process.env.TEST_DATABASE_URL = "postgresql://leaky:SENTINEL-pw-3f19@localhost:5440/nope";

    const error = (() => {
      try {
        requireTestDatabase();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error).not.toBeNull();
    expect(error!.message).not.toContain("SENTINEL-pw-3f19");
    // The database NAME is safe and useful; the credentials are not.
    expect(error!.message).toContain("nope");
  });
});
