import { describe, expect, it } from "vitest";

import {
  isShareToken,
  newShareToken,
  SHARE_TOKEN_LENGTH,
  SHARE_TOKEN_PATTERN,
} from "./share-token";

describe("minting a share token", () => {
  it("is 32 lowercase hex characters", () => {
    const token = newShareToken();

    expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(token).toMatch(SHARE_TOKEN_PATTERN);
    expect(token).toBe(token.toLowerCase());
  });

  it("never repeats", () => {
    // The property that matters is not "two calls differ" — a counter would
    // satisfy that. It is that the values are drawn from a space large enough
    // that collision and prediction are both out of reach. A thousand draws
    // with no repeat fails loudly against a constant, a counter, or a
    // small-space generator; against 128 bits it cannot realistically fail.
    const tokens = new Set(Array.from({ length: 1000 }, () => newShareToken()));

    expect(tokens.size).toBe(1000);
  });

  it("does not concentrate on any one character position", () => {
    // Guards the mutation that produces correct-looking output from a weak
    // source, e.g. hashing a constant or padding a short random value. Every
    // position should vary across a sample this size.
    const sample = Array.from({ length: 200 }, () => newShareToken());

    for (let position = 0; position < SHARE_TOKEN_LENGTH; position += 1) {
      const distinct = new Set(sample.map((token) => token[position]));
      expect(distinct.size).toBeGreaterThan(1);
    }
  });
});

describe("recognising a share token", () => {
  it("accepts a freshly minted one", () => {
    expect(isShareToken(newShareToken())).toBe(true);
  });

  it.each([
    ["too short", "0123456789abcdef0123456789abcde"],
    ["too long", "0123456789abcdef0123456789abcdef0"],
    ["uppercase hex", "0123456789ABCDEF0123456789ABCDEF"],
    ["non-hex characters", "0123456789abcdef0123456789abcdeg"],
    ["a leading space", " 123456789abcdef0123456789abcdef"],
    ["empty", ""],
  ])("rejects %s", (_label, candidate) => {
    expect(isShareToken(candidate)).toBe(false);
  });

  it("rejects a valid token with anything appended", () => {
    // The pattern is anchored at both ends with an exact length. An unanchored
    // or `+`-quantified version passes this input, which is why it is here.
    const token = newShareToken();

    expect(isShareToken(`${token} OR 1=1`)).toBe(false);
    expect(isShareToken(`${token}\n${token}`)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 12345678901234567890],
    ["an object", { toString: () => "0123456789abcdef0123456789abcdef" }],
  ])("rejects %s without coercing it", (_label, candidate) => {
    expect(isShareToken(candidate)).toBe(false);
  });
});

describe("what a share token must not encode", () => {
  it("is not derived from any input, because it takes none", () => {
    expect(newShareToken).toHaveLength(0);
  });

  it("does not decode to anything", () => {
    // The defect being retired: `shareableId` was base64 of the Plaid account
    // id, so decoding a reference yielded the account it named. A hex token
    // read as base64 yields bytes that mean nothing, and critically it cannot
    // equal the encoding of any account id, because it is not a function of one.
    const accountId = "hDpLZR9nQ1fRxVRoWKBEsjmgjnjRoLtL5pDVj";
    const oldStyleReference = Buffer.from(accountId).toString("base64");

    for (let i = 0; i < 100; i += 1) {
      expect(newShareToken()).not.toBe(oldStyleReference);
    }
  });
});
