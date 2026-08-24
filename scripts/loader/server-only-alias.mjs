/**
 * Resolve `server-only` to its empty module for operator scripts.
 *
 * `server-only` is a BUILD-TIME marker: it means "this module must never end up
 * in a client bundle". Its default entry throws unconditionally, and the
 * harmless empty entry is reachable only through the `react-server` export
 * condition, which bundlers set and plain Node does not.
 *
 * A backfill legitimately runs these modules in a Node process, so the marker
 * has to be neutralised. The obvious lever — `node --conditions=react-server` —
 * is too blunt: it also flips `react` to its server-components entry, which
 * throws outside React's experimental channel as soon as anything reaches
 * `next/headers`.
 *
 * So the alias is narrowed to exactly one specifier. This mirrors the alias
 * vitest.config.ts already applies for the same reason.
 *
 * registerHooks, not register: tsx transpiles these .ts files to CommonJS, so
 * `import "server-only"` becomes a `require()` call. An ESM-only resolve hook
 * never sees it. registerHooks runs synchronously in-thread and covers both
 * module systems.
 *
 * Neutralising the marker does NOT relax the boundary it marks. What keeps
 * these modules out of the browser is the architecture suite in
 * lib/server-action-surface.test.ts, which proves no client-reachable module
 * imports them.
 */
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const EMPTY = pathToFileURL(
  join(dirname(require.resolve("server-only")), "empty.js")
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: EMPTY, format: "commonjs", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
