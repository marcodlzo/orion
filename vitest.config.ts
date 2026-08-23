import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the "@/*" -> "./*" alias in tsconfig.json.
      "@": fileURLToPath(new URL("./", import.meta.url)),

      // "server-only" ships a conditional export: the "react-server" condition
      // resolves to an empty module, anything else to a module that throws.
      // Next.js sets that condition on the server; Vitest does not, so an
      // otherwise valid server module would fail to import under test.
      // Point it at the same empty entry Next.js uses rather than flipping
      // resolve conditions globally, which would also affect React.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
    // Financial tests must be able to run genuinely in parallel. Sequential
    // "concurrency" tests prove nothing.
    pool: "threads",
    restoreMocks: true,
    clearMocks: true,
  },
});
