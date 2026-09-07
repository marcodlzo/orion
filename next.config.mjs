import { withSentryConfig } from "@sentry/nextjs/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Quality gates are deliberately enabled. TypeScript and ESLint failures
  // must block a build. Do not reintroduce ignoreBuildErrors /
  // ignoreDuringBuilds: they are what allowed type errors to ship previously.
  experimental: { instrumentationHook: true },
  productionBrowserSourceMaps: false,
};

// Sentry is optional and configured entirely through environment variables.
// Without an upload token, disable source-map generation entirely. Hidden maps
// are still publicly downloadable, and upload-time deletion cannot protect a
// build that never uploads them.
const hasSentryAuth = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(
  nextConfig,
  {
    silent: true,
    telemetry: false,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    // Upload a larger set of source maps for prettier stack traces.
    widenClientFileUpload: true,

    sourcemaps: {
      disable: !hasSentryAuth,
      deleteSourcemapsAfterUpload: true,
    },

    // Tree-shake Sentry logger statements out of the bundle.
    webpack: { treeshake: { removeDebugLogging: true } },
  }
);
