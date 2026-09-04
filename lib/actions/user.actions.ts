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
// DATA MINIMISATION applies to the ordinary read paths: signIn, signUp and
// getLoggedInUser return an allowlisted CurrentUserDTO, and SSN and date of
// birth are no longer persisted at all.
//
// The two ForLegacyTransfer functions that used to live here are gone. Money
// movement is one action, lib/actions/transfer.actions.ts, and the browser no
// longer receives a funding-source URL or an access token by any path.

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
import {
  addFundingSource,
  createDwollaCustomer,
  describeDwollaError,
} from "../server/dwolla";
import { plaidErrorCode } from "../plaid-sync/adapter";
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
import { createBankForActor } from "../repositories/banks.repository";
import { toCurrentUserDTO } from "../dto/user.dto";

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

    return parseStringify(toCurrentUserDTO(user));
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

    // SSN and date of birth are request-scoped. Dwolla needed them above to
    // create the customer; nothing in this application reads them afterwards,
    // so they are never written to Appwrite. Named explicitly rather than
    // deleted from a spread, so a future field is excluded by default.
    const { ssn: _ssn, dateOfBirth: _dateOfBirth, ...persistable } = userData;
    void _ssn;
    void _dateOfBirth;

    const newUser = await createUserRecord({
      ...persistable,
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

    return parseStringify(toCurrentUserDTO(newUser));
  } catch (error) {
    // Never log the signup payload: it holds the SSN and date of birth.
    console.error('Sign-up failed');
  }
}

/**
 * PROTECTED — the "who am I?" probe.
 *
 * Returning null when unauthenticated is preserved: the root layout relies on
 * it to redirect to /sign-in. An infrastructure failure is rethrown rather than
 * flattened to null, so an outage does not present as "logged out".
 *
 * Returns an allowlisted CurrentUserDTO. The raw document is never serialized.
 */
export async function getLoggedInUser() {
  try {
    const actor = await requireActor();
    const user = await findUserByAuthId(actor.authId);

    return parseStringify(toCurrentUserDTO(user));
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
 * EVERY DEPOSITORY ACCOUNT ON THE ITEM IS LINKED, not `accounts[0]`.
 *
 * The tutorial took the first account and discarded the rest, so a user linking
 * a bank with a chequing and a savings account silently got one of them — and
 * which one depended on Plaid's ordering. Every account now gets its own funding
 * source and its own bank record, which is what the schema already modelled: a
 * bank document carries an `accountId`.
 *
 * FILTERED TO DEPOSITORY. A credit card or a loan appears in the same response
 * and cannot fund an ACH transfer; asking Dwolla for a funding source on one
 * fails, and doing it inside the loop would abandon the accounts that came
 * after. Non-depository accounts are skipped deliberately, not by accident.
 *
 * PARTIAL SUCCESS IS REPORTED, NOT SWALLOWED. If one account's funding source
 * fails, the others are still linked and the result says how many succeeded. The
 * alternative — failing the whole link — would make one unsupported account
 * block a user's entire bank.
 */
export const exchangePublicToken = async ({
  publicToken,
}: exchangePublicTokenProps) => {
  // A START LINE, so "never called" is distinguishable from "called and
  // failed". Without it a link that never reached onSuccess and a link that
  // threw look identical from the outside: no bank, no error, no clue.
  console.log("Linking a bank: exchanging the public token");

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

    // Depository only: these are the accounts ACH can draw on. The rest are
    // reported as skipped rather than silently dropped.
    const linkable = accountsResponse.data.accounts.filter(
      (account) => account.type === "depository"
    );

    if (linkable.length === 0) {
      throw new Error("This bank has no accounts that can send or receive money");
    }

    let linked = 0;
    const failed: string[] = [];

    for (const accountData of linkable) {
      try {
        const request: ProcessorTokenCreateRequest = {
          access_token: accessToken,
          account_id: accountData.account_id,
          processor: "dwolla" as ProcessorTokenCreateRequestProcessorEnum,
        };

        const processorTokenResponse =
          await plaidClient.processorTokenCreate(request);
        const processorToken = processorTokenResponse.data.processor_token;

        const fundingSourceUrl = await addFundingSource({
          dwollaCustomerId: actor.dwollaCustomerId,
          processorToken,
          // Distinct per account, so a user with two accounts at one bank can
          // tell them apart in Dwolla.
          bankName: `${accountData.name} ${accountData.mask ?? ""}`.trim(),
        });

        if (!fundingSourceUrl) {
          throw new Error("Failed to create a Dwolla funding source");
        }

        await createBankForActor(actor, {
          bankId: itemId,
          accountId: accountData.account_id,
          accessToken,
          fundingSourceUrl,
          shareableId: encryptId(accountData.account_id),
        });

        linked += 1;
      } catch (error) {
        // The ACCOUNT ID, never the error: a Plaid or Dwolla error echoes the
        // request, and the request carries the access token and the processor
        // token.
        // THE ACCOUNT ID AND A SAFE DESCRIPTION. The id alone was not enough to
        // diagnose anything — four accounts failed and the log said only that
        // they had. Both describers below emit a provider CODE and, for Dwolla,
        // the rejected FIELD PATHS; neither emits a message or a request body,
        // which is where the access token and processor token live.
        console.error(
          "Failed to link one account on the item:",
          accountData.account_id,
          "|",
          plaidErrorCode(error) ?? describeDwollaError(error)
        );
        failed.push(accountData.account_id);
      }
    }

    if (linked === 0) {
      throw new Error("None of this bank's accounts could be linked");
    }

    revalidatePath("/");

    console.log(
      `Linking a bank: complete — ${linked} account(s) linked, ${failed.length} failed`
    );

    return parseStringify({
      publicTokenExchange: "complete",
      linkedAccounts: linked,
      skippedAccounts:
        accountsResponse.data.accounts.length - linkable.length + failed.length,
    });
  } catch (error) {
    console.error(
      "Linking a bank FAILED:",
      error instanceof Error ? error.message : "unknown error"
    );
    // Reported rather than swallowed. Returning undefined told the caller
    // nothing, and the caller navigated to the dashboard as if it had worked —
    // so a failed link looked exactly like a successful one.
    return parseStringify({ publicTokenExchange: "failed" });
  }
}


