import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { init, replayIntegration } = vi.hoisted(() => ({
  init: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
}));
vi.mock("@sentry/nextjs", () => ({ init, replayIntegration }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "NEXT_RUNTIME",
    "SENTRY_TRACES_SAMPLE_RATE", "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE",
    "NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE", "NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE"]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("Sentry remains optional and private after the SDK migration", () => {
  it.each(["client", "server", "edge"])("does not initialize %s telemetry without a DSN", async (runtime) => {
    if (runtime === "client") await import("./sentry.client.config");
    if (runtime === "server") await import("./sentry.server.config");
    if (runtime === "edge") await import("./sentry.edge.config");
    expect(init).not.toHaveBeenCalled();
    expect(replayIntegration).not.toHaveBeenCalled();
  });

  it.each(["nodejs", "edge"])("initializes only the selected %s runtime from the instrumentation hook", async (runtime) => {
    vi.stubEnv("NEXT_RUNTIME", runtime);
    vi.stubEnv("SENTRY_DSN", "https://test-key@example.invalid/1");
    const { register } = await import("./instrumentation");
    await register();
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: "https://test-key@example.invalid/1", sendDefaultPii: false, tracesSampleRate: 0, debug: false,
    }));
    expect(replayIntegration).not.toHaveBeenCalled();
  });

  it("keeps browser replay masking and zero sampling defaults", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://test-key@example.invalid/1");
    await import("./sentry.client.config");
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      sendDefaultPii: false, debug: false, tracesSampleRate: 0,
      replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0,
    }));
    expect(replayIntegration).toHaveBeenCalledWith({
      maskAllText: true, maskAllInputs: true, blockAllMedia: true,
    });
  });

  it.each(["server", "edge"])("preserves the public DSN fallback for %s", async (runtime) => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://test-key@example.invalid/1");
    if (runtime === "server") await import("./sentry.server.config");
    if (runtime === "edge") await import("./sentry.edge.config");
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: "https://test-key@example.invalid/1", sendDefaultPii: false,
    }));
  });
});
