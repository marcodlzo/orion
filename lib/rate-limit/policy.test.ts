import { describe, it, expect } from "vitest";

import {
  LINK_TOKEN_BY_ACTOR,
  SIGN_IN_BY_ADDRESS,
  SIGN_IN_BY_EMAIL,
  SIGN_UP_BY_ADDRESS,
  TOKEN_EXCHANGE_BY_ACTOR,
  TRANSFER_BY_ACTOR,
  bucketFor,
  hashSubject,
  windowStartFor,
} from "./policy";

/**
 * The pure half of rate limiting: window arithmetic and key construction.
 *
 * No database, because none is needed. What a bucket key contains and where a
 * window begins are decidable from the inputs alone, and a test that needed a
 * server to check them would be testing the server.
 */

describe("hashSubject", () => {
  it("does not carry the subject", () => {
    // THE POINT OF THE HASH. A rate-limit table that stored raw values would be
    // a list of email addresses somebody tried to sign in as — a worse
    // disclosure than anything the limiter prevents.
    const email = "victim@example.invalid";

    expect(hashSubject(email)).not.toContain("victim");
    expect(hashSubject(email)).not.toContain("example");
    expect(hashSubject(email)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is stable, so the same subject keeps counting into the same bucket", () => {
    expect(hashSubject("a@b.invalid")).toBe(hashSubject("a@b.invalid"));
  });

  it("separates different subjects", () => {
    expect(hashSubject("a@b.invalid")).not.toBe(hashSubject("c@d.invalid"));
  });
});

describe("bucketFor", () => {
  it("keeps rules apart for the same subject", () => {
    // Two rules keyed on a client address must count separately. Sharing a
    // bucket would let sign-up attempts exhaust the sign-in budget, and the
    // subject digest alone would collide exactly like that.
    const address = "203.0.113.7";

    expect(bucketFor(SIGN_IN_BY_ADDRESS, address)).not.toBe(
      bucketFor(SIGN_UP_BY_ADDRESS, address)
    );
  });

  it("leaves the scope legible and the subject not", () => {
    const bucket = bucketFor(SIGN_IN_BY_EMAIL, "victim@example.invalid");

    expect(bucket.startsWith("signin:email:")).toBe(true);
    expect(bucket).not.toContain("victim");
  });
});

describe("windowStartFor", () => {
  it("puts two moments in the same window on the same start", () => {
    const rule = TRANSFER_BY_ACTOR; // one hour
    const a = new Date("2026-09-04T10:00:30.000Z");
    const b = new Date("2026-09-04T10:59:59.999Z");

    expect(windowStartFor(a, rule.windowSeconds)).toEqual(
      windowStartFor(b, rule.windowSeconds)
    );
  });

  it("moves to a new window at the boundary", () => {
    const rule = TRANSFER_BY_ACTOR;
    const before = new Date("2026-09-04T10:59:59.999Z");
    const after = new Date("2026-09-04T11:00:00.000Z");

    expect(windowStartFor(after, rule.windowSeconds).getTime()).toBeGreaterThan(
      windowStartFor(before, rule.windowSeconds).getTime()
    );
  });

  it("aligns to the epoch, not to the first request", () => {
    // Aligning to first use would give every bucket its own phase, so two
    // requests a second apart could land in different windows depending on when
    // each subject was first seen. Deterministic alignment is what makes the
    // burst below a fixed, statable bound rather than a variable one.
    const start = windowStartFor(
      new Date("2026-09-04T10:17:42.123Z"),
      15 * 60
    );

    expect(start.toISOString()).toBe("2026-09-04T10:15:00.000Z");
  });

  it("PINS THE KNOWN BURST: a full budget either side of a boundary", () => {
    // This is a characterisation test, not an aspiration. Fixed windows permit
    // up to 2x the limit across a boundary, and the choice was made knowing
    // that. The test exists so the property stays KNOWN — if someone later
    // replaces the algorithm, this fails and makes them say so.
    //
    // The bound is real but narrow: never more than `limit` within any single
    // window, and the 2x requires the attempts to straddle the boundary exactly.
    const rule = SIGN_IN_BY_ADDRESS;
    const endOfWindow = new Date("2026-09-04T10:14:59.000Z");
    const startOfNext = new Date("2026-09-04T10:15:00.000Z");

    const first = windowStartFor(endOfWindow, rule.windowSeconds);
    const second = windowStartFor(startOfNext, rule.windowSeconds);

    // Different windows one second apart, so each grants a full `limit`.
    expect(first).not.toEqual(second);
    expect(second.getTime() - first.getTime()).toBe(rule.windowSeconds * 1000);
  });
});

describe("the policy values themselves", () => {
  it("keeps the per-email sign-in limit LOOSER than the per-address one", () => {
    // NOT A STYLE PREFERENCE. A tight limit keyed on a victim's email address is
    // an account-lockout primitive: anyone who knows the address can spend the
    // budget and keep the owner out. The per-address rule is the brute-force
    // control; the per-email rule is a backstop against an attacker rotating
    // addresses, and it must cost a real owner less than it costs an attacker.
    expect(SIGN_IN_BY_EMAIL.limit).toBeGreaterThan(SIGN_IN_BY_ADDRESS.limit);
  });

  it("keeps sign-up tighter than sign-in", () => {
    // A sign-up that succeeds creates a Dwolla customer. Abuse costs money at a
    // provider, not just compute here.
    expect(SIGN_UP_BY_ADDRESS.limit).toBeLessThan(SIGN_IN_BY_ADDRESS.limit);
  });

  it("states every rule in positive, finite terms", () => {
    // A zero or negative limit would refuse everything; a zero window would
    // divide by zero in the window arithmetic. Neither is reachable by
    // configuration, because these are constants — this catches a typo.
    for (const rule of [
      SIGN_IN_BY_ADDRESS,
      SIGN_IN_BY_EMAIL,
      SIGN_UP_BY_ADDRESS,
      TRANSFER_BY_ACTOR,
      LINK_TOKEN_BY_ACTOR,
      TOKEN_EXCHANGE_BY_ACTOR,
    ]) {
      expect(rule.limit, rule.scope).toBeGreaterThan(0);
      expect(rule.windowSeconds, rule.scope).toBeGreaterThan(0);
      expect(Number.isSafeInteger(rule.limit), rule.scope).toBe(true);
      expect(Number.isSafeInteger(rule.windowSeconds), rule.scope).toBe(true);
    }
  });
});
