'use server';

// Every export in this module is a publicly callable POST endpoint.
//
// AUTHENTICATION is enforced: every action except signIn and signUp resolves
// the caller from the session before any privileged work.
//
// AUTHORIZATION is now enforced for the actor's OWN resources: owned reads go
// through actor-scoped repository methods, and the ownership predicate is part
// of the datastore query rather than a comparison performed afterwards.
//
// NOT yet fixed here:
//  - responses are still raw documents, so PII and provider credentials still
//    cross to the browser (DTO phase)
//  - getBankByAccountId is a counterparty lookup and is deliberately not
//    ownership scoped (see its comment)
//  - createTransfer still accepts funding-source URLs from the browser
//    (transfer-orchestration phase)

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  CountryCode,
  ProcessorTokenCreateRequest,
  ProcessorTokenCreateRequestProcessorEnum,
  Products,
} from "plaid";

import { createSessionClient } from "../appwrite";
import { plaidClient } from '@/lib/plaid';
import { encryptId, extractCustomerIdFromUrl, parseStringify } from "../utils";
import { addFundingSource, createDwollaCustomer } from "../server/dwolla";
import { requireActor, SESSION_COOKIE } from "../auth/actor";
import { isUnauthenticated } from "../auth/errors";
import {
  createAuthAccount,
  createEmailPasswordSession,
} from "../repositories/accounts.repository";
import {
  createUserRecord,
  findUserByAuthId,
} from "../repositories/users.repository";
import {
  createBankForActor,
  findCounterpartyBankByAccountId,
  getOwnedBankByDocumentId,
} from "../repositories/banks.repository";
import { NotFoundError } from "../repositories/errors";

/** PUBLIC AUTH ENTRY — requiring a session to sign in would be circular. */
export const signIn = async ({ email, password }: signInProps) => {
  try {
    const session = await createEmailPasswordSession(email, password);

    cookies().set(SESSION_COOKIE, session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });

    const user = await findUserByAuthId(session.userId);

    return parseStringify(user);
  } catch (error) {
    console.error('Error', error);
  }
}

/**
 * PUBLIC AUTH ENTRY — no account exists yet.
 *
 * DEFECT (not this phase): the three steps below are not a transaction. A
 * failure between them leaves an orphaned auth account, an orphaned Dwolla
 * customer, or an account with no internal record — the state
 * ActorNotProvisionedError exists to report.
 */
export const signUp = async ({ password, ...userData }: SignUpParams) => {
  const { email, firstName, lastName } = userData;

  try {
    const newUserAccount = await createAuthAccount({
      email,
      password,
      name: `${firstName} ${lastName}`,
    });

    if (!newUserAccount) throw new Error('Error creating user')

    const dwollaCustomerUrl = await createDwollaCustomer({
      ...userData,
      type: 'personal'
    })

    if (!dwollaCustomerUrl) throw new Error('Error creating Dwolla customer')

    const dwollaCustomerId = extractCustomerIdFromUrl(dwollaCustomerUrl);

    // DEFECT (not this phase): userData still carries ssn and dateOfBirth, and
    // both are persisted in plaintext.
    const newUser = await createUserRecord({
      ...userData,
      userId: newUserAccount.$id,
      dwollaCustomerId,
      dwollaCustomerUrl,
    });

    const session = await createEmailPasswordSession(email, password);

    cookies().set(SESSION_COOKIE, session.secret, {
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
 * Returning null when unauthenticated is preserved: the root layout relies on
 * it to redirect to /sign-in. An infrastructure failure is rethrown rather than
 * flattened to null, so an outage does not present as "logged out".
 *
 * DEFECT (not this phase): still returns the raw user document, so ssn,
 * dateOfBirth and address cross to the browser.
 */
export async function getLoggedInUser() {
  try {
    const actor = await requireActor();
    const user = await findUserByAuthId(actor.authId);

    return parseStringify(user);
  } catch (error) {
    if (isUnauthenticated(error)) return null;
    throw error;
  }
}

/**
 * PROTECTED — acts on the current session only; accepts no identity.
 *
 * The server-side session is revoked BEFORE the cookie is cleared, so a failure
 * cannot leave a live server session while the browser believes it logged out.
 *
 * DEFECT (not this phase): resolves undefined on success, so the caller's
 * `if (loggedOut) router.push('/sign-in')` never runs.
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

/** PROTECTED — the link token is minted for the session's identity. */
export const createLinkToken = async () => {
  try {
    const actor = await requireActor();
    const user = await findUserByAuthId(actor.authId);

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
 * PROTECTED — the linked bank is filed against the session's identity.
 *
 * The owner is no longer supplied by the caller, so a bank cannot be filed
 * under another user, and the funding source is attached to the actor's own
 * Dwolla customer.
 *
 * DEFECT (not this phase): only accounts[0] is used, so every other account on
 * the Plaid Item is discarded.
 */
export const exchangePublicToken = async ({
  publicToken,
}: exchangePublicTokenProps) => {
  try {
    const actor = await requireActor();

    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountData = accountsResponse.data.accounts[0];

    const request: ProcessorTokenCreateRequest = {
      access_token: accessToken,
      account_id: accountData.account_id,
      processor: "dwolla" as ProcessorTokenCreateRequestProcessorEnum,
    };

    const processorTokenResponse = await plaidClient.processorTokenCreate(request);
    const processorToken = processorTokenResponse.data.processor_token;

    const fundingSourceUrl = await addFundingSource({
      dwollaCustomerId: actor.dwollaCustomerId,
      processorToken,
      bankName: accountData.name,
    });

    if (!fundingSourceUrl) throw new Error("Failed to create a Dwolla funding source");

    await createBankForActor(actor, {
      bankId: itemId,
      accountId: accountData.account_id,
      accessToken,
      fundingSourceUrl,
      shareableId: encryptId(accountData.account_id),
    });

    revalidatePath("/");

    return parseStringify({
      publicTokenExchange: "complete",
    });
  } catch (error) {
    console.error("An error occurred while creating exchanging token:", error);
  }
}

/**
 * PROTECTED AND OWNERSHIP SCOPED.
 *
 * The query filters on document id AND owner together, so another user's bank
 * is never loaded. A record that does not exist and one that exists but is not
 * owned both raise NotFoundError, so this cannot be used to test whether a bank
 * id is real.
 *
 * Errors are no longer swallowed: a datastore outage surfaces as
 * InfrastructureError rather than as an indistinguishable undefined.
 *
 * DEFECT (not this phase): the response is the raw document, so the actor's own
 * access token and funding-source URL still reach the browser.
 */
export const getBank = async ({ documentId }: getBankProps) => {
  const actor = await requireActor();

  const bank = await getOwnedBankByDocumentId(actor, documentId);
  if (!bank) throw new NotFoundError("Bank not found");

  return parseStringify(bank);
}

/**
 * PROTECTED — COUNTERPARTY LOOKUP, deliberately NOT ownership scoped.
 *
 * This resolves a transfer RECIPIENT, which by definition is a bank the actor
 * does not own. Scoping it by ownership would break paying anybody.
 *
 * STILL VULNERABLE, and not fixable within this phase:
 *  - it returns the recipient's full record, including their Plaid access token
 *    and Dwolla funding-source URL. Narrowing the response is the DTO phase.
 *  - the caller supplies accountId, decoded from a "shareable id" that is only
 *    base64. Removing the browser's need to resolve a recipient at all is the
 *    transfer-orchestration phase.
 *
 * Returns null on no match or an ambiguous match, preserving prior behaviour.
 */
export const getBankByAccountId = async ({ accountId }: getBankByAccountIdProps) => {
  await requireActor();

  const bank = await findCounterpartyBankByAccountId(accountId);
  if (!bank) return null;

  return parseStringify(bank);
}
