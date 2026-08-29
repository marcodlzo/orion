import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  digestPayload,
  parseDwollaEvent,
  transferOutcomeForTopic,
  verifyDwollaSignature,
} from "./dwolla-webhook";

const SECRET = "test-webhook-secret";

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

const BODY = JSON.stringify({
  id: "evt-1",
  topic: "customer_transfer_completed",
  resourceId: "xfer-1",
});

describe("verifyDwollaSignature", () => {
  it("accepts a signature computed over the exact body", () => {
    expect(
      verifyDwollaSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY),
        secret: SECRET,
      })
    ).toEqual({ ok: true });
  });

  it("REFUSES when the secret is unset, rather than skipping the check", () => {
    // The dangerous implementation is `if (!secret) return { ok: true }`, on the
    // reasoning that verification is not configured yet. That turns a
    // misconfiguration into an endpoint anyone can post settlements to, and it
    // does so silently.
    const result = verifyDwollaSignature({
      rawBody: BODY,
      signatureHeader: sign(BODY),
      secret: undefined,
    });

    expect(result).toEqual({ ok: false, reason: "no-secret" });
  });

  it("refuses an empty-string secret too", () => {
    // "" is what an unset environment variable looks like in a container.
    expect(
      verifyDwollaSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY, ""),
        secret: "",
      })
    ).toEqual({ ok: false, reason: "no-secret" });
  });

  it("rejects a missing signature header", () => {
    expect(
      verifyDwollaSignature({
        rawBody: BODY,
        signatureHeader: null,
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "no-signature" });
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyDwollaSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY, "not-the-secret"),
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a body altered after signing", () => {
    // The attack this exists to stop: take a real event and change the amount,
    // the resource, or the topic.
    const tampered = BODY.replace("xfer-1", "xfer-2");
    expect(tampered).not.toBe(BODY);

    expect(
      verifyDwollaSignature({
        rawBody: tampered,
        signatureHeader: sign(BODY),
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a truncated signature instead of throwing", () => {
    // timingSafeEqual throws on a length mismatch. An unguarded implementation
    // turns a one-character header into a 500 — and a 500 asks Dwolla to
    // redeliver forever.
    expect(
      verifyDwollaSignature({
        rawBody: BODY,
        signatureHeader: "ab",
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("does not accept a re-serialised body", () => {
    // The signature covers bytes, not meaning. Round-tripping through JSON
    // reorders keys and drops whitespace, and the usual "fix" for the resulting
    // mismatch is to stop verifying.
    const reserialised = JSON.stringify(JSON.parse(BODY), ["topic", "id", "resourceId"]);
    expect(reserialised).not.toBe(BODY);

    expect(
      verifyDwollaSignature({
        rawBody: reserialised,
        signatureHeader: sign(BODY),
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("accepts an uppercase hex signature", () => {
    expect(
      verifyDwollaSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY).toUpperCase(),
        secret: SECRET,
      })
    ).toEqual({ ok: true });
  });
});

describe("digestPayload", () => {
  it("is stable for one body and differs for another", () => {
    expect(digestPayload(BODY)).toBe(digestPayload(BODY));
    expect(digestPayload(BODY)).not.toBe(digestPayload(`${BODY} `));
  });

  it("does not contain the payload", () => {
    const body = JSON.stringify({
      id: "evt-1",
      topic: "customer_transfer_completed",
      _links: {
        resource: {
          href: "https://api.dwolla.com/funding-sources/abc-secret-url",
        },
      },
    });

    const digest = digestPayload(body);
    expect(digest).not.toContain("funding-sources");
    expect(digest).not.toContain("abc-secret-url");
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("parseDwollaEvent", () => {
  it("reads id, topic and resourceId", () => {
    expect(parseDwollaEvent(BODY)).toEqual({
      id: "evt-1",
      topic: "customer_transfer_completed",
      resourceId: "xfer-1",
    });
  });

  it("falls back to the transfer named by the resource link", () => {
    const body = JSON.stringify({
      id: "evt-2",
      topic: "customer_transfer_failed",
      _links: { resource: { href: "https://api.dwolla.com/transfers/xfer-9" } },
    });

    expect(parseDwollaEvent(body)?.resourceId).toBe("xfer-9");
  });

  it("returns null on unparseable or incomplete bodies instead of throwing", () => {
    // A throw here becomes a 500, and a 500 asks for redelivery of something
    // that will never parse.
    expect(parseDwollaEvent("not json")).toBeNull();
    expect(parseDwollaEvent("null")).toBeNull();
    expect(parseDwollaEvent("[]")).toBeNull();
    expect(parseDwollaEvent(JSON.stringify({ topic: "x" }))).toBeNull();
    expect(parseDwollaEvent(JSON.stringify({ id: "x" }))).toBeNull();
    expect(parseDwollaEvent(JSON.stringify({ id: "  ", topic: "x" }))).toBeNull();
  });

  it("reads a resource link only when it names a transfer", () => {
    // Taking the last path segment of any href would read a customer id, a
    // funding-source id, or a segment of an unrelated URL as a transfer id —
    // and then look up the wrong transfer to mark settled.
    const withHref = (href: string) =>
      parseDwollaEvent(
        JSON.stringify({
          id: "evt-3",
          topic: "customer_transfer_completed",
          _links: { resource: { href } },
        })
      )?.resourceId;

    expect(withHref("https://api.dwolla.com/transfers/xfer-9")).toBe("xfer-9");
    expect(withHref("https://api.dwolla.com/transfers/xfer-9/")).toBe("xfer-9");

    expect(withHref("https://api.dwolla.com/customers/cust-1")).toBeNull();
    expect(withHref("https://api.dwolla.com/funding-sources/fs-1")).toBeNull();
    expect(withHref("https://evil.example/../../etc/passwd")).toBeNull();
    expect(withHref("https://api.dwolla.com/transfers")).toBeNull();
    expect(withHref("not a url")).toBeNull();
    expect(withHref("")).toBeNull();
  });

  it("prefers the resourceId field over the link", () => {
    const body = JSON.stringify({
      id: "evt-4",
      topic: "customer_transfer_completed",
      resourceId: "xfer-field",
      _links: { resource: { href: "https://api.dwolla.com/transfers/xfer-link" } },
    });

    expect(parseDwollaEvent(body)?.resourceId).toBe("xfer-field");
  });
});

describe("transferOutcomeForTopic", () => {
  it("maps the topics that end a transfer", () => {
    expect(transferOutcomeForTopic("customer_transfer_completed")).toBe("settled");
    expect(transferOutcomeForTopic("customer_transfer_failed")).toBe("failed");
    expect(transferOutcomeForTopic("customer_transfer_returned")).toBe("returned");
  });

  it("returns null for topics this application has no opinion about", () => {
    // Guessing at an unmapped topic would be inventing provider state.
    expect(transferOutcomeForTopic("customer_created")).toBeNull();
    expect(transferOutcomeForTopic("customer_transfer_created")).toBeNull();
    expect(transferOutcomeForTopic("")).toBeNull();
  });

  it("does not map a pending or created transfer to settled", () => {
    // ACCEPTANCE IS NOT SETTLEMENT. This is the mapping mistake that would let
    // the ledger record money that has not moved.
    for (const topic of [
      "customer_transfer_created",
      "customer_bank_transfer_created",
      "customer_transfer_cancelled",
    ]) {
      expect(transferOutcomeForTopic(topic)).not.toBe("settled");
    }
  });
});
