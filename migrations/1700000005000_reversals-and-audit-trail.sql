-- Up Migration

-- Reversals, and an audit trail of every transfer state change.
--
-- TWO EXISTING CONSTRAINTS BLOCKED REVERSAL, AND THEY WERE RIGHT TO. The state
-- machine had no `reversed`, and `ledger_transactions` allowed one posting per
-- transfer. Both were correct for a system that could not reverse anything, and
-- both have to be widened deliberately rather than worked around — which is the
-- whole reason they were written as constraints.
--
-- A REVERSAL IS NEW OPPOSING ENTRIES, NEVER AN EDIT. Ledger entries already
-- reject UPDATE and DELETE, so compensation is the only mechanism the schema
-- permits. That is not a coincidence to route around; it is the design.

-- ---------------------------------------------------------------------------
-- ledger_transactions: what a posting IS
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_transactions
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'settlement',

    -- The posting this one compensates. UNIQUE: a posting is reversed at most
    -- once, which is what stops a redelivered return from compensating twice
    -- and handing the money back a second time.
    ADD COLUMN reverses_transaction_id UUID
        REFERENCES ledger_transactions (id) ON DELETE RESTRICT;

-- Existing rows are all settlements; from here on a caller must say which.
ALTER TABLE ledger_transactions
    ALTER COLUMN kind DROP DEFAULT;

ALTER TABLE ledger_transactions
    ADD CONSTRAINT ledger_transactions_kind_known
        CHECK (kind IN ('settlement', 'reversal')),

    -- A reversal names what it reverses; a settlement reverses nothing. Without
    -- this a reversal could exist with nothing to compensate, which is just an
    -- unexplained pair of entries.
    ADD CONSTRAINT ledger_transactions_reversal_names_its_original
        CHECK ((kind = 'reversal') = (reverses_transaction_id IS NOT NULL)),

    ADD CONSTRAINT ledger_transactions_one_reversal_per_posting
        UNIQUE (reverses_transaction_id);

-- The old constraint said "one posting per transfer" and blocked the reversal
-- along with the double post. Replaced by one that still says a transfer SETTLES
-- exactly once, while allowing the compensating posting that undoes it.
ALTER TABLE ledger_transactions
    DROP CONSTRAINT ledger_transactions_one_posting_per_transfer;

CREATE UNIQUE INDEX ledger_transactions_one_settlement_per_transfer
    ON ledger_transactions (transfer_id)
    WHERE kind = 'settlement' AND transfer_id IS NOT NULL;

COMMENT ON COLUMN ledger_transactions.transfer_id IS
    'A transfer SETTLES at most once (partial unique index on kind = settlement). A reversal posts against the same transfer and is itself unique per original.';

-- A reversal must not point at another reversal: compensating a compensation is
-- a re-settlement, and calling it a reversal would make the audit trail lie
-- about which direction the money went.
CREATE OR REPLACE FUNCTION ledger_transactions_guard_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    original_kind TEXT;
BEGIN
    IF NEW.reverses_transaction_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT kind INTO original_kind
      FROM ledger_transactions
     WHERE id = NEW.reverses_transaction_id;

    IF original_kind <> 'settlement' THEN
        RAISE EXCEPTION
            'ledger_transactions: only a settlement may be reversed (% is %)',
            NEW.reverses_transaction_id, original_kind
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER ledger_transactions_guard_reversal
    BEFORE INSERT OR UPDATE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION ledger_transactions_guard_reversal();

-- ---------------------------------------------------------------------------
-- transfers: the `reversed` state
-- ---------------------------------------------------------------------------
ALTER TABLE transfers
    ADD COLUMN reversed_at TIMESTAMPTZ;

ALTER TABLE transfers
    DROP CONSTRAINT transfers_state_known,
    ADD CONSTRAINT transfers_state_known
        CHECK (state IN ('requested', 'submitted', 'settled', 'failed',
                         'returned', 'reversed'));

-- `settled_at` records WHEN THE TRANSFER SETTLED, and a reversed transfer did
-- settle — that is the entire premise of reversing it. The old constraint tied
-- the timestamp to the CURRENT state, which would now reject the very row this
-- milestone exists to create. Corrected rather than dropped: the timestamp is
-- still required exactly when it is meaningful, and still forbidden when it is
-- not.
ALTER TABLE transfers
    DROP CONSTRAINT transfers_settled_has_timestamp,
    ADD CONSTRAINT transfers_settled_has_timestamp
        CHECK ((state IN ('settled', 'reversed')) = (settled_at IS NOT NULL)),

    ADD CONSTRAINT transfers_reversed_has_timestamp
        CHECK ((state = 'reversed') = (reversed_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- transfer_state_transitions — the audit trail
--
-- WRITTEN BY A TRIGGER, NOT BY THE APPLICATION. An audit trail the code has to
-- remember to append to is one that is complete until the day somebody adds a
-- code path and forgets. This one records every state change on `transfers`,
-- including a change made by hand in psql.
--
-- The CAUSE is the one thing the database cannot know, so it is read from a
-- transaction-local setting the caller may set. Absent, it is recorded as
-- 'unrecorded' — a visible gap rather than a missing row.
-- ---------------------------------------------------------------------------
CREATE TABLE transfer_state_transitions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    transfer_id  UUID        NOT NULL REFERENCES transfers (id) ON DELETE RESTRICT,

    -- NULL for the row that records the transfer coming into existence.
    from_state   TEXT,
    to_state     TEXT        NOT NULL,

    cause        TEXT        NOT NULL,

    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT transfer_state_transitions_states_differ
        CHECK (from_state IS DISTINCT FROM to_state),

    CONSTRAINT transfer_state_transitions_cause_known
        CHECK (cause IN (
            'claim',              -- the transfer was created
            'provider-accepted',  -- Dwolla returned a reference
            'provider-event',     -- a verified webhook
            'insufficient-funds', -- refused before the provider was called
            'provider-rejected',  -- the provider call itself failed
            'operator',           -- a human, deliberately
            'unrecorded'          -- nobody said; the change still happened
        ))
);

COMMENT ON TABLE transfer_state_transitions IS
    'Append-only log of every transfer state change, written by a trigger so it cannot be bypassed. Records what changed, not who: no actor identifier, no provider payload.';

CREATE INDEX transfer_state_transitions_by_transfer_idx
    ON transfer_state_transitions (transfer_id, occurred_at);

CREATE OR REPLACE FUNCTION transfers_record_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    declared_cause TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
        RETURN NULL;
    END IF;

    -- current_setting(..., true) returns NULL rather than raising when unset,
    -- so a caller that says nothing produces a row saying nothing was said.
    declared_cause := current_setting('orion.transition_cause', true);
    IF declared_cause IS NULL OR btrim(declared_cause) = '' THEN
        declared_cause := 'unrecorded';
    END IF;

    INSERT INTO transfer_state_transitions (transfer_id, from_state, to_state, cause)
    VALUES (
        NEW.id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.state ELSE NULL END,
        NEW.state,
        declared_cause
    );

    RETURN NULL;
END $$;

CREATE TRIGGER transfers_record_transition
    AFTER INSERT OR UPDATE OF state ON transfers
    FOR EACH ROW EXECUTE FUNCTION transfers_record_transition();

-- Append-only, for the same reason ledger entries are: a history that can be
-- rewritten is not a history.
CREATE OR REPLACE FUNCTION transfer_state_transitions_no_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'transfer_state_transitions is append-only (row %)',
        COALESCE(OLD.id, NEW.id)
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER transfer_state_transitions_no_update
    BEFORE UPDATE ON transfer_state_transitions
    FOR EACH ROW EXECUTE FUNCTION transfer_state_transitions_no_change();

CREATE TRIGGER transfer_state_transitions_no_delete
    BEFORE DELETE ON transfer_state_transitions
    FOR EACH ROW EXECUTE FUNCTION transfer_state_transitions_no_change();

-- Backfill the transfers that already exist, so the log is not silently partial
-- for anything created before this migration. Cause is 'unrecorded' because it
-- genuinely is: nothing recorded it at the time, and inventing one would make
-- the trail claim knowledge it does not have.
INSERT INTO transfer_state_transitions (transfer_id, from_state, to_state, cause, occurred_at)
SELECT id, NULL, state, 'unrecorded', created_at FROM transfers;

-- Down Migration
DROP TRIGGER IF EXISTS transfers_record_transition ON transfers;
DROP FUNCTION IF EXISTS transfers_record_transition();
DROP TRIGGER IF EXISTS transfer_state_transitions_no_delete ON transfer_state_transitions;
DROP TRIGGER IF EXISTS transfer_state_transitions_no_update ON transfer_state_transitions;
DROP FUNCTION IF EXISTS transfer_state_transitions_no_change();
DROP TABLE IF EXISTS transfer_state_transitions;

ALTER TABLE transfers
    DROP CONSTRAINT IF EXISTS transfers_reversed_has_timestamp,
    DROP CONSTRAINT IF EXISTS transfers_settled_has_timestamp;
ALTER TABLE transfers
    ADD CONSTRAINT transfers_settled_has_timestamp
        CHECK ((state = 'settled') = (settled_at IS NOT NULL));
ALTER TABLE transfers
    DROP CONSTRAINT IF EXISTS transfers_state_known,
    ADD CONSTRAINT transfers_state_known
        CHECK (state IN ('requested', 'submitted', 'settled', 'failed', 'returned'));
ALTER TABLE transfers DROP COLUMN IF EXISTS reversed_at;

DROP TRIGGER IF EXISTS ledger_transactions_guard_reversal ON ledger_transactions;
DROP FUNCTION IF EXISTS ledger_transactions_guard_reversal();
DROP INDEX IF EXISTS ledger_transactions_one_settlement_per_transfer;
ALTER TABLE ledger_transactions
    DROP CONSTRAINT IF EXISTS ledger_transactions_one_reversal_per_posting,
    DROP CONSTRAINT IF EXISTS ledger_transactions_reversal_names_its_original,
    DROP CONSTRAINT IF EXISTS ledger_transactions_kind_known,
    DROP COLUMN IF EXISTS reverses_transaction_id,
    DROP COLUMN IF EXISTS kind;
ALTER TABLE ledger_transactions
    ADD CONSTRAINT ledger_transactions_one_posting_per_transfer UNIQUE (transfer_id);
