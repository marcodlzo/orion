import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptStoredCredentials } from "./credential-encryption";
import { encryptCredential, isEncrypted } from "../crypto/envelope";
import { resetKeyringCache } from "../crypto/keyring";

/**
 * THE MIGRATION THAT REWRITES THE ONLY COPY OF A CREDENTIAL.
 *
 * Every assertion here is about not losing one. A bug in this path does not lose
 * a row — it loses somebody's access to their bank account, and the failure is
 * silent until they try to move money.
 *
 * Keys are generated per run. No key material is committed, and the fixtures are
 * deliberately not shaped like real provider tokens.
 */

// A keyring for the whole file, set before anything imports it lazily.
const KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEYS = `k1:${KEY}`;
  process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = "k1";
  resetKeyringCache();
});

const bank = (over: Record<string, unknown> = {}) => ({
  $id: "bank-doc-1",
  userId: "user-doc-1",
  accountId: "acct-1",
  bankId: "item-1",
  accessToken: "plaintext-credential-a",
  fundingSourceUrl: "https://provider.invalid/funding-sources/one",
  shareableId: "share-1",
  ...over,
});

function harness(documents: Record<string, unknown>[]) {
  const updateDocument = vi.fn(async () => undefined);
  const readBanks = vi.fn(async () => ({
    documents: documents as never,
    scanned: documents.length,
    reportedTotal: documents.length,
    pages: 1,
    complete: true,
    fingerprint: "test-fingerprint",
  }));

  return { readBanks, updateDocument, deps: { readBanks, updateDocument } };
}

describe("dry run", () => {
  it("WRITES NOTHING by default", () => {
    // The default has to be safe: this rewrites the only copy of a credential.
    const { updateDocument, deps } = harness([bank()]);

    return encryptStoredCredentials({}, deps).then((report) => {
      expect(updateDocument).not.toHaveBeenCalled();
      expect(report.committed).toBe(false);
      // It still reports exactly what it WOULD do.
      expect(report.fieldsEncrypted).toBe(2);
      expect(report.documentsChanged).toBe(1);
    });
  });

  it("writes nothing when commit is anything other than true", async () => {
    const { updateDocument, deps } = harness([bank()]);

    await encryptStoredCredentials({ commit: undefined }, deps);
    // A truthy-but-not-true value must not be read as consent.
    await encryptStoredCredentials({ commit: "yes" as unknown as boolean }, deps);

    expect(updateDocument).not.toHaveBeenCalled();
  });
});

describe("committing", () => {
  it("encrypts both credential fields", async () => {
    const { updateDocument, deps } = harness([bank()]);

    const report = await encryptStoredCredentials({ commit: true }, deps);

    expect(updateDocument).toHaveBeenCalledTimes(1);
    const [documentId, data] = updateDocument.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];

    expect(documentId).toBe("bank-doc-1");
    expect(isEncrypted(data.accessToken)).toBe(true);
    expect(isEncrypted(data.fundingSourceUrl)).toBe(true);
    expect(report.fieldsEncrypted).toBe(2);
  });

  it("writes NO PLAINTEXT into the update", async () => {
    const { updateDocument, deps } = harness([bank()]);

    await encryptStoredCredentials({ commit: true }, deps);

    const written = JSON.stringify(updateDocument.mock.calls[0]);
    expect(written).not.toContain("plaintext-credential-a");
    expect(written).not.toContain("provider.invalid");
  });

  it("updates nothing but the credential fields", async () => {
    // A migration that rewrote the whole document could clobber a field it did
    // not understand.
    const { updateDocument, deps } = harness([bank()]);

    await encryptStoredCredentials({ commit: true }, deps);

    const [, data] = updateDocument.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];
    expect(Object.keys(data).sort()).toEqual(["accessToken", "fundingSourceUrl"]);
  });

  it("binds each ciphertext to its own document", async () => {
    // Two documents must not produce interchangeable ciphertexts — that binding
    // is what stops one being copied into the other's record.
    const { updateDocument, deps } = harness([
      bank(),
      bank({ $id: "bank-doc-2", accessToken: "plaintext-credential-b" }),
    ]);

    await encryptStoredCredentials({ commit: true }, deps);

    const first = (updateDocument.mock.calls[0] as unknown as [string, Record<string, string>])[1];
    const second = (updateDocument.mock.calls[1] as unknown as [string, Record<string, string>])[1];

    expect(first.accessToken).not.toBe(second.accessToken);
  });
});

describe("re-runnable", () => {
  it("skips values that are already encrypted", async () => {
    const already = encryptCredential("already-secret", {
      recordId: "bank-doc-1",
      field: "accessToken",
    });
    const { updateDocument, deps } = harness([bank({ accessToken: already })]);

    const report = await encryptStoredCredentials({ commit: true }, deps);

    expect(report.fieldsAlreadyEncrypted).toBe(1);
    expect(report.fieldsEncrypted).toBe(1); // only fundingSourceUrl

    const [, data] = updateDocument.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];
    expect(data).not.toHaveProperty("accessToken");
  });

  it("reports clean once everything is encrypted", async () => {
    const { deps } = harness([
      bank({
        accessToken: encryptCredential("a", {
          recordId: "bank-doc-1",
          field: "accessToken",
        }),
        fundingSourceUrl: encryptCredential("b", {
          recordId: "bank-doc-1",
          field: "fundingSourceUrl",
        }),
      }),
    ]);

    const report = await encryptStoredCredentials({ commit: true }, deps);

    expect(report.clean).toBe(true);
    expect(report.fieldsEncrypted).toBe(0);
  });

  it("is not clean immediately after encrypting something", async () => {
    // A run that did work is not proof the job is done — only a later run that
    // finds nothing is.
    const { deps } = harness([bank()]);

    const report = await encryptStoredCredentials({ commit: true }, deps);

    expect(report.fieldsEncrypted).toBe(2);
    expect(report.clean).toBe(false);
  });
});

describe("values it must not touch", () => {
  it("REFUSES TO REWRITE an encrypted value it cannot read", async () => {
    // THE MOST DESTRUCTIVE THING THIS SCRIPT COULD DO. Re-encrypting a value
    // that is already ciphertext destroys it permanently. The cause is a key
    // problem an operator must fix, so it is reported and left alone.
    const foreign = encryptCredential(
      "written-under-another-key",
      { recordId: "bank-doc-1", field: "accessToken" },
      { active: { id: "kx", material: randomBytes(32) },
        byId: new Map([["kx", { id: "kx", material: randomBytes(32) }]]) }
    );

    const { updateDocument, deps } = harness([bank({ accessToken: foreign })]);

    const report = await encryptStoredCredentials({ commit: true }, deps);

    expect(report.fieldsUnreadable).toBe(1);
    expect(report.clean).toBe(false);

    const [, data] = updateDocument.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];
    expect(data).not.toHaveProperty("accessToken");
  });

  it("reports a missing credential rather than encrypting an empty string", async () => {
    // Encrypting "" would store a valid-looking ciphertext for a credential
    // that does not exist.
    const { updateDocument, deps } = harness([
      bank({ accessToken: "", fundingSourceUrl: undefined }),
    ]);

    const report = await encryptStoredCredentials({ commit: true }, deps);

    expect(report.fieldsMissing).toBe(2);
    expect(report.fieldsEncrypted).toBe(0);
    expect(updateDocument).not.toHaveBeenCalled();
  });
});

describe("the report carries no secret", () => {
  it("holds only ids, field names and counts", async () => {
    const { deps } = harness([bank(), bank({ $id: "bank-doc-2" })]);

    const report = await encryptStoredCredentials({ commit: true }, deps);
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain("plaintext-credential-a");
    expect(serialised).not.toContain("provider.invalid");
    // Not even the ciphertext, which would let anyone with the key read it.
    expect(serialised).not.toMatch(/v1\.k1\./);

    for (const outcome of report.outcomes) {
      expect(Object.keys(outcome).sort()).toEqual([
        "alreadyEncrypted",
        "documentId",
        "encrypted",
        "missing",
        "unreadable",
      ]);
    }
  });
});

describe("completeness", () => {
  it("carries the scan totals through so a partial read is visible", async () => {
    // The caller refuses to report on a partial sweep, and can only do that if
    // these two numbers survive.
    const readBanks = vi.fn(async () => ({
      documents: [bank()] as never,
      scanned: 1,
      reportedTotal: 40,
      pages: 1,
      complete: false,
      fingerprint: "test-fingerprint",
    }));

    const report = await encryptStoredCredentials(
      {},
      { readBanks, updateDocument: vi.fn(async () => undefined) }
    );

    expect(report.scanned).toBe(1);
    expect(report.reportedTotal).toBe(40);
  });
});
