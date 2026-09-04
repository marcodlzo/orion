/**
 * Rate-limit policy: what is limited, how hard, and how a bucket key is built.
 *
 * PURE. No I/O, no database, no clock of its own — the time is passed in. That
 * is what makes the window arithmetic and the key construction testable without
 * a server, and it is why this file rather than the repository owns them.
 *
 * These are POLICY, in the same sense as lib/domain/limits.ts: changing one is a
 * code review, not an environment variable somebody sets differently in
 * production and nobody notices.
 */

import { createHash } from "node:crypto";

export type RateLimitRule = {
  /** Names the limit. Becomes the bucket prefix, so it is visible in the store. */
  readonly scope: string;
  /** Attempts permitted per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * SIGN-IN, BY CLIENT ADDRESS.
 *
 * The primary brute-force control. Deliberately tighter than the per-email rule
 * below, because an attacker running a credential-stuffing list changes the
 * email on every attempt and would never trip a per-account limit.
 */
export const SIGN_IN_BY_ADDRESS: RateLimitRule = {
  scope: "signin:addr",
  limit: 10,
  windowSeconds: 15 * MINUTE,
};

/**
 * SIGN-IN, BY EMAIL ATTEMPTED.
 *
 * THROTTLE, NOT LOCKOUT, and the distinction is the whole design. A limit keyed
 * on the victim's email is a denial-of-service primitive: anyone who knows an
 * address can spend the account's budget and lock its owner out. That is why
 * this is deliberately LOOSER than the per-address rule and spans a short
 * window — it exists to slow a distributed attack spread across many addresses,
 * which the per-address rule cannot see, while costing a real owner at most a
 * few minutes.
 *
 * The genuinely safe version of this control needs a proof-of-work or CAPTCHA
 * step rather than a refusal. Not built; naming it is better than pretending the
 * tension does not exist.
 */
export const SIGN_IN_BY_EMAIL: RateLimitRule = {
  scope: "signin:email",
  limit: 20,
  windowSeconds: 15 * MINUTE,
};

/**
 * SIGN-UP, BY CLIENT ADDRESS.
 *
 * Tight, because each success creates a Dwolla customer and an Appwrite account.
 * This is the one unauthenticated endpoint whose abuse costs money at a provider
 * rather than only compute here.
 */
export const SIGN_UP_BY_ADDRESS: RateLimitRule = {
  scope: "signup:addr",
  limit: 5,
  windowSeconds: HOUR,
};

/**
 * TRANSFER INITIATION, BY ACTOR.
 *
 * Velocity control on money movement. It does NOT replace the hold and the
 * available-balance check, which is what actually stops a customer committing
 * more than they may — this bounds how fast an authenticated session can try.
 */
export const TRANSFER_BY_ACTOR: RateLimitRule = {
  scope: "transfer:actor",
  limit: 15,
  windowSeconds: HOUR,
};

/**
 * PLAID LINK TOKEN CREATION, BY ACTOR.
 *
 * Each call is a billable provider request. Generous enough that a user
 * retrying a flaky link flow is unaffected.
 */
export const LINK_TOKEN_BY_ACTOR: RateLimitRule = {
  scope: "linktoken:actor",
  limit: 30,
  windowSeconds: HOUR,
};

/**
 * PUBLIC TOKEN EXCHANGE, BY ACTOR.
 *
 * Each call reaches Plaid and then Dwolla, once per depository account on the
 * Item, so one request can be several provider calls.
 */
export const TOKEN_EXCHANGE_BY_ACTOR: RateLimitRule = {
  scope: "exchange:actor",
  limit: 30,
  windowSeconds: HOUR,
};

/**
 * Hash a rate-limit subject.
 *
 * The store must never hold the value itself. An email address is PII, and a
 * table of addresses somebody tried to sign in as is a worse disclosure than
 * anything rate limiting prevents. A client address is identifying too.
 *
 * Truncated to 32 hex characters. That is 128 bits, so a collision between two
 * real subjects is not a practical concern, and it keeps the key short enough to
 * index comfortably.
 *
 * NOT A SECRET AND NOT REVERSIBLE-PROOF. An unsalted digest of a known email
 * address can be confirmed by anyone who guesses it. This narrows the value of
 * the table to an attacker who already has a candidate list; it does not make it
 * safe to publish. The point is that reading the table does not ENUMERATE
 * anyone.
 */
export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 32);
}

/**
 * The bucket key for one rule and one subject.
 *
 * The scope stays in the clear so the table is legible to an operator and so two
 * rules can never share a bucket: a per-address sign-in limit and a per-address
 * sign-up limit must count separately, and they would collide if the key were
 * the subject digest alone.
 */
export function bucketFor(rule: RateLimitRule, subject: string): string {
  return `${rule.scope}:${hashSubject(subject)}`;
}

/**
 * The start of the fixed window containing `now`.
 *
 * FIXED WINDOW, DELIBERATELY, AND ITS LIMITATION IS KNOWN. Requests are counted
 * per aligned window, so a caller can spend a full budget at the very end of one
 * window and a second full budget immediately after it starts — up to 2x the
 * limit across a boundary, though never more than the limit within any single
 * window.
 *
 * That bound is acceptable for what these rules defend, and it buys an algorithm
 * whose behaviour is exactly describable. The alternatives were worse trades: a
 * sliding-window COUNTER replaces this precise 2x bound with an estimate that
 * assumes attempts were spread evenly through the previous window, and a sliding
 * window LOG is exact but stores a row per attempt, which is unbounded growth
 * under exactly the flood it is meant to survive.
 *
 * A test pins the burst rather than describing it, so this stays a known
 * property and cannot quietly become a surprise.
 */
export function windowStartFor(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}
