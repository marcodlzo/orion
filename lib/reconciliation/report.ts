/**
 * Rendering for the reconciliation CLI.
 *
 * PURE. Returns lines; writes nothing — so it can be tested for what it must
 * never print. An operator report ends up in a terminal scrollback, a CI log and
 * often a pasted message, which makes it one of the easiest places for a
 * funding-source URL or an access token to escape.
 *
 * Findings carry internal identifiers and fixed vocabulary by construction.
 * `redactSecrets` is reused here as the last line of defence, not the first.
 */

import { redactSecrets } from "../migration/report-format";
import type { Finding, ReconciliationReport } from "./checks";

const RULE = "─".repeat(64);

/** What each finding means, in a sentence an operator can act on. */
const EXPLANATION: Record<Finding["code"], string> = {
  SETTLED_WITHOUT_POSTING:
    "the transfer is settled but the ledger has no entries for it — money moved with no record",
  POSTING_WITHOUT_SETTLEMENT:
    "the ledger has entries for a transfer that never settled",
  REVERSED_WITHOUT_COMPENSATION:
    "the transfer is reversed but nothing compensates the original posting",
  POSTED_AMOUNT_MISMATCH: "the posted amount differs from the transfer amount",
  POSTED_NET_UNEXPECTED:
    "the transfer's entries do not net to zero — an unpaired entry exists",
  TERMINAL_WITH_ACTIVE_HOLD:
    "funds are still reserved for a transfer that has finished",
  STALE_SUBMITTED:
    "accepted by the provider long ago and still unresolved — check for missed webhooks",
  STALE_REQUESTED:
    "claimed and never sent; a process died between the claim and the provider call",
  SUBMITTED_WITHOUT_REFERENCE:
    "submitted with no provider reference — this transfer cannot be reconciled",
  PROVIDER_AHEAD: "the provider has moved on and this system has not noticed",
  PROVIDER_CONTRADICTS_SETTLEMENT:
    "the provider says this did not complete, and the ledger still counts it",
  PROVIDER_UNKNOWN_REFERENCE:
    "the provider does not recognise a reference this system recorded",
  LEDGER_NOT_BALANCED:
    "the ledger does not sum to zero — no balance in it can be trusted",
};

/** Human-readable lines for a report. Never printed here; returned. */
export function formatReconciliationReport(
  report: ReconciliationReport
): string[] {
  const lines: string[] = [
    RULE,
    "RECONCILIATION",
    RULE,
    `transfers checked      ${report.checkedTransfers}`,
    `compared with provider ${report.comparedWithProvider}`,
    `findings               ${report.findings.length} (${report.criticalCount} critical, ${report.warningCount} warning)`,
    "",
  ];

  if (report.clean) {
    lines.push("No drift found.");
    lines.push("");
    lines.push(
      "This means the ledger agrees with itself and with everything that was compared."
    );
    lines.push(
      "It does NOT mean every transfer reached the provider — only those with a"
    );
    lines.push("reference could be compared at all.");
    return lines.map(redactSecrets);
  }

  // Critical first: an operator reading a long report should meet the ledger
  // problems before the "check this eventually" ones.
  const ordered = [...report.findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1
  );

  for (const finding of ordered) {
    const marker = finding.severity === "critical" ? "CRITICAL" : "warning ";
    const subject = finding.transferId ?? "ledger";
    lines.push(`${marker}  ${finding.code}  ${subject}`);
    lines.push(`          ${EXPLANATION[finding.code]}`);
    lines.push(`          ${finding.detail}`);
    lines.push("");
  }

  lines.push(RULE);
  lines.push("NOTHING WAS CHANGED. Reconciliation reports; it does not repair.");
  lines.push(
    "Correcting drift automatically would destroy the evidence of what caused it."
  );

  return lines.map(redactSecrets);
}

/** Non-zero when a human needs to look. */
export function exitCodeFor(report: ReconciliationReport): number {
  if (report.criticalCount > 0) return 2;
  if (report.warningCount > 0) return 1;
  return 0;
}
