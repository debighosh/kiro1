-- ============================================================================
-- Migration: 20260101000009_questions.sql
-- Purpose:   Create the `question_status` enumerated type and the `questions`
--            table — one row per audience-submitted question — the first
--            Milestone 2 (Core Live Q&A) data-model migration of MSS LivePulse.
--
-- This migration MUST sort AFTER 20260101000008_admin_audit_rls.sql (and after
-- 20260101000002_events.sql, which defines both the `events` table this table
-- references and the reusable `set_updated_at()` trigger function reused here).
--
-- Scope (Task 11.1 only):
--   * Create the `question_status` enum
--     ('pending','approved','featured','answered','hidden')          (Req 3.5).
--   * Create the `questions` table with all columns, PK, the `event_id`
--     FK → events(id) ON DELETE CASCADE, and CHECK constraints per design.
--   * Attach the existing reusable BEFORE UPDATE `set_updated_at()` trigger to
--     `questions` (Req 3.4 — keep `updated_at` current on every update).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * `idx_questions_event` / `idx_questions_status` / `idx_questions_created`
--     / `idx_questions_votes` indexes and the partial UNIQUE
--     (event_id, submission_key) idempotency constraint          (Task 11.2).
--   * The `question_votes` table                                 (Task 11.3).
--   * RLS enablement / policies for `questions`                  (Task 12.1).
--   * The rate-limited submit RPC / Edge Function                (Task 13.2).
--
-- DECISION — deferred `cluster_id` foreign key:
--   The design lists `cluster_id` as `FK → question_clusters(id) ON DELETE SET
--   NULL`. However, `question_clusters` is a Milestone-4 table that does not
--   yet exist, so for Milestone 2 `cluster_id` is declared here as a PLAIN
--   nullable `uuid` with NO foreign key. The `FK → question_clusters(id)
--   ON DELETE SET NULL` is DEFERRED to the Milestone-4 clusters migration,
--   which will add the constraint via ALTER TABLE once that table exists.
--
-- DECISION — `status` column default:
--   The design describes `status` as "NOT NULL, default per moderation mode":
--   the submit RPC/trigger (Task 13.2) sets `pending` (pre-moderation) or
--   `approved` (post-moderation) per the event's `moderation_mode`. To keep
--   raw inserts safe before that RPC exists, a column default of `'pending'`
--   is declared here; the submit path OVERRIDES this per moderation mode.
--
-- Requirements: 3.4, 3.5, 22.1, 21.18, 23.8
-- Design ref:  Data Models → `questions` table; Enumerated types.
--
-- Idempotency: the enum is guarded with a DO $$ IF NOT EXISTS block and the
-- table with IF NOT EXISTS so the migration is safe to re-run.
-- ============================================================================

-- question_status — lifecycle of a submitted question through moderation
-- (Req 3.5): a question is pending (awaiting pre-moderation), approved
-- (visible to audience), featured (highlighted), answered, or hidden.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'question_status') THEN
        CREATE TYPE question_status AS ENUM (
            'pending',
            'approved',
            'featured',
            'answered',
            'hidden'
        );
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- questions — one row per audience-submitted question (Req 3, 4, 15, 16).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
    id                     uuid            PRIMARY KEY DEFAULT gen_random_uuid(),                    -- Req 3.4
    event_id               uuid            NOT NULL
                                           REFERENCES events (id) ON DELETE CASCADE,                 -- Req 3.4, 21.18
    text                   text            NOT NULL
                                           CONSTRAINT questions_text_length_chk
                                               CHECK (char_length(text) BETWEEN 1 AND 300),          -- Req 3.1, 22.1
    -- Default 'pending' keeps raw inserts safe; the submit RPC/trigger
    -- (Task 13.2) overrides this to 'pending' (pre) or 'approved' (post) per
    -- the parent event's moderation_mode (Req 3.5–3.7).
    status                 question_status NOT NULL DEFAULT 'pending',                               -- Req 3.5
    vote_count             integer         NOT NULL DEFAULT 0
                                           CONSTRAINT questions_vote_count_nonneg_chk
                                               CHECK (vote_count >= 0),                               -- Req 3.4, 4.1
    ai_category            text,                                                                      -- Req 15.1, 15.3
    ai_category_confidence numeric(3,2),                                                             -- Req 15.5, 15.6
    ai_prior_category      text,                                                                      -- Req 15.7
    -- cluster_id: plain nullable uuid for M2; FK → question_clusters(id)
    -- ON DELETE SET NULL is deferred to the Milestone-4 clusters migration
    -- (question_clusters does not exist yet). See header DECISION note.
    cluster_id             uuid,                                                                      -- Req 3.4, 16.4 (FK deferred to M4)
    -- submission_key: client-supplied idempotency key so a retried write is
    -- not duplicated (Req 23.8). The partial UNIQUE (event_id, submission_key)
    -- WHERE submission_key IS NOT NULL is added in Task 11.2.
    submission_key         text,                                                                      -- Req 23.8
    created_at             timestamptz     NOT NULL DEFAULT now(),                                    -- Req 3.4
    updated_at             timestamptz     NOT NULL DEFAULT now()                                     -- Req 3.4
);

-- Refresh updated_at on every UPDATE to questions (Req 3.4), reusing the
-- table-agnostic set_updated_at() trigger function created in
-- 20260101000002_events.sql.
DROP TRIGGER IF EXISTS trg_questions_set_updated_at ON questions;
CREATE TRIGGER trg_questions_set_updated_at
    BEFORE UPDATE ON questions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
