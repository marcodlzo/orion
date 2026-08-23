'use server';

// Every export in this module is a publicly callable POST endpoint. Only
// functions genuinely invoked from a client component belong here.
//
// getUserInfo, createBankAccount and getBanks were never called from the
// browser and now live in lib/server/users.ts. createSessionClient and
// createAdminClient are no longer actions at all — lib/appwrite.ts is
// server-only.
//
// AUTHENTICATION vs AUTHORIZATION
//
// Every action below except signIn and signUp now resolves the caller from the
// session via requireActor() before doing any privileged work. That answers
// "who is calling?".
//
// It does NOT answer "may this caller touch this record?". getBank,
// getBankByAccountId, createTransaction and createTransfer still accept
// client-supplied resource identifiers and do not check ownership, so an
// authenticated user can still reach another user's data. Closing that is the
// repository/ownership phase. Do not read the presence of requireActor() here
// as evidence that these endpoints are safe.

import { ID, Query } from "node-appwrite";
import { createAdminClient, createSessionClient } from "../appwrite";
import { cookies } from "next/headers";
import { encryptId, extractCustomerIdFromUrl, parseStringify } from "../utils";
import { CountryCode, ProcessorTokenCreateRequest, ProcessorTokenCreateRequestProcessorEnum, Products } from "plaid";

import { plaidClient } from '@/lib/plaid';
import { revalidatePath } from "next/cache";
import { addFundingSource, createDwollaCustomer } from "../server/dwolla";
import { createBankAccount, getUserInfo } from "../server/users";
import { requireActor, SESSION_COOKIE } from "../auth/actor";
import { isUnauthenticated } from "../auth/errors";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

export const signIn = async ({ email, password }: signInProps) => {
  try {
    const { account } = await createAdminClient();
    const session = await account.createEmailPasswordSession(email, password);

    cookies().set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });

    const user = await getUserInfo({ userId: session.userId }) 

    return parseStringify(user);
  } catch (error) {
    console.error('Error', error);
  }
}

export const signUp = async ({ password, ...userData }: SignUpParams) => {
  const { email, firstName, lastName } = userData;
  
  let newUserAccount;

  try {
    const { account, database } = await createAdminClient();

    newUserAccount = await account.create(
      ID.unique(), 
      email, 
      password, 
      `${firstName} ${lastName}`
    );

    if(!newUserAccount) throw new Error('Error creating user')

    const dwollaCustomerUrl = await createDwollaCustomer({
      ...userData,
      type: 'personal'
    })

    if(!dwollaCustomerUrl) throw new Error('Error creating Dwolla customer')

    const dwollaCustomerId = extractCustomerIdFromUrl(dwollaCustomerUrl);

    const newUser = await database.createDocument(
      DATABASE_ID!,
      USER_COLLECTION_ID!,
      ID.unique(),
      {
        ...userData,
        userId: newUserAccount.$id,
        dwollaCustomerId,
        dwollaCustomerUrl
      }
    )

    const session = await account.createEmailPasswordSession(email, password);

    cookies().set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });

    return parseStringify(newUser);
  } catch (error) {
    console.error('Error', error);
  }
}

/**
 * PROTECTED — the "who am I?" probe.
 *
 * Identity comes only from the session; it accepts no parameters and never did.
 * Returning null when unauthenticated is preserved deliberately: the layout
 * relies on it to redirect to /sign-in, and turning that into a throw would
 * replace a redirect with a crash.
 *
 * An INFRASTRUCTURE failure is now rethrown rather than flattened to null. A
 * datastore outage previously looked identical to "logged out", which sent
 * users to a login screen that could not work either.
 *
 * DEFECT (not fixed here): the response is still the raw user document, so it
 * carries ssn, dateOfBirth and address. That is the DTO phase.
 */
export async function getLoggedInUser() {
  try {
    const actor = await requireActor();
    const user = await getUserInfo({ userId: actor.authId });

    return parseStringify(user);
  } catch (error) {
    if (isUnauthenticated(error)) return null;
    throw error;
  }
}

/**
 * PROTECTED — accepts no identity; acts on the current session only.
 *
 * Ordering fixed: the server-side Appwrite session is revoked BEFORE the cookie
 * is cleared. Previously the cookie was deleted first, so a failure in
 * deleteSession left a live server session while the browser believed it had
 * logged out. Fixed here because it is one statement inside the path this phase
 * already touches.
 *
 * DEFECT (not fixed here): this resolves undefined on success, so the caller's
 * `if (loggedOut) router.push('/sign-in')` never runs and the user is not
 * navigated away. That is a client-side contract change, out of scope for an
 * authentication phase; tracked separately.
 */
export const logoutAccount = async () => {
  try {
    await requireActor();

    const { account } = await createSessionClient();
    await account.deleteSession('current');

    cookies().delete(SESSION_COOKIE);
  } catch (error) {
    return null;
  }
}

/**
 * PROTECTED — no longer accepts a caller-supplied user object.
 *
 * The Plaid link token is now minted for the session's own identity. Previously
 * the browser chose whose id it was issued against.
 *
 * client_name is a display string shown inside Plaid Link, so the profile is
 * read explicitly here rather than being carried on the Actor.
 */
export const createLinkToken = async () => {
  try {
    const actor = await requireActor();
    const user = await getUserInfo({ userId: actor.authId });

    const tokenParams = {
      user: {
        client_user_id: actor.userId
      },
      client_name: `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Orion Banking',
      products: ['auth'] as Products[],
      language: 'en',
      country_codes: ['US'] as CountryCode[],
    }

    const response = await plaidClient.linkTokenCreate(tokenParams);

    return parseStringify({ linkToken: response.data.link_token })
  } catch (error) {
    console.log(error);
  }
}

/**
 * PROTECTED — no longer accepts a caller-supplied user object.
 *
 * Previously the browser sent the entire user document and this action trusted
 * `user.dwollaCustomerId` and `user.$id`. That let a caller attach a bank as a
 * funding source on someone else's Dwolla customer, or file a bank under
 * another user's id. Both identifiers now come from the session.
 *
 * DEFECT (not fixed here): only accountsResponse.data.accounts[0] is used, so
 * every other account on the Plaid Item is silently discarded.
 */
export const exchangePublicToken = async ({
  publicToken,
}: exchangePublicTokenProps) => {
  try {
    const actor = await requireActor();

    // Exchange public token for access token and item ID
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;
    
    // Get account information from Plaid using the access token
    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountData = accountsResponse.data.accounts[0];

    // Create a processor token for Dwolla using the access token and account ID
    const request: ProcessorTokenCreateRequest = {
      access_token: accessToken,
      account_id: accountData.account_id,
      processor: "dwolla" as ProcessorTokenCreateRequestProcessorEnum,
    };

    const processorTokenResponse = await plaidClient.processorTokenCreate(request);
    const processorToken = processorTokenResponse.data.processor_token;

     // Create a funding source URL for the account using the Dwolla customer ID, processor token, and bank name
     const fundingSourceUrl = await addFundingSource({
      dwollaCustomerId: actor.dwollaCustomerId,
      processorToken,
      bankName: accountData.name,
    });
    
    // If the funding source URL is not created, throw an error
    if (!fundingSourceUrl) throw Error;

    // Create a bank account using the user ID, item ID, account ID, access token, funding source URL, and shareableId ID
    await createBankAccount({
      userId: actor.userId,
      bankId: itemId,
      accountId: accountData.account_id,
      accessToken,
      fundingSourceUrl,
      shareableId: encryptId(accountData.account_id),
    });

    // Revalidate the path to reflect the changes
    revalidatePath("/");

    // Return a success message
    return parseStringify({
      publicTokenExchange: "complete",
    });
  } catch (error) {
    console.error("An error occurred while creating exchanging token:", error);
  }
}

/**
 * PROTECTED — authenticated, NOT yet authorized.
 *
 * requireActor() now runs before the admin client is touched, so an anonymous
 * caller can no longer read bank documents. The actor is deliberately unused
 * below: `documentId` is a RESOURCE identifier, not an identity claim, and
 * filtering the query by the actor is the repository/ownership phase.
 *
 * STILL VULNERABLE: any authenticated user may pass any other user's bank
 * document id and receive it, including the Plaid access token and the Dwolla
 * funding-source URL.
 */
export const getBank = async ({ documentId }: getBankProps) => {
  try {
    await requireActor();

    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('$id', [documentId])]
    )

    return parseStringify(bank.documents[0]);
  } catch (error) {
    console.log(error)
  }
}

/**
 * PROTECTED — authenticated, NOT yet authorized.
 *
 * STILL VULNERABLE: `accountId` is decoded from a "shareable id" that is only
 * base64, so any authenticated user can decode a counterparty's id and receive
 * that bank's full document, credentials included. Ownership/counterparty
 * scoping is the repository phase.
 */
export const getBankByAccountId = async ({ accountId }: getBankByAccountIdProps) => {
  try {
    await requireActor();

    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('accountId', [accountId])]
    )

    if(bank.total !== 1) return null;

    return parseStringify(bank.documents[0]);
  } catch (error) {
    console.log(error)
  }
}