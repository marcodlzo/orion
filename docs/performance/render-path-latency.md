# Render-path latency: why switching tabs is slow

Measured 2026-09-05 against the live development stack (Appwrite Cloud, Plaid
sandbox, local PostgreSQL) with the account that owns two linked banks.

**Finding: a single page navigation performs 7.5 to 12 seconds of server work.**
Almost none of it is compilation, rendering, or bundle size. It is network round
trips, most of which are redundant.

---

## 1. Measured latency per dependency

Median of five calls, from this machine.

| Dependency | Median round trip |
|---|---|
| Appwrite Cloud (one query) | 427 ms |
| Plaid sandbox (`accountsGet`) | 504 ms |
| PostgreSQL (local Docker) | 1 ms |

PostgreSQL is three orders of magnitude faster than the two hosted services,
because it is local. Everything below is a consequence of that gap: the pages are
slow in proportion to how many times they cross the network to Appwrite and
Plaid.

## 2. Measured cost of one navigation

Replaying the exact server work `transaction-history` performs, three runs:

| Step | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `requireActor()` (one of four) | 2163 ms | 644 ms | 1516 ms |
| `getOwnedBanks` | 878 ms | 265 ms | 267 ms |
| Plaid `accountsGet` x2, parallel | 1270 ms | 1704 ms | 1482 ms |
| `getOwnedBankByDocumentId` | 326 ms | — | — |
| Plaid `accountsGet` x1 | 430 ms | — | — |
| `getTransactionsForOwnedBank` | 1466 ms | 2128 ms | 648 ms |
| `listTransactionsForOwnedAccounts` (PostgreSQL) | 55 ms | — | — |
| **Page body total, serial** | **11996 ms** | **7469 ms** | **8545 ms** |

Variance is high because every line except the last is a hosted-service round
trip.

## 3. Root causes, in order of cost

### 3.1 `requireActor()` runs four times per render

Each call is **two** Appwrite round trips: `account.get()` to resolve the
session, then `findUserByAuthId()` to load the user document. Nothing caches or
deduplicates it.

Per navigation it is called by:

1. `getLoggedInUser()` in `app/(root)/layout.tsx`
2. `getLoggedInUser()` again in the page component
3. `getAccounts()` in `lib/server/banks.ts`
4. `getAccount()` in `lib/server/banks.ts`

That is **eight Appwrite round trips to answer "who is this?" four times**, for a
value that cannot change during a single render.

### 3.2 `getLoggedInUser()` loads the user document twice

`requireActor()` already fetches the user document and then discards everything
but three fields. `getLoggedInUser()` immediately calls `findUserByAuthId()`
again for the same document.

So `getLoggedInUser()` costs **three** Appwrite round trips where one plus a
session check would do. It is called twice per navigation, once by the layout and
once by the page, which is itself the next problem.

### 3.3 Every page calls `getLoggedInUser()` after the layout already did

`app/(root)/layout.tsx` calls it, then all four pages call it again. The layout's
result is not passed down and not shared. Six Appwrite round trips per
navigation, for one answer.

### 3.4 `getAccounts()` and `getAccount()` fetch the same Plaid data twice

`getAccounts()` calls `accountsGet` for every linked bank, which returns **all**
accounts on each Item. `getAccount()` then calls `accountsGet` again for one of
those same banks and picks one account out of the response it already had.

The two run sequentially, so this is a second Plaid wave that could be zero
calls.

### 3.5 Nothing is cached, anywhere

There is no `React.cache()`, no `unstable_cache`, no `revalidate`, and no
`Promise.all` across the independent steps. Every navigation re-does the full
sequence from cold.

### 3.6 Live Plaid balances are on the render path

`accountsGet` exists to show a current balance. It is a provider round trip per
linked bank per page view. This is the one item on this list that is a product
decision rather than a straightforward defect, and it is discussed in section 5.

---

## 4. Recommended fixes, ranked by benefit against risk

### Fix 1 — Deduplicate `requireActor()` with React `cache()`

**Effort: one line. Expected saving: roughly 6 of 8 Appwrite round trips, about
2.5 to 4 seconds.**

```ts
import { cache } from "react";

export const requireActor = cache(async function requireActor(): Promise<Actor> {
  // unchanged body
});
```

**This is per-request memoisation, not caching.** React's `cache()` is scoped to
a single server render pass and is discarded afterwards, so there is no staleness
window and no cross-user leakage: two concurrent requests get separate caches.
Identity is still resolved from the session cookie on every request.

Verify this property holds before relying on it, because the whole security model
depends on identity being per-request.

### Fix 2 — Stop `getLoggedInUser()` re-fetching the user document

**Effort: small. Expected saving: about 850 ms per call, twice per navigation.**

`requireActor()` already has the document. Either have it return the document
alongside the identity, or wrap `findUserByAuthId` in `cache()` so the second
call is free. The second option is smaller and does not change any signature.

### Fix 3 — Wrap the read helpers in `cache()` too

**Effort: small. Expected saving: the duplicate Plaid wave, about 500 ms.**

`getAccounts`, `getOwnedBanks`, and `getLoggedInUser` are all called more than
once per render with identical arguments. The same per-request memoisation
applies.

### Fix 4 — Have the page make one pass instead of two

**Effort: medium. Expected saving: one Plaid wave plus one Appwrite query.**

`getAccount()` re-derives data `getAccounts()` already fetched. Restructure so
the page resolves the account list once and selects from it, rather than issuing
a second lookup for a member of a set it already holds.

Watch the ownership check while doing this. `getAccount()` currently proves
ownership through `getOwnedBankByDocumentId`, and the `appwriteItemId` it takes
comes from a URL query parameter. Any restructure must keep that check, and must
not start trusting the URL parameter because the list happens to have been
fetched for the right actor.

### Fix 5 — Parallelise what remains

**Effort: small.**

After the above, the surviving independent calls should run under `Promise.all`
rather than sequential `await`s.

---

## 5. What NOT to do

These are constraints from the project's rules, not preferences. Breaking one of
them trades a visible slowness for an invisible correctness bug.

- **Do not cache balances across requests without deciding the staleness budget.**
  Per-request memoisation is free and safe. Cross-request caching means showing
  a figure that may be wrong, which is a product decision about a banking
  interface, not a performance tweak.

- **Do not move balance fetching into the Plaid sync store as a quick fix.** An
  architecture test asserts the render path reaches no module that advances a
  cursor. A page load that advances sync state lets two concurrent renders race
  the same Item. Doing this properly is a milestone.

- **Do not cache `requireActor()` across requests.** Per-render only. Identity
  must be resolved from the session on every request.

- **Do not remove the ownership check** in `getOwnedBankByDocumentId` while
  restructuring, and do not replace it with a filter applied after a broader
  read.

- **Do not add a second reader of the credential encryption keys.** Bank records
  are decrypted at the repository boundary. Any new read path goes through it.

---

## 6. What is not the problem

Ruled out by measurement, so that effort is not spent here:

- **PostgreSQL.** One millisecond per query. The ledger, holds, rate limits and
  the synced transaction store contribute nothing measurable.
- **Bundle size or client rendering.** The largest route is 20.6 kB with a 253 kB
  first load, which is unremarkable. The delay is server-side, before any HTML
  is sent.
- **The rate limiter.** It adds one local PostgreSQL upsert, about 1 ms, and only
  on the five limited actions. Page renders are not limited at all.

---

## 7. Suggested order of work

1. Fix 1, then re-measure. It is one line and should be the largest single win.
2. Fix 2 and Fix 3 together, then re-measure.
3. Fix 4 only after the first three, since it is the only one that changes
   control flow and touches an ownership check.
4. Leave Fix 5 until last; it matters least once the redundant calls are gone.

Re-measure after each step rather than at the end. The variance between runs is
large enough that a change worth 400 ms cannot be distinguished from noise in a
single sample. Take a median of at least five.
