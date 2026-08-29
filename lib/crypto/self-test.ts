// Server-only. Proves the configured keyring can actually protect a credential.
//
// INSIDE THE CRYPTO BOUNDARY ON PURPOSE. The architecture test confines
// encrypt/decrypt to the storage boundary and the migration; this lives in
// `lib/crypto/` rather than in `scripts/` so that confinement stays true and an
// operator command does not become a third module handling ciphertext.
import "server-only";

import { getKeyring } from "./keyring";
import { decryptCredential, encryptCredential, isEncrypted } from "./envelope";

export type KeyringCheck = {
  usable: boolean;
  /** Key ids present, for an operator to compare against what they expect. */
  keyIds: string[];
  activeKeyId: string | null;
  /** Byte length per key id. Never the material. */
  keyBytes: Record<string, number>;
  /** Why it is not usable. Fixed vocabulary, never key material. */
  problem: string | null;
};

/**
 * Check the keyring end to end.
 *
 * A KEY OF THE RIGHT LENGTH CAN STILL BE UNUSABLE — a truncated buffer that
 * happened to land on 32 bytes, say. The only way to know it works is to use it,
 * so this encrypts and decrypts a synthetic probe and confirms the record
 * binding rejects a different record. Reporting "32 bytes, looks fine" without
 * that would be reporting on the shape of the configuration rather than on
 * whether it protects anything.
 *
 * RETURNS DATA; PRINTS NOTHING. The caller decides what to show, and there is
 * nothing here that would compromise the key if it were shown.
 */
export function checkKeyring(): KeyringCheck {
  const empty: KeyringCheck = {
    usable: false,
    keyIds: [],
    activeKeyId: null,
    keyBytes: {},
    problem: null,
  };

  let keyring;
  try {
    keyring = getKeyring();
  } catch (error) {
    // A KeyringError's message is written to be safe to surface: it names ids
    // and lengths, never material.
    return {
      ...empty,
      problem: error instanceof Error ? error.message : "the keyring could not be built",
    };
  }

  const keyIds = Array.from(keyring.byId.keys()).sort();
  const keyBytes: Record<string, number> = {};
  for (const id of keyIds) keyBytes[id] = keyring.byId.get(id)!.material.length;

  const base = { keyIds, activeKeyId: keyring.active.id, keyBytes };

  const probe = "round-trip-probe-value";
  const context = { recordId: "keyring-self-test", field: "accessToken" } as const;

  let stored: string;
  try {
    stored = encryptCredential(probe, context, keyring);
  } catch {
    return { ...base, usable: false, problem: "the active key could not encrypt" };
  }

  if (!isEncrypted(stored)) {
    return {
      ...base,
      usable: false,
      problem: "encryption produced an unrecognised format",
    };
  }

  try {
    if (decryptCredential(stored, context, keyring) !== probe) {
      return { ...base, usable: false, problem: "a value did not survive a round trip" };
    }
  } catch {
    return { ...base, usable: false, problem: "the active key could not decrypt" };
  }

  // The binding must actually reject a different record, or the protection
  // against a ciphertext moved between records is not in force.
  try {
    decryptCredential(stored, { recordId: "different", field: "accessToken" }, keyring);
    return {
      ...base,
      usable: false,
      problem: "ciphertext is not bound to its record",
    };
  } catch {
    /* expected: the binding held */
  }

  return { ...base, usable: true, problem: null };
}
