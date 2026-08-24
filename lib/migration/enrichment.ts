// Server-only. Uses Plaid access tokens.
import "server-only";

import { plaidClient } from "../plaid";

/**
 * Display metadata for a linked account, fetched from the provider.
 *
 * The legacy bank document stores only identifiers — accountId, bankId, the
 * access token. Everything a person would recognise (the account's name, mask,
 * type) lives at Plaid and was previously re-fetched on every page render.
 * The migration captures it once.
 */
export type AccountMetadata = {
  displayName: string;
  officialName: string | null;
  mask: string | null;
  accountType: string | null;
  accountSubtype: string | null;
};

/**
 * Why enrichment did not produce usable metadata.
 *
 * Distinct codes, not one "failed" bucket, because they demand different
 * actions: a network fault is retried, an ambiguous match is a data question
 * for a human, and an unsupported currency must not be migrated at all.
 */
export type EnrichmentFailureCode =
  | "NO_ACCESS_TOKEN"
  | "SOURCE_ACCOUNT_NOT_FOUND"
  | "AMBIGUOUS_PROVIDER_ACCOUNT"
  | "UNSUPPORTED_CURRENCY"
  | "PROVIDER_ERROR";

export type EnrichmentOutcome =
  | { ok: true; metadata: AccountMetadata; currency: string }
  | {
      ok: false;
      code: EnrichmentFailureCode;
      reason: string;
      /** Never migrate this account at all, as opposed to migrating degraded. */
      blocking: boolean;
      metadata: AccountMetadata;
      currency: string | null;
    };

/**
 * Used when the provider cannot be reached.
 *
 * `display_name` is NOT NULL in the target, so a placeholder is required for a
 * FIRST insert — but it is deliberately obvious rather than a guess dressed up
 * as real data. On a RE-RUN the placeholder is never written over metadata that
 * is already correct; see `metadataKnown` in the linked-accounts repository.
 */
export const FALLBACK_METADATA: AccountMetadata = {
  displayName: "Linked account",
  officialName: null,
  mask: null,
  accountType: null,
  accountSubtype: null,
};

/** The only currency the schema accepts. */
const SUPPORTED_CURRENCY = "USD";

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * Fetch metadata for one account.
 *
 * NEVER THROWS. A backfill that aborts because one Plaid Item has expired
 * credentials would strand every record after it, and re-running would then
 * hit the same wall. An unreachable provider degrades one row instead.
 *
 * The access token is used here and discarded. It is not returned, not logged,
 * and has no column in the target schema.
 */
export async function fetchAccountMetadata(input: {
  accessToken: string;
  externalAccountId: string;
}): Promise<EnrichmentOutcome> {
  if (!input.accessToken) {
    return degraded("NO_ACCESS_TOKEN", "no access token on the legacy record", false);
  }

  try {
    const response = await plaidClient.accountsGet({
      access_token: input.accessToken,
    });

    const accounts = response.data.accounts ?? [];

    // Match the specific account by id. The legacy code used accounts[0] and
    // discarded the rest, which is how a multi-account Item ended up
    // mislabelled. Both non-unary outcomes are named rather than resolved by
    // picking one: silently choosing among candidates is the original bug in a
    // different costume.
    const matches = accounts.filter((a) => a.account_id === input.externalAccountId);

    if (matches.length === 0) {
      return degraded(
        "SOURCE_ACCOUNT_NOT_FOUND",
        `account ${input.externalAccountId} is not on the Plaid Item`,
        false
      );
    }
    if (matches.length > 1) {
      return degraded(
        "AMBIGUOUS_PROVIDER_ACCOUNT",
        `account ${input.externalAccountId} matched ${matches.length} accounts on the Plaid Item`,
        true
      );
    }

    const account = matches[0];

    // Currency comes from the provider, never assumed. `iso_currency_code` is
    // read off the balances object; the balance AMOUNTS are deliberately not
    // read, because there is no balance column and a stale copy of someone's
    // money looks authoritative.
    const balances = account.balances as
      | { iso_currency_code?: unknown; unofficial_currency_code?: unknown }
      | undefined;
    const currency =
      str(balances?.iso_currency_code) ?? str(balances?.unofficial_currency_code);

    if (!currency) {
      return degraded(
        "UNSUPPORTED_CURRENCY",
        `account ${input.externalAccountId} reports no currency`,
        true
      );
    }
    if (currency.toUpperCase() !== SUPPORTED_CURRENCY) {
      // Relabelling a CAD account as USD to satisfy a CHECK constraint would
      // put a false fact in the system of record. Refuse the row instead.
      return degraded(
        "UNSUPPORTED_CURRENCY",
        `account ${input.externalAccountId} is denominated in ${currency}, not ${SUPPORTED_CURRENCY}`,
        true,
        currency
      );
    }

    const name = str(account.name);
    return {
      ok: true,
      currency: SUPPORTED_CURRENCY,
      metadata: {
        displayName: name ?? FALLBACK_METADATA.displayName,
        officialName: str(account.official_name),
        mask: str(account.mask),
        accountType: str(account.type as unknown),
        accountSubtype: str(account.subtype as unknown),
      },
    };
  } catch (error) {
    // Report the provider's error CODE, never the error object: a Plaid error
    // can echo the request, and the request contains the access token.
    const code =
      (error as { response?: { data?: { error_code?: unknown } } })?.response?.data
        ?.error_code ?? "unknown";
    return degraded("PROVIDER_ERROR", `provider error: ${String(code)}`, false);
  }
}

function degraded(
  code: EnrichmentFailureCode,
  reason: string,
  blocking: boolean,
  currency: string | null = null
): EnrichmentOutcome {
  return { ok: false, code, reason, blocking, metadata: FALLBACK_METADATA, currency };
}
