# 2. Accounting model for the PostgreSQL cutover

- Status: proposed; settlement and funding choices awaiting confirmation
- Date: 2026-09-09
- Implements: [PostgreSQL cutover plan](../cutover-plan.md)

## Context

The existing ledger records a sender debit and a house-account credit. It has
one customer account per currency, not one account per linked external bank.
The current exposure allowance permits transfers without a funded ledger.
Plaid reports external bank balances; it does not establish that Orion received
a deposit. The current transfer table also lacks the recipient and bank
references needed to render incoming history or post a recipient credit.

## Proposed settlement decision

For new internal transfers, store both customer references and both linked-bank
references with the durable claim. Resolve these from authenticated ownership
and the server-resolved recipient before calling Dwolla.

On a verified completion event, post `sender -amount` and `recipient +amount`
in the same transaction as settlement and hold capture. Preserve the existing
signed-value convention. A return reverses those exact original entries; it
does not recompute the destination from current bank ownership.

Transfers between two external accounts owned by the same customer require
explicit handling: they move funds between banks but do not change the customer's
aggregate internal position. The posting must not fabricate income.

Keep the house account for external funding and withdrawals. Preserve the old
transfer's posting under an explicit legacy accounting model. Do not change,
delete, or automatically reverse historical entries during schema migration.
The deliberately injected settlement/provider-pending discrepancy stays visible.

## Funding choice requiring confirmation

Recommended: keep external bank balances separate from internal ledger funds.
An explicit funding posting must have a durable, unique source reference,
currency, amount, customer, and provenance. Duplicate delivery must produce one
posting. Provider-confirmed funding and a sandbox opening allocation must be
distinguishable. A Plaid balance refresh is never itself a repeatable deposit.

Alternative for this sandbox: import a one-time opening allocation from a
reviewed Plaid snapshot, paired with a house opening-equity account. Enforce
uniqueness for the opening import and retain its source and timestamp. Never
silently refresh or add the full balance again, and do not describe this
allocation as provider-confirmed money held by Orion.

Do not reduce the existing credit allowance or replace displayed bank balances
until the selected funding model has been tested and reconciled. The allowance
must remain separately labelled; it is not cash.

## Migration order and guards

1. Add durable parties, bank references, note, and accounting-model provenance
   before changing postings. This is a prerequisite within Phase 1, even though
   the original plan groups history columns under Phase 2.
2. Backfill history in a dry-run-first operator tool. Legacy Appwrite records
   contain neither the PostgreSQL transfer ID nor the idempotency key. Repeated
   identical transfers therefore cannot be matched by amount and timestamp
   alone. Refuse ambiguous matches; require an explicit reviewed mapping.
3. Verify sender and recipient history independently, including amount, direction,
   note, date, status, merged Plaid history, and stable sort order. Continue the
   legacy write until the new read passes comparison.
4. Present customer-level internal funds separately from per-bank external
   balances. Do not copy a customer's aggregate ledger balance onto every card
   or sum it once per linked bank.
5. Migrate credentials into a dedicated PostgreSQL credential table so
   `linked_accounts` remains metadata-only. Re-encrypt using the target record
   and field binding, verify decrypted equality without printing values, then
   switch the runtime storage boundary. No plaintext fallback or mixed-store
   runtime fallback.

Every new request-reachable repository must be listed explicitly by the
architecture tests. Ownership stays in SQL predicates. Reconciliation remains
read-only. No cursor advances on a render path, and no financial migration
rewrites the original ledger entries.
