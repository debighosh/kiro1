-- ============================================================================
-- Migration: 20260101000032_question_clusters.sql
-- Purpose:   Create the `question_clusters` table — one row per AI-generated
--            (or presenter-curated) cluster of related questions within an
--            event — and THEN attach the DEFERRED foreign key on the existing
--            `questions.cluster_id` column, a Milestone 4 (AI Features)
--            data-model migration of MSS LivePulse.
--
-- This migration MUST sort AFTER 20260101000031_ai_jobs.sql (and after
-- 20260101000002_events.sql, which defines both the `events` table this table
-- references and the reusable `set_updated_at()` trigger function reused here,
-- and after 20260101000009_questions.sql, which created the `questions` table
-- and its plain nullable `cluster_id` column whose FK is added below).
--
-- Scope (Task 26.3):
--   * Create the `question_clusters` table with all columns, PK, the
--     `event_id` FK → events(id) ON DELETE CASCADE, and the label CHECK
--     constraint per design                                    (Req 16.1, 16.7).
--   * Add the `idx_question_clusters_event` secondary index on `event_id`.
--   * Attach the existing reusable BEFORE UPDATE `set_updated_at()` trigger to
--     `question_clusters` (Req 3.4 — keep `updated_at` current on every update).
--   * Add the DEFERRED foreign key on the existing `questions.cluster_id`
--     column: FK → question_clusters(id) ON DELETE SET NULL     (Req 16.4, 16.9).
--
-- DECISION — the deferred `questions.cluster_id` foreign key:
--   The design lists `questions.cluster_id` as `FK → question_clusters(id)
--   ON DELETE SET NULL`. However, `question_clusters` is this Milestone-4
--   table, which did not exist when the Milestone-2 questions migration
--   (20260101000009_questions.sql, ~line 89) ran; that migration therefore
--   DELIBERATELY declared `cluster_id` as a PLAIN nullable `uuid` with NO
--   foreign key and documented (see its header DECISION note + the tasks.md
--   Notes decision) that the FK would be DEFERRED to this M4 clusters
--   migration. This migration introduces that FK now, once the referenced
--   table exists. `ON DELETE SET NULL` means deleting a cluster leaves its
--   member questions intact and simply clears their `cluster_id`, rather than
--   cascading the delete to the questions (Req 16.4, 16.9). The single-
--   membership model (a question belongs to at most one cluster) is expressed
--   by the single nullable `cluster_id` column on `questions`.
--
-- Requirements: 16.1, 16.4, 16.7, 16.9, 16.10, 3.4
-- Design ref:  Data Models → `question_clusters` table; single-membership via
--              `questions.cluster_id` FK ON DELETE SET NULL; Notes decision on
--              the deferred cluster FK.
--
-- Idempotency: the table is guarded with IF NOT EXISTS, the index with
-- IF NOT EXISTS, the trigger is dropped-then-created, and the deferred FK is
-- added inside a DO $$ block that first checks pg_constraint so re-running the
-- migration neither errors nor duplicates the constraint.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- question_clusters — one row per cluster of related questions within an event
-- (Req 16.1, 16.7). Each cluster has a human-readable `label` (1–100 chars).
-- Deleting the parent event cascades to its clusters (ON DELETE CASCADE);
-- deleting a cluster clears (does NOT delete) its member questions via the
-- deferred `questions.cluster_id` FK ON DELETE SET NULL added below.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_clusters (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),                  -- Req 16.1
    event_id   uuid        NOT NULL
                           REFERENCES events (id) ON DELETE CASCADE,               -- Req 16.1, 16.7
    label      text        NOT NULL
                           CONSTRAINT question_clusters_label_length_chk
                               CHECK (char_length(label) BETWEEN 1 AND 100),       -- Req 16.1, 16.10
    created_at timestamptz NOT NULL DEFAULT now(),                                 -- Req 3.4
    updated_at timestamptz NOT NULL DEFAULT now()                                  -- Req 3.4
);

-- Secondary index to look up all clusters belonging to an event (Req 16.1).
CREATE INDEX IF NOT EXISTS idx_question_clusters_event
    ON question_clusters (event_id);

-- Refresh updated_at on every UPDATE to question_clusters (Req 3.4), reusing
-- the table-agnostic set_updated_at() trigger function created in
-- 20260101000002_events.sql (NOT redefined here).
DROP TRIGGER IF EXISTS trg_question_clusters_set_updated_at ON question_clusters;
CREATE TRIGGER trg_question_clusters_set_updated_at
    BEFORE UPDATE ON question_clusters
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- Deferred foreign key: questions.cluster_id → question_clusters(id)
-- ============================================================================
-- The M2 questions migration declared `cluster_id` as a plain nullable uuid
-- with NO FK because question_clusters did not yet exist (see the DECISION
-- note at the top of this file). Now that question_clusters exists, add the
-- foreign key with ON DELETE SET NULL so deleting a cluster clears — but does
-- NOT delete — its member questions (Req 16.4, 16.9).
--
-- Wrapped in a DO $$ block that checks pg_constraint for the constraint name
-- first, so the migration is safe to re-run: the FK is added only if it is
-- not already present.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'questions_cluster_id_fkey'
           AND conrelid = 'questions'::regclass
    ) THEN
        ALTER TABLE questions
            ADD CONSTRAINT questions_cluster_id_fkey
            FOREIGN KEY (cluster_id)
            REFERENCES question_clusters (id)
            ON DELETE SET NULL;
    END IF;
END
$$;
