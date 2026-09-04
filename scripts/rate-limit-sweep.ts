/**
 * Delete expired rate-limit windows.
 *
 *   npm run rate-limit:sweep
 *
 * Counters accumulate one row per bucket per window, and nothing ever reads a
 * window that has passed. Sweeping is an operator action rather than something
 * bolted onto the request path, so a user's sign-in never pays for someone
 * else's cleanup and a slow delete cannot become request latency.
 *
 * SAFE BY CONSTRUCTION: it only removes windows that STARTED more than the
 * retention period ago. A limit currently in force is never cleared, because
 * doing so would hand whoever tripped it a fresh budget — a sweep must not be a
 * way to reset a throttle.
 *
 * It is also the escape hatch in development. With no proxy in front there is no
 * forwarded header, so every request shares one bucket and the unauthenticated
 * limits are reached sooner than they would be in production.
 */
import { closePool } from "../lib/db/pool";
import { sweepExpiredCounters } from "../lib/db/repositories/rate-limits.repository";

/**
 * How far back to keep windows.
 *
 * Comfortably longer than the longest rule's window (one hour), so a counter is
 * never removed while it could still be consulted. The margin is deliberate:
 * cutting it fine would trade a little disk for a limit that silently resets.
 */
const RETAIN_HOURS = 6;

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }

  const before = new Date(Date.now() - RETAIN_HOURS * 60 * 60 * 1000);

  try {
    const removed = await sweepExpiredCounters(before);

    console.log(
      [
        "────────────────────────────────────────────────────────────────",
        "Rate-limit sweep",
        "────────────────────────────────────────────────────────────────",
        `retention        ${RETAIN_HOURS}h`,
        `cutoff           ${before.toISOString()}`,
        `windows removed  ${removed}`,
        "",
        "Windows that started after the cutoff are untouched, so a limit",
        "currently in force stays in force.",
        "────────────────────────────────────────────────────────────────",
      ].join("\n")
    );

    return 0;
  } catch (error) {
    // Name only. A driver error quotes the offending statement and its
    // parameters, and the parameter here is a bucket key.
    console.error(
      `Sweep failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    return 1;
  } finally {
    await closePool();
  }
}

main().then((code) => {
  process.exitCode = code;
});
