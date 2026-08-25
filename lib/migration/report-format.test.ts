import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackfillReport } from "./backfill";
import {
  describeThrown,
  formatBackfillReport,
  formatVerificationReport,
  redactSecrets,
} from "./report-format";
import type { VerificationReport } from "./verify";

/**
 * OPERATOR OUTPUT.
 *
 * This is the surface a person actually reads, and the one that ends up in a
 * terminal scrollback, a CI log, or a pasted bug report. "There is no
 * access_token column" says nothing about what gets printed.
 *
 * Sentinels are unique per source so a leak names its own origin.
 */
const ACCESS_TOKEN = "access-sandbox-SENTINELa1b2c3d4";
const PROCESSOR = "processor-sandbox-SENTINELe5f6a7b8";
const DB_PASSWORD = "SENTINEL-db-password-9c0d1e2f";
const CONNECTION = `postgresql://orion:${DB_PASSWORD}@localhost:5432/orion`;
const SENTINELS = [ACCESS_TOKEN, PROCESSOR, DB_PASSWORD];

const assertClean = (text: string, label: string) => {
  for (const secret of SENTINELS) {
    expect(text, `${label} leaked a sentinel`).not.toContain(secret);
  }
};

/** Capture what actually reaches stdout / stderr. */
function captureConsole() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(" "));
  });
  return {
    stdout: () => stdout.join("\n"),
    stderr: () => stderr.join("\n"),
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const backfillReport = (over: Partial<BackfillReport> = {}): BackfillReport => ({
  dryRun: false,
  outcome: "committed",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  source: {
    users: { scanned: 2, reportedTotal: 2, pages: 1, complete: true },
    banks: { scanned: 2, reportedTotal: 2, pages: 1, complete: true },
    complete: true,
    fingerprint: "fp-committed",
  },
  customers: { created: 2, existing: 0, failed: 0 },
  accounts: { created: 2, updated: 0, failed: 0, blocked: 0 },
  enrichment: { succeeded: 2, failed: 0 },
  skipped: [],
  failures: [],
  enrichmentFailures: [],
  ...over,
});

const verificationReport = (
  over: Partial<VerificationReport> = {}
): VerificationReport => ({
  checkedAt: "2026-01-01T00:00:00.000Z",
  legacy: {
    users: 2,
    banks: 2,
    migratable: { customers: 2, accounts: 2 },
    scan: {
      users: { scanned: 2, reportedTotal: 2, pages: 1 },
      banks: { scanned: 2, reportedTotal: 2, pages: 1 },
      complete: true,
    },
  },
  postgres: { customers: 2, accounts: 2 },
  skippedBySource: 0,
  drift: [],
  ok: true,
  scope: { verified: ["identity"], notVerified: ["provider metadata"] },
  ...over,
});

describe("redactSecrets", () => {
  it("masks a password inside a connection URL but keeps the host", () => {
    const out = redactSecrets(`connect failed: ${CONNECTION}`);

    expect(out).not.toContain(DB_PASSWORD);
    // The operator still needs to know WHICH database failed.
    expect(out).toContain("localhost:5432/orion");
    expect(out).toContain("orion:***@");
  });

  it("masks Plaid token shapes", () => {
    expect(redactSecrets(`token was ${ACCESS_TOKEN}`)).not.toContain(ACCESS_TOKEN);
    expect(redactSecrets(`token was ${PROCESSOR}`)).not.toContain(PROCESSOR);
  });

  it("masks a value that announced itself as a secret", () => {
    for (const pair of [
      `access_token=${ACCESS_TOKEN}`,
      `"accessToken": "${ACCESS_TOKEN}"`,
      `password: ${DB_PASSWORD}`,
      `Authorization: ${DB_PASSWORD}`,
    ]) {
      assertClean(redactSecrets(pair), pair);
    }
  });

  it("leaves ordinary text alone", () => {
    const plain = "read 12 of 12 documents across 1 page(s)";
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("is not a substitute for containment", () => {
    // A secret with no recognisable shape and no announcing key survives.
    // Stated as a test so nobody mistakes redaction for a guarantee: the
    // reports must not carry secrets in the first place.
    expect(redactSecrets("opaque hunter2")).toContain("hunter2");
  });
});

describe("describeThrown", () => {
  it("gives the name and message, redacted", () => {
    const error = new Error(`could not connect to ${CONNECTION}`);

    const out = describeThrown(error);

    expect(out).toContain("Error:");
    assertClean(out, "describeThrown");
  });

  it("does not stringify a non-Error", () => {
    // A rejected provider promise is often a plain object holding the request.
    const providerRejection = {
      response: { data: { request: { access_token: ACCESS_TOKEN } } },
    };

    const out = describeThrown(providerRejection);

    expect(out).toBe("unknown error");
    assertClean(out, "non-Error");
  });

  it("does not print the cause chain", () => {
    const error = new Error("outer", { cause: new Error(CONNECTION) });

    const out = describeThrown(error);

    expect(out).toBe("Error: outer");
    assertClean(out, "cause chain");
  });

  it("does not print the stack", () => {
    const error = new Error("boom");

    expect(describeThrown(error)).not.toContain("at ");
  });
});

describe("formatBackfillReport — content", () => {
  it("prints source evidence, not just counts", () => {
    const lines = formatBackfillReport(backfillReport()).join("\n");

    expect(lines).toContain("2/2 scanned over 1 page(s)");
  });

  it("marks an incomplete read loudly and says not to trust the run", () => {
    const lines = formatBackfillReport(
      backfillReport({
        source: {
          users: { scanned: 3, reportedTotal: 90, pages: 1, complete: false },
          banks: { scanned: 2, reportedTotal: 2, pages: 1, complete: true },
          complete: false,
          fingerprint: "fp-short",
        },
      })
    ).join("\n");

    expect(lines).toContain("*** INCOMPLETE ***");
    expect(lines).toContain("Do not treat this run as a complete migration");
  });

  it("separates degraded accounts from blocked ones", () => {
    const lines = formatBackfillReport(
      backfillReport({
        accounts: { created: 1, updated: 0, failed: 0, blocked: 1 },
        enrichmentFailures: [
          {
            legacyBankDocumentId: "bank-a",
            code: "PROVIDER_ERROR",
            reason: "provider error: ITEM_LOGIN_REQUIRED",
            blocked: false,
          },
          {
            legacyBankDocumentId: "bank-b",
            code: "UNSUPPORTED_CURRENCY",
            reason: "denominated in CAD",
            blocked: true,
          },
        ],
      })
    ).join("\n");

    // The distinction decides what an operator does next, so it must not be
    // one undifferentiated "failures" list.
    expect(lines).toContain("MIGRATED with placeholder names");
    expect(lines).toContain("NOT MIGRATED");
    expect(lines).toContain("bank-a");
    expect(lines).toContain("bank-b");
  });

  it("says nothing was written after a dry run", () => {
    const lines = formatBackfillReport(
      backfillReport({ dryRun: true, outcome: "dry-run" })
    ).join("\n");

    expect(lines).toContain("DRY RUN");
    expect(lines).toContain("Nothing was written");
  });

  it("does not say that after a committed run", () => {
    const lines = formatBackfillReport(backfillReport()).join("\n");

    expect(lines).toContain("COMMITTED");
    expect(lines).not.toContain("Nothing was written");
  });

  it("never says COMMITTED about a transaction that rolled back", () => {
    // The defect this replaces: counters accumulated before an abort were
    // printed under a COMMITTED heading, describing a database state that did
    // not exist.
    const lines = formatBackfillReport(
      backfillReport({
        outcome: "rolled-back",
        customers: { created: 0, existing: 0, failed: 1 },
        accounts: { created: 0, updated: 0, failed: 0, blocked: 0 },
        failures: [
          { kind: "customer", id: "(transaction)", reason: "ConstraintViolationError / 23514 / x" },
        ],
      })
    ).join("\n");

    expect(lines).toContain("ROLLED BACK");
    expect(lines).not.toContain("COMMITTED");
    expect(lines).toContain("PostgreSQL discarded every write");
  });

  it("says plainly when a run was refused before doing anything", () => {
    const lines = formatBackfillReport(
      backfillReport({
        outcome: "refused",
        refusedBecause: "source read was incomplete (users 3/90)",
        customers: { created: 0, existing: 0, failed: 0 },
        accounts: { created: 0, updated: 0, failed: 0, blocked: 0 },
        source: {
          users: { scanned: 3, reportedTotal: 90, pages: 1, complete: false },
          banks: { scanned: 2, reportedTotal: 2, pages: 1, complete: true },
          complete: false,
          fingerprint: "fp-short",
        },
      })
    ).join("\n");

    expect(lines).toContain("REFUSED");
    expect(lines).toContain("No provider calls were made and no rows were written");
    expect(lines).not.toContain("COMMITTED");
  });

  it("prints every skip with its code", () => {
    const lines = formatBackfillReport(
      backfillReport({
        skipped: [
          {
            kind: "user",
            id: "doc-b",
            code: "DUPLICATE_AUTH_ID",
            reason: "auth id auth-1 is also claimed by doc-a",
          },
        ],
      })
    ).join("\n");

    expect(lines).toContain("[DUPLICATE_AUTH_ID]");
    expect(lines).toContain("doc-b");
  });
});

describe("formatVerificationReport — content", () => {
  it("states plainly when there is no drift", () => {
    const lines = formatVerificationReport(verificationReport()).join("\n");

    expect(lines).toContain("No drift");
  });

  it("groups drift by category", () => {
    const lines = formatVerificationReport(
      verificationReport({
        ok: false,
        drift: [
          { category: "missing-customer", id: "u-1", detail: "no PostgreSQL row" },
          { category: "missing-customer", id: "u-2", detail: "no PostgreSQL row" },
          { category: "orphan-account", id: "a-9", detail: "no source document" },
        ],
      })
    ).join("\n");

    expect(lines).toContain("DRIFT (3)");
    expect(lines).toContain("missing-customer (2)");
    expect(lines).toContain("orphan-account (1)");
  });

  it("flags an incomplete scan in the header", () => {
    const base = verificationReport();
    const lines = formatVerificationReport({
      ...base,
      legacy: { ...base.legacy, scan: { ...base.legacy.scan, complete: false } },
    }).join("\n");

    expect(lines).toContain("*** INCOMPLETE ***");
  });
});

/**
 * The requirement names stdout and stderr specifically, so these assert against
 * what the console actually received rather than against a returned string.
 */
describe("operator output — stdout and stderr", () => {
  it("keeps sentinels off stdout for a backfill report", () => {
    const cap = captureConsole();
    try {
      const report = backfillReport({
        skipped: [
          {
            kind: "bank",
            id: "bank-a",
            code: "MISSING_ACCOUNT_ID",
            // A hostile-but-plausible reason: something upstream interpolated
            // a token into prose.
            reason: `missing accountId near ${ACCESS_TOKEN}`,
          },
        ],
        failures: [
          { kind: "account", id: "bank-b", reason: `insert failed on ${CONNECTION}` },
        ],
        enrichmentFailures: [
          {
            legacyBankDocumentId: "bank-c",
            code: "PROVIDER_ERROR",
            reason: `provider error near ${PROCESSOR}`,
            blocked: false,
          },
        ],
      });

      for (const line of formatBackfillReport(report)) console.log(line);

      assertClean(cap.stdout(), "stdout");
      // And it still printed something useful.
      expect(cap.stdout()).toContain("bank-a");
      expect(cap.stdout()).toContain("localhost:5432/orion");
    } finally {
      cap.restore();
    }
  });

  it("keeps sentinels off stdout for a verification report", () => {
    const cap = captureConsole();
    try {
      const report = verificationReport({
        ok: false,
        drift: [
          {
            category: "mismatched-account",
            id: "bank-a",
            detail: `bridged to ${ACCESS_TOKEN}`,
          },
        ],
      });

      for (const line of formatVerificationReport(report)) console.log(line);

      assertClean(cap.stdout(), "stdout");
      expect(cap.stdout()).toContain("mismatched-account");
    } finally {
      cap.restore();
    }
  });

  it("keeps sentinels off stderr when a run aborts", () => {
    const cap = captureConsole();
    try {
      // The exact shape scripts/db-backfill.ts uses in its catch.
      const error = new Error(`connection failure: ${CONNECTION}`);
      console.error("Backfill aborted:", describeThrown(error));

      assertClean(cap.stderr(), "stderr");
      expect(cap.stderr()).toContain("Backfill aborted:");
    } finally {
      cap.restore();
    }
  });

  it("keeps sentinels off stderr for a provider rejection", () => {
    const cap = captureConsole();
    try {
      const rejection = {
        message: `request failed: {"access_token":"${ACCESS_TOKEN}"}`,
        config: { data: ACCESS_TOKEN },
      };
      console.error("Verification aborted:", describeThrown(rejection));

      assertClean(cap.stderr(), "stderr");
    } finally {
      cap.restore();
    }
  });

  it("prints nothing at all when there is nothing to say", () => {
    const cap = captureConsole();
    try {
      expect(cap.stdout()).toBe("");
      expect(cap.stderr()).toBe("");
    } finally {
      cap.restore();
    }
  });
});
