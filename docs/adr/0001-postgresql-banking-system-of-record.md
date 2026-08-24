# 1. PostgreSQL becomes the banking system of record

- Status: accepted
- Date: 2026-08-24

## Context

The application inherited Appwrite as its only datastore. Appwrite holds the
user profile, the linked bank records, and the transaction history.

The audit established what that history actually is: a mutable display log. It
holds one row per transfer, with no balanced pair, no running balance, no
sequence, and no provider reference. Balances are not stored at all — they are
read live from Plaid on every page render, which means the balance shown and the
money moved are entirely decoupled.

Fixing that requires a ledger, and a correct ledger requires guarantees Appwrite's
document model does not offer:

- **Multi-row atomicity.** A double-entry posting writes a debit and a credit.
  Either both land or neither does. Appwrite has no transaction spanning two
  document writes, so a failure between them produces an unbalanced ledger, which
  is unrecoverable without reconciliation.
- **Unique constraints.** Idempotency needs a key that the datastore itself
  refuses to duplicate. An application-level check is a race, not a constraint.
- **Foreign keys and check constraints.** An entry referencing a non-existent
  account, or a currency the system does not support, must be impossible rather
  than merely unlikely.
- **Isolation levels and row locking.** Two concurrent transfers spending the
  same funds must serialise. Without `SELECT … FOR UPDATE` or serializable
  isolation, the only defence is optimism.

None of these are things a careful application layer can add on top. They are
properties of the store.

## Decision

**PostgreSQL becomes the banking system of record.** Ledger accounts, entries,
transfers, holds and idempotency keys will live there.

**Appwrite remains authentication infrastructure** during and after the
migration. It is a reasonable identity provider and replacing it is not on the
critical path for financial correctness.

Access is via `pg` (node-postgres) with explicit, reviewed SQL migrations. No
ORM. The reason is the same list above: the correctness properties we need are
expressed in transaction boundaries, isolation levels, lock modes and constraint
definitions. An ORM's value is hiding SQL, and here the SQL is the design.

**PostgreSQL does not depend on Appwrite's document model.** The relational
schema is designed for the banking domain. It stores identifiers that map to
Appwrite records; it does not mirror their shape.

### Money contract

Monetary columns will be `BIGINT` holding **integer minor units** (USD cents).
Never `REAL`, `DOUBLE PRECISION`, or an unconstrained `NUMERIC` — binary floating
point cannot represent most decimal fractions, and a ledger that drifts is
unrecoverable.

node-postgres returns `BIGINT` as a **string**, deliberately: a 64-bit integer
does not fit a JavaScript `number`. No parser override is registered, because
silently coercing would reintroduce the precision loss the money primitive exists
to prevent.

The boundary is therefore:

```
PostgreSQL BIGINT  →  string  →  readMoneyMinor()  →  Money.amountMinor
                                  range-checked
```

`readMoneyMinor` (`lib/db/pool.ts`) rejects any value outside
`Number.MAX_SAFE_INTEGER` rather than rounding it. That bound is roughly $90
trillion in cents; exceeding it means something is wrong, and a loud failure is
better than an approximately-correct balance.

## Consequences

**Positive**

- ACID transactions, so a double-entry posting is atomic
- Relational constraints make invalid financial state unrepresentable
- Explicit isolation levels and row locking, so concurrency can be tested
- Idempotency can rest on a unique index rather than a read-then-write race
- Reconciliation becomes possible once provider references are stored

**Tradeoffs**

- Two datastores during migration, with the operational and mental cost that
  carries
- An explicit identity mapping between Appwrite accounts and local customers —
  one more join, and one more thing that can drift
- Migration must be staged carefully; a half-migrated financial system is worse
  than either end state
- We now own database operations: backups, connection limits, upgrades

## Rejected alternatives

**Keep financial state solely in Appwrite.** Rejected because the guarantees a
ledger needs are absent, not merely inconvenient. The specific blocker is
multi-row atomicity: there is no way to write a balanced pair of entries such
that a crash between them is impossible. Every workaround is a reconciliation
process compensating for a missing transaction.

**Treat provider or browser state as balance authority.** This is what the
application does today — `getAccounts()` reads Plaid on every render. Rejected
because Plaid reports what a bank says about an external account, and Dwolla
reports what an ACH network did. Neither knows about money we have recorded but
not yet settled, holds we have placed, or transfers in flight. A provider is an
adapter to reconcile against, never the source of truth.

**A database per service, or microservices.** Rejected because there are no
service boundaries yet that would justify the cost. Distributed systems make
correctness *harder*: cross-service consistency would replace a local
transaction with a saga, which is strictly more machinery to get wrong. A
modular monolith with one transactional store is the simpler correct thing, and
extraction stays available if an operational reason ever appears.

## Status of this phase

Infrastructure and schema only. **No application traffic uses PostgreSQL.**
Signup still writes Appwrite, bank linking still writes Appwrite, and the
transfer path still reads Appwrite. There is no dual-write and no fallback —
"try Postgres, else Appwrite" would produce two partially-correct datasets and
hide which one is authoritative.

Data migration is a separate, deliberate phase.
