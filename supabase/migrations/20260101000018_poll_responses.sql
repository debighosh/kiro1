-- ============================================================================
-- Migration: 20260101000018_poll_responses.sql
-- Purpose:   Create the `poll_responses` table — one row per participant's
--            current response to a poll — a Milestone 3 (Polls & Word Cloud)
--            data-model migration of MSS LivePulse.
--
-- This migration MUST sort AFTER 20260101000017_polls.sql because
-- `poll_responses` references both the `polls` table and the `poll_options`
-- table via foreign keys. `poll_options` is appended to
-- 20260101000017_polls.sql by Task 19.2; because …017 sorts before …018 by
-- filename order, both `polls` and `poll_options` exist at apply time.
-- The table also references the `events` table (20260101000002_events.sql) via
-- a foreign key and reuses the `set_updated_at()` trigger function defined
-- there.
--
-- Scope (Task 19.3 only):
--   * Create the `poll_responses` table with all columns, PK, the `poll_id` FK
--     → polls(id) ON DELETE CASCADE, the `event_id` FK → events(id) ON DELETE
--     CASCADE (the latter enables event-scoped RLS), and the `option_id` FK
--     → poll_options(id) ON DELETE CASCADE.
--   * Add the DB-level one-response-per-participant-per-poll UNIQUE constraint
--     on (participant_identifier, poll_id) — the guarantee enabling the
--     upsert-replace behaviour (a participant may change their answer, but only
--     ever holds one response row per poll).
--   * Add the `idx_poll_responses_poll` index on (poll_id).
--   * Attach the existing reusable BEFORE UPDATE `set_updated_at()` trigger to
--     `poll_responses` (keep `updated_at` current on every update).
--
-- AUTHORITATIVE ONE-RESPONSE ENFORCEMENT:
--   The UNIQUE (participant_identifier, poll_id) constraint below is the
--   AUTHORITATIVE, DB-level enforcement of the "one response per participant
--   per poll" rule (Req 5.7, 5.8). It is the guarantee that the upsert-replace
--   flow relies upon: a participant changing their vote replaces their single
--   existing row rather than accumulating duplicates. Application code MUST NOT
--   be trusted as the sole enforcer — this constraint is the single source of
--   truth.
--
-- PRIVACY (Req 21.18):
--   `participant_identifier` is an OPAQUE, high-entropy anonymous token that
--   carries NO personal data. The `event_id` column duplicates the parent
--   poll's event so RLS policies can scope responses to a live event without a
--   join (Req 21.18).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * RLS enablement / policies for `poll_responses`             (Task 20.2).
--   * The static-guard enforcement of closed-poll response rules (Task 19.5).
--   * The `poll_options` table it references                     (Task 19.2).
--
-- Requirements: 5.7, 5.8, 23.3, 21.18
-- Design ref:  Data Models → `poll_responses` table; UNIQUE
--              (participant_identifier, poll_id).
--
-- Idempotency: the table is guarded with IF NOT EXISTS, the index with
-- IF NOT EXISTS, and the UNIQUE constraint is declared inline in the
-- CREATE TABLE so the migration is safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- poll_responses — one row per participant's current response to a poll (Req 5).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poll_responses (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),                 -- Req 5.7
    poll_id                uuid        NOT NULL
                                       REFERENCES polls (id) ON DELETE CASCADE,               -- Req 5.7, 21.18
    -- event_id duplicates the parent poll's event so event-scoped RLS policies
    -- (Task 20.2) can gate responses to a live event without a join.
    event_id               uuid        NOT NULL
                                       REFERENCES events (id) ON DELETE CASCADE,              -- Req 21.18 (RLS scoping)
    option_id              uuid        NOT NULL
                                       REFERENCES poll_options (id) ON DELETE CASCADE,        -- Req 5.7
    -- participant_identifier is an opaque, high-entropy anonymous token that
    -- carries NO personal data (Req 21.18).
    participant_identifier text        NOT NULL,                                              -- Req 21.18
    created_at             timestamptz NOT NULL DEFAULT now(),                                -- Req 5.7
    updated_at             timestamptz NOT NULL DEFAULT now(),                                -- Req 5.8
    -- AUTHORITATIVE one-response-per-participant-per-poll rule (Req 5.7, 5.8):
    -- this DB-level UNIQUE constraint is the single source of truth enabling
    -- the upsert-replace flow. A participant changing their answer replaces
    -- their single existing row rather than accumulating duplicates.
    CONSTRAINT uq_poll_responses_participant_poll
        UNIQUE (participant_identifier, poll_id)                                              -- Req 5.7, 5.8
);

-- Refresh updated_at on every UPDATE to poll_responses (Req 5.8), reusing the
-- table-agnostic set_updated_at() trigger function created in
-- 20260101000002_events.sql.
DROP TRIGGER IF EXISTS trg_poll_responses_set_updated_at ON poll_responses;
CREATE TRIGGER trg_poll_responses_set_updated_at
    BEFORE UPDATE ON poll_responses
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Secondary lookup index for reading/aggregating a poll's responses (Req 23.3).
CREATE INDEX IF NOT EXISTS idx_poll_responses_poll
    ON poll_responses (poll_id);                                                              -- Req 23.3
