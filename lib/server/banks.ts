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

        // get institution info from plaid
        const institution = await getInstitution({
          institutionId: accountsResponse.data.item.institution_id!,
        });

        const account = {
          id: accountData.account_id,
          availableBalance: accountData.balances.available!,
          currentBalance: accountData.balances.current!,
          institutionId: institution.institution_id,
          name: accountData.name,
          officialName: accountData.official_name,
          mask: accountData.mask!,
          type: accountData.type as string,
          subtype: accountData.subtype! as string,
          appwriteItemId: bank.$id,
          shareableId: bank.shareableId,
        };

        return account;
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
      (transferData) => ({
        id: transferData.$id,
        name: transferData.name!,
        amount: transferData.amount!,
        date: transferData.$createdAt,
        paymentChannel: transferData.channel,
        category: transferData.category,
        type: transferData.senderBankId === bank.$id ? "debit" : "credit",
      })
    );

    // get institution info from plaid
    const institution = await getInstitution({
      institutionId: accountsResponse.data.item.institution_id!,
    });

    const transactions = await getTransactions({
      accessToken: bank?.accessToken,
    });

    const account = {
      id: accountData.account_id,
      availableBalance: accountData.balances.available!,
      currentBalance: accountData.balances.current!,
      institutionId: institution.institution_id,
      name: accountData.name,
      officialName: accountData.official_name,
      mask: accountData.mask!,
      type: accountData.type as string,
      subtype: accountData.subtype! as string,
      appwriteItemId: bank.$id,
    };

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

// Get bank info
export const getInstitution = async ({
  institutionId,
}: getInstitutionProps) => {
  try {
    const institutionResponse = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: ["US"] as CountryCode[],
    });

    const intitution = institutionResponse.data.institution;

    return parseStringify(intitution);
  } catch (error) {
    console.error("An error occurred while getting the accounts:", error);
  }
};

// Get transactions
export const getTransactions = async ({
  accessToken,
}: getTransactionsProps) => {
  let hasMore = true;
  let transactions: any = [];

  try {
    // Iterate through each page of new transaction updates for item
    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
      });

      const data = response.data;

      transactions = response.data.added.map((transaction) => ({
        id: transaction.transaction_id,
        name: transaction.name,
        paymentChannel: transaction.payment_channel,
        type: transaction.payment_channel,
        accountId: transaction.account_id,
        amount: transaction.amount,
        pending: transaction.pending,
        category: transaction.category ? transaction.category[0] : "",
        date: transaction.date,
        image: transaction.logo_url,
      }));

      hasMore = data.has_more;
    }

    return parseStringify(transactions);
  } catch (error) {
    console.error("An error occurred while getting the accounts:", error);
  }
};