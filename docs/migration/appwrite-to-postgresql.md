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

npm run db:backfill            # DRY RUN — writes nothing (the default)
npm run db:backfill:commit     # actually write
npm run db:verify              # compare both stores, exit non-zero on drift
```

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

### Re-running is safe

Both repositories upsert. Re-run freely — after a Plaid outage, after fixing a
mapping bug, after adding a column. Existing rows are updated; nothing is
duplicated.

Two details make this true rather than merely intended:

- Customers conflict on `appwrite_auth_id` and the update is a no-op assignment,
  so `xmax = 0` still reports correctly whether the row was inserted.
- Accounts conflict on `(customer_id, provider, external_account_id)` and update
  **display metadata only**. `legacy_appwrite_bank_document_id` is written with
  `COALESCE(existing, excluded)`, so a bridge that is already recorded is never
  cleared by a later run that lacks it.

---

## What the backfill reports

Nothing is dropped silently. Every source record is either migrated or listed in
`skipped` with a reason.

**Skips** are records that *cannot* migrate, decided before any database call:

| Reason | Meaning |
|---|---|
| missing `userId` | A user document with no auth account — a partial-signup artefact, not a customer. |
| duplicate auth id | Two user documents claiming one auth account. The unique index would reject the second. |
| owner has no migratable user record | The bank's owner was deleted or was itself skipped; the foreign key would reject it. |
| missing `accountId` | No provider account to link. |
| duplicate account for owner | The same provider account linked twice by one customer. First occurrence wins. |

A skip is a finding, not an error. The command still exits `0` — deciding what
to do about a malformed legacy record is an operator's call.

**Write failures** are different: they exit `1`. Because the run is one
transaction, a write failure means nothing was committed.

**Enrichment failures** are reported separately and are *not* fatal. If Plaid
cannot be reached for an Item — expired credentials, an outage — that account
still migrates, with `display_name = "Linked account"` and null metadata. The
link is real data; it must not be lost because a provider was unavailable. A
later re-run fills the real values in.

Failure reasons carry a classification (`name / code / constraint`), never the
driver's message. A constraint violation quotes the offending row back at you,
and a Plaid error echoes the request that caused it — which contains the access
token.

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

Cursor pagination, not offset: offset pagination silently skips or repeats rows
when the underlying set changes between pages, which during a migration means
quietly losing a customer's account.

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
