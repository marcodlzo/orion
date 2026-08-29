// Server-only. Verifies Dwolla webhook signatures.
//
// A webhook endpoint is a PUBLIC, UNAUTHENTICATED HTTP surface: anyone on the
// internet can post to it, claiming a transfer settled. The signature is the
// only thing that distinguishes Dwolla from an attacker, so it is checked
// before the body is parsed, not after.
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: "no-secret" | "no-signature" | "bad-signature" };

/**
 * Verify the HMAC over the RAW request body.
 *
 * RAW, not re-serialised. `JSON.parse` followed by `JSON.stringify` reorders
 * keys, drops whitespace and normalises numbers, so a signature computed over
 * the round-tripped text would not match the one Dwolla computed — and the
 * usual fix for that mismatch is to stop checking, which is how a verified
 * endpoint quietly becomes an open one.
 *
 * Compared with `timingSafeEqual`. A byte-by-byte `===` leaks how much of a
 * forged signature was correct, which is enough to construct one given enough
 * attempts.
 */
export function verifyDwollaSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string | undefined;
}): VerificationResult {
  if (!input.secret) {
    // Refusing is the only safe response. Treating a missing secret as "skip
    // verification" would turn a misconfiguration into an open endpoint, and it
    // would do so silently.
    return { ok: false, reason: "no-secret" };
  }
  if (!input.signatureHeader) {
    return { ok: false, reason: "no-signature" };
  }

  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody, "utf8")
    .digest("hex");

  const provided = input.signatureHeader.trim().toLowerCase();

  // timingSafeEqual throws on a length mismatch, so compare lengths first —
  // length is not secret, the content is.
  if (provided.length !== expected.length) {
    return { ok: false, reason: "bad-signature" };
  }

  const equal = timingSafeEqual(
    Buffer.from(provided, "utf8"),
    Buffer.from(expected, "utf8")
  );

  return equal ? { ok: true } : { ok: false, reason: "bad-signature" };
}

/** A digest of the body, for recording that an event was seen without keeping it. */
export function digestPayload(rawBody: string): string {
  return createHmac("sha256", "orion-webhook-digest")
    .update(rawBody, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export type DwollaEvent = {
  id: string;
  topic: string;
  /** The transfer the event concerns, when it names one. */
  resourceId: string | null;
};

/**
 * Read a transfer id out of a resource link.
 *
 * REQUIRES THE LINK TO NAME A TRANSFER. Taking the last path segment of an
 * arbitrary href would let any resource link — a customer, a funding source, a
 * URL that is not a Dwolla URL at all — be read as a transfer identifier. The
 * body is verified by the time this runs, so this is not defending against an
 * attacker; it is refusing to guess which resource an event was about, which is
 * how the wrong transfer gets marked settled.
 */
function transferIdFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;

  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    return null;
  }

  const match = /^\/transfers\/([\w-]+)\/?$/.exec(path);
  return match ? match[1] : null;
}

/**
 * Read the fields we act on out of a VERIFIED body.
 *
 * Returns null rather than throwing on anything unexpected: a webhook handler
 * that throws on a malformed body hands the provider a 500 and invites endless
 * redelivery of something that will never parse.
 */
export function parseDwollaEvent(rawBody: string): DwollaEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const body = parsed as {
    id?: unknown;
    topic?: unknown;
    resourceId?: unknown;
    _links?: { resource?: { href?: unknown } };
  };

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!id || !topic) return null;

  // Dwolla gives the resource id directly and also as a link. Prefer the field;
  // fall back to the last path segment of the href.
  let resourceId: string | null =
    typeof body.resourceId === "string" && body.resourceId.trim()
      ? body.resourceId.trim()
      : null;

  if (!resourceId) {
    resourceId = transferIdFromHref(body._links?.resource?.href);
  }

  return { id, topic, resourceId };
}

/**
 * What a topic means for a transfer's lifecycle.
 *
 * An unmapped topic is `null` and is recorded as seen without changing
 * anything. Dwolla emits many topics this application has no opinion about,
 * and guessing at one would be inventing provider state.
 */
export function transferOutcomeForTopic(
  topic: string
): "settled" | "failed" | "returned" | null {
  switch (topic) {
    case "customer_transfer_completed":
    case "transfer_completed":
      return "settled";
    case "customer_transfer_failed":
    case "transfer_failed":
      return "failed";
    case "customer_transfer_returned":
    case "transfer_returned":
      return "returned";
    default:
      return null;
  }
}
