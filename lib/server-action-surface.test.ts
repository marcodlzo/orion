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
/**
 * Actions that must resolve an authenticated actor before any privileged work.
 * Everything not listed in PUBLIC_AUTH_ENTRY belongs here.
 */
const PROTECTED_ACTIONS = [
  "createLinkToken",
  "createTransaction",
  "createTransfer",
  "exchangePublicToken",
  "getBank",
  "getBankByAccountId",
  "getLoggedInUser",
  "logoutAccount",
];

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

/**
 * The only actions that may run without an authenticated actor.
 *
 * These are authentication ENTRY points: requiring a session to sign in would
 * be circular. Adding a name here creates an anonymous endpoint — do not widen
 * it to make a test pass.
 */
const PUBLIC_AUTH_ENTRY = ["signIn", "signUp"].sort();

describe("authentication boundary", () => {
  const modules = findActionModules();

  it("has exactly two intentionally public auth-entry actions", () => {
    const publicActions = ALLOWED_SERVER_ACTIONS.filter(
      (fn) => !PROTECTED_ACTIONS.includes(fn)
    ).sort();
    expect(publicActions).toEqual(PUBLIC_AUTH_ENTRY);
  });

  it("accounts for every action as either public entry or protected", () => {
    expect([...PUBLIC_AUTH_ENTRY, ...PROTECTED_ACTIONS].sort()).toEqual(
      ALLOWED_SERVER_ACTIONS
    );
  });

  it("every module holding a protected action imports the actor boundary", () => {
    for (const mod of modules) {
      const holdsProtected = mod.exports.some((fn) => PROTECTED_ACTIONS.includes(fn));
      if (!holdsProtected) continue;

      const src = readFileSync(join(ROOT, mod.file), "utf8");
      // Match the import statement specifically, so a mention in a comment
      // cannot satisfy this.
      expect(src, `${mod.file} must import requireActor`).toMatch(
        /^import\s+\{[^}]*\brequireActor\b[^}]*\}\s+from\s+["'][^"']*auth\/actor["']/m
      );
    }
  });

  it("calls requireActor inside every protected action body", () => {
    for (const mod of modules) {
      const src = readFileSync(join(ROOT, mod.file), "utf8");
      const withoutComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");

      for (const fn of mod.exports) {
        if (!PROTECTED_ACTIONS.includes(fn)) continue;

        // Body runs from the declaration to the next top-level export.
        const start = withoutComments.search(
          new RegExp(`^export\\s+(?:const|async function|function)\\s+${fn}\\b`, "m")
        );
        expect(start, `${fn} not found in ${mod.file}`).toBeGreaterThan(-1);
        const rest = withoutComments.slice(start + 1);
        const nextExport = rest.search(/^export\s+(?:const|async function|function)\s/m);
        const body = nextExport === -1 ? rest : rest.slice(0, nextExport);

        expect(body, `${fn} must call requireActor()`).toMatch(/requireActor\s*\(/);
      }
    }
  });

  it("no protected action accepts a caller-supplied identity parameter", () => {
    // Identity must come from the session. A parameter named user/userId/
    // accountId-as-identity is what made these actions impersonatable.
    for (const mod of modules) {
      const src = readFileSync(join(ROOT, mod.file), "utf8");
      const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

      for (const fn of mod.exports) {
        if (!PROTECTED_ACTIONS.includes(fn)) continue;
        const decl = new RegExp(
          `export\\s+(?:const|async function|function)\\s+${fn}\\s*(?:=\\s*async\\s*)?\\(([^)]*)\\)`,
          "m"
        );
        const params = decl.exec(withoutComments)?.[1] ?? "";
        expect(params, `${fn} must not take a caller-supplied user`).not.toMatch(
          /\buser\s*[,:}]|\buser\s*$/
        );
      }
    }
  });
});

/**
 * The ONLY files permitted to reach the admin Appwrite client.
 *
 * The admin client authenticates with NEXT_APPWRITE_KEY and bypasses every
 * Appwrite permission rule, so every query it issues must be visible in one
 * place. Scattering it back across action modules is how ownership checks get
 * forgotten one endpoint at a time.
 *
 * lib/appwrite.ts is the factory itself and is necessarily on this list.
 */
const ADMIN_CLIENT_ALLOWED = [
  "lib/appwrite.ts",
  "lib/repositories/accounts.repository.ts",
  "lib/repositories/banks.repository.ts",
  "lib/repositories/transactions.repository.ts",
  "lib/repositories/users.repository.ts",
];

describe("admin client boundary", () => {
  /** Every non-test source file, with comments stripped. */
  const sources = (() => {
    const files: string[] = [];
    for (const dir of SEARCH) {
      try {
        walk(join(ROOT, dir), files);
      } catch {
        /* directory may not exist */
      }
    }
    return files
      .map((file) => ({
        file: file.slice(ROOT.length).replace(/\\/g, "/"),
        code: readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1"),
      }))
      .filter(({ file }) => !/\.test\.tsx?$/.test(file));
  })();

  it("createAdminClient appears only in the approved data-access layer", () => {
    const offenders = sources
      .filter(({ code }) => /\bcreateAdminClient\b/.test(code))
      .map(({ file }) => file)
      .sort();

    expect(offenders).toEqual([...ADMIN_CLIENT_ALLOWED].sort());
  });

  it("no action, server helper, component or route issues a raw admin query", () => {
    const offenders = sources
      .filter(({ file }) => !ADMIN_CLIENT_ALLOWED.includes(file))
      .filter(({ code }) => /\bdatabase\.(listDocuments|createDocument|updateDocument|deleteDocument|getDocument)\b/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("Appwrite Query is not constructed outside the repositories", () => {
    // A Query built in an action is a filter nobody reviewed for ownership.
    const offenders = sources
      .filter(({ file }) => !file.startsWith("lib/repositories/"))
      .filter(({ code }) => /\bQuery\.(equal|notEqual|contains|search|and|or)\s*\(/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("every repository declares server-only", () => {
    const repos = sources.filter(({ file }) => file.startsWith("lib/repositories/"));
    expect(repos.length).toBeGreaterThan(0);

    for (const { file, code } of repos) {
      if (file.endsWith("errors.ts")) continue; // pure error classes, no data access
      expect(code, `${file} must import server-only`).toMatch(
        /import\s+["']server-only["']/
      );
    }
  });
});

describe("server-only boundaries", () => {
  const mustBeServerOnly = [
    "lib/appwrite.ts",
    "lib/auth/actor.ts",
    "lib/plaid.ts",
    "lib/server/banks.ts",
    "lib/server/dwolla.ts",
    "lib/repositories/accounts.repository.ts",
    "lib/repositories/banks.repository.ts",
    "lib/repositories/transactions.repository.ts",
    "lib/repositories/users.repository.ts",
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
