-- ============================================================================
-- Migration: 20260101000026_word_cloud_respond_rpc.sql
-- Purpose:   Implement the server-side word-cloud response upsert RPC for MSS
--            LivePulse (Task 22.3, Milestone 3 — Polls & Word Cloud). This is a
--            single `SECURITY DEFINER` PostgreSQL function that anonymous
--            participants invoke to submit (or update) their one response to an
--            OPEN word-cloud prompt. It performs, in order:
--              1. Server-side rate limiting (30 responses / 60 s).
--              2. Prompt-must-exist-and-be-'open' gating.
--              3. Event-must-be-live gating.
--              4. Length validation (1–50 code points after trim).
--              5. NORMALISATION of the trimmed text on write.
--              6. UPSERT on UNIQUE (participant_identifier, prompt_id).
--
-- Ordering: This migration is named `…000026_…` so it sorts (byte-lexicographic,
--           matching the Supabase CLI's directory read order) AFTER every
--           earlier Milestone 3 migration — in particular after
--           `20260101000019_word_cloud.sql` (the `word_cloud_prompts` /
--           `word_cloud_responses` tables + the
--           `uq_word_cloud_responses_participant_prompt` UNIQUE constraint this
--           RPC upserts on) and after `20260101000024_word_cloud_prompt_rpc.sql`
--           (the admin prompt-lifecycle RPC). It also depends on:
--             * `events` (…000002)              — for the live-event gating.
--             * `event_is_live(uuid)` (…000006) — live gating helper.
--             * `check_and_record_rate_limit(text, text, uuid, int, int)`
--               (…000013_rate_limiting)         — the shared rate-limit primitive.
--           All of the above sort before `…000026`, so the ordering is sound.
--           (No `…000025` file exists yet; `…000026` still sorts after `…000024`,
--           which is the only ordering requirement.)
--
-- Scope (Task 22.3 ONLY):
--   * Implements ONLY the word-cloud response upsert / normalisation RPC. It
--     deliberately does NOT implement the moderator hide/unhide + broadcast
--     (Task 22.4) or any client UI.
--
-- ----------------------------------------------------------------------------
-- RATE-LIMIT ACTION TYPE — IMPORTANT COMPATIBILITY NOTE
-- ----------------------------------------------------------------------------
--   The shared rate-limit primitive `check_and_record_rate_limit(...)` and the
--   `rate_events.action` CHECK constraint (both defined in
--   20260101000013_rate_limiting.sql) currently accept ONLY the action values
--   `'submit_question'` and `'vote'`. The generic function explicitly returns
--   FALSE for any other action value, and the CHECK constraint would reject an
--   insert of any other value. Introducing a brand-new `'wordcloud_response'`
--   action would therefore make EVERY word-cloud response fail as
--   `rate_limited` (the limiter returns FALSE before any insert) — and it would
--   also require editing the rate-limiting migration, which is out of scope for
--   Task 22.3 (this task creates ONLY this file).
--
--   To keep this migration self-contained AND functional, the word-cloud
--   response action REUSES the existing `'vote'` rate-limit bucket. This is a
--   natural fit: the intended word-cloud limit (30 actions / 60 s) is exactly
--   the vote limit (Req 21.14), and word-cloud responses are, like votes, a
--   high-frequency anonymous participant interaction. The limit is scoped to
--   the resolved event id so it is per-event. If a future task widens the
--   allowed action set (e.g. adds a dedicated `'wordcloud_response'` value to
--   both the CHECK constraint and the primitive's allow-list), this call can be
--   switched to that value with no other change here.
--
-- ----------------------------------------------------------------------------
-- Behaviour and requirements traceability
-- ----------------------------------------------------------------------------
--   * Rate limiting (Req 21.13–21.15): the function first resolves the prompt's
--     event id (needed for scoping + the rate-limit key + the live-event check)
--     and then calls
--       check_and_record_rate_limit(p_participant_identifier, 'vote',
--                                   v_event_id, 30, 60)
--     — 30 actions / 60 s, event-scoped. If it returns FALSE the limit is
--     exceeded: the function RAISES 'rate_limited' (SQLSTATE P0001) and PERSISTS
--     NOTHING (the primitive itself records nothing when it returns FALSE). This
--     runs FIRST so an abusive client is throttled before any other work.
--
--   * Prompt must exist and be 'open' (Req 6.7): the prompt is loaded (status +
--     event_id). A missing prompt RAISES 'prompt_not_found'. A prompt whose
--     status <> 'open' RAISES 'prompt_not_open' and any prior response is
--     RETAINED unchanged (the function neither modifies nor deletes it).
--
--   * Event must be live (Req 6.7 gating): if NOT event_is_live(v_event_id) the
--     function RAISES 'event_not_live'. (event_is_live returns FALSE for an
--     unknown event, but the prompt's FK to events guarantees it exists here.)
--
--   * Length validation (Req 6.8): the raw text is trimmed of leading/trailing
--     whitespace; the trimmed value must be BETWEEN 1 AND 50 Unicode code points
--     (`char_length` counts code points). Empty / whitespace-only / over-length
--     input RAISES 'invalid_length' and RETAINS any previously stored response
--     (nothing is deleted or modified). NULL raw text is treated as invalid.
--
--   * Normalise on write (Req 6.10): `normalised_text` is computed from the
--     TRIMMED raw text using the SAME rule as the client-side twin
--     `src/lib/wordcloud.ts` `normalise()`: lower-case all letters, trim, and
--     collapse each run of internal whitespace to a single ASCII space. In SQL:
--       v_normalised := btrim(regexp_replace(lower(v_trimmed), '\s+', ' ', 'g'))
--     src/lib/wordcloud.ts is the CLIENT-SIDE TWIN of this rule; both MUST stay
--     in sync — if you change the rule here, change it there too (and vice
--     versa). Because the trimmed value is already 1–50 non-whitespace-bounded
--     characters, the normalised value is also non-empty.
--
--   * Upsert on UNIQUE (participant_identifier, prompt_id) (Req 6.6, 6.9): the
--     function does
--       INSERT ... ON CONFLICT (participant_identifier, prompt_id)
--         DO UPDATE SET raw_text = EXCLUDED.raw_text,
--                       normalised_text = EXCLUDED.normalised_text
--     storing raw_text = the TRIMMED value, normalised_text = the computed
--     value, event_id = the resolved event id, and (on INSERT) is_hidden =
--     false via the column default. Changing a response is an upsert that
--     replaces the prior submission's text (Req 6.9). `updated_at` is refreshed
--     automatically by the existing BEFORE UPDATE `set_updated_at` trigger
--     (…000019), so it is intentionally OMITTED from the DO UPDATE SET.
--
--     MODERATION PRESERVED ACROSS RESUBMIT: the DO UPDATE deliberately does NOT
--     touch `is_hidden`. If a moderator hid an entry (is_hidden = true) and the
--     participant then resubmits, the entry STAYS hidden — resubmitting text
--     must not silently un-hide a moderated entry (Req 6.12/6.13 intent).
--
--   * The resulting `word_cloud_responses` row (created or updated) is returned
--     so the caller has id, timestamps, normalised_text, is_hidden, etc.
--
-- Error signals (for the client / Edge layer to map), all SQLSTATE 'P0001'
-- (raise_exception) with the MESSAGE set to the signal string:
--   * 'rate_limited'    — too many responses in the window (→ HTTP 429).
--   * 'prompt_not_found'— no such prompt (→ 404/409).
--   * 'prompt_not_open' — prompt exists but is draft/closed; prior response
--                         retained (→ 409).
--   * 'event_not_live'  — the prompt's event is not live (→ 403/409).
--   * 'invalid_length'  — trimmed text empty/whitespace-only/over-length; any
--                         prior response retained (→ 400, 1–50 char constraint).
--
-- Security model:
--   * SECURITY DEFINER with `SET search_path = public, pg_temp` so the function
--     can insert/update `word_cloud_responses` (which has event-scoped RLS with
--     no direct anonymous write policy — Task 20.3) on behalf of anonymous
--     callers, and cannot be hijacked via a caller-controlled search_path.
--   * EXECUTE is granted to `anon` AND `authenticated` because anonymous
--     participants submit word-cloud responses (like question submit); an
--     authenticated user may also.
--
-- Design ref: Request/data flows → "Word cloud — one response per participant,
--             updatable while open" (rate-limit → prompt open + event live →
--             1–50 length → normalise on write → upsert on the participant/
--             prompt unique key; hidden entries stay hidden on resubmit).
--
-- Requirements: 6.6, 6.7, 6.8, 6.9, 6.10, 21.13, 21.14, 21.15, 23.8.
--
-- Idempotency (of the migration itself): CREATE OR REPLACE FUNCTION + guarded
--   grants make it safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- submit_word_cloud_response(
--     p_prompt_id              uuid,
--     p_participant_identifier text,
--     p_raw_text               text
-- ) RETURNS word_cloud_responses
--
-- Returns the full created-or-updated word_cloud_responses row so the caller
-- has the id, normalised_text, is_hidden, timestamps, etc. Idempotency is
-- provided directly by the (participant_identifier, prompt_id) UNIQUE upsert —
-- a re-submit updates the participant's single row rather than inserting a
-- duplicate — so no separate submission_key is needed (Req 6.9, 23.8).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_word_cloud_response(
    p_prompt_id              uuid,
    p_participant_identifier text,
    p_raw_text               text
)
RETURNS word_cloud_responses
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status     wordcloud_status;
    v_event_id   uuid;
    v_trimmed    text;
    v_len        int;
    v_normalised text;
    v_row        word_cloud_responses%ROWTYPE;
BEGIN
    -- Defensive: an absent participant identifier or prompt id cannot be
    -- rate-limited/gated meaningfully — reject as prompt_not_found.
    IF p_participant_identifier IS NULL OR p_prompt_id IS NULL THEN
        RAISE EXCEPTION 'prompt_not_found' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- Resolve the prompt's event id FIRST. It is needed for (a) the rate-limit
    -- key/scoping, (b) the live-event check, and (c) the response row's
    -- event_id (RLS scoping). We also capture the prompt status here so the
    -- open-gating check below reuses the same lookup.
    -- ------------------------------------------------------------------------
    SELECT wcp.status, wcp.event_id
      INTO v_status, v_event_id
      FROM word_cloud_prompts wcp
     WHERE wcp.id = p_prompt_id;

    -- Missing prompt (Req 6.7).
    IF NOT FOUND THEN
        RAISE EXCEPTION 'prompt_not_found' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1. Rate limit FIRST (Req 21.13–21.15). Reuse the shared 'vote' bucket
    --    (30 / 60 s, event-scoped) — see the RATE-LIMIT ACTION TYPE note in the
    --    header for why we reuse 'vote' rather than a new action value. On
    --    exceed the primitive returns FALSE and records nothing; we reject and
    --    persist nothing further.
    -- ------------------------------------------------------------------------
    IF NOT check_and_record_rate_limit(
               p_participant_identifier,
               'vote',
               v_event_id,
               30,   -- max responses in the window (reuses the vote limit, Req 21.14)
               60    -- window seconds (Req 21.14)
           ) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 2. Prompt must be 'open' (Req 6.7). A draft/closed prompt is rejected and
    --    any prior response is RETAINED unchanged (we neither modify nor delete
    --    it — we simply do not write).
    -- ------------------------------------------------------------------------
    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'prompt_not_open' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 3. Event must be live (Req 6.7 gating). The prompt's FK guarantees the
    --    event exists; this enforces the live window.
    -- ------------------------------------------------------------------------
    IF NOT event_is_live(v_event_id) THEN
        RAISE EXCEPTION 'event_not_live' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 4. Length validation (Req 6.8). Trim surrounding whitespace; the trimmed
    --    value must be 1–50 Unicode code points. Empty / whitespace-only /
    --    over-length input is rejected and any previously stored response is
    --    RETAINED (nothing deleted or modified).
    -- ------------------------------------------------------------------------
    IF p_raw_text IS NULL THEN
        RAISE EXCEPTION 'invalid_length' USING ERRCODE = 'P0001';
    END IF;

    v_trimmed := btrim(p_raw_text);
    v_len := char_length(v_trimmed);
    IF v_len < 1 OR v_len > 50 THEN
        RAISE EXCEPTION 'invalid_length' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 5. Normalise on write (Req 6.10). Lower-case, trim, and collapse internal
    --    whitespace runs to a single space — the SAME rule as the client-side
    --    twin src/lib/wordcloud.ts normalise(). Both MUST stay in sync.
    -- ------------------------------------------------------------------------
    v_normalised := btrim(regexp_replace(lower(v_trimmed), '\s+', ' ', 'g'));

    -- ------------------------------------------------------------------------
    -- 6. Upsert on UNIQUE (participant_identifier, prompt_id) (Req 6.6, 6.9).
    --    On INSERT: is_hidden uses its column default (false); updated_at/
    --    created_at use their defaults. On CONFLICT (a resubmit): update ONLY
    --    the text fields — updated_at is refreshed by the set_updated_at trigger
    --    and is_hidden is intentionally left untouched so a moderated (hidden)
    --    entry STAYS hidden across resubmission.
    -- ------------------------------------------------------------------------
    INSERT INTO word_cloud_responses (
        prompt_id,
        event_id,
        participant_identifier,
        raw_text,
        normalised_text
    )
    VALUES (
        p_prompt_id,
        v_event_id,
        p_participant_identifier,
        v_trimmed,
        v_normalised
    )
    ON CONFLICT ON CONSTRAINT uq_word_cloud_responses_participant_prompt
    DO UPDATE SET
        raw_text        = EXCLUDED.raw_text,
        normalised_text = EXCLUDED.normalised_text
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION submit_word_cloud_response(uuid, text, text) IS
    'Word-cloud response upsert RPC (Task 22.3; Req 6.6-6.10, 21.13-21.15, '
    '23.8). SECURITY DEFINER. Order: resolve prompt event_id -> rate-limit '
    '(30/60s, reuses the shared ''vote'' bucket) -> prompt must be ''open'' -> '
    'event must be live -> trim + 1-50 code-point length -> normalise on write '
    '(lower/trim/collapse internal whitespace, twin of src/lib/wordcloud.ts) -> '
    'upsert on UNIQUE (participant_identifier, prompt_id), preserving is_hidden '
    'on resubmit. Error signals (SQLSTATE P0001, MESSAGE): rate_limited, '
    'prompt_not_found, prompt_not_open, event_not_live, invalid_length.';

-- ----------------------------------------------------------------------------
-- Grants. Anonymous participants submit word-cloud responses, so EXECUTE is
-- granted to anon; authenticated users may also submit. The function is
-- SECURITY DEFINER and mediates the write into `word_cloud_responses` (which
-- has no direct anonymous write policy), so this grant does not expose any
-- direct table access.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION submit_word_cloud_response(uuid, text, text) TO anon;
GRANT EXECUTE ON FUNCTION submit_word_cloud_response(uuid, text, text) TO authenticated;
