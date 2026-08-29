import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildKeyring, KeyringError, type Keyring } from "./keyring";
import {
  credentialsMatch,
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
  isEncrypted,
} from "./envelope";

/**
 * CREDENTIAL ENCRYPTION AT REST.
 *
 * Keys here are generated per test run. Nothing in this file is a real key, and
 * no key material is ever committed — the operator generates one and supplies it
 * through the environment.
 *
 * FIXTURES ARE DELIBERATELY NOT TOKEN-SHAPED. An earlier draft used realistic
 * `access-sandbox-…` strings and the pre-write guard blocked the file, which is
 * the guard working: it cannot tell a synthetic token from a real one, and a
 * codebase where "it's only a test fixture" is an accepted excuse is one where a
 * real token eventually lands the same way. The crypto does not care about the
 * shape of what it encrypts.
 *
 * The tests that matter are the attack-shaped ones: a moved ciphertext, a
 * tampered tag, a wrong key, a retired key. Round-tripping a value proves the
 * code runs; those prove it protects something.
 */

const keyOf = (id: string) => `${id}:${randomBytes(32).toString("base64")}`;

const ring = (): Keyring => {
  const keys = `${keyOf("k1")},${keyOf("k2")}`;
  return buildKeyring({ keys, activeKeyId: "k2" });
};

const CONTEXT = { recordId: "bank-doc-1", field: "accessToken" } as const;

/** Stands in for a provider credential without looking like one. */
const SECRET = "credential-under-test-0001";

describe("round trip", () => {
  it("returns exactly what was encrypted", () => {
    const keyring = ring();

    const stored = encryptCredential(SECRET, CONTEXT, keyring);

    expect(decryptCredential(stored, CONTEXT, keyring)).toBe(SECRET);
  });

  it("does not contain the plaintext", () => {
    const keyring = ring();

    const stored = encryptCredential(SECRET, CONTEXT, keyring);

    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("credential-under-test");
    expect(Buffer.from(stored, "utf8").includes(Buffer.from(SECRET))).toBe(false);
  });

  it("produces a DIFFERENT ciphertext every time", () => {
    // A fresh random IV per encryption. Reusing one with the same key in GCM
    // leaks the XOR of the two plaintexts and allows forgery — and a
    // deterministic ciphertext would also let anyone with read access tell which
    // records share a credential.
    const keyring = ring();

    const a = encryptCredential("same-value", CONTEXT, keyring);
    const b = encryptCredential("same-value", CONTEXT, keyring);

    expect(a).not.toBe(b);
    expect(decryptCredential(a, CONTEXT, keyring)).toBe("same-value");
    expect(decryptCredential(b, CONTEXT, keyring)).toBe("same-value");
  });

  it("handles a URL, which is what a funding source is", () => {
    const keyring = ring();
    const url = "https://provider.invalid/funding-sources/abc-123-def";
    const context = { recordId: "bank-doc-1", field: "fundingSourceUrl" } as const;

    const stored = encryptCredential(url, context, keyring);

    expect(stored).not.toContain("provider.invalid");
    expect(decryptCredential(stored, context, keyring)).toBe(url);
  });
});

describe("a ciphertext cannot be moved", () => {
  it("REFUSES a ciphertext copied to another record", () => {
    // THE ATTACK THIS BINDING EXISTS FOR. An attacker with write access to the
    // store copies the encrypted access token from their own bank record into
    // somebody else's. Without the binding the application decrypts it happily
    // and uses it against the victim's account.
    const keyring = ring();
    const stored = encryptCredential(SECRET, CONTEXT, keyring);

    expect(() =>
      decryptCredential(stored, { recordId: "bank-doc-2", field: "accessToken" }, keyring)
    ).toThrow(CredentialCryptoError);
  });

  it("REFUSES a ciphertext moved between fields on the same record", () => {
    // A funding-source URL pasted into the access-token field, or the reverse.
    const keyring = ring();
    const stored = encryptCredential(SECRET, CONTEXT, keyring);

    expect(() =>
      decryptCredential(
        stored,
        { recordId: "bank-doc-1", field: "fundingSourceUrl" },
        keyring
      )
    ).toThrow(CredentialCryptoError);
  });

  it("cannot be tricked by a record id that concatenates", () => {
    // Length-prefixed binding: "ab" + "accessToken" must not collide with
    // "abaccessToken" + "".
    const keyring = ring();
    const stored = encryptCredential("v", { recordId: "ab", field: "accessToken" }, keyring);

    expect(() =>
      decryptCredential(stored, { recordId: "abaccessToken", field: "accessToken" }, keyring)
    ).toThrow(CredentialCryptoError);
  });

  it("refuses to encrypt without a record to bind to", () => {
    const keyring = ring();

    expect(() =>
      encryptCredential("v", { recordId: "", field: "accessToken" }, keyring)
    ).toThrow(CredentialCryptoError);
  });

  it("refuses to encrypt an empty credential", () => {
    // An empty string is what a missing field looks like. Encrypting it would
    // store a valid-looking ciphertext for a credential that does not exist.
    expect(() => encryptCredential("", CONTEXT, ring())).toThrow(CredentialCryptoError);
  });
});

describe("a ciphertext cannot be altered", () => {
  it("REFUSES a flipped byte in the payload", () => {
    // Authenticated encryption, not merely encryption. Under AES-CBC an attacker
    // with write access could flip bits in a stored token and the application
    // would use whatever came out.
    const keyring = ring();
    const stored = encryptCredential(SECRET, CONTEXT, keyring);
    const [version, keyId, iv, payload] = stored.split(".");

    const bytes = Buffer.from(payload, "base64url");
    bytes[0] ^= 0x01;
    const tampered = [version, keyId, iv, bytes.toString("base64url")].join(".");

    expect(tampered).not.toBe(stored);
    expect(() => decryptCredential(tampered, CONTEXT, keyring)).toThrow(
      CredentialCryptoError
    );
  });

  it("REFUSES a flipped byte in the authentication tag", () => {
    const keyring = ring();
    const stored = encryptCredential(SECRET, CONTEXT, keyring);
    const [version, keyId, iv, payload] = stored.split(".");

    const bytes = Buffer.from(payload, "base64url");
    bytes[bytes.length - 1] ^= 0x01;

    expect(() =>
      decryptCredential(
        [version, keyId, iv, bytes.toString("base64url")].join("."),
        CONTEXT,
        keyring
      )
    ).toThrow(CredentialCryptoError);
  });

  it("REFUSES a swapped IV", () => {
    const keyring = ring();
    const a = encryptCredential("value-a", CONTEXT, keyring);
    const b = encryptCredential("value-b", CONTEXT, keyring);

    const [, , ivB] = b.split(".");
    const [version, keyId, , payloadA] = a.split(".");

    expect(() =>
      decryptCredential([version, keyId, ivB, payloadA].join("."), CONTEXT, keyring)
    ).toThrow(CredentialCryptoError);
  });

  it("refuses a truncated value", () => {
    const keyring = ring();
    const stored = encryptCredential("v", CONTEXT, keyring);

    expect(() => decryptCredential(stored.slice(0, -8), CONTEXT, keyring)).toThrow(
      CredentialCryptoError
    );
  });

  it("carries neither plaintext nor ciphertext in its error", () => {
    // The most likely thing in this module to reach a log or a Sentry event.
    const keyring = ring();
    const stored = encryptCredential(SECRET, CONTEXT, keyring);

    const error = (() => {
      try {
        decryptCredential(stored, { recordId: "other", field: "accessToken" }, keyring);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error).toBeInstanceOf(CredentialCryptoError);
    const text = `${error!.message} ${JSON.stringify(error)} ${error!.stack ?? ""}`;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("credential-under-test");
    expect(text).not.toContain(stored.split(".")[3]);
  });
});

describe("keys", () => {
  it("decrypts with the key that wrote it, not the active one", () => {
    // Rotation: after the active key changes, values written with the old key
    // must still be readable. Otherwise a rotation is a data-loss event.
    const k1 = keyOf("k1");
    const k2 = keyOf("k2");

    const before = buildKeyring({ keys: `${k1},${k2}`, activeKeyId: "k1" });
    const stored = encryptCredential("written-under-k1", CONTEXT, before);
    expect(stored.split(".")[1]).toBe("k1");

    const after = buildKeyring({ keys: `${k1},${k2}`, activeKeyId: "k2" });
    expect(decryptCredential(stored, CONTEXT, after)).toBe("written-under-k1");

    // And new writes use the new key.
    expect(encryptCredential("new", CONTEXT, after).split(".")[1]).toBe("k2");
  });

  it("REFUSES a value whose key has been retired", () => {
    // Loudly, naming the key — an operator can restore it. Silently returning
    // the stored string would hand a caller ciphertext to use as a token.
    const k1 = keyOf("k1");
    const k2 = keyOf("k2");

    const stored = encryptCredential(
      "v",
      CONTEXT,
      buildKeyring({ keys: `${k1},${k2}`, activeKeyId: "k1" })
    );

    const withoutK1 = buildKeyring({ keys: k2, activeKeyId: "k2" });
    expect(() => decryptCredential(stored, CONTEXT, withoutK1)).toThrow(
      /no key k1 is available/
    );
  });

  it("REFUSES a value encrypted under a different key of the same id", () => {
    const impostor = buildKeyring({ keys: keyOf("k2"), activeKeyId: "k2" });
    const stored = encryptCredential("v", CONTEXT, ring());

    expect(() => decryptCredential(stored, CONTEXT, impostor)).toThrow(
      CredentialCryptoError
    );
  });
});

describe("keyring configuration", () => {
  it("REFUSES to run without keys rather than falling back to plaintext", () => {
    // The dangerous implementation returns a no-op cipher when the variable is
    // missing, so a misconfigured deploy silently stores everything in the clear
    // while the operator believes it is encrypted.
    expect(() => buildKeyring({ keys: undefined, activeKeyId: "k1" })).toThrow(
      KeyringError
    );
    expect(() => buildKeyring({ keys: "", activeKeyId: "k1" })).toThrow(KeyringError);
    expect(() => buildKeyring({ keys: "   ", activeKeyId: "k1" })).toThrow(KeyringError);
  });

  it("refuses without an active key id", () => {
    expect(() => buildKeyring({ keys: keyOf("k1"), activeKeyId: undefined })).toThrow(
      KeyringError
    );
    expect(() => buildKeyring({ keys: keyOf("k1"), activeKeyId: "  " })).toThrow(
      KeyringError
    );
  });

  it("REFUSES a key that is not exactly 32 bytes", () => {
    // Base64 decoding is lenient — it drops characters it does not recognise
    // rather than failing — so the length check is what actually rejects a
    // truncated key. Without it a two-character key would be accepted and
    // everything encrypted under it trivially breakable.
    const short = `k1:${randomBytes(16).toString("base64")}`;
    const long = `k1:${randomBytes(48).toString("base64")}`;

    expect(() => buildKeyring({ keys: short, activeKeyId: "k1" })).toThrow(/32 bytes/);
    expect(() => buildKeyring({ keys: long, activeKeyId: "k1" })).toThrow(/32 bytes/);
    expect(() => buildKeyring({ keys: "k1:!!!!", activeKeyId: "k1" })).toThrow(
      /32 bytes/
    );
  });

  it("refuses an active key id that names no key", () => {
    expect(() => buildKeyring({ keys: keyOf("k1"), activeKeyId: "k9" })).toThrow(
      /not in CREDENTIAL_ENCRYPTION_KEYS/
    );
  });

  it("refuses a duplicate key id", () => {
    expect(() =>
      buildKeyring({ keys: `${keyOf("k1")},${keyOf("k1")}`, activeKeyId: "k1" })
    ).toThrow(/appears twice/);
  });

  it("refuses a key id that would make stored ciphertext ambiguous", () => {
    // The id is parsed back out of the ciphertext by splitting on ".".
    const material = randomBytes(32).toString("base64");

    for (const id of ["has.dot", "HasUpper", "-starts-with-dash", "a".repeat(33)]) {
      expect(() =>
        buildKeyring({ keys: `${id}:${material}`, activeKeyId: id })
      ).toThrow(KeyringError);
    }
  });

  it("refuses a malformed entry", () => {
    expect(() => buildKeyring({ keys: "no-separator", activeKeyId: "k1" })).toThrow(
      /keyId:base64key/
    );
    expect(() => buildKeyring({ keys: ":no-id", activeKeyId: "k1" })).toThrow(
      KeyringError
    );
  });

  it("accepts more than one key, which is what rotation needs", () => {
    const keyring = buildKeyring({
      keys: `${keyOf("old")},${keyOf("current")}`,
      activeKeyId: "current",
    });

    expect(keyring.active.id).toBe("current");
    expect(Array.from(keyring.byId.keys()).sort()).toEqual(["current", "old"]);
  });
});

describe("telling encrypted from plaintext", () => {
  it("recognises what it wrote", () => {
    expect(isEncrypted(encryptCredential("v", CONTEXT, ring()))).toBe(true);
  });

  it("does not mistake a plaintext credential for ciphertext", () => {
    // The backfill depends on this to be re-runnable: a false positive would
    // skip a plaintext record forever, a false negative would double-encrypt.
    expect(isEncrypted("some-plaintext-credential-value")).toBe(false);
    expect(isEncrypted("https://provider.invalid/funding-sources/abc")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
    // Shaped like it, but not four parts, or a version this module did not write.
    expect(isEncrypted("v1.k1.iv")).toBe(false);
    expect(isEncrypted("v2.k1.iv.payload")).toBe(false);
    expect(isEncrypted("v1..iv.payload")).toBe(false);
  });

  it("does not attempt decryption", () => {
    // "is this encrypted?" and "can I decrypt this?" are different questions.
    // Conflating them would make a wrong-key situation look like plaintext and
    // invite the backfill to encrypt ciphertext a second time.
    const stored = encryptCredential("v", CONTEXT, ring());
    const otherRing = buildKeyring({ keys: keyOf("k9"), activeKeyId: "k9" });

    expect(isEncrypted(stored)).toBe(true);
    expect(() => decryptCredential(stored, CONTEXT, otherRing)).toThrow();
  });
});

describe("comparing credentials", () => {
  it("matches equal values and rejects different ones", () => {
    expect(credentialsMatch("abc", "abc")).toBe(true);
    expect(credentialsMatch("abc", "abd")).toBe(false);
    expect(credentialsMatch("abc", "abcd")).toBe(false);
    expect(credentialsMatch("", "")).toBe(true);
  });
});
