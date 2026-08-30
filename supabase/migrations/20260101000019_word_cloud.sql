-- ============================================================================
-- Migration: 20260101000019_word_cloud.sql
-- Purpose:   Create the `wordcloud_status` enumerated type and the
--            `word_cloud_prompts` and `word_cloud_responses` tables — the
--            Word Cloud data-model migration of MSS LivePulse Milestone 3
--            (Polls & Word Cloud).
--
-- This migration MUST sort AFTER 20260101000018_poll_responses.sql (the last
-- Polls migration, authored by another task) and, transitively, after
-- 20260101000002_events.sql, which defines both the `events` table these
-- tables reference and the reusable `set_updated_at()` trigger function
-- reused here.
--
-- Scope (Task 19.4 only):
--   * Create the `wordcloud_status` enum ('draft','open','closed')   (Req 6.3).
--   * Create the `word_cloud_prompts` table with all columns, PK, the
--     `event_id` FK → events(id) ON DELETE CASCADE, and CHECK constraints per
--     design, plus the partial UNIQUE index enforcing at-most-one-open-prompt
--     per event                                                (Req 6.5).
--   * Create the `word_cloud_responses` table with all columns, PK, the
--     `prompt_id` FK → word_cloud_prompts(id) ON DELETE CASCADE, the
--     `event_id` FK → events(id) ON DELETE CASCADE (RLS scoping), the
--     one-response-per-participant-per-prompt UNIQUE constraint (Req 6.9),
--     and the `idx_wc_responses_prompt` lookup index (Req 23.3).
--   * Attach the existing reusable BEFORE UPDATE `set_updated_at()` trigger to
--     BOTH tables (keep `updated_at` current on every update).
--
-- AUTHORITATIVE SINGLE-OPEN-PROMPT ENFORCEMENT (Req 6.5):
--   The partial UNIQUE index `one_open_prompt_per_event` below is the
--   AUTHORITATIVE, DB-level guarantee that at most one word-cloud prompt per
--   event can be in the `'open'` status at a time. A second attempt to open a
--   prompt for the same event is rejected by this index. Application code MUST
--   NOT be trusted as the sole enforcer.
--
-- AUTHORITATIVE ONE-RESPONSE ENFORCEMENT (Req 6.9):
--   The UNIQUE (participant_identifier, prompt_id) constraint is the
--   AUTHORITATIVE, DB-level enforcement of the "one response per participant
--   per prompt" rule; changing a response is an upsert that replaces the prior
--   submission.
--
-- PRIVACY (Req 2.5, 21.18):
--   `participant_identifier` is an OPAQUE, high-entropy anonymous token that
--   carries NO personal data. The `event_id` column on `word_cloud_responses`
--   duplicates the parent prompt's event so event-scoped RLS policies (Task
--   20.3) can gate responses to a live event without a join.
--
-- NORMALISED TEXT (Req 6.10):
--   `normalised_text` is COMPUTED ON WRITE by the submit RPC — it has NO DB
--   default. Aggregation groups by `normalised_text` where `is_hidden = false`
--   and the term is not a stop word (Req 6.11, 6.13, 6.14).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * RLS enablement / policies for both tables                  (Task 20.3).
--   * The static single-open-prompt guard                        (Task 19.5).
--   * The submit-response / normalisation RPC.
--
-- Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.8, 6.9, 6.12, 22.4, 23.3
-- Design ref:  Data Models → `word_cloud_prompts` / `word_cloud_responses`
--              tables; single-open-prompt partial unique index; enum
--              `wordcloud_status`.
--
-- Idempotency: the enum is guarded with a DO $$ IF NOT EXISTS block, the
-- tables and indexes with IF NOT EXISTS, and the UNIQUE constraints are
-- declared inline in the CREATE TABLE so the migration is safe to re-run.
-- ============================================================================

-- wordcloud_status — lifecycle of a word-cloud prompt (Req 6.3): a prompt is
-- draft (not yet accepting responses), open (collecting responses), or closed
-- (collection ended).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wordcloud_status') THEN
        CREATE TYPE wordcloud_status AS ENUM (
            'draft',
            'open',
            'closed'
        );
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- word_cloud_prompts — one row per word-cloud prompt on an event (Req 6).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS word_cloud_prompts (
    id                                uuid             PRIMARY KEY DEFAULT gen_random_uuid(),          -- Req 6.1
    event_id                          uuid             NOT NULL
                                                       REFERENCES events (id) ON DELETE CASCADE,       -- Req 6.1, 21.18
    prompt_text                       text             NOT NULL
                                                       CONSTRAINT word_cloud_prompts_prompt_text_length_chk
                                                           CHECK (char_length(prompt_text) BETWEEN 1 AND 200), -- Req 6.1, 6.2
    max_words_per_response            integer          NOT NULL
                                                       CONSTRAINT word_cloud_prompts_max_words_chk
                                                           CHECK (max_words_per_response BETWEEN 1 AND 10),    -- Req 6.1, 6.2
    status                            wordcloud_status NOT NULL DEFAULT 'draft',                        -- Req 6.3
    results_visible_while_collecting  boolean          NOT NULL,                                        -- Req 6.1
    created_at                        timestamptz      NOT NULL DEFAULT now(),                          -- Req 6.1
    updated_at                        timestamptz      NOT NULL DEFAULT now()                           -- Req 6.1
);

-- AUTHORITATIVE at-most-one-open-prompt-per-event rule (Req 6.5): this partial
-- UNIQUE index is the single source of truth. Only rows with status = 'open'
-- participate in the uniqueness check, so an event may have many draft/closed
-- prompts but at most one open prompt at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_prompt_per_event
    ON word_cloud_prompts (event_id)
    WHERE status = 'open';                                                                              -- Req 6.5

-- Refresh updated_at on every UPDATE to word_cloud_prompts, reusing the
-- table-agnostic set_updated_at() trigger function created in
-- 20260101000002_events.sql.
DROP TRIGGER IF EXISTS trg_word_cloud_prompts_set_updated_at ON word_cloud_prompts;
CREATE TRIGGER trg_word_cloud_prompts_set_updated_at
    BEFORE UPDATE ON word_cloud_prompts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- word_cloud_responses — one row per participant submission to a prompt
-- (Req 6.6–6.13).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS word_cloud_responses (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),                 -- Req 6.6
    prompt_id              uuid        NOT NULL
                                       REFERENCES word_cloud_prompts (id) ON DELETE CASCADE,  -- Req 6.6
    -- event_id duplicates the parent prompt's event so event-scoped RLS
    -- policies (Task 20.3) can gate responses to a live event without a join.
    event_id               uuid        NOT NULL
                                       REFERENCES events (id) ON DELETE CASCADE,              -- Req 21.18 (RLS scoping)
    -- participant_identifier is an opaque, high-entropy anonymous token that
    -- carries NO personal data (Req 2.5).
    participant_identifier text        NOT NULL,                                              -- Req 6.6, 2.5
    raw_text               text        NOT NULL
                                       CONSTRAINT word_cloud_responses_raw_text_length_chk
                                           CHECK (char_length(raw_text) BETWEEN 1 AND 50),     -- Req 6.6, 6.8, 22.4
    -- normalised_text is COMPUTED ON WRITE by the submit RPC (Req 6.10); it has
    -- NO DB default. Aggregation groups by this column (Req 6.11, 6.13, 6.14).
    normalised_text        text        NOT NULL,                                              -- Req 6.10
    is_hidden              boolean     NOT NULL DEFAULT false,                                 -- Req 6.12, 6.13
    created_at             timestamptz NOT NULL DEFAULT now(),                                -- Req 6.6
    updated_at             timestamptz NOT NULL DEFAULT now(),                                -- Req 6.6
    -- AUTHORITATIVE one-response-per-participant-per-prompt rule (Req 6.9):
    -- this DB-level UNIQUE constraint is the single source of truth; changing
    -- a response is an upsert that replaces the prior submission.
    CONSTRAINT uq_word_cloud_responses_participant_prompt
        UNIQUE (participant_identifier, prompt_id)                                            -- Req 6.9
);

-- Secondary lookup index for reading/aggregating a prompt's responses (Req 23.3).
CREATE INDEX IF NOT EXISTS idx_wc_responses_prompt
    ON word_cloud_responses (prompt_id);                                                      -- Req 23.3

-- Refresh updated_at on every UPDATE to word_cloud_responses, reusing the
-- table-agnostic set_updated_at() trigger function created in
-- 20260101000002_events.sql.
DROP TRIGGER IF EXISTS trg_word_cloud_responses_set_updated_at ON word_cloud_responses;
CREATE TRIGGER trg_word_cloud_responses_set_updated_at
    BEFORE UPDATE ON word_cloud_responses
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
