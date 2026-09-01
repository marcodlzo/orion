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
| Database test suites could truncate the development database | `3d845ee` | `TEST_DATABASE_URL` is required with no fallback to `DATABASE_URL`, refused when both resolve to the same database, and refused when the name does not end in `_test`. `lib/db/test-database.test.ts` |
| No idempotency — a retry, a second tab or a replayed request sent two transfers | Phase 7 | A client-generated key is claimed durably **before** the provider is called, and travels with the request so Dwolla returns the original transfer rather than creating a second. Replay is asserted by re-issuing the request and checking one financial effect, never by observing that a key row exists. `transfers.db.test.ts`, `transfer.test.ts` |
| The Dwolla transfer reference was discarded, making reconciliation impossible | Phase 7 | Recorded on the transfer row, unique, and never overwritten once set. A response with no reference raises rather than inventing a placeholder. |
| No ledger; balances read live from the provider | Milestone 6 | Double-entry entries in PostgreSQL, signed integer minor units, sum-to-zero enforced by a deferred constraint trigger, UPDATE and DELETE rejected by triggers. There is no balance column: a balance is `SUM(amount_minor)`, so it cannot drift from the entries. `ledger.db.test.ts` |
| Provider acceptance treated as settlement | Milestone 7 | `submitted` and `settled` are distinct states. `settled` is reachable from exactly one function, only from `submitted`, and only when driven by a signature-verified provider event — enforced in the SQL predicate, not by a caller remembering to check. `settlement.service.db.test.ts` |
| No webhooks — the system could never learn what the ACH network did | Milestone 7 | `/api/webhooks/dwolla` verifies an HMAC over the **raw** body with `timingSafeEqual` before parsing, and **refuses every delivery when the secret is unset** rather than falling through to accepting them. Events are deduplicated by a unique index on the provider's event id, so a redelivery has no second financial effect — asserted by delivering the same event twice, and concurrently, and counting ledger entries. |
| No holds; an available balance was not distinguished from a ledger balance | Milestone 8 | A hold is placed in the same transaction as the idempotency claim and committed BEFORE the provider is called; captured on settlement, released on failure or return, always in the same transaction as the terminal state. Available balance is derived on every read — no stored balance and no stored available balance exist, and a test fails if either is added. `holds.db.test.ts` |
| A return arriving after settlement was silently discarded, leaving the ledger counting money that had come back | Milestone 9 | `settled -> reversed` is a real transition, and it posts COMPENSATING entries in the same transaction. The originals are never touched — the entry triggers make an edit impossible — and the compensating amounts are derived from the original rows rather than supplied by a caller. A posting is reversed at most once, enforced by a unique constraint, and a reversal cannot itself be reversed. `reversals.db.test.ts` |
| No audit trail of financial state changes | Milestone 9 | An AFTER UPDATE trigger on `transfers` logs every state change, so the trail cannot be bypassed by a new code path or by a hand-written UPDATE — asserted by changing state in psql and checking the row appears. Append-only. It carries no actor identifier and no provider payload; a test asserts the exact column list. |
| Provider credentials stored in plaintext in Appwrite documents | credential encryption | AES-256-GCM at the storage boundary, keys from the environment, each ciphertext BOUND to the record and field it belongs to — so one copied into another user's record fails to decrypt rather than being used. A missing key refuses every read and write; there is no disabled mode. `npm run credentials:encrypt` converts existing values, verifying each round-trips before writing and refusing to rewrite ciphertext it cannot read. `envelope.test.ts`, `credential-encryption.test.ts` |
| Transaction status was derived from a clock — a failed transfer displayed as "Success" after 48 hours | Milestone 11 | `getTransactionStatus()` is deleted. Status is carried on the DTO and comes from the provider's `pending` flag or the transfer state machine. Its characterisation tests were removed rather than relaxed, which is the documented lifecycle. `dto.test.ts` |
| Money was a float through the entire display path, so a rendered column did not sum to the stored total | Milestone 11 | `formatAmount(amount: number)` is deleted. Balances and transaction amounts are exact integer minor units to the point of display, and `formatMinorUnits` REFUSES a float rather than rounding it. `money.test.ts` |
| Plaid was called during SSR, so a page render drove provider sync | Milestone 11 | History reads the synced store. An architecture test asserts no render path reaches any sync module, and that the request-reachable read module contains no write — the half that advances a cursor stays operator-only. |
| Account linking discarded every account on an Item but the first | Milestone 11 | Every depository account gets its own funding source and bank record. Non-depository accounts are skipped deliberately and counted, and one account's failure no longer blocks the rest. |
| `transactionsSync` called with no cursor inside `while (has_more)` — an infinite loop against a paid API | Milestone 10 | The loop is a pure engine: the cursor is sent, advanced and returned, and an unchanged cursor with more pages promised ABORTS instead of looping. A bounded page ceiling backstops a provider that advances forever. `engine.test.ts` |
| Sync pages overwrote each other, and `modified`/`removed` were ignored | Milestone 10 | All three change lists accumulate across pages and are folded into a net effect per transaction, so an add-then-remove within one run does not depend on the applier's ordering. Modifications update; removals soft-delete. `plaid-sync.db.test.ts` |
| No cursor was persisted, so every call re-fetched an item's entire history | Milestone 10 | The cursor and the transactions it produced are written in ONE transaction — asserted by inducing a failure between them and checking neither landed and the cursor stayed put. Cursor-first loses data permanently; data-first reprocesses. |
| A Plaid Item that stopped working was indistinguishable from one with no activity | Milestone 10 | `login_required` and `error` are explicit item states carrying the provider's error CODE. The message is never read: a Plaid error message echoes the request, and the request carries the access token. |
| No reconciliation — drift between the provider and the ledger was undetectable | Milestone 9 | `npm run db:reconcile` compares the ledger against itself and, optionally, against Dwolla. It REPORTS AND NEVER REPAIRS: an architecture test scans every module under `lib/reconciliation/` for a write of any form, and that guard is itself mutation-checked against four write shapes. The reconciler is unreachable from any request path — it reads every transfer regardless of owner. |
| No concurrency protection — two simultaneous requests could both spend the same funds | Milestone 8 | Serialised by a row lock on the ledger account. Proven by holding one transaction open and asserting the second CANNOT decide until it commits, then sees the committed world — not by a parallel race, which can pass on timing luck against no lock at all. Ten concurrent requests against funds for five commit exactly five. |
| A settled transfer could exist that the ledger had never recorded | Milestone 7 | The state change and the ledger posting share one transaction. Asserted by inducing a failure inside it and checking the transfer is still `submitted`, the event claim is gone, and the redelivery then applies cleanly. |

The DTO tests are allowlist-based and run against a serialized payload rather
than checking fields one at a time — a per-field assertion would keep passing
after someone added a new sensitive column.

## Known unfixed vulnerabilities

These are documented, scheduled, and deliberately not fixed opportunistically.
They are real, and this application should not be exposed to untrusted users.

| Finding | Severity | Milestone |
|---|---|---|
| Nothing credits a customer's ledger account, so the solvency check is an exposure cap rather than a balance check | Medium | unscheduled |
| No end-to-end tests; the server-owned transfer flow is not driven end to end | Medium | unscheduled |
| No rate limiting on authentication or money movement | Medium | unscheduled |
| `shareableId` is base64 encoding presented as encryption | Medium | unscheduled |

Three rows now read **unscheduled**, and that is a correction rather than a
demotion: rate limiting and `shareableId` were tagged to Milestone 2, which
closed without them. A finding pointing at a completed milestone is how work
quietly disappears, so they are named as unowned until something claims them.

The credentials row has moved to Fixed. Access tokens and funding-source URLs
are encrypted at rest, which removes what was blocking the PostgreSQL cutover —
the migration deliberately did not copy them while they were plaintext.

TWO HONEST LIMITS. Reads still ACCEPT a plaintext value, because records written
before the migration hold one; that tolerance is removed once
`credentials:encrypt` reports clean, and it is not a fallback for a decryption
failure — an encrypted value that fails to decrypt raises. And the key lives in
an environment variable, so anyone who can read the environment can decrypt: this
is encryption at rest against a stolen backup, a console session or a leaked
admin key, not against a compromised host. A KMS is the next step up and is not
in place.

`initiateTransfer` is now idempotent. PostgreSQL holds the claim, which makes it
the first table a request path writes to — a boundary opened deliberately for
this one route and pinned by an allowlist, not removed. Milestone 7 opened a
second, for the same reason and under the same pin: settlement writes the
transfer state and the ledger from a verified webhook. The allowlist is asserted
by exact equality, so a third crossing fails the suite rather than joining it.

Reconciliation deliberately does not act on what it finds. Applying the
provider's view would make it a second place settlement can happen, bypassing
the signature verification that makes the webhook path trustworthy — and
silently correcting drift destroys the evidence of what caused it, which is the
only thing that can tell an operator whether they are looking at a bug or a
provider incident. The report says so in its own output.

Milestone 11 moved it off the render path, closing what Milestone 10 left open.
The paragraph below is kept because it records what was true between the two,
and because the guard it describes is still what prevents the coupling coming
back.

Milestone 10 fixed the sync ITSELF but did not move it off the render path.
`getTransactions` now paginates correctly, accumulates, and terminates — the
infinite loop and the data loss are gone — but it starts from no cursor on every
call, so a page render still re-walks an item's history. The cursor-persisting
sync runs from `npm run plaid:sync`, and an architecture test forbids any render
path from reaching the cursor store: a page load that advances sync state would
let two concurrent renders race the same item. Wiring the UI to read the synced
store is the UI rebuild's job, and both remaining Plaid defects are listed above
rather than implied.

The solvency-check row moved to unscheduled. It was pointed at Milestone 10 on
the assumption that Plaid balances would land with the sync rebuild; they did
not — this milestone rebuilt transaction sync, not balance ingestion. Re-pointing
it at a milestone that has now closed would be how the finding quietly
disappears.

`credit_limit_minor` is stated plainly rather than dressed up: it caps how much
one customer may have committed and unsettled at once. It is NOT a bank-balance
check, because nothing in this system knows what is in anyone's bank account —
a customer's ledger balance is zero or negative and only ever decreases. The
mechanism (checked under a row lock, in the claim's transaction, before the
provider call) is what Milestone 8 delivers and what the tests prove; the number
is a placeholder awaiting Plaid balances, at which point the same check becomes a
real solvency check without changing shape. That gap is listed above rather than
left implicit.

The timestamp-derived status row moved from Milestone 7 to 11. Milestone 7 gave
**transfers** a real, provider-driven state, and nothing derives that from a
clock. `getTransactionStatus()` survives only in the Appwrite-backed transaction
table, which the UI rebuild replaces; moving the row is a re-pointing, not a
demotion, and it stays listed until that table is gone.

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
  application repository reaches it at any depth — and that remains absolute.

  `lib/db` is no longer absolutely unreachable: the idempotency milestone opened
  ONE route into it, for the transfer claim. That crossing is an explicit
  allowlist naming four modules, asserted by exact equality, with a separate
  test pinning the crossing point to the transfer service. A second crossing,
  or any reach into the migration tooling or the operator repositories, fails
  the suite. The boundary moved once, deliberately; it did not dissolve.
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

- **The verifier cannot write.** Its snapshot runs in a `READ ONLY` transaction
  enforced by PostgreSQL, not by convention: an `INSERT` or `UPDATE` fails
  `25006` and leaves no row. "No caller writes" is a fact about today's callers;
  `READ ONLY` is a fact about the transaction.

- **The verifier does not rely on the schema to prove uniqueness.** It checks
  four bridges itself — customer auth id, customer user-document id, account
  natural key, account legacy bank-document id — and reports every duplicate
  with its row count and ids. Indexing PostgreSQL with a plain `Map` had
  silently kept the last row per key, which meant the check most likely to
  reveal corruption was the one that hid it.

- **Connections of unknown state are destroyed, not reused.** A lost
  acknowledgement for `pg_advisory_lock` or `BEGIN` does not prove the statement
  did not run: the server may be holding a session lock, or sitting inside an
  open transaction, while the client saw only an error. Returning that
  connection to the pool would strand the lock until the process exited, or hand
  the next caller someone else's open transaction. All three paths mark the
  client suspect so it is discarded. Proven against real PostgreSQL by asserting
  the consequence — the advisory lock actually becomes free, and the backend
  holding the open transaction actually ends — rather than that a release
  function was called.

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
