import { describe, it, expect, vi, beforeEach } from "vitest";

import { SIGN_IN_BY_ADDRESS, SIGN_IN_BY_EMAIL } from "../rate-limit/policy";

/**
 * The limiter's behaviour when the store misbehaves, and how it reads a request.
 *
 * Separate from the .db.test suite on purpose. That one proves what happens when
 * PostgreSQL WORKS — the counting, the atomicity, the windows. This one proves
 * what happens when it does not, which needs an injected fault rather than a
 * real server, and how the client address is derived, which needs request
 * headers rather than a database.
 */

const { recordAttempt, headerStore } = vi.hoisted(() => ({
  recordAttempt: vi.fn(),
  headerStore: { current: new Headers() },
}));

vi.mock("../db/repositories/rate-limits.repository", () => ({
  recordAttempt,
  attemptsIn: vi.fn(),
  sweepExpiredCounters: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: () => headerStore.current,
}));

import {
  RateLimitedError,
  RateLimiterUnavailableError,
  clientAddress,
  consume,
  consumeAll,
} from "./rate-limit.service";

beforeEach(() => {
  vi.clearAllMocks();
  headerStore.current = new Headers();
});

describe("failing closed", () => {
  it("refuses the request when the store cannot be reached", async () => {
    // THE DECISION THIS SUITE EXISTS FOR. A limiter that opens under load is not
    // a control: an attacker who can pressure the database gets unlimited
    // attempts at exactly the moment the system is least able to cope.
    recordAttempt.mockRejectedValue(new Error("connection terminated"));

    await expect(consume(SIGN_IN_BY_ADDRESS, "203.0.113.7")).rejects.toBeInstanceOf(
      RateLimiterUnavailableError
    );
  });

  it("distinguishes an outage from a refusal", async () => {
    // Collapsing these into one error makes an outage look like an attack and an
    // attack look like an outage. An operator reading logs has to be able to
    // tell them apart, and a caller retrying gets different advice.
    recordAttempt.mockRejectedValue(new Error("connection terminated"));
    const outage = await consume(SIGN_IN_BY_ADDRESS, "a").catch((e) => e);

    recordAttempt.mockResolvedValue(SIGN_IN_BY_ADDRESS.limit + 1);
    const refusal = await consume(SIGN_IN_BY_ADDRESS, "a").catch((e) => e);

    expect(outage).toBeInstanceOf(RateLimiterUnavailableError);
    expect(refusal).toBeInstanceOf(RateLimitedError);
    expect(outage).not.toBeInstanceOf(RateLimitedError);
    expect(refusal).not.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it("does not put the driver error in the message", async () => {
    // A driver error quotes the offending statement and its parameters, and the
    // parameter here is the bucket — the closest thing this table has to a
    // subject. It travels as `cause` for a log, never in the message.
    recordAttempt.mockRejectedValue(
      new Error('duplicate key value violates unique constraint: bucket=(signin:email:abc)')
    );

    const error = (await consume(SIGN_IN_BY_EMAIL, "victim@example.invalid").catch(
      (e) => e
    )) as Error;

    expect(error.message).not.toContain("bucket");
    expect(error.message).not.toContain("signin:email");
    expect(error.message).not.toContain("constraint");
  });
});

describe("the refusal boundary", () => {
  it("allows the attempt that reaches the limit exactly", async () => {
    // Off-by-one here is the difference between a limit of N and a limit of
    // N-1. The count returned is the attempt's own position, so the Nth
    // attempt returns N and must be allowed.
    recordAttempt.mockResolvedValue(SIGN_IN_BY_ADDRESS.limit);

    await expect(consume(SIGN_IN_BY_ADDRESS, "203.0.113.7")).resolves.toBeUndefined();
  });

  it("refuses the one after it", async () => {
    recordAttempt.mockResolvedValue(SIGN_IN_BY_ADDRESS.limit + 1);

    await expect(consume(SIGN_IN_BY_ADDRESS, "203.0.113.7")).rejects.toBeInstanceOf(
      RateLimitedError
    );
  });

  it("says how long to wait and nothing else", async () => {
    recordAttempt.mockResolvedValue(SIGN_IN_BY_ADDRESS.limit + 1);
    const error = (await consume(
      SIGN_IN_BY_ADDRESS,
      "203.0.113.7"
    ).catch((e) => e)) as RateLimitedError;

    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    // NOT how many attempts were made, NOT what the limit is, and NOT which
    // rule was hit. On signIn a distinguishable "this email is throttled" would
    // confirm that an address exists.
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      String(SIGN_IN_BY_ADDRESS.limit)
    );
    expect(error.message).not.toContain("email");
    expect(error.message).not.toContain("address");
  });
});

describe("consumeAll", () => {
  it("records every rule it reaches, and stops at the first refusal", async () => {
    // The first rule refuses. The second must NOT be consumed: charging a
    // victim's per-email budget for a request already rejected on its address
    // would let an attacker burn other people's allowances for free.
    recordAttempt.mockResolvedValue(SIGN_IN_BY_ADDRESS.limit + 1);

    await expect(
      consumeAll([
        { rule: SIGN_IN_BY_ADDRESS, subject: "203.0.113.7" },
        { rule: SIGN_IN_BY_EMAIL, subject: "victim@example.invalid" },
      ])
    ).rejects.toBeInstanceOf(RateLimitedError);

    expect(recordAttempt).toHaveBeenCalledTimes(1);
  });

  it("consumes every rule when all are under their limits", async () => {
    recordAttempt.mockResolvedValue(1);

    await expect(
      consumeAll([
        { rule: SIGN_IN_BY_ADDRESS, subject: "203.0.113.7" },
        { rule: SIGN_IN_BY_EMAIL, subject: "someone@example.invalid" },
      ])
    ).resolves.toBeUndefined();

    expect(recordAttempt).toHaveBeenCalledTimes(2);
  });
});

describe("clientAddress", () => {
  it("takes the originating client from x-forwarded-for", () => {
    headerStore.current = new Headers({
      "x-forwarded-for": "203.0.113.7, 198.51.100.1, 192.0.2.1",
    });

    expect(clientAddress()).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    headerStore.current = new Headers({ "x-real-ip": "203.0.113.8" });

    expect(clientAddress()).toBe("203.0.113.8");
  });

  it("puts every unidentifiable request in ONE shared bucket", () => {
    // The safe direction to fail. Giving each unidentifiable request its own
    // bucket would hand an attacker a fresh allowance per attempt, which is
    // exactly what the limit exists to deny.
    expect(clientAddress()).toBe("unknown");
  });

  it("ignores an empty forwarded header rather than keying on blank", () => {
    headerStore.current = new Headers({ "x-forwarded-for": "   " });

    expect(clientAddress()).toBe("unknown");
  });
});
