-- Up Migration

-- Transfer parties, bank references, note, and accounting provenance.
--
-- WHY. `transfers` records who SENT money and nothing about who received it. It
-- carries customer_id (the sender), an amount, a state and a provider
-- reference. That is enough to move money and not enough to describe it.
--
-- Two consequences, both blocking the PostgreSQL cutover:
--
--   1. A recipient cannot query their incoming transfers AT ALL. The row is
--      keyed only to the sender, so "show me what I received" has no answer.
--      Today that view comes from the Appwrite transaction collection, which is
--      why it is still dual-written.
--
--   2. Settlement cannot credit the recipient, because it does not know who
--      they are. It posts sender -amount and HOUSE +amount, so the recipient's
--      ledger balance never reflects money received. See
--      docs/adr/0002-cutover-accounting-model.md.
--
-- This migration adds the facts. It changes no posting and rewrites no entry.

-- ---------------------------------------------------------------------------
-- The counterparty
-- ---------------------------------------------------------------------------

-- The recipient's Appwrite user document. Resolved server-side from the bank
-- the reference names, never from anything the caller supplied.
--
-- NULLABLE because rows written before this migration genuinely do not have it.
-- A default would be inventing a party.
ALTER TABLE transfers ADD COLUMN recipient_user_document_id TEXT;

-- The recipient's local customer, once they are enrolled.
--
-- SEPARATE FROM THE DOCUMENT ID ON PURPOSE. The document id is knowable at
-- claim time with no extra read; the customer id may not exist yet, because a
-- recipient who has never transferred has no bridge row. Settlement resolves it
-- and enrols if needed, which is off the request path and can afford the read.
--
-- ON DELETE RESTRICT, like every other reference to a customer: a customer with
-- financial history is not deletable.
ALTER TABLE transfers ADD COLUMN recipient_customer_id UUID
    REFERENCES banking_customers(id) ON DELETE RESTRICT;

CREATE INDEX transfers_recipient_customer_id_idx
    ON transfers (recipient_customer_id)
    WHERE recipient_customer_id IS NOT NULL;

-- The recipient's own view of their history needs this before they are ever
-- enrolled, so it is indexed too.
CREATE INDEX transfers_recipient_user_document_id_idx
    ON transfers (recipient_user_document_id)
    WHERE recipient_user_document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Which accounts, and what the sender called it
-- ---------------------------------------------------------------------------

-- The Appwrite bank documents on each side. Stored as the legacy identifiers
-- they are, matching linked_accounts.legacy_appwrite_bank_document_id, so the
-- two can be joined without inventing a mapping.
ALTER TABLE transfers ADD COLUMN sender_bank_document_id TEXT;
ALTER TABLE transfers ADD COLUMN recipient_bank_document_id TEXT;

-- The note the sender typed. This is the transaction's display NAME, and its
-- absence is why history cannot be rendered from this table.
--
-- NOT a free-text audit field: it is bounded, and it is the sender's own words
-- about their own transfer.
ALTER TABLE transfers ADD COLUMN note TEXT;

ALTER TABLE transfers ADD CONSTRAINT transfers_note_length
    CHECK (note IS NULL OR length(note) <= 200);

-- ---------------------------------------------------------------------------
-- Accounting provenance
-- ---------------------------------------------------------------------------

-- WHICH MODEL POSTED THIS TRANSFER'S ENTRIES.
--
-- Entries are immutable by trigger, so a transfer settled under the old model
-- keeps the postings it got: sender -amount, house +amount. Rewriting them is
-- not possible and would not be desirable — the record of what the system
-- believed at the time is the evidence.
--
-- Without this column the ledger becomes unreadable after the change: two
-- transfers with identical rows would have different entry shapes and nothing
-- would say why. Reconciliation in particular has to know which shape to expect.
--
-- 'house' is the old model and the default, so existing rows are labelled
-- truthfully rather than back-dated into the new one. New transfers are written
-- as 'internal_two_party' by the claim.
ALTER TABLE transfers ADD COLUMN accounting_model TEXT NOT NULL DEFAULT 'house';

ALTER TABLE transfers ADD CONSTRAINT transfers_accounting_model_known
    CHECK (accounting_model IN ('house', 'internal_two_party'));

-- Down Migration
DROP INDEX IF EXISTS transfers_recipient_user_document_id_idx;
DROP INDEX IF EXISTS transfers_recipient_customer_id_idx;
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_accounting_model_known;
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_note_length;
ALTER TABLE transfers DROP COLUMN IF EXISTS accounting_model;
ALTER TABLE transfers DROP COLUMN IF EXISTS note;
ALTER TABLE transfers DROP COLUMN IF EXISTS recipient_bank_document_id;
ALTER TABLE transfers DROP COLUMN IF EXISTS sender_bank_document_id;
ALTER TABLE transfers DROP COLUMN IF EXISTS recipient_customer_id;
ALTER TABLE transfers DROP COLUMN IF EXISTS recipient_user_document_id;
