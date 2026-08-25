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

export function formatBackfillReport(report: BackfillReport): string[] {
  const mode = report.dryRun ? "DRY RUN — nothing was written" : "COMMITTED";
  const { users, banks } = report.source;
  const out: string[] = [];

  const scanLine = (label: string, s: typeof users) =>
    `source ${label.padEnd(11)}${s.scanned}/${s.reportedTotal} scanned over ${s.pages} page(s)` +
    (s.complete ? "" : "   *** INCOMPLETE ***");

  out.push(RULE, `Appwrite → PostgreSQL backfill   [${mode}]`, RULE);
  // Source evidence, not just counts: "12 customers migrated" is equally true
  // of a complete read and of one that stopped after the first page.
  out.push(scanLine("users", users), scanLine("banks", banks));
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
  if (!report.source.complete) {
    out.push("SOURCE READ WAS INCOMPLETE. Do not treat this run as a complete migration.");
  }
  if (report.dryRun) {
    out.push("Nothing was written. Re-run with --commit to apply.");
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
    out.push("", "No drift. PostgreSQL matches the legacy dataset.");
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
