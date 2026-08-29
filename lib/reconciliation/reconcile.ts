// Server-only. Operator tooling: compares the ledger against itself and against
// the provider, and REPORTS. It never writes.
//
// Unreachable from any request path, like lib/migration. Reconciliation reads
// every transfer regardless of who owns it — correct for an operator sweep,
// catastrophic in a request. The import-boundary suite enforces that.
import "server-only";

import { query } from "../db/pool";
import { readMoneyMinor } from "../db/pool";
import {
  checkAgainstProvider,
  checkLedgerTotal,
  checkTransfer,
  summarise,
  type Finding,
  type ProviderTransferStatus,
  type ReconciliationReport,
  type TransferSnapshot,
} from "./checks";

/**
 * Reads provider status for a transfer reference.
 *
 * INJECTED. The reconciler must be runnable against a real database with no
 * provider at all — the internal checks are the ones that catch our own bugs,
 * and they should not be blocked on network access or credentials. It also
 * keeps the tests off the network entirely.
 */
export type ProviderStatusReader = (
  providerTransferId: string
) => Promise<ProviderTransferStatus>;

type TransferQueryRow = {
  id: string;
  state: TransferSnapshot["state"];
  amount_minor: string;
  provider_transfer_id: string | null;
  created_at: Date;
  settlement_posting_id: string | null;
  reversal_posting_id: string | null;
  posted_net_minor: string;
  settled_amount_minor: string | null;
  active_hold_minor: string;
};

/**
 * One query, one row per transfer, everything the rules need.
 *
 * Assembled in SQL rather than by looping because a per-transfer round trip
 * reads a moving target: rows change between iterations and the report ends up
 * describing a state the system was never in.
 */
const SNAPSHOT_SQL = `
  SELECT
    t.id,
    t.state,
    t.amount_minor::text                              AS amount_minor,
    t.provider_transfer_id,
    t.created_at,
    settlement.id                                     AS settlement_posting_id,
    reversal.id                                       AS reversal_posting_id,
    COALESCE(posted.net_minor, 0)::text               AS posted_net_minor,
    settled.amount_minor::text                        AS settled_amount_minor,
    COALESCE(holds.held_minor, 0)::text               AS active_hold_minor
  FROM transfers t

  LEFT JOIN ledger_transactions settlement
    ON settlement.transfer_id = t.id AND settlement.kind = 'settlement'

  LEFT JOIN ledger_transactions reversal
    ON reversal.reverses_transaction_id = settlement.id

  LEFT JOIN LATERAL (
    SELECT sum(e.amount_minor) AS net_minor
      FROM ledger_entries e
      JOIN ledger_transactions lt ON lt.id = e.transaction_id
     WHERE lt.transfer_id = t.id
  ) posted ON TRUE

  -- The magnitude the settlement actually moved: the positive side of the pair.
  LEFT JOIN LATERAL (
    SELECT max(e.amount_minor) AS amount_minor
      FROM ledger_entries e
     WHERE e.transaction_id = settlement.id AND e.amount_minor > 0
  ) settled ON TRUE

  LEFT JOIN LATERAL (
    SELECT sum(h.amount_minor) AS held_minor
      FROM ledger_holds h
     WHERE h.transfer_id = t.id AND h.state = 'active'
  ) holds ON TRUE

  ORDER BY t.created_at, t.id
`;

function toSnapshot(row: TransferQueryRow): TransferSnapshot {
  return {
    id: row.id,
    state: row.state,
    amountMinor: readMoneyMinor(row.amount_minor),
    providerTransferId: row.provider_transfer_id,
    createdAt: row.created_at,
    settlementPostingId: row.settlement_posting_id,
    reversalPostingId: row.reversal_posting_id,
    postedNetMinor: readMoneyMinor(row.posted_net_minor),
    settledAmountMinor:
      row.settled_amount_minor === null
        ? null
        : readMoneyMinor(row.settled_amount_minor),
    activeHoldMinor: readMoneyMinor(row.active_hold_minor),
  };
}

/**
 * Compare everything, and report.
 *
 * WRITES NOTHING. Not a single UPDATE, and no code path here can reach one —
 * the only database call is the SELECT above plus one aggregate. If a future
 * version wants to repair drift, that is a separate, explicitly invoked tool
 * with its own audit trail, not a flag on this one.
 */
export async function reconcile(
  options: {
    /** Omit to run the internal checks only. */
    readProviderStatus?: ProviderStatusReader;
    now?: Date;
  } = {}
): Promise<ReconciliationReport> {
  const now = options.now ?? new Date();

  const { rows } = await query<TransferQueryRow>(SNAPSHOT_SQL, []);
  const snapshots = rows.map(toSnapshot);

  const findings: Finding[] = [];

  const { rows: totals } = await query<{ total: string }>(
    "SELECT COALESCE(sum(amount_minor), 0)::text AS total FROM ledger_entries",
    []
  );
  findings.push(...checkLedgerTotal(readMoneyMinor(totals[0].total)));

  let comparedWithProvider = 0;

  for (const snapshot of snapshots) {
    findings.push(...checkTransfer(snapshot, now));

    if (!options.readProviderStatus || !snapshot.providerTransferId) continue;

    // A provider that is down or slow must not lose the internal findings
    // already gathered. The failure becomes a finding of its own shape —
    // unknown — rather than an exception that discards the report.
    let status: ProviderTransferStatus;
    try {
      status = await options.readProviderStatus(snapshot.providerTransferId);
    } catch {
      status = "unknown";
    }

    comparedWithProvider += 1;
    findings.push(...checkAgainstProvider(snapshot, status));
  }

  return summarise({
    checkedTransfers: snapshots.length,
    comparedWithProvider,
    findings,
  });
}
