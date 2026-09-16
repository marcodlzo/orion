-- Up Migration

-- This intentionally destroys the stored legacy recipient reference. That is
-- lossless in the only sense that matters: every value was base64 of
-- external_account_id and can be recomputed from that retained column. Its
-- recomputability is the security defect; preserving the redundant encoding
-- would preserve a second, misleading path back to the Plaid account id.
ALTER TABLE linked_accounts
    DROP COLUMN shareable_id;

-- Down Migration

-- Rollback can reconstruct the exact legacy scheme because it never contained
-- independent information. This exists only to restore the prior schema; the
-- application no longer produces or consumes these values.
ALTER TABLE linked_accounts
    ADD COLUMN shareable_id TEXT;

UPDATE linked_accounts
   SET shareable_id = encode(convert_to(external_account_id, 'UTF8'), 'base64');

ALTER TABLE linked_accounts
    ADD CONSTRAINT linked_accounts_shareable_id_not_blank
        CHECK (shareable_id IS NULL OR length(btrim(shareable_id)) > 0);
