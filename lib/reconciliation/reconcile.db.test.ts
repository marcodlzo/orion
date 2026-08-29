import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closePool, query, withTransaction } from "../db/pool";
import { requireTestDatabase } from "../db/test-database";
import { upsertBankingCustomer } from "../db/repositories/banking-customers.repository";
import {
  claimTransfer,
  markSubmitted,
  markTerminal,
} from "../db/repositories/transfers.repository";
import {
  ensureCustomerAccount,
  ensureSettlementAccount,
  postTransaction,
  reverseTransaction,
} from "../db/repositories/ledger.repository";
import { placeHold } from "../db/repositories/holds.repository";
import { reconcile } from "./reconcile";
import { formatReconciliationReport, exitCodeFor } from "./report";

/**
 * RECONCILIATION AGAINST A REAL SERVER.
 *
 * Two things are being proven. First, that a healthy system reconciles clean —
 * without which every drift assertion below is meaningless, because a reconciler
 * that reports problems for correct data reports nothing at all. Second, that it
 * WRITES NOTHING: the whole value of a reconciler is that it observes, and one
 * that repairs destroys the evidence of what went wrong.
 */

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query(
    `TRUNCATE transfer_state_transitions, ledger_holds, ledger_entries,
              ledger_transactions, ledger_accounts, provider_webhook_events,
              transfers, linked_accounts, banking_customers CASCADE`
  );
});

async function customer(n = 1) {
  const { row } = await upsertBankingCustomer({
    appwriteAuthId: `auth-${n}-${randomUUID()}`,
    appwriteUserDocumentId: `doc-${n}-${randomUUID()}`,
  });
  return row.id;
}

async function claimed(customerId: string, amountMinor = 100_00) {
  const claim = await claimTransfer({
    customerId,
    idempotencyKey: randomUUID(),
    requestFingerprint: `fp-${randomUUID()}`,
    amountMinor,
    currency: "USD",
  });
  return claim.row.id;
}

async function submitted(customerId: string, amountMinor = 100_00) {
  const transferId = await claimed(customerId, amountMinor);
  await withTransaction(async (client) => {
    const account = await ensureCustomerAccount(customerId, client);
    await placeHold({ accountId: account.id, transferId, amountMinor }, client);
  });
  await markSubmitted({ transferId, providerTransferId: `xfer-${randomUUID()}` });
  return transferId;
}

/** A fully healthy settled transfer: state, posting and hold all agreeing. */
async function settled(customerId: string, amountMinor = 100_00) {
  const transferId = await submitted(customerId, amountMinor);

  await withTransaction(async (client) => {
    await markTerminal({ transferId, outcome: "settled" }, client);
    await client.query(
      "UPDATE ledger_holds SET state = 'captured', resolved_at = now() WHERE transfer_id = $1",
      [transferId]
    );
    const account = await ensureCustomerAccount(customerId, client);
    const settlement = await ensureSettlementAccount(client);
    await postTransaction(
      {
        description: `transfer ${transferId} settled`,
        transferId,
        lines: [
          { accountId: account.id, amountMinor: -amountMinor },
          { accountId: settlement.id, amountMinor },
        ],
      },
      client
    );
  });

  return transferId;
}

const codesOf = (report: Awaited<ReturnType<typeof reconcile>>) =>
  report.findings.map((f) => f.code).sort();

describe("a healthy ledger reconciles clean", () => {
  it("finds nothing wrong with settled, failed and in-flight transfers", async () => {
    // WITHOUT THIS TEST NOTHING ELSE HERE MEANS ANYTHING. A reconciler that
    // flags correct data is a reconciler nobody reads.
    const c = await customer();
    await settled(c, 100_00);
    await settled(c, 45_50);

    const failing = await submitted(c, 10_00);
    await withTransaction(async (client) => {
      await markTerminal({ transferId: failing, outcome: "failed" }, client);
      await client.query(
        "UPDATE ledger_holds SET state = 'released', resolved_at = now() WHERE transfer_id = $1",
        [failing]
      );
    });

    await submitted(c, 20_00); // still in flight, hold active — legitimate

    const report = await reconcile();

    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.checkedTransfers).toBe(4);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("reconciles a reversed transfer clean", async () => {
    const c = await customer();
    const transferId = await settled(c, 60_00);

    await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM ledger_transactions WHERE transfer_id = $1 AND kind = 'settlement'",
        [transferId]
      );
      await reverseTransaction(
        { transactionId: rows[0].id, description: "returned" },
        client
      );
      await client.query(
        "UPDATE transfers SET state = 'reversed', reversed_at = now() WHERE id = $1",
        [transferId]
      );
    });

    expect((await reconcile()).findings).toEqual([]);
  });

  it("says clean on an empty database", async () => {
    const report = await reconcile();
    expect(report.clean).toBe(true);
    expect(report.checkedTransfers).toBe(0);
  });
});

describe("drift is detected", () => {
  it("finds a settled transfer the ledger has never heard of", async () => {
    // Forced directly, because no code path can produce it: the state change
    // and the posting share a transaction. That is the invariant under test.
    const c = await customer();
    const transferId = await submitted(c, 100_00);
    await query(
      "UPDATE transfers SET state = 'settled', settled_at = now() WHERE id = $1",
      [transferId]
    );

    const report = await reconcile();

    expect(codesOf(report)).toEqual([
      "SETTLED_WITHOUT_POSTING",
      "TERMINAL_WITH_ACTIVE_HOLD",
    ]);
    expect(report.criticalCount).toBe(2);
    expect(exitCodeFor(report)).toBe(2);
  });

  it("finds a finished transfer that is still reserving funds", async () => {
    const c = await customer();
    const transferId = await submitted(c, 100_00);

    // Terminal, but nobody released the hold — the failure Milestone 8's
    // release path exists to prevent.
    await withTransaction((client) =>
      markTerminal({ transferId, outcome: "failed" }, client)
    );

    const report = await reconcile();
    expect(codesOf(report)).toEqual(["TERMINAL_WITH_ACTIVE_HOLD"]);
  });

  it("finds a transfer submitted long ago and never resolved", async () => {
    const c = await customer();
    const transferId = await submitted(c, 100_00);
    await query("UPDATE transfers SET created_at = now() - interval '10 days' WHERE id = $1", [
      transferId,
    ]);

    const report = await reconcile();

    expect(codesOf(report)).toEqual(["STALE_SUBMITTED"]);
    // A warning is still not clean: something needs a human.
    expect(report.clean).toBe(false);
    expect(exitCodeFor(report)).toBe(1);
  });

  it("finds a claim that never reached the provider", async () => {
    const c = await customer();
    const transferId = await claimed(c, 100_00);
    await query("UPDATE transfers SET created_at = now() - interval '2 days' WHERE id = $1", [
      transferId,
    ]);

    expect(codesOf(await reconcile())).toEqual(["STALE_REQUESTED"]);
  });

  it("finds a posting whose amount does not match its transfer", async () => {
    const c = await customer();
    const transferId = await submitted(c, 100_00);

    await withTransaction(async (client) => {
      await markTerminal({ transferId, outcome: "settled" }, client);
      await client.query(
        "UPDATE ledger_holds SET state = 'captured', resolved_at = now() WHERE transfer_id = $1",
        [transferId]
      );
      const account = await ensureCustomerAccount(c, client);
      const settlement = await ensureSettlementAccount(client);
      // Balanced, so the ledger's own triggers are satisfied — and still wrong,
      // because it does not match the transfer it claims to settle.
      await postTransaction(
        {
          description: "wrong amount",
          transferId,
          lines: [
            { accountId: account.id, amountMinor: -99_00 },
            { accountId: settlement.id, amountMinor: 99_00 },
          ],
        },
        client
      );
    });

    const report = await reconcile();
    expect(codesOf(report)).toEqual(["POSTED_AMOUNT_MISMATCH"]);
    expect(report.findings[0].detail).toBe("transfer=10000 posted=9900");
  });
});

describe("comparing against the provider", () => {
  it("flags a settlement the provider says did not stand", async () => {
    const c = await customer();
    await settled(c, 100_00);

    const report = await reconcile({
      readProviderStatus: async () => "returned",
    });

    expect(codesOf(report)).toEqual(["PROVIDER_CONTRADICTS_SETTLEMENT"]);
    expect(report.comparedWithProvider).toBe(1);
  });

  it("CHANGES NOTHING when the provider disagrees", async () => {
    // The provider is an adapter, not the system of record. Applying its view
    // here would make this a second place settlement can happen, bypassing the
    // signature verification that makes the first one trustworthy.
    const c = await customer();
    const transferId = await settled(c, 100_00);

    const before = await query(
      "SELECT state, settled_at, reversed_at FROM transfers WHERE id = $1",
      [transferId]
    );
    const entriesBefore = await query(
      "SELECT count(*)::text AS n FROM ledger_entries",
      []
    );

    await reconcile({ readProviderStatus: async () => "returned" });

    const after = await query(
      "SELECT state, settled_at, reversed_at FROM transfers WHERE id = $1",
      [transferId]
    );
    const entriesAfter = await query(
      "SELECT count(*)::text AS n FROM ledger_entries",
      []
    );

    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(entriesAfter.rows[0]).toEqual(entriesBefore.rows[0]);

    // Not even an audit row: nothing transitioned, because nothing was written.
    const { rows } = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM transfer_state_transitions WHERE transfer_id = $1",
      [transferId]
    );
    expect(Number(rows[0].n)).toBe(3); // requested, submitted, settled
  });

  it("keeps the internal findings when the provider is unreachable", async () => {
    // A provider outage must not discard a report that already found real
    // problems in our own data.
    const c = await customer();
    const transferId = await submitted(c, 100_00);
    await query(
      "UPDATE transfers SET state = 'settled', settled_at = now() WHERE id = $1",
      [transferId]
    );

    const report = await reconcile({
      readProviderStatus: async () => {
        throw new Error("dwolla is down");
      },
    });

    expect(codesOf(report)).toEqual([
      "PROVIDER_UNKNOWN_REFERENCE",
      "SETTLED_WITHOUT_POSTING",
      "TERMINAL_WITH_ACTIVE_HOLD",
    ]);
  });

  it("does not ask the provider about transfers with no reference", async () => {
    const c = await customer();
    await claimed(c, 100_00);

    const reader = vi.fn(async () => "processed" as const);
    const report = await reconcile({ readProviderStatus: reader });

    expect(reader).not.toHaveBeenCalled();
    expect(report.comparedWithProvider).toBe(0);
  });

  it("runs the internal checks with no provider at all", async () => {
    const c = await customer();
    await settled(c, 100_00);

    const report = await reconcile();

    expect(report.clean).toBe(true);
    expect(report.comparedWithProvider).toBe(0);
  });
});

describe("the operator report", () => {
  it("names findings and states plainly that nothing was changed", async () => {
    const c = await customer();
    const transferId = await submitted(c, 100_00);
    await query(
      "UPDATE transfers SET state = 'settled', settled_at = now() WHERE id = $1",
      [transferId]
    );

    const lines = formatReconciliationReport(await reconcile());
    const text = lines.join("\n");

    expect(text).toContain("SETTLED_WITHOUT_POSTING");
    expect(text).toContain("NOTHING WAS CHANGED");
  });

  it("prints no provider URL, token or funding source", async () => {
    // An operator report ends up in a terminal, a CI log and often a pasted
    // message. Nothing sensitive may reach it.
    const c = await customer();
    const transferId = await submitted(c, 100_00);
    await query(
      "UPDATE transfers SET provider_transfer_id = $2 WHERE id = $1",
      [transferId, "https://api.dwolla.com/funding-sources/abc-secret"]
    );
    await query(
      "UPDATE transfers SET created_at = now() - interval '10 days' WHERE id = $1",
      [transferId]
    );

    const text = formatReconciliationReport(await reconcile()).join("\n");

    expect(text).not.toContain("funding-sources");
    expect(text).not.toContain("abc-secret");
    expect(text).not.toContain("api.dwolla.com");
  });

  it("does not claim more than it checked", async () => {
    const c = await customer();
    await settled(c, 100_00);

    const text = formatReconciliationReport(await reconcile()).join("\n");

    expect(text).toContain("No drift found.");
    // The honest caveat: only transfers with a reference could be compared, and
    // with no provider reader nothing was compared at all.
    expect(text).toContain("does NOT mean every transfer reached the provider");
  });
});
