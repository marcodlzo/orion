// Operator-only test probe. Returns account identifiers and sync evidence,
// never the access token or the opaque cursor.
import { findCounterpartyBankByAccountId } from "../lib/repositories/banks.repository";
import { plaidClient } from "../lib/plaid";
import { syncPlaidItem, defaultSyncDeps } from "../lib/plaid-sync/sync";
import { query, closePool } from "../lib/db/pool";

async function main() {
  const [mode, accountId] = process.argv.slice(2);
  if (process.env.DWOLLA_ENV !== "sandbox" || !process.env.ORION_E2E_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.ORION_E2E_DATABASE_URL) throw new Error("Test environment required");
  // BY ACCOUNT ID, FROM POSTGRESQL. This read the Appwrite bank collection
  // until the Phase 4 cutover stopped writing it.
  //
  // The lookup is unscoped by design — a probe has no actor — and it decrypts
  // at the storage boundary rather than here, so this stays the only place
  // credentials are read and nothing outside lib/repositories touches the
  // keyring.
  const bank = await findCounterpartyBankByAccountId(accountId);
  if (!bank) throw new Error("Test bank not found");
  if (mode === "accounts") {
    const response = await plaidClient.accountsGet({ access_token: bank.accessToken });
    console.log(JSON.stringify({ itemId: bank.bankId, accounts: response.data.accounts
      .filter(a => a.type === "depository").map(a => ({ id: a.account_id, name: a.name, subtype: a.subtype })) }));
  } else if (mode === "sync") {
    const before = await query<{ cursor: string | null }>("SELECT cursor FROM plaid_items WHERE item_id=$1", [bank.bankId]);
    const storedCursor = before.rows[0]?.cursor ?? null;
    const sent: Array<string | null> = [];
    const result = await syncPlaidItem({ itemId: bank.bankId, accessToken: bank.accessToken }, {
      fetchPage: token => async cursor => {
        sent.push(cursor);
        return defaultSyncDeps.fetchPage(token)(cursor);
      },
    });
    console.log(JSON.stringify({ ...result, resumed: storedCursor !== null && sent[0] === storedCursor }));
  } else throw new Error("Unknown probe");
}
main().catch(() => { console.error("Sandbox Item probe failed"); process.exitCode = 1; }).finally(closePool);
