// Server-only. PostgreSQL boundary for rate-limit counters.
//
// Holds no credential and no PII. The bucket arrives already hashed by
// lib/rate-limit/policy.ts; nothing here can un-hash it, and nothing here should
// ever be given a raw email address or client address to store.
import "server-only";

import type { PoolClient } from "pg";

import { query } from "../pool";
import { toDatabaseError } from "../errors";

/** Run against a transaction client when given one, otherwise the pool. */
async function run<T extends Record<string, unknown>>(
  client: PoolClient | undefined,
  text: string,
  params: readonly unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  if (!client) return query<T>(text, params);
  try {
    const result = await client.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/**
 * Record one attempt against a bucket and return the resulting count.
 *
 * ONE STATEMENT, AND THAT IS THE POINT. A SELECT followed by an UPDATE lets two
 * concurrent requests both read `limit - 1` and both proceed, which is exactly
 * the burst a rate limiter exists to prevent — and it would pass any test that
 * did not run the two requests genuinely at once. The upsert serialises on the
 * primary key inside the server, so the count it returns is this caller's
 * position in the sequence and no two callers can receive the same number.
 *
 * The caller compares against the limit; this function does not know it. Keeping
 * the decision out of the store is what lets the policy be unit-tested without a
 * database and the store be tested without knowing any rule.
 *
 * A REFUSED ATTEMPT STILL COUNTS. The increment happens before anyone decides,
 * so a caller sitting at the limit does not get a free unlimited retry loop
 * while their attempts "do not count". The saturation guard exists only so that
 * a sustained flood cannot overflow a 32-bit column.
 *
 * THE GUARD IS A `CASE`, NOT `LEAST(hits + 1, max)`, AND THE DIFFERENCE IS THE
 * WHOLE POINT. PostgreSQL evaluates a function's arguments before calling it, so
 * `LEAST` never sees the overflow — `hits + 1` has already raised "integer out
 * of range" by then. The guard has to stop the addition from happening, which is
 * what the branch does. The first version of this line used LEAST and was
 * exactly as broken as having no guard at all.
 *
 * The consequence was not a re-opened limit: the statement raised, the service
 * failed closed, and the request was still refused. It was worse in a subtler
 * way — a saturated bucket reported RateLimiterUnavailableError for the rest of
 * its window, so a sustained attack presented in the logs as a database outage.
 * That is precisely the distinction those two error types exist to preserve.
 */
export async function recordAttempt(
  input: { bucket: string; windowStart: Date },
  client?: PoolClient
): Promise<number> {
  const { rows } = await run<{ hits: number }>(
    client,
    `INSERT INTO rate_limit_counters (bucket, window_start, hits)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE
       SET hits = CASE
         WHEN rate_limit_counters.hits < 2147483647
           THEN rate_limit_counters.hits + 1
         ELSE rate_limit_counters.hits
       END
     RETURNING hits`,
    [input.bucket, input.windowStart]
  );

  return rows[0].hits;
}

/**
 * Attempts recorded so far, without recording one.
 *
 * For tests and for an operator answering "is this bucket throttled?". Never
 * used to decide, because deciding on a read and then writing separately is the
 * race `recordAttempt` exists to avoid.
 */
export async function attemptsIn(
  input: { bucket: string; windowStart: Date },
  client?: PoolClient
): Promise<number> {
  const { rows } = await run<{ hits: number }>(
    client,
    `SELECT hits FROM rate_limit_counters
      WHERE bucket = $1 AND window_start = $2`,
    [input.bucket, input.windowStart]
  );

  return rows[0]?.hits ?? 0;
}

/**
 * Delete windows that ended before `before`. Returns rows removed.
 *
 * Expired counters are dead weight: nothing reads a window that has passed, and
 * every bucket a flood touches leaves one behind. Sweeping is a separate
 * operator action rather than something bolted onto the request path, so a
 * user's sign-in never pays for someone else's cleanup and a slow delete cannot
 * turn into request latency.
 */
export async function sweepExpiredCounters(
  before: Date,
  client?: PoolClient
): Promise<number> {
  const { rowCount } = await run(
    client,
    "DELETE FROM rate_limit_counters WHERE window_start < $1",
    [before]
  );

  return rowCount;
}
