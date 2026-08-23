// Sentry browser-side initialisation.
//
// Sentry is OPTIONAL. It activates only when NEXT_PUBLIC_SENTRY_DSN is set.
// With no DSN the SDK is never initialised, nothing is transmitted, and the
// application builds and runs normally.
//
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

    // Sample rates default to 0 so telemetry volume is an explicit decision.
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0),
    replaysSessionSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE ?? 0
    ),
    replaysOnErrorSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE ?? 0
    ),

    debug: false,

    // This application handles SSN, bank credentials and provider tokens.
    // Never send PII, and mask everything in any replay that is enabled.
    sendDefaultPii: false,

    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
  });
}
