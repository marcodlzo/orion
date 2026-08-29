-- Up Migration

-- Plaid sync state: the cursor, and the transactions it produced.
--
-- WHAT THIS FIXES. `getTransactions()` called `transactionsSync` with NO CURSOR
-- inside `while (has_more)`, and ASSIGNED rather than accumulated each page. Two
-- defects in six lines: the cursor never advanced so the loop could not
-- terminate, and every page discarded the one before it. Nothing was persisted,
-- so every call re-fetched an item's entire history.
--
-- NO ACCESS TOKEN LIVES HERE, and there is no column for one. The item id and
-- the cursor are identifiers, not credentials: neither can fetch anything on its
-- own. Access tokens remain in Appwrite until they are encrypted, which is a
-- separate unscheduled milestone — copying them into a second store first would
-- double the exposure rather than reduce it. A test asserts this table declares
-- no credential-shaped column.

-- ---------------------------------------------------------------------------
-- plaid_items — one row per Plaid Item, holding the sync cursor
-- ---------------------------------------------------------------------------
CREATE TABLE plaid_items (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Plaid's own item identifier. Not a secret; it is what the cursor belongs
    -- to and what a webhook names.
    item_id         TEXT        NOT NULL,

    -- OPAQUE. Plaid's pagination token, stored verbatim and never parsed. NULL
    -- means this item has never synced, which is how Plaid is told to send the
    -- full history rather than the changes since some point we cannot name.
    cursor          TEXT,

    -- An Item stops working for reasons the user has to resolve — revoked
    -- consent, a changed password, an expired login. Modelled explicitly,
    -- because a swallowed exception here looks exactly like "no new
    -- transactions" forever.
    status          TEXT        NOT NULL DEFAULT 'healthy',

    -- The provider's error CODE, never its message: a Plaid error message
    -- echoes the request, and the request carries the access token.
    last_error_code TEXT,

    last_synced_at  TIMESTAMPTZ,
    -- Advanced only when a sync completes. A cursor that moved without this
    -- moving means the apply and the cursor were not written together.
    last_cursor_at  TIMESTAMPTZ,

    consecutive_failures INTEGER NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT plaid_items_item_id_key UNIQUE (item_id),

    CONSTRAINT plaid_items_item_id_not_blank
        CHECK (length(btrim(item_id)) > 0),

    -- A cursor is never blank. Plaid returns "" for an item with no history on
    -- the very first page, and storing that instead of NULL would ask for
    -- "changes since the beginning of nothing" on the next run.
    CONSTRAINT plaid_items_cursor_not_blank
        CHECK (cursor IS NULL OR length(btrim(cursor)) > 0),

    CONSTRAINT plaid_items_status_known
        CHECK (status IN ('healthy', 'login_required', 'error')),

    -- A degraded item says why; a healthy one does not carry a stale reason.
    CONSTRAINT plaid_items_error_matches_status
        CHECK ((status = 'healthy') = (last_error_code IS NULL)),

    CONSTRAINT plaid_items_failures_not_negative
        CHECK (consecutive_failures >= 0)
);

COMMENT ON TABLE plaid_items IS
    'One row per Plaid Item, holding the transactionsSync cursor. Contains NO access token and no column for one: the cursor and item id are identifiers, not credentials.';

COMMENT ON COLUMN plaid_items.cursor IS
    'Opaque Plaid pagination token. Stored verbatim, never parsed. NULL means never synced.';

-- Items needing attention: the query an operator actually runs.
CREATE INDEX plaid_items_unhealthy_idx
    ON plaid_items (status, updated_at)
    WHERE status <> 'healthy';

-- ---------------------------------------------------------------------------
-- plaid_transactions — what the bank reports
--
-- THESE ARE NOT LEDGER ENTRIES, and they are deliberately in a different table
-- with a different shape. The ledger records money THIS system moved, in signed
-- integer minor units, double-entry and immutable. This records what a bank says
-- happened in an external account: single-sided, mutable by the provider, and
-- occasionally retracted. Conflating the two would let a bank's revision of its
-- own history rewrite our record of ours.
-- ---------------------------------------------------------------------------
CREATE TABLE plaid_transactions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    item_id         TEXT        NOT NULL REFERENCES plaid_items (item_id)
                                ON DELETE RESTRICT,

    -- Plaid's identifier for the transaction. UNIQUE: this is what makes the
    -- sync idempotent, so a replayed page updates rather than duplicates.
    plaid_transaction_id TEXT   NOT NULL,

    -- An Item owns MANY accounts. Recording which one is what stops the
    -- `accounts[0]` defect from reappearing at this layer.
    plaid_account_id TEXT       NOT NULL,

    -- INTEGER MINOR UNITS. Plaid sends a JSON number; it is converted once, at
    -- the adapter edge, and no float reaches this column.
    --
    -- SIGN IS PLAID'S CONVENTION, kept deliberately: positive means money left
    -- the account. Re-signing it here would make this table disagree with the
    -- provider it is a record of, and the place to reconcile the two
    -- conventions is where they meet, not in storage.
    amount_minor    BIGINT      NOT NULL,

    iso_currency    TEXT        NOT NULL,

    -- The date the bank assigns. Not a settlement time, and nothing derives
    -- state from it.
    posted_date     DATE        NOT NULL,

    name            TEXT        NOT NULL,
    merchant_name   TEXT,

    -- A pending transaction can change amount, date and name, or vanish. It is
    -- not a fact yet.
    pending         BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Plaid retracts transactions. Soft-deleted rather than removed, so a
    -- retraction is visible instead of silently leaving no trace.
    removed_at      TIMESTAMPTZ,

    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT plaid_transactions_id_key UNIQUE (plaid_transaction_id),

    CONSTRAINT plaid_transactions_currency_not_blank
        CHECK (length(btrim(iso_currency)) > 0),

    CONSTRAINT plaid_transactions_name_not_blank
        CHECK (length(btrim(name)) > 0),

    CONSTRAINT plaid_transactions_account_not_blank
        CHECK (length(btrim(plaid_account_id)) > 0)
);

COMMENT ON TABLE plaid_transactions IS
    'What a bank reports, via Plaid. NOT ledger entries: single-sided, provider-mutable, and retractable. The ledger records money this system moved.';

CREATE INDEX plaid_transactions_by_account_idx
    ON plaid_transactions (plaid_account_id, posted_date DESC)
    WHERE removed_at IS NULL;

CREATE INDEX plaid_transactions_by_item_idx
    ON plaid_transactions (item_id, posted_date DESC);

CREATE TRIGGER plaid_items_set_updated_at
    BEFORE UPDATE ON plaid_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER plaid_transactions_set_updated_at
    BEFORE UPDATE ON plaid_transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS plaid_transactions;
DROP TABLE IF EXISTS plaid_items;
