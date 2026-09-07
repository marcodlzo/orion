import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// Next installs this before loading its React server runtime. The renderer uses
// it to retain the request's cache through awaits and concurrent server renders.
Object.defineProperty(globalThis, "AsyncLocalStorage", {
  value: AsyncLocalStorage,
  configurable: true,
});

/**
 * Test environment bootstrap.
 *
 * Placeholder values only. Tests never touch Appwrite, Plaid or Dwolla — the
 * SDKs are mocked at the module boundary. These exist because several modules
 * read process.env at import time and one (lib/actions/dwolla.actions.ts)
 * throws at module load when DWOLLA_ENV is absent.
 *
 * If a test ever needs a real credential, the test is wrong: contract tests
 * belong against provider sandboxes, never against live accounts.
 */
const TEST_ENV: Record<string, string> = {
  NEXT_PUBLIC_APPWRITE_ENDPOINT: "https://test.invalid/v1",
  NEXT_PUBLIC_APPWRITE_PROJECT: "test-project",
  NEXT_APPWRITE_KEY: "test-key",
  APPWRITE_DATABASE_ID: "test-db",
  APPWRITE_USER_COLLECTION_ID: "test-users",
  APPWRITE_BANK_COLLECTION_ID: "test-banks",
  APPWRITE_TRANSACTION_COLLECTION_ID: "test-transactions",
  PLAID_CLIENT_ID: "test-plaid-client",
  PLAID_SECRET: "test-plaid-secret",
  DWOLLA_KEY: "test-dwolla-key",
  DWOLLA_SECRET: "test-dwolla-secret",
  DWOLLA_ENV: "sandbox",

  /**
   * GENERATED PER RUN, never committed and never reused.
   *
   * Required since reads stopped tolerating a plaintext credential. Before that,
   * a fixture could carry a bare string and the repository would hand it back
   * unchanged; now every stored credential must be real ciphertext, so the
   * suite needs a real keyring to build one with.
   *
   * A fresh 32 bytes each run is deliberate. A fixed key in this file would be
   * committed key material, and the fact that it only ever protects fixtures is
   * exactly the reasoning that lets a real one land the same way.
   */
  CREDENTIAL_ENCRYPTION_KEYS: `test-key:${randomBytes(32).toString("base64")}`,
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "test-key",
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] ??= value;
}
