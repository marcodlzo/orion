# Dependency upgrade plan

Status 2026-09-08: Tracks A-D are complete. See [implementation and validation results](dependency-upgrade-results.md). Track E remains a separate migration decision.

Written 2026-09-07, after upgrading Next.js 14.2.3 to 14.2.35.

Five tracks remain. They are independent and should land as separate commits.
The SDK usage in each section was mapped from this repository; the breaking
changes were read from vendor documentation and are marked where they need
re-confirming against the exact target version.

## Current position

`npm audit --omit=dev` reports 21 advisories: 1 critical, 12 high, 8 moderate.
The Next upgrade already closed one critical and one high.

| Track | Package | Installed | Latest | Severity carried | Risk of upgrade |
|---|---|---|---|---|---|
| A | `dwolla-v2` | 3.4.0 | 3.4.2 | none | trivial |
| B | `plaid` | 23.0.0 | 47.0.0 | **critical** | low |
| C | `node-appwrite` | 12.0.1 | 29.0.0 | high | medium |
| D | `@sentry/nextjs` | 7.112.2 | 10.73.0 | high | medium |
| E | `next` | 14.2.35 | 16.x | high | large |

Recommended order is A, B, C, D, E. That is roughly increasing risk, and it
front-loads the remaining critical.

---

## Track A — `dwolla-v2` 3.4.0 to 3.4.2

**Patch release. Do this first because it is free.**

Usage is two files and three calls:

- `lib/server/dwolla.ts` imports `Client`
- `dwollaClient.post` twice, `dwollaClient.get` once

No advisory attached. It is here only so the lockfile has one fewer stale entry.

```bash
npm install dwolla-v2@3.4.2
```

---

## Track B — `plaid` 23.0.0 to 47.0.0

**Closes the last critical advisory. Do this second.**

The critical is not in Plaid's own code. It is `form-data`, reached through
`axios@1.6.8`, which Plaid 23 pins. Plaid 47 pins a current axios, which also
clears the high-severity axios server-side request forgery advisory.

### Surface in this repository

Two import sites:

- `lib/plaid.ts` — `Configuration`, `PlaidApi`, `PlaidEnvironments`
- `lib/actions/user.actions.ts` — `CountryCode`, `Products`,
  `ProcessorTokenCreateRequest`, `ProcessorTokenCreateRequestProcessorEnum`

Five distinct API calls in the whole codebase:

| Call | Where |
|---|---|
| `accountsGet` (×3) | `lib/server/banks.ts` |
| `linkTokenCreate` | `lib/actions/user.actions.ts` |
| `itemPublicTokenExchange` | `lib/actions/user.actions.ts` |
| `processorTokenCreate` | `lib/actions/user.actions.ts` |
| `transactionsSync` | `lib/plaid-sync/` |

All five are core, long-stable endpoints. The client is generated from Plaid's
OpenAPI schema, so most major bumps are additive schema regenerations rather
than redesigns, and each release annotates its own breaking changes.

### What to check

1. Read every `Breaking changes in this version` heading between 24 and 47 in
   the plaid-node changelog. Most will not apply, because this repository uses
   five endpoints.
2. `PlaidEnvironments.sandbox` is hardcoded in `lib/plaid.ts` and `PLAID_ENV` is
   deliberately ignored. Keep it that way. Making the environment configurable
   is a deployment concern and a pinned sandbox is the safe default.
3. The enum import `ProcessorTokenCreateRequestProcessorEnum` is the most likely
   thing to have been renamed. It is used once, for Dwolla.
4. `transactionsSync` must still be called WITH a cursor. A test scopes that
   check to the call expression rather than the file, because the enclosing
   `(cursor) =>` parameter satisfied a file-wide version.

### What must not change

- Money crosses from Plaid as a float and becomes integer minor units in
  `lib/plaid-sync/adapter.ts`, through the decimal representation, never
  `amount * 100`. If a regenerated type changes the shape of an amount, fix the
  adapter, not the domain.
- Provider types stop at the adapter edge. Do not let a regenerated Plaid type
  spread into domain, ledger or transfer code.

---

## Track C — `node-appwrite` 12.0.1 to 29.0.0

**Clears a high advisory and may retire a workaround. Do this third.**

The high is `undici@5.28.4`, pinned by node-appwrite 12.

### The second reason to do this

Appwrite Cloud moved schema management from the legacy
`/databases/{id}/collections/...` routes to `/tablesdb/{id}/tables/...`. The
legacy routes now return 401 `general_unauthorized_scope` regardless of which
scopes the API key holds. This is not a permissions problem and no amount of
ticking boxes in the console fixes it — the SDK is calling routes the server no
longer authorises.

That was verified directly against the live project: every legacy route returned
401 while every TablesDB equivalent returned 200 with the same key.

The workaround is a hand-written HTTP client, `scripts/appwrite-tablesdb.ts`,
which keeps the old method names so `scripts/appwrite-schema.ts` did not have to
change. A current SDK should speak TablesDB natively and let that file be
deleted.

### Surface in this repository

| Import | Files |
|---|---|
| `Client`, `Account`, `Databases`, `Users` | `lib/appwrite.ts` |
| `ID`, `Query` | `lib/repositories/{users,banks,transactions,accounts}.repository.ts`, `lib/migration/appwrite-source.ts` |

Seven distinct methods across the codebase:

`database.listDocuments` (×9), `database.createDocument` (×3),
`database.updateDocument`, `account.get`, `account.create`,
`account.createEmailPasswordSession`, `account.deleteSession`.

### What to check

1. **The document methods are deprecated, not removed.** `listDocuments` and
   `createDocument` remain backwards compatible in current SDKs. This is why the
   upgrade is medium rather than large risk: the repositories may not need to
   change at all. Confirm this against 29 before assuming it.
2. Root factory methods now require explicit IDs in newer versions. Check
   `lib/appwrite.ts` where the clients are constructed.
3. `IndexType` was renamed and split into `DatabasesIndexType` and
   `TablesDBIndexType`. Only `scripts/appwrite-schema.ts` creates indexes.
4. If the SDK speaks TablesDB natively, delete `scripts/appwrite-tablesdb.ts`
   and point `scripts/appwrite-schema.ts` at the SDK. Keep the two normalisers
   in mind when you do: TablesDB reports an index's members as `columns` where
   the script reads `attributes`, and a relationship's target as `relatedTable`
   where the script reads `relatedCollection`. Both currently translate inside
   the workaround.

### What must not change

- `createAdminClient()` bypasses every Appwrite permission rule. It must stay
  confined to `lib/repositories/` and must never become reachable from a
  function taking a client-controlled identifier.
- Every ownership predicate is part of its query, not a filter applied
  afterwards. A record the actor does not own is never loaded into memory.
  Do not let a changed query builder turn `Query.equal` into a post-fetch check.
- Bank credentials are decrypted at the repository boundary, bound to the
  record id and field. Do not add a second decryption path.

---

## Track D — `@sentry/nextjs` 7.112.2 to 10.73.0

**Three major versions and the most configuration churn. Do this fourth.**

This is the track most likely to break a security control, so read the whole
section before starting.

### Current setup

- `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`
- `next.config.mjs` calls `withSentryConfig(nextConfig, {...}, {...})` — the
  three-argument form
- Sentry is optional and env-driven. Without `SENTRY_AUTH_TOKEN` the plugin runs
  in `dryRun` and the build still succeeds.

Options currently passed: `silent`, `dryRun`, `org`, `project`,
`widenClientFileUpload`, `hideSourceMaps`, `disableClientWebpackPlugin`,
`disableServerWebpackPlugin`.

### Breaking changes that definitely apply

**v7 to v8**

1. **`instrumentation.ts` is now required.** The `sentry.server.config.ts` and
   `sentry.edge.config.ts` files are still supported, but an `instrumentation.ts`
   exporting `register()` must import them conditionally by runtime.
2. **`withSentryConfig` takes two arguments, not three.** The second and third
   are merged into one. This repository uses the three-argument form and will
   need editing.
3. **`hideSourceMaps` was removed with no replacement.** Hidden source maps
   became the default. See the warning below, because this option is load-bearing
   here.
4. Minimum Node 14.18.0, and ES2018 compatibility.

**v8 to v9**

5. `processThreadBreadcrumbIntegration` renamed to `childProcessIntegration`.
6. `startSpan` now clones a custom scope rather than mutating it.
7. `requestDataIntegration` no longer sets the user automatically. Irrelevant
   here — this application must never send a user identity to Sentry anyway.

Re-confirm 1 to 4 against the exact target version. They were read from Sentry's
migration guides, not from this repository.

### THE SOURCE-MAP WARNING

`hideSourceMaps: true` is not a preference in this repository. The original
audit found four live Plaid sandbox tokens readable from a **served `.js.map`**
even though tree-shaking had removed them from the emitted `.js`. That is why
the option is set and why CI asserts it.

In v8 the default became: emit hidden source maps, and delete client source maps
after uploading them to Sentry. **This application usually has no
`SENTRY_AUTH_TOKEN`, so nothing is uploaded** — and it is not established that
the deletion still happens when the upload does not. Verify empirically rather
than by reading the default.

The check is already written and must pass with no auth token set:

```bash
npm run build
find .next/static -name '*.js.map'   # must print nothing
```

`.github/workflows/ci.yml` runs exactly this and fails the build on any match.
Do not relax that gate to accommodate a new Sentry default. If the new default
emits maps, set whatever the current equivalent option is until it does not.

### Also verify after upgrading

The build must still succeed with **no** Sentry environment variables set at
all. Sentry being optional is deliberate: a missing DSN must never fail a build.

---

## Track E — `next` 14.2.35 to 16.x

**Largest, and a separate decision rather than a maintenance task.**

Every remaining Next advisory has its first fix in 16.3.4. There is no 14.x
release that closes any of them:

- Denial of service in Server Components (three separate advisories)
- Server-side request forgery in Server Actions on custom servers
- Server-side request forgery in rewrites via attacker-controlled destination
- Cache confusion of response bodies for requests with bodies
- Unauthenticated disclosure of internal Server Function endpoints
- Middleware and proxy bypass in Pages Router applications using i18n
- Cross-site scripting in App Router applications using CSP nonces

### How much of this reaches this application

Less than the list suggests, and it is worth working out before committing to
the migration:

- There is **no** `middleware.ts`, so the middleware and proxy advisories do not
  apply.
- There is no custom server, so that server-side request forgery variant does
  not apply.
- There are no rewrites configured.
- There is no i18n.
- The Server Component denial-of-service advisories and the Server Function
  endpoint disclosure **do** apply. Every page here is a Server Component and
  there are seven server actions.

### The one thing that will break on this migration

`vitest.config.ts` aliases `react` to a version-specific path inside `next/dist`:

```
./node_modules/next/dist/server/future/route-modules/app-page/vendored/rsc/react.js
```

This exists so `lib/server/render-latency.test.ts` exercises the real server
`cache()` rather than a stub. The path is internal to Next and will move.

When it breaks, **fix the path, do not replace `cache()` with a fake.** The
suite's entire purpose is proving that memoisation is scoped to one request. A
stub would make it prove that the stub works, and the failure it guards against
is one user's identity being served to another.

---

## Invariants that must survive every track

These are enforced by tests. If one fails, the upgrade is wrong, not the test.

| Invariant | Enforced by |
|---|---|
| Nine `lib/db` modules reachable from a request path, exact equality | `lib/server-action-surface.test.ts` |
| Three crossing points into `lib/db`, all services | same |
| Seven server-action exports, exact list | same |
| No script reachable from a request path | same |
| Only the storage boundary and its migration handle ciphertext | same |
| The encryption migration reads credentials as stored, not decrypted | same |
| Request-scoped identity, isolated between concurrent users | `lib/server/render-latency.test.ts` |
| Ownership checked in the query, not after the fetch | same, plus repository tests |
| No credential or source map in client output | `.github/workflows/ci.yml` |
| Money is integer minor units end to end | `lib/domain/` tests |

---

## Verification for each track

Run all of it per track, not once at the end.

```bash
npm run typecheck
npm run lint
npm test                 # 686 application tests
npm run test:db          # 326 database tests, needs TEST_DATABASE_URL
npm run build
find .next/static -name '*.js.map'                    # must be empty
grep -rlE "access-(sandbox|development|production)-|accessToken|fundingSourceUrl" .next/static/   # must be empty
```

Then confirm the advisory actually moved:

```bash
npm audit --omit=dev
```

A track that does not reduce the advisory count has not done its job, and the
count should be recorded in the commit message so the next person can tell
which track closed what.

### Operator tooling to re-run after Track C

The Appwrite upgrade touches the code these depend on:

```bash
npm run credentials:check     # keyring usable
npm run credentials:encrypt   # dry run; must report every value encrypted
npm run db:backfill           # dry run; must report 3 ok, 0 failed
npm run db:verify             # must report no drift
```

The backfill is the sharpest of these. It reads every bank document with the
admin client, decrypts the credentials, and calls Plaid with them, so it
exercises the Appwrite SDK, the encryption boundary and the Plaid client in one
command. It reported `3 ok, 0 failed` before this plan was written.
