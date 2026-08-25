/**
 * Rendering for the operator CLIs.
 *
 * PURE. Returns lines; writes nothing. Formatting lives here rather than in
 * scripts/ so it can be tested — including for what it must never print. The
 * scripts were previously the only untested code in the migration path, which
 * is a poor place for a blind spot: they are the surface an operator actually
 * reads, and the one that ends up in a terminal scrollback or a CI log.
 */

import type { BackfillReport } from "./backfill";
import type { VerificationReport } from "./verify";

const RULE = "─".repeat(64);

/**
 * Strip credential-shaped substrings from text bound for a terminal.
 *
 * The last line of defence, not the first. Reports are built from contained
 * values and carry no secret by construction; this exists because operator
 * output also renders arbitrary `Error.message`, and an error thrown by a
 * driver, a provider SDK or a dependency is not something this project
 * controls. `pg` alone will happily put a connection URL in a message.
 *
 * Redaction is not a substitute for not having the secret. It is what stops a
 * library's idea of a helpful message from becoming a leak.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // postgres://user:password@host — the password, not the whole URL, so the
      // remaining text still tells the operator which host failed.
      .replace(/(\w+:\/\/[^:/\s]+:)[^@\s]+(@)/g, "$1***$2")
      // Plaid and Dwolla token shapes.
      .replace(/\b(access|processor|public)-(sandbox|development|production)-[\w-]+/gi, "$1-$2-***")
      // Anything that announced itself as a secret in a key=value pair.
      .replace(
        /\b(access_?token|processor_?token|api_?key|secret|password|authorization)\b(\s*[=:]\s*)("?)[^\s",;}]+\3/gi,
        "$1$2***"
      )
  );
}

/** One operator-safe line describing a thrown value. */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(`${error.name}: ${error.message}`);
  }
  // Never stringify an unknown object: it may be a provider response.
  return "unknown error";
}

/**
 * Process exit code for a finished backfill.
 *
 * Extracted so it can be tested. A successful DRY RUN is a success — it used to
 * exit 1, which made the normal first command always look like a failure and
 * would have blocked CI on the happy path. Everything that did not durably do
 * what was asked exits non-zero, including "unknown", which needs a human.
 */
export function backfillExitCode(report: BackfillReport): number {
  const succeeded =
    (report.outcome === "committed" || report.outcome === "dry-run") &&
    report.failures.length === 0;
  return succeeded ? 0 : 1;
}

export function formatBackfillReport(report: BackfillReport): string[] {
  // The heading states what happened to the DATABASE, not what was requested.
  // "COMMITTED" over counters that PostgreSQL rolled back is a false statement
  // about the system of record.
  const mode: Record<BackfillReport["outcome"], string> = {
    "committed": "COMMITTED",
    "dry-run": "DRY RUN — nothing was written",
    "rolled-back": "ROLLED BACK — nothing was written",
    "not-started": "NOT STARTED — the transaction never opened",
    "unknown": "*** OUTCOME UNKNOWN — INSPECT THE DATABASE ***",
    "refused": "REFUSED — nothing was attempted",
  };
  const { users, banks } = report.source;
  const out: string[] = [];

  const scanLine = (label: string, s: typeof users) =>
    `source ${label.padEnd(11)}${s.scanned}/${s.reportedTotal} scanned over ${s.pages} page(s)` +
    (s.complete ? "" : "   *** INCOMPLETE ***");

  out.push(RULE, `Appwrite → PostgreSQL backfill   [${mode[report.outcome]}]`, RULE);
  // Source evidence, not just counts: "12 customers migrated" is equally true
  // of a complete read and of one that stopped after the first page.
  out.push(scanLine("users", users), scanLine("banks", banks));
  out.push(`source digest     ${report.source.fingerprint}`);
  out.push(
    `customers         ${report.customers.created} created, ${report.customers.existing} already present, ${report.customers.failed} failed`,
    `linked accounts   ${report.accounts.created} created, ${report.accounts.updated} updated, ${report.accounts.blocked} blocked, ${report.accounts.failed} failed`,
    `enrichment        ${report.enrichment.succeeded} ok, ${report.enrichment.failed} failed`
  );

  if (report.skipped.length) {
    out.push("", `skipped by mapping (${report.skipped.length}) — these will NOT migrate:`);
    for (const s of report.skipped) {
      out.push(`  ${s.kind} ${s.id}: [${s.code}] ${s.reason}`);
    }
  }

  const degraded = report.enrichmentFailures.filter((f) => !f.blocked);
  const blocked = report.enrichmentFailures.filter((f) => f.blocked);

  if (degraded.length) {
    out.push(
      "",
      `provider metadata unavailable (${degraded.length}) — MIGRATED with placeholder names; a re-run fills them in and will not overwrite good data:`
    );
    for (const f of degraded) out.push(`  ${f.legacyBankDocumentId}: [${f.code}] ${f.reason}`);
  }

  if (blocked.length) {
    out.push(
      "",
      `NOT MIGRATED (${blocked.length}) — migrating these would require inventing a fact:`
    );
    for (const f of blocked) out.push(`  ${f.legacyBankDocumentId}: [${f.code}] ${f.reason}`);
  }

  if (report.failures.length) {
    out.push("", `WRITE FAILURES (${report.failures.length}):`);
    for (const f of report.failures) out.push(`  ${f.kind} ${f.id}: ${f.reason}`);
  }

  out.push(RULE);
  if (report.outcome === "refused") {
    out.push(`REFUSED: ${report.refusedBecause ?? "precondition not met"}`);
    out.push("No provider calls were made and no rows were written.");
  }
  if (report.outcome === "rolled-back") {
    out.push(
      "The transaction aborted. PostgreSQL discarded every write, so the counters above are all zero."
    );
  }
  if (report.outcome === "not-started") {
    out.push(
      "The transaction never opened, so nothing was attempted. This is not the same as a rollback."
    );
  }
  if (report.outcome === "unknown") {
    out.push(
      "COMMIT FAILED. PostgreSQL may or may not have applied this transaction —",
      "the acknowledgement was lost, and a later ROLLBACK cannot undo a commit",
      "that already happened. DO NOT re-run blindly. Inspect the database first;",
      "the upserts are idempotent, so a re-run is safe once you know the state."
    );
  }
  if (!report.source.complete) {
    out.push("SOURCE READ WAS INCOMPLETE. Do not treat this run as a complete migration.");
  }
  if (report.outcome === "dry-run") {
    out.push("Nothing was written. To apply exactly this dataset:");
    out.push(
      `  npm run db:backfill:commit -- --expect-source=${report.source.fingerprint}`
    );
    out.push("The commit refuses if the source changed in the meantime.");
  }

  return out.map(redactSecrets);
}

export function formatVerificationReport(report: VerificationReport): string[] {
  const { scan } = report.legacy;
  const out: string[] = [];

  out.push(RULE, `Appwrite ↔ PostgreSQL verification   ${report.checkedAt}`, RULE);
  out.push(
    `legacy source     ${report.legacy.users} users, ${report.legacy.banks} bank documents`,
    `source scan       users ${scan.users.scanned}/${scan.users.reportedTotal} (${scan.users.pages}p), banks ${scan.banks.scanned}/${scan.banks.reportedTotal} (${scan.banks.pages}p)` +
      (scan.complete ? "" : "   *** INCOMPLETE ***"),
    `expected          ${report.legacy.migratable.customers} customers, ${report.legacy.migratable.accounts} linked accounts`,
    `postgres          ${report.postgres.customers} customers, ${report.postgres.accounts} linked accounts`,
    `not migratable    ${report.skippedBySource} source records`
  );

  if (report.ok) {
    // Scoped deliberately. "No drift" previously read as "the migration is
    // correct", which is more than this command can establish.
    out.push("", "No drift in identity or linkage.");
    out.push("", "NOT checked by this command:");
    for (const item of report.scope.notVerified) out.push(`  - ${item}`);
  } else {
    const byCategory = new Map<string, typeof report.drift>();
    for (const d of report.drift) {
      const bucket = byCategory.get(d.category) ?? [];
      bucket.push(d);
      byCategory.set(d.category, bucket);
    }

    out.push("", `DRIFT (${report.drift.length}):`);
    for (const [category, items] of Array.from(byCategory.entries())) {
      out.push("", `  ${category} (${items.length})`);
      for (const item of items) out.push(`    ${item.id}: ${item.detail}`);
    }
  }

  out.push(RULE);
  return out.map(redactSecrets);
}
