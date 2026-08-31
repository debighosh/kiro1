-- ============================================================================
-- Migration: 20260101000017_polls.sql
-- Purpose:   Create the `poll_status` and `poll_results_visibility` enumerated
--            types and the `polls` table — one row per presenter-authored poll
--            — plus the single-open-poll partial unique index and the
--            `poll_options` table — the first Milestone 3 (Polls & Word Cloud)
--            data-model migration of MSS LivePulse.
--
-- This migration MUST sort AFTER 20260101000016_vote_broadcast.sql (and after
-- 20260101000002_events.sql, which defines both the `events` table this table
-- references and the reusable `set_updated_at()` trigger function reused here).
--
-- Scope (Task 19.1):
--   * Create the `poll_status` enum ('draft','open','closed')          (Req 5.1).
--   * Create the `poll_results_visibility` enum
--     ('show_always','hide_until_closed')                             (Req 5.4).
--   * Create the `polls` table with all columns, PK, the `event_id`
--     FK → events(id) ON DELETE CASCADE, and CHECK constraints per design.
--   * Attach the existing reusable BEFORE UPDATE `set_updated_at()` trigger to
--     `polls` (Req 22.2 — keep `updated_at` current on every update).
--   * Add the `idx_polls_event` secondary index on `event_id`.
--
-- Scope (Task 19.2 — added below):
--   * Add the partial UNIQUE `one_open_poll_per_event` index enforcing that at
--     most ONE poll may be 'open' per event at the DB level              (Req 5.5).
--   * Create the `poll_options` table (id PK, poll_id FK → polls(id) ON DELETE
--     CASCADE, text 1–100 chars, display_order, response_count ≥ 0)  (Req 5.1, 22.3).
--   * Add the `idx_poll_options_poll` secondary index on `poll_id`.
--   * Enforce 2–10 options per poll via a DEFERRABLE constraint trigger
--     (a plain CHECK cannot count sibling rows)                     (Req 5.1, 5.2, 23.3).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * The `poll_responses` table                                  (Task 19.3).
--   * RLS enablement / policies for `polls` / `poll_options`       (Task 20).
--
-- Requirements: 5.1, 5.2, 5.4, 5.5, 22.2, 22.3, 23.3
-- Design ref:  Data Models → `polls` / `poll_options` tables; Enumerated types;
--              `one_open_poll_per_event` partial unique index.
--
-- Idempotency: the enums are guarded with DO $$ IF NOT EXISTS blocks, the
-- tables with IF NOT EXISTS, indexes with IF NOT EXISTS, the trigger function
-- with CREATE OR REPLACE, and the constraint trigger is dropped-then-created,
-- so the migration is safe to re-run.
-- ============================================================================

-- poll_status — lifecycle of a poll (Req 5.1): a poll is draft (being authored,
-- not yet visible to the audience), open (accepting responses), or closed
-- (locked; no further responses accepted).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'poll_status') THEN
        CREATE TYPE poll_status AS ENUM (
            'draft',
            'open',
            'closed'
        );
    END IF;
END
$$;

-- poll_results_visibility — controls when poll results are revealed to the
-- audience (Req 5.4): show_always (results visible while the poll is open) or
-- hide_until_closed (results withheld until the poll is closed).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'poll_results_visibility') THEN
        CREATE TYPE poll_results_visibility AS ENUM (
            'show_always',
            'hide_until_closed'
        );
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- polls — one row per presenter-authored poll (Req 5).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS polls (
    id                 uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),                 -- Req 5.1
    event_id           uuid                    NOT NULL
                                               REFERENCES events (id) ON DELETE CASCADE,             -- Req 5.1
    question_text      text                    NOT NULL
                                               CONSTRAINT polls_question_text_length_chk
                                                   CHECK (char_length(question_text) BETWEEN 1 AND 200), -- Req 5.1, 22.2
    status             poll_status             NOT NULL DEFAULT 'draft',                             -- Req 5.1
    display_order      integer                 NOT NULL
                                               CONSTRAINT polls_display_order_positive_chk
                                                   CHECK (display_order > 0),                        -- Req 5.1
    results_visibility poll_results_visibility NOT NULL,                                             -- Req 5.4
    created_at         timestamptz             NOT NULL DEFAULT now(),                               -- Req 22.2
    updated_at         timestamptz             NOT NULL DEFAULT now()                                -- Req 22.2
);

-- Refresh updated_at on every UPDATE to polls (Req 22.2), reusing the
-- table-agnostic set_updated_at() trigger function created in
-- 20260101000002_events.sql.
DROP TRIGGER IF EXISTS trg_polls_set_updated_at ON polls;
CREATE TRIGGER trg_polls_set_updated_at
    BEFORE UPDATE ON polls
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Secondary index to look up all polls belonging to an event (Req 5.1).
CREATE INDEX IF NOT EXISTS idx_polls_event ON polls (event_id);


-- ============================================================================
-- Task 19.2 — single-open-poll enforcement + poll_options table
-- ============================================================================

-- ----------------------------------------------------------------------------
-- one_open_poll_per_event — partial UNIQUE index enforcing, at the DB level,
-- that AT MOST ONE poll per event may have status = 'open' at any time
-- (Req 5.5). Because the index only covers rows WHERE status = 'open', any
-- number of 'draft' / 'closed' polls per event remain allowed; a second
-- attempt to open a poll for an event whose other poll is already 'open'
-- raises a unique-violation. Enforcing this in the schema (rather than only in
-- application code) makes the invariant race-safe under concurrent updates.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS one_open_poll_per_event
    ON polls (event_id)
    WHERE status = 'open';

-- ----------------------------------------------------------------------------
-- poll_options — one row per selectable answer option of a poll (Req 5.1, 5.2).
-- A poll owns between 2 and 10 options (enforced by the constraint trigger
-- below). `response_count` is a denormalised tally of responses that selected
-- this option, kept non-negative (Req 22.3).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poll_options (
    id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),                     -- Req 5.1
    poll_id        uuid    NOT NULL
                           REFERENCES polls (id) ON DELETE CASCADE,                   -- Req 5.1, 22.3
    text           text    NOT NULL
                           CONSTRAINT poll_options_text_length_chk
                               CHECK (char_length(text) BETWEEN 1 AND 100),           -- Req 5.1, 22.3
    display_order  integer NOT NULL,                                                  -- Req 5.1
    response_count integer NOT NULL DEFAULT 0
                           CONSTRAINT poll_options_response_count_nonneg_chk
                               CHECK (response_count >= 0)                            -- Req 22.3
);

-- Secondary index to look up all options belonging to a poll (Req 5.1).
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id);

-- ----------------------------------------------------------------------------
-- enforce_poll_option_count() — enforces the 2–10 options-per-poll rule
-- (Req 5.1, 5.2, 23.3). A plain CHECK constraint cannot count sibling rows, so
-- this is implemented as a CONSTRAINT TRIGGER.
--
-- DESIGN CHOICE — DEFERRED lower bound, EAGER upper bound:
--   Options are inserted incrementally: a poll starts with 0 options and gains
--   them one at a time. A naive AFTER INSERT check of the LOWER bound (>= 2)
--   would reject the very first option because the poll momentarily has 1
--   option. To allow a poll's full option set to be inserted within a single
--   transaction and validated AS A SET, the constraint trigger is declared
--   DEFERRABLE INITIALLY DEFERRED so the count is validated at COMMIT time.
--   The UPPER bound (<= 10) is safe to reason about at commit as well and is
--   checked in the same place, so both bounds are validated together once,
--   per affected poll, when the transaction commits.
--
--   Implementation detail: the trigger fires AFTER INSERT OR DELETE OR
--   UPDATE OF poll_id, FOR EACH ROW. It resolves the affected poll_id from
--   NEW (insert/update) or OLD (delete/update), then counts that poll's
--   options and raises if the count is outside [2, 10]. Being deferred, the
--   check runs at COMMIT with the final row set, so intermediate states
--   (0 or 1 option mid-transaction) do not trip it. If the parent poll was
--   itself deleted in the same transaction (ON DELETE CASCADE removes its
--   options), the count is 0 and the poll no longer exists — that is a valid
--   terminal state, so a count of 0 for a now-absent poll is not an error.
--
-- SECURITY DEFINER with a locked search_path so the invariant is enforced
-- reliably regardless of the caller's rights or search_path.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_poll_option_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_poll_id uuid;
    v_count   int;
    v_exists  boolean;
BEGIN
    -- Resolve the affected poll: NEW on INSERT/UPDATE, OLD on DELETE.
    IF TG_OP = 'DELETE' THEN
        v_poll_id := OLD.poll_id;
    ELSE
        v_poll_id := NEW.poll_id;
    END IF;

    -- If the parent poll no longer exists (e.g. it was deleted in the same
    -- transaction and its options cascaded away), there is nothing to enforce:
    -- an eventless/pollless set of 0 options is a valid terminal state.
    SELECT EXISTS (SELECT 1 FROM polls WHERE id = v_poll_id) INTO v_exists;
    IF NOT v_exists THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_count
      FROM poll_options
     WHERE poll_id = v_poll_id;

    -- Both bounds are validated here. Because the trigger is DEFERRED, this
    -- runs at COMMIT against the final option set for the poll, so the LOWER
    -- bound is not tripped by the intermediate 1-option state during an
    -- incremental multi-row insert (see DESIGN CHOICE above). The UPPER bound
    -- is likewise validated against the committed set.
    IF v_count < 2 OR v_count > 10 THEN
        RAISE EXCEPTION
            'poll % must have between 2 and 10 options (has %)', v_poll_id, v_count
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION enforce_poll_option_count() IS
    'Constraint-trigger function enforcing 2-10 options per poll (Req 5.1, 5.2, '
    '23.3). Fired as a DEFERRABLE INITIALLY DEFERRED AFTER INSERT/DELETE/UPDATE '
    'constraint trigger so the count is validated at COMMIT against the final '
    'option set, allowing options to be inserted incrementally within one '
    'transaction without tripping the lower bound. SECURITY DEFINER with a '
    'locked search_path.';

-- Deferred constraint trigger. INITIALLY DEFERRED so the 2–10 count is checked
-- once per affected poll at COMMIT time rather than after each individual row
-- change (see the DESIGN CHOICE comment on the function above).
DROP TRIGGER IF EXISTS trg_poll_options_enforce_count ON poll_options;
CREATE CONSTRAINT TRIGGER trg_poll_options_enforce_count
    AFTER INSERT OR DELETE OR UPDATE OF poll_id ON poll_options
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_poll_option_count();
