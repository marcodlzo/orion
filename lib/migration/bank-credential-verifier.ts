// Server-only. Independent read-only verifier for the credential cutover.
import "server-only";

import { credentialsMatch, decryptCredential, isEncrypted } from "../crypto/envelope";
import { withLockedSnapshot } from "../db/pool";
import { readAllLegacyBanksAsStored } from "./appwrite-source";
import { MIGRATION_LOCK_KEY } from "./lock";

export async function verifyBankCredentialCutover(): Promise<{ checked: number }> {
  const source = await readAllLegacyBanksAsStored();
  return withLockedSnapshot(MIGRATION_LOCK_KEY, async (client) => {
    let checked = 0;
    for (const bank of source.documents) {
      const { rows } = await client.query<{
        credential_id: string; access_token: string; funding_source_url: string;
        provider_item_id: string | null; shareable_id: string | null;
      }>(
        `SELECT k.id AS credential_id, k.access_token, k.funding_source_url,
                a.provider_item_id, a.shareable_id
           FROM linked_accounts a
           JOIN linked_account_credentials k ON k.linked_account_id = a.id
          WHERE a.legacy_appwrite_bank_document_id = $1`,
        [bank.$id]
      );
      const row = rows[0];
      if (!row) throw new Error(`Missing credential target for legacy bank ${bank.$id}`);
      if (row.provider_item_id !== bank.bankId || row.shareable_id !== bank.shareableId) {
        throw new Error(`Metadata verification failed for legacy bank ${bank.$id}`);
      }
      const compare = (field: "accessToken" | "fundingSourceUrl", target: string) => {
        const legacy = bank[field];
        if (typeof legacy !== "string" || !isEncrypted(legacy)) throw new Error(`Unreadable legacy ${bank.$id}.${field}`);
        const oldPlain = decryptCredential(legacy, { recordId: bank.$id, field });
        const newPlain = decryptCredential(target, { recordId: row.credential_id, field });
        if (!credentialsMatch(oldPlain, newPlain)) throw new Error(`Credential mismatch for legacy bank ${bank.$id}.${field}`);
      };
      compare("accessToken", row.access_token);
      compare("fundingSourceUrl", row.funding_source_url);
      checked += 1;
    }
    return { checked };
  });
}
