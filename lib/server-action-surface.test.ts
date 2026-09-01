import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

import { CUSTOMER_CREDIT_LIMIT_MINOR } from "./domain/limits";
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

/**
 * Remove comments before scanning source for a forbidden symbol.
 *
 * ONE left-to-right pass over both comment forms, not two passes. Stripping
 * block comments first is subtly wrong: a line comment mentioning a glob —
 * `// see lib/repositories/*` — contains the characters `/*`, and a
 * block-comment-first pass treats it as an opening delimiter and deletes
 * everything up to the next `*​/`, which is usually the end of the next JSDoc.
 * That silently swallowed a real `import "server-only"` and made this file's
 * guards pass on a module that did not satisfy them.
 *
 * A guard that a comment can switch off is not a guard. The alternation below
 * matches whichever delimiter appears first, which is what a tokenizer does.
 * The `[^:]` prefix keeps `https://` in a string literal from reading as a
 * comment.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/gm, (_m, lead) => lead ?? "");
}

/**
 * The scanner underpins every guard in this file, so it is tested directly.
 * A bug here does not fail a test — it makes tests pass on code that violates
 * them, which is worse.
 */
describe("stripComments", () => {
  it("removes both comment forms", () => {
    // The character before `//` is preserved by the `[^:]` guard, so the
    // comment's text goes and the surrounding code does not shift.
    expect(stripComments("a // gone\nb")).toBe("a \nb");
    expect(stripComments("a /* gone */ b")).toBe("a  b");
  });

  it("does not let a glob inside a line comment open a block comment", () => {
    // The exact shape that swallowed a real `import "server-only"`.
    const src = [
      "// see lib/repositories/* for the Appwrite ones",
      'import "server-only";',
      "/** doc */",
      "const x = 1;",
    ].join("\n");

    expect(stripComments(src)).toContain('import "server-only";');
    expect(stripComments(src)).toContain("const x = 1;");
  });

  it("does not let a // inside a block comment leak the block's tail", () => {
    const src = "/* see http://example.invalid\n * more\n */ const x = 1;";

    expect(stripComments(src)).toBe(" const x = 1;");
  });

  it("keeps a URL in a string literal intact", () => {
    const src = 'const u = "https://api.example.invalid/v1";';

    expect(stripComments(src)).toBe(src);
  });

  it("still hides a forbidden symbol that is genuinely commented out", () => {
    expect(stripComments("// createAdminClient()")).not.toContain("createAdminClient");
    expect(stripComments("/* createAdminClient() */")).not.toContain("createAdminClient");
  });

  it("does not hide a forbidden symbol that follows a glob comment", () => {
    // Mutation check: with the old two-pass stripper this returned "", and the
    // admin-client guard reported the file as clean.
    const src = "// lib/repositories/*\ncreateAdminClient();\n/** doc */";

    expect(stripComments(src)).toContain("createAdminClient()");
  });
});

/**
 * Repo-relative paths this module imports AT RUN TIME.
 *
 * `import type { X } from "./y"` is erased by the compiler, so it is not an
 * execution path and is deliberately excluded. Counting it would fail a module
 * for a dependency that does not exist when the code runs — which is the
 * opposite of what the reachability suites are trying to measure. A formatter
 * that names a report type is not a caller of the thing that produces it.
 *
 * Only relative and `@/` specifiers are followed; a bare package name is not
 * part of this repository's graph.
 */
function resolveRuntimeImports(code: string, rel: string): string[] {
  const specifiers: string[] = [];

  // `import … from "x"` / `export … from "x"`, skipping type-only forms.
  const FROM = /(?:^|[\n;])\s*(?:import|export)\s+([\s\S]*?)\bfrom\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = FROM.exec(code)) !== null) {
    if (/^type\b/.test(m[1].trim())) continue; // erased at compile time
    specifiers.push(m[2]);
  }

  // The three forms the earlier parser missed. Each executes the target module
  // exactly as a named import does, so a containment claim that ignored them
  // was broader than the check behind it:
  //
  //   import "./x"        side effect — runs the module for its top level alone
  //   import("./x")       dynamic — runs it later, but still runs it
  //   require("./x")      CommonJS — the form tsx actually emits
  //
  // Backticks are accepted everywhere a quote is. A template-literal specifier
  // executes identically and was the last syntactic way past this guard.
  const SIDE_EFFECT = /(?:^|[\n;])\s*import\s+["'`]([^"'`]+)["'`]/g;
  const DYNAMIC = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  const REQUIRE = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  for (const re of [SIDE_EFFECT, DYNAMIC, REQUIRE]) {
    while ((m = re.exec(code)) !== null) specifiers.push(m[1]);
  }

  const out: string[] = [];
  for (const spec of specifiers) {
    let base: string;
    if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) base = join(ROOT, rel, "..", spec);
    else continue;

    for (const cand of [base + ".ts", base + ".tsx", join(base, "index.ts")]) {
      try {
        statSync(cand);
        const resolved = cand.slice(ROOT.length).replace(/\\/g, "/");
        if (!out.includes(resolved)) out.push(resolved);
        break;
      } catch {
        /* not this extension */
      }
    }
  }
  return out;
}

/**
 * The parser behind every containment claim in this file, tested directly.
 *
 * It previously recognised only `import … from`, so a side-effect, dynamic or
 * CommonJS import of the unscoped legacy reader would have been invisible to
 * the suite while executing perfectly well at run time. A guard is only as
 * broad as its parser.
 */
describe("resolveRuntimeImports", () => {
  const FROM = "lib/actions/example.ts";
  const TARGET = "lib/migration/appwrite-source.ts";

  it("sees a named import", () => {
    const code = 'import { readAllLegacyUsers } from "../migration/appwrite-source";';
    expect(resolveRuntimeImports(code, FROM)).toContain(TARGET);
  });

  it("sees a SIDE-EFFECT import", () => {
    expect(resolveRuntimeImports('import "../migration/appwrite-source";', FROM)).toContain(
      TARGET
    );
  });

  it("sees a DYNAMIC import", () => {
    const code = 'const m = await import("../migration/appwrite-source");';
    expect(resolveRuntimeImports(code, FROM)).toContain(TARGET);
  });

  it("sees a CommonJS require", () => {
    const code = 'const m = require("../migration/appwrite-source");';
    expect(resolveRuntimeImports(code, FROM)).toContain(TARGET);
  });

  it("sees a TEMPLATE-LITERAL dynamic import", () => {
    // The last syntactic way past this guard. It executes identically to the
    // quoted form.
    const code = "const m = await import(`../migration/appwrite-source`);";
    expect(resolveRuntimeImports(code, FROM)).toContain(TARGET);
  });

  it("sees a template-literal require", () => {
    const code = "const m = require(`../migration/appwrite-source`);";
    expect(resolveRuntimeImports(code, FROM)).toContain(TARGET);
  });

  it("sees an @/ alias", () => {
    expect(
      resolveRuntimeImports('import "@/lib/migration/appwrite-source";', FROM)
    ).toContain(TARGET);
  });

  it("still ignores a type-only import", () => {
    const code = 'import type { LegacyUserDocument } from "../migration/appwrite-source";';
    expect(resolveRuntimeImports(code, FROM)).toEqual([]);
  });

  it("ignores bare package specifiers", () => {
    // Not part of this repository's graph. `import "server-only"` is the common
    // case and must not resolve to anything.
    expect(resolveRuntimeImports('import "server-only";', FROM)).toEqual([]);
    expect(resolveRuntimeImports('import { z } from "zod";', FROM)).toEqual([]);
  });

  it("does not report the same module twice", () => {
    const code = [
      'import { readAllLegacyUsers } from "../migration/appwrite-source";',
      'import "../migration/appwrite-source";',
    ].join("\n");

    expect(resolveRuntimeImports(code, FROM).filter((f) => f === TARGET)).toHaveLength(1);
  });
});

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
  "createLinkToken",         // PlaidLink
  "exchangePublicToken",     // PlaidLink
  "getLoggedInUser",         // AuthForm
  "initiateTransfer",        // PaymentTransferForm — the ONLY money movement
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
  "exchangePublicToken",
  "getLoggedInUser",
  "initiateTransfer",
  "logoutAccount",
];

const MUST_STAY_INTERNAL = [
  "addFundingSource",
  "createDwollaTransfer",
  "createTransaction",
  "createTransactionRecord",
  "createTransfer",
  "executeTransfer",
  "findCounterpartyBankByAccountId",
  "getBankForLegacyTransfer",
  "getCounterpartyBankForLegacyTransfer",
  "getOwnedBankByDocumentId",
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
      const withoutComments = stripComments(src);

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
      const withoutComments = stripComments(src);

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
  // OPERATOR TOOLING, NOT A REQUEST PATH. Unlike the repositories above, this
  // module scopes nothing: it reads every user and every bank document, because
  // a backfill has no current user. It is on this list only because a separate
  // suite ("migration tooling stays out of the request path") proves it is
  // unreachable from any server action and from anything client-reachable.
  // Adding an entry here WITHOUT that containment would be an unauthenticated
  // read of the whole dataset.
  "lib/migration/appwrite-source.ts",
  // OPERATOR TOOLING, same containment as above and for the same reason: it
  // rewrites the credential fields of every bank document during the one-off
  // encryption migration. It is on this list only because the containment suite
  // proves no request path can reach it.
  "lib/migration/credential-encryption.ts",
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
        code: stripComments(readFileSync(file, "utf8")),
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

  it("an admin client cannot be constructed without naming the approved factory", () => {
    // THE GUARD ABOVE HAS A HOLE WITHOUT THIS ONE. `createAdminClient` is
    // allowlisted by name, but `new Client().setKey(...)` grants exactly the
    // same authority — the API key bypasses every Appwrite permission rule —
    // and never mentions the factory. A module could hold a full admin client
    // and the allowlist would report the codebase clean.
    //
    // Found while reviewing scripts/appwrite-schema.ts, which does this
    // legitimately as operator tooling outside the scanned directories. The
    // defect was never that script; it was that nothing would have noticed a
    // server action doing the same thing.
    const offenders = sources
      .filter(({ code }) => /\.setKey\s*\(/.test(code))
      .map(({ file }) => file)
      .sort();

    expect(offenders).toEqual(["lib/appwrite.ts"]);
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

/**
 * THE CLIENT BOUNDARY FOR PROVIDER CAPABILITIES.
 *
 * A funding-source URL is a capability: possession of one is sufficient to move
 * money from that account. It must not appear in any module that ships to the
 * browser, and no client component may reach the internals that handle one.
 */
describe("provider capabilities never reach client source", () => {
  /**
   * Modules that actually reach the client bundle.
   *
   * Directory is NOT the test: app/(root)/page.tsx is a server component and
   * legitimately imports server-only modules. A module is client-reachable if
   * it declares "use client" or is imported by one that does.
   *
   * The traversal stops at "use server": a client component importing an action
   * receives a reference, not the module body, so an action's dependencies do
   * not ship to the browser.
   */
  const clientModules = (() => {
    const files: string[] = [];
    for (const dir of SEARCH) {
      try {
        walk(join(ROOT, dir), files);
      } catch {
        /* directory may not exist */
      }
    }

    type Mod = { file: string; code: string; isClient: boolean; isAction: boolean; imports: string[] };
    const mods = new Map<string, Mod>();

    for (const full of files) {
      const rel = full.slice(ROOT.length).replace(/\\/g, "/");
      if (/\.test\.tsx?$/.test(rel)) continue;
      const raw = readFileSync(full, "utf8");
      const code = stripComments(raw);

      const imports = resolveRuntimeImports(code, rel);

      mods.set(rel, {
        file: rel,
        code,
        isClient: /^\s*["']use client["']/m.test(raw),
        isAction: /^\s*["']use server["']/m.test(raw),
        imports,
      });
    }

    const reachable = new Set<string>();
    const queue = Array.from(mods.values()).filter((m) => m.isClient).map((m) => m.file);
    while (queue.length) {
      const cur = queue.pop()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const dep of mods.get(cur)?.imports ?? []) {
        if (reachable.has(dep)) continue;
        if (mods.get(dep)?.isAction) continue; // boundary stops here
        queue.push(dep);
      }
    }

    return Array.from(reachable).map((f) => mods.get(f)!).filter(Boolean);
  })();

  it("finds the client module set", () => {
    expect(clientModules.length).toBeGreaterThan(0);
    expect(clientModules.map((m) => m.file)).toContain(
      "components/PaymentTransferForm.tsx"
    );
  });

  it("no component or route mentions fundingSourceUrl", () => {
    const offenders = clientModules
      .filter(({ code }) => /\bfundingSourceUrl\b/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("no component or route mentions a Plaid or Dwolla credential field", () => {
    const offenders = clientModules
      .filter(({ code }) => /\b(accessToken|processorToken|dwollaCustomerId|dwollaCustomerUrl)\b/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("no client component imports a repository, service or provider module", () => {
    const offenders = clientModules
      .filter(({ code }) =>
        /from\s+["'][^"']*(repositories\/|services\/|server\/dwolla|server\/banks|lib\/appwrite|lib\/plaid)/.test(code)
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("no client-reachable module imports lib/db or pg", () => {
    // DATABASE_URL carries credentials and pg opens raw sockets. Neither may
    // reach a browser bundle.
    const offenders = clientModules
      .filter(({ code }) =>
        /from\s+["'](pg|[^"']*lib\/db\/[^"']*|\.\.\/db\/[^"']*)["']/.test(code)
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("PaymentTransferForm imports exactly one money-movement action", () => {
    const form = clientModules.find(({ file }) =>
      file.endsWith("components/PaymentTransferForm.tsx")
    );
    expect(form, "PaymentTransferForm not found").toBeDefined();

    const code = form!.code;
    expect(code).toMatch(/import\s+\{\s*initiateTransfer\s*\}\s+from/);

    // The four primitives it used to orchestrate with must be gone.
    for (const removed of [
      "createTransfer",
      "createTransaction",
      "getBankForLegacyTransfer",
      "getCounterpartyBankForLegacyTransfer",
    ]) {
      expect(code, `${removed} must not be reachable from the browser`).not.toContain(removed);
    }
  });
});

/**
 * THE DATABASE BOUNDARY.
 *
 * DATABASE_URL carries credentials and `pg` opens raw sockets. Neither may be
 * reachable from anything that ships to a browser.
 */
describe("PostgreSQL stays server-side", () => {
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
        code: stripComments(readFileSync(file, "utf8")),
      }))
      .filter(({ file }) => !/\.test\.tsx?$/.test(file));
  })();

  it("DATABASE_URL is referenced only from lib/db", () => {
    const offenders = sources
      .filter(({ code }) => /\bDATABASE_URL\b/.test(code))
      .map(({ file }) => file)
      .filter((file) => !file.startsWith("lib/db/"));

    expect(offenders).toEqual([]);
  });

  it("`pg` is imported only from lib/db", () => {
    const offenders = sources
      .filter(({ code }) => /from\s+["']pg["']/.test(code))
      .map(({ file }) => file)
      .filter((file) => !file.startsWith("lib/db/"));

    expect(offenders).toEqual([]);
  });

  it("every lib/db module declares server-only", () => {
    const dbModules = sources.filter(({ file }) => file.startsWith("lib/db/"));
    expect(dbModules.length).toBeGreaterThan(0);

    for (const { file, code } of dbModules) {
      // errors.ts is pure error classes with no I/O and no credentials, so it
      // is safe to import anywhere; everything else touches the pool.
      if (file.endsWith("errors.ts")) continue;
      expect(code, `${file} must import server-only`).toMatch(
        /import\s+["']server-only["']/
      );
    }
  });

  it("the SQL schema declares no provider-secret or balance column", () => {
    const migrationsDir = join(ROOT, "migrations");
    const sql = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
      .join("\n")
      // Strip BOTH line comments and single-quoted string literals. COMMENT ON
      // statements document why these fields are absent, so the prose would
      // otherwise make this test fail on the explanation of its own rule.
      .replace(/--.*$/gm, "")
      .replace(/'(?:[^']|'')*'/g, "''");

    for (const forbidden of [
      "access_token",
      "funding_source_url",
      "processor_token",
      "dwolla_customer_url",
      "ssn",
      "date_of_birth",
      "double precision",
      " real ",
    ]) {
      expect(sql.toLowerCase(), `schema must not declare ${forbidden}`).not.toContain(
        forbidden
      );
    }
  });

  /**
   * ONE definition, used by both the guard and the test that proves the guard
   * works. Declaring it twice meant mutating the guard's copy left the proof
   * test passing against its own private regex — the proof proved nothing about
   * the thing in use.
   */
  const STORED_BALANCE_COLUMN =
    /^\s*"?\w*balance\w*"?\s+(bigint|numeric|integer|int|decimal|money|smallint)\b/im;

  it("the migration seeds the same credit limit the code hands out", () => {
    // The migration fills existing rows; ensureCustomerAccount fills new ones.
    // If the two drift, accounts created before and after a deploy get
    // different allowances for no stated reason — and nothing would notice,
    // because both paths would look correct in isolation.
    const sql = readFileSync(
      join(ROOT, "migrations", "1700000004000_holds-and-available-balance.sql"),
      "utf8"
    );

    const seeded = /SET credit_limit_minor = (\d+)\s*\n\s*WHERE kind = 'customer'/.exec(
      sql
    );
    expect(seeded, "the migration must seed customer credit limits").toBeTruthy();
    expect(Number(seeded![1])).toBe(CUSTOMER_CREDIT_LIMIT_MINOR);
  });

  it("no stored available balance either", () => {
    // Available balance is the ledger balance, less active holds, plus the
    // account's limit — derived on every read. Storing it would be the same
    // defect as a stored balance, one step further removed from the entries
    // and the holds that justify it.
    const migrationsDir = join(ROOT, "migrations");
    const sql = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
      .join("\n")
      .replace(/--.*$/gm, "")
      .replace(/'(?:[^']|'')*'/g, "''");

    const NUMERIC = "(bigint|numeric|integer|int|decimal|money|smallint)\\b";

    for (const forbidden of ["available_balance\\w*", "held_total\\w*", "reserved_\\w*"]) {
      expect(
        sql.toLowerCase(),
        `schema must not declare a stored ${forbidden} column`
      ).not.toMatch(new RegExp(`^\\s*"?${forbidden}"?\\s+${NUMERIC}`, "im"));
    }
  });

  it("the SQL schema declares no STORED balance column", () => {
    const migrationsDir = join(ROOT, "migrations");
    const sql = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
      .join("\n")
      .replace(/--.*$/gm, "")
      .replace(/'(?:[^']|'')*'/g, "''");

    // A COLUMN DECLARATION, not the substring. The bare word appears
    // legitimately in the ledger — the balance trigger is named for what it
    // enforces — and failing on that would push the next author to rename the
    // guard rather than keep the rule. What must never exist is a stored
    // numeric balance: a second source of truth that drifts from the entries
    // silently. Balance is SUM(amount_minor), derived on every read.
    const storedBalanceColumn =
      /^\s*"?\w*balance\w*"?\s+(bigint|numeric|integer|int|decimal|money|smallint)\b/im;

    expect(
      storedBalanceColumn.test(sql),
      "schema must not declare a stored balance column — balance is derived from entries"
    ).toBe(false);
  });

  it("that guard would catch a stored balance column if one were added", () => {
    // The regex above is doing real work only if it matches the thing it
    // forbids. Asserting the absence alone would pass against a broken pattern.
    const storedBalanceColumn =
      /^\s*"?\w*balance\w*"?\s+(bigint|numeric|integer|int|decimal|money|smallint)\b/im;

    for (const planted of [
      "    balance        BIGINT      NOT NULL,",
      "    current_balance NUMERIC(20,2),",
      '    "available_balance" integer',
    ]) {
      expect(STORED_BALANCE_COLUMN.test(planted), planted).toBe(true);
    }
    // And not on the legitimate uses.
    expect(
      STORED_BALANCE_COLUMN.test("CREATE FUNCTION ledger_transaction_must_balance()")
    ).toBe(false);
  });
});

describe("server-only boundaries", () => {
  const mustBeServerOnly = [
    "lib/appwrite.ts",
    "lib/auth/actor.ts",
    "lib/plaid.ts",
    "lib/server/banks.ts",
    "lib/server/dwolla.ts",
    "lib/services/transfers.service.ts",
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

/**
 * THE MIGRATION-TOOLING BOUNDARY.
 *
 * `lib/migration/appwrite-source.ts` reads EVERY user and EVERY bank document,
 * ignoring ownership entirely. That is correct for a one-off operator backfill
 * and catastrophic in a request path: an unscoped read reachable from a server
 * action is an IDOR with the authorization check not merely bypassed but absent.
 *
 * The rule is therefore containment, not review. Operator tooling is reachable
 * only from scripts/.
 */
describe("migration tooling stays out of the request path", () => {
  const graph = (() => {
    const files: string[] = [];
    for (const dir of [...SEARCH, "scripts"]) {
      try {
        walk(join(ROOT, dir), files);
      } catch {
        /* directory may not exist */
      }
    }

    type Mod = {
      file: string;
      code: string;
      isClient: boolean;
      isAction: boolean;
      imports: string[];
    };
    const mods = new Map<string, Mod>();

    for (const full of files) {
      const rel = full.slice(ROOT.length).replace(/\\/g, "/");
      if (/\.test\.tsx?$/.test(rel)) continue;
      const raw = readFileSync(full, "utf8");
      const code = stripComments(raw);

      const imports = resolveRuntimeImports(code, rel);

      mods.set(rel, {
        file: rel,
        code,
        isClient: /^\s*["']use client["']/m.test(raw),
        isAction: /^\s*["']use server["']/m.test(raw),
        imports,
      });
    }
    return mods;
  })();

  /** Everything transitively imported by the given entry modules. */
  const closure = (entries: string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const dep of graph.get(cur)?.imports ?? []) {
        if (!seen.has(dep)) queue.push(dep);
      }
    }
    return seen;
  };

  const migrationModules = Array.from(graph.keys()).filter((f) =>
    f.startsWith("lib/migration/")
  );

  it("finds the migration modules", () => {
    expect(migrationModules).toContain("lib/migration/appwrite-source.ts");
    expect(migrationModules).toContain("lib/migration/backfill.ts");
    expect(migrationModules).toContain("lib/migration/verify.ts");
  });

  it("no server action reaches migration tooling, at any depth", () => {
    const actions = Array.from(graph.values())
      .filter((m) => m.isAction)
      .map((m) => m.file);
    expect(actions.length).toBeGreaterThan(0);

    // Not stopping at any boundary: everything an action imports runs on the
    // server with the action's authority.
    const reachable = closure(actions);
    const offenders = migrationModules.filter((f) => reachable.has(f));

    expect(offenders).toEqual([]);
  });

  it("no client-reachable module reaches migration tooling", () => {
    const clients = Array.from(graph.values())
      .filter((m) => m.isClient)
      .map((m) => m.file);
    expect(clients.length).toBeGreaterThan(0);

    const reachable = closure(clients);
    const offenders = migrationModules.filter((f) => reachable.has(f));

    expect(offenders).toEqual([]);
  });

  it("only scripts/ and lib/migration/ import the unscoped reader", () => {
    const importers = Array.from(graph.values())
      .filter((m) => m.imports.includes("lib/migration/appwrite-source.ts"))
      .map((m) => m.file);

    // Type-only imports are erased, so a module naming it in an `import type`
    // is not a runtime caller; the resolver above sees the specifier either way,
    // which makes this stricter than the runtime graph rather than looser.
    for (const importer of importers) {
      expect(
        importer.startsWith("scripts/") || importer.startsWith("lib/migration/"),
        `${importer} must not import the unscoped legacy reader`
      ).toBe(true);
    }
  });

  it("only scripts/ reaches the backfill and the verifier", () => {
    const entryPoints = ["lib/migration/backfill.ts", "lib/migration/verify.ts"];
    const importers = Array.from(graph.values())
      .filter((m) => m.imports.some((i) => entryPoints.includes(i)))
      .map((m) => m.file);

    expect(importers.length).toBeGreaterThan(0);
    for (const importer of importers) {
      expect(importer.startsWith("scripts/"), `${importer} must not run a backfill`).toBe(
        true
      );
    }
  });

  it("no request-time page, layout or route reaches migration tooling", () => {
    // Server components and route handlers run per request with the caller's
    // session in scope. An unscoped read of every user reachable from one is an
    // IDOR with no check to bypass, so this covers app/ whether or not the file
    // is marked "use client".
    const requestEntries = Array.from(graph.keys()).filter(
      (f) =>
        f.startsWith("app/") &&
        /\/(page|layout|route|template|error|loading|not-found)\.tsx?$/.test(f)
    );
    expect(requestEntries.length).toBeGreaterThan(0);

    const reachable = closure(requestEntries);
    expect(migrationModules.filter((f) => reachable.has(f))).toEqual([]);
  });

  it("no application repository or service reaches migration tooling", () => {
    // The actor-scoped repositories are the request path's data layer. If one
    // of them imported the unscoped reader, every caller would inherit it.
    const appDataLayer = Array.from(graph.keys()).filter(
      (f) =>
        f.startsWith("lib/repositories/") ||
        f.startsWith("lib/services/") ||
        f.startsWith("lib/server/")
    );
    expect(appDataLayer.length).toBeGreaterThan(0);

    const reachable = closure(appDataLayer);
    expect(migrationModules.filter((f) => reachable.has(f))).toEqual([]);
  });

  it("migration tooling does not import the application's request-path layers", () => {
    // The other direction. Operator tooling reusing an actor-scoped repository
    // would need an actor it does not have, and reusing a server action would
    // put a public endpoint in a migration.
    const offenders: string[] = [];
    for (const file of migrationModules) {
      for (const dep of graph.get(file)?.imports ?? []) {
        if (
          dep.startsWith("lib/repositories/") ||
          dep.startsWith("lib/services/") ||
          dep.startsWith("lib/actions/") ||
          graph.get(dep)?.isAction
        ) {
          offenders.push(`${file} -> ${dep}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE ONE PERMITTED CROSSING.
   *
   * Phase 6B kept PostgreSQL entirely out of every request path. Phase 7 opens
   * exactly one route into it — transfers need a durable idempotency claim, and
   * Appwrite cannot give one — and this list is the whole of it.
   *
   * An ALLOWLIST, not a deleted guard. Everything else in lib/db is still
   * unreachable from a request, and a second crossing fails this test. That is
   * the point: the boundary moved once, deliberately, and did not dissolve.
   *
   * `pool.ts` and `errors.ts` appear because the transfers repository imports
   * them; reaching the pool through a repository is the intended shape.
   * `migration/` is NOT here and never will be — those reads are unscoped.
   */
  // EXACT EQUALITY, NOT A SUBSET. Every entry here was a deliberate milestone
  // decision to let a request path reach PostgreSQL. Growing this list is how a
  // cutover happens by accident, so a new arrival must fail the test and be
  // argued for, not absorbed.
  //
  // The second group arrived with the webhook receiver: settlement is the point
  // at which the provider tells us what actually happened, and it writes the
  // ledger in the same transaction as the state change.
  const RUNTIME_DB_ALLOWLIST = [
    "lib/db/repositories/transfers.repository.ts",
    "lib/db/repositories/banking-customers.repository.ts",
    "lib/db/repositories/webhook-events.repository.ts",
    "lib/db/repositories/ledger.repository.ts",
    "lib/db/repositories/holds.repository.ts",
    // Milestone 11: transaction history now comes from the synced store instead
    // of a live Plaid call during SSR. READ-ONLY by construction — the module
    // that advances a cursor is a different file and stays operator-only.
    "lib/db/repositories/plaid-transactions.read.ts",
    "lib/db/pool.ts",
    "lib/db/errors.ts",
  ];

  it("only the transfer path reaches lib/db, and only these modules", () => {
    const requestEntries = Array.from(graph.values())
      .filter((m) => m.isAction || m.isClient || m.file.startsWith("app/"))
      .map((m) => m.file);

    const reachable = closure(requestEntries);
    const dbModules = Array.from(graph.keys()).filter((f) =>
      f.startsWith("lib/db/")
    );
    expect(dbModules.length).toBeGreaterThan(0);

    const crossings = dbModules.filter((f) => reachable.has(f)).sort();
    expect(crossings).toEqual([...RUNTIME_DB_ALLOWLIST].sort());
  });

  it("no request path reaches the migration tooling or the operator repositories", () => {
    // The parts of lib/db that remain operator-only. linked_accounts is written
    // by the backfill and read by the verifier; nothing serving a request has
    // any business touching it yet.
    const requestEntries = Array.from(graph.values())
      .filter((m) => m.isAction || m.isClient || m.file.startsWith("app/"))
      .map((m) => m.file);

    const reachable = closure(requestEntries);
    const forbidden = Array.from(graph.keys()).filter(
      (f) =>
        f.startsWith("lib/migration/") ||
        // Reconciliation reads EVERY transfer regardless of who owns it —
        // correct for an operator sweep, catastrophic in a request.
        f.startsWith("lib/reconciliation/") ||
        // Plaid sync ADVANCES A STORED CURSOR. Driving that from a page render
        // is the defect Milestone 10 removed: a render would advance sync state
        // as a side effect of someone loading a page, and two concurrent
        // renders would race the same item's cursor. The pure engine and
        // adapter are deliberately NOT here — they hold no state and the render
        // path uses them to paginate correctly without persisting anything.
        f === "lib/plaid-sync/sync.ts" ||
        f === "lib/db/repositories/plaid-items.repository.ts" ||
        f === "lib/db/repositories/linked-accounts.repository.ts" ||
        f === "lib/db/test-database.ts" ||
        f === "lib/db/health.ts"
    );

    expect(forbidden.length).toBeGreaterThan(0);
    expect(forbidden.filter((f) => reachable.has(f))).toEqual([]);
  });

  it("the crossing is a service, not a component, a route body or an action body", () => {
    // Where the boundary is crossed matters as much as that it is. A client
    // component importing a repository directly would put a database call one
    // refactor away from the browser bundle; a route handler doing its own
    // database work would put the decisions somewhere no test can reach without
    // standing up a server.
    const DB_REPOSITORIES = [
      "lib/db/repositories/transfers.repository.ts",
      "lib/db/repositories/webhook-events.repository.ts",
      "lib/db/repositories/ledger.repository.ts",
      "lib/db/repositories/holds.repository.ts",
    ];

    const importers = Array.from(
      new Set(
        Array.from(graph.values())
          .filter((m) => m.imports.some((i) => DB_REPOSITORIES.includes(i)))
          .map((m) => m.file)
      )
    ).sort();

    expect(importers).toEqual([
      "lib/services/settlement.service.ts",
      "lib/services/transfers.service.ts",
    ]);
  });

  it("the webhook route delegates and does not decide", () => {
    // A webhook handler is the easiest place in an application for logic to
    // accumulate out of reach of the tests: it needs an HTTP request to call, so
    // whatever lives in it tends to go unasserted. Keeping the route free of
    // database and provider imports is what keeps the decisions in a service
    // that a unit test can call directly.
    const route = graph.get("app/api/webhooks/dwolla/route.ts");
    expect(route, "the webhook route must exist").toBeTruthy();

    const forbidden = route!.imports.filter(
      (i) =>
        i.startsWith("lib/db/") ||
        i.startsWith("lib/repositories/") ||
        i === "lib/server/dwolla.ts"
    );
    expect(forbidden).toEqual([]);
  });

  it("only the transfers repository writes a transfer state", () => {
    // `settled` means money moved. If any module besides the one repository can
    // assign a transfer state, the system can declare a settlement on its own
    // say-so, which is the entire failure this milestone exists to prevent.
    //
    // Matches SQL assignment (`state = 'settled'`), not the words themselves:
    // the service and the tests name these states constantly.
    const ASSIGNS_STATE = /\bstate\s*=\s*'(requested|submitted|settled|failed|returned)'/;

    const writers = Array.from(graph.values())
      .filter((m) => !m.file.endsWith(".test.ts") && ASSIGNS_STATE.test(m.code))
      .map((m) => m.file)
      .sort();

    // Non-vacuous by construction: that repository does assign states, so an
    // expression that matched nothing would fail here rather than pass quietly.
    expect(writers).toEqual(["lib/db/repositories/transfers.repository.ts"]);
  });

  it("a transfer can only become terminal from submitted", () => {
    const code = graph.get("lib/db/repositories/transfers.repository.ts")!.code;
    const markTerminal = code.slice(code.indexOf("export async function markTerminal"));
    expect(markTerminal).toContain("export async function markTerminal");

    // The state machine is in the WHERE clause, not in an `if` somebody has to
    // remember to write. Without this predicate a redelivered webhook, or two
    // events arriving out of order, rewrites a terminal transfer.
    expect(markTerminal).toMatch(/WHERE\s+id = \$1\s+AND\s+state = 'submitted'/);
  });

  it("reconciliation issues no write, in any module", () => {
    // THE ENTIRE VALUE OF A RECONCILER IS THAT IT OBSERVES. One that repairs
    // drift destroys the evidence of what caused it, and the cause is the thing
    // that matters — a ledger disagreeing with a provider means something
    // upstream is wrong, and quietly editing rows until the numbers agree is
    // how a bug becomes permanent.
    //
    // Asserted against the source rather than trusted to a docstring: "it never
    // writes" is exactly the kind of promise that survives in a comment long
    // after it stopped being true.
    const files = Array.from(graph.keys()).filter((f) =>
      f.startsWith("lib/reconciliation/")
    );
    expect(files.length).toBeGreaterThan(0);

    // No trailing \b: the first version ended the alternation with one after
    // `update\s+\w`, which can never match — a word character is never followed
    // by a word boundary mid-word. It reported clean against a reconciler that
    // had been given a real UPDATE, which is the precise failure this file
    // exists to prevent, so the regex is now mutation-checked like any other
    // guard.
    const WRITE =
      /\b(insert\s+into|update\s+"?\w|delete\s+from|truncate\b|drop\s+table|alter\s+table|set_config)/i;

    for (const file of files) {
      // Comments are stripped first: they describe what this must never do, and
      // the prose would otherwise fail the test on its own explanation.
      expect(WRITE.test(graph.get(file)!.code), `${file} must issue no write`).toBe(
        false
      );
    }
  });

  it("the reconciler declares server-only and is reached only from scripts", () => {
    const reconcile = graph.get("lib/reconciliation/reconcile.ts");
    expect(reconcile, "the reconciler must exist").toBeTruthy();
    expect(reconcile!.code).toMatch(/import\s+["']server-only["']/);

    const importers = Array.from(graph.values())
      .filter((m) => m.imports.includes("lib/reconciliation/reconcile.ts"))
      .map((m) => m.file)
      .sort();

    expect(importers).toEqual(["scripts/db-reconcile.ts"]);
  });

  it("NO render path calls Plaid for transactions at all", () => {
    // Milestone 10 made the render-path loop correct; Milestone 11 removed it.
    // Transaction history is read from the synced store, so a page render does
    // no Plaid pagination — not a bounded amount, none.
    //
    // The earlier version of this test asserted the render path DID reach the
    // pagination engine, which was right while the loop still existed there.
    // Asserting it now would forbid the fix.
    const banks = graph.get("lib/server/banks.ts");
    expect(banks, "the render-path bank reader must exist").toBeTruthy();

    const reachable = closure(["lib/server/banks.ts"]);

    expect(reachable.has("lib/plaid-sync/engine.ts")).toBe(false);
    expect(reachable.has("lib/plaid-sync/sync.ts")).toBe(false);
    expect(reachable.has("lib/db/repositories/plaid-items.repository.ts")).toBe(
      false
    );
  });

  it("the request-path Plaid read issues no write", () => {
    // The read half of the store is reachable from a request; the half that
    // advances a cursor is not. That split only holds if the reachable half
    // genuinely cannot write — a render that moves sync state lets two
    // concurrent page loads race the same Item.
    const read = graph.get("lib/db/repositories/plaid-transactions.read.ts");
    expect(read, "the request-path Plaid read must exist").toBeTruthy();

    const WRITE =
      /\b(insert\s+into|update\s+"?\w|delete\s+from|truncate\b|drop\s+table|alter\s+table|set_config)/i;

    expect(WRITE.test(read!.code)).toBe(false);
    expect(read!.imports).not.toContain(
      "lib/db/repositories/plaid-items.repository.ts"
    );
  });

  it("the sync loop cannot be written without a cursor again", () => {
    // The original defect in one line: `transactionsSync({ access_token })` with
    // no cursor, which returns the same first page forever. Every call site must
    // either pass a cursor or be the deliberate first-page case that names it.
    // Scoped to the CALL, not the file. The first version of this guard just
    // asked whether the module mentioned "cursor" anywhere, which the enclosing
    // `async (cursor) =>` satisfied — so it stayed green against a call reverted
    // to `transactionsSync({ access_token })`. A guard a nearby identifier can
    // satisfy is not a guard.
    const CALL = /transactionsSync\s*\(/g;

    let callSites = 0;
    for (const mod of Array.from(graph.values())) {
      let match: RegExpExecArray | null;
      const rx = new RegExp(CALL.source, CALL.flags);

      while ((match = rx.exec(mod.code)) !== null) {
        callSites += 1;

        // The argument expression: from the opening paren to its match.
        let depth = 0;
        let end = match.index + match[0].length - 1;
        for (let i = end; i < mod.code.length; i += 1) {
          if (mod.code[i] === "(") depth += 1;
          else if (mod.code[i] === ")") {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const args = mod.code.slice(match.index, end + 1);

        expect(
          args,
          `${mod.file}: transactionsSync must be called with a cursor`
        ).toMatch(/\bcursor\b/);
      }
    }

    expect(callSites, "no transactionsSync call sites found").toBeGreaterThan(0);
  });

  /**
   * What a client component actually BUNDLES.
   *
   * A `'use server'` module is an RPC boundary: Next replaces the import with a
   * reference and the action's own imports never reach the browser. So the
   * bundle closure stops AT an action rather than traversing through it.
   *
   * Getting this wrong in either direction is bad. Treating the boundary as
   * transparent forbids a repository from doing any server-side work at all —
   * every repository is reachable through some action, including the ones
   * holding the Appwrite admin key, and that has always been correct. Ignoring
   * the boundary entirely would miss a client component importing a server
   * module DIRECTLY, which is the case that genuinely bundles.
   *
   * Capability containment — what an action can reach — is a different question
   * and is asserted separately, by the action-closure tests above.
   */
  const clientBundleClosure = (): Set<string> => {
    const seen = new Set<string>();
    const queue = Array.from(graph.values())
      .filter((m) => m.isClient)
      .map((m) => m.file);

    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);

      const mod = graph.get(cur);

      // An action IS reachable — it is in `seen` above, as the stub the bundler
      // emits — but its own imports are not bundled, so the walk stops here.
      if (mod?.isAction) continue;

      for (const dep of mod?.imports ?? []) {
        if (!seen.has(dep)) queue.push(dep);
      }
    }
    return seen;
  };

  it("no key material can reach the browser bundle", () => {
    // THE WORST PLACE A KEY COULD END UP. A client component importing the
    // keyring — even unused — puts key material in the bundle and, more
    // durably, in the source map, which tree-shaking does not touch. That would
    // make every encrypted credential readable by anyone who opened devtools.
    const bundled = clientBundleClosure();

    expect(bundled.has("lib/crypto/keyring.ts")).toBe(false);
    expect(bundled.has("lib/crypto/envelope.ts")).toBe(false);
  });

  it("the bundle closure stops at an action but not before it", () => {
    // The closure above is only meaningful if it genuinely walks past a client
    // component into its non-action imports, and genuinely stops at an action.
    // Without this, a closure that returned almost nothing would pass every
    // bundle test in this file.
    const bundled = clientBundleClosure();

    // It reaches a plain module a client imports directly.
    expect(bundled.has("lib/utils.ts")).toBe(true);
    // It does not walk THROUGH an action into that action's server-side
    // dependencies.
    expect(bundled.has("lib/appwrite.ts")).toBe(false);
  });

  it("the crypto modules declare server-only", () => {
    for (const file of ["lib/crypto/keyring.ts", "lib/crypto/envelope.ts"]) {
      const mod = graph.get(file);
      expect(mod, `${file} must exist`).toBeTruthy();
      expect(mod!.code, `${file} must import server-only`).toMatch(
        /import\s+["']server-only["']/
      );
    }
  });

  it("only the storage boundary and its migration handle ciphertext", () => {
    // Encryption belongs at the point of storage. Spreading encrypt/decrypt
    // through services would mean every caller deciding what to bind a ciphertext
    // to, and a caller that got the binding wrong would silently disable the
    // protection against a moved ciphertext.
    const importers = Array.from(graph.values())
      .filter((m) => m.imports.includes("lib/crypto/envelope.ts"))
      .map((m) => m.file)
      .sort();

    expect(importers).toEqual([
      // Inside the crypto boundary itself: the self-test proves the configured
      // keyring can actually protect a value. It is listed here rather than
      // allowlisting the operator script, so encrypt/decrypt stays confined to
      // lib/crypto, the storage boundary, and the migration.
      "lib/crypto/self-test.ts",
      "lib/migration/credential-encryption.ts",
      "lib/repositories/banks.repository.ts",
    ]);
  });

  it("no credential-encryption key is read outside the keyring", () => {
    // One place reads the key material from the environment. A second reader is
    // how a module ends up with a key it does not need and cannot be audited
    // for.
    const readers = Array.from(graph.values())
      .filter((m) => m.code.includes("CREDENTIAL_ENCRYPTION_KEYS"))
      .map((m) => m.file)
      .sort();

    expect(readers).toEqual(["lib/crypto/keyring.ts"]);
  });

  it("every migration module that performs I/O declares server-only", () => {
    // mapping.ts and report-format.ts are pure — no clients, no environment,
    // no I/O. They stay importable anywhere and are tested without a database.
    // report-format.ts returns lines rather than printing them precisely so it
    // can be asserted against for what it must never emit.
    // lock.ts is a single exported number with no imports at all — shared by
    // the backfill and the verifier precisely so the verifier need not import
    // the backfill. A shared constant is not a shared capability.
    const PURE = ["mapping.ts", "report-format.ts", "lock.ts"];

    for (const file of migrationModules) {
      if (PURE.some((p) => file.endsWith(p))) continue;
      expect(graph.get(file)!.code, `${file} must import server-only`).toMatch(
        /import\s+["']server-only["']/
      );
    }
  });

  it("the migration writes no provider credential", () => {
    // The plan carries an access token to enrich metadata and discards it. It
    // must never be handed to a repository.
    const backfill = graph.get("lib/migration/backfill.ts")!.code;
    const upsertCall = backfill.slice(backfill.indexOf("upsertAccount("));

    for (const forbidden of [
      "accessTokenForEnrichment",
      "processorToken",
      "fundingSourceUrl",
      "shareableId",
    ]) {
      expect(upsertCall, `${forbidden} must not be written to PostgreSQL`).not.toContain(
        forbidden
      );
    }
  });
});
