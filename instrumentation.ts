// Sentry 8+ initializes server and edge SDKs through Next's instrumentation
// hook. Each configuration still requires a DSN before initializing telemetry.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
