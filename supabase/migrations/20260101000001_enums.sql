-- ============================================================================
-- Migration: 20260101000001_enums.sql
-- Purpose:   Create the enumerated types required for the Milestone 1 foundation
--            tables of MSS LivePulse.
--
-- This is the FIRST migration in the project; it must sort before the events
-- table and all later-milestone migrations, so its enums are available when
-- the foundation tables reference them.
--
-- Scope (Milestone 1 only):
--   * event_status     — event lifecycle states            (Req 1.5)
--   * moderation_mode  — pre- vs post-moderation of Q&A     (Req 3.6, 3.7)
--   * presenter_mode   — active presenter-view content mode (Req 7.4)
--
-- Later-milestone enums (question_status, poll_status, poll_results_visibility,
-- wordcloud_status, provider_type, ai_auth_type, ai_job_type, ai_job_status)
-- are intentionally NOT created here; they belong to the Milestone 2–4
-- migrations.
--
-- Design ref: Data Models → Enumerated types.
--
-- Idempotency: each CREATE TYPE is guarded with an IF NOT EXISTS check so the
-- migration is safe to re-run against a database where the type already exists.
-- ============================================================================

-- event_status — event lifecycle (Req 1.5)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status') THEN
        CREATE TYPE event_status AS ENUM ('draft', 'live', 'ended', 'archived');
    END IF;
END
$$;

-- moderation_mode — pre-moderation vs post-moderation of questions (Req 3.6, 3.7)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_mode') THEN
        CREATE TYPE moderation_mode AS ENUM ('pre', 'post');
    END IF;
END
$$;

-- presenter_mode — the content currently shown by the presenter view (Req 7.4)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'presenter_mode') THEN
        CREATE TYPE presenter_mode AS ENUM (
            'join',
            'featured_question',
            'top_questions',
            'poll_results',
            'word_cloud',
            'ai_themes',
            'waiting'
        );
    END IF;
END
$$;
