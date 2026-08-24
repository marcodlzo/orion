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

export type EnrichmentOutcome =
  | { ok: true; metadata: AccountMetadata }
  | { ok: false; reason: string; metadata: AccountMetadata };

/**
 * Used when the provider cannot be reached.
 *
 * `display_name` is NOT NULL in the target, so a placeholder is required — but
 * it is deliberately obvious rather than a guess dressed up as real data. The
 * row is still migrated, the failure is reported, and a later re-run fills the
 * real values in because the upsert refreshes metadata.
 */
export const FALLBACK_METADATA: AccountMetadata = {
  displayName: "Linked account",
  officialName: null,
  mask: null,
  accountType: null,
  accountSubtype: null,
};

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
    return {
      ok: false,
      reason: "no access token on the legacy record",
      metadata: FALLBACK_METADATA,
    };
  }

  try {
    const response = await plaidClient.accountsGet({
      access_token: input.accessToken,
    });

    const accounts = response.data.accounts ?? [];
    // Match the specific account. The legacy code used accounts[0] and
    // discarded the rest, which is how a multi-account Item ended up
    // mislabelled; here the right one is selected by id.
    const account = accounts.find((a) => a.account_id === input.externalAccountId);

    if (!account) {
      return {
        ok: false,
        reason: `account ${input.externalAccountId} not present on the Plaid Item`,
        metadata: FALLBACK_METADATA,
      };
    }

    const name = str(account.name);
    return {
      ok: true,
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
    return {
      ok: false,
      reason: `provider error: ${String(code)}`,
      metadata: FALLBACK_METADATA,
    };
  }
}
