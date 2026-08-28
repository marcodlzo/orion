-- Up Migration

-- The immutable double-entry ledger.
--
-- This is the system of record for internal money. Everything before it was
-- identity, linkage, or a record of what a provider was asked to do; this is
-- the first thing that says who owns what.
--
-- THE INVARIANTS LIVE IN THE SCHEMA, NOT IN APPLICATION CODE. Balance,
-- immutability and conservation are enforced by constraints and triggers, so a
-- bug in a repository, a migration script, or a psql session cannot violate
-- them. Application-level checks protect only the paths that remember to run
-- them.

-- ---------------------------------------------------------------------------
-- ledger_accounts
--
-- Internal accounts. NOT the same thing as linked_accounts: that table records
-- an external provider connection, this one records a place money can sit.
--
-- `kind` distinguishes the two halves of double entry. A customer account is a
-- liability — the money is theirs, we merely hold it — and the settlement
-- account is the asset side facing the provider. Getting these backwards is the
-- classic first ledger bug, so the sign convention is written down below and
-- tested.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_accounts (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL for house accounts, which belong to no customer.
    customer_id   UUID        REFERENCES banking_customers (id) ON DELETE RESTRICT,

    kind          TEXT        NOT NULL,
    currency      CHAR(3)     NOT NULL DEFAULT 'USD',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ledger_accounts_kind_known
        CHECK (kind IN ('customer', 'settlement')),

    CONSTRAINT ledger_accounts_currency_supported
        CHECK (currency = 'USD'),

    -- A customer account has an owner; a house account must not.
    CONSTRAINT ledger_accounts_ownership_matches_kind
        CHECK (
            (kind = 'customer'   AND customer_id IS NOT NULL) OR
            (kind = 'settlement' AND customer_id IS NULL)
        ),

    -- One customer account per customer per currency. Two would let a balance
    -- be correct in aggregate while wrong everywhere it is read.
    CONSTRAINT ledger_accounts_one_per_customer
        UNIQUE (customer_id, currency)
);

-- UNIQUE permits many NULLs in PostgreSQL, so the constraint above says nothing
-- at all about house accounts — two settlement accounts could exist and money
-- would silently split between them. A partial index is what actually enforces
-- "exactly one".
CREATE UNIQUE INDEX ledger_accounts_one_settlement_per_currency
    ON ledger_accounts (currency)
    WHERE kind = 'settlement';

COMMENT ON TABLE ledger_accounts IS
    'Internal accounts money can sit in. Carries no balance column: a balance is derived from entries, never stored.';

-- Deliberately no `balance` column. A stored balance is a second source of
-- truth that drifts from the entries the moment anything goes wrong, and the
-- drift is silent. Balance is SUM(amount_minor), always.

-- ---------------------------------------------------------------------------
-- ledger_transactions
--
-- The grouping every entry belongs to. Exists so "balanced" has something to be
-- true OF: entries balance within a transaction, not globally.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_transactions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The transfer that caused this, when there was one. UNIQUE: one transfer
    -- posts to the ledger exactly once, which is what stops a retry from
    -- double-posting even if every layer above fails.
    transfer_id UUID        REFERENCES transfers (id) ON DELETE RESTRICT,

    description TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ledger_transactions_one_posting_per_transfer
        UNIQUE (transfer_id),

    CONSTRAINT ledger_transactions_description_not_blank
        CHECK (length(btrim(description)) > 0)
);

COMMENT ON COLUMN ledger_transactions.transfer_id IS
    'UNIQUE: a transfer posts to the ledger at most once. This is the last defence against a double post.';

-- ---------------------------------------------------------------------------
-- ledger_entries
--
-- Signed integer minor units. A debit is positive, a credit is negative, and a
-- transaction balances when its entries sum to ZERO.
--
-- Signed amounts rather than an amount plus a direction column, deliberately:
-- "sum to zero" is then a single arithmetic fact PostgreSQL can check, instead
-- of a rule application code has to apply consistently in every query.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    transaction_id UUID        NOT NULL
        REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    account_id     UUID        NOT NULL
        REFERENCES ledger_accounts (id) ON DELETE RESTRICT,

    -- Positive debit, negative credit. Never zero: an entry that moves nothing
    -- is noise in an immutable record.
    amount_minor   BIGINT      NOT NULL,
    currency       CHAR(3)     NOT NULL DEFAULT 'USD',

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ledger_entries_amount_nonzero
        CHECK (amount_minor <> 0),

    CONSTRAINT ledger_entries_currency_supported
        CHECK (currency = 'USD')
);

COMMENT ON TABLE ledger_entries IS
    'Immutable double-entry lines. Positive is a debit, negative a credit; a transaction sums to zero. UPDATE and DELETE are rejected by trigger.';

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

-- ---------------------------------------------------------------------------
-- IMMUTABILITY
--
-- A posted entry is never updated and never deleted. Correcting a mistake means
-- posting a compensating entry, which leaves both the error and the correction
-- visible — that is the entire reason a ledger is append-only.
--
-- Enforced by trigger rather than by permissions so it holds for every role,
-- including the owner and anything a migration runs as.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger_entries_are_immutable() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'ledger_entries is append-only: % rejected. Post a compensating entry instead.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
    BEFORE UPDATE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_immutable();

CREATE TRIGGER ledger_entries_no_delete
    BEFORE DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_are_immutable();

-- ---------------------------------------------------------------------------
-- BALANCE
--
-- Every transaction's entries must sum to zero, and there must be at least two
-- of them.
--
-- A CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, so the check runs at
-- COMMIT rather than after each row. A per-row check would make a balanced pair
-- impossible to insert: the first entry is always unbalanced on its own.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger_transaction_must_balance() RETURNS TRIGGER AS $$
DECLARE
    entry_count INTEGER;
    net         BIGINT;
    txn         UUID;
BEGIN
    txn := COALESCE(NEW.transaction_id, OLD.transaction_id);

    SELECT count(*), COALESCE(sum(amount_minor), 0)
      INTO entry_count, net
      FROM ledger_entries
     WHERE transaction_id = txn;

    -- A transaction with no entries at all is a transaction that was rolled
    -- back or never posted; nothing to check.
    IF entry_count = 0 THEN
        RETURN NULL;
    END IF;

    IF entry_count < 2 THEN
        RAISE EXCEPTION
            'ledger transaction % has % entry: double entry requires at least two',
            txn, entry_count
            USING ERRCODE = 'check_violation';
    END IF;

    IF net <> 0 THEN
        RAISE EXCEPTION
            'ledger transaction % does not balance: entries sum to % minor units',
            txn, net
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balance
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_transaction_must_balance();

CREATE TRIGGER ledger_accounts_set_updated_at
    BEFORE UPDATE ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS ledger_accounts_set_updated_at ON ledger_accounts;
DROP TRIGGER IF EXISTS ledger_entries_balance ON ledger_entries;
DROP TRIGGER IF EXISTS ledger_entries_no_delete ON ledger_entries;
DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
DROP FUNCTION IF EXISTS ledger_transaction_must_balance();
DROP FUNCTION IF EXISTS ledger_entries_are_immutable();
DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS ledger_transactions;
DROP INDEX IF EXISTS ledger_accounts_one_settlement_per_currency;
DROP TABLE IF EXISTS ledger_accounts;
