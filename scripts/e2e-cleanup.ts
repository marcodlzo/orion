/**
 * Remove the Appwrite records the end-to-end suite leaves behind.
 *
 *   npm run e2e:cleanup          DRY RUN — deletes nothing
 *   npm run e2e:cleanup:commit   actually delete
 *
 * WHY THIS EXISTS. The browser suite isolates PostgreSQL — it runs against
 * TEST_DATABASE_URL — but it signs up through the real application, so its users,
 * banks and transactions land in the SAME Appwrite project as production data.
 * Nine of eleven users and six of nine bank documents were test residue by the
 * time this was noticed.
 *
 * That is not untidiness. `npm run db:backfill` reads every user and every bank,
 * so the residue migrates: a dry run reported 9 customers and 6 linked accounts
 * it would have created in the real database. The cutover reads the same source.
 *
 * THE PROPER FIX IS A SEPARATE APPWRITE PROJECT for end-to-end runs. This is the
 * mitigation until there is one, alongside the suite cleaning up after itself.
 *
 * WHAT IT CANNOT UNDO. Dwolla customers cannot be deleted, only deactivated, and
 * Plaid Items and funding sources created by a run stay in the sandbox. Provider
 * accumulation is inherent to testing against a real sandbox; only the Appwrite
 * side is recoverable.
 */
import { createAdminClient } from "../lib/appwrite";
import {
  readAllLegacyBanks,
  readAllLegacyTransfers,
  readAllLegacyUsers,
} from "../lib/migration/appwrite-source";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
  APPWRITE_TRANSACTION_COLLECTION_ID: TRANSACTION_COLLECTION_ID,
} = process.env;

/**
 * The suite's email prefix, and the only thing that marks a record as disposable.
 *
 * Deliberately narrow. It is generated in the spec as
 * `orion-e2e-<uuid>@example.com`, so it cannot collide with a real address
 * unless somebody deliberately creates one — and the guard below refuses if the
 * prefix would ever match everything.
 */
const E2E_EMAIL_PREFIX = "orion-e2e-";

function ownerDocumentId(bank: Record<string, unknown>): string {
  const raw = bank.userId;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "$id" in raw) {
    return String((raw as { $id: unknown }).$id);
  }
  return "";
}

async function main(): Promise<number> {
  const commit = process.argv.includes("--commit");

  if (!DATABASE_ID || !USER_COLLECTION_ID || !BANK_COLLECTION_ID) {
    console.error("Appwrite collection environment variables are not set.");
    return 2;
  }

  const users = await readAllLegacyUsers();
  const banks = await readAllLegacyBanks();

  const disposable = users.documents.filter((u) =>
    String((u as Record<string, unknown>).email ?? "").startsWith(E2E_EMAIL_PREFIX)
  );

  // A prefix that matches everything would delete the whole dataset. This
  // cannot happen with the constant above, which is exactly why it is worth
  // asserting: a later edit to the prefix is the only way to get here.
  if (disposable.length === users.documents.length && users.documents.length > 0) {
    console.error(
      "REFUSING: the test-account prefix matches every user. That is not cleanup."
    );
    return 2;
  }

  const disposableIds = new Set(disposable.map((u) => u.$id));
  const disposableBanks = banks.documents.filter((b) =>
    disposableIds.has(ownerDocumentId(b as unknown as Record<string, unknown>))
  );

  // ORPHANED TRANSACTION DOCUMENTS.
  //
  // The first version of this tool deleted users and banks and left these
  // behind, so a run's transaction records survived the user that made them.
  // They are not merely untidy: the history backfill reads this collection, and
  // an orphan is a record it cannot attribute to anybody.
  //
  // Identified by their PARTIES rather than by an email prefix, because a
  // transaction carries no email. A record naming a user document that no
  // longer exists is unattributable whatever created it.
  const liveUserIds = new Set(
    users.documents.filter((u) => !disposableIds.has(u.$id)).map((u) => u.$id)
  );
  const transfers = TRANSACTION_COLLECTION_ID
    ? (await readAllLegacyTransfers()).documents
    : [];
  const orphanedTransfers = transfers.filter((t) => {
    const r = t as unknown as Record<string, unknown>;
    const sender = String(r.senderId ?? "");
    const receiver = String(r.receiverId ?? "");
    return !liveUserIds.has(sender) || !liveUserIds.has(receiver);
  });

  console.log(
    [
      "────────────────────────────────────────────────────────────────",
      `End-to-end residue   ${commit ? "[DELETING]" : "[DRY RUN — nothing is deleted]"}`,
      "────────────────────────────────────────────────────────────────",
      `users scanned        ${users.documents.length}`,
      `banks scanned        ${banks.documents.length}`,
      `test users           ${disposable.length}`,
      `test bank documents  ${disposableBanks.length}`,
      `orphaned transactions ${orphanedTransfers.length}`,
      `retained users       ${users.documents.length - disposable.length}`,
      "",
    ].join("\n")
  );

  for (const user of users.documents) {
    const record = user as unknown as Record<string, unknown>;
    const email = String(record.email ?? "");
    const keep = !disposableIds.has(user.$id);
    console.log(
      `  ${keep ? "KEEP  " : "DELETE"}  ${String(record.firstName ?? "?").padEnd(10)} <${email}>`
    );
  }

  if (!commit) {
    console.log(
      [
        "",
        "Nothing was deleted. To apply:",
        "  npm run e2e:cleanup:commit",
        "────────────────────────────────────────────────────────────────",
      ].join("\n")
    );
    return 0;
  }

  const { database, user: userService } = await createAdminClient();
  let transfersDeleted = 0;
  let banksDeleted = 0;
  let usersDeleted = 0;
  let authDeleted = 0;
  let failed = 0;

  // Transactions first: they name users and banks, so removing them last would
  // mean deleting the things they point at while they still point at them.
  for (const transfer of orphanedTransfers) {
    if (!TRANSACTION_COLLECTION_ID) break;
    try {
      await database.deleteDocument(DATABASE_ID, TRANSACTION_COLLECTION_ID, transfer.$id);
      transfersDeleted += 1;
    } catch {
      console.error(`  failed to delete transaction ${transfer.$id}`);
      failed += 1;
    }
  }

  // Banks next: the user document is the relationship target, so removing it
  // while a bank still points at it leaves a dangling reference.
  for (const bank of disposableBanks) {
    try {
      await database.deleteDocument(DATABASE_ID, BANK_COLLECTION_ID, bank.$id);
      banksDeleted += 1;
    } catch {
      // Names only. A provider error echoes the request, and a bank document
      // request carries the record that holds the credentials.
      console.error(`  failed to delete bank ${bank.$id}`);
      failed += 1;
    }
  }

  for (const user of disposable) {
    const authId = String((user as Record<string, unknown>).userId ?? "");
    try {
      await database.deleteDocument(DATABASE_ID, USER_COLLECTION_ID, user.$id);
      usersDeleted += 1;
    } catch {
      console.error(`  failed to delete user document ${user.$id}`);
      failed += 1;
    }
    if (!authId) continue;
    try {
      await userService.delete(authId);
      authDeleted += 1;
    } catch {
      // The auth account may already be gone, or the key may lack the scope.
      // Neither is fatal: the document is what the migration reads.
      console.error(`  could not delete auth account for ${user.$id}`);
    }
  }

  console.log(
    [
      "",
      `transactions deleted    ${transfersDeleted}`,
      `bank documents deleted  ${banksDeleted}`,
      `user documents deleted  ${usersDeleted}`,
      `auth accounts deleted   ${authDeleted}`,
      `failures                ${failed}`,
      "",
      "Dwolla customers and Plaid Items created by those runs are NOT removed.",
      "Dwolla customers cannot be deleted, only deactivated.",
      "────────────────────────────────────────────────────────────────",
    ].join("\n")
  );

  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `Cleanup failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    process.exitCode = 1;
  });
