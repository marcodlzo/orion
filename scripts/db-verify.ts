/**
 * Verify the Appwrite → PostgreSQL migration.
 *
 *   npm run db:verify
 *
 * Read-only. Compares the live legacy dataset against PostgreSQL and reports
 * every difference. Exits non-zero when drift is present so it can gate a
 * cutover rather than merely inform one.
 *
 * It never repairs anything. Deciding what a mismatch means is an operator's
 * judgement.
 */
import { closePool } from "../lib/db/pool";
import {
  describeThrown,
  formatVerificationReport,
} from "../lib/migration/report-format";
import { verifyMigration } from "../lib/migration/verify";

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }

  const report = await verifyMigration();
  for (const line of formatVerificationReport(report)) console.log(line);
  return report.ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error("Verification aborted:", describeThrown(error));
    await closePool().catch(() => undefined);
    process.exit(1);
  });
