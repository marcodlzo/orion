-- Up Migration

-- The unguessable replacement for `shareable_id`, which is base64 of the Plaid
-- account id and therefore computable by anyone who knows that id.
--
-- LANDS BESIDE THE OLD COLUMN, deliberately. `shareable_id` keeps its values
-- and the transfer path keeps resolving through it until the cutover. Rotating
-- in place would break every recipient reference the moment this migration ran,
-- with the fix sitting in a later commit.
--
-- The DEFAULT is defence in depth: a future insert path that forgets the column
-- still gets a strong random token rather than a NULL or a blank. `gen_random_uuid`
-- draws from the OS random source and is built in from PostgreSQL 13, so this
-- needs no extension.
ALTER TABLE linked_accounts
    ADD COLUMN share_token TEXT
        DEFAULT replace(gen_random_uuid()::text, '-', '');

-- A ROTATION, NOT A COPY. Every existing row gets its own fresh value --
-- `gen_random_uuid()` is volatile, so it is evaluated per row rather than once
-- for the statement. Carrying the old base64 across would migrate the defect.
UPDATE linked_accounts
   SET share_token = replace(gen_random_uuid()::text, '-', '')
 WHERE share_token IS NULL;

ALTER TABLE linked_accounts
    ALTER COLUMN share_token SET NOT NULL,
    ADD CONSTRAINT linked_accounts_share_token_shape
        CHECK (share_token ~ '^[0-9a-f]{32}$');

-- It is a lookup key: the token alone selects the recipient of a transfer. Two
-- rows sharing one would make that recipient ambiguous, and the resolver would
-- have to pick. Refuse it in the schema instead.
CREATE UNIQUE INDEX linked_accounts_share_token_key
    ON linked_accounts (share_token);

COMMENT ON COLUMN linked_accounts.share_token IS
    'Unguessable bearer reference for receiving money. Encodes nothing; not an authorization capability.';

-- Down Migration
DROP INDEX IF EXISTS linked_accounts_share_token_key;
ALTER TABLE linked_accounts
    DROP CONSTRAINT IF EXISTS linked_accounts_share_token_shape,
    DROP COLUMN IF EXISTS share_token;
