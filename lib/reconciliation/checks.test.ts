import { describe, expect, it } from "vitest";

import {
  checkAgainstProvider,
  checkLedgerTotal,
  checkTransfer,
  summarise,
  STALE_REQUESTED_HOURS,
  STALE_SUBMITTED_HOURS,
  type ProviderTransferStatus,
  type TransferSnapshot,
} from "./checks";

/**
 * The reconciliation rules, tested exhaustively because they are pure.
 *
 * Several of the states below are supposed to be IMPOSSIBLE — a settled
 * transfer with no posting cannot be created through any code path, because the
 * state change and the posting share a transaction. That is exactly why the
 * rule exists and why it is tested here rather than only against a database: an
 * invariant nobody checks is one that quietly stops holding, and by the time it
 * does, the code path that broke it will not be the one that made the promise.
 */

const NOW = new Date("2026-08-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const snapshot = (over: Partial<TransferSnapshot> = {}): TransferSnapshot => ({
  id: "transfer-1",
  state: "settled",
  amountMinor: 100_00,
  providerTransferId: "xfer-1",
  createdAt: hoursAgo(1),
  settlementPostingId: "posting-1",
  reversalPostingId: null,
  postedNetMinor: 0,
  settledAmountMinor: 100_00,
  activeHoldMinor: 0,
  ...over,
});

const codes = (findings: ReturnType<typeof checkTransfer>) =>
  findings.map((f) => f.code).sort();

describe("a consistent transfer produces no findings", () => {
  it("settled, posted, nothing held", () => {
    expect(checkTransfer(snapshot(), NOW)).toEqual([]);
  });

  it("reversed, posted and compensated", () => {
    expect(
      checkTransfer(
        snapshot({ state: "reversed", reversalPostingId: "posting-2" }),
        NOW
      )
    ).toEqual([]);
  });

  it("failed, with nothing posted and nothing held", () => {
    expect(
      checkTransfer(
        snapshot({
          state: "failed",
          settlementPostingId: null,
          settledAmountMinor: null,
        }),
        NOW
      )
    ).toEqual([]);
  });

  it("recently submitted and awaiting settlement", () => {
    expect(
      checkTransfer(
        snapshot({
          state: "submitted",
          settlementPostingId: null,
          settledAmountMinor: null,
          activeHoldMinor: 100_00,
          createdAt: hoursAgo(2),
        }),
        NOW
      )
    ).toEqual([]);
  });
});

describe("the ledger disagreeing with the transfer", () => {
  it("flags a settled transfer the ledger has never heard of", () => {
    // Milestone 7 made this impossible by putting the state change and the
    // posting in one transaction. Checked anyway — that is the whole job.
    const findings = checkTransfer(
      snapshot({ settlementPostingId: null, settledAmountMinor: null }),
      NOW
    );

    expect(codes(findings)).toEqual(["SETTLED_WITHOUT_POSTING"]);
    expect(findings[0].severity).toBe("critical");
  });

  it("flags entries for a transfer that never settled", () => {
    expect(
      codes(checkTransfer(snapshot({ state: "submitted" }), NOW))
    ).toEqual(["POSTING_WITHOUT_SETTLEMENT"]);
  });

  it("flags a reversed transfer with nothing compensating it", () => {
    expect(
      codes(checkTransfer(snapshot({ state: "reversed" }), NOW))
    ).toEqual(["REVERSED_WITHOUT_COMPENSATION"]);
  });

  it("flags a reversed transfer that never had a posting at all", () => {
    expect(
      codes(
        checkTransfer(
          snapshot({
            state: "reversed",
            settlementPostingId: null,
            settledAmountMinor: null,
          }),
          NOW
        )
      )
    ).toEqual(["SETTLED_WITHOUT_POSTING"]);
  });

  it("flags a posted amount that differs from the transfer", () => {
    const findings = checkTransfer(snapshot({ settledAmountMinor: 99_99 }), NOW);

    expect(codes(findings)).toEqual(["POSTED_AMOUNT_MISMATCH"]);
    // The detail carries the numbers an operator needs and nothing else.
    expect(findings[0].detail).toBe("transfer=10000 posted=9999");
  });

  it("flags entries that do not net out", () => {
    // An unpaired entry. The deferred balance trigger should make this
    // impossible; a non-zero net means it did not.
    expect(codes(checkTransfer(snapshot({ postedNetMinor: -50 }), NOW))).toEqual([
      "POSTED_NET_UNEXPECTED",
    ]);
  });

  it("flags a finished transfer that is still reserving funds", () => {
    for (const state of ["settled", "failed", "returned", "reversed"] as const) {
      const findings = checkTransfer(
        snapshot({
          state,
          activeHoldMinor: 100_00,
          reversalPostingId: state === "reversed" ? "posting-2" : null,
          settlementPostingId: ["settled", "reversed"].includes(state)
            ? "posting-1"
            : null,
          settledAmountMinor: ["settled", "reversed"].includes(state)
            ? 100_00
            : null,
        }),
        NOW
      );

      expect(codes(findings), `state ${state}`).toContain("TERMINAL_WITH_ACTIVE_HOLD");
    }
  });

  it("does not flag a hold on a transfer still in flight", () => {
    expect(
      codes(
        checkTransfer(
          snapshot({
            state: "submitted",
            settlementPostingId: null,
            settledAmountMinor: null,
            activeHoldMinor: 100_00,
          }),
          NOW
        )
      )
    ).toEqual([]);
  });
});

describe("transfers that have stopped moving", () => {
  it("flags a submitted transfer older than the threshold", () => {
    const findings = checkTransfer(
      snapshot({
        state: "submitted",
        settlementPostingId: null,
        settledAmountMinor: null,
        createdAt: hoursAgo(STALE_SUBMITTED_HOURS + 1),
      }),
      NOW
    );

    expect(codes(findings)).toEqual(["STALE_SUBMITTED"]);
    // A warning, not critical: ACH is genuinely slow, and this is "look at it",
    // not "the ledger is wrong".
    expect(findings[0].severity).toBe("warning");
  });

  it("does not flag one just under the threshold", () => {
    expect(
      codes(
        checkTransfer(
          snapshot({
            state: "submitted",
            settlementPostingId: null,
            settledAmountMinor: null,
            createdAt: hoursAgo(STALE_SUBMITTED_HOURS - 1),
          }),
          NOW
        )
      )
    ).toEqual([]);
  });

  it("flags a claim that was never sent", () => {
    // The evidence the durable claim exists to leave: a process died between
    // claiming the key and calling the provider.
    const findings = checkTransfer(
      snapshot({
        state: "requested",
        providerTransferId: null,
        settlementPostingId: null,
        settledAmountMinor: null,
        createdAt: hoursAgo(STALE_REQUESTED_HOURS + 1),
      }),
      NOW
    );

    expect(codes(findings)).toEqual(["STALE_REQUESTED"]);
  });

  it("flags a submitted transfer with no provider reference", () => {
    // Unreconcilable forever: Dwolla accepted it and returned no location
    // header, so nothing can ever match this row to a provider transfer.
    expect(
      codes(
        checkTransfer(
          snapshot({
            state: "submitted",
            providerTransferId: null,
            settlementPostingId: null,
            settledAmountMinor: null,
            createdAt: hoursAgo(1),
          }),
          NOW
        )
      )
    ).toEqual(["SUBMITTED_WITHOUT_REFERENCE"]);
  });
});

describe("comparing against the provider", () => {
  const compare = (
    status: ProviderTransferStatus,
    over: Partial<TransferSnapshot> = {}
  ) => checkAgainstProvider(snapshot(over), status);

  it("agrees when both say it completed", () => {
    expect(compare("processed")).toEqual([]);
  });

  it("flags a settlement the provider says did not stand", () => {
    // THE FINDING THAT MATTERS MOST: the ledger is counting money that came
    // back. Critical, because every balance derived from it is overstated.
    for (const status of ["failed", "returned"] as const) {
      const findings = compare(status);
      expect(codes(findings)).toEqual(["PROVIDER_CONTRADICTS_SETTLEMENT"]);
      expect(findings[0].severity).toBe("critical");
    }
  });

  it("flags a provider that has moved on while we have not", () => {
    const findings = compare("processed", {
      state: "submitted",
      settlementPostingId: null,
      settledAmountMinor: null,
    });

    expect(codes(findings)).toEqual(["PROVIDER_AHEAD"]);
    expect(findings[0].detail).toBe("internal=submitted provider=processed");
  });

  it("flags a failure the provider reported and we never received", () => {
    expect(
      codes(
        compare("returned", {
          state: "submitted",
          settlementPostingId: null,
          settledAmountMinor: null,
        })
      )
    ).toEqual(["PROVIDER_AHEAD"]);
  });

  it("flags a reference the provider does not recognise", () => {
    expect(codes(compare("unknown"))).toEqual(["PROVIDER_UNKNOWN_REFERENCE"]);
  });

  it("says nothing about a transfer with no reference to compare", () => {
    expect(compare("unknown", { providerTransferId: null })).toEqual([]);
  });

  it("is quiet while the provider is still working", () => {
    expect(
      compare("pending", {
        state: "submitted",
        settlementPostingId: null,
        settledAmountMinor: null,
      })
    ).toEqual([]);
  });

  it("NEVER returns an instruction to change anything", () => {
    // The rules produce findings. There is no shape here a caller could mistake
    // for "apply this" — the provider is an adapter, not the system of record,
    // and auto-applying its view would become a second place settlement can
    // happen, bypassing the signature check that makes the first trustworthy.
    const findings = [
      ...compare("failed"),
      ...compare("processed", { state: "submitted", settlementPostingId: null }),
    ];

    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual([
        "code",
        "detail",
        "severity",
        "transferId",
      ]);
    }
  });
});

describe("the ledger as a whole", () => {
  it("is silent when it balances", () => {
    expect(checkLedgerTotal(0)).toEqual([]);
  });

  it("flags any non-zero total, in either direction", () => {
    expect(checkLedgerTotal(1)[0].code).toBe("LEDGER_NOT_BALANCED");
    expect(checkLedgerTotal(-1)[0].code).toBe("LEDGER_NOT_BALANCED");
    expect(checkLedgerTotal(-1)[0].transferId).toBeNull();
  });
});

describe("summarising", () => {
  it("counts severities and reports clean only when nothing was found", () => {
    expect(
      summarise({ checkedTransfers: 3, comparedWithProvider: 2, findings: [] })
    ).toEqual({
      checkedTransfers: 3,
      comparedWithProvider: 2,
      findings: [],
      clean: true,
      criticalCount: 0,
      warningCount: 0,
    });
  });

  it("is not clean when only warnings were found", () => {
    // A warning is still something a human has to look at. Reporting "clean"
    // because nothing was critical is how a stale transfer sits for a month.
    const report = summarise({
      checkedTransfers: 1,
      comparedWithProvider: 0,
      findings: checkTransfer(
        snapshot({
          state: "submitted",
          settlementPostingId: null,
          settledAmountMinor: null,
          createdAt: hoursAgo(STALE_SUBMITTED_HOURS + 5),
        }),
        NOW
      ),
    });

    expect(report.clean).toBe(false);
    expect(report.criticalCount).toBe(0);
    expect(report.warningCount).toBe(1);
  });
});

describe("findings carry no sensitive value", () => {
  it("names transfers by internal id and states by fixed vocabulary", () => {
    // A reconciliation report ends up in a terminal, a CI log and often a
    // pasted message. Nothing that reaches it may carry a funding-source URL,
    // a token, an email or a name — and the way to guarantee that is for the
    // finding never to hold one.
    const all = [
      ...checkTransfer(
        snapshot({
          state: "reversed",
          settlementPostingId: null,
          settledAmountMinor: 1,
          postedNetMinor: 7,
          activeHoldMinor: 5,
          providerTransferId: "https://api.dwolla.com/funding-sources/secret",
        }),
        NOW
      ),
      ...checkAgainstProvider(
        snapshot({
          providerTransferId: "https://api.dwolla.com/funding-sources/secret",
        }),
        "failed"
      ),
    ];

    // Exact, so the loop below cannot pass by having nothing to iterate.
    expect(all.map((f) => f.code).sort()).toEqual([
      "POSTED_AMOUNT_MISMATCH",
      "POSTED_NET_UNEXPECTED",
      "PROVIDER_CONTRADICTS_SETTLEMENT",
      "SETTLED_WITHOUT_POSTING",
      "TERMINAL_WITH_ACTIVE_HOLD",
    ]);

    for (const finding of all) {
      const text = `${finding.transferId ?? ""} ${finding.detail}`;
      expect(text).not.toContain("dwolla");
      expect(text).not.toContain("funding-sources");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("https");
    }
  });
});
