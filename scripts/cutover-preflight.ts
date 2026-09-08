import { readAllLegacyBanksAsStored, readAllLegacyTransfers } from "../lib/migration/appwrite-source";
import { planTransferHistory } from "../lib/migration/transfer-history-plan";
import { query, closePool } from "../lib/db/pool";

function relationshipId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "$id" in value && typeof value.$id === "string") return value.$id;
  return "";
}
async function main() {
  const [banks, legacy, customers, transfers] = await Promise.all([
    readAllLegacyBanksAsStored(), readAllLegacyTransfers(),
    query<{ id: string; userDocumentId: string }>('SELECT id, appwrite_user_document_id AS "userDocumentId" FROM banking_customers', []),
    query<{ id: string; customerId: string; fingerprint: string; amountMinor: string; currency: string; state: string }>(
      'SELECT id, customer_id AS "customerId", request_fingerprint AS fingerprint, amount_minor::text AS "amountMinor", currency, state FROM transfers', []),
  ]);
  if (banks.scanned !== banks.reportedTotal || legacy.scanned !== legacy.reportedTotal) throw new Error("Source changed during scan");
  const report = planTransferHistory({
    legacy: legacy.documents,
    banks: banks.documents.map(b => ({ id: b.$id, owner: relationshipId(b.userId), accountId: b.accountId })),
    customers: customers.rows, transfers: transfers.rows,
  });
  console.log(JSON.stringify({ readOnly: true, legacyRecords: legacy.scanned, durableTransfers: transfers.rows.length,
    candidateMatches: report.matches.length, issues: report.issues, sourceFingerprint: legacy.fingerprint }, null, 2));
  // A unique candidate is not authorization to migrate. This is a preflight,
  // not an independent verifier and not a commit mode.
  process.exitCode = report.issues.length ? 1 : 0;
}
main().catch(() => { console.error("Cutover preflight failed; no data was changed"); process.exitCode = 2; }).finally(closePool);
