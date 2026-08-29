-- Up Migration

-- Provider webhook events, and the settlement half of the transfer lifecycle.
--
-- Until now a transfer could reach `submitted` and never move again: nothing in
-- the system could learn what the ACH network actually did. Acceptance is not
-- settlement, so `settled`, `failed` and `returned` were defined but
-- unreachable. This is what drives them.
--
-- A webhook endpoint is a PUBLIC, UNAUTHENTICATED HTTP surface. Anyone can post
-- to it. The two things that make it safe are a verified signature and
-- deduplication, and both are enforced here rather than assumed.

-- ---------------------------------------------------------------------------
-- provider_webhook_events
--
-- One row per event the provider has ever delivered, keyed by the PROVIDER'S
-- event id.
--
-- The UNIQUE constraint is the deduplication. Dwolla retries delivery, and a
-- retry is indistinguishable from a first delivery at the HTTP layer — so
-- "apply once" cannot be a property of the handler's control flow. It has to be
-- a property of the database.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_webhook_events (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    provider        TEXT        NOT NULL DEFAULT 'dwolla',

    -- The provider's own event identifier. What makes a redelivery detectable.
    provider_event_id TEXT      NOT NULL,

    topic           TEXT        NOT NULL,

    -- Digest of the verified body, NOT the body. Storing the payload would
    -- keep provider URLs — including funding sources — in a table that has no
    -- business holding them.
    payload_digest  TEXT        NOT NULL,

    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- NULL until the event has been applied. A row that exists but is
    -- unprocessed is a delivery that arrived and then something failed, which
    -- is exactly what a redelivery should be allowed to retry.
    processed_at    TIMESTAMPTZ,

    -- Fixed vocabulary. Never a provider message: those echo the request.
    outcome         TEXT,

    CONSTRAINT provider_webhook_events_provider_supported
        CHECK (provider IN ('dwolla')),

    CONSTRAINT provider_webhook_events_event_id_not_blank
        CHECK (length(btrim(provider_event_id)) > 0),

    CONSTRAINT provider_webhook_events_topic_not_blank
        CHECK (length(btrim(topic)) > 0),

    -- THE DEDUPLICATION. Scoped by provider so two providers cannot collide on
    -- an id neither controls.
    CONSTRAINT provider_webhook_events_one_per_provider_event
        UNIQUE (provider, provider_event_id),

    -- A processed event says how it went; an unprocessed one does not pretend.
    CONSTRAINT provider_webhook_events_outcome_matches_processed
        CHECK (
            (processed_at IS NULL     AND outcome IS NULL) OR
            (processed_at IS NOT NULL AND outcome IS NOT NULL)
        )
);

COMMENT ON TABLE provider_webhook_events IS
    'One row per provider event, deduplicated by (provider, provider_event_id). Stores a digest of the payload, never the payload: bodies carry funding-source URLs.';

CREATE INDEX provider_webhook_events_unprocessed_idx
    ON provider_webhook_events (received_at)
    WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- transfers.settled_at / returned_at
--
-- Recorded so a terminal state carries WHEN it became terminal. Derived state
-- with no timestamp is how "status from a clock" gets reinvented later: without
-- a real settlement time, someone eventually computes one.
-- ---------------------------------------------------------------------------
ALTER TABLE transfers
    ADD COLUMN settled_at  TIMESTAMPTZ,
    ADD COLUMN returned_at TIMESTAMPTZ;

-- A terminal state and its timestamp travel together, in both directions.
ALTER TABLE transfers
    ADD CONSTRAINT transfers_settled_has_timestamp
        CHECK ((state = 'settled')  = (settled_at  IS NOT NULL)),
    ADD CONSTRAINT transfers_returned_has_timestamp
        CHECK ((state = 'returned') = (returned_at IS NOT NULL));

-- Down Migration
ALTER TABLE transfers
    DROP CONSTRAINT IF EXISTS transfers_returned_has_timestamp,
    DROP CONSTRAINT IF EXISTS transfers_settled_has_timestamp;
ALTER TABLE transfers
    DROP COLUMN IF EXISTS returned_at,
    DROP COLUMN IF EXISTS settled_at;
DROP TABLE IF EXISTS provider_webhook_events;
