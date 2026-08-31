-- ============================================================================
-- Migration: 20260101000010_question_votes.sql
-- Purpose:   Create the `question_votes` table — one row per participant upvote
--            on a question — the second Milestone 2 (Core Live Q&A) data-model
--            migration of MSS LivePulse.
--
-- This migration MUST sort AFTER 20260101000009_questions.sql (and the
-- concurrently-authored 20260101000009_questions_indexes.sql from Task 11.2)
-- because `question_votes` references both the `questions` table and the
-- `events` table (20260101000002_events.sql) via foreign keys.
--
-- Scope (Task 11.3 only):
--   * Create the `question_votes` table with all columns, PK, the
--     `question_id` FK → questions(id) ON DELETE CASCADE, and the `event_id`
--     FK → events(id) ON DELETE CASCADE (the latter enables event-scoped RLS).
--   * Add the DB-level one-vote-per-participant-per-question UNIQUE constraint
--     on (participant_identifier, question_id).
--   * Add the `idx_votes_question` index on (question_id).
--
-- AUTHORITATIVE ONE-VOTE ENFORCEMENT (Property 1):
--   The UNIQUE (participant_identifier, question_id) constraint below is the
--   AUTHORITATIVE, DB-level enforcement of the "one active vote per participant
--   per question" rule (Req 4.3). It is the guarantee that Correctness
--   Property 1 relies upon: a duplicate vote insert is rejected by this
--   constraint, leaving the cached questions.vote_count unchanged. Application
--   code (the vote RPC, Task 13.3) MUST NOT be trusted as the sole enforcer —
--   this constraint is the single source of truth.
--
-- PRIVACY (Req 2.5, 21.18):
--   `participant_identifier` is an OPAQUE, high-entropy anonymous token that
--   carries NO personal data. It is never exposed to clients (raw vote rows are
--   not readable by anonymous users — see Task 12.2 RLS); vote counts are read
--   from questions.vote_count. The `event_id` column duplicates the parent
--   question's event so RLS policies can scope votes to a live event without a
--   join (Req 21.18).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * RLS enablement / vote policies for `question_votes`         (Task 12.2).
--   * The atomic cast/remove vote RPC that maintains vote_count   (Task 13.3).
--
-- Requirements: 4.3, 2.5, 23.3, 21.18
-- Design ref:  Data Models → `question_votes` table; DB-layer uniqueness.
--
-- Idempotency: the table is guarded with IF NOT EXISTS, the index with
-- IF NOT EXISTS, and the UNIQUE constraint is declared inline in the
-- CREATE TABLE so the migration is safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- question_votes — one row per participant upvote on a question (Req 4).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_votes (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),                 -- Req 4.2
    question_id            uuid        NOT NULL
                                       REFERENCES questions (id) ON DELETE CASCADE,           -- Req 4.3, 21.18
    -- event_id duplicates the parent question's event so event-scoped RLS
    -- policies (Task 12.2) can gate votes to a live event without a join.
    event_id               uuid        NOT NULL
                                       REFERENCES events (id) ON DELETE CASCADE,              -- Req 21.18 (RLS scoping)
    -- participant_identifier is an opaque, high-entropy anonymous token that
    -- carries NO personal data (Req 2.5) and is never exposed to clients.
    participant_identifier text        NOT NULL,                                              -- Req 2.5
    created_at             timestamptz NOT NULL DEFAULT now(),                                -- Req 4.2
    -- AUTHORITATIVE one-vote-per-participant-per-question rule (Req 4.3):
    -- this DB-level UNIQUE constraint is the single source of truth that
    -- Correctness Property 1 depends upon. A duplicate vote is rejected here.
    CONSTRAINT uq_question_votes_participant_question
        UNIQUE (participant_identifier, question_id)                                          -- Req 4.3 (Property 1)
);

-- Secondary lookup index for reading/aggregating a question's votes (Req 23.3).
CREATE INDEX IF NOT EXISTS idx_votes_question
    ON question_votes (question_id);                                                          -- Req 23.3
