// Dwolla webhook receiver.
//
// THE FIRST PUBLIC, UNAUTHENTICATED HTTP SURFACE IN THIS APPLICATION. There is
// no session here and no actor: the caller is whoever reached the URL. The only
// thing separating Dwolla from an attacker announcing that a transfer settled
// is the HMAC over the raw body, so verification happens first, in the service,
// before the body is parsed.
//
// This handler deliberately holds almost no logic. It converts HTTP into a call
// and a result into a status code; the decisions live in
// lib/services/settlement.service.ts where they can be tested without a server.
import { handleDwollaWebhook } from "@/lib/services/settlement.service";

// A webhook is never static and never cached. Without this, Next can decide at
// build time that this route has a constant response.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Dwolla's signature header. Compared case-insensitively by Headers.get. */
const SIGNATURE_HEADER = "x-request-signature-sha-256";

export async function POST(request: Request): Promise<Response> {
  // RAW TEXT, NOT request.json(). The signature covers the exact bytes Dwolla
  // sent; parsing and re-serialising reorders keys and would break every
  // comparison. Reading the body twice is not possible, so this is also why the
  // service takes a string rather than a parsed object.
  const rawBody = await request.text();

  const result = await handleDwollaWebhook({
    rawBody,
    signatureHeader: request.headers.get(SIGNATURE_HEADER),
    secret: process.env.DWOLLA_WEBHOOK_SECRET,
  });

  if (!result.accepted) {
    // 401 for an unverified caller. The body says nothing about WHY — whether
    // the secret is unset, the header missing, or the digest wrong is
    // information an attacker would use to work out what to send next.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // 200 for everything verified, including events this system ignores. A
  // non-2xx asks Dwolla to redeliver, and requesting redelivery of an event we
  // have correctly decided to ignore is an infinite loop.
  //
  // The outcome is returned because it is a fixed internal vocabulary — never a
  // provider message, never a transfer id, never an amount.
  return Response.json({ outcome: result.outcome }, { status: 200 });
}

/**
 * Dwolla probes an endpoint before it will send to it.
 *
 * 405 rather than 404: the route exists, and the method is what is wrong. It
 * discloses nothing, and it makes a misconfigured integration diagnosable.
 */
export async function GET(): Promise<Response> {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
