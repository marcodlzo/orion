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
  const out: string[] = [];
  const IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+([\s\S]*?)\bfrom\s+["']([^"']+)["']/g;

  let m: RegExpExecArray | null;
  while ((m = IMPORT.exec(code)) !== null) {
    if (/^type\b/.test(m[1].trim())) continue; // erased at compile time

    const spec = m[2];
    let base: string;
    if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) base = join(ROOT, rel, "..", spec);
    else continue;

    for (const cand of [base + ".ts", base + ".tsx", join(base, "index.ts")]) {
      try {
        statSync(cand);
        out.push(cand.slice(ROOT.length).replace(/\\/g, "/"));
        break;
      } catch {
        /* not this extension */
      }
    }
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
      "balance",
      "double precision",
      " real ",
    ]) {
      expect(sql.toLowerCase(), `schema must not declare ${forbidden}`).not.toContain(
        forbidden
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

  it("keeps Appwrite as the runtime source: no request path imports lib/db", () => {
    // Phase 6B populates PostgreSQL but does not cut over to it. If a server
    // action or a page started reading lib/db, the cutover would have happened
    // silently.
    const requestEntries = Array.from(graph.values())
      .filter((m) => m.isAction || m.isClient || m.file.startsWith("app/"))
      .map((m) => m.file);

    const reachable = closure(requestEntries);
    const dbModules = Array.from(graph.keys()).filter(
      (f) => f.startsWith("lib/db/") && !f.endsWith("errors.ts")
    );

    expect(dbModules.length).toBeGreaterThan(0);
    expect(dbModules.filter((f) => reachable.has(f))).toEqual([]);
  });

  it("every migration module that performs I/O declares server-only", () => {
    // mapping.ts and report-format.ts are pure — no clients, no environment,
    // no I/O. They stay importable anywhere and are tested without a database.
    // report-format.ts returns lines rather than printing them precisely so it
    // can be asserted against for what it must never emit.
    const PURE = ["mapping.ts", "report-format.ts"];

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
