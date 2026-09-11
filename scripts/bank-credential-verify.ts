import { closePool } from "../lib/db/pool";
import { verifyBankCredentialCutover } from "../lib/migration/bank-credential-verifier";

verifyBankCredentialCutover()
  .then(async ({ checked }) => {
    console.log(`BANK CREDENTIAL CUTOVER VERIFIED — ${checked} record(s)`);
    await closePool();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Credential verification failed");
    await closePool();
    process.exitCode = 1;
  });
