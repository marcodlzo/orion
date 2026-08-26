# Appwrite → PostgreSQL migration

**Status:** backfill implemented; **runtime cutover not started.**

Every request path still reads and writes Appwrite. PostgreSQL is populated and
verifiable, but nothing in the application reads it yet. Copying data is the
easy half; changing which store is authoritative is a separate phase with its
own rollback plan.

---

## What moves, and what does not

The target is an **identity and linkage map**, not a second copy of the profile
store. Two tables, no financial state.

| Legacy Appwrite | PostgreSQL | Note |
|---|---|---|
| `USER.$id` | `banking_customers.appwrite_user_document_id` | what `BANK.userId` points at |
| `USER.userId` | `banking_customers.appwrite_auth_id` | the **auth account** id |
| `BANK.$id` | `linked_accounts.legacy_appwrite_bank_document_id` | the bridge back |
| `BANK.accountId` | `linked_accounts.external_account_id` | the provider's account id |
| — | `linked_accounts.display_name`, `official_name`, `mask`, `account_type`, `account_subtype` | fetched from Plaid during the backfill |

### The naming trap

The USER document's `userId` **field** holds the Appwrite **auth account** id.
Its `$id` is the **document** id. Bank ownership points at `$id`, not at
`userId`.

Confusing the two does not throw — it silently reassigns accounts to the wrong
owners, and the foreign key still passes because both are plausible-looking id
strings. `resolveOwnerUserDocumentId` exists solely to make that decision
explicit and testable, and `mapping.test.ts` asserts the distinction directly.

### Deliberately not migrated

| Field | Why |
|---|---|
| `accessToken`, `processorToken`, `fundingSourceUrl` | Provider credentials. There is no column for them. Moving plaintext secrets into a newer datastore is not a security improvement — PostgreSQL alone is not encryption. |
| `ssn`, `dateOfBirth`, `address1`, `city`, `state`, `postalCode` | Phase 4A stopped persisting these. The target is an identity map, not a profile store. |
| `dwollaCustomerId`, `dwollaCustomerUrl` | Provider identity; belongs to the Dwolla adapter, not to the banking record. |
| `shareableId` | `btoa` of a document id. The recipient-reference scheme is being replaced, not carried forward. |
| balances | **There is no balance column, on purpose.** A balance is provider state, read on demand. A stale copy of someone's money is worse than no copy — it looks authoritative. When the ledger lands, balances become derived from ledger entries, never a stored scalar. |

The access token is read from the legacy record and used **once**, before the
transaction opens, to fetch display metadata. It is not persisted, not logged,
and not returned in any report. `backfill.test.ts` asserts this against the
written rows; an architecture test asserts it against the source.

---

## Running it

```bash
npm run db:up                  # start PostgreSQL
npm run db:migrate             # apply the schema

# 1. DRY RUN (the default). Writes nothing, and prints a source digest.
npm run db:backfill

# 2. COMMIT the dataset that dry run approved. The digest is REQUIRED.
npm run db:backfill:commit -- --expect-source=<digest from step 1>

# 3. VERIFY. Exits non-zero on drift.
npm run db:verify
```

### Running the tests

```bash
npm test                       # unit; hermetic, no database
TEST_DATABASE_URL=... npm run test:db
```

`test:db` **requires** `TEST_DATABASE_URL` and never falls back to
`DATABASE_URL`. These suites `TRUNCATE`, and an unset variable must stop the run
rather than pick a target on its own — the earlier fallback would have let a
developer with `.env.local` in their shell wipe their development database while
the suite reported green. The guard also refuses when both variables resolve to
the same host/port/database, and when the database name does not end in
`_test`.

Both commands need `DATABASE_URL` plus the Appwrite and Plaid variables from
`.env.local`. They are operator commands run from a shell; they are not
reachable from the application.

### The dry run is a real transaction

`npm run db:backfill` opens a transaction, performs **every** insert, and then
rolls back. It is not a plan printed from memory.

This matters because the failures worth catching are the ones only PostgreSQL
can find: a duplicate `(customer, provider, account)`, a foreign key with no
parent, a `NOT NULL` that the legacy data does not satisfy. A dry run that
skipped the writes would report success for a dataset the database would reject,
which is the exact situation the dry run exists to prevent.

Consequence: the dry run takes as long as the real run and hits Plaid the same
number of times.

### One transaction, all or nothing

The whole backfill is a single transaction. Either the entire legacy dataset
lands or none of it does.

A half-migrated financial dataset is worse than an un-migrated one: it is no
longer obvious which store is authoritative, and the answer differs per record.

### Dry run and commit are bound together

Appwrite stays live throughout, so a dry run reads dataset A and the commit that
follows independently reads whatever is there then. Counts cannot detect the
difference — one delete plus one insert leaves them identical.

Every run therefore reports a **source digest**, and the dry run prints the exact
command to apply what it approved:

```bash
npm run db:backfill:commit -- --expect-source=<digest>
```

`--expect-source` is **required** for a commit and refuses if the source moved.
A dry run needs none — it produces the digest — so there is no first-run
problem. An unbound commit is not possible: optional binding is not binding.

### Only one migration runs at a time

The transaction takes a PostgreSQL advisory lock as its first statement. Two
backfills launched concurrently both insert the same customer, and
`ON CONFLICT (appwrite_auth_id)` arbitrates only that one index — the loser could
still trip the unique index on `appwrite_user_document_id` and report a `23505`
that was nothing but a race with itself. The stored data was always correct; the
*report* was not. The lock releases on commit or rollback, so a crashed run
cannot leave it held.

### Re-running is safe

Both repositories upsert. Re-run freely — after a Plaid outage, after fixing a
mapping bug, after adding a column.

Idempotency here means more than "the row count did not change". Across any
number of runs:

- **UUIDs are stable.** `id` is never rewritten, so anything holding a reference
  keeps working.
- **`created_at` is stable.** It is the only record of when a customer was first
  migrated.
- **Identity columns are never rewritten.** `customer_id` and
  `external_account_id` are the row's identity; a change there means the source
  moved, which `db:verify` reports rather than absorbing.
- **The legacy bridge is never cleared.** `legacy_appwrite_bank_document_id` is
  written with `COALESCE(existing, excluded)`, so a later run that lacks it does
  not erase it.
- **Good metadata is never degraded.** See below.

#### A re-run during a provider outage must not destroy data

This is the one that bites. The obvious upsert —
`ON CONFLICT DO UPDATE SET display_name = EXCLUDED.display_name` — overwrites a
correct account name with the placeholder `"Linked account"` whenever a re-run
happens while Plaid is unreachable. The row count is unchanged, so a
count-based idempotency check reports success while the data is quietly worse.

So the repository takes `metadataKnown`: when enrichment failed, every metadata
column keeps the value it already had.

That protection now sits behind a stronger one. **An account whose currency the
provider did not positively confirm is not written at all** — not with a
placeholder, not with an assumed `'USD'`. `currency` is `NOT NULL` with a
`CHECK` of `'USD'`, so inserting an unverified account asserts a fact nobody
checked, and an unreachable Item could be hiding a CAD account. The customer
still migrates; the account is reported as blocked and a later run inserts it
once Plaid answers. `metadataKnown` remains as defence in depth for any future
caller.

Proven by `repositories.db.test.ts` (repository level) and `backfill.db.test.ts`
(end to end), both against real PostgreSQL, and both verified to fail when the
`CASE WHEN` is reverted to the naive assignment.

---

## What the backfill reports

Nothing is dropped silently. Every source record is either migrated or listed in
`skipped` with a reason.

**Skips** are records that *cannot* migrate, decided before any database call.
Each carries a machine-readable `code` as well as prose, so a script can branch
on it without pattern-matching an English sentence:

| Code | Meaning |
|---|---|
| `MISSING_AUTH_ID` | A user document with no auth account — a partial-signup artefact, not a customer. |
| `DUPLICATE_AUTH_ID` | Two user documents claiming one auth account. The unique index would reject the second. |
| `OWNER_NOT_MIGRATABLE` | The bank's owner was deleted or was itself skipped; the foreign key would reject it. |
| `MISSING_OWNER` | The relationship is absent or unreadable. |
| `MISSING_ACCOUNT_ID` | No provider account to link. |
| `DUPLICATE_OWNER_ACCOUNT` | The **same customer** linked the same provider account twice. |
| `MISSING_DOCUMENT_ID` | The document has no `$id`. |

#### Conflicts resolve the same way every run

Appwrite does not promise a document order. "Whichever arrived first wins" would
let the same dataset migrate differently on two runs, with both reporting
success and the difference invisible.

So the source is **sorted by document id before anything is decided**, and the
rule is stated in the skip reason: **lowest document id wins**. Arbitrary, but
stable, reproducible, and reported — the losing record names the winner, so a
human can judge whether the tie-break picked the right one.

`mapping.test.ts` runs every conflict case through all permutations of its
input and asserts the accepted mappings and reported conflicts are identical.

#### Joint accounts are not conflicts

Two *different* customers linking the same provider account is a joint account
and is allowed — by the mapper and by the schema, whose unique index is
`(customer_id, provider, external_account_id)`, not `(provider, account)`.

Only the *same* customer linking it twice is a duplicate. The distinction is
deliberate and is not to be "fixed" by tightening the index.

A skip is a finding, not an error. The command still exits `0` — deciding what
to do about a malformed legacy record is an operator's call.

**Write failures** are different: they exit `1`, and the run stops at the first
one. Because the run is one transaction, a write failure means nothing was
committed — and the report says so rather than printing the counters it had
accumulated before the abort. Every report carries an outcome:

| Outcome | Meaning |
|---|---|
| `committed` | Every write is durable. |
| `dry-run` | Writes executed and were undone. Counters are a forecast. |
| `rolled-back` | A failure aborted the transaction. **Nothing** was written; counters are zero. |
| `refused` | Stopped before any provider call or write. Nothing happened at all. |
| `not-started` | The transaction never opened — no connection, or BEGIN failed. Nothing was attempted, which is **not** the same as a rollback. |
| `unknown` | **COMMIT failed.** PostgreSQL may or may not have applied the transaction; the acknowledgement was lost and a later ROLLBACK cannot undo a commit that already happened. The counters are what the run **attempted** — they are not a claim about durability in either direction. Inspect the database before re-running. The upserts are idempotent, so a re-run is safe once you know the state. |

A run is refused when the source read was incomplete, or when `--expect-source`
does not match. Refusal happens before enrichment, so it costs nothing and
reaches neither Plaid nor PostgreSQL.

**Enrichment failures** split in two, because they call for different actions:

| Code | Blocking? | Meaning |
|---|---|---|
| `PROVIDER_ERROR` | **yes** | Plaid unreachable or the Item needs re-auth. |
| `NO_ACCESS_TOKEN` | **yes** | The legacy record has no token, so nothing can be confirmed. |
| `SOURCE_ACCOUNT_NOT_FOUND` | **yes** | The account is not on the Item any more. |
| `AMBIGUOUS_PROVIDER_ACCOUNT` | **yes** | Two Plaid accounts share the id. Picking one would be a guess. |
| `UNSUPPORTED_CURRENCY` | **yes** | Not USD. Writing `'USD'` to satisfy the CHECK would record a false fact. |

**Every** enrichment failure blocks the account. `currency` is `NOT NULL` with a
`CHECK` of `'USD'`, so writing a row the provider did not confirm asserts a fact
nobody checked — an unreachable Item could be hiding a CAD account.

Nothing is lost: the link still exists in Appwrite, the **customer still
migrates**, and a re-run inserts the account once the provider answers. An
earlier version of this document said non-blocking failures migrated a
placeholder row; that is no longer true, and was the defect that made it
untrue-in-the-safe-direction.

**Currency comes from the provider**, never assumed. It is read from the
account's `iso_currency_code` (falling back to `unofficial_currency_code`).
The balance *amounts* on the same object are deliberately not read.

Failure reasons carry a classification (`name / SQLSTATE / constraint`), never
the driver's message. A constraint violation quotes the offending row back at
you, and a Plaid error echoes the request that caused it — which contains the
access token.

---

## Verification

`npm run db:verify` re-reads **both** stores and re-derives what should be
present from the source. It deliberately does not consult anything the backfill
recorded: a verifier that reads the backfill's own report can only confirm the
backfill agrees with itself.

| Drift | Meaning |
|---|---|
| `missing-customer` / `missing-account` | In Appwrite, absent from PostgreSQL. Re-run the backfill. |
| `orphan-customer` / `orphan-account` | In PostgreSQL, no live source. Usually deleted in Appwrite after the backfill. |
| `mismatched-customer` / `mismatched-account` | Present on both sides but bridged to the wrong record. **Investigate before re-running** — this is the shape a mapping bug takes. |
| `unenriched-account` | Migrated with placeholder metadata. Re-run once the provider is reachable. |

It exits non-zero when drift exists, so it can gate a cutover rather than merely
inform one.

### What a green verification does and does not prove

**Proved:** every customer and account link is present, correctly bridged, not
duplicated; the source was read completely; and no source record was silently
dropped.

**Not proved:** that Appwrite held still while it was being read — it stays
live throughout, so a verification is a statement about the dataset it observed,
which is why the report carries that dataset's digest. PostgreSQL *is* read
consistently: both tables come from one REPEATABLE READ snapshot taken after
waiting on the migration advisory lock, so a concurrent backfill cannot tear the
comparison.

Also not proved: that stored provider metadata is *correct*. The verifier
compares Appwrite against PostgreSQL, and Appwrite does not hold the metadata —
name, official name, mask, type, subtype and currency all come from Plaid, which
this command deliberately never calls. A row containing plausible-but-wrong
values for every metadata field verifies clean. The literal `"Linked account"`
placeholder is caught only because it is a value this tool writes, not one it
validates.

The command prints this limitation on every successful run, and the report
carries it in `scope.notVerified`. "Verification passed" is exactly the kind of
claim that grows in the retelling.

### Skipped records fail verification

A record the mapper refused to migrate is a record that is **not** in
PostgreSQL. It used to be counted and then followed by "No drift", which told
the operator the two stores matched while a customer's account had been dropped.

Every skip is now drift. An operator who has judged a specific code acceptable
for this dataset can acknowledge it explicitly:

```bash
npm run db:verify -- --acknowledge=MISSING_AUTH_ID:user-doc-42
```

Acknowledgement is **per record**, as `CODE:sourceId` — the exact token the
drift line prints. Per-code would have absolved every future record that
happened to share a code, so a run approved for one partial signup would keep
passing as new ones appeared. "The mapper skipped it" and "a human reviewed this
one" are different facts, and only the second justifies a green result.

**It never repairs anything.** Deleting a PostgreSQL customer because Appwrite
no longer has the document would destroy financial history on a tool's
initiative. Drift is reported for a person to judge.

Note that new signups create Appwrite records continuously, so a verification
run against a live system will show `missing-*` drift for anyone who signed up
after the last backfill. That is expected, and is why cutover needs a freeze
window rather than a clean verify alone.

---

## Containment

`lib/migration/appwrite-source.ts` reads **every** user and **every** bank
document, ignoring ownership entirely.

That is correct for a backfill — a migration is an operator action against the
whole dataset and has no "current user" — and catastrophic anywhere else. An
unscoped read reachable from a server action is not an IDOR with a weak check;
it is one with no check at all.

So the rule is containment, not review. Enforced by
`lib/server-action-surface.test.ts`:

- no `'use server'` module reaches `lib/migration/`, at any import depth
- no client-reachable module reaches it
- only `scripts/` imports the backfill or the verifier
- every module in `lib/migration/` that performs I/O declares `server-only`
  (`mapping.ts` is pure and exempt)

If you find yourself wanting one of these functions inside a request path, you
want an actor-scoped repository instead — see `lib/repositories/`.

---

## Module map

| Module | Role |
|---|---|
| `lib/migration/appwrite-source.ts` | Unscoped cursor-paginated reads of the legacy collections. |
| `lib/migration/mapping.ts` | **Pure.** Legacy documents → planned rows, with every skip reasoned. No I/O, so the riskiest decisions are testable without a database. |
| `lib/migration/enrichment.ts` | Plaid metadata for one account. **Never throws**; degrades to a placeholder. |
| `lib/migration/backfill.ts` | Orchestration, transaction, dry-run rollback, reporting. |
| `lib/migration/verify.ts` | Independent comparison. Read-only. |
| `lib/db/repositories/*.ts` | Idempotent upserts against PostgreSQL. |
| `scripts/db-backfill.ts`, `scripts/db-verify.ts` | The operator entry points. |

### Reading the source completely

Cursor pagination, not offset: offset pagination silently skips or repeats rows
when the underlying set changes between pages, which during a migration means
quietly losing a customer's account. The page size is set explicitly (100, the
maximum) rather than inherited from Appwrite's default of 25.

**Non-progress throws.** An earlier version broke out of the loop when the
cursor failed to advance, turning a provider fault into a short read — the
caller then saw a small, well-formed dataset with no way to know it was
truncated. Now a stalled cursor, a repeated document, or a total that exceeds
what was actually walked all raise `InfrastructureError` and stop the run.

Every read returns evidence, not just documents:

```
scanned  reportedTotal  pages  complete
```

Both commands print it, and both exit non-zero when `complete` is false.
`db:verify` additionally records `incomplete-source-scan` as drift, so `ok` can
never be true over a partial read — a comparison against a short read would
report every missed record as a PostgreSQL orphan.

---

## What each claim rests on

| Claim | Evidence |
|---|---|
| **idempotent** | Real-PostgreSQL re-runs asserting stable `id`, stable `created_at`, no duplicate rows, and preserved metadata — not merely that `ON CONFLICT` is present. `backfill.db.test.ts`, `repositories.db.test.ts`. |
| **atomic** | A real CHECK violation mid-run leaves *zero* rows, including customers written before the failure, and the run stops at the first error rather than issuing further statements inside an aborted transaction — so no `25P02` appears at all. `backfill.db.test.ts` → "a real PostgreSQL failure". |
| **dry-run equivalent** | Dry run and commit call the *same* repository functions in the *same* transaction; only the ending differs. Proven by running both from the same initial state against real PostgreSQL and comparing every counter, plus a foreign-key violation that fires *during* the dry run. |
| **no secret leakage** | Unique sentinel values for access token, funding-source URL, processor token and DB password, asserted absent from stored rows, reports, error messages, error stacks and JSON across success, provider failure, DB failure, dry run and verification. The absence of an `access_token` column is *not* treated as proof. |
| **migration complete** | `scanned` vs `reportedTotal` vs `pages` for both collections, with a short read throwing and a non-advancing cursor throwing. Multi-page reads are tested, including the exact-multiple boundary. |
| **verification independent** | The verifier's dependency list contains no backfill input; it re-derives expectations from the source via `planMigration`. Tested by changing the source under a previously-correct PostgreSQL state and asserting drift appears. |
| **runtime unchanged** | Import-boundary tests proving no server action, client component, `app/` page/layout/route, or application repository/service reaches `lib/migration/` **or** `lib/db/` at any depth. Mutation-tested: planting either import fails the suite. |

---

## Not done yet

Runtime cutover. Signup, bank linking and transfers all still use Appwrite.

What that phase needs, at minimum:

- a decision on write ordering (dual-write, or freeze-and-switch)
- provider credentials moved to real encrypted storage — they are still in
  Appwrite documents, and the reason they were not migrated is that there is
  nowhere safe to put them yet
- reads moved behind the PostgreSQL repositories, one call site at a time
- a rollback path that does not depend on the backfill being re-runnable at the
  moment it is needed
