/**
 * Compare transfer history from Appwrite against transfer history from
 * PostgreSQL, for every bank.
 *
 *   npm run history:compare
 *
 * READ-ONLY. It writes nothing to either store.
 *
 * WHY THIS EXISTS. The cutover rule is that an Appwrite read is not deleted
 * until a PostgreSQL read has been proven to give the same answer. "Proven"
 * means compared on real data, not asserted in a commit message.
 *
 * WHAT A DIFFERENCE MEANS. Not necessarily a bug. Transfers written before the
 * party columns existed have NULL bank references, so PostgreSQL cannot yet
 * serve them — they need the backfill. That shows up here as a row Appwrite has
 * and PostgreSQL does not, which is exactly the signal the backfill is for.
 */
import { closePool } from "../lib/db/pool";
import { listTransfersForBank } from "../lib/db/repositories/transfers.repository";
import { toTransactionDTOFromTransfer } from "../lib/dto/transaction.dto";
import { readAllLegacyBanks, readAllLegacyTransfers } from "../lib/migration/appwrite-source";

type Legacy = Record<string, unknown>;

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }

  const banks = await readAllLegacyBanks();
  const legacy = await readAllLegacyTransfers();

  console.log(
    [
      "────────────────────────────────────────────────────────────────",
      "Transfer history: Appwrite vs PostgreSQL   [READ-ONLY]",
      "────────────────────────────────────────────────────────────────",
      `banks            ${banks.documents.length}`,
      `legacy records   ${legacy.documents.length}`,
      "",
    ].join("\n")
  );

  let agreed = 0;
  let onlyLegacy = 0;
  let onlyPostgres = 0;

  for (const bank of banks.documents) {
    const bankId = bank.$id;

    const fromAppwrite = legacy.documents.filter((d) => {
      const r = d as unknown as Legacy;
      return r.senderBankId === bankId || r.receiverBankId === bankId;
    });

    const rows = await listTransfersForBank(bankId);
    const fromPostgres = rows.map((row) => toTransactionDTOFromTransfer(row, bankId));

    // Matched by amount and direction, because the legacy records carry neither
    // the PostgreSQL transfer id nor the idempotency key. That is the whole
    // difficulty of the backfill and it is why this is a REPORT rather than an
    // automatic reconciliation.
    const legacyKeys = fromAppwrite.map((d) => {
      const r = d as unknown as Legacy;
      const direction = r.senderBankId === bankId ? "debit" : "credit";
      return `${direction}:${String(r.amount ?? "").trim()}`;
    });
    const postgresKeys = fromPostgres.map(
      (t) => `${t.direction}:${(t.amountMinor / 100).toFixed(2)}`
    );

    const matched = postgresKeys.filter((k) => legacyKeys.includes(k));
    const missingFromPostgres = legacyKeys.filter((k) => !postgresKeys.includes(k));
    const extraInPostgres = postgresKeys.filter((k) => !legacyKeys.includes(k));

    agreed += matched.length;
    onlyLegacy += missingFromPostgres.length;
    onlyPostgres += extraInPostgres.length;

    if (missingFromPostgres.length || extraInPostgres.length) {
      console.log(`  bank ${bankId}`);
      console.log(
        `    appwrite ${legacyKeys.length}  postgres ${postgresKeys.length}  matched ${matched.length}`
      );
      for (const k of missingFromPostgres) console.log(`    ONLY IN APPWRITE   ${k}`);
      for (const k of extraInPostgres) console.log(`    ONLY IN POSTGRES   ${k}`);
    }
  }

  console.log(
    [
      "",
      `matched            ${agreed}`,
      `only in Appwrite   ${onlyLegacy}   (need the backfill)`,
      `only in PostgreSQL ${onlyPostgres}`,
      "",
      onlyLegacy === 0 && onlyPostgres === 0
        ? "The two stores agree. The PostgreSQL read can serve this history."
        : "They do not agree yet. Do not switch the read until they do.",
      "────────────────────────────────────────────────────────────────",
    ].join("\n")
  );

  await closePool();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `Comparison failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    process.exitCode = 1;
  });
