import { beforeEach, describe, expect, it, vi } from "vitest";

const { accountsGet } = vi.hoisted(() => ({ accountsGet: vi.fn() }));

vi.mock("../plaid", () => ({ plaidClient: { accountsGet } }));

import { fetchAccountMetadata, FALLBACK_METADATA } from "./enrichment";

/** Unique per-surface sentinels, so a leak names its own source. */
const TOKEN = "SENTINEL-plaid-access-token-4f81c2";
const FUNDING = "https://sentinel.invalid/funding-sources/8ab31d";

const plaidAccount = (over: Record<string, unknown> = {}) => ({
  account_id: "plaid-account-1",
  name: "Plaid Checking",
  official_name: "Plaid Gold Standard 0% Interest Checking",
  mask: "0000",
  type: "depository",
  subtype: "checking",
  balances: { current: 110, available: 100, iso_currency_code: "USD" },
  ...over,
});

const fetchOne = (over: { accessToken?: string; externalAccountId?: string } = {}) =>
  fetchAccountMetadata({
    accessToken: over.accessToken ?? TOKEN,
    externalAccountId: over.externalAccountId ?? "plaid-account-1",
  });

beforeEach(() => {
  accountsGet.mockReset();
});

describe("fetchAccountMetadata — the happy path", () => {
  it("returns the provider's metadata for the requested account", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    const outcome = await fetchOne();

    expect(outcome).toEqual({
      ok: true,
      currency: "USD",
      metadata: {
        displayName: "Plaid Checking",
        officialName: "Plaid Gold Standard 0% Interest Checking",
        mask: "0000",
        accountType: "depository",
        accountSubtype: "checking",
      },
    });
  });

  it("falls back to a placeholder name rather than an empty one", async () => {
    // display_name is NOT NULL in the target.
    accountsGet.mockResolvedValue({
      data: { accounts: [plaidAccount({ name: "   " })] },
    });

    const outcome = await fetchOne();

    expect(outcome.metadata.displayName).toBe(FALLBACK_METADATA.displayName);
  });

  it("normalises absent optional fields to null", async () => {
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({ official_name: null, mask: undefined, subtype: null }),
        ],
      },
    });

    const outcome = await fetchOne();

    expect(outcome.metadata.officialName).toBeNull();
    expect(outcome.metadata.mask).toBeNull();
    expect(outcome.metadata.accountSubtype).toBeNull();
  });
});

describe("fetchAccountMetadata — exact account matching", () => {
  it("selects the account whose id matches, not the first one", async () => {
    // The legacy code used accounts[0] and discarded the rest, which is how a
    // multi-account Item ended up labelling a savings account "Checking".
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({ account_id: "wrong-account", name: "Plaid Checking" }),
          plaidAccount({
            account_id: "target-account",
            name: "Plaid Saving",
            mask: "1111",
            subtype: "savings",
          }),
        ],
      },
    });

    const outcome = await fetchOne({ externalAccountId: "target-account" });

    expect(outcome.ok).toBe(true);
    expect(outcome.metadata.displayName).toBe("Plaid Saving");
    expect(outcome.metadata.mask).toBe("1111");
  });

  it("reports SOURCE_ACCOUNT_NOT_FOUND when nothing matches", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    const outcome = await fetchOne({ externalAccountId: "removed-account" });

    expect(outcome).toMatchObject({ ok: false, code: "SOURCE_ACCOUNT_NOT_FOUND" });
    expect(outcome.metadata).toEqual(FALLBACK_METADATA);
  });

  it("reports AMBIGUOUS_PROVIDER_ACCOUNT rather than picking one", async () => {
    // Choosing silently among candidates is the accounts[0] bug in a different
    // costume: it produces a confident answer that may be wrong.
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({ account_id: "dupe", name: "First" }),
          plaidAccount({ account_id: "dupe", name: "Second" }),
        ],
      },
    });

    const outcome = await fetchOne({ externalAccountId: "dupe" });

    expect(outcome).toMatchObject({ ok: false, code: "AMBIGUOUS_PROVIDER_ACCOUNT" });
    expect(outcome.metadata.displayName).not.toBe("First");
    expect(outcome.metadata.displayName).not.toBe("Second");
  });

  it("blocks migration for an ambiguous match", async () => {
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({ account_id: "dupe" }),
          plaidAccount({ account_id: "dupe" }),
        ],
      },
    });

    const outcome = await fetchOne({ externalAccountId: "dupe" });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.blocking).toBe(true);
  });

  it("does not block migration for a merely-missing account", async () => {
    // A removed account still has a real legacy link; degrade, do not discard.
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    const outcome = await fetchOne({ externalAccountId: "gone" });

    expect(outcome.ok === false && outcome.blocking).toBe(false);
  });
});

describe("fetchAccountMetadata — currency", () => {
  it("takes the currency from provider data", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    const outcome = await fetchOne();

    expect(outcome.ok && outcome.currency).toBe("USD");
  });

  it("refuses a non-USD account instead of relabelling it", async () => {
    // The schema's CHECK accepts only USD. Writing "USD" for a CAD account to
    // satisfy it would put a false fact in the system of record.
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({
            balances: { current: 110, iso_currency_code: "CAD" },
          }),
        ],
      },
    });

    const outcome = await fetchOne();

    expect(outcome).toMatchObject({ ok: false, code: "UNSUPPORTED_CURRENCY" });
    expect(outcome.ok === false && outcome.blocking).toBe(true);
    expect(outcome.ok === false && outcome.currency).toBe("CAD");
  });

  it("reports the real currency in the reason so an operator can act", async () => {
    accountsGet.mockResolvedValue({
      data: {
        accounts: [plaidAccount({ balances: { iso_currency_code: "GBP" } })],
      },
    });

    const outcome = await fetchOne();

    expect(outcome.ok === false && outcome.reason).toContain("GBP");
  });

  it("falls back to the unofficial currency code when there is no ISO one", async () => {
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({
            balances: { iso_currency_code: null, unofficial_currency_code: "USD" },
          }),
        ],
      },
    });

    const outcome = await fetchOne();

    expect(outcome.ok).toBe(true);
  });

  it("refuses an account that reports no currency at all", async () => {
    accountsGet.mockResolvedValue({
      data: { accounts: [plaidAccount({ balances: {} })] },
    });

    const outcome = await fetchOne();

    expect(outcome).toMatchObject({ ok: false, code: "UNSUPPORTED_CURRENCY" });
  });

  it("reads the currency without carrying the balance across", async () => {
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({
            balances: { current: 4210.55, available: 4000, iso_currency_code: "USD" },
          }),
        ],
      },
    });

    const outcome = await fetchOne();

    // There is no balance column, on purpose: a stale copy of someone's money
    // looks authoritative.
    expect(JSON.stringify(outcome)).not.toContain("4210");
    expect(outcome.metadata).not.toHaveProperty("balances");
  });
});

describe("fetchAccountMetadata — degradation", () => {
  it("degrades rather than throwing when the provider fails", async () => {
    // A backfill that aborts on one expired Item strands every record after it,
    // and re-running hits the same wall.
    accountsGet.mockRejectedValue({
      response: { data: { error_code: "ITEM_LOGIN_REQUIRED" } },
    });

    const outcome = await fetchOne();

    expect(outcome).toMatchObject({
      ok: false,
      code: "PROVIDER_ERROR",
      reason: "provider error: ITEM_LOGIN_REQUIRED",
      blocking: false,
    });
  });

  it("never throws, whatever the provider does", async () => {
    accountsGet.mockRejectedValue(new Error("socket hang up"));

    await expect(fetchOne()).resolves.toMatchObject({ ok: false });
  });

  it("survives a response with no accounts array", async () => {
    accountsGet.mockResolvedValue({ data: {} });

    const outcome = await fetchOne();

    expect(outcome).toMatchObject({ ok: false, code: "SOURCE_ACCOUNT_NOT_FOUND" });
  });

  it("does not call the provider without a token", async () => {
    const outcome = await fetchOne({ accessToken: "" });

    expect(accountsGet).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, code: "NO_ACCESS_TOKEN" });
  });
});

describe("fetchAccountMetadata — secret containment", () => {
  const surfaces = (outcome: unknown) => JSON.stringify(outcome);

  it("returns no access token on success", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    expect(surfaces(await fetchOne())).not.toContain(TOKEN);
  });

  it("returns no access token when the provider errors", async () => {
    // A Plaid error echoes the request that caused it, and the request carries
    // the access token.
    accountsGet.mockRejectedValue({
      response: {
        data: {
          error_code: "INVALID_ACCESS_TOKEN",
          request: { access_token: TOKEN },
        },
      },
      config: { data: JSON.stringify({ access_token: TOKEN }) },
      message: `Request failed with body {"access_token":"${TOKEN}"}`,
    });

    const outcome = await fetchOne();

    expect(surfaces(outcome)).not.toContain(TOKEN);
    expect(outcome.ok === false && outcome.reason).not.toContain(TOKEN);
  });

  it("returns no access token when the account is missing or ambiguous", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [] } });
    expect(surfaces(await fetchOne())).not.toContain(TOKEN);

    accountsGet.mockResolvedValue({
      data: {
        accounts: [plaidAccount({ account_id: "d" }), plaidAccount({ account_id: "d" })],
      },
    });
    expect(surfaces(await fetchOne({ externalAccountId: "d" }))).not.toContain(TOKEN);
  });

  it("does not carry a funding source url out of the provider payload", async () => {
    accountsGet.mockResolvedValue({
      data: {
        accounts: [plaidAccount({ funding_source_url: FUNDING })],
        item: { funding_source_url: FUNDING },
      },
    });

    expect(surfaces(await fetchOne())).not.toContain(FUNDING);
  });

  it("returns a plain object with no hidden error reference", async () => {
    const providerError = Object.assign(new Error(`boom ${TOKEN}`), {
      response: { data: { error_code: "X" } },
    });
    accountsGet.mockRejectedValue(providerError);

    const outcome = await fetchOne();

    // Structured-clone the outcome: anything reachable from it, including via
    // a nested cause, would come along.
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(Object.values(outcome).some((v) => v instanceof Error)).toBe(false);
  });
});
