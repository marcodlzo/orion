# Everything still to do

Rewritten 2026-09-09, after Phase 2 landed. This replaces the earlier version of
this file, whose Phase 2 section is now history.

## Where this stands, measured

**The application is finished. The architecture is three quarters there.**

Every user-facing flow works end to end against real providers and is proven by
six browser tests. One real transfer has moved money, settled through a
signature-verified webhook, captured its hold and posted balanced ledger
entries. The ledger holds six entries across two customers and sums to exactly
zero.

| Phase | State |
|---|---|
| 1 — accounting model, recipient credited, balances funded | **done** |
| 2 — transfer history from PostgreSQL, dual write removed | **done** |
| 3 — balances from the ledger | not started |
| 4 — bank records and credentials | not started |

One security finding remains open, and it is the mildest on the original list:
`shareableId` is base64 rather than encryption.

---

## Phase 3 — Balances from the ledger

**Small. Mostly a display decision, because the data already exists.**

`getAccounts` in `lib/server/banks.ts` calls Plaid `accountsGet` on every render
for a balance. Since Phase 1 the ledger holds a real one, derived as
`SUM(amount_minor) - active holds + credit_limit_minor`.

### What to build

Show **both, labelled as the different things they are**:

- The **provider balance** is what the external bank says the customer has
  THERE. It is what `accountsGet` returns.
- The **ledger balance** is what this system has recorded. It is what a transfer
  is checked against.

Displaying one under the other's name is how a banking interface lies. They
genuinely differ right now — the ledger balance came from an opening allocation,
not from money Orion received — and the interface must not blur that.

The **credit allowance stays separately labelled**. It is not cash, and it is
what makes any transfer possible while real funding does not exist.

### Constraints

- **No stored balance column, ever.** A balance is derived on every read, which
  is what makes it unable to disagree with the entries. A schema test asserts
  this.
- The per-render memo already deduplicates the Plaid call within one render. Do
  not add a cross-request cache without deciding a staleness budget: a stale
  balance in a banking interface is a wrong number, not a slow one.
- `formatMinorUnits` renders money and REFUSES a float. Do not reintroduce a
  dollars-as-double prop.

---

## Phase 4 — Bank records and credentials

**The last large piece, and the only one that moves the encryption boundary.**

`linked_accounts` already mirrors every bank on the request path. What it
deliberately does not hold is `accessToken` and `fundingSourceUrl`, and a test
asserts no column could.

### The exact surface

`lib/repositories/banks.repository.ts` has five exports. Every caller:

| Function | Called from |
|---|---|
| `getOwnedBanks` | `lib/server/banks.ts` |
| `getOwnedBankByDocumentId` | `lib/server/banks.ts`, `lib/services/transfers.service.ts`, `lib/repositories/transactions.repository.ts` |
| `getOwnedBankByAccountId` | `lib/services/bank-linking.service.ts` |
| `findCounterpartyBankByAccountId` | `lib/services/transfers.service.ts` |
| `createBankForActor` | `lib/actions/user.actions.ts`, `lib/services/bank-linking.service.ts` |

Five functions, five caller files once the dead one below is removed. The work
is not the size — it is the care.

### This is a RE-ENCRYPTION, not a copy

Each ciphertext is bound to its record id and field. That binding is what stops
one being moved into another row and used, so **new record ids mean the binding
must be rebuilt**. A straight column copy produces ciphertext that fails to
decrypt, which is the protection working — but discovering it after the switch
means an outage.

Decrypt through the existing boundary, re-encrypt against the target record,
verify the round trip **without printing values**, then switch.

### Rules currently enforced by tests, which must survive

- Encryption and decryption happen at **one** storage boundary. Do not end up
  with two while migrating.
- `keyring.ts` stays the only reader of `CREDENTIAL_ENCRYPTION_KEYS`.
- There is no plaintext tolerance to fall back on. A value that is encrypted and
  fails to decrypt raises.
- No mixed-store runtime fallback. Reads come from one place.
- **Ownership stays in the SQL predicate**, not a filter applied after a broader
  read. Every Appwrite repository does this today; the PostgreSQL equivalents
  must too, or a record the actor does not own becomes reachable in memory.

### Sequence

1. Add the credential columns — a dedicated table is cleaner, so
   `linked_accounts` stays metadata-only and its "no credential" test keeps
   meaning something.
2. Migrate with a dry run and an independent verifier, refusing any value it
   cannot read. `npm run credentials:encrypt` is the model.
3. Move the storage boundary. Keep exactly one.
4. Switch reads.
5. Remove the Appwrite bank collection from the read path.

---

## Cleanup the cutover left behind

**`lib/repositories/transactions.repository.ts` is dead in production code.**
Nothing outside tests imports it: `getTransactionsForOwnedBank` lost its caller
when history moved, and `createTransactionRecord` lost its caller when the dual
write stopped.

`toTransactionDTOFromRecord` in `lib/dto/transaction.dto.ts` is dead the same
way — only its own tests use it.

Both should go, along with the tests that exist solely to cover them, and their
entries in the architecture allowlists. Do this deliberately in its own commit
rather than folding it into a phase: deleting a repository is the kind of change
that should be visible in the history.

Leave the Appwrite **collection** in place. It holds legacy rows and a schema
test now asserts the application no longer writes it.

---

## Not a task — a judgement call worth naming

**Real funding does not exist.** Customer balances came from an
`opening_allocation`, which is honestly-labelled seeded capital booked against
equity. Money has never actually arrived.

Building it means an inbound transfer confirmed by a provider event, using the
same `source_reference` mechanism so a duplicate delivery posts once, and
distinguishable from an allocation by transaction kind. The mechanism is already
there; the flow is not.

That is the difference between a correct banking application and a working one,
and it is a product decision rather than an item on this list.

---

## Housekeeping

Ordered by what unblocks the most.

1. **Re-link a bank.** Both Plaid Items report `ADDITIONAL_CONSENT_REQUIRED` and
   cannot gain the `transactions` product retroactively, so transaction history
   is empty no matter how correct the code is. The browser suite proved a fresh
   link syncs correctly. This is data, not code, and it blocks seeing Phase 3
   work against anything real.
2. **Give the browser suite a schedule.** Manual dispatch only, so it can rot,
   and it took real effort to get green. Nightly is probably right; per-commit is
   not, because it creates provider-side records.
3. **A separate Appwrite project for end-to-end runs.** The suite cleans up
   after itself now and `npm run e2e:cleanup` sweeps residue, but it still writes
   to the same project as real data. Mitigation is not isolation. This one bit
   already: nine of eleven users were test residue before it was noticed, and a
   backfill dry run would have migrated all of them.
4. **Next.js 16.** Its own migration. No middleware, no custom server, no
   rewrites, no i18n, so most advisories do not reach this application. What does
   is the Server Component denial of service and the unauthenticated disclosure
   of internal Server Function endpoints. `vitest.config.ts` aliases React to a
   version-specific path inside `next/dist` — fix the path when it moves, and
   never replace `cache()` with a stub, because that suite exists to prove
   memoisation is scoped to one request.
5. **`shareableId` is base64** of the Plaid account id. The last open finding.
   Nothing should depend on its secrecy.
6. **The reconciliation drift is deliberate.** `internal=settled,
   provider=pending`, because settlement was driven by a locally injected event.
   Leave it until a transfer settles for real.

---

## Invariants

Enforced by tests. If one fails, the change is wrong, not the test.

| Invariant | Enforced by |
|---|---|
| `lib/db` modules request-reachable, exact equality | `lib/server-action-surface.test.ts` |
| Crossing points listed exactly | same |
| Seven server-action exports, exact list | same |
| Nothing that creates money is request-reachable | same |
| No script is request-reachable | same |
| Only the transfers repository assigns a transfer state | same |
| `settled` reachable only from `submitted` | same |
| No module under `lib/reconciliation/` contains a write | same |
| Render path reaches no cursor-advancing module | same |
| `pg` imported only from `lib/db` | same |
| The application does not write the Appwrite transactions collection | `scripts/appwrite-schema.test.ts` |
| Entries sum to zero; UPDATE and DELETE rejected | deferred constraint and triggers |
| No stored balance column, anywhere | schema tests |
| One posting per source reference | unique index |
| Request-scoped identity, isolated between users | `lib/server/render-latency.test.ts` |
| Ownership checked in the query, not after the fetch | repository tests |
| Reads refuse a plaintext credential | `lib/actions/user.actions.test.ts` |
| No credential reaches `linked_accounts` | `bank-linking.service.db.test.ts` |
| No credential or source map in client output | `.github/workflows/ci.yml` |

The `lib/db` allowlist grows during Phase 4. That is the point of a cutover, but
each addition is a decision to argue for in the same commit.

---

## Verification

```bash
npm run typecheck
npm run lint
npm test                  # 708 application tests
npm run test:db           # 348 database tests — NEEDS DOCKER RUNNING
npm run build
npm run test:e2e          # 6 browser tests, needs sandbox credentials
find .next/static -name '*.js.map'    # must be empty
```

If the database suite reports "Database is unavailable" across a whole file, the
container has stopped. `npm run db:up`, then wait for `pg_isready`. That is
environmental and has happened twice.

Operator tooling after anything touching storage:

```bash
npm run credentials:check
npm run credentials:encrypt         # dry run; every value encrypted
npm run db:backfill                 # dry run
npm run db:verify                   # no drift
npm run db:reconcile                # internal
npm run db:reconcile -- --provider  # one deliberate finding, see above
npm run funding:opening             # dry run; already-allocated is correct
npm run history:compare             # both stores agree
npm run e2e:cleanup                 # no residue
```

Then assert the database changed the way the phase intended. Every phase moves
or produces rows, and the rows are the evidence. A phase that leaves the tables
unchanged has not done its job, however green the suite is.

## The rule that matters most

Every change leaves a working, buildable application. Land beside the old path,
verify the new one agrees, cut over, then remove the old path. Do not delete an
Appwrite read until a PostgreSQL read has been proven to give the same answer —
that is how Phase 2 was done, and `npm run history:compare` exists because of it.
