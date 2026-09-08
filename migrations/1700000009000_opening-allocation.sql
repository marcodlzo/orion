-- Up Migration

-- An explicit, one-time opening allocation, and the equity account it comes
-- from.
--
-- WHY THIS SHAPE. A customer's ledger balance starts at zero and only ever
-- falls, because nothing credits it. Every transfer draws on
-- `credit_limit_minor`, which makes the pre-transfer check an in-flight
-- exposure cap rather than a solvency check.
--
-- The tempting fix is to read a Plaid balance and credit the ledger with it.
-- That would be a LIE. A Plaid balance is what the external bank says the
-- customer has THERE. It is not money Orion received, and posting it as though
-- it were claims a deposit that never happened.
--
-- So the credit is modelled as what it actually is: an OPENING ALLOCATION,
-- booked against an equity account, carrying its own provenance, and issued by
-- an operator rather than by a request. See
-- docs/adr/0002-cutover-accounting-model.md.
--
-- When real funding arrives — a confirmed inbound transfer — it uses this same
-- `source_reference` mechanism with a provider reference, and is distinguishable
-- from an allocation by its transaction kind.

-- ---------------------------------------------------------------------------
-- The equity side
-- ---------------------------------------------------------------------------

-- Entries must sum to zero, so a credit to a customer needs a matching debit
-- somewhere. It must NOT be the settlement account: that represents money in
-- flight to and from the provider, and mixing seeded capital into it would make
-- the settlement balance meaningless for reconciliation.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_known;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_known
    CHECK (kind IN ('customer', 'settlement', 'opening_equity'));

-- The kind also decides ownership: a customer account names a customer, a house
-- account does not. `opening_equity` is a house account, so this has to be
-- extended too — without it the new kind is rejected by a constraint that
-- predates it, which is the constraint doing its job.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_ownership_matches_kind;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_ownership_matches_kind
    CHECK (
        (kind = 'customer' AND customer_id IS NOT NULL)
        OR (kind IN ('settlement', 'opening_equity') AND customer_id IS NULL)
    );

-- One per currency, like the settlement account. `customer_id` is NULL for a
-- house account, and NULLs do not collide in the existing unique constraint, so
-- this needs its own partial index.
CREATE UNIQUE INDEX ledger_accounts_one_opening_equity_per_currency
    ON ledger_accounts (currency)
    WHERE kind = 'opening_equity';

-- ---------------------------------------------------------------------------
-- The posting
-- ---------------------------------------------------------------------------

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_known;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_known
    CHECK (kind IN ('settlement', 'reversal', 'opening_allocation'));

-- WHERE THIS MONEY CAME FROM, and what makes it repeat-proof.
--
-- For an opening allocation this is the reviewed snapshot it was derived from.
-- For real funding later it is the provider's own reference. Either way it is
-- the thing that makes a duplicate delivery produce ONE posting: the unique
-- index below decides, not application control flow.
ALTER TABLE ledger_transactions ADD COLUMN source_reference TEXT;

CREATE UNIQUE INDEX ledger_transactions_one_posting_per_source
    ON ledger_transactions (source_reference)
    WHERE source_reference IS NOT NULL;

-- An allocation names its source and belongs to no transfer. A settlement is
-- the other way round. Stating it as a constraint means a posting cannot be
-- created in a shape that later code would have to guess about.
ALTER TABLE ledger_transactions
    ADD CONSTRAINT ledger_transactions_allocation_names_its_source
    CHECK (
        kind <> 'opening_allocation'
        OR (source_reference IS NOT NULL AND transfer_id IS NULL)
    );

-- Down Migration
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_allocation_names_its_source;
DROP INDEX IF EXISTS ledger_transactions_one_posting_per_source;
ALTER TABLE ledger_transactions DROP COLUMN IF EXISTS source_reference;
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_kind_known;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_known
    CHECK (kind IN ('settlement', 'reversal'));
DROP INDEX IF EXISTS ledger_accounts_one_opening_equity_per_currency;
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_ownership_matches_kind;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_ownership_matches_kind
    CHECK (
        (kind = 'customer' AND customer_id IS NOT NULL)
        OR (kind = 'settlement' AND customer_id IS NULL)
    );
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_kind_known;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_known
    CHECK (kind IN ('customer', 'settlement'));
