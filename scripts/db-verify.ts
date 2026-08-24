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
import { verifyMigration, type VerificationReport } from "../lib/migration/verify";

function render(report: VerificationReport): void {
  const line = "─".repeat(64);

  console.log(line);
  console.log(`Appwrite ↔ PostgreSQL verification   ${report.checkedAt}`);
  console.log(line);
  const { scan } = report.legacy;
  console.log(
    `legacy source     ${report.legacy.users} users, ${report.legacy.banks} bank documents`
  );
  console.log(
    `source scan       users ${scan.users.scanned}/${scan.users.reportedTotal} (${scan.users.pages}p), banks ${scan.banks.scanned}/${scan.banks.reportedTotal} (${scan.banks.pages}p)${scan.complete ? "" : "   *** INCOMPLETE ***"}`
  );
  console.log(
    `expected          ${report.legacy.migratable.customers} customers, ${report.legacy.migratable.accounts} linked accounts`
  );
  console.log(
    `postgres          ${report.postgres.customers} customers, ${report.postgres.accounts} linked accounts`
  );
  console.log(`not migratable    ${report.skippedBySource} source records`);

  if (report.ok) {
    console.log(`\nNo drift. PostgreSQL matches the legacy dataset.`);
  } else {
    const byCategory = new Map<string, typeof report.drift>();
    for (const d of report.drift) {
      const bucket = byCategory.get(d.category) ?? [];
      bucket.push(d);
      byCategory.set(d.category, bucket);
    }

    console.log(`\nDRIFT (${report.drift.length}):`);
    for (const [category, items] of Array.from(byCategory.entries())) {
      console.log(`\n  ${category} (${items.length})`);
      for (const item of items) console.log(`    ${item.id}: ${item.detail}`);
    }
  }

  console.log(line);
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }

  const report = await verifyMigration();
  render(report);
  return report.ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(
      "Verification aborted:",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"
    );
    await closePool().catch(() => undefined);
    process.exit(1);
  });
