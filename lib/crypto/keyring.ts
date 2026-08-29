// Server-only. Holds the credential-encryption keys.
//
// NEVER IMPORTABLE FROM A CLIENT COMPONENT. This module reads key material from
// the environment; a client-reachable import would put it in the browser bundle
// and, worse, in the source map even after tree-shaking removes it from the
// emitted JavaScript.
import "server-only";

/**
 * A key that can decrypt, identified so ciphertext can name the key that made
 * it. Rotation is the reason this is a ring rather than a single value: after a
 * rotation, old ciphertext is still readable while new ciphertext uses the new
 * key, and nothing has to be re-encrypted in a flag day.
 */
export type EncryptionKey = {
  id: string;
  material: Buffer;
};

export class KeyringError extends Error {
  readonly code = "KEYRING_MISCONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
    Object.setPrototypeOf(this, KeyringError.prototype);
  }
}

/** AES-256. Anything else is a misconfiguration, not a shorter key. */
export const KEY_BYTES = 32;

/** Key ids appear in stored ciphertext, so they are constrained, not free text. */
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type Keyring = {
  /** The key new ciphertext is written with. */
  active: EncryptionKey;
  /** Every key that can still decrypt something, by id. */
  byId: Map<string, EncryptionKey>;
};

/**
 * Build the keyring from environment values.
 *
 * PURE — takes the strings rather than reading process.env, so every failure
 * mode is testable without mutating global state, and so a test can never
 * accidentally depend on a developer's real key being set.
 *
 * FAILS LOUDLY ON EVERY MISCONFIGURATION. There is no default key, no
 * "encryption disabled" mode, and no fallback to plaintext. A system that
 * silently stops encrypting when a variable is missing is worse than one that
 * never encrypted: the operator believes the data is protected.
 */
export function buildKeyring(input: {
  keys: string | undefined;
  activeKeyId: string | undefined;
}): Keyring {
  if (!input.keys || input.keys.trim() === "") {
    throw new KeyringError(
      "CREDENTIAL_ENCRYPTION_KEYS is not set. Provider credentials cannot be stored without it."
    );
  }
  if (!input.activeKeyId || input.activeKeyId.trim() === "") {
    throw new KeyringError(
      "CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID is not set. Which key to encrypt with is a decision, not a default."
    );
  }

  const byId = new Map<string, EncryptionKey>();

  for (const entry of input.keys.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new KeyringError(
        "CREDENTIAL_ENCRYPTION_KEYS entries must be `keyId:base64key`"
      );
    }

    const id = trimmed.slice(0, separator);
    const encoded = trimmed.slice(separator + 1);

    if (!KEY_ID.test(id)) {
      // The id is stored in ciphertext and parsed back out, so a separator or a
      // wildcard inside it would make the format ambiguous.
      throw new KeyringError(
        "a key id must be lowercase alphanumeric with - or _, at most 32 characters"
      );
    }
    if (byId.has(id)) {
      throw new KeyringError(`key id ${id} appears twice`);
    }

    let material: Buffer;
    try {
      material = Buffer.from(encoded, "base64");
    } catch {
      throw new KeyringError(`key ${id} is not valid base64`);
    }

    // Base64 decoding is lenient — it drops characters it does not recognise
    // rather than failing — so the length check is what actually rejects a
    // truncated or corrupted key. Without it a two-character key would be
    // accepted and every value encrypted with it would be trivially breakable.
    if (material.length !== KEY_BYTES) {
      throw new KeyringError(
        `key ${id} must be exactly ${KEY_BYTES} bytes (got ${material.length})`
      );
    }

    byId.set(id, { id, material });
  }

  if (byId.size === 0) {
    throw new KeyringError("CREDENTIAL_ENCRYPTION_KEYS contained no usable key");
  }

  const active = byId.get(input.activeKeyId.trim());
  if (!active) {
    throw new KeyringError(
      `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID names ${input.activeKeyId.trim()}, which is not in CREDENTIAL_ENCRYPTION_KEYS`
    );
  }

  return { active, byId };
}

let cached: Keyring | null = null;

/**
 * The process keyring, built once.
 *
 * Deliberately lazy rather than built at module load: a module that throws on
 * import takes down anything that imports it, including code paths that never
 * touch a credential. Failing at first use puts the error where an operator can
 * see which operation needed it.
 */
export function getKeyring(): Keyring {
  if (cached) return cached;
  cached = buildKeyring({
    keys: process.env.CREDENTIAL_ENCRYPTION_KEYS,
    activeKeyId: process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
  });
  return cached;
}

/** Testing seam. Never called by application code. */
export function resetKeyringCache(): void {
  cached = null;
}
