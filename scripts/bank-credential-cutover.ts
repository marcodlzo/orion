import { closePool } from "../lib/db/pool";
import { migrateBankCredentials } from "../lib/migration/bank-credential-cutover";

const commit = process.argv.includes("--commit");
migrateBankCredentials({ commit })
  .then(async (report) => {
    console.log(commit ? "BANK CREDENTIAL CUTOVER — COMMITTED" : "BANK CREDENTIAL CUTOVER — DRY RUN");
    console.log(`documents scanned      ${report.scanned}`);
    console.log(`credentials migrated   ${report.migrated}`);
    console.log(`existing verified      ${report.verifiedExisting}`);
    await closePool();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Credential cutover failed");
    await closePool();
    process.exitCode = 1;
  });
