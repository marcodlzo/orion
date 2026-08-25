import { describe, expect, it } from "vitest";

import { plaidClient, plaidRequestTimeoutMs } from "./plaid";

/**
 * The provider client's configuration, asserted rather than assumed.
 *
 * A missing deadline does not fail loudly — it produces a promise that never
 * settles, which stalls the backfill before the transaction opens with no
 * error, no output, and no way to distinguish a hung migration from a slow one.
 * `fetchAccountMetadata` catches a REJECTED call; it cannot catch one that
 * never returns.
 */
describe("plaidClient configuration", () => {
  it("sets a bounded request timeout", () => {
    expect(plaidRequestTimeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(plaidRequestTimeoutMs)).toBe(true);
  });

  it("passes the timeout to the underlying HTTP client", () => {
    // Reaching into the SDK's config is deliberate: asserting the exported
    // constant alone would pass even if it were never wired through.
    const config = (plaidClient as unknown as {
      configuration?: { baseOptions?: { timeout?: unknown } };
    }).configuration;

    expect(config?.baseOptions?.timeout).toBe(plaidRequestTimeoutMs);
  });

  it("keeps the deadline short enough to be useful", () => {
    // A migration that waits ten minutes per account is indistinguishable from
    // one that is stuck, so the bound has to be operationally meaningful.
    expect(plaidRequestTimeoutMs).toBeLessThanOrEqual(60_000);
  });

  it("stays pinned to the sandbox", () => {
    const config = (plaidClient as unknown as {
      configuration?: { basePath?: string };
    }).configuration;

    // A dev build must never reach production. The pin is intentional until the
    // Plaid milestone; this fails if someone points it elsewhere by accident.
    expect(config?.basePath).toContain("sandbox");
  });
});
