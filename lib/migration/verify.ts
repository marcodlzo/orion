// Server-only. OPERATOR TOOLING. Reached only from scripts/.
import "server-only";

import {
  listBankingCustomers,
  type BankingCustomerRow,
} from "../db/repositories/banking-customers.repository";
import {
  listLinkedAccounts,
  type LinkedAccountRow,
} from "../db/repositories/linked-accounts.repository";
import {
  readAllLegacyBanks,
  readAllLegacyUsers,
  type LegacyBankDocument,
  type LegacyUserDocument,
  type SourceScan,
} from "./appwrite-source";
import { planMigration } from "./mapping";

export type Drift = {
  category:
    | "missing-customer"
    | "missing-account"
    | "orphan-customer"
    | "orphan-account"
    | "mismatched-customer"
    | "mismatched-account"
    | "unenriched-account"
    | "incomplete-source-scan";
  id: string;
  detail: string;
};

export type VerificationReport = {
  checkedAt: string;
  legacy: {
    users: number;
    banks: number;
    migratable: { customers: number; accounts: number };
    /** Pagination evidence. A verification over a short read proves nothing. */
    scan: {
      users: { scanned: number; reportedTotal: number; pages: number };
      banks: { scanned: number; reportedTotal: number; pages: number };
      complete: boolean;
    };
  };
  postgres: { customers: number; accounts: number };
  skippedBySource: number;
  drift: Drift[];
  ok: boolean;
};

export type VerifyDeps = {
  readUsers: () => Promise<SourceScan<LegacyUserDocument>>;
  readBanks: () => Promise<SourceScan<LegacyBankDocument>>;
  listCustomers: () => Promise<BankingCustomerRow[]>;
  listAccounts: () => Promise<LinkedAccountRow[]>;
};

export const defaultVerifyDeps: VerifyDeps = {
  readUsers: readAllLegacyUsers,
  readBanks: readAllLegacyBanks,
  listCustomers: listBankingCustomers,
  listAccounts: listLinkedAccounts,
};

/**
 * Compare the legacy dataset against PostgreSQL and report every difference.
 *
 * Deliberately independent of the backfill: it re-derives what SHOULD be there
 * from the source rather than trusting anything the backfill recorded. A
 * verifier that reuses the backfill's own bookkeeping can only confirm the
 * backfill agrees with itself.
 *
 * Read-only. It never repairs drift — deciding what a mismatch means is an
 * operator's judgement, and a tool that silently "fixes" financial data is how
 * a mistake becomes permanent.
 */
export async function verifyMigration(
  deps: VerifyDeps = defaultVerifyDeps
): Promise<VerificationReport> {
  const [userScan, bankScan, pgCustomers, pgAccounts] = await Promise.all([
    deps.readUsers(),
    deps.readBanks(),
    deps.listCustomers(),
    deps.listAccounts(),
  ]);

  const users = userScan.documents;
  const banks = bankScan.documents;
  const expected = planMigration(users, banks);
  const drift: Drift[] = [];

  // A comparison against a partial read is not a verification — every record
  // the walk missed would look like a PostgreSQL row with no source, i.e. an
  // orphan. Record it as drift so `ok` can never be true over a short read.
  for (const [label, scan] of [
    ["users", userScan],
    ["banks", bankScan],
  ] as const) {
    if (!scan.complete) {
      drift.push({
        category: "incomplete-source-scan",
        id: label,
        detail: `read ${scan.scanned} of ${scan.reportedTotal} documents across ${scan.pages} page(s)`,
      });
    }
  }

  // --- customers ----------------------------------------------------------
  const pgByAuthId = new Map(pgCustomers.map((c) => [c.appwrite_auth_id, c]));
  const expectedAuthIds = new Set(expected.customers.map((c) => c.appwriteAuthId));

  for (const customer of expected.customers) {
    const row = pgByAuthId.get(customer.appwriteAuthId);
    if (!row) {
      drift.push({
        category: "missing-customer",
        id: customer.appwriteUserDocumentId,
        detail: `auth ${customer.appwriteAuthId} has no PostgreSQL row`,
      });
      continue;
    }
    if (row.appwrite_user_document_id !== customer.appwriteUserDocumentId) {
      drift.push({
        category: "mismatched-customer",
        id: customer.appwriteAuthId,
        detail: `document id is ${row.appwrite_user_document_id}, source says ${customer.appwriteUserDocumentId}`,
      });
    }
  }

  for (const row of pgCustomers) {
    if (!expectedAuthIds.has(row.appwrite_auth_id)) {
      // A row with no live source. Usually a user deleted in Appwrite after the
      // backfill ran; never deleted automatically, because a customer with
      // financial history must not vanish on a tool's initiative.
      drift.push({
        category: "orphan-customer",
        id: row.id,
        detail: `auth ${row.appwrite_auth_id} has no source user document`,
      });
    }
  }

  // --- accounts -----------------------------------------------------------
  const customerIdByDocument = new Map(
    pgCustomers.map((c) => [c.appwrite_user_document_id, c.id])
  );
  const pgByNaturalKey = new Map(
    pgAccounts.map((a) => [`${a.customer_id}::${a.external_account_id}`, a])
  );
  const expectedKeys = new Set<string>();

  for (const account of expected.accounts) {
    const customerId = customerIdByDocument.get(account.ownerUserDocumentId);
    if (!customerId) {
      drift.push({
        category: "missing-account",
        id: account.legacyAppwriteBankDocumentId,
        detail: `owner ${account.ownerUserDocumentId} is not in PostgreSQL`,
      });
      continue;
    }

    const key = `${customerId}::${account.externalAccountId}`;
    expectedKeys.add(key);
    const row = pgByNaturalKey.get(key);

    if (!row) {
      drift.push({
        category: "missing-account",
        id: account.legacyAppwriteBankDocumentId,
        detail: `external account ${account.externalAccountId} has no PostgreSQL row`,
      });
      continue;
    }
    if (row.legacy_appwrite_bank_document_id !== account.legacyAppwriteBankDocumentId) {
      drift.push({
        category: "mismatched-account",
        id: account.legacyAppwriteBankDocumentId,
        detail: `row ${row.id} is bridged to ${row.legacy_appwrite_bank_document_id ?? "nothing"}`,
      });
    }
    if (row.display_name === "Linked account") {
      // Migrated with the fallback because the provider was unreachable. Not
      // corruption — a re-run fills it in — but it must be visible.
      drift.push({
        category: "unenriched-account",
        id: account.legacyAppwriteBankDocumentId,
        detail: "still has placeholder metadata; re-run the backfill",
      });
    }
  }

  for (const [key, row] of Array.from(pgByNaturalKey.entries())) {
    if (!expectedKeys.has(key)) {
      drift.push({
        category: "orphan-account",
        id: row.id,
        detail: `external account ${row.external_account_id} has no source bank document`,
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    legacy: {
      users: users.length,
      banks: banks.length,
      migratable: {
        customers: expected.customers.length,
        accounts: expected.accounts.length,
      },
      scan: {
        users: {
          scanned: userScan.scanned,
          reportedTotal: userScan.reportedTotal,
          pages: userScan.pages,
        },
        banks: {
          scanned: bankScan.scanned,
          reportedTotal: bankScan.reportedTotal,
          pages: bankScan.pages,
        },
        complete: userScan.complete && bankScan.complete,
      },
    },
    postgres: { customers: pgCustomers.length, accounts: pgAccounts.length },
    skippedBySource: expected.skipped.length,
    drift,
    ok: drift.length === 0,
  };
}
