import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * PostgreSQL integration tests.
 *
 * Separate from `npm test` because these require a running database. Keeping
 * them apart means the application suite stays fast and hermetic, while these
 * are impossible to pass by accident.
 *
 * They do NOT skip when the database is missing. A schema suite that silently
 * skips is worse than no suite: it reports green while proving nothing.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["**/*.db.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    // Schema tests share one database. Running files in parallel would let one
    // file's truncate land in the middle of another's assertions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
