-- ============================================================================
-- Migration: 20260101000031_ai_jobs.sql
-- Purpose:   Create the `ai_jobs` table — the AI-operation audit log that
--            records each AI job's type, status, model, timing and retry
--            metadata (Req 20.6). This is the Milestone 4 (AI Features)
--            audit-trail data-model migration of MSS LivePulse.
--
-- Ordering: this migration MUST sort AFTER
--   20260101000030_ai_provider_settings.sql because:
--     * …030 CREATES the `ai_job_type` and `ai_job_status` enum types that the
--       `job_type` and `status` columns below reference. This migration does
--       NOT (re)define those enums — it relies on …030 having created them.
--   It must also sort after 20260101000002_events.sql because `ai_jobs.event_id`
--   carries a foreign key to `events(id)`. The 20260101000031 timestamp places
--   it after both, so all referenced types and tables already exist.
--
-- Scope (Task 26.2 only):
--   * Create ONLY the `ai_jobs` table, its FK/CHECK constraints and the
--     `idx_ai_jobs_event` lookup index.
--   * No enums are (re)defined here (owned by …030).
--   * No RLS / policies are added here.
--
-- PRIVACY — NO CREDENTIALS, NO PROMPT TEXT (Req 12.9, 20.7):
--   `ai_jobs` stores ONLY sanitised operational metadata. It NEVER stores
--   provider credentials (API keys, secret references, encrypted material) and
--   NEVER stores full prompt text or model input/output. The only free-text
--   column, `sanitised_error`, holds a scrubbed error summary — sanitised of
--   any secrets or prompt content before it is written (Req 12.9, 20.7).
--
-- Requirements: 14.6, 19.3, 20.6, 20.7, 12.9
-- Design ref:  Data Models → `ai_jobs` table.
--
-- Idempotency: the table is guarded with IF NOT EXISTS, the index with
-- IF NOT EXISTS, and constraints are declared inline in the CREATE TABLE so
-- the migration is safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ai_jobs — one row per AI operation, holding sanitised audit metadata only.
--   Depends on the `ai_job_type` and `ai_job_status` enums created by
--   20260101000030_ai_provider_settings.sql (see Ordering note above).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_jobs (
    -- Unique audit-record id.
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),                 -- Req 20.6

    -- Optional event this AI job relates to. Nullable because some AI
    -- operations are not scoped to a single event. When the referenced event is
    -- deleted, its AI-job audit rows are removed as well (ON DELETE CASCADE),
    -- consistent with the event-delete behaviour elsewhere.
    event_id        uuid          NULL
                                  REFERENCES events (id) ON DELETE CASCADE,             -- Req 20.6

    -- The category of AI job (enum from …030) — e.g. summarisation, moderation.
    job_type        ai_job_type   NOT NULL,                                             -- Req 20.6

    -- The current lifecycle status of the job (enum from …030).
    status          ai_job_status NOT NULL,                                             -- Req 20.6

    -- The AI model identifier used for the job. Free-form, sanitised metadata —
    -- NOT a credential.
    model_id        text          NULL,                                                 -- Req 20.6

    -- UTC timestamp of when the job started (Req 20.6).
    started_at      timestamptz   NOT NULL DEFAULT now(),                               -- Req 20.6

    -- UTC timestamp of when the job ended; NULL while still running (Req 20.6).
    ended_at        timestamptz   NULL,                                                 -- Req 20.6

    -- Number of attempts made for this job (retry accounting). Must be
    -- non-negative (Req 14.6, 19.3).
    attempt_count   integer       NOT NULL DEFAULT 0
                                  CHECK (attempt_count >= 0),                           -- Req 14.6, 19.3

    -- SANITISED error summary ONLY (Req 12.9, 20.7): scrubbed of any secrets,
    -- credentials or prompt/model text before being written here. NEVER stores
    -- full prompt text or credentials.
    sanitised_error text          NULL                                                  -- Req 20.7, 12.9
);

-- Index supporting lookups of AI-job audit rows scoped to a given event.
CREATE INDEX IF NOT EXISTS idx_ai_jobs_event
    ON ai_jobs (event_id);                                                              -- Req 20.6
