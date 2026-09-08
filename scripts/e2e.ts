import { spawnSync } from "node:child_process";
import { requireTestDatabase } from "../lib/db/test-database";

// Only the dedicated test database is used by the browser server. The normal
// application database and its intentional reconciliation finding stay intact.
const databaseUrl = requireTestDatabase();
if (process.env.DWOLLA_ENV !== "sandbox") throw new Error("E2E requires Dwolla sandbox");
for (const name of ["NEXT_APPWRITE_KEY", "PLAID_CLIENT_ID", "PLAID_SECRET", "DWOLLA_KEY", "DWOLLA_SECRET"]) {
  if (!process.env[name]) throw new Error(`E2E requires ${name}`);
}
const env = { ...process.env, ORION_E2E_DATABASE_URL: databaseUrl };
const migrations = spawnSync(process.execPath, ["node_modules/node-pg-migrate/bin/node-pg-migrate.js", "up"], { env, stdio: "inherit" });
if (migrations.status !== 0) process.exit(migrations.status ?? 1);
const tests = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)], { env, stdio: "inherit" });
process.exit(tests.status ?? 1);
