import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Quality gates are deliberately enabled. TypeScript and ESLint failures
  // must block a build. Do not reintroduce ignoreBuildErrors /
  // ignoreDuringBuilds: they are what allowed type errors to ship previously.
};

// Sentry is optional and configured entirely through environment variables.
// Source-map upload requires an auth token; without one the plugin runs in
// dry-run mode so a build never fails on missing Sentry configuration.
const hasSentryAuth = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(
  nextConfig,
  {
    silent: true,
    dryRun: !hasSentryAuth,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
  },
  {
    // Upload a larger set of source maps for prettier stack traces.
    widenClientFileUpload: true,

    // Never emit source maps into the client bundle. The audit found tutorial
    // Plaid tokens readable from a served .js.map even though they had been
    // tree-shaken out of the .js itself.
    hideSourceMaps: true,
    disableClientWebpackPlugin: !hasSentryAuth,
    disableServerWebpackPlugin: !hasSentryAuth,

    // Tree-shake Sentry logger statements out of the bundle.
    disableLogger: true,
  }
);
