import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      // Use the actual React server runtime Next 14 aliases into App Router.
      // The standalone React 18 package has no cache(), and replacing it with
      // a fake memo would conceal request-isolation bugs.
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL(
          "./node_modules/next/dist/server/future/route-modules/app-page/vendored/rsc/react.js",
          import.meta.url
        )),
      },
      // Mirrors the "@/*" -> "./*" alias in tsconfig.json.
      { find: "@", replacement: fileURLToPath(new URL("./", import.meta.url)) },

      // "server-only" ships a conditional export: the "react-server" condition
      // resolves to an empty module, anything else to a module that throws.
      // Next.js sets that condition on the server; Vitest does not, so an
      // otherwise valid server module would fail to import under test.
      // Point it at the same empty entry Next.js uses rather than flipping
      // resolve conditions globally, which would also affect React.
      { find: "server-only", replacement: fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url)
      ) },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // *.db.test.ts needs a live PostgreSQL and runs under vitest.db.config.ts
    // via `npm run test:db`. Kept out so the application suite stays hermetic.
    exclude: ["node_modules/**", ".next/**", "**/*.db.test.ts"],
    // Financial tests must be able to run genuinely in parallel. Sequential
    // "concurrency" tests prove nothing.
    pool: "threads",
    restoreMocks: true,
    clearMocks: true,
  },
});
