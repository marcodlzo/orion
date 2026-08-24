-- Up Migration

-- The relational identity foundation for the banking domain.
--
-- Deliberately NOT included: ledger accounts, ledger entries, transfers,
-- balances, holds, idempotency keys. Those arrive with the ledger milestone and
-- creating empty shells for them now would invite premature coupling.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- banking_customers
--
-- The local identity anchor. Appwrite owns authentication; this table owns the
-- banking domain's notion of "who", so that ledger rows can reference a stable
-- local key rather than a foreign system's document id.
--
-- It is a MAPPING, not a second profile database. No name, email, address,
-- date of birth or SSN. Duplicating a profile means two places to keep correct
-- and two places to leak from; the profile stays where it already lives.
-- ---------------------------------------------------------------------------
CREATE TABLE banking_customers (
    id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Appwrite auth account id. What a session resolves to.
    appwrite_auth_id          TEXT        NOT NULL,

    -- Appwrite user-collection DOCUMENT id. What the legacy bank records point
    -- at. Both are kept because they are genuinely different identifiers and
    -- conflating them is a known trap in this codebase.
    appwrite_user_document_id TEXT        NOT NULL,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT banking_customers_appwrite_auth_id_key
        UNIQUE (appwrite_auth_id),
    CONSTRAINT banking_customers_appwrite_user_document_id_key
        UNIQUE (appwrite_user_document_id),

    -- Empty strings are not identifiers.
    CONSTRAINT banking_customers_appwrite_auth_id_not_blank
        CHECK (length(btrim(appwrite_auth_id)) > 0),
    CONSTRAINT banking_customers_appwrite_user_document_id_not_blank
        CHECK (length(btrim(appwrite_user_document_id)) > 0)
);

COMMENT ON TABLE banking_customers IS
    'Identity mapping from Appwrite authentication to the local banking domain. Not a profile store.';

-- ---------------------------------------------------------------------------
-- linked_accounts
--
-- EXTERNAL bank accounts connected through a provider such as Plaid.
--
-- These are NOT internal ledger accounts. The distinction is load-bearing:
--   linked_accounts  = someone else's account at a real bank, which we can
--                      observe and address, and whose balance belongs to that
--                      bank
--   ledger_accounts  = an internal account whose balance is DERIVED by summing
--                      our own double-entry rows  (does not exist yet)
--
-- Naming this table `accounts` would blur the two and invite a future reader to
-- treat provider data as authoritative balance. That confusion is precisely the
-- defect the audit found in the original application.
--
-- NO BALANCE COLUMN. See the check at the end of this file's test coverage.
-- Plaid balances remain external display data until the ledger exists.
--
-- NO PROVIDER SECRETS. accessToken, fundingSourceUrl and processorToken stay
-- behind the existing server boundary. PostgreSQL is not encryption, and moving
-- plaintext credentials into a new datastore is not a security improvement — an
-- encrypted provider-connection model is its own deliberate change.
-- ---------------------------------------------------------------------------
CREATE TABLE linked_accounts (
    id                               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id                      UUID        NOT NULL,

    -- Bridge to the legacy Appwrite bank document during migration. Nullable
    -- because accounts linked after the cutover will not have one.
    legacy_appwrite_bank_document_id TEXT,

    -- The provider's identifier for the account (e.g. a Plaid account_id).
    external_account_id              TEXT        NOT NULL,
    provider                         TEXT        NOT NULL,

    display_name                     TEXT        NOT NULL,
    official_name                    TEXT,
    mask                             TEXT,
    account_type                     TEXT,
    account_subtype                  TEXT,

    -- USD only, on purpose. A general currency column implies FX, per-currency
    -- rounding and mixed-currency arithmetic that have no requirements behind
    -- them. Widening this must be a deliberate migration.
    currency                         CHAR(3)     NOT NULL DEFAULT 'USD',

    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT linked_accounts_customer_id_fkey
        FOREIGN KEY (customer_id)
        REFERENCES banking_customers (id)
        -- RESTRICT, not CASCADE: financial records must never disappear as a
        -- side effect of deleting a customer row. Removing a customer with
        -- linked accounts has to be an explicit, considered operation.
        ON DELETE RESTRICT,

    CONSTRAINT linked_accounts_currency_supported
        CHECK (currency = 'USD'),

    CONSTRAINT linked_accounts_provider_supported
        CHECK (provider IN ('plaid')),

    CONSTRAINT linked_accounts_external_account_id_not_blank
        CHECK (length(btrim(external_account_id)) > 0),
    CONSTRAINT linked_accounts_display_name_not_blank
        CHECK (length(btrim(display_name)) > 0),

    -- The same provider account cannot be linked twice for the same customer.
    CONSTRAINT linked_accounts_customer_provider_account_key
        UNIQUE (customer_id, provider, external_account_id),

    -- One legacy Appwrite bank document maps to at most one row, so a rerun of
    -- the migration cannot duplicate it. UNIQUE permits many NULLs in
    -- PostgreSQL, which is what we want for post-cutover accounts.
    CONSTRAINT linked_accounts_legacy_bank_document_key
        UNIQUE (legacy_appwrite_bank_document_id)
);

COMMENT ON TABLE linked_accounts IS
    'External provider-linked bank accounts. NOT internal ledger accounts; carries no balance and no provider credentials.';

CREATE INDEX linked_accounts_customer_id_idx ON linked_accounts (customer_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- Enforced by the database rather than by application code, so a write from a
-- migration script or a psql session cannot leave a stale timestamp.
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER banking_customers_set_updated_at
    BEFORE UPDATE ON banking_customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER linked_accounts_set_updated_at
    BEFORE UPDATE ON linked_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS linked_accounts_set_updated_at ON linked_accounts;
DROP TRIGGER IF EXISTS banking_customers_set_updated_at ON banking_customers;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TABLE IF EXISTS linked_accounts;
DROP TABLE IF EXISTS banking_customers;
