// Server-only. Reads Plaid using stored access tokens and returns raw provider
// data. None of these are called from a client component — they are consumed by
// server components and by other server modules — so none needs to be a
// publicly callable server action.
import "server-only";

import { CountryCode } from "plaid";

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
  toTransactionDTOFromSync,
  toTransactionDTOFromRecord,
} from "../dto/transaction.dto";
import { collectChanges, foldChanges } from "../plaid-sync/engine";
import { plaidErrorCode, toSyncPage } from "../plaid-sync/adapter";

/**
 * How many pages a RENDER may walk.
 *
 * Not a correctness bound — the engine's cursor guard provides that. This is a
 * blast radius: a page render that walks an item's entire history is a slow page
 * at best and a timeout at worst, and the honest fix is the background sync, not
 * a bigger number here.
 */
const RENDER_PATH_PAGE_LIMIT = 5;

/**
 * OWNED — every account belonging to the authenticated actor.
 *
 * Previously took a userId, which server components passed from the session
 * anyway, but which made the function look like a general "accounts for any
 * user" query. It now derives identity itself, so there is no parameter to
 * get wrong.
 */
export const getAccounts = async () => {
  try {
    const actor = await requireActor();
    const banks = await getOwnedBanks(actor);

    const accounts = await Promise.all(
      banks?.map(async (bank) => {
        // get each account info from plaid
        const accountsResponse = await plaidClient.accountsGet({
          access_token: bank.accessToken,
        });
        const accountData = accountsResponse.data.accounts[0];

        // The bank record holds accessToken and fundingSourceUrl. It is passed
        // to the mapper rather than spread, so neither can ride along.
        return toAccountSummaryDTO({ plaidAccount: accountData, bank });
      })
    );

    const totalBanks = accounts.length;
    const totalCurrentBalance = accounts.reduce((total, account) => {
      return total + account.currentBalance;
    }, 0);

    return parseStringify({ data: accounts, totalBanks, totalCurrentBalance });
  } catch (error) {
    console.error("An error occurred while getting the accounts:", error);
  }
};

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

    // get account info from plaid
    const accountsResponse = await plaidClient.accountsGet({
      access_token: bank.accessToken,
    });
    const accountData = accountsResponse.data.accounts[0];

    // get transfer transactions from appwrite
    // Ownership was proven above; this reads that bank's history.
    const transferTransactionsData = await getTransactionsForOwnedBank(
      actor,
      bank.$id
    );

    const transferTransactions = transferTransactionsData.documents.map(
      (transferData) =>
        toTransactionDTOFromRecord(
          transferData,
          transferData.senderBankId === bank.$id ? "debit" : "credit"
        )
    );

    const transactions = await getTransactions({
      accessToken: bank.accessToken,
    });

    const account = toAccountSummaryDTO({ plaidAccount: accountData, bank });

    // sort transactions by date such that the most recent transaction is first
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

/**
 * Plaid transactions for one access token, for display.
 *
 * WHAT THIS USED TO BE, and why it could not work:
 *
 *   while (hasMore) {
 *     const response = await plaidClient.transactionsSync({ access_token });
 *     transactions = response.data.added.map(...);   // overwrote each page
 *     hasMore = data.has_more;                       // cursor never advanced
 *   }
 *
 * No cursor was sent, so Plaid returned the same first page every time and
 * `has_more` never became false — an infinite loop against a paid API. And each
 * pass ASSIGNED rather than accumulated, so even a terminating version would
 * have kept only the last page. `modified` and `removed` were ignored entirely.
 *
 * It now walks pages through the shared engine: the cursor advances, pages
 * accumulate, an unchanged cursor aborts, and the walk is bounded.
 *
 * STILL ON THE RENDER PATH, AND STILL WRONG FOR THAT REASON. This starts from no
 * cursor on every call, so it re-fetches an item's whole history during SSR. The
 * cursor-persisting sync that fixes this properly lives in `lib/plaid-sync/` and
 * runs outside any request; wiring the UI to read from that store is the UI
 * rebuild's job. Do not add callers, and do not "optimise" this by persisting a
 * cursor here — a render path must not advance sync state.
 */
export const getTransactions = async ({
  accessToken,
}: getTransactionsProps) => {
  try {
    const changes = await collectChanges(
      async (cursor) => {
        const response = await plaidClient.transactionsSync(
          cursor === null
            ? { access_token: accessToken }
            : { access_token: accessToken, cursor }
        );
        return toSyncPage(response.data as unknown as Record<string, unknown>);
      },
      null,
      // A display read has no business walking a decade of history during a
      // page render. Bounded far below the engine's own ceiling.
      { maxPages: RENDER_PATH_PAGE_LIMIT }
    );

    const { upserts } = foldChanges(changes);

    // Mapped to the display DTO. Retracted transactions are already excluded by
    // the fold, so a removal in a later page cannot resurface here.
    return parseStringify(upserts.map(toTransactionDTOFromSync));
  } catch (error) {
    // The code, never the provider error: a Plaid error echoes the request, and
    // the request carries the access token.
    console.error(
      "An error occurred while getting transactions:",
      plaidErrorCode(error) ?? "UNKNOWN"
    );
  }
};
