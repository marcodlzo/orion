# Orion Banking

A correctness-first digital banking platform, built by systematically dismantling
and rebuilding a tutorial application.

Orion starts from [`adrianhajdin/banking`](https://github.com/adrianhajdin/banking)
("Horizon") — a well-known Next.js banking tutorial that connects Plaid and
Dwolla to move money between users. The tutorial works. It is also, as an
engineering artefact, unsafe: it has no authorization on its server actions, no
ledger, no idempotency, and no tests.

This repository is the record of turning it into something that could survive
contact with real money.

> **Sandbox only.** This project uses Plaid and Dwolla sandbox environments and
> is not connected to any real financial institution. It is not a licensed
> money transmitter and moves no real funds.

---

## Why this exists

Most portfolio banking apps stop at "it renders a balance and calls an API."
The interesting problems in financial software are the ones that only appear
under failure: what happens on a double-click, on a timeout, when the provider
succeeds but your database write fails, when two transfers race for the same
funds.

Orion is an attempt to take those seriously, starting from a codebase that
does not.

## The audit

Before changing anything, the inherited code was audited in full. Findings that
drive the roadmap:

**Authorization** — 20 of 22 server actions authenticate with the Appwrite admin
key, accept a client-supplied identifier, and return the matching record without
checking who is asking. The only authorization control in the application is a
`redirect()` in a layout, which gates page rendering and nothing else. A server
action is a public POST endpoint; a layout cannot defend it.

**Money movement** — transfers are orchestrated from the browser across four
separate server actions. The submit button has no disabled state, so a
double-click sends two transfers. There are no idempotency keys. The Dwolla
transfer URL is discarded, so no local record can ever be reconciled against the
provider.

**No ledger** — the transaction collection is a mutable display log. Balances are
read live from Plaid on every page render, which means the balance shown and the
money moved are entirely decoupled. Amounts are JavaScript floats and strings.

**Transaction status is invented** — status is derived from a timestamp: under
two days old reads "Processing", older reads "Success". A failed transfer
displays as successful after 48 hours.

**Plaid sync is broken** — `transactionsSync` is called with no cursor inside a
`while (has_more)` loop that overwrites its results each pass. It is
simultaneously an infinite-loop hazard and a data-loss bug. `modified` and
`removed` are ignored entirely.

**Credentials and PII** — four live Plaid sandbox tokens were committed to source
and remained readable in a served `.js.map` even after tree-shaking removed them
from the emitted JavaScript. SSN and date of birth are stored in plaintext and
serialized into the RSC payload delivered to the browser on every authenticated
page.

**Quality gates** — `ignoreBuildErrors` and `ignoreDuringBuilds` were both
enabled, which is how five type errors shipped.

## Direction of travel

- **The internal ledger becomes the system of record.** Double-entry, immutable
  entries, integer minor units. PostgreSQL owns financial state.
- **Plaid and Dwolla are adapters**, never the source of truth. Provider types
  stop at the adapter boundary.
- **The browser submits intent; the server orchestrates.** One call in, one
  result out, with authorization, idempotency and ledger write inside a single
  server-side transaction.
- **Every financial record has an explicit lifecycle.** `requested → authorized →
  submitted → pending → settled | failed | returned | reversed`. Never inferred
  from a clock.
- **Modular monolith.** No microservices for appearance.
- **Every change leaves a working, buildable application.**

## Roadmap

| # | Milestone | Status |
|---|---|---|
| 0 | Secure buildable baseline — credentials removed, quality gates restored | done |
| 1 | Test harness and CI | done |
| 2 | Authorization foundation — server-resolved identity, ownership checks, DTO boundary | done |
| 3 | Money primitives — integer minor units | done |
| 4 | PostgreSQL introduction — schema, migrations, backfill, verifier | done |
| 5 | Idempotency and durable transfer records | done |
| 6 | Immutable double-entry ledger | done |
| 7 | Transfer state machine and provider webhooks | done |
| 8 | Holds, available vs ledger balance, concurrency safety | done |
| 9 | Reconciliation, audit trail, reversals | done |
| 10 | Plaid sync rebuild — cursor persistence, full change handling | done |
| 11 | UI rebuild | next |

**Milestone 2** shrank the server-action surface from 24 exports to 7, moved
identity resolution into the session, pushed ownership checks into the
repositories, stopped persisting SSN and date of birth, and put transfer
orchestration behind a single server-owned endpoint.

**Milestone 4** built the Appwrite → PostgreSQL migration engine: schema,
migrations, idempotent repositories, a backfill whose dry run is a real
transaction that rolls back, and an independent verifier. PostgreSQL is
**populated but not authoritative** — every request path still reads and writes
Appwrite, and an import-boundary test proves a cutover cannot happen by
accident. Doing it on purpose is blocked on encrypting provider credentials.

**Milestone 5** made `initiateTransfer` idempotent. A client-generated key is
claimed in PostgreSQL and committed *before* Dwolla is called, so a process that
dies mid-flight leaves evidence and the retry returns the original result
instead of moving money twice. The Dwolla reference — previously discarded — is
now stored, which is what makes reconciliation possible at all.

This is the first table a request path writes to. The boundary was opened for
that one route and is pinned by an allowlist; a second crossing fails the
architecture suite.

Idempotency and the ledger swapped places: a ledger that can double-post is
worse than no ledger, so the key came first.

Deferred defects stay deferred until their milestone rather than being fixed
opportunistically. Some tests deliberately assert current defective behaviour so
that the milestone which fixes it can prove the change; those are named `DEFECT`
and carry an `AFTER` comment describing what replaces them.

## Stack

Next.js 14 (App Router) · React 18 · TypeScript 5 (`strict`) · Tailwind +
shadcn/ui · Appwrite · **PostgreSQL 16** (`pg`, `node-pg-migrate`, Docker) ·
Plaid · Dwolla · Zod · Vitest

Appwrite currently provides authentication and storage, and remains the runtime
source for every request path. PostgreSQL holds the migrated identity and
linkage map and will own financial state; Appwrite may remain authentication
infrastructure after cutover.

## Running locally

```bash
npm install
cp .env.example .env.local   # then fill in — see .gitignore for guidance
npm run dev
```

Requires Appwrite, Plaid sandbox and Dwolla sandbox credentials. The app will
not start without them. `.env.local` is gitignored; `.env.example` is a
placeholder template and must never contain a real value.

```bash
npm run typecheck   # tsc --noEmit, must be 0 errors
npm run lint        # must be clean
npm test            # vitest — unit and integration, no database required
npm run build       # gates are on; a type or lint error fails the build
```

Database work needs Docker:

```bash
npm run db:up       # PostgreSQL 16 via docker compose
npm run db:migrate  # apply migrations to DATABASE_URL
npm run test:db     # integration tests — REQUIRES TEST_DATABASE_URL
```

`test:db` requires `TEST_DATABASE_URL` and never falls back to `DATABASE_URL`.
These suites `TRUNCATE`, so an unset variable stops the run rather than picking
a target; it also refuses when both variables resolve to the same database, or
when the name does not end in `_test`.

Operator-only, never reachable from the application:

```bash
npm run db:backfill                                  # dry run (the default)
npm run db:backfill:commit -- --expect-source=<digest>
npm run db:verify
```

The dry run writes nothing and prints a source digest; the commit requires that
digest and refuses if the source changed in between.

CI runs every gate above on each push and pull request — typecheck, lint, unit
tests, migrations applied to a **freshly created empty database**, the full
`test:db` suite, and the build — plus three security gates: a scan of the client
bundle for credential patterns including source maps, an assertion that no
provider credential name appears in client output, and an assertion that no
`.js.map` is served to clients.

## Security

See [SECURITY.md](SECURITY.md) — including a note on credentials present in the
preserved upstream baseline commit.

## Licence and attribution

MIT. Derived from [`adrianhajdin/banking`](https://github.com/adrianhajdin/banking)
by Adrian Hajdin / JS Mastery, whose copyright notice is retained in
[LICENSE](LICENSE). The first commit preserves that work unmodified so the
subsequent changes can be diffed against it.
