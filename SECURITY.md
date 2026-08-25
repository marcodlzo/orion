# Security

Orion is a sandbox-only project under active reconstruction. It connects to
Plaid and Dwolla **sandbox** environments, is not a licensed money transmitter,
and moves no real funds.

This document is deliberately explicit about what is *not* yet secure, because
the repository is a record of fixing those things in sequence rather than a
finished product.

## Credentials in the baseline commit

**The first commit contains credentials. They are not ours, and this is
intentional.**

Commit `ba82011` — *"preserve original Horizon tutorial baseline"* — is a
byte-for-byte copy of the upstream tutorial
[`adrianhajdin/banking`](https://github.com/adrianhajdin/banking) as received.
That upstream repository is public and contains, in `constants/index.ts`:

- four Plaid **sandbox** access tokens
- a Sentry DSN belonging to the tutorial author's organisation
- tutorial account identifiers

These were removed in the following commit, `6325705`. They were also readable
from a served `.js.map` before that commit, because tree-shaking removed them
from the emitted JavaScript while leaving the source map intact — a detail worth
recording, since `hideSourceMaps` only strips the `sourceMappingURL` comment and
does not stop the map being fetched directly.

The baseline is preserved rather than scrubbed because it is the evidence:

```bash
git log -S "access-sandbox-" --oneline
```

shows exactly where they entered and where they left. Rewriting that commit would
delete the proof that the audit happened.

**No credential belonging to this project has ever been committed.** `.env.local`
is gitignored and untracked; `.env.example` contains placeholders only. CI
enforces this on every build by scanning the client bundle — source maps
included — for credential-shaped strings, and by asserting that no `.js.map`
reaches client output at all.

## Fixed

Each row names the commit that closed it and the test that would fail if it
regressed. Nothing here is claimed on the strength of a code reading alone.

| Finding | Closed by | Proof |
|---|---|---|
| Server actions accepted client-supplied identifiers with no ownership check (IDOR/BOLA) | `58d4dac`, `893a99b` | Identity comes from `requireActor()` and the session cookie; repositories scope every read and write to the actor. `lib/auth/actor.test.ts`, `lib/actions/authentication.test.ts` |
| `createTransfer` accepted arbitrary funding-source URLs — an account-drain primitive | `d68c2f7` | The endpoint is gone. `initiateTransfer` takes an intent typed `unknown`, validates it server-side, and resolves both funding sources from bank records the actor owns. `lib/actions/transfer.test.ts` |
| Transaction records could be forged by an unauthenticated caller | `d68c2f7` | `createTransaction` is no longer a server action. The public surface is 24 → 7 exports, asserted by `lib/server-action-surface.test.ts` |
| Bank-linking trusted a client-supplied user object | `58d4dac` | The action derives the actor from the session and ignores any caller-supplied identity |
| SSN and date of birth stored in plaintext and serialized into the RSC payload | `ca68d00` | Both are destructured out before persistence and excluded from the Actor and every DTO. `lib/actions/data-minimization.test.ts`, `lib/dto/dto.test.ts` |
| Database test suites could truncate the development database | `3af095b` | `TEST_DATABASE_URL` is required with no fallback to `DATABASE_URL`, refused when both resolve to the same database, and refused when the name does not end in `_test`. `lib/db/test-database.test.ts` |

The DTO tests are allowlist-based and run against a serialized payload rather
than checking fields one at a time — a per-field assertion would keep passing
after someone added a new sensitive column.

## Known unfixed vulnerabilities

These are documented, scheduled, and deliberately not fixed opportunistically.
They are real, and this application should not be exposed to untrusted users.

| Finding | Severity | Milestone |
|---|---|---|
| No idempotency — a double-click sends two transfers | High | 6 |
| No ledger; balances read live from the provider | High | 5 |
| Provider acceptance treated as settlement | High | 7 |
| `transactionsSync` called without a cursor; results overwritten each page | High | 10 |
| No rate limiting on authentication or money movement | Medium | 2 |
| `shareableId` is base64 encoding presented as encryption | Medium | 2 |
| Transaction status derived from a timestamp | Medium | 7 |
| Provider credentials stored in plaintext Appwrite documents | High | unscheduled |

The last row is not new, but it is now stated plainly rather than implied: access
tokens, processor tokens and funding-source URLs live unencrypted in the
document store. This is why the PostgreSQL migration does **not** copy them —
and why it cannot be completed until this is fixed. It has no milestone yet,
which is itself worth recording: it currently blocks the runtime cutover.

`initiateTransfer` documents its own lack of idempotency in the source, at the
endpoint, so nobody has to read this file to find out.

## The PostgreSQL migration

PostgreSQL is being introduced as the future system of record. As of the
migration milestone it is **populated but not authoritative** — every request
path still reads and writes Appwrite.

Security-relevant properties, each enforced by a test rather than a convention:

- **No credential is migrated.** There is no column for an access token,
  processor token or funding-source URL. The reason they were not moved is that
  moving plaintext secrets into a newer datastore is not an improvement —
  PostgreSQL alone is not encryption. They stay where they are until the
  milestone that encrypts them.
- **No PII is migrated.** The target is an identity and linkage map, not a
  second profile store.
- **No balance is stored.** A stale copy of someone's money reads as
  authoritative. Balances remain provider state until the ledger exists.
- **The legacy reader is unscoped, and contained.** It reads every user and every
  bank document, because a migration has no current user. An import-boundary
  test proves no server action, client component, `app/` page or route, or
  application repository reaches it at any depth. The same test proves no
  request path reaches `lib/db`, so a runtime cutover cannot happen silently.
- **Secrets are kept out of reports and errors.** Failure reasons carry a
  classification (`name / SQLSTATE / constraint`), never the driver's message,
  because a constraint violation quotes the offending row and a Plaid error
  echoes the request that contained the access token. Unique sentinel values are
  asserted absent from stored rows, reports, error messages, error stacks,
  stdout, stderr and JSON across success, provider failure, database failure,
  dry run and verification paths.

  **What redaction does NOT claim.** Operator output redacts the *password* from
  a connection URL and keeps scheme, user, host and database, so a failure still
  says which database it was. So "the database password never appears in output"
  is true; "no part of `DATABASE_URL` appears in output" is false, and is not
  claimed. Redaction also only catches recognisable shapes — a secret with no
  distinguishing form and no announcing key survives it. It is a backstop for
  third-party error messages, not a substitute for reports that carry no secret
  in the first place, and there is a passing test that says so.

- **Provider calls have a deadline.** `PLAID_TIMEOUT_MS` (15s default). Without
  one a promise that never settles stalls the migration silently — the error
  handling only catches calls that *reject*.

See [`docs/migration/appwrite-to-postgresql.md`](docs/migration/appwrite-to-postgresql.md)
for the full contract, including what each claim rests on.

## Characterisation tests are not requirements

`lib/utils.test.ts` contains tests named `DEFECT` that assert the *current,
defective* behaviour of several findings above — float money, base64-as-
encryption, timestamp-derived status, and an SSN "validator" that accepts any
three characters. Each carries an `AFTER` comment describing the secure
behaviour that replaces it.

**They are expected to fail when their milestone lands.** A failure there is the
milestone working, not a regression to repair.

## Reporting

This is a personal project and not deployed. If you find something not listed
above, please open an issue. Do not include real credentials in a report.

## Testing scope

Any security testing must use sandbox, local, or provider-test environments
only. Do not exercise findings against live provider systems or third-party
accounts.
