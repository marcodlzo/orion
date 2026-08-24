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
 */
import { closePool } from "../lib/db/pool";
import { runBackfill, type BackfillReport } from "../lib/migration/backfill";

function render(report: BackfillReport): void {
  const mode = report.dryRun ? "DRY RUN — nothing was written" : "COMMITTED";
  const line = "─".repeat(64);

  const { users, banks } = report.source;

  console.log(line);
  console.log(`Appwrite → PostgreSQL backfill   [${mode}]`);
  console.log(line);
  // Source evidence, not just counts: "12 customers migrated" is equally true
  // of a complete read and of one that stopped after the first page.
  console.log(
    `source users      ${users.scanned}/${users.reportedTotal} scanned over ${users.pages} page(s)${users.complete ? "" : "   *** INCOMPLETE ***"}`
  );
  console.log(
    `source banks      ${banks.scanned}/${banks.reportedTotal} scanned over ${banks.pages} page(s)${banks.complete ? "" : "   *** INCOMPLETE ***"}`
  );
  console.log(
    `customers         ${report.customers.created} created, ${report.customers.existing} already present, ${report.customers.failed} failed`
  );
  console.log(
    `linked accounts   ${report.accounts.created} created, ${report.accounts.updated} updated, ${report.accounts.blocked} blocked, ${report.accounts.failed} failed`
  );
  console.log(
    `enrichment        ${report.enrichment.succeeded} ok, ${report.enrichment.failed} failed`
  );

  if (report.skipped.length) {
    console.log(`\nskipped by mapping (${report.skipped.length}) — these will NOT migrate:`);
    for (const s of report.skipped) {
      console.log(`  ${s.kind} ${s.id}: [${s.code}] ${s.reason}`);
    }
  }

  const degradedOnly = report.enrichmentFailures.filter((f) => !f.blocked);
  const blockedByProvider = report.enrichmentFailures.filter((f) => f.blocked);

  if (degradedOnly.length) {
    console.log(
      `\nprovider metadata unavailable (${degradedOnly.length}) — MIGRATED with placeholder names; a re-run fills them in and will not overwrite good data:`
    );
    for (const f of degradedOnly) {
      console.log(`  ${f.legacyBankDocumentId}: [${f.code}] ${f.reason}`);
    }
  }

  if (blockedByProvider.length) {
    console.log(
      `\nNOT MIGRATED (${blockedByProvider.length}) — migrating these would require inventing a fact:`
    );
    for (const f of blockedByProvider) {
      console.log(`  ${f.legacyBankDocumentId}: [${f.code}] ${f.reason}`);
    }
  }

  if (report.failures.length) {
    console.log(`\nWRITE FAILURES (${report.failures.length}):`);
    for (const f of report.failures) console.log(`  ${f.kind} ${f.id}: ${f.reason}`);
  }

  console.log(line);
  if (!report.source.complete) {
    console.log(
      "SOURCE READ WAS INCOMPLETE. Do not treat this run as a complete migration."
    );
  }
  if (report.dryRun) {
    console.log("Nothing was written. Re-run with --commit to apply.");
  }
}

async function main(): Promise<number> {
  const commit = process.argv.includes("--commit");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }

  const report = await runBackfill({ dryRun: !commit });
  render(report);

  // A failed write is an error even though the tool completed, and so is a
  // short source read — a run over partial data must not look successful.
  // Skipped and degraded records are reported but do not fail the command:
  // they are expected outcomes an operator decides about.
  return report.failures.length > 0 || !report.source.complete ? 1 : 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    // Print the type, not the object: a driver error can quote the offending
    // row and a provider error can echo the request.
    console.error(
      "Backfill aborted:",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"
    );
    await closePool().catch(() => undefined);
    process.exit(1);
  });
