-- Up Migration

-- Rate limiting: counters for abuse control on the public surface.
--
-- WHAT THIS FIXES. There was no throttle anywhere in the application. `signIn`
-- accepted unlimited credential-stuffing attempts, `signUp` could be driven in a
-- loop to create Dwolla customers, and `initiateTransfer` had no velocity limit.
-- Every server action is a public POST reachable by anyone who can reach the
-- app, so "the UI only submits one at a time" restricted nothing.
--
-- NO CREDENTIAL AND NO PII LIVES HERE, and there is no column for either. The
-- bucket is an opaque key. Where a limit is keyed on something identifying — an
-- email address being tried, a client address — the caller hashes it before it
-- arrives, so this table holds a digest rather than the value. A rate-limit
-- table is exactly the wrong place to accumulate a list of email addresses
-- somebody attempted to sign in as.

-- ---------------------------------------------------------------------------
-- rate_limit_counters — one row per bucket per fixed window
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limit_counters (
    -- Opaque bucket key: "<scope>:<hashed subject>". Never a raw email, never a
    -- raw address. Built by lib/rate-limit/policy.ts, which is pure and tested.
    bucket          TEXT        NOT NULL,

    -- Start of the fixed window this row counts, truncated by the caller to the
    -- window size. Two requests in the same window share a row; the next window
    -- gets a new one.
    window_start    TIMESTAMPTZ NOT NULL,

    -- Attempts recorded in this window. Incremented by an atomic upsert, so
    -- concurrent requests cannot both read the same value and both write it
    -- back. There is no SELECT-then-UPDATE anywhere in this table's access path.
    hits            INTEGER     NOT NULL DEFAULT 0,

    -- The pair is the identity of a window. A composite primary key rather than
    -- a surrogate id: the upsert's ON CONFLICT needs exactly this to be unique,
    -- and a separate id would let two rows describe the same window.
    PRIMARY KEY (bucket, window_start),

    CONSTRAINT rate_limit_counters_hits_positive CHECK (hits > 0),
    CONSTRAINT rate_limit_counters_bucket_not_blank CHECK (length(btrim(bucket)) > 0)
);

-- Sweeping expired windows is the only query that does not name a bucket, so it
-- is the only one that needs an index on the timestamp alone. Without it the
-- sweep degrades to a full scan as the table grows, which is precisely when it
-- matters.
CREATE INDEX rate_limit_counters_window_start_idx
    ON rate_limit_counters (window_start);

-- Down Migration
DROP TABLE rate_limit_counters;
