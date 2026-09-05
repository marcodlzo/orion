# Render-path latency fix

Implemented 2026-09-05 in response to the navigation latency report.

The expensive duplication was confirmed in the code: the layout and page each
resolved a profile, the account list and detail each resolved identity, and the
detail reader fetched a Plaid Item response already read for the list. The
transaction repository also repeated the detail reader's ownership query.

## Changes

- `requireActor` and `findUserByAuthId` share their in-flight results within a
  server render. The actor remains a minimal identity; the profile still leaves
  the server only through the existing allowlisted DTO.
- Account lists and ownership-scoped bank reads are memoized within the render.
  The selected bank's query still includes both its document id and the actor's
  user-document id. The transaction repository uses the same checked query.
- A private Plaid reader shares the complete Item response by decrypted access
  token. It serves both account-list and account-detail readers, including
  multiple linked accounts on one Item. Account selection still matches the
  bank record's `accountId`.
- The detail reader starts Plaid, Appwrite history and PostgreSQL history reads
  together after ownership is established. Pages overlap profile and account
  reads where both are needed and omit unused profile reads.

The detail reader deliberately keeps its ownership query. Reusing the provider
response removes the duplicate Plaid wave without replacing that query with a
list filter or trusting a URL parameter. There is no new public server action,
credential decryption path, persistent balance cache or sync-store writer.

## Verified request counts

`lib/server/render-latency.test.ts` exercises the actual React server renderer
shipped with Next 14.2.3, with mocked external I/O. Its representative navigation
has three linked accounts across two Items, two profile callers, an account list
and a selected account with history.

| Read | Before, from the original call graph | After, asserted by tests |
| --- | ---: | ---: |
| Appwrite session resolution | 4 | 1 |
| Appwrite user document | 6 | 1 |
| Appwrite bank queries | 3 | 2 |
| Appwrite transaction queries | 2 | 2 |
| Plaid account requests | 4 | 2 |

The tests also verify concurrent-user isolation, fresh balances on a subsequent
request, logout, foreign bank ids both before and after loading the owned list,
account selection, DTO fields, integer balance totals and overlapping history
reads. Existing architecture tests continue to protect the ownership, encryption
and sync boundaries.

[React documents `cache` as scoped to each server request](https://react.dev/reference/react/cache).
Vitest uses Next's vendored React server runtime and initializes
`AsyncLocalStorage` as Next does, so these tests exercise real memoization across
awaits rather than replacing `cache` with a test implementation. Calls outside a
server render are not memoized.

## Validation and measurement limits

Typecheck, lint, all 686 application tests and the production build passed.
The production client artifact scan found no provider credential fields,
credential-shaped strings or JavaScript source maps.

Live Appwrite/Plaid navigation latency has not been remeasured. The original
report's timing estimates are not measured savings from this change. To compare
latency, use the same signed-in account and warmed route compilation, collect at
least five server navigations per route before and after, and compare medians.
