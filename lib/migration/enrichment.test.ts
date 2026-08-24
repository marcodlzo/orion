import { beforeEach, describe, expect, it, vi } from "vitest";

const { accountsGet } = vi.hoisted(() => ({ accountsGet: vi.fn() }));

vi.mock("../plaid", () => ({ plaidClient: { accountsGet } }));

import { fetchAccountMetadata, FALLBACK_METADATA } from "./enrichment";

const plaidAccount = (over: Record<string, unknown> = {}) => ({
  account_id: "plaid-account-1",
  name: "Plaid Checking",
  official_name: "Plaid Gold Standard 0% Interest Checking",
  mask: "0000",
  type: "depository",
  subtype: "checking",
  ...over,
});

beforeEach(() => {
  accountsGet.mockReset();
});

describe("fetchAccountMetadata", () => {
  it("returns the provider's metadata for the requested account", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-1",
    });

    expect(outcome).toEqual({
      ok: true,
      metadata: {
        displayName: "Plaid Checking",
        officialName: "Plaid Gold Standard 0% Interest Checking",
        mask: "0000",
        accountType: "depository",
        accountSubtype: "checking",
      },
    });
  });

  it("selects the account by id instead of taking the first one", async () => {
    // The legacy code used accounts[0] and discarded the rest, which is how a
    // multi-account Item ended up labelling a savings account "Checking".
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({ account_id: "other-account", name: "Plaid Checking" }),
          plaidAccount({
            account_id: "plaid-account-2",
            name: "Plaid Saving",
            mask: "1111",
            subtype: "savings",
          }),
        ],
      },
    });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-2",
    });

    expect(outcome.metadata.displayName).toBe("Plaid Saving");
    expect(outcome.metadata.mask).toBe("1111");
  });

  it("degrades when the account is absent from the Item", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "removed-account",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.metadata).toEqual(FALLBACK_METADATA);
  });

  it("degrades rather than throwing when the provider fails", async () => {
    // A backfill that aborts on one expired Item strands every record after it,
    // and re-running hits the same wall.
    accountsGet.mockRejectedValue({
      response: { data: { error_code: "ITEM_LOGIN_REQUIRED" } },
    });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-1",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ reason: "provider error: ITEM_LOGIN_REQUIRED" });
  });

  it("never throws, whatever the provider does", async () => {
    accountsGet.mockRejectedValue(new Error("socket hang up"));

    await expect(
      fetchAccountMetadata({
        accessToken: "access-sandbox-1",
        externalAccountId: "plaid-account-1",
      })
    ).resolves.toMatchObject({ ok: false });
  });

  it("reports the provider's error code, never the error object", async () => {
    // A Plaid error echoes the request that caused it, and the request carries
    // the access token.
    accountsGet.mockRejectedValue({
      response: {
        data: {
          error_code: "INVALID_ACCESS_TOKEN",
          request: { access_token: "access-sandbox-must-not-appear" },
        },
      },
      config: { data: '{"access_token":"access-sandbox-must-not-appear"}' },
    });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-must-not-appear",
      externalAccountId: "plaid-account-1",
    });

    expect(JSON.stringify(outcome)).not.toContain("access-sandbox-must-not-appear");
  });

  it("does not call the provider without a token", async () => {
    const outcome = await fetchAccountMetadata({
      accessToken: "",
      externalAccountId: "plaid-account-1",
    });

    expect(accountsGet).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.metadata).toEqual(FALLBACK_METADATA);
  });

  it("returns no access token in the outcome", async () => {
    accountsGet.mockResolvedValue({ data: { accounts: [plaidAccount()] } });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-must-not-appear",
      externalAccountId: "plaid-account-1",
    });

    // The token is used here and discarded; it has no column in the target.
    expect(JSON.stringify(outcome)).not.toContain("access-sandbox-must-not-appear");
    expect(outcome.metadata).not.toHaveProperty("accessToken");
  });

  it("falls back to a placeholder name rather than an empty one", async () => {
    // display_name is NOT NULL in the target.
    accountsGet.mockResolvedValue({
      data: { accounts: [plaidAccount({ name: "   " })] },
    });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-1",
    });

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

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-1",
    });

    expect(outcome.metadata.officialName).toBeNull();
    expect(outcome.metadata.mask).toBeNull();
    expect(outcome.metadata.accountSubtype).toBeNull();
  });

  it("survives a response with no accounts array", async () => {
    accountsGet.mockResolvedValue({ data: {} });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-1",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.metadata).toEqual(FALLBACK_METADATA);
  });

  it("carries no balance into the metadata", async () => {
    accountsGet.mockResolvedValue({
      data: {
        accounts: [
          plaidAccount({ balances: { current: 4210.55, available: 4000, iso_currency_code: "USD" } }),
        ],
      },
    });

    const outcome = await fetchAccountMetadata({
      accessToken: "access-sandbox-1",
      externalAccountId: "plaid-account-1",
    });

    // Balances are provider state, re-read on demand. There is no balance
    // column, on purpose: a stale copy of someone's money is worse than none.
    expect(JSON.stringify(outcome)).not.toContain("4210");
    expect(outcome.metadata).not.toHaveProperty("balances");
  });
});
