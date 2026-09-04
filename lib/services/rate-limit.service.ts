// Server-only. The one place a request path consults the rate-limit store.
//
// THE CROSSING. Actions call this service; they never import the repository.
// Where the boundary is crossed matters as much as that it is — a `'use server'`
// module importing lib/db directly puts a database call one refactor away from
// the browser bundle, and the import-boundary suite pins the crossing points by
// exact equality.
import "server-only";

import { headers } from "next/headers";

import {
  bucketFor,
  windowStartFor,
  type RateLimitRule,
} from "../rate-limit/policy";
import { recordAttempt } from "../db/repositories/rate-limits.repository";

/**
 * Raised when the caller has exhausted a limit.
 *
 * Carries only how long to wait. NOT how many attempts were made, not what the
 * limit is, and not which of several rules was hit: on an unauthenticated
 * endpoint those answers let someone map the controls, and on `signIn` a
 * distinguishable "this email is throttled" would confirm an address exists.
 */
export class RateLimitedError extends Error {
  readonly code = "RATE_LIMITED";
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many attempts. Try again shortly.");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, RateLimitedError.prototype);
  }
}

/**
 * Raised when the limiter itself could not be consulted.
 *
 * SEPARATE FROM RateLimitedError ON PURPOSE, even though both refuse the
 * request. An operator looking at logs must be able to tell "we are under
 * attack" from "the database is unreachable"; collapsing them into one error
 * makes an outage look like traffic and a flood look like an outage.
 */
export class RateLimiterUnavailableError extends Error {
  readonly code = "RATE_LIMITER_UNAVAILABLE";

  constructor(options?: { cause?: unknown }) {
    super("Service temporarily unavailable. Try again shortly.");
    this.name = "RateLimiterUnavailableError";
    if (options?.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, RateLimiterUnavailableError.prototype);
  }
}

/**
 * Consume one attempt against a rule, or refuse.
 *
 * FAILS CLOSED. If the store cannot be reached the request is refused, not
 * waved through. A limiter that opens under load is not a control: an attacker
 * who can pressure the database gets unlimited attempts at exactly the moment
 * the system is least able to cope, and nothing in the logs distinguishes that
 * from ordinary traffic.
 *
 * This matches how the rest of the system already behaves. A missing webhook
 * secret refuses every delivery rather than accepting them, and a missing
 * encryption key refuses every read and write rather than storing plaintext.
 * There is no "rate limiting disabled" mode for the same reason there is no
 * "encryption disabled" one: a control that silently stops applying is worse
 * than one that was never there, because the operator believes it is on.
 *
 * The cost is real and is the reason the two cheapest actions are not limited at
 * all: a PostgreSQL outage refuses sign-in and transfers. Sign-in already needs
 * Appwrite, and transfers already need PostgreSQL to claim their key, so neither
 * gains a dependency it did not have.
 */
export async function consume(
  rule: RateLimitRule,
  subject: string,
  now: Date = new Date()
): Promise<void> {
  const windowStart = windowStartFor(now, rule.windowSeconds);

  let hits: number;
  try {
    hits = await recordAttempt({ bucket: bucketFor(rule, subject), windowStart });
  } catch (error) {
    // The driver error never travels. A constraint violation quotes the
    // offending row, and the bucket is the closest thing here to a subject.
    throw new RateLimiterUnavailableError({ cause: error });
  }

  if (hits > rule.limit) {
    const endsAt = windowStart.getTime() + rule.windowSeconds * 1000;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((endsAt - now.getTime()) / 1000)
    );
    throw new RateLimitedError(retryAfterSeconds);
  }
}

/**
 * Consume against several rules, refusing if any is exhausted.
 *
 * SEQUENTIAL, AND EVERY RULE IS CONSUMED BEFORE ANY IS JUDGED — `consume`
 * records first and throws after, so a caller stopped by the first rule has
 * still been counted against it and only it. Running these in parallel would be
 * faster and would make which rules got counted depend on scheduling.
 */
export async function consumeAll(
  checks: readonly { rule: RateLimitRule; subject: string }[],
  now: Date = new Date()
): Promise<void> {
  for (const check of checks) {
    await consume(check.rule, check.subject, now);
  }
}

/**
 * The client address to key an unauthenticated limit on.
 *
 * ONLY AS TRUSTWORTHY AS THE PROXY IN FRONT. `x-forwarded-for` is a request
 * header, so a client talking directly to this server can set it to anything and
 * give itself a fresh bucket per attempt. It is trustworthy only when a proxy
 * that OVERWRITES the header sits in front — which is the normal deployment and
 * is not the case for `npm run dev`.
 *
 * The first entry is taken because that is the position a conforming proxy puts
 * the originating client in. Without knowing how many proxies are in front, no
 * choice here is safe against forgery; this one is right when the deployment is
 * right, and the limit keyed on the actor is what protects the authenticated
 * endpoints regardless.
 *
 * A request with no forwarded header at all shares one bucket with every other
 * such request. That is the safe direction to fail — they are throttled
 * together rather than each given their own allowance — and in development it
 * means the limits are reached sooner than they would be in production. Clear
 * them with `npm run rate-limit:sweep`.
 */
export function clientAddress(): string {
  const header = headers();
  const forwarded = header.get("x-forwarded-for");

  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const real = header.get("x-real-ip")?.trim();
  if (real) return real;

  return "unknown";
}
