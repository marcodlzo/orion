/**
 * Backfill the legacy Appwrite dataset into PostgreSQL.
 *
 *   npm run db:backfill              dry run (default)
 *   npm run db:backfill -- --commit  actually write
 *
 * DRY RUN IS THE DEFAULT, on purpose. A one-character mistake on a command that
 * writes to a financial datastore should not be possible; writing requires
 * saying so explicitly.
 *
 * The dry run is not a simulation — it opens a real transaction, performs every
 * insert, and rolls back. Constraint violations surface exactly as they would
 * on the real run.
 *
 * Formatting lives in lib/migration/report-format.ts so it can be tested for
 * what it must never print. This file only decides exit codes.
 */
import { closePool } from "../lib/db/pool";
import { runBackfill } from "../lib/migration/backfill";
import {
  describeThrown,
  formatBackfillReport,
} from "../lib/migration/report-format";

async function main(): Promise<number> {
  const commit = process.argv.includes("--commit");

  // Carry the fingerprint printed by the dry run into the commit. Without it a
  // dry run of dataset A can be followed by a commit of dataset B, and nothing
  // notices.
  const expect = process.argv
    .find((a) => a.startsWith("--expect-source="))
    ?.split("=")[1];

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }

  const report = await runBackfill({
    dryRun: !commit,
    ...(expect ? { expectSourceFingerprint: expect } : {}),
  });
  for (const line of formatBackfillReport(report)) console.log(line);

  // A failed write is an error even though the tool completed, and so is a
  // short source read — a run over partial data must not look successful.
  // Skipped and degraded records are reported but do not fail the command:
  // they are expected outcomes an operator decides about.
  return report.outcome === "committed" && report.failures.length === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error("Backfill aborted:", describeThrown(error));
    await closePool().catch(() => undefined);
    process.exit(1);
  });
