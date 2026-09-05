// Server-only. Reads Plaid using stored access tokens and returns raw provider
// data. None of these are called from a client component — they are consumed by
// server components and by other server modules — so none needs to be a
// publicly callable server action.
import "server-only";

import { cache } from "react";

import { plaidClient } from "../plaid";
import { parseStringify } from "../utils";

import { requireActor } from "../auth/actor";
import {
  getOwnedBankByDocumentId,
  getOwnedBanks,
} from "../repositories/banks.repository";
import { NotFoundError } from "../repositories/errors";
import { getTransactionsForOwnedBank } from "../repositories/transactions.repository";
import { toAccountSummaryDTO } from "../dto/bank.dto";
import {
  toTransactionDTOFromStore,
  toTransactionDTOFromRecord,
} from "../dto/transaction.dto";
// THE READ half of the Plaid store. The writer — which advances a cursor — is
// deliberately unreachable from here; an architecture test enforces the split.
import { listTransactionsForOwnedAccounts } from "../db/repositories/plaid-transactions.read";

// An Item can back several bank records. Share its complete response across
// list and detail readers using the same decrypted token, never across renders.
// Only call this after a repository has established the actor's ownership.
const getPlaidAccounts = cache(async (accessToken: string) => {
  const response = await plaidClient.accountsGet({ access_token: accessToken });
  return response.data.accounts;
});

/**
 * OWNED — every account belonging to the authenticated actor.
 *
 * Previously took a userId, which server components passed from the session
 * anyway, but which made the function look like a general "accounts for any
 * user" query. It now derives identity itself, so there is no parameter to
 * get wrong.
 */
export const getAccounts = cache(async () => {
  try {
    const actor = await requireActor();
    const banks = await getOwnedBanks(actor);

    const accounts = await Promise.all(
      banks?.map(async (bank) => {
        // get each account info from plaid
        const plaidAccounts = await getPlaidAccounts(bank.accessToken);

        // THE ACCOUNT THIS BANK RECORD IS FOR, not accounts[0]. An Item owns
        // many accounts, and taking the first one showed the wrong balance
        // against every linked account but one — silently, because the shape
        // was always valid.
        const accountData =
          plaidAccounts.find(
            (a) => a.account_id === bank.accountId
          ) ?? null;

        if (!accountData) return null;

        // The bank record holds accessToken and fundingSourceUrl. It is passed
        // to the mapper rather than spread, so neither can ride along.
        return toAccountSummaryDTO({ plaidAccount: accountData, bank });
      })
    );

    // An account Plaid no longer reports is dropped rather than rendered as a
    // zero balance, which would look like an emptied account.
    const found = accounts.filter(
      (account): account is NonNullable<typeof account> => account !== null
    );

    const totalBanks = found.length;

    // SUMMED IN INTEGER MINOR UNITS. This was a float sum across accounts, so
    // the representation error compounded once per linked account.
    const totalCurrentBalanceMinor = found.reduce(
      (total, account) => total + account.currentBalanceMinor,
      0
    );

    return parseStringify({
      data: found,
      totalBanks,
      totalCurrentBalanceMinor,
    });
  } catch (error) {
    console.error("An error occurred while getting the accounts:", error);
  }
});

/**
 * OWNED — one account belonging to the actor.
 *
 * `appwriteItemId` reaches this from a URL query parameter, so it is fully
 * caller-controlled. It is now resolved through an ownership-scoped query: a
 * bank the actor does not own is never loaded, and the request fails as
 * NotFound rather than returning another user's balances and history.
 */
export const getAccount = async ({ appwriteItemId }: getAccountProps) => {
  try {
    const actor = await requireActor();

    const bank = await getOwnedBankByDocumentId(actor, appwriteItemId);
    if (!bank) throw new NotFoundError("Bank not found");

    // Ownership is proven before starting any provider or history read. The
    // balances and the two history sources are independent and can overlap.
    // The transaction repository still performs its own ownership check,
    // deduplicated by the repository's per-render memo.
    const [plaidAccounts, transferTransactionsData, storedRows] = await Promise.all([
      getPlaidAccounts(bank.accessToken),
      getTransactionsForOwnedBank(actor, bank.$id),
      listTransactionsForOwnedAccounts([bank.accountId]),
    ]);

    // The account this bank record names, not accounts[0].
    const accountData = plaidAccounts.find(
      (a) => a.account_id === bank.accountId
    );
    if (!accountData) throw new NotFoundError("Account not found");

    const transferTransactions = transferTransactionsData.documents.map(
      (transferData) =>
        toTransactionDTOFromRecord(
          transferData,
          transferData.senderBankId === bank.$id ? "debit" : "credit"
        )
    );

    // FROM THE SYNCED STORE, NOT FROM PLAID. This used to call transactionsSync
    // during SSR — a page render driving provider sync, re-walking an item's
    // whole history every time somebody loaded the page.
    //
    // OWNERSHIP WAS PROVEN ABOVE. `bank.accountId` came from a document the
    // ownership-scoped query returned for THIS actor, so it is the one account
    // id it is safe to read by. Passing the URL parameter through instead would
    // be an IDOR.
    const transactions = storedRows.map(toTransactionDTOFromStore);

    const account = toAccountSummaryDTO({ plaidAccount: accountData, bank });

    const allTransactions = [...transactions, ...transferTransactions].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return parseStringify({
      data: account,
      transactions: allTransactions,
    });
  } catch (error) {
    console.error("An error occurred while getting the account:", error);
  }
};
