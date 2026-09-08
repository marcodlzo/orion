import { defineConfig, devices } from "@playwright/test";

if (!process.env.ORION_E2E_DATABASE_URL) throw new Error("Run npm run test:e2e to enforce database isolation");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0, // A retry must not silently create another provider-side fixture.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:3101",
    // Auth and Link exchanges contain credentials. Do not persist them in traces.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3101",
    url: "http://localhost:3101/sign-in",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATABASE_URL: process.env.ORION_E2E_DATABASE_URL },
    // Silent by default: server logs can carry provider error objects from a
    // Link exchange. Flip both to "pipe" when a failure needs the server's side
    // of the story — that is the debugging step, not the default.
    stdout: "ignore",
    stderr: "ignore",
  },
});
