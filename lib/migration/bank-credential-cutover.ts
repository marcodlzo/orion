// Server-only. Operator-only Appwrite-to-PostgreSQL credential re-encryption.
import "server-only";

import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool";
import {
  credentialsMatch,
  decryptCredential,
  encryptCredential,
  isEncrypted,
} from "../crypto/envelope";
import { readAllLegacyBanksAsStored } from "./appwrite-source";

export type BankCredentialCutoverReport = {
  committed: boolean;
  scanned: number;
  migrated: number;
  verifiedExisting: number;
};

class DryRunRollback extends Error {
  constructor(readonly report: BankCredentialCutoverReport) { super("dry run rollback"); }
}

export async function migrateBankCredentials(
  options: { commit?: boolean } = {}
): Promise<BankCredentialCutoverReport> {
  const source = await readAllLegacyBanksAsStored();
  if (source.scanned !== source.reportedTotal) throw new Error("Legacy bank scan was incomplete");

  try {
    return await withTransaction(async (client) => {
      let migrated = 0;
      let verifiedExisting = 0;

      for (const bank of source.documents) {
        const linked = await client.query<{ id: string }>(
          "SELECT id FROM linked_accounts WHERE legacy_appwrite_bank_document_id = $1",
          [bank.$id]
        );
        if (!linked.rows[0]) throw new Error(`No linked account for legacy bank ${bank.$id}`);

        const readLegacy = (field: "accessToken" | "fundingSourceUrl") => {
          const value = bank[field];
          if (typeof value !== "string" || !isEncrypted(value)) {
            throw new Error(`Legacy bank ${bank.$id}.${field} is not encrypted`);
          }
          return decryptCredential(value, { recordId: bank.$id, field });
        };
        const accessToken = readLegacy("accessToken");
        const fundingSourceUrl = readLegacy("fundingSourceUrl");

        const existing = await client.query<{
          id: string; access_token: string; funding_source_url: string;
        }>(
          "SELECT id, access_token, funding_source_url FROM linked_account_credentials WHERE linked_account_id = $1",
          [linked.rows[0].id]
        );

        if (existing.rows[0]) {
          const row = existing.rows[0];
          const storedAccess = decryptCredential(row.access_token, { recordId: row.id, field: "accessToken" });
          const storedFunding = decryptCredential(row.funding_source_url, { recordId: row.id, field: "fundingSourceUrl" });
          if (!credentialsMatch(storedAccess, accessToken) || !credentialsMatch(storedFunding, fundingSourceUrl)) {
            throw new Error(`Credential verification failed for legacy bank ${bank.$id}`);
          }
          verifiedExisting += 1;
        } else {
          const credentialId = randomUUID();
          const encryptedAccess = encryptCredential(accessToken, { recordId: credentialId, field: "accessToken" });
          const encryptedFunding = encryptCredential(fundingSourceUrl, { recordId: credentialId, field: "fundingSourceUrl" });
          if (!credentialsMatch(decryptCredential(encryptedAccess, { recordId: credentialId, field: "accessToken" }), accessToken) ||
              !credentialsMatch(decryptCredential(encryptedFunding, { recordId: credentialId, field: "fundingSourceUrl" }), fundingSourceUrl)) {
            throw new Error(`Credential round trip failed for legacy bank ${bank.$id}`);
          }
          await client.query(
            `INSERT INTO linked_account_credentials
               (id, linked_account_id, access_token, funding_source_url)
             VALUES ($1, $2, $3, $4)`,
            [credentialId, linked.rows[0].id, encryptedAccess, encryptedFunding]
          );
          migrated += 1;
        }

        await client.query(
          `UPDATE linked_accounts
              SET provider_item_id = $2, shareable_id = $3
            WHERE id = $1`,
          [linked.rows[0].id, bank.bankId, bank.shareableId]
        );
      }

      const report = { committed: options.commit === true, scanned: source.scanned, migrated, verifiedExisting };
      if (!options.commit) throw new DryRunRollback(report);
      return report;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}
