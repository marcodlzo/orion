# Making PostgreSQL the system of record

Written 2026-09-09. The final architectural piece of the project.

The stated target is "the internal ledger is the system of record". It is not
yet. Every read a user sees still comes from Appwrite, while PostgreSQL holds
financial state that nothing displays.

This was blocked on encrypting provider credentials. That landed. Nothing blocks
it now except doing it.

**Read section 1 before planning any of this.** Three things found while writing
this plan change what the first phase has to be, and none of them is visible
from the schema alone.

---

## 1. Three findings that shape the order

### 1.1 The ledger does not model a transfer between two customers

This is the important one.

Settlement posts two lines, in `lib/services/settlement.service.ts`:

```
customer   -amount
settlement +amount
```

The **recipient is never credited**. `settlement` is a single house account, not
the person receiving the money. So the ledger records "money left the sender
toward the provider", which is a defensible model of an ACH debit, but it is not
"money moved from A to B".

The consequence is concrete. In the live database right now:

| Account | Balance |
|---|---|
| sender (customer) | -500 |
| settlement (house) | +500 |
| recipient | no entries at all |

The recipient saw `+$5.00` in the interface, but that came from the Appwrite
transaction record, not from the ledger. **If PostgreSQL became authoritative
today, the recipient's balance would show nothing received.**

Decide this before anything else, because everything downstream reads these
balances. Two coherent options:

- **Two-legged internal transfer.** Credit the recipient's customer account
  instead of the house account when both parties are internal. The settlement
  account then only appears for money genuinely entering or leaving the system.
- **Keep the house account and add a second posting** that credits the
  recipient when the funds arrive, driven by its own provider event.

The first is simpler and matches how the money actually moves between two users
of this application. The second is more faithful to ACH if inbound settlement is
ever tracked separately. Either way it is a **product decision, not a
refactor**, and it changes what a balance means.

### 1.2 Nothing ever credits a customer account

Related but distinct. Even with 1.1 fixed, a customer's balance starts at zero
and only ever goes down, because no deposit path exists. The
`credit_limit_minor` of 500,000 is what makes any transfer possible at all.

So the check that runs before every transfer is an **in-flight exposure cap**,
not a solvency check. The enforcement is correct, tested, and takes a row lock;
it simply has no real balance to enforce against.

Closing this means crediting customer accounts from Plaid balances. Until then,
**do not show a ledger balance to a user** — it would read as a large negative
number against an allowance nobody explained.

### 1.3 The transfers table cannot render transaction history

Moving history to PostgreSQL is not "read from the other store". The columns do
not exist.

`transfers` has: `id`, `customer_id`, `idempotency_key`, `request_fingerprint`,
`state`, `amount_minor`, `currency`, `provider`, `provider_transfer_id`,
`failure_code`, and timestamps.

`TransactionDTO` needs: `name`, `date`, `amountMinor`, `direction`, `status`,
`paymentChannel`, `category`.

Missing entirely:

- **the note** the sender typed, which is the transaction's `name`
- **the counterparty**, so neither side can be labelled
- **the recipient's identity**, so `transfers` is keyed only to the sender via
  `customer_id` and a recipient cannot query their incoming transfers at all

The Appwrite `transactions` collection holds all of this (`name`, `senderId`,
`receiverId`, `senderBankId`, `receiverBankId`, `email`). That is why it is
still dual-written by `executeTransfer`.

So this phase needs a **migration**, not just a query change.

---

## 2. Phases, in dependency order

### Phase 1 — Make a balance mean something

**Depends on nothing. Everything else depends on it.**

1. Decide 1.1: does an internal transfer credit the recipient's account, or the
   house account plus a later posting? Write the decision down as an ADR in
   `docs/adr/` before writing code.
2. Implement it in the settlement posting. Entries still sum to zero; the
   deferred constraint trigger already enforces that and must not be relaxed.
3. Credit customer accounts from Plaid balances so a balance has a floor other
   than the credit limit.
4. Only then consider lowering `CUSTOMER_CREDIT_LIMIT_MINOR`, which exists
   solely because balances start at zero.

**Do not** post a correcting entry to fix the existing transfer. Entries are
immutable by trigger, and that is the point. If the model changes, the old
posting stays as it was and a compensating posting records the change — the
reversal machinery in Milestone 9 already does exactly this.

**Watch out for:** the existing settled transfer is the only real ledger data
you have. Whatever you change must leave it interpretable, not orphaned.

### Phase 2 — Transaction history from PostgreSQL

**Depends on Phase 1 only for what a balance means; the history itself is
independent.**

1. Add the missing columns to `transfers`, or a companion table: the note, and
   both parties. Prefer explicit sender and recipient customer references over
   copying Appwrite document ids, since the point is to stop depending on them.
2. Backfill from the Appwrite `transactions` collection. Treat it exactly like
   the existing backfill: dry run first, an independent verifier, and a refusal
   to invent a fact it cannot read.
3. Switch `getAccount` to read history from PostgreSQL instead of
   `getTransactionsForOwnedBank`.
4. **Stop the dual write** in `executeTransfer` only after the read has been
   switched and verified. Until then, both stores stay in step and either can
   serve.
5. Delete `PROVIDER_REFERENCE_PERSISTENCE` in `transfers.service.ts`. It exists
   because the Appwrite collection has no column for the provider reference. The
   PostgreSQL table has had one since Phase 7.

**Watch out for:** `plaid_transactions` already serves synced provider
transactions from PostgreSQL. The history view merges those with transfer
records. Do not lose the merge or the sort.

### Phase 3 — Balances from the ledger

**Depends on Phase 1 being complete and credible.**

`getAccounts` calls Plaid `accountsGet` on every render for a live balance.
After Phase 1 the ledger has a real balance, and a derived
`SUM(amount_minor) - active holds + credit_limit` is what the application should
show for internal funds.

Keep the distinction visible in the interface: the provider's balance is what
the bank says, and the ledger balance is what this system has recorded. They
answer different questions and showing one labelled as the other is how a
banking interface lies.

**Watch out for:** there is still no stored balance column and there must not
be. A balance is derived on every read, which is what makes it impossible for it
to disagree with the entries.

### Phase 4 — Bank records and credentials

**The real cutover. Do it last.**

`linked_accounts` already mirrors every bank on the request path and matches
today: 3 rows, 3 documents. What it deliberately does **not** hold is the
`accessToken` and `fundingSourceUrl`, and a test asserts no column could.

Moving those means **moving the encryption storage boundary** from
`lib/repositories/banks.repository.ts` to a PostgreSQL repository. That is a
single, careful move with rules that are currently enforced by tests:

- Encryption and decryption happen at **one** storage boundary and nowhere else.
- Each ciphertext is bound to its record id and field, which is what stops one
  being copied into another row and used. The binding must be rebuilt for the
  new record ids, so this is a **re-encryption**, not a copy.
- `keyring.ts` stays the only reader of `CREDENTIAL_ENCRYPTION_KEYS`.
- There is no plaintext tolerance to fall back on any more. A value that fails
  to decrypt raises.

Sequence that keeps the application working throughout:

1. Add the credential columns to `linked_accounts` (or a dedicated table).
2. Write a migration that reads through the Appwrite boundary, decrypts, and
   re-encrypts bound to the new record. Dry run, verifier, refuses on any value
   it cannot read — the existing `credentials:encrypt` is the model.
3. Move the storage boundary. Keep exactly one.
4. Switch reads.
5. Remove the Appwrite bank collection from the read path.

**Watch out for:** the ownership predicate must remain part of the query, not a
filter applied after fetching. Every Appwrite repository does this today and it
is asserted; the PostgreSQL equivalents must do the same, or a record the actor
does not own becomes reachable in memory.

---

## 3. What stays in Appwrite

Authentication and the user profile. That is legitimate and the project has said
so from the start: Appwrite may remain authentication infrastructure during and
after migration. `getLoggedInUser` reading a profile from Appwrite is not part
of this cutover.

Do not migrate the user collection for tidiness. It buys nothing and it puts the
session and the identity bridge in two places that can disagree.

---

## 4. Housekeeping, independent of the cutover

Each of these is small and none blocks the phases above.

1. **The end-to-end suite does not run on every commit.** It is manual dispatch
   because it needs sandbox credentials and creates provider-side records. A
   suite nothing runs is a suite that rots, and this one took real effort to get
   green. Consider a nightly schedule rather than per-commit, and note it
   creates a fresh Appwrite user per run, which accumulates.
2. **Two Plaid Items are stale.** Both report `ADDITIONAL_CONSENT_REQUIRED` and
   cannot gain the `transactions` product retroactively. Transaction history
   stays empty until a bank is re-linked. The end-to-end run proved a fresh link
   syncs correctly, so this is a data problem, not a code one.
3. **Next.js 16.** Its own migration. Most advisories do not reach this
   application: no middleware, no custom server, no rewrites, no i18n. What does
   reach it is the Server Component denial of service and the unauthenticated
   disclosure of internal Server Function endpoints. When it happens,
   `vitest.config.ts` aliases React to a version-specific path inside
   `next/dist` — fix the path, never replace `cache()` with a stub, because the
   suite exists to prove memoisation is scoped to one request.
4. **`shareableId` is base64** of the Plaid account id, not encryption. Nothing
   should depend on its secrecy.
5. **The reconciliation finding is deliberate.** `internal=settled,
   provider=pending`, because settlement was driven by a locally injected event.
   Leave it until a transfer settles for real, then confirm it clears.

---

## 5. Invariants that must survive the cutover

Enforced by tests. If one fails, the change is wrong, not the test.

| Invariant | Enforced by |
|---|---|
| `lib/db` modules request-reachable, exact equality | `lib/server-action-surface.test.ts` |
| Crossing points are services, listed exactly | same |
| Seven server-action exports, exact list | same |
| Only the transfers repository assigns a transfer state | same |
| `settled` reachable only from `submitted` | same |
| No module under `lib/reconciliation/` contains a write | same |
| Render path reaches no cursor-advancing module | same |
| Entries sum to zero; UPDATE and DELETE rejected | deferred constraint and triggers |
| No stored balance column, anywhere | schema tests |
| Request-scoped identity, isolated between users | `lib/server/render-latency.test.ts` |
| Ownership checked in the query, not after the fetch | repository tests |
| Reads refuse a plaintext credential | `lib/actions/user.actions.test.ts` |
| No credential reaches `linked_accounts` | `bank-linking.service.db.test.ts` |
| No credential or source map in client output | `.github/workflows/ci.yml` |

The `lib/db` allowlist will grow during this work. **That is the point of the
cutover**, but each addition is still a deliberate decision to argue for, not a
line to absorb quietly. Update the count and say why in the same commit.

---

## 6. Verification, per phase

```bash
npm run typecheck
npm run lint
npm test                  # 700 application tests
npm run test:db           # 335 database tests
npm run build
npm run test:e2e          # 6 browser tests, needs sandbox credentials
find .next/static -name '*.js.map'    # must be empty
```

Operator tooling after any phase that touches storage:

```bash
npm run credentials:check
npm run credentials:encrypt    # dry run; must report every value encrypted
npm run db:backfill            # dry run
npm run db:verify              # must report no drift
npm run db:reconcile           # internal
npm run db:reconcile -- --provider
```

Then assert the database changed the way the phase intended. Every phase here
produces or moves rows, and the rows are the evidence. A phase that leaves the
tables unchanged has not done its job, however green the suite is.

## 7. The rule that matters most

Every change leaves a working, buildable application. Land behind the existing
dual-write, verify the new path against the old, then cut over, then remove the
old path. Do not delete an Appwrite read until a PostgreSQL read has been proven
to serve the same answer.
