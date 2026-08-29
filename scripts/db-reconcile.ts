/**
 * Reconcile the ledger against itself and, optionally, against Dwolla.
 *
 *   npm run db:reconcile                 internal checks only
 *   npm run db:reconcile -- --provider   also ask Dwolla about each reference
 *
 * READ-ONLY, and structurally so: the reconciler issues SELECTs and nothing
 * else. It reports drift and exits non-zero; it never repairs. Deciding what a
 * mismatch means, and what to do about it, is an operator's judgement — and
 * silently correcting one would destroy the evidence of what caused it.
 *
 * Exit codes:  0 clean   1 warnings only   2 critical findings
 */
import { closePool } from "../lib/db/pool";
import { describeThrown } from "../lib/migration/report-format";
import { reconcile, type ProviderStatusReader } from "../lib/reconciliation/reconcile";
import {
  exitCodeFor,
  formatReconciliationReport,
} from "../lib/reconciliation/report";

/**
 * Ask Dwolla what it thinks of a transfer.
 *
 * Imported lazily so the internal checks run with no Dwolla credentials
 * configured at all. The provider comparison is the optional half; the half
 * that catches this system's own bugs should never be blocked on it.
 */
async function dwollaStatusReader(): Promise<ProviderStatusReader> {
  const { dwollaClient } = await import("../lib/server/dwolla");

  return async (providerTransferId: string) => {
    try {
      const response = await dwollaClient.get(`transfers/${providerTransferId}`);
      const status = (response.body as { status?: unknown }).status;

      switch (status) {
        case "processed":
          return "processed";
        case "pending":
          return "pending";
        case "failed":
          return "failed";
        case "cancelled":
        case "reclaimed":
          return "returned";
        default:
          // An unmapped status is NOT assumed benign. Reporting it as unknown
          // puts it in front of an operator instead of quietly passing.
          return "unknown";
      }
    } catch {
      // A 404 and an outage are indistinguishable here, and both mean the same
      // thing for the report: this reference could not be confirmed.
      return "unknown";
    }
  };
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }

  const useProvider = process.argv.includes("--provider");

  const readProviderStatus = useProvider ? await dwollaStatusReader() : undefined;

  if (!useProvider) {
    console.log(
      "Internal checks only. Pass --provider to also compare against Dwolla."
    );
  }

  const report = await reconcile({ readProviderStatus });

  for (const line of formatReconciliationReport(report)) {
    console.log(line);
  }

  return exitCodeFor(report);
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
