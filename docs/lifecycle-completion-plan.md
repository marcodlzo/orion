# Completing the money lifecycle

Written 2026-09-08, immediately after the first real transfer succeeded.

## Why this document exists

The application now works. A real transfer went through the whole server-owned
path against live Appwrite, Plaid and Dwolla, and the stored result is exactly
what the design demands.

But **five milestones are built, unit-tested, and have never run against real
data.** Every one of them is a step in the money lifecycle that begins where the
transfer we just made stops.

This plan finishes that lifecycle. It is deliberately ordered so each step
produces the data the next one needs.

## Verified working, as of now

One transfer exists. These values are from the live database, not from a test:

| Field | Value |
|---|---|
| transfer id | `36cb86f4-dbff-4d2e-95a3-743f8bcb31d5` |
| provider_transfer_id | `8e1fe32e-dfaa-f111-acd5-02ab38c54207` |
| state | `submitted` |
| amount_minor | `500` |
| idempotency key | claimed, one distinct key |
| hold | 1 row, `active`, 500 minor units |

Two properties worth noting because they are the ones hardest to prove any other
way:

- **The transfer row and the hold share a timestamp to the microsecond**
  (`17:11:36.06895`). That is one transaction committing both. The window where
  a transfer is claimed but its money is not yet reserved does not exist.
- **The amount is `500`, not `5.0`.** Exact integer minor units survived the
  form string, the provider call and storage.

The audit trail recorded both transitions with causes: `→ requested` (cause
`claim`), then `requested → submitted` (cause `provider-accepted`), three
seconds apart. That gap is the Dwolla call.

## Never run against real data

| Table | Rows | What has never happened |
|---|---|---|
| `ledger_entries` | 0 | no balanced entry has ever been posted |
| `provider_webhook_events` | 0 | no webhook has ever been received |
| `ledger_transactions` | 0 | no reversal has ever been created |
| `plaid_transactions` | 0 | no synced transaction has ever been stored |
| `plaid_items` | 0 | no cursor has ever been advanced |

The webhook endpoint currently returns 401 to everything. That is correct, not
broken: `DWOLLA_WEBHOOK_SECRET` is absent, and a missing secret makes the
endpoint refuse every delivery rather than accept them.

---

## Step 1 — Settle the transfer

**The most valuable step. It exercises three milestones at once.**

Dwolla cannot reach `localhost`, so the event has to be delivered locally. This
is testing our own endpoint against our own secret, not simulating Dwolla to
anyone else.

### Mechanics, exactly

`app/api/webhooks/dwolla/route.ts` reads the **raw body text**, never
`request.json()`, because the signature covers the exact bytes and
re-serialising reorders keys.

- Header: `x-request-signature-sha-256`
- Value: HMAC-SHA256 of the raw body, keyed with `DWOLLA_WEBHOOK_SECRET`, hex,
  compared lowercase and in constant time
- Body: `{ "id": "<unique event id>", "topic": "<topic>", "resourceId": "<provider_transfer_id>" }`
- `resourceId` must equal the transfer's `provider_transfer_id`

Topics that map to an outcome, in `lib/server/dwolla-webhook.ts`:

| Topic | Result |
|---|---|
| `customer_transfer_completed` | `settled` |
| `customer_transfer_failed` | `failed` |
| `customer_transfer_returned` | `returned` |

### What to do

1. Generate a secret and put it in `.env.local` as `DWOLLA_WEBHOOK_SECRET`.
   Restart the dev server so it is read.
2. Post a signed `customer_transfer_completed` event whose `resourceId` is
   `8e1fe32e-dfaa-f111-acd5-02ab38c54207`.
3. Assert the outcome, in the database rather than in the response:
   - `transfers.state` is now `settled`
   - the hold is `captured`, with `resolved_at` set
   - `ledger_entries` holds a balanced set summing to zero
   - `ledger_transactions` has one row
   - `provider_webhook_events` has one row
   - a third transition row exists, `submitted → settled`
4. **Post the identical event again.** It must produce `duplicate`, change
   nothing, and add no second entry. This is the deduplication guard and it is
   the whole reason the provider's event id is a unique index.
5. Post an event with a **wrong signature**. It must return 401 and write
   nothing.

### What must not be done to make this pass

- Do not add a bypass for local testing. There is no "skip verification" mode
  and adding one would turn a misconfiguration into an open endpoint.
- Do not write `settled` from anywhere except the one function that already
  does. An architecture test asserts only the transfers repository assigns a
  state, and it is non-vacuous.
- The state change and the ledger posting share one transaction. A settled
  transfer the ledger has never heard of must remain impossible.

---

## Step 2 — Run the Plaid sync

**`plaid_items` is empty, so the rebuilt cursor engine has never advanced
against a real Item.**

Transaction history reads the synced store. What Ana sees today is Appwrite
transfer records, not synced Plaid transactions, because the store is empty.

```bash
npm run plaid:sync
```

### What to check afterwards

1. `plaid_items` has a row per linked Item with a non-null cursor.
2. `plaid_transactions` is populated.
3. **Run it a second time.** The cursor must advance rather than re-walk. The
   original defect was calling `transactionsSync` with no cursor inside
   `while (has_more)`, which returned the same first page forever.
4. Transaction history in the UI now shows synced transactions alongside
   transfers.
5. Amounts are integer minor units, converted through the decimal
   representation in `lib/plaid-sync/adapter.ts`, never `amount * 100`.

### Constraint

`sync.ts` and the cursor repository are operator-only. A render path must never
reach a module that advances a cursor, or two concurrent renders race the same
Item. An architecture test enforces this; do not relax it to make the UI
refresh.

---

## Step 3 — Reconcile

Only meaningful once Step 1 has produced real ledger entries.

```bash
npm run db:reconcile
npm run db:reconcile -- --provider    # also asks Dwolla
```

It compares the ledger against itself, and with `--provider` against Dwolla's
view. It **reports and never repairs**, and an architecture test scans every
module under `lib/reconciliation/` for writes of any form. Correcting drift
automatically would destroy the evidence of what caused it, and applying the
provider's view would make reconciliation a second place settlement can happen,
bypassing the signature check that makes the first one trustworthy.

Expect clean output. If it reports drift, that is a finding worth investigating
rather than a bug in the reconciler.

---

## Step 4 — Add Playwright and lock the flow in

**The structural gap. The project has never had an end-to-end test.**

The case is no longer theoretical. In recent sessions, driving the app by hand
found: an empty-state crash on every page for a new user, a silent bank-link
failure, an enrolment defect that made every new signup permanently unable to
transfer, an encryption and migration interaction that fed ciphertext to Plaid,
and a rate-limit guard that reported the opposite of the truth. **None was
caught by the unit suite. Every one would have been caught by driving the app
once.**

### Minimum worth having

1. Sign up a new user, and assert they can reach the dashboard without a crash.
2. Sign in, link a sandbox bank through Plaid Link, assert every depository
   account appears rather than only the first.
3. Complete a transfer, and assert the durable result: one transfer row, one
   hold, one provider reference.
4. Submit the same transfer twice, and assert one financial effect.
5. Assert an empty state renders for a user with no linked bank.

Test 3 and 4 are the ones that matter. Assert **ledger and database state**, not
that a toast appeared.

### Practical notes

- Plaid Link runs in an iframe and needs the sandbox credentials flow.
- The rate limiter will bite a test suite that signs in repeatedly. Sign-in is
  10 per 15 minutes per address, and with no proxy in front every local request
  shares one bucket. Either sweep between runs with `npm run rate-limit:sweep`,
  which only clears expired windows, or reuse a session.
- These tests need the database and Docker running, so they belong in a separate
  CI job from the hermetic unit suite.

---

## Smaller known items

In rough order of value against effort.

1. **`withSentryConfig` import.** Both lint and build emit a deprecation: import
   it from `@sentry/nextjs/config` instead. It stops working in v11. One line.
2. **Remove the plaintext tolerance** in `lib/repositories/banks.repository.ts`.
   Reads still accept an unencrypted credential for records written before the
   encryption migration. The rule was that this comes out when
   `credentials:encrypt` reports clean, and it now does: six of six encrypted,
   zero unreadable. It is NOT a fallback for a decryption failure, and a value
   that is encrypted and fails to decrypt must still raise.
3. **Create `linked_accounts` rows on the request path.** Same defect class as
   the enrolment fix, one table over. A new user who links a bank gets no row
   until an operator runs the backfill, which produces verifier drift that is
   not really drift. Nothing breaks functionally, because every read still comes
   from Appwrite.
4. **The replay identifier inconsistency.** A fresh `initiateTransfer` returns
   the Appwrite transaction document id; a replay of the same key returns the
   PostgreSQL transfer id. The same request answers with two different
   identifiers. Pick one and make both paths return it.
5. **`shareableId` is base64**, not encryption, and it encodes the Plaid account
   id. Do not build anything on its secrecy.

---

## Invariants that must survive all of this

Enforced by tests. If one fails, the change is wrong, not the test.

| Invariant | Enforced by |
|---|---|
| Nine `lib/db` modules request-reachable, exact equality | `lib/server-action-surface.test.ts` |
| Three crossing points, all services | same |
| Seven server-action exports, exact list | same |
| Only the transfers repository assigns a transfer state | same |
| `settled` reachable only from `submitted` | same |
| No module under `lib/reconciliation/` contains a write | same |
| Render path reaches no cursor-advancing module | same |
| Request-scoped identity, isolated between concurrent users | `lib/server/render-latency.test.ts` |
| Ownership checked in the query, not after the fetch | repository tests |
| No credential or source map in client output | `.github/workflows/ci.yml` |
| Money is integer minor units end to end | `lib/domain/` tests |

## Verification after each step

```bash
npm run typecheck
npm run lint
npm test                 # 698 application tests
npm run test:db          # 326 database tests, needs TEST_DATABASE_URL
npm run build
find .next/static -name '*.js.map'    # must be empty
```

Then assert the database changed the way the step intended. Every step in this
plan produces rows, and the rows are the evidence. A step that leaves the tables
unchanged has not done its job, however green the suite is.
