import "server-only";

import type { Actor } from "../auth/actor";
import { InfrastructureError } from "../auth/errors";
import { createBankForActor, getOwnedBankByAccountId } from "../repositories/banks.repository";

type BankInput = Pick<Parameters<typeof createBankForActor>[1],
  "bankId" | "accountId" | "accessToken" | "fundingSourceUrl" | "shareableId">;
export type LinkedAccountMetadata = {
  displayName: string;
  officialName: string | null;
  mask: string | null;
  accountType: string;
  accountSubtype: string | null;
  currency: string | null;
};

/** Both identities come from the session; metadata comes from accountsGet. */
export async function linkBankForActor(actor: Actor, input: BankInput, metadata: LinkedAccountMetadata) {
  if (metadata.currency !== "USD" || metadata.accountType !== "depository") {
    throw new InfrastructureError("Only USD depository accounts can be linked");
  }
  const existing = await getOwnedBankByAccountId(actor, input.accountId);
  if (existing && existing.bankId !== input.bankId) {
    throw new InfrastructureError("The existing account belongs to a different Item");
  }
  if (existing) return existing;

  return createBankForActor(actor, {
    ...input,
    displayName: metadata.displayName,
    officialName: metadata.officialName,
    mask: metadata.mask,
    accountType: metadata.accountType,
    accountSubtype: metadata.accountSubtype,
  });
}
