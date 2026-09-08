/**
 * Fill in the party columns on transfers written before they existed.
 *
 *   npm run history:backfill          DRY RUN — writes nothing
 *   npm run history:backfill:commit   actually write
 *
 * WHY. `transfers` gained `sender_bank_document_id`,
 * `recipient_bank_document_id`, `recipient_user_document_id` and `note` with the
 * accounting-model change. Rows written before that have NULLs, so the
 * PostgreSQL history read cannot serve them and `npm run history:compare`
 * reports them as present in Appwrite and absent here.
 *
 * WHAT MAKES THIS HARD, AND WHY IT REFUSES RATHER THAN GUESSES.
 *
 * Legacy Appwrite records carry neither the PostgreSQL transfer id nor the
 * idempotency key. There is no shared identifier at all. Matching is therefore
 * inference from customer, amount and time — and two identical transfers a
 * second apart are indistinguishable by all three.
 *
 * So an ambiguous match is REFUSED. Attaching the wrong counterparty to a
 * transfer would put a person's name against money that was not theirs, and it
 * would be invisible afterwards because both records would look well-formed.
 * A refusal leaves a NULL, which the comparison keeps reporting until somebody
 * resolves it deliberately.
 *
 * IT ONLY EVER FILLS NULLS. A row that already has parties is never rewritten,
 * so this is safe to re-run and cannot overwrite what the application recorded
 * for itself.
 */
import { closePool, query, withTransaction } from "../lib/db/pool";
import { findCustomerByUserDocumentId } from "../lib/db/repositories/banking-customers.repository";
import { readAllLegacyTransfers } from "../lib/migration/appwrite-source";

type LegacyTransfer = {
  $id: string;
  $createdAt?: string;
  amount?: unknown;
  name?: unknown;
  senderId?: unknown;
  receiverId?: unknown;
  senderBankId?: unknown;
  receiverBankId?: unknown;
};

/** The legacy amount is a decimal string. Parsed by digits, never by * 100. */
function legacyToMinor(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const cents = (match[3] ?? "").padEnd(2, "0");
  return sign * (Number(match[2]) * 100 + Number(cents));
}

async function main(): Promise<number> {
  const commit = process.argv.includes("--commit");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }

  const { rows: incomplete } = await query<{
    id: string;
    customer_id: string;
    amount_minor: string;
    created_at: Date;
  }>(
    `SELECT id, customer_id, amount_minor, created_at
       FROM transfers
      WHERE sender_bank_document_id IS NULL
      ORDER BY created_at`
  );

  const legacy = (await readAllLegacyTransfers()).documents as unknown as LegacyTransfer[];

  console.log(
    [
      "────────────────────────────────────────────────────────────────",
      `History backfill   ${commit ? "[COMMITTED]" : "[DRY RUN — nothing is written]"}`,
      "────────────────────────────────────────────────────────────────",
      `transfers missing parties  ${incomplete.length}`,
      `legacy records available   ${legacy.length}`,
      "",
    ].join("\n")
  );

  let filled = 0;
  let refused = 0;

  for (const transfer of incomplete) {
    const amountMinor = Number(transfer.amount_minor);

    // Candidates: the legacy record's SENDER must resolve to this transfer's
    // customer, and the amount must match exactly. Time is not used to
    // discriminate — it is only reported, because "closest in time" is exactly
    // the kind of guess that attaches the wrong party.
    const candidates: LegacyTransfer[] = [];
    for (const record of legacy) {
      if (legacyToMinor(record.amount) !== amountMinor) continue;
      const senderCustomer = await findCustomerByUserDocumentId(String(record.senderId ?? ""));
      if (senderCustomer?.id === transfer.customer_id) candidates.push(record);
    }

    if (candidates.length !== 1) {
      refused += 1;
      console.log(
        `  REFUSED   transfer ${transfer.id}  ${candidates.length} candidate(s)` +
          (candidates.length === 0 ? " — no legacy record matches" : " — ambiguous, resolve by hand")
      );
      continue;
    }

    const match = candidates[0];
    const recipientUserDocumentId = String(match.receiverId ?? "");
    const recipientCustomer = recipientUserDocumentId
      ? await findCustomerByUserDocumentId(recipientUserDocumentId)
      : null;

    console.log(
      `  ${commit ? "FILLED " : "WOULD FILL"}  transfer ${transfer.id}` +
        `  from legacy ${match.$id}  note=${JSON.stringify(String(match.name ?? ""))}`
    );

    if (!commit) {
      filled += 1;
      continue;
    }

    await withTransaction(async (client) => {
      // ONLY NULLS. The WHERE clause is what makes this re-runnable and what
      // stops it overwriting anything the application recorded itself.
      await client.query(
        `UPDATE transfers
            SET sender_bank_document_id = $2,
                recipient_bank_document_id = $3,
                recipient_user_document_id = $4,
                recipient_customer_id = COALESCE(recipient_customer_id, $5),
                note = COALESCE(note, $6)
          WHERE id = $1
            AND sender_bank_document_id IS NULL`,
        [
          transfer.id,
          String(match.senderBankId ?? ""),
          String(match.receiverBankId ?? ""),
          recipientUserDocumentId,
          recipientCustomer?.id ?? null,
          String(match.name ?? ""),
        ]
      );
    });
    filled += 1;
  }

  console.log(
    [
      "",
      commit ? `filled ${filled}, refused ${refused}` : `${filled} would be filled, ${refused} refused`,
      "",
      "The accounting_model is NOT changed. These transfers settled under the",
      "house model and their entries are immutable; relabelling them would make",
      "the column describe a shape the ledger does not have.",
      commit ? "" : "To apply:\n  npm run history:backfill:commit",
      "────────────────────────────────────────────────────────────────",
    ]
      .filter(Boolean)
      .join("\n")
  );

  await closePool();
  return refused === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `Backfill failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    process.exitCode = 1;
  });
