-- Up Migration

-- Holds, and the distinction between a LEDGER balance and an AVAILABLE balance.
--
-- Until now nothing stood between a transfer request and the provider call. Two
-- requests arriving together both saw the same world and both proceeded: there
-- was no record of money committed but not yet moved, so there was nothing for a
-- second request to notice.
--
-- A hold is that record. It is placed BEFORE the provider is called, it reduces
-- what is available without touching the ledger balance, and it is resolved —
-- captured or released — in the same transaction as the transfer's terminal
-- state. The ledger balance still changes only when money actually moves.

-- ---------------------------------------------------------------------------
-- ledger_accounts.credit_limit_minor
--
-- HOW FAR BELOW ZERO AN ACCOUNT'S AVAILABLE BALANCE MAY GO, as a positive
-- magnitude.
--
-- What this is honestly measuring today: a cap on how much one customer may
-- have COMMITTED AND UNSETTLED at once. It is not a bank-balance check and must
-- not be described as one — this system does not know what is in anyone's bank
-- account. Plaid balances are Milestone 10; when they land, this same check
-- becomes a real solvency check without changing shape.
--
-- No DEFAULT once the existing rows are filled: an account's limit is a
-- decision, and a column with a default is how an account silently acquires one.
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_accounts
    ADD COLUMN credit_limit_minor BIGINT NOT NULL DEFAULT 0;

-- Existing customer accounts get the standing policy value; the settlement
-- account keeps 0 and is constrained to it below.
UPDATE ledger_accounts
   SET credit_limit_minor = 500000
 WHERE kind = 'customer';

ALTER TABLE ledger_accounts
    ALTER COLUMN credit_limit_minor DROP DEFAULT;

ALTER TABLE ledger_accounts
    ADD CONSTRAINT ledger_accounts_credit_limit_not_negative
        CHECK (credit_limit_minor >= 0),

    -- The house account is never the subject of a hold, so its limit is never
    -- consulted. Pinning it to 0 means that if one is ever placed against it,
    -- the attempt fails loudly instead of quietly drawing on an allowance
    -- nobody granted.
    ADD CONSTRAINT ledger_accounts_only_customers_have_credit
        CHECK (kind = 'customer' OR credit_limit_minor = 0);

COMMENT ON COLUMN ledger_accounts.credit_limit_minor IS
    'How far below zero available balance may go, as a positive magnitude. Today this caps committed-but-unsettled exposure; it is NOT a bank-balance check.';

-- ---------------------------------------------------------------------------
-- ledger_holds
--
-- One hold per transfer, enforced by UNIQUE. A re-drive of an in-flight
-- transfer must find the hold it already placed rather than placing a second —
-- two holds for one transfer would reserve the money twice and refuse a
-- transfer the customer could actually afford.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_holds (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id      UUID        NOT NULL REFERENCES ledger_accounts (id),

    -- The transfer this hold reserves funds for. UNIQUE: see above.
    transfer_id     UUID        NOT NULL REFERENCES transfers (id),

    -- A POSITIVE MAGNITUDE, unlike a ledger entry, which is signed. A hold has
    -- no direction: it reserves, it does not move. Storing it signed would
    -- invite it being summed together with entries, which would be wrong in
    -- both directions.
    amount_minor    BIGINT      NOT NULL,

    currency        TEXT        NOT NULL DEFAULT 'USD',

    state           TEXT        NOT NULL DEFAULT 'active',

    placed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,

    CONSTRAINT ledger_holds_amount_positive
        CHECK (amount_minor > 0),

    CONSTRAINT ledger_holds_currency_supported
        CHECK (currency = 'USD'),

    CONSTRAINT ledger_holds_state_known
        CHECK (state IN ('active', 'captured', 'released')),

    -- An active hold has not been resolved; a resolved one says when.
    CONSTRAINT ledger_holds_resolved_matches_state
        CHECK ((state = 'active') = (resolved_at IS NULL)),

    CONSTRAINT ledger_holds_one_per_transfer
        UNIQUE (transfer_id)
);

COMMENT ON TABLE ledger_holds IS
    'Funds committed but not yet moved. Reduces available balance without touching the ledger balance. Exactly one per transfer.';

-- The index that makes the availability read cheap, and says what the hot query
-- is: the active holds on one account.
CREATE INDEX ledger_holds_active_by_account_idx
    ON ledger_holds (account_id)
    WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- The hold state machine, enforced by the database
--
-- A hold is not immutable — it is meant to transition — but WHAT may change is
-- fixed. Rewriting an amount or moving a hold to another account would let a
-- reservation be edited after the decision it justified was already made.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_holds_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.account_id  IS DISTINCT FROM OLD.account_id
    OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency    IS DISTINCT FROM OLD.currency
    OR NEW.placed_at   IS DISTINCT FROM OLD.placed_at THEN
        RAISE EXCEPTION
            'ledger_holds: only state and resolved_at may change (hold %)', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- One-way door. A captured hold that could go back to active would let the
    -- same money be reserved again after it had already been spent.
    IF OLD.state <> 'active' AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION
            'ledger_holds: hold % is already %, it cannot become %',
            OLD.id, OLD.state, NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER ledger_holds_guard_update
    BEFORE UPDATE ON ledger_holds
    FOR EACH ROW EXECUTE FUNCTION ledger_holds_guard_update();

CREATE OR REPLACE FUNCTION ledger_holds_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_holds is append-only: hold % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER ledger_holds_no_delete
    BEFORE DELETE ON ledger_holds
    FOR EACH ROW EXECUTE FUNCTION ledger_holds_no_delete();

-- Down Migration
DROP TRIGGER IF EXISTS ledger_holds_no_delete ON ledger_holds;
DROP FUNCTION IF EXISTS ledger_holds_no_delete();
DROP TRIGGER IF EXISTS ledger_holds_guard_update ON ledger_holds;
DROP FUNCTION IF EXISTS ledger_holds_guard_update();
DROP TABLE IF EXISTS ledger_holds;
ALTER TABLE ledger_accounts
    DROP CONSTRAINT IF EXISTS ledger_accounts_only_customers_have_credit,
    DROP CONSTRAINT IF EXISTS ledger_accounts_credit_limit_not_negative,
    DROP COLUMN IF EXISTS credit_limit_minor;
