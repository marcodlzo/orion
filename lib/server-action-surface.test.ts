import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ARCHITECTURE TEST — the server-action attack surface.
 *
 * Every export of a module carrying the "use server" directive is a publicly
 * callable POST endpoint. It is reachable by anyone who can reach the
 * application, regardless of what the UI does, and a layout redirect does not
 * protect it.
 *
 * This test fails if that surface grows. It is not a style check: each new
 * export is a new endpoint that must defend itself.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SEARCH = ["app", "components", "lib", "constants"];

type ActionModule = { file: string; exports: string[] };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== ".next") walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collects capture group 1 of every match.
 *
 * Uses exec rather than spreading matchAll: tsconfig sets no `target`, so tsc
 * defaults below ES2015 and spreading an iterator would require
 * --downlevelIteration. Changing compiler options is out of scope here.
 */
function matchAllGroups(src: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = rx.exec(src)) !== null) {
    out.push(m[1]);
    if (m.index === rx.lastIndex) rx.lastIndex++; // guard against zero-length matches
  }
  return out;
}

function findActionModules(): ActionModule[] {
  const files: string[] = [];
  for (const dir of SEARCH) {
    try {
      walk(join(ROOT, dir), files);
    } catch {
      /* directory may not exist */
    }
  }

  return files
    .map((file) => ({ file, src: readFileSync(file, "utf8") }))
    .filter(({ src }) => /^\s*["']use server["']/m.test(src))
    .map(({ file, src }) => ({
      file: file.slice(ROOT.length).replace(/\\/g, "/"),
      exports: matchAllGroups(
        src,
        /^export\s+(?:const|async function|function)\s+([A-Za-z0-9_]+)/gm
      ),
    }));
}

/**
 * The complete, intentional public surface. Every entry is invoked from a
 * client component.
 *
 * Adding a name here means accepting a new public endpoint. Do not widen this
 * list to make the test pass — if a function does not need to cross the
 * browser/server boundary, move it into lib/server/ instead.
 */
const ALLOWED_SERVER_ACTIONS = [
  "createTransaction",       // PaymentTransferForm
  "createTransfer",          // PaymentTransferForm
  "createLinkToken",         // PlaidLink
  "exchangePublicToken",     // PlaidLink
  "getBank",                 // PaymentTransferForm
  "getBankByAccountId",      // PaymentTransferForm
  "getLoggedInUser",         // AuthForm
  "logoutAccount",           // Footer
  "signIn",                  // AuthForm
  "signUp",                  // AuthForm
].sort();

/**
 * Functions established as internal implementation detail. These handle admin
 * clients, provider credentials or raw documents and are not called from any
 * client component. None may be exported from a "use server" module again.
 */
const MUST_STAY_INTERNAL = [
  "addFundingSource",
  "createAdminClient",
  "createBankAccount",
  "createDwollaCustomer",
  "createFundingSource",
  "createOnDemandAuthorization",
  "createSessionClient",
  "getAccount",
  "getAccounts",
  "getBanks",
  "getInstitution",
  "getTransactions",
  "getTransactionsByBankId",
  "getUserInfo",
];

describe("server-action surface", () => {
  const modules = findActionModules();
  const exported = modules.flatMap((m) => m.exports).sort();

  it("finds the action modules", () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it("exports exactly the intended public surface", () => {
    expect(exported).toEqual(ALLOWED_SERVER_ACTIONS);
  });

  it("never re-exposes an internal function as a server action", () => {
    const leaked = MUST_STAY_INTERNAL.filter((fn) => exported.includes(fn));
    expect(leaked).toEqual([]);
  });

  it("keeps every internal module out of the action layer", () => {
    // lib/server/** is server-only implementation. If one of these files ever
    // gains a "use server" directive, its exports become public endpoints.
    const serverDirActions = modules.filter((m) => m.file.startsWith("lib/server/"));
    expect(serverDirActions.map((m) => m.file)).toEqual([]);
  });
});

describe("server-only boundaries", () => {
  const mustBeServerOnly = [
    "lib/appwrite.ts",
    "lib/plaid.ts",
    "lib/server/banks.ts",
    "lib/server/dwolla.ts",
    "lib/server/transactions.ts",
    "lib/server/users.ts",
  ];

  it.each(mustBeServerOnly)("%s imports server-only", (relPath) => {
    const src = readFileSync(join(ROOT, relPath), "utf8");
    expect(src).toMatch(/import\s+["']server-only["']/);
  });

  it("does not mark client-reachable modules as server-only", () => {
    // These are imported by client components and must stay importable.
    for (const relPath of ["lib/utils.ts", "constants/index.ts"]) {
      const src = readFileSync(join(ROOT, relPath), "utf8");
      expect(src).not.toMatch(/import\s+["']server-only["']/);
    }
  });
});
