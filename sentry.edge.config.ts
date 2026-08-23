// Sentry edge-runtime initialisation (middleware, edge routes).
//
// Sentry is OPTIONAL. It activates only when SENTRY_DSN is set. With no DSN
// the SDK is never initialised, nothing is transmitted, and the application
// builds and runs normally.
//
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),

    debug: false,

    sendDefaultPii: false,
  });
}
