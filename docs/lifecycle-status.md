# Lifecycle status and handoff

Written 2026-09-08, after resuming and completing the work in
[the lifecycle completion plan](lifecycle-completion-plan.md).

Three of the four planned steps are done. This records what is proven, what the
reconciler found, and what is left.

---

## Done, with evidence from the live database

### Step 1 — Settlement. Complete.

The money lifecycle now runs end to end. Not in a test: in the database.

| Check | Result |
|---|---|
| transfer state | `settled` |
| hold | `captured`, `resolved_at` set |
| ledger transactions | 1 |
| ledger entries | 2, summing to exactly 0 |
| webhook events | 1 |
| state transitions | 3 |

The transitions read `→ requested` (cause `claim`), `requested → submitted`
(cause `provider-accepted`), `submitted → settled` (cause `provider-event`).

Both negative cases were exercised and both behaved:

- The identical event replayed returned `duplicate` and changed nothing.
- A wrong signature returned 401 and wrote nothing.

That is Milestone 6 (the ledger), Milestone 7 (the state machine and webhooks)
and Milestone 8 (hold capture) working against a real server for the first time.

### Step 3 — Reconciliation. Complete, and it found something.

Internal checks are clean: 1 transfer checked, 0 findings.

**Against the provider it reports one critical finding, and the finding is
correct:**

```
CRITICAL  PROVIDER_CONTRADICTS_SETTLEMENT
          internal=settled  provider=pending
```

This is not a bug. The settlement above was driven by a **locally injected**
webhook event, because Dwolla cannot reach `localhost`. Dwolla itself never
completed the transfer, so it still reports `pending` while our ledger counts it
as settled. The ledger is genuinely ahead of the provider and the reconciler is
right to say so.

Two things worth noting:

1. **This finding only exists because the `pending` case was added to
   `checkAgainstProvider`.** Before that change only `failed` and `returned`
   contradicted a local `settled`, and an artificial settlement would have
   passed silently.
2. **It reported and repaired nothing**, exactly as designed. The output ends
   with `NOTHING WAS CHANGED`.

Leaving the drift in place is deliberate. It is the honest record of what was
done, and clearing it by hand would destroy the first real example this system
has of the reconciler doing its job.

### Smaller items, all landed

| Item | State |
|---|---|
| `withSentryConfig` imported from `@sentry/nextjs/config` | done, before it breaks in v11 |
| Plaintext credential tolerance removed | done, and now guarded by a test |
| Replay returns the same identifier as the original call | done |
| `linked_accounts` rows created on the request path | done, with nine tests |
| Reconciler treats provider `pending` vs local `settled` as drift | done |

### What was added while finishing

`lib/services/bank-linking.service.ts` is the **third request path that writes
to PostgreSQL** and it arrived with no test. That is the shape of the enrolment
defect: a path nothing exercises, which was permanently broken for every new
user while the whole suite stayed green.

It now has nine tests against a real server, covering the properties that exist
only because Appwrite and PostgreSQL cannot share a transaction:

- a first link creates both the customer bridge and the mirror row
- a retry repairs a missing mirror without creating a second bank document
- relinking the same account does not duplicate it
- an account arriving under a different Item is refused
- a failed mirror does not leak the driver error, which quotes the offending row
- **no credential reaches PostgreSQL**, asserted by value and by column name

Four mutations were run and each turned tests red: skipping the mirror (5 tests),
dropping the currency guard (2), re-adding the plaintext tolerance (1), and a
corrected fault injection (1).

The plaintext mutation is the one worth understanding. Tolerance is
**permissive**, so re-adding it leaves every encrypted fixture passing. Without
a test that specifically asserts refusal, that removal would silently drift back
and nothing would notice.

---

## Not done

### Step 2 — Plaid sync. Blocked, and the block is understood.

The sync ran. It did the right thing and recorded a provider error:

| Field | Value |
|---|---|
| status | `error` |
| last_error_code | `ADDITIONAL_CONSENT_REQUIRED` |
| cursor | still null |
| consecutive_failures | 1 |

Both Items are in this state. **This is the error handling working, not a
defect.** The cursor was left exactly where it was, the provider's CODE was
stored rather than its message, and the item was marked rather than the failure
being swallowed.

The cause: both Items were linked when the link token requested the `auth`
product only. `transactionsSync` needs `transactions`.

`createLinkToken` now requests `['auth', 'transactions']`, so the fix is in
place for **future** links. The two existing Items predate it.

**To finish this step, re-link a bank.** The existing Items cannot gain a
product retroactively. After re-linking:

1. `npm run plaid:sync`
2. Confirm `plaid_items.cursor` is non-null and `status` is `healthy`
3. Confirm `plaid_transactions` is populated
4. **Run it a second time** and confirm the cursor advances rather than the
   walk restarting. The original defect was calling `transactionsSync` with no
   cursor inside `while (has_more)`, which returned the same first page forever.
5. Confirm amounts are integer minor units, converted through the decimal
   representation in `lib/plaid-sync/adapter.ts`, never `amount * 100`.

Do not relax the architecture test that keeps a render path away from the cursor
store in order to make the UI refresh. Two concurrent renders would race the
same Item.

### Step 4 — Playwright. Not started.

Still the largest structural gap, and the case is made from this project's own
history rather than in principle. Driving the app by hand has now found: an
empty-state crash for every new user, a silent bank-link failure, an enrolment
defect that made every new signup permanently unable to transfer, an encryption
interaction that fed ciphertext to Plaid, a rate-limit guard that reported the
opposite of the truth, and a linking service shipped with no test.

None was caught by the unit suite. Every one would have been caught by driving
the app once.

The five tests worth having, and the practical obstacles, are in
[the completion plan](lifecycle-completion-plan.md#step-4--add-playwright-and-lock-the-flow-in).
The two that matter most assert **database state** after a transfer and after a
duplicate submission, not that a toast appeared.

### Still open, unchanged

- **`shareableId` is base64**, not encryption, and it encodes the Plaid account
  id. Do not build anything on its secrecy.
- **Next.js 16** remains its own migration decision. Every remaining Next
  advisory has its first fix there and none reaches the 14.x line. Most do not
  apply to this application: there is no middleware, no custom server, no
  rewrites and no i18n. What does apply is the Server Component denial of
  service and the unauthenticated disclosure of internal Server Function
  endpoints.
- **Dependency advisories** sit at 13 affected packages with none critical,
  almost all build tooling plus Next itself.

---

## Current gate status

| Gate | Result |
|---|---|
| typecheck | clean |
| lint | clean |
| application tests | 700 passed |
| database tests | 335 passed |
| production build | compiled |
| client credential scan | clean |
| client source-map scan | clean |

## Invariants to keep

Enforced by tests. If one fails, the change is wrong, not the test.

| Invariant | Enforced by |
|---|---|
| Ten `lib/db` modules request-reachable, exact equality | `lib/server-action-surface.test.ts` |
| Crossing points are services, listed exactly | same |
| Seven server-action exports, exact list | same |
| Only the transfers repository assigns a transfer state | same |
| `settled` reachable only from `submitted` | same |
| No module under `lib/reconciliation/` contains a write | same |
| Render path reaches no cursor-advancing module | same |
| Request-scoped identity, isolated between concurrent users | `lib/server/render-latency.test.ts` |
| Reads refuse a plaintext credential | `lib/actions/user.actions.test.ts` |
| No credential reaches `linked_accounts` | `lib/services/bank-linking.service.db.test.ts` |
| No credential or source map in client output | `.github/workflows/ci.yml` |

## A note on test fixtures

Since reads stopped tolerating plaintext, **every fixture carrying a stored
credential must be real ciphertext**, encrypted with `encryptCredential` and
bound to that record's id and field. A bare string is a document the datastore
cannot produce, and the repository correctly refuses it.

The test keyring is generated per run in `vitest.setup.ts` and never committed.

One trap, already hit once: a provider stub must match on the **plaintext**,
because the repository decrypts before calling the provider. A stub matching on
the stored ciphertext never fires, and it fails in a way that looks like a
caching bug rather than a fixture one.
