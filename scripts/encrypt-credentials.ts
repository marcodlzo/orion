/**
 * Encrypt provider credentials already stored in plaintext.
 *
 *   npm run credentials:encrypt           DRY RUN — writes nothing
 *   npm run credentials:encrypt:commit    actually rewrite
 *
 * WHAT THIS FIXES. Plaid access tokens and Dwolla funding-source URLs were
 * stored in plaintext in the Appwrite bank collection. An access token grants
 * read access to somebody's bank account; possession of a funding-source URL is
 * sufficient to move money from it. A backup, a console session or a leaked
 * admin key exposed every one of them at once.
 *
 * DRY RUN BY DEFAULT, and deliberately so: this rewrites the ONLY COPY of a
 * credential. A bug here does not lose a row, it loses access to somebody's bank
 * account. Every value is decrypted back and compared before anything is
 * written, and an already-encrypted value that cannot be read is reported rather
 * than rewritten.
 *
 * RE-RUNNABLE. Run it again after a partial run; encrypted values are skipped.
 *
 * NO CREDENTIAL IS EVER PRINTED. The report carries document ids, field names
 * and counts. Nothing in it is built from a scope holding a secret.
 *
 * Exit codes:  0 clean   1 work remains or a value is unreadable   2 the run failed
 */
import { closePool } from "../lib/db/pool";
import { describeThrown } from "../lib/migration/report-format";
import {
  encryptStoredCredentials,
  type EncryptionReport,
} from "../lib/migration/credential-encryption";

const RULE = "─".repeat(64);

function render(report: EncryptionReport): string[] {
  const lines = [
    RULE,
    report.committed
      ? "CREDENTIAL ENCRYPTION — COMMITTED"
      : "CREDENTIAL ENCRYPTION — DRY RUN (nothing was written)",
    RULE,
    `bank documents scanned   ${report.scanned} of ${report.reportedTotal}`,
    `documents needing work   ${report.documentsChanged}`,
    `fields to encrypt        ${report.fieldsEncrypted}`,
    `already encrypted        ${report.fieldsAlreadyEncrypted}`,
    `absent                   ${report.fieldsMissing}`,
    `UNREADABLE               ${report.fieldsUnreadable}`,
    "",
  ];

  if (report.fieldsUnreadable > 0) {
    lines.push(
      "Some values are encrypted but cannot be decrypted with the current keyring."
    );
    lines.push(
      "They were NOT rewritten. Restore the key that wrote them before continuing —"
    );
    lines.push("re-encrypting them would destroy whatever they hold.");
    lines.push("");
    for (const outcome of report.outcomes) {
      if (outcome.unreadable.length > 0) {
        lines.push(`  ${outcome.documentId}  ${outcome.unreadable.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (report.clean) {
    lines.push("Every credential at rest is encrypted and readable.");
  } else if (!report.committed && report.fieldsEncrypted > 0) {
    lines.push(
      `${report.fieldsEncrypted} field(s) would be encrypted. Re-run with:`
    );
    lines.push("  npm run credentials:encrypt:commit");
  }

  return lines;
}

async function main(): Promise<number> {
  const commit = process.argv.includes("--commit");

  const report = await encryptStoredCredentials({ commit });

  // Completeness first. A sweep that silently read half the collection would
  // report the unread half as fine, and this is the sweep that decides whether
  // plaintext still exists.
  if (report.scanned !== report.reportedTotal) {
    console.error(
      `Incomplete read: scanned ${report.scanned} of ${report.reportedTotal} bank documents. Refusing to report on a partial sweep.`
    );
    return 2;
  }

  for (const line of render(report)) console.log(line);

  if (report.fieldsUnreadable > 0) return 1;
  return report.clean ? 0 : 1;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(describeThrown(error));
    await closePool();
    process.exit(2);
  });
