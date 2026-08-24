// Server-only. Reads connection strings, so it lives behind the same boundary
// as the pool it configures.
import "server-only";

/**
 * Point the pool at the TEST database, or refuse to run.
 *
 * The integration suites TRUNCATE tables. There is exactly one acceptable
 * target for that and it is named explicitly.
 *
 * NO FALLBACK TO DATABASE_URL. The earlier `TEST_DATABASE_URL ?? DATABASE_URL`
 * was a loaded gun: a developer with .env.local in their shell and no
 * TEST_DATABASE_URL would have had the destructive suites silently truncate
 * their development database, and the suite would have passed while doing it.
 * An unset variable must stop the run, not pick a target on its own.
 *
 * The equality check matters as much as the presence check. Setting both
 * variables to the same URL satisfies "TEST_DATABASE_URL is set" while
 * targeting the development database anyway.
 *
 * Call from a top-level `beforeAll` in every *.db.test.ts file, before the pool
 * is first used — getPool() reads DATABASE_URL once and caches the pool.
 */
export function requireTestDatabase(): string {
  const testUrl = process.env.TEST_DATABASE_URL;

  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Database tests truncate tables and will " +
        "not guess a target; they never fall back to DATABASE_URL. Set it to a " +
        "dedicated test database (see .env.example) and re-run."
    );
  }

  const devUrl = process.env.DATABASE_URL;
  if (devUrl && normalise(devUrl) === normalise(testUrl)) {
    throw new Error(
      "TEST_DATABASE_URL and DATABASE_URL point at the same database. These " +
        "tests truncate tables; refusing to run against the development database."
    );
  }

  if (!/_test(\b|$)/.test(databaseNameOf(testUrl))) {
    // A convention, deliberately enforced. The cost of a wrong URL here is a
    // wiped database, and the cost of the convention is renaming one database.
    throw new Error(
      `TEST_DATABASE_URL names the database "${databaseNameOf(testUrl)}", which ` +
        "does not end in _test. Refusing to truncate a database that is not " +
        "clearly a test database."
    );
  }

  process.env.DATABASE_URL = testUrl;
  return testUrl;
}

/** The database name, with no credentials attached. */
function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

/**
 * Compare connection targets without being fooled by cosmetic differences.
 * Credentials are deliberately excluded: two URLs differing only by password
 * still address the same database.
 */
function normalise(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}
