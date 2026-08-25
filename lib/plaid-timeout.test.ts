import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PLAID_TIMEOUT_MS validation, each case in a freshly loaded module.
 *
 * The deadline is read once at import time, so a test that does not reset the
 * module registry only ever exercises the value the suite started with. Every
 * input below silently produced a broken or absent deadline before validation
 * existed: axios treats 0 as "no timeout at all".
 */
const ORIGINAL = process.env.PLAID_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLAID_TIMEOUT_MS;
  else process.env.PLAID_TIMEOUT_MS = ORIGINAL;
  vi.resetModules();
});

async function loadWith(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.PLAID_TIMEOUT_MS;
  else process.env.PLAID_TIMEOUT_MS = value;
  return import("./plaid");
}

describe("PLAID_TIMEOUT_MS", () => {
  it("defaults to a bounded value when unset", async () => {
    const mod = await loadWith(undefined);
    expect(mod.plaidRequestTimeoutMs).toBe(15_000);
  });

  it("accepts a valid positive integer", async () => {
    const mod = await loadWith("9000");
    expect(mod.plaidRequestTimeoutMs).toBe(9_000);
  });

  it.each([
    ["0", "axios treats zero as NO timeout"],
    ["-1", "negative"],
    ["not-a-number", "NaN"],
    ["Infinity", "infinite"],
    ["1500.5", "fractional"],
    ["60001", "beyond the stated maximum"],
    ["", "empty"],
  ])("REFUSES %s (%s)", async (value) => {
    await expect(loadWith(value)).rejects.toThrow(/PLAID_TIMEOUT_MS/);
  });

  it("fails at configuration load, not at the first call", async () => {
    // A deadline that is only checked when used would let a migration get all
    // the way to the provider before discovering it has no bound.
    await expect(loadWith("0")).rejects.toThrow();
  });
});
