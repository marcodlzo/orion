-- Up Migration

-- Provider connection metadata needed after the Appwrite bank read cutover.
ALTER TABLE linked_accounts
    ADD COLUMN provider_item_id TEXT,
    ADD COLUMN shareable_id TEXT;

ALTER TABLE linked_accounts
    ADD CONSTRAINT linked_accounts_provider_item_not_blank
        CHECK (provider_item_id IS NULL OR length(btrim(provider_item_id)) > 0),
    ADD CONSTRAINT linked_accounts_shareable_id_not_blank
        CHECK (shareable_id IS NULL OR length(btrim(shareable_id)) > 0);

-- Credentials stay out of linked_accounts. Each credential row has its own id;
-- AES-GCM associated data binds both ciphertexts to that id and field name.
CREATE TABLE linked_account_credentials (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    linked_account_id  UUID        NOT NULL UNIQUE
        REFERENCES linked_accounts (id) ON DELETE RESTRICT,
    access_token       TEXT        NOT NULL,
    funding_source_url TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT linked_account_credentials_access_token_not_blank
        CHECK (length(btrim(access_token)) > 0),
    CONSTRAINT linked_account_credentials_funding_source_not_blank
        CHECK (length(btrim(funding_source_url)) > 0)
);

COMMENT ON TABLE linked_account_credentials IS
    'Encrypted provider capabilities, separated from linked account metadata. Ciphertexts are bound to this row id and field.';

CREATE TRIGGER linked_account_credentials_set_updated_at
    BEFORE UPDATE ON linked_account_credentials
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS linked_account_credentials_set_updated_at ON linked_account_credentials;
DROP TABLE IF EXISTS linked_account_credentials;
ALTER TABLE linked_accounts
    DROP CONSTRAINT IF EXISTS linked_accounts_shareable_id_not_blank,
    DROP CONSTRAINT IF EXISTS linked_accounts_provider_item_not_blank,
    DROP COLUMN IF EXISTS shareable_id,
    DROP COLUMN IF EXISTS provider_item_id;
