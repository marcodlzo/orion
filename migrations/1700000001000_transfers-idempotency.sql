-- Up Migration

-- Idempotent transfer records.
--
-- The first table in this schema that a REQUEST PATH writes to. Everything
-- before it was populated by operator tooling only.
--
-- It exists because two facts about the current transfer path are unacceptable
-- together: `initiateTransfer` is not idempotent, so a retry sends money twice;
-- and Dwolla's transfer reference is discarded, so a local record can never be
-- matched to a provider transfer. The second makes the first unrecoverable —
-- without a stored reference there is no way to ask "did this already happen?"
--
-- Deliberately NOT included: ledger entries, balances, holds. A transfer row
-- records that money was ASKED FOR and what the provider said; it is not a
-- statement about who owns what. That is the ledger, and it is a later
-- milestone.

-- ---------------------------------------------------------------------------
-- transfers
--
-- One row per intent, claimed BEFORE the provider is called.
--
-- The claim is what makes retry safe. A row inserted and committed before the
-- Dwolla request means a process that dies mid-flight leaves evidence: the next
-- attempt finds the row, re-sends with the same Idempotency-Key, and Dwolla
-- returns the original transfer instead of creating a second one.
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Whose transfer this is. RESTRICT, not CASCADE: a customer with financial
    -- history must not be deletable, and certainly not silently.
    customer_id           UUID        NOT NULL
        REFERENCES banking_customers (id) ON DELETE RESTRICT,

    -- Client-generated, one per submission attempt, resent unchanged on retry.
    idempotency_key       TEXT        NOT NULL,

    -- Hash of the normalised intent. What makes "same key, different payload"
    -- detectable instead of silently replayed.
    request_fingerprint   TEXT        NOT NULL,

    state                 TEXT        NOT NULL,

    -- Integer minor units. There is no float anywhere in this column's history
    -- and there must not be one in its future.
    amount_minor          BIGINT      NOT NULL,
    currency              CHAR(3)     NOT NULL DEFAULT 'USD',

    provider              TEXT        NOT NULL DEFAULT 'dwolla',

    -- The reference the current code throws away. NULL until the provider has
    -- accepted; never cleared once set.
    provider_transfer_id  TEXT,

    -- Set only in a terminal failure state. Fixed vocabulary, never a driver
    -- message: those quote the offending row.
    failure_code          TEXT,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- SCOPED PER CUSTOMER, deliberately. A key is client-supplied, so a global
    -- unique index would let one actor probe or collide with another's keys.
    CONSTRAINT transfers_customer_idempotency_key
        UNIQUE (customer_id, idempotency_key),

    -- One local row per provider transfer. Stops a bug from recording the same
    -- Dwolla transfer twice under different keys. UNIQUE permits many NULLs,
    -- which is what a not-yet-submitted transfer needs.
    CONSTRAINT transfers_provider_transfer_id_key
        UNIQUE (provider_transfer_id),

    -- The lifecycle, in full. `settled` and `returned` are not reachable yet —
    -- they need webhooks — but a state machine that only knows the states it
    -- can currently reach has to be rewritten when the rest arrive.
    CONSTRAINT transfers_state_known
        CHECK (state IN ('requested', 'submitted', 'settled', 'failed', 'returned')),

    -- Money moves in whole minor units and only ever forwards.
    CONSTRAINT transfers_amount_positive
        CHECK (amount_minor > 0),

    CONSTRAINT transfers_currency_supported
        CHECK (currency = 'USD'),

    CONSTRAINT transfers_provider_supported
        CHECK (provider IN ('dwolla')),

    CONSTRAINT transfers_idempotency_key_not_blank
        CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT transfers_request_fingerprint_not_blank
        CHECK (length(btrim(request_fingerprint)) > 0),

    -- A submitted transfer has a provider reference. Enforcing it here means a
    -- code path that forgets to store the reference fails loudly at the write
    -- rather than quietly producing an unreconcilable row.
    CONSTRAINT transfers_submitted_has_provider_reference
        CHECK (state <> 'submitted' OR provider_transfer_id IS NOT NULL),

    -- A failure explains itself.
    CONSTRAINT transfers_failed_has_code
        CHECK (state <> 'failed' OR failure_code IS NOT NULL)
);

COMMENT ON TABLE transfers IS
    'One row per transfer intent, claimed before the provider is called. Records what was asked for and what the provider said; carries no balance and is not a ledger.';

COMMENT ON COLUMN transfers.provider_transfer_id IS
    'Provider reference. Without it a local record can never be matched to a provider transfer, which makes reconciliation structurally impossible.';

CREATE INDEX transfers_customer_id_idx ON transfers (customer_id);

-- Recovery lookup: find attempts that were claimed but never resolved.
CREATE INDEX transfers_unresolved_idx
    ON transfers (state, created_at)
    WHERE state = 'requested';

CREATE TRIGGER transfers_set_updated_at
    BEFORE UPDATE ON transfers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS transfers_set_updated_at ON transfers;
DROP TABLE IF EXISTS transfers;
