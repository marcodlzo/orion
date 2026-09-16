/**
 * The reference a customer hands out to be paid.
 *
 * WHAT THIS REPLACES. `shareableId` was `btoa(plaidAccountId)` — base64, named
 * `encryptId`, and presented as a secret. Two consequences followed from it
 * being an ENCODING rather than a secret:
 *
 *   - anyone holding a reference could decode it and read the Plaid account id;
 *   - anyone who learned a Plaid account id could COMPUTE the reference without
 *     ever having been given it.
 *
 * A share token encodes nothing. It is 128 bits of randomness with no
 * relationship to the account it names, so neither direction works.
 *
 * WHAT IT IS AND IS NOT. This is a bearer reference for RECEIVING money, like
 * an account number: holding one lets somebody pay you, and nothing else. It is
 * NOT an authorization capability — it cannot move money out of the account it
 * names. What authorises a transfer is the actor's ownership of the SOURCE
 * bank, checked in the SQL predicate of `getOwnedBankByDocumentId`. Do not
 * start treating possession of a token as permission to do anything but credit.
 *
 * PURE, AND DELIBERATELY IMPORT-FREE. Web Crypto rather than `node:crypto`, so
 * this module stays safe for a client component to import for the shape check
 * without dragging a Node built-in into the browser bundle. `getRandomValues`
 * is a CSPRNG in both runtimes — this is not `Math.random` with extra steps.
 *
 * That a browser CAN call `newShareToken` does not mean one may: a token is
 * minted at the storage boundary when an account is linked, and a token
 * arriving from a client is input, not identity.
 */

/** 16 bytes rendered as hex. Fixed width, so a length check means something. */
export const SHARE_TOKEN_LENGTH = 32;

/**
 * Lowercase hex only. Anchored, and with an exact length rather than `+`, so a
 * token with anything appended fails instead of matching a prefix.
 */
export const SHARE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** A fresh, unguessable reference. 128 bits from the platform CSPRNG. */
export function newShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_LENGTH / 2);
  crypto.getRandomValues(bytes);
  // Indexed rather than `for...of`: iterating a Uint8Array needs
  // downlevelIteration under this tsconfig target, and this module is meant to
  // stay dependency- and flag-free.
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Is this the shape of a share token?
 *
 * A shape check, NOT an existence check and NOT authorization. It exists so a
 * malformed reference is rejected before it reaches a query, and so the
 * rejection is indistinguishable from "no such recipient" — see the
 * counterparty lookup, which must not become an oracle for which tokens are
 * real.
 */
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_PATTERN.test(value);
}
