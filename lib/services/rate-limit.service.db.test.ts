import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closePool, query } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import {
  attemptsIn,
  sweepExpiredCounters,
} from "../db/repositories/rate-limits.repository";
import {
  SIGN_IN_BY_ADDRESS,
  SIGN_IN_BY_EMAIL,
  bucketFor,
  windowStartFor,
  type RateLimitRule,
} from "../rate-limit/policy";
import { RateLimitedError, consume } from "./rate-limit.service";

/**
 * RATE LIMITING, AGAINST A REAL SERVER.
 *
 * The property that matters cannot be shown any other way. "Exactly N attempts
 * are permitted" is a claim about what happens when requests arrive AT THE SAME
 * TIME, and it is decided by an atomic upsert inside PostgreSQL. A fake store
 * would serialise everything through one JavaScript thread and pass whether or
 * not the real thing is safe.
 *
 * The limiter is the one control here that an attacker interacts with directly,
 * so every assertion is about observable effect: how many calls got through, and
 * what the table holds afterwards.
 */

// The service imports this for clientAddress(). Nothing in this file calls it —
// these limits are keyed on values passed in directly — but the import itself
// must resolve outside a Next request.
vi.mock("next/headers", () => ({ headers: () => new Headers() }));

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query("TRUNCATE rate_limit_counters");
});

/** A fixed instant, so a window boundary never lands mid-test. */
const NOW = new Date("2026-09-04T10:20:00.000Z");

/** Attempt once, reporting whether it was permitted. */
async function attempt(
  rule: RateLimitRule,
  subject: string,
  now: Date = NOW
): Promise<"allowed" | "refused"> {
  try {
    await consume(rule, subject, now);
    return "allowed";
  } catch (error) {
    if (error instanceof RateLimitedError) return "refused";
    throw error;
  }
}

describe("the limit is the limit", () => {
  it("permits exactly the limit and refuses the next", async () => {
    const rule = SIGN_IN_BY_ADDRESS;
    const results: string[] = [];

    for (let i = 0; i < rule.limit + 3; i += 1) {
      results.push(await attempt(rule, "203.0.113.7"));
    }

    expect(results.filter((r) => r === "allowed")).toHaveLength(rule.limit);
    expect(results.slice(0, rule.limit).every((r) => r === "allowed")).toBe(true);
    expect(results.slice(rule.limit).every((r) => r === "refused")).toBe(true);
  });

  it("keeps counting refused attempts, so there is no free retry loop", async () => {
    // If a refusal did not increment, a caller sitting at the limit could hammer
    // forever at zero cost and the counter would never reflect the attack. The
    // record happens before anyone decides, which is why this holds.
    const rule = SIGN_IN_BY_ADDRESS;
    const subject = "203.0.113.9";

    for (let i = 0; i < rule.limit + 5; i += 1) await attempt(rule, subject);

    const recorded = await attemptsIn({
      bucket: bucketFor(rule, subject),
      windowStart: windowStartFor(NOW, rule.windowSeconds),
    });

    expect(recorded).toBe(rule.limit + 5);
  });

  it("saturates at the largest integer instead of overflowing", async () => {
    // PostgreSQL evaluates function arguments before calling the function, so
    // LEAST(hits + 1, 2147483647) still overflows when hits is already at the
    // maximum. The guard has to prevent the addition itself from happening.
    const rule = SIGN_IN_BY_ADDRESS;
    const subject = "203.0.113.10";
    const windowStart = windowStartFor(NOW, rule.windowSeconds);

    await attempt(rule, subject);
    await query(
      `UPDATE rate_limit_counters
          SET hits = 2147483647
        WHERE bucket = $1 AND window_start = $2`,
      [bucketFor(rule, subject), windowStart]
    );

    expect(await attempt(rule, subject)).toBe("refused");
    expect(
      await attemptsIn({ bucket: bucketFor(rule, subject), windowStart })
    ).toBe(2147483647);
  });

  it("reports a retry delay inside the window, never zero", async () => {
    const rule = SIGN_IN_BY_ADDRESS;
    for (let i = 0; i < rule.limit; i += 1) await attempt(rule, "203.0.113.11");

    await expect(consume(rule, "203.0.113.11", NOW)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    try {
      await consume(rule, "203.0.113.11", NOW);
      expect.unreachable("should have refused");
    } catch (error) {
      const refusal = error as RateLimitedError;
      // A zero or negative delay would tell a client to retry immediately, which
      // is the one instruction guaranteed to fail.
      expect(refusal.retryAfterSeconds).toBeGreaterThan(0);
      expect(refusal.retryAfterSeconds).toBeLessThanOrEqual(rule.windowSeconds);
    }
  });
});

describe("concurrency", () => {
  it("permits exactly the limit when every request arrives at once", async () => {
    // GENUINELY PARALLEL, AND THIS IS THE TEST THE DESIGN EXISTS FOR. A
    // SELECT-then-UPDATE limiter passes every sequential test above and fails
    // this one: concurrent readers all see the same count and all decide they
    // are under it. The atomic upsert is what makes the number each caller
    // receives its own position in the sequence.
    const rule = SIGN_IN_BY_ADDRESS;
    const attempts = rule.limit * 3;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => attempt(rule, "203.0.113.13"))
    );

    expect(results.filter((r) => r === "allowed")).toHaveLength(rule.limit);
    expect(results.filter((r) => r === "refused")).toHaveLength(
      attempts - rule.limit
    );

    // And the store agrees: one row, counting every attempt including refusals.
    const { rows } = await query<{ count: string; hits: number }>(
      "SELECT count(*)::text AS count, max(hits) AS hits FROM rate_limit_counters"
    );
    expect(rows[0].count).toBe("1");
    expect(rows[0].hits).toBe(attempts);
  });
});

describe("buckets do not bleed into each other", () => {
  it("gives each subject its own budget", async () => {
    const rule = SIGN_IN_BY_ADDRESS;
    for (let i = 0; i < rule.limit; i += 1) await attempt(rule, "203.0.113.20");

    expect(await attempt(rule, "203.0.113.20")).toBe("refused");
    // A different client is unaffected. Sharing a bucket would make one
    // attacker able to lock out everybody.
    expect(await attempt(rule, "203.0.113.21")).toBe("allowed");
  });

  it("gives each rule its own budget for the same subject", async () => {
    const subject = "shared@example.invalid";
    for (let i = 0; i < SIGN_IN_BY_EMAIL.limit; i += 1) {
      await attempt(SIGN_IN_BY_EMAIL, subject);
    }

    expect(await attempt(SIGN_IN_BY_EMAIL, subject)).toBe("refused");
    // Same subject, different rule, separate counter.
    expect(await attempt(SIGN_IN_BY_ADDRESS, subject)).toBe("allowed");
  });

  it("starts a fresh budget in the next window", async () => {
    const rule = SIGN_IN_BY_ADDRESS;
    for (let i = 0; i < rule.limit; i += 1) await attempt(rule, "203.0.113.30");
    expect(await attempt(rule, "203.0.113.30")).toBe("refused");

    const nextWindow = new Date(NOW.getTime() + rule.windowSeconds * 1000);
    expect(await attempt(rule, "203.0.113.30", nextWindow)).toBe("allowed");
  });
});

describe("what the table holds", () => {
  it("stores no raw subject", async () => {
    // The store must not become a list of the email addresses somebody tried.
    const email = "victim@example.invalid";
    await attempt(SIGN_IN_BY_EMAIL, email);

    const { rows } = await query<{ bucket: string }>(
      "SELECT bucket FROM rate_limit_counters"
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).not.toContain("victim");
    expect(rows[0].bucket).not.toContain("example.invalid");
    expect(rows[0].bucket).toBe(bucketFor(SIGN_IN_BY_EMAIL, email));
  });

  it("declares no column that could hold a credential or an address", async () => {
    const { rows } = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'rate_limit_counters'
        ORDER BY column_name`
    );

    // EXACT LIST. A rate-limit table is a tempting place to add "the email that
    // was attempted" or "the address it came from" for debugging, and either
    // would turn an abuse control into a PII store.
    expect(rows.map((r) => r.column_name)).toEqual([
      "bucket",
      "hits",
      "window_start",
    ]);
  });
});

describe("sweeping expired windows", () => {
  it("removes past windows and leaves the current one", async () => {
    const rule = SIGN_IN_BY_ADDRESS;
    // Four windows back. The *1000 matters: getTime is milliseconds and
    // windowSeconds is seconds, and without it "four windows ago" is 3.6
    // seconds ago, which is the same window.
    const old = new Date(NOW.getTime() - rule.windowSeconds * 1000 * 4);

    await attempt(rule, "203.0.113.40", old);
    await attempt(rule, "203.0.113.40", NOW);
    expect(await query("SELECT 1 FROM rate_limit_counters")).toMatchObject({
      rowCount: 2,
    });

    const removed = await sweepExpiredCounters(
      windowStartFor(NOW, rule.windowSeconds)
    );

    expect(removed).toBe(1);
    const { rows } = await query<{ window_start: Date }>(
      "SELECT window_start FROM rate_limit_counters"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].window_start).toEqual(windowStartFor(NOW, rule.windowSeconds));
  });

  it("does not reopen a limit that is still in force", async () => {
    // Sweeping the CURRENT window would hand an attacker a fresh budget, which
    // is why the sweep takes a cutoff rather than deleting everything old-ish.
    const rule = SIGN_IN_BY_ADDRESS;
    for (let i = 0; i < rule.limit; i += 1) await attempt(rule, "203.0.113.41");

    await sweepExpiredCounters(windowStartFor(NOW, rule.windowSeconds));

    expect(await attempt(rule, "203.0.113.41")).toBe("refused");
  });
});
