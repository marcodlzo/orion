# Cutover: the remaining work

Written 2026-09-09, after Phase 1 landed. This supersedes the phase ordering in
[the cutover plan](cutover-plan.md), which was written before the accounting
model was decided.

## Where this actually stands

**Phase 1 is done.** Settlement credits the recipient, customer accounts have a
floor, and the pre-transfer check is a real balance check. See
[ADR 0002](adr/0002-cutover-accounting-model.md).

Three reads a user sees still come from Appwrite:

| What | Source today | Phase |
|---|---|---|
| Transfer history | Appwrite `transactions`, dual-written | 2 |
| Account balances | live Plaid call, every render | 3 |
| Bank records and credentials | Appwrite `banks` | 4 |

Do them in that order. Phase 2 is independent, Phase 3 depends on Phase 1 being
credible, and Phase 4 is the largest because it moves the encryption boundary.

---

## Phase 2 — Transfer history from PostgreSQL

The columns landed with Phase 1. `transfers` now carries
`recipient_user_document_id`, `recipient_customer_id`,
`sender_bank_document_id`, `recipient_bank_document_id`, `note`, and
`accounting_model`. The data to serve history exists for every transfer written
since; older rows have NULLs and need the backfill below.

### What the read has to produce

`getAccount` in `lib/server/banks.ts` merges two sources into `TransactionDTO[]`
and sorts by date descending. The Plaid half already comes from PostgreSQL. Only
the transfer half moves.

`TransactionDTO` is `id`, `name`, `date`, `amountMinor`, `direction`, `status`,
`paymentChannel`, `category`. Mapping from a transfer row:

- `name` — the `note`. Empty note means the sender typed nothing, which is not
  the same as unknown; NULL means a row that predates the column.
- `direction` — `debit` when `sender_bank_document_id` matches the bank being
  viewed, `credit` when `recipient_bank_document_id` does. **Never infer it from
  the sign of a formatted string**; that was the original defect.
- `status` — from the transfer STATE. Never from a timestamp. `getTransactionStatus`
  is deleted and must not come back.
- `amountMinor` — read with `readMoneyMinor`, never `Number()`.

### The query

One row serves both sides, so it is a single query with an OR, not two reads
merged in JavaScript:

```
WHERE sender_bank_document_id = $1 OR recipient_bank_document_id = $1
```

**PAGINATE IT.** The Appwrite version does not, and says so in a comment: both
`listDocuments` calls are unpaginated, so the default page size silently caps
the result while `total` reports the real number. A user with more transfers
than one page has been quietly missing history. Do not port that across — this
is the opportunity to fix it, and a test should prove a customer with more rows
than one page sees all of them.

### Ownership

The existing read proves ownership by looking the bank up scoped to the actor,
then querying by its document id. Keep that shape. The `appwriteItemId` arrives
from a URL query parameter and must never reach a query unchecked, and do not
replace the check with a filter applied after a broader read.

### Backfill

The Appwrite collection holds rows the PostgreSQL table does not. Treat it like
every other migration here: dry run first, an independent verifier, and a
refusal to invent a fact.

**The matching problem is real.** Legacy Appwrite records carry neither the
PostgreSQL transfer id nor the idempotency key, so two identical transfers a
second apart cannot be told apart by amount and timestamp. Refuse ambiguous
matches and require an explicit reviewed mapping rather than guessing. There are
currently two legacy documents against one PostgreSQL transfer, so this is small
enough to review by hand.

### Order of operations

1. Add the read alongside the existing one. Do not switch yet.
2. Compare both for the same account: amount, direction, note, date, status,
   merged Plaid rows, and sort order. Sender and recipient views independently.
3. Switch `getAccount` to the PostgreSQL read.
4. **Only then** stop `createTransactionRecord` in `executeTransfer`.
5. Delete `PROVIDER_REFERENCE_PERSISTENCE` in `transfers.service.ts`. It exists
   because the Appwrite collection has no column for the provider reference; the
   PostgreSQL table has had one since Phase 7.

Steps 3 and 4 are separate on purpose. While both stores are written, either can
serve, and a mistake is recoverable by switching back.

---

## Phase 3 — Balances from the ledger

`getAccounts` calls Plaid `accountsGet` on every render. After Phase 1 the
ledger holds a real balance, derived as `SUM(amount_minor) - active holds +
credit_limit_minor`.

**Show both, labelled.** The provider balance is what the external bank says.
The ledger balance is what this system has recorded. They answer different
questions, and displaying one under the other's name is how a banking interface
lies. The credit allowance in particular must stay separately labelled: it is
not cash.

There is no stored balance column and there must not be one. A balance is
derived on every read, which is what makes it unable to disagree with the
entries.

The per-render memo already deduplicates the Plaid call within one render. If
provider balances are kept for display, that is where they stay — do not add a
cross-request cache without deciding a staleness budget, because a stale balance
in a banking interface is a wrong number, not a slow one.

---

## Phase 4 — Bank records and credentials

The largest, and the only one that moves the encryption boundary.

`linked_accounts` already mirrors every bank on the request path and matches
today. What it deliberately does not hold is `accessToken` and
`fundingSourceUrl`, and a test asserts no column could.

**This is a re-encryption, not a copy.** Each ciphertext is bound to its record
id and field — that binding is what stops one being moved into another row and
used — so new record ids mean the binding must be rebuilt. Decrypt through the
existing boundary, re-encrypt against the target, verify the round trip without
printing values, then switch.

Rules that are currently enforced by tests and must survive:

- Encryption and decryption happen at **one** storage boundary. Keep exactly
  one; do not end up with two while migrating.
- `keyring.ts` stays the only reader of `CREDENTIAL_ENCRYPTION_KEYS`.
- There is no plaintext tolerance to fall back on. A value that fails to decrypt
  raises.
- No mixed-store runtime fallback. Reads come from one place.

Sequence: add the columns, migrate with a dry run and a verifier, move the
boundary, switch reads, then remove the Appwrite bank collection from the read
path.

---

## What stays in Appwrite

Authentication and the user profile. That was always the plan and it is not part
of this cutover. Migrating them for tidiness buys nothing and puts the session
and the identity bridge in two places that can disagree.

---

## Housekeeping, independent of the phases

1. **Re-link a bank.** Both existing Plaid Items report
   `ADDITIONAL_CONSENT_REQUIRED` and cannot gain the `transactions` product
   retroactively, so transaction history has nothing to show. The end-to-end run
   proved a fresh link syncs correctly. This is a data problem, not a code one,
   and it blocks seeing Phase 2 work against real data.
2. **Give the browser suite a schedule.** It is manual dispatch and does not run
   on every commit, so it can rot. A nightly run is probably right; per-commit
   is not, because it creates provider-side records.
3. **A separate Appwrite project for end-to-end runs.** The suite now cleans up
   after itself and `npm run e2e:cleanup` sweeps residue, but it still writes to
   the same project as real data. That mitigation is not isolation.
4. **Next.js 16.** Its own migration. No middleware, no custom server, no
   rewrites, no i18n, so most advisories do not reach this application. What does
   is the Server Component denial of service and the unauthenticated disclosure
   of internal Server Function endpoints. When it happens, `vitest.config.ts`
   aliases React to a version-specific path inside `next/dist` — fix the path,
   and never replace `cache()` with a stub.
5. **`shareableId` is base64** of the Plaid account id, not encryption. The last
   open finding, and nothing should depend on its secrecy.
6. **The reconciliation drift is deliberate.** `internal=settled,
   provider=pending`, because settlement was driven by a locally injected event.
   Leave it until a transfer settles for real.

---

## Invariants

Enforced by tests. If one fails, the change is wrong, not the test.

| Invariant | Enforced by |
|---|---|
| `lib/db` modules request-reachable, exact equality | `lib/server-action-surface.test.ts` |
| Crossing points are services, listed exactly | same |
| Seven server-action exports, exact list | same |
| Nothing that creates money is request-reachable | same |
| No script is request-reachable | same |
| Only the transfers repository assigns a transfer state | same |
| `settled` reachable only from `submitted` | same |
| No module under `lib/reconciliation/` contains a write | same |
| Render path reaches no cursor-advancing module | same |
| `pg` imported only from `lib/db` | same |
| Entries sum to zero; UPDATE and DELETE rejected | deferred constraint and triggers |
| No stored balance column, anywhere | schema tests |
| One posting per source reference | unique index |
| Request-scoped identity, isolated between users | `lib/server/render-latency.test.ts` |
| Ownership checked in the query, not after the fetch | repository tests |
| Reads refuse a plaintext credential | `lib/actions/user.actions.test.ts` |
| No credential reaches `linked_accounts` | `bank-linking.service.db.test.ts` |
| No credential or source map in client output | `.github/workflows/ci.yml` |

The `lib/db` allowlist grows during this work. That is the point of a cutover,
but each addition is a decision to argue for in the same commit, not a line to
absorb quietly.

---

## Verification, per phase

```bash
npm run typecheck
npm run lint
npm test                  # 709 application tests
npm run test:db           # 348 database tests
npm run build
npm run test:e2e          # 6 browser tests, needs sandbox credentials
find .next/static -name '*.js.map'    # must be empty
```

Operator tooling after anything that touches storage:

```bash
npm run credentials:check
npm run credentials:encrypt         # dry run; every value encrypted
npm run db:backfill                 # dry run
npm run db:verify                   # no drift
npm run db:reconcile                # internal
npm run db:reconcile -- --provider
npm run funding:opening             # dry run; already-allocated is correct
```

Then assert the database changed the way the phase intended. Every phase here
moves or produces rows, and the rows are the evidence. A phase that leaves the
tables unchanged has not done its job, however green the suite is.

## The rule that matters most

Every change leaves a working, buildable application. Land beside the old path,
verify the new one agrees, cut over, then remove the old path. Do not delete an
Appwrite read until a PostgreSQL read has been proven to give the same answer.
