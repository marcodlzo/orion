/**
 * Reconciliation rules.
 *
 * PURE. No database, no provider, no I/O — plain data in, findings out. This is
 * where the decisions about what counts as drift live, so they can be tested
 * exhaustively without standing anything up, including the cases that are hard
 * to produce in a real system precisely because they are supposed to be
 * impossible.
 *
 * RECONCILIATION REPORTS; IT NEVER REPAIRS. A process that silently corrects
 * drift destroys the evidence of what caused it, and the cause is the thing that
 * matters — a ledger disagreeing with a provider means something upstream is
 * wrong, and quietly editing rows until the numbers match is how a bug becomes
 * permanent. Every function here returns findings. None of them returns a fix.
 */

/** The internal view of a transfer, as reconciliation needs it. */
export type TransferSnapshot = {
  id: string;
  state:
    | "requested"
    | "submitted"
    | "settled"
    | "failed"
    | "returned"
    | "reversed";
  amountMinor: number;
  providerTransferId: string | null;
  createdAt: Date;
  /** Net of the transfer's ledger entries on the customer's own account. */
  settlementPostingId: string | null;
  reversalPostingId: string | null;
  /** Sum of every entry belonging to this transfer, which must net out. */
  postedNetMinor: number;
  /** Magnitude posted by the settlement, before any compensation. */
  settledAmountMinor: number | null;
  activeHoldMinor: number;
};

/** What the provider says about one transfer. */
export type ProviderTransferStatus =
  | "pending"
  | "processed"
  | "failed"
  | "returned"
  | "unknown";

export type FindingCode =
  /** Settled internally, but the ledger has no posting for it. */
  | "SETTLED_WITHOUT_POSTING"
  /** A posting exists for a transfer that never settled. */
  | "POSTING_WITHOUT_SETTLEMENT"
  /** Reversed internally, but nothing compensates the original. */
  | "REVERSED_WITHOUT_COMPENSATION"
  /** The posted amount does not match the transfer. */
  | "POSTED_AMOUNT_MISMATCH"
  /** A transfer's entries do not net to what its state implies. */
  | "POSTED_NET_UNEXPECTED"
  /** Terminal, but funds are still reserved. */
  | "TERMINAL_WITH_ACTIVE_HOLD"
  /** Accepted by the provider long ago and still not resolved. */
  | "STALE_SUBMITTED"
  /** Claimed long ago and never sent — a process that died mid-flight. */
  | "STALE_REQUESTED"
  /** Submitted with no provider reference to reconcile against. */
  | "SUBMITTED_WITHOUT_REFERENCE"
  /** The provider has settled it and we have not. */
  | "PROVIDER_AHEAD"
  /** The provider says it failed or returned and we still count the money. */
  | "PROVIDER_CONTRADICTS_SETTLEMENT"
  /** The provider has never heard of a reference we recorded. */
  | "PROVIDER_UNKNOWN_REFERENCE"
  /** The whole ledger does not sum to zero. */
  | "LEDGER_NOT_BALANCED";

export type Finding = {
  code: FindingCode;
  /** Internal identifier only. Never a provider URL, token, name or email. */
  transferId: string | null;
  /** Fixed-vocabulary detail. Numbers and states only. */
  detail: string;
  severity: "critical" | "warning";
};

const TERMINAL = new Set(["settled", "failed", "returned", "reversed"]);

/** How long a transfer may sit unresolved before it is worth a human looking. */
export const STALE_SUBMITTED_HOURS = 96;
export const STALE_REQUESTED_HOURS = 1;

const hoursBetween = (from: Date, to: Date): number =>
  (to.getTime() - from.getTime()) / 3_600_000;

/**
 * Everything that can be checked without asking the provider anything.
 *
 * These are the findings that indicate a bug in this system rather than a
 * disagreement with Dwolla, which is why they are separated: a
 * PROVIDER_CONTRADICTS_SETTLEMENT might be the provider's doing, but a
 * SETTLED_WITHOUT_POSTING is entirely ours.
 */
export function checkTransfer(
  transfer: TransferSnapshot,
  now: Date
): Finding[] {
  const findings: Finding[] = [];
  const say = (
    code: FindingCode,
    detail: string,
    severity: Finding["severity"] = "critical"
  ) => findings.push({ code, transferId: transfer.id, detail, severity });

  // A settled transfer the ledger has never heard of. Milestone 7 made this
  // impossible by putting both in one transaction — which is exactly why it is
  // worth checking: an invariant nobody verifies is an invariant that quietly
  // stops holding.
  if (transfer.state === "settled" && !transfer.settlementPostingId) {
    say("SETTLED_WITHOUT_POSTING", "state=settled posting=none");
  }

  if (transfer.state === "reversed") {
    if (!transfer.settlementPostingId) {
      say("SETTLED_WITHOUT_POSTING", "state=reversed posting=none");
    } else if (!transfer.reversalPostingId) {
      say("REVERSED_WITHOUT_COMPENSATION", "state=reversed compensation=none");
    }
  }

  if (
    transfer.settlementPostingId &&
    transfer.state !== "settled" &&
    transfer.state !== "reversed"
  ) {
    say("POSTING_WITHOUT_SETTLEMENT", `state=${transfer.state} posting=present`);
  }

  if (
    transfer.settledAmountMinor !== null &&
    transfer.settledAmountMinor !== transfer.amountMinor
  ) {
    say(
      "POSTED_AMOUNT_MISMATCH",
      `transfer=${transfer.amountMinor} posted=${transfer.settledAmountMinor}`
    );
  }

  // A settled transfer's entries net to zero across the two accounts, and so do
  // a reversed one's. Anything else means an unpaired entry exists.
  if (transfer.postedNetMinor !== 0) {
    say("POSTED_NET_UNEXPECTED", `net=${transfer.postedNetMinor}`);
  }

  // A terminal transfer still reserving funds permanently reduces what the
  // customer can commit, for money that is no longer in motion.
  if (TERMINAL.has(transfer.state) && transfer.activeHoldMinor > 0) {
    say(
      "TERMINAL_WITH_ACTIVE_HOLD",
      `state=${transfer.state} held=${transfer.activeHoldMinor}`
    );
  }

  if (transfer.state === "submitted") {
    if (!transfer.providerTransferId) {
      // Nothing to reconcile against, ever. This is the unrecoverable case the
      // transfer service raises TransferSubmittedButNotRecordedError for.
      say("SUBMITTED_WITHOUT_REFERENCE", "state=submitted reference=none");
    }
    const age = hoursBetween(transfer.createdAt, now);
    if (age >= STALE_SUBMITTED_HOURS) {
      say(
        "STALE_SUBMITTED",
        `hours=${Math.floor(age)} threshold=${STALE_SUBMITTED_HOURS}`,
        "warning"
      );
    }
  }

  if (transfer.state === "requested") {
    const age = hoursBetween(transfer.createdAt, now);
    if (age >= STALE_REQUESTED_HOURS) {
      // Claimed and never sent: a process died between the claim and the
      // provider call. The claim did its job — this is the evidence it exists
      // to leave.
      say(
        "STALE_REQUESTED",
        `hours=${Math.floor(age)} threshold=${STALE_REQUESTED_HOURS}`,
        "warning"
      );
    }
  }

  return findings;
}

/**
 * Compare one transfer against what the provider says about it.
 *
 * NEVER APPLIES THE PROVIDER'S VIEW. Dwolla is an adapter, not the system of
 * record; a disagreement is a finding for a human, not an instruction to
 * overwrite internal state. Auto-applying it would also make this the second
 * place settlement can happen, bypassing the signature verification that makes
 * the first one trustworthy.
 */
export function checkAgainstProvider(
  transfer: TransferSnapshot,
  providerStatus: ProviderTransferStatus
): Finding[] {
  const findings: Finding[] = [];
  const say = (
    code: FindingCode,
    detail: string,
    severity: Finding["severity"] = "critical"
  ) => findings.push({ code, transferId: transfer.id, detail, severity });

  if (providerStatus === "unknown") {
    if (transfer.providerTransferId) {
      say("PROVIDER_UNKNOWN_REFERENCE", `state=${transfer.state} provider=unknown`);
    }
    return findings;
  }

  // The provider has finished and we have not noticed — a webhook that never
  // arrived, or was never verified.
  if (providerStatus === "processed" && transfer.state === "submitted") {
    say("PROVIDER_AHEAD", "internal=submitted provider=processed", "warning");
  }

  if (
    (providerStatus === "failed" || providerStatus === "returned") &&
    transfer.state === "submitted"
  ) {
    say("PROVIDER_AHEAD", `internal=submitted provider=${providerStatus}`, "warning");
  }

  // We are counting money the provider says came back. This one is critical:
  // the ledger is overstating what moved.
  if (
    (providerStatus === "failed" || providerStatus === "returned") &&
    transfer.state === "settled"
  ) {
    say(
      "PROVIDER_CONTRADICTS_SETTLEMENT",
      `internal=settled provider=${providerStatus}`
    );
  }

  if (providerStatus === "processed" && transfer.state === "failed") {
    say("PROVIDER_CONTRADICTS_SETTLEMENT", "internal=failed provider=processed");
  }

  return findings;
}

/**
 * The ledger as a whole.
 *
 * Conservation is a property of every balanced posting, so this can only fail if
 * an entry exists without its pair — which the deferred balance trigger is meant
 * to make impossible. Checked anyway: this is the one number that, if wrong,
 * means nothing else in the ledger can be trusted.
 */
export function checkLedgerTotal(totalMinor: number): Finding[] {
  if (totalMinor === 0) return [];
  return [
    {
      code: "LEDGER_NOT_BALANCED",
      transferId: null,
      detail: `total=${totalMinor}`,
      severity: "critical",
    },
  ];
}

export type ReconciliationReport = {
  checkedTransfers: number;
  comparedWithProvider: number;
  findings: Finding[];
  /** True when nothing needs a human. */
  clean: boolean;
  criticalCount: number;
  warningCount: number;
};

/** Assemble a report from findings already gathered. */
export function summarise(input: {
  checkedTransfers: number;
  comparedWithProvider: number;
  findings: readonly Finding[];
}): ReconciliationReport {
  const findings = [...input.findings];
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warningCount = findings.length - criticalCount;

  return {
    checkedTransfers: input.checkedTransfers,
    comparedWithProvider: input.comparedWithProvider,
    findings,
    clean: findings.length === 0,
    criticalCount,
    warningCount,
  };
}
