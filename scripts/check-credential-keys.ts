/**
 * Verify the credential-encryption keyring is configured correctly.
 *
 *   npm run credentials:check
 *
 * PRINTS NO KEY MATERIAL, EVER. It reports key ids, byte lengths and whether a
 * round trip works — everything needed to know the configuration is right, and
 * nothing that would compromise it if this output were pasted into a chat, an
 * issue or a CI log. That constraint is why it exists as a command rather than
 * as an ad-hoc console.log somebody writes when they need it.
 *
 * The checking itself lives in `lib/crypto/self-test.ts`, inside the crypto
 * boundary. This file only renders the result: encrypt and decrypt stay confined
 * to `lib/crypto/`, the storage boundary and the migration, and an operator
 * command does not become a third place handling ciphertext.
 *
 * Run it after setting a key for the first time, and after any rotation. It
 * catches the failures that otherwise surface much later and much worse: a
 * truncated paste, a missing `keyId:` prefix, an active key id naming a key that
 * is not present, or a key that cannot actually encrypt and decrypt.
 *
 * Exit codes:  0 usable   1 misconfigured
 */
import { checkKeyring } from "../lib/crypto/self-test";

const RULE = "─".repeat(64);

function main(): number {
  const result = checkKeyring();

  console.log(RULE);
  console.log("CREDENTIAL ENCRYPTION KEYS");
  console.log(RULE);

  if (result.keyIds.length > 0) {
    console.log(`keys available   ${result.keyIds.join(", ")}`);
    console.log(`active key       ${result.activeKeyId}`);
    for (const id of result.keyIds) {
      console.log(`  ${id}  ${result.keyBytes[id]} bytes`);
    }
    console.log("");
  }

  if (!result.usable) {
    console.error(`NOT USABLE: ${result.problem ?? "unknown problem"}`);
    return 1;
  }

  console.log("Round trip OK, and ciphertext is bound to its record.");
  console.log("");
  console.log("This keyring can encrypt and read provider credentials.");
  return 0;
}

process.exit(main());
