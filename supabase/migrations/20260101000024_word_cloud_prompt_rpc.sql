-- ============================================================================
-- Migration: 20260101000024_word_cloud_prompt_rpc.sql
-- Purpose:   Implement the server-side word-cloud PROMPT LIFECYCLE RPCs for
--            MSS LivePulse (Task 22.2, Milestone 3 — Polls & Word Cloud). Two
--            admin-only `SECURITY DEFINER` PostgreSQL functions:
--              1. create_word_cloud_prompt(...) — validate + create a prompt in
--                 status 'draft'.
--              2. set_word_cloud_prompt_status(...) — advance a prompt along the
--                 draft → open → closed lifecycle, guarded by the single-open
--                 partial unique index.
--
-- Ordering: This migration is named `…000024_…` so it sorts (byte-lexicographic,
--           matching the Supabase CLI's directory read order) AFTER every
--           `…000022_*`/`…000023_*` file — in particular after
--           `20260101000023_create_poll_rpc.sql` (the poll-create RPC, authored
--           by a concurrent task, whose admin-authorisation pattern this file
--           mirrors). It depends on:
--             * `word_cloud_prompts` table + the partial UNIQUE index
--               `one_open_prompt_per_event` WHERE status='open'
--               (…000019_word_cloud.sql)                 — insert target / guard.
--             * `wordcloud_status` enum ('draft','open','closed')
--               (…000019_word_cloud.sql)                 — status param / column.
--           Both sort before `…000024`, so the ordering is sound.
--
-- Scope (Task 22.2 ONLY):
--   * Implements ONLY the prompt create + open/close lifecycle RPCs. It
--     deliberately does NOT implement the response upsert RPC (Task 22.3) nor
--     the entry hide/unhide moderation RPC / aggregation broadcast (Task 22.4).
--
-- ----------------------------------------------------------------------------
-- Behaviour and requirements traceability
-- ----------------------------------------------------------------------------
--   create_word_cloud_prompt (Req 6.1, 6.2, 6.3):
--     * Validates prompt_text is 1–200 Unicode code points; on failure RAISES
--       'invalid_prompt_text' and creates NO prompt.
--     * Validates max_words_per_response BETWEEN 1 AND 10; on failure RAISES
--       'invalid_max_words' and creates NO prompt.
--     * On success inserts the prompt in status 'draft' (Req 6.3) and returns
--       the created row. (The table CHECK constraints back-stop the same
--       bounds; validating here lets us return a precise, field-specific
--       error signal before touching the table.)
--
--   set_word_cloud_prompt_status (Req 6.4, 6.5, 21.6):
--     * Loads the prompt's current status first; if the prompt does not exist
--       RAISES 'prompt_not_found'.
--     * Enforces the lifecycle draft → open → closed. Only draft→open and
--       open→closed are permitted; a no-op same-status set is also allowed.
--       ANY other transition (e.g. closed→open, open→draft, closed→draft,
--       draft→closed) RAISES 'invalid_transition' and changes nothing.
--     * When transitioning TO 'open', the AUTHORITATIVE at-most-one-open-prompt
--       -per-event rule is the partial UNIQUE index `one_open_prompt_per_event`
--       (…000019). The UPDATE ... SET status='open' is wrapped in a
--       BEGIN ... EXCEPTION WHEN unique_violation block: a second open prompt
--       for the same event trips the index (SQLSTATE 23505), which we CATCH and
--       re-RAISE as 'prompt_already_open' (SQLSTATE P0001), leaving BOTH
--       prompts' statuses unchanged (Req 6.5).
--     * Returns the updated row.
--
-- Error signals (for the client / Edge layer to map). All raised with SQLSTATE
-- 'P0001' (raise_exception) and MESSAGE set to the signal string so callers can
-- switch on the message:
--   * 'invalid_prompt_text' — prompt_text NULL / empty / > 200 code points
--                             (→ 400); no prompt created.
--   * 'invalid_max_words'   — max_words_per_response NULL / outside 1–10
--                             (→ 400); no prompt created.
--   * 'prompt_not_found'    — no word_cloud_prompt with the given id (→ 404).
--   * 'invalid_transition'  — requested status change is not draft→open→closed
--                             (→ 409); nothing changed.
--   * 'prompt_already_open' — another prompt for the same event is already
--                             'open' (→ 409); both statuses unchanged (Req 6.5).
--
-- Security model:
--   * Both functions are SECURITY DEFINER with `SET search_path = public,
--     pg_temp` so they mediate writes to `word_cloud_prompts` (which has RLS
--     with no anonymous/authenticated INSERT/UPDATE policy — Task 20.3) and
--     cannot be hijacked via a caller-controlled search_path.
--   * ADMIN AUTHORISATION: EXECUTE is granted to `authenticated` ONLY (NOT
--     anon), mirroring the poll-create RPC. In V1 ANY authenticated user is
--     treated as an admin; a finer-grained admin role/claim check is a future
--     hardening step. Anonymous participants cannot manage prompt lifecycle.
--
-- Design ref: Request/data flows → "Word cloud — one prompt open at a time"
--             (draft → open → closed; opening a second prompt while one is open
--             is rejected); Data Models → single-open-prompt partial unique
--             index `one_open_prompt_per_event`.
--
-- Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 21.6.
--
-- Idempotency (of the migration itself): CREATE OR REPLACE FUNCTION + guarded
--   grants make it safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- create_word_cloud_prompt(
--     p_event_id                        uuid,
--     p_prompt_text                     text,
--     p_max_words_per_response          integer,
--     p_results_visible_while_collecting boolean
-- ) RETURNS word_cloud_prompts
--
-- Validates the inputs, then creates the prompt in status 'draft' and returns
-- the created row (id, status, timestamps, etc.).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_word_cloud_prompt(
    p_event_id                         uuid,
    p_prompt_text                      text,
    p_max_words_per_response           integer,
    p_results_visible_while_collecting boolean
)
RETURNS word_cloud_prompts
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_len int;
    v_row word_cloud_prompts%ROWTYPE;
BEGIN
    -- ------------------------------------------------------------------------
    -- Validate prompt_text: 1–200 Unicode code points (Req 6.1, 6.2).
    -- char_length counts code points. NULL, empty, or over-length is rejected
    -- and NO prompt is created.
    -- ------------------------------------------------------------------------
    IF p_prompt_text IS NULL THEN
        RAISE EXCEPTION 'invalid_prompt_text' USING ERRCODE = 'P0001';
    END IF;

    v_len := char_length(p_prompt_text);
    IF v_len < 1 OR v_len > 200 THEN
        RAISE EXCEPTION 'invalid_prompt_text' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- Validate max_words_per_response: BETWEEN 1 AND 10 (Req 6.1, 6.2).
    -- NULL or out-of-range is rejected and NO prompt is created.
    -- ------------------------------------------------------------------------
    IF p_max_words_per_response IS NULL
       OR p_max_words_per_response < 1
       OR p_max_words_per_response > 10 THEN
        RAISE EXCEPTION 'invalid_max_words' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- Insert the prompt in status 'draft' (Req 6.3). The status column DEFAULT
    -- is 'draft'; we set it explicitly to be unambiguous. The table CHECK
    -- constraints re-assert the 1–200 / 1–10 bounds as a back-stop.
    -- ------------------------------------------------------------------------
    INSERT INTO word_cloud_prompts (
        event_id,
        prompt_text,
        max_words_per_response,
        status,
        results_visible_while_collecting
    )
    VALUES (
        p_event_id,
        p_prompt_text,
        p_max_words_per_response,
        'draft'::wordcloud_status,
        p_results_visible_while_collecting
    )
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION create_word_cloud_prompt(uuid, text, integer, boolean) IS
    'Word-cloud prompt-create RPC (Task 22.2; Req 6.1-6.3). SECURITY DEFINER, '
    'admin-only (EXECUTE granted to authenticated only; V1 = any authenticated '
    'user is admin). Validates prompt_text 1-200 code points and '
    'max_words_per_response 1-10, then creates the prompt in status draft and '
    'returns the row. Error signals (SQLSTATE P0001, MESSAGE): '
    'invalid_prompt_text, invalid_max_words (no prompt created on failure).';

-- ----------------------------------------------------------------------------
-- set_word_cloud_prompt_status(
--     p_prompt_id uuid,
--     p_status    wordcloud_status
-- ) RETURNS word_cloud_prompts
--
-- Advances a prompt along the draft → open → closed lifecycle and returns the
-- updated row. Rejects any other transition. Opening a second prompt for the
-- same event while one is already open is rejected via the single-open partial
-- unique index, surfaced as 'prompt_already_open'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_word_cloud_prompt_status(
    p_prompt_id uuid,
    p_status    wordcloud_status
)
RETURNS word_cloud_prompts
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_current wordcloud_status;
    v_row     word_cloud_prompts%ROWTYPE;
BEGIN
    -- ------------------------------------------------------------------------
    -- Load the current status first so we can validate the requested
    -- transition (Req 6.4). A missing prompt is rejected with 'prompt_not_found'.
    -- ------------------------------------------------------------------------
    SELECT status INTO v_current
      FROM word_cloud_prompts
     WHERE id = p_prompt_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'prompt_not_found' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- Enforce the lifecycle draft → open → closed (Req 6.4). Permitted moves:
    --   * draft → open
    --   * open  → closed
    --   * X     → X      (idempotent no-op set to the same status)
    -- ANY other move (closed→open, open→draft, closed→draft, draft→closed) is
    -- rejected with 'invalid_transition' and NOTHING is changed.
    -- ------------------------------------------------------------------------
    IF p_status <> v_current
       AND NOT (
            (v_current = 'draft' AND p_status = 'open')
         OR (v_current = 'open'  AND p_status = 'closed')
       ) THEN
        RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- Apply the update. When transitioning TO 'open', the AUTHORITATIVE
    -- single-open-prompt-per-event guarantee is the partial UNIQUE index
    -- `one_open_prompt_per_event` (…000019). If another prompt for the same
    -- event is already open, this UPDATE trips the index and raises a
    -- unique_violation (SQLSTATE 23505); we CATCH it and re-RAISE as
    -- 'prompt_already_open' (SQLSTATE P0001), leaving BOTH prompts' statuses
    -- unchanged (the failed UPDATE is rolled back within the block) (Req 6.5).
    -- ------------------------------------------------------------------------
    IF p_status = 'open' AND v_current <> 'open' THEN
        BEGIN
            UPDATE word_cloud_prompts
               SET status = 'open'::wordcloud_status
             WHERE id = p_prompt_id
            RETURNING * INTO v_row;
        EXCEPTION
            WHEN unique_violation THEN
                RAISE EXCEPTION 'prompt_already_open' USING ERRCODE = 'P0001';
        END;
    ELSE
        UPDATE word_cloud_prompts
           SET status = p_status
         WHERE id = p_prompt_id
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION set_word_cloud_prompt_status(uuid, wordcloud_status) IS
    'Word-cloud prompt status-transition RPC (Task 22.2; Req 6.4, 6.5, 21.6). '
    'SECURITY DEFINER, admin-only (EXECUTE granted to authenticated only; V1 = '
    'any authenticated user is admin). Enforces the lifecycle draft->open->'
    'closed (loads current status first); opening a second prompt while one is '
    'open trips the one_open_prompt_per_event partial unique index. Error '
    'signals (SQLSTATE P0001, MESSAGE): prompt_not_found, invalid_transition, '
    'prompt_already_open (both statuses unchanged on the last).';

-- ----------------------------------------------------------------------------
-- Grants. ADMIN AUTHORISATION: prompt lifecycle management is an admin action,
-- so EXECUTE is granted to `authenticated` ONLY (NOT anon), mirroring the
-- poll-create RPC. V1 treats ANY authenticated user as an admin. The functions
-- are SECURITY DEFINER and mediate the writes to `word_cloud_prompts` (which
-- has no anonymous/authenticated write policy), so these grants do not expose
-- any direct table access.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION create_word_cloud_prompt(uuid, text, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION set_word_cloud_prompt_status(uuid, wordcloud_status) TO authenticated;
