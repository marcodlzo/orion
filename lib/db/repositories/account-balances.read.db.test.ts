import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query, withTransaction } from "../pool";
import { requireTestDatabase } from "../test-database";
import { upsertBankingCustomer } from "./banking-customers.repository";
import {
  ensureCustomerAccount,
  ensureOpeningEquityAccount,
  postTransaction,
} from "./ledger.repository";
import { getAccountBalanceSummary } from "./account-balances.read";

const ACTOR = {
  authId: "auth-balance-reader",
  userId: "userdoc-balance-reader",
  dwollaCustomerId: "dwolla-balance-reader",
};

beforeAll(() => requireTestDatabase());
afterAll(() => closePool());

beforeEach(async () => {
  await query(
    `TRUNCATE transfer_state_transitions, ledger_holds, ledger_entries,
              ledger_transactions, ledger_accounts, provider_webhook_events,
              transfers, linked_accounts, banking_customers CASCADE`
  );
});

describe("actor-scoped account balance projection", () => {
  it("derives ledger and available balances without storing either", async () => {
    const { row: customer } = await upsertBankingCustomer({
      appwriteAuthId: ACTOR.authId,
      appwriteUserDocumentId: ACTOR.userId,
    });

    await withTransaction(async (client) => {
      const account = await ensureCustomerAccount(customer.id, client);
      const equity = await ensureOpeningEquityAccount(client);
      await client.query(
        "UPDATE ledger_accounts SET credit_limit_minor = 5000 WHERE id = $1",
        [account.id]
      );
      await postTransaction(
        {
          description: "Balance projection fixture",
          kind: "opening_allocation",
          sourceReference: "balance-projection-fixture",
          lines: [
            { accountId: account.id, amountMinor: 25_00 },
            { accountId: equity.id, amountMinor: -25_00 },
          ],
        },
        client
      );
    });

    await expect(getAccountBalanceSummary(ACTOR)).resolves.toEqual({
      ledgerBalanceMinor: 25_00,
      activeHoldsMinor: 0,
      creditAllowanceMinor: 50_00,
      availableToTransferMinor: 75_00,
    });
  });

  it("returns no row when either ownership identifier differs", async () => {
    const { row: customer } = await upsertBankingCustomer({
      appwriteAuthId: ACTOR.authId,
      appwriteUserDocumentId: ACTOR.userId,
    });
    await ensureCustomerAccount(customer.id);

    await expect(
      getAccountBalanceSummary({ ...ACTOR, userId: "somebody-else" })
    ).resolves.toEqual({
      ledgerBalanceMinor: 0,
      activeHoldsMinor: 0,
      creditAllowanceMinor: 0,
      availableToTransferMinor: 0,
    });
  });
});
