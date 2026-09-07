import "server-only";

import type { Actor } from "../auth/actor";
import { InfrastructureError } from "../auth/errors";
import { createBankForActor, getOwnedBankByAccountId } from "../repositories/banks.repository";
import { withTransaction } from "../db/pool";
import { ensureBankingCustomer } from "../db/repositories/banking-customers.repository";
import { upsertLinkedAccount } from "../db/repositories/linked-accounts.repository";

type BankInput = Parameters<typeof createBankForActor>[1];
export type LinkedAccountMetadata = {
  displayName: string;
  officialName: string | null;
  mask: string | null;
  accountType: string;
  accountSubtype: string | null;
  currency: string | null;
};

/** Both identities come from the session; metadata comes from accountsGet.
 * Appwrite and PostgreSQL cannot share a transaction. A failed mirror is
 * reported, and retry reuses the owned document to repair the missing bridge.
 * No credential is copied into PostgreSQL.
 */
export async function linkBankForActor(actor: Actor, input: BankInput, metadata: LinkedAccountMetadata) {
  if (metadata.currency !== "USD" || metadata.accountType !== "depository") {
    throw new InfrastructureError("Only USD depository accounts can be linked");
  }
  const existing = await getOwnedBankByAccountId(actor, input.accountId);
  if (existing && existing.bankId !== input.bankId) {
    throw new InfrastructureError("The existing account belongs to a different Item");
  }
  const bank = existing ?? await createBankForActor(actor, input);
  try {
    await withTransaction(async (client) => {
      const { row: customer } = await ensureBankingCustomer({
        appwriteAuthId: actor.authId,
        appwriteUserDocumentId: actor.userId,
      }, client);
      await upsertLinkedAccount({
        customerId: customer.id,
        legacyAppwriteBankDocumentId: bank.$id,
        externalAccountId: bank.accountId,
        provider: "plaid",
        ...metadata,
        currency: "USD",
        metadataKnown: true,
      }, client);
    });
  } catch {
    // Do not expose driver errors, which can contain the offending row.
    throw new InfrastructureError("Bank linked, but its banking record could not be saved");
  }
  return bank;
}
