# Dependency upgrade results

Completed 2026-09-08 against the [dependency upgrade plan](dependency-upgrade-plan.md).
Tracks A-D are implemented as separate commits. Track E (Next.js 16) remains a
separate migration decision, as specified in the plan; Next.js stays at 14.2.35.

| Track | Upgrade | Production audit after upgrade |
|---|---|---|
| Baseline | Before these four tracks | 21 affected packages: 1 critical, 12 high, 8 moderate |
| A | Dwolla 3.4.0 -> 3.4.2 | 21: 1 critical, 12 high, 8 moderate |
| B | Plaid 23.0.0 -> 47.0.0 | 18: 0 critical, 11 high, 7 moderate |
| C | Appwrite 12.0.1 -> 29.0.0 | 17: 0 critical, 10 high, 7 moderate |
| D | Sentry 7.112.2 -> 10.73.0 | 13: 0 critical, 8 high, 5 moderate |

Counts come from `npm audit --omit=dev` and count affected packages, not unique
advisories. All four target SDK versions are pinned exactly in the manifest.

## Implementation

- Dwolla and Plaid require no changes to the application's SDK calls. The Plaid
  upgrade also refreshes Axios, form-data, and follow-redirects in the lockfile.
- Appwrite runtime calls remain compatible. Schema tooling now uses the SDK's
  native TablesDB API in place of the handwritten HTTP adapter. Column and index
  responses are normalized to preserve the existing schema validation contract.
  Four transport tests exercise the real SDK with mocked HTTP transport.
- Sentry uses the current two-argument build configuration and Next.js 14's
  instrumentation hook for server and edge initialization. Initialization remains
  conditional on a DSN, with privacy and sampling defaults preserved. Builds
  without an upload token disable source maps; upload-enabled configuration requests
  deletion after upload. Eight tests cover initialization and privacy defaults.

## Validation

Each track passed TypeScript checking, ESLint, application tests, database tests,
the production build, and client credential/source-map artifact scans.
The final run passed **698 application tests and 326 database tests**.
The Sentry build passed without any Sentry environment configuration; its client
artifacts contained no source maps or scanned credential patterns. Uploads with a
real Sentry auth token were not exercised.

Appwrite operator checks also passed: credential-keyring checks, credential
encryption dry run (six credentials already encrypted), database backfill dry run
(two users and three banks), and database verification without identity/linkage
drift. These checks did not perform a backfill or credential rewrite.

The additional live Appwrite schema check returned HTTP 401
`general_unauthorized_scope`. The previous raw HTTP transport and the upgraded SDK
both returned the same error with the configured key. Live schema verification
therefore remains limited by the existing key's scope; schema permissions were
not changed. Local SDK transport/schema validation tests passed.

Sentry emits a non-blocking recommendation to use `instrumentation-client.ts`
with Turbopack. The current Next.js 14 webpack build retains
`sentry.client.config.ts`; that convention can change with Track E.

## Remaining audit findings

The final audit still flags `@babel/runtime`, `brace-expansion`, `braces`,
`cross-spawn`, `decode-uri-component`, `glob`, `micromatch`, `minimatch`, `next`,
`picomatch`, `postcss`, `query-string`, and `yaml`. The four SDK upgrades remove
the remaining critical finding but do not make the dependency tree advisory-free.
These findings require follow-up dependency work, including the separately scoped
Next.js migration.

## Vendor references reviewed

- [Plaid changelog](https://github.com/plaid/plaid-node/blob/master/CHANGELOG.md), including breaking changes between versions 24 and 47.
- [Appwrite 29.0.0 release](https://github.com/appwrite/sdk-for-node/releases/tag/29.0.0) and its [TablesDB implementation](https://github.com/appwrite/sdk-for-node/blob/29.0.0/src/services/tables-db.ts).
- Sentry's [v7 to v8](https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v7-to-v8/), [v8 to v9](https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v8-to-v9/), and [v9 to v10](https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v9-to-v10/) migration guides, plus the installed 10.73.0 configuration types.
