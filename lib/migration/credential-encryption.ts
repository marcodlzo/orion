// Server-only. OPERATOR TOOLING: encrypts provider credentials already at rest.
//
// Unreachable from any request path. It reads every bank document with the admin
// client and rewrites credential fields — correct for a one-off migration,
// catastrophic in a request.
import "server-only";

import { createAdminClient } from "../appwrite";
import {
  encryptCredential,
  decryptCredential,
  isEncrypted,
  credentialsMatch,
} from "../crypto/envelope";
import {
  readAllLegacyBanksAsStored,
  type LegacyBankDocument,
} from "./appwrite-source";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

const FIELDS = ["accessToken", "fundingSourceUrl"] as const;
type CredentialField = (typeof FIELDS)[number];

/**
 * What happened to one document.
 *
 * NO FIELD HERE CAN HOLD A CREDENTIAL. The report is built from these, and a
 * report is the single most likely place for a secret to escape — it reaches a
 * terminal, a CI log and often a pasted message. Counts and document ids only.
 */
export type DocumentOutcome = {
  documentId: string;
  encrypted: CredentialField[];
  alreadyEncrypted: CredentialField[];
  /** Present but unreadable — a wrong key or a tampered value. Never rewritten. */
  unreadable: CredentialField[];
  missing: CredentialField[];
};

export type EncryptionReport = {
  committed: boolean;
  scanned: number;
  reportedTotal: number;
  outcomes: DocumentOutcome[];
  documentsChanged: number;
  fieldsEncrypted: number;
  fieldsAlreadyEncrypted: number;
  fieldsUnreadable: number;
  fieldsMissing: number;
  /** True when every credential at rest is encrypted and readable. */
  clean: boolean;
};

export type EncryptionDeps = {
  readBanks: typeof readAllLegacyBanksAsStored;
  updateDocument: (
    documentId: string,
    data: Record<string, string>
  ) => Promise<void>;
};

export const defaultEncryptionDeps: EncryptionDeps = {
  readBanks: readAllLegacyBanksAsStored,
  updateDocument: async (documentId, data) => {
    const { database } = await createAdminClient();
    await database.updateDocument(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      documentId,
      data
    );
  },
};

/**
 * Encrypt every plaintext credential at rest.
 *
 * DRY RUN BY DEFAULT. `commit` must be passed explicitly, because this rewrites
 * the only copy of a credential: a bug here does not lose a row, it loses access
 * to somebody's bank account.
 *
 * RE-RUNNABLE. Already-encrypted values are recognised by shape and skipped, so
 * a run interrupted halfway can simply be run again. That is why `isEncrypted`
 * does not attempt decryption — if it did, a wrong key would make ciphertext look
 * like plaintext and this would encrypt it a second time, destroying it.
 *
 * VERIFIES BEFORE IT WRITES. Every value is decrypted back and compared to what
 * went in, in the same iteration. Writing a ciphertext that cannot be read back
 * is indistinguishable from data loss, and finding out later is finding out when
 * a user tries to move money.
 */
export async function encryptStoredCredentials(
  options: { commit?: boolean } = {},
  deps: EncryptionDeps = defaultEncryptionDeps
): Promise<EncryptionReport> {
  const commit = options.commit === true;

  const scan = await deps.readBanks();
  const outcomes: DocumentOutcome[] = [];

  for (const bank of scan.documents) {
    outcomes.push(await processDocument(bank, commit, deps));
  }

  const count = (pick: (o: DocumentOutcome) => CredentialField[]) =>
    outcomes.reduce((total, o) => total + pick(o).length, 0);

  const fieldsUnreadable = count((o) => o.unreadable);
  const fieldsEncrypted = count((o) => o.encrypted);

  return {
    committed: commit,
    scanned: scan.scanned,
    reportedTotal: scan.reportedTotal,
    outcomes,
    documentsChanged: outcomes.filter((o) => o.encrypted.length > 0).length,
    fieldsEncrypted,
    fieldsAlreadyEncrypted: count((o) => o.alreadyEncrypted),
    fieldsUnreadable,
    fieldsMissing: count((o) => o.missing),
    // Clean means nothing left to do AND nothing broken. A run that encrypted
    // values is not clean until a later run finds none.
    clean: fieldsUnreadable === 0 && fieldsEncrypted === 0,
  };
}

async function processDocument(
  bank: LegacyBankDocument,
  commit: boolean,
  deps: EncryptionDeps
): Promise<DocumentOutcome> {
  const outcome: DocumentOutcome = {
    documentId: bank.$id,
    encrypted: [],
    alreadyEncrypted: [],
    unreadable: [],
    missing: [],
  };

  const updates: Record<string, string> = {};

  for (const field of FIELDS) {
    const stored = bank[field];

    if (typeof stored !== "string" || stored === "") {
      outcome.missing.push(field);
      continue;
    }

    if (isEncrypted(stored)) {
      // Confirm it is readable under the CURRENT keyring. An encrypted value
      // nobody can decrypt is worse than a plaintext one: it looks fine.
      try {
        decryptCredential(stored, { recordId: bank.$id, field });
        outcome.alreadyEncrypted.push(field);
      } catch {
        // NOT REWRITTEN. Re-encrypting an unreadable value would destroy
        // whatever it is, and the cause is a key problem an operator must fix.
        outcome.unreadable.push(field);
      }
      continue;
    }

    const ciphertext = encryptCredential(stored, { recordId: bank.$id, field });

    // ROUND-TRIP BEFORE WRITING, not after. This is the only copy.
    const readBack = decryptCredential(ciphertext, {
      recordId: bank.$id,
      field,
    });
    if (!credentialsMatch(readBack, stored)) {
      throw new Error(
        `credential for ${bank.$id}.${field} did not survive a round trip; nothing was written`
      );
    }

    updates[field] = ciphertext;
    outcome.encrypted.push(field);
  }

  if (commit && Object.keys(updates).length > 0) {
    await deps.updateDocument(bank.$id, updates);
  }

  return outcome;
}
