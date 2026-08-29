// Server-only. Authenticated encryption for provider credentials at rest.
import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { getKeyring, type Keyring } from "./keyring";

/**
 * AES-256-GCM.
 *
 * AUTHENTICATED, not merely encrypted. GCM produces a tag that fails decryption
 * if a single byte of the ciphertext changed, which matters here because the
 * store holding these values is one an attacker with database access can write
 * to as well as read. Unauthenticated encryption — AES-CBC, say — would let such
 * an attacker flip bits in an access token and have the application use the
 * result.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

export class CredentialCryptoError extends Error {
  readonly code: "ENCRYPT_FAILED" | "DECRYPT_FAILED" | "MALFORMED";
  constructor(
    code: CredentialCryptoError["code"],
    message: string,
    options?: { cause?: unknown }
  ) {
    // NOTHING HERE EVER CARRIES PLAINTEXT OR CIPHERTEXT. An error message is the
    // most likely thing in this file to reach a log, a Sentry event or a
    // terminal, and a decryption failure that quoted the value it failed on
    // would defeat the entire point of encrypting it.
    super(message);
    this.name = "CredentialCryptoError";
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, CredentialCryptoError.prototype);
  }
}

/**
 * What a ciphertext is FOR, bound into the encryption itself.
 *
 * Passed to GCM as additional authenticated data: it is not stored in the
 * ciphertext, but decryption fails unless the caller supplies the same value.
 *
 * THIS IS WHAT STOPS A CIPHERTEXT BEING MOVED. Without it, an attacker with
 * write access to the store could copy the encrypted access token from their own
 * bank record into somebody else's — or copy a funding-source URL into the
 * access-token field — and the application would decrypt it happily and use it.
 * Binding the record id and the field name makes a relocated ciphertext
 * undecryptable rather than merely wrong.
 */
export type CredentialContext = {
  /** The record this value belongs to. */
  recordId: string;
  /** The field within it. */
  field: "accessToken" | "fundingSourceUrl";
};

function additionalData(context: CredentialContext): Buffer {
  if (!context.recordId || context.recordId.trim() === "") {
    throw new CredentialCryptoError(
      "MALFORMED",
      "a credential must be bound to a record id"
    );
  }
  // Length-prefixed so no field's contents can forge the separator and make two
  // different contexts produce the same binding.
  const parts = [context.recordId, context.field];
  return Buffer.from(parts.map((p) => `${p.length}:${p};`).join(""), "utf8");
}

/**
 * Encrypt one credential.
 *
 * A FRESH RANDOM IV EVERY TIME. Reusing an IV with the same key in GCM is
 * catastrophic — it leaks the XOR of the two plaintexts and allows forging — so
 * it is generated here rather than derived from anything, and never from the
 * value being encrypted.
 */
export function encryptCredential(
  plaintext: string,
  context: CredentialContext,
  keyring: Keyring = getKeyring()
): string {
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new CredentialCryptoError(
      "ENCRYPT_FAILED",
      "refusing to encrypt an empty credential"
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.active.material, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(context));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Self-describing: the version and key id travel with the value so a rotated
  // key can still decrypt what the previous one wrote.
  return [
    VERSION,
    keyring.active.id,
    iv.toString("base64url"),
    Buffer.concat([ciphertext, tag]).toString("base64url"),
  ].join(".");
}

/**
 * Whether a stored value is one this module wrote.
 *
 * Used to tell an already-encrypted value from a plaintext one during migration,
 * so the backfill is safely re-runnable. Deliberately a SHAPE check — it does not
 * attempt decryption, because "is this encrypted?" and "can I decrypt this?" are
 * different questions and conflating them would make a wrong-key situation look
 * like unencrypted data and invite re-encrypting ciphertext.
 */
export function isEncrypted(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts[0] === VERSION &&
    parts[1].length > 0 &&
    parts[2].length > 0 &&
    parts[3].length > 0
  );
}

/**
 * Decrypt one credential.
 *
 * Fails on: an unknown key id, a tampered ciphertext, a tampered tag, and a
 * context that does not match the one it was encrypted under. All of them raise
 * the same way, carrying no value.
 */
export function decryptCredential(
  stored: string,
  context: CredentialContext,
  keyring: Keyring = getKeyring()
): string {
  if (!isEncrypted(stored)) {
    throw new CredentialCryptoError(
      "MALFORMED",
      "stored credential is not in the expected encrypted form"
    );
  }

  const [, keyId, ivPart, payloadPart] = stored.split(".");

  const key = keyring.byId.get(keyId);
  if (!key) {
    // A retired key is the likeliest cause, and it is a configuration problem
    // an operator can fix — so it says which key without saying anything else.
    throw new CredentialCryptoError(
      "DECRYPT_FAILED",
      `no key ${keyId} is available to decrypt this credential`
    );
  }

  const iv = Buffer.from(ivPart, "base64url");
  const payload = Buffer.from(payloadPart, "base64url");

  if (iv.length !== IV_BYTES || payload.length <= TAG_BYTES) {
    throw new CredentialCryptoError("MALFORMED", "stored credential is truncated");
  }

  const ciphertext = payload.subarray(0, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key.material, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(context));
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    // `cause` is deliberately dropped. The driver's message is harmless here,
    // but attaching it invites a caller to print an error chain, and this is the
    // one place in the codebase where doing so would be next to the value.
    void error;
    throw new CredentialCryptoError(
      "DECRYPT_FAILED",
      "credential failed authentication — it was altered, or bound to a different record"
    );
  }
}

/**
 * Whether two credentials are the same, without leaking how nearly.
 *
 * Used by the verifier to confirm a migrated value round-trips. A plain `===`
 * on secret material leaks its prefix through timing, which matters when the
 * comparison is reachable by anything an attacker can trigger repeatedly.
 */
export function credentialsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
