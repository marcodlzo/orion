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
| 2 | Authorization foundation — server-resolved identity, ownership checks, DTO boundary | next |
| 3 | Money primitives — integer minor units | |
| 4 | PostgreSQL introduction | |
| 5 | Immutable double-entry ledger | |
| 6 | Idempotency and server-side transfer orchestration | |
| 7 | Transfer state machine and provider webhooks | |
| 8 | Holds, available vs ledger balance, concurrency safety | |
| 9 | Reconciliation, audit trail, reversals | |
| 10 | Plaid sync rebuild — cursor persistence, full change handling | |
| 11 | UI rebuild | |

Deferred defects stay deferred until their milestone rather than being fixed
opportunistically. Some tests deliberately assert current defective behaviour so
that the milestone which fixes it can prove the change; those are named `DEFECT`
and carry an `AFTER` comment describing what replaces them.

## Stack

Next.js 14 (App Router) · React 18 · TypeScript 5 (`strict`) · Tailwind +
shadcn/ui · Appwrite · Plaid · Dwolla · Zod · Vitest

Appwrite currently provides authentication and storage. Financial state migrates
to PostgreSQL; Appwrite may remain authentication infrastructure.

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
npm test            # vitest
npm run build       # gates are on; a type or lint error fails the build
```

CI runs all four on every push and pull request, plus two security gates: a scan
of the client bundle for credential patterns including source maps, and an
assertion that no `.js.map` is served to clients.

## Security

See [SECURITY.md](SECURITY.md) — including a note on credentials present in the
preserved upstream baseline commit.

## Licence and attribution

MIT. Derived from [`adrianhajdin/banking`](https://github.com/adrianhajdin/banking)
by Adrian Hajdin / JS Mastery, whose copyright notice is retained in
[LICENSE](LICENSE). The first commit preserves that work unmodified so the
subsequent changes can be diffed against it.
