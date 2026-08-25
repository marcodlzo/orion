import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * THE CLI ITSELF, AS A SUBPROCESS.
 *
 * Formatter tests cannot prove exit semantics, and the mandatory-binding check
 * lives in `main()` where no unit test reached it — a mutation removing it went
 * undetected. This runs the real command.
 *
 * The binding check deliberately precedes the DATABASE_URL check, so this
 * exercise needs no database and no credentials.
 */
async function runCli(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./scripts/loader/server-only-alias.mjs",
        "scripts/db-backfill.ts",
        ...args,
      ],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: "" }, timeout: 60_000 }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("db-backfill CLI", () => {
  it(
    "REFUSES --commit without --expect-source",
    async () => {
      const { code, stderr } = await runCli(["--commit"]);

      // Optional binding is no binding: the documented command was an unbound
      // commit, so the standard path could write a dataset nobody reviewed.
      expect(code).toBe(1);
      expect(stderr).toContain("Refusing to commit without --expect-source");
    },
    90_000
  );

  it(
    "tells the operator exactly how to obtain the digest",
    async () => {
      const { stderr } = await runCli(["--commit"]);

      expect(stderr).toContain("npm run db:backfill");
      expect(stderr).toContain("--expect-source=");
    },
    90_000
  );

  it(
    "refuses before touching the database or the provider",
    async () => {
      const { stderr } = await runCli(["--commit"]);

      // If it had reached the database check first, this would say
      // "DATABASE_URL is not set" instead — and the binding refusal would be
      // untestable without a live database.
      expect(stderr).not.toContain("DATABASE_URL is not set");
    },
    90_000
  );

  it(
    "gets past the binding check when a digest is supplied",
    async () => {
      const { code, stderr } = await runCli(["--commit", "--expect-source=abc123"]);

      // No DATABASE_URL in this environment, so it stops at the next gate —
      // which proves the binding gate let it through.
      expect(code).toBe(1);
      expect(stderr).toContain("DATABASE_URL is not set");
      expect(stderr).not.toContain("Refusing to commit");
    },
    90_000
  );

  it(
    "does not require a digest for a dry run",
    async () => {
      const { stderr } = await runCli([]);

      // A dry run PRODUCES the digest, so requiring one would make a first run
      // impossible.
      expect(stderr).not.toContain("Refusing to commit");
    },
    90_000
  );
});
