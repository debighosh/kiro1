-- ============================================================================
-- Migration: 20260101000014_submit_question_rpc.sql
-- Purpose:   Implement the server-side question-submit RPC for MSS LivePulse
--            (Task 13.2, Milestone 2 — Core Live Q&A). This is a single
--            `SECURITY DEFINER` PostgreSQL function that anonymous participants
--            invoke to submit a question. It performs, in order:
--              1. Server-side rate limiting (default 10 submissions / 60 s).
--              2. Event-must-be-live gating (implies the event must exist).
--              3. Length validation (1–300 Unicode code points) + sanitisation.
--              4. Idempotent handling of a client-supplied submission_key.
--              5. Moderation-mode-driven initial status (pre → pending,
--                 post → approved).
--              6. Insert of the question and return of the created (or the
--                 idempotently-existing) row.
--
-- Ordering: This migration is named `…000014_…` so it sorts (byte-lexicographic,
--           matching the Supabase CLI's directory read order) AFTER every
--           `…000013_*` file — in particular after
--           `20260101000013_rate_limiting.sql`, which defines the
--           `check_submit_rate_limit(text, uuid)` helper this RPC calls. It also
--           depends on:
--             * `events` (…000002)                       — moderation_mode.
--             * `event_is_live(uuid)` (…000006)          — live gating.
--             * `questions` table (…000009_questions)    — insert target / row type.
--             * partial UNIQUE (event_id, submission_key) WHERE submission_key
--               IS NOT NULL, `uq_questions_event_submission_key`
--               (…000009_questions_indexes)              — idempotency backstop.
--           All of the above sort before `…000014`, so the ordering is sound.
--
-- Scope (Task 13.2 ONLY):
--   * Implements ONLY the question-submit RPC. It deliberately does NOT
--     implement the vote RPC (Task 13.3), the vote-count Realtime Broadcast
--     fan-out (Task 13.4), or any client submit UI (Task 15.1).
--
-- ----------------------------------------------------------------------------
-- Behaviour and requirements traceability
-- ----------------------------------------------------------------------------
--   * Rate limiting (Req 21.13): the function first calls
--     `check_submit_rate_limit(p_participant_identifier, p_event_id)` (default
--     10 submissions / 60 s). If it returns FALSE the limit is exceeded — the
--     function RAISES EXCEPTION with SQLSTATE 'P0001' and MESSAGE 'rate_limited'
--     and records/persists NOTHING further. The Edge/RPC layer maps this to a
--     429-style response. This runs FIRST so an abusive client is throttled
--     before any other work (and before the more expensive validation).
--
--   * Event must be live (Req 3.3): if NOT `event_is_live(p_event_id)` the
--     function RAISES 'event_not_live'. Because `event_is_live` returns FALSE
--     for a non-existent event, this also rejects submissions to unknown
--     events. The Edge/RPC layer maps this to a "submissions only accepted
--     while the event is live" error.
--
--   * Length + sanitisation (Req 3.1, 3.2, 22.1, 21.9, 21.10, 21.11):
--       - The text is trimmed of leading/trailing whitespace, and any C0/C1
--         control characters (except that any tab/newline/CR are first
--         collapsed to a single space) are stripped — a minimal allow-list
--         sanitisation that rejects control/executable payloads while keeping
--         ordinary Unicode text intact (Req 21.9).
--       - After sanitisation the length must be BETWEEN 1 AND 300 Unicode code
--         points (`char_length` counts code points — Req 22.1). An empty /
--         whitespace-only / control-only submission collapses to length 0 and
--         is rejected (Req 3.2). Over-length is rejected (Req 3.1, 21.10).
--       - On any failure the function RAISES 'invalid_length' and persists
--         NOTHING (Req 21.11). The whole submission is rejected.
--       - Storage-as-inert-text (Req 21.12) is a rendering concern enforced
--         client-side; the DB stores plain text only (never executes it).
--
--   * Idempotency (Req 23.8): when `p_submission_key` IS NOT NULL, a retried
--     submit for the same (event_id, submission_key) returns the EXISTING row
--     instead of inserting a duplicate. Implemented with
--     `INSERT … ON CONFLICT (event_id, submission_key)
--     WHERE submission_key IS NOT NULL DO NOTHING` followed by a SELECT of the
--     existing row when the insert is a no-op. The partial unique index
--     `uq_questions_event_submission_key` is the backstop. Note: because the
--     rate-limit check runs first, a genuine retry only returns the existing
--     row while the client is within its window; that is acceptable — the
--     idempotency guarantee (no duplicate row) always holds via the unique
--     index regardless.
--
--   * Initial status from moderation mode (Req 3.6, 3.7): the parent event's
--     `moderation_mode` decides the inserted status — 'pre' → 'pending' (awaits
--     moderator approval), 'post' → 'approved' (visible immediately). The
--     column's own DEFAULT is overridden explicitly here.
--
--   * Stored fields (Req 3.4): the insert sets event_id, the sanitised text,
--     the moderation-derived status, vote_count 0, and the submission_key;
--     id/created_at/updated_at use their column defaults.
--
-- Error signals (for the client / Edge layer to map):
--   * 'rate_limited'   — too many submissions in the window (→ HTTP 429).
--   * 'event_not_live' — event is not live or does not exist (→ 403/409).
--   * 'invalid_length' — text empty/whitespace-only/over-length/sanitised-empty
--                        (→ 400 with the 1–300 character length constraint).
--   All are raised with SQLSTATE 'P0001' (raise_exception) and the MESSAGE set
--   to the signal string above so callers can switch on the message.
--
-- Security model:
--   * SECURITY DEFINER with `SET search_path = public, pg_temp` so the function
--     can insert into `questions` (which has RLS with NO anonymous INSERT
--     policy — Task 12.1) on behalf of anonymous callers, and cannot be
--     hijacked via a caller-controlled search_path.
--   * EXECUTE is granted to `anon` AND `authenticated` because anonymous
--     participants submit questions (and an authenticated admin may also).
--
-- Design ref: Request/data flows → "2. Question submit + moderation"
--             (validate length/sanitisation, insert pending/approved per
--             moderation_mode); RLS Design → Server-side rate limiting.
--
-- Requirements: 3.1, 3.2, 3.3, 3.6, 3.7, 22.1, 21.9, 21.10, 21.11, 21.12,
--               21.13, 23.8.
--
-- Idempotency (of the migration itself): CREATE OR REPLACE FUNCTION + guarded
--   grants make it safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- submit_question(
--     p_event_id               uuid,
--     p_participant_identifier text,
--     p_text                   text,
--     p_submission_key         text DEFAULT NULL
-- ) RETURNS questions
--
-- Returns the full created question row (or, for an idempotent retry, the
-- existing row) so the caller has the id, status, vote_count, timestamps, etc.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_question(
    p_event_id               uuid,
    p_participant_identifier text,
    p_text                   text,
    p_submission_key         text DEFAULT NULL
)
RETURNS questions
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sanitised text;
    v_len       int;
    v_mode      moderation_mode;
    v_status    question_status;
    v_row       questions%ROWTYPE;
BEGIN
    -- Defensive: an absent participant identifier or event id cannot be
    -- rate-limited/gated meaningfully — treat as not-live to reject safely.
    IF p_participant_identifier IS NULL OR p_event_id IS NULL THEN
        RAISE EXCEPTION 'event_not_live' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1. Rate limit FIRST (Req 21.13). On exceed: reject and record nothing
    --    further. The helper itself records nothing when it returns FALSE.
    -- ------------------------------------------------------------------------
    IF NOT check_submit_rate_limit(p_participant_identifier, p_event_id) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 2. Event must be live (Req 3.3). event_is_live returns FALSE for a
    --    non-existent event, so this also rejects unknown events.
    -- ------------------------------------------------------------------------
    IF NOT event_is_live(p_event_id) THEN
        RAISE EXCEPTION 'event_not_live' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 3. Validate + sanitise text (Req 3.1, 3.2, 22.1, 21.9–21.11).
    --    - Normalise tab/newline/CR to a single space, then strip any
    --      remaining C0/C1 control characters (allow-list: keep printable
    --      Unicode text, drop control payloads — Req 21.9).
    --    - Trim surrounding whitespace so empty/whitespace-only input
    --      collapses to length 0 and is rejected (Req 3.2).
    --    - char_length counts Unicode code points (Req 22.1); require 1–300.
    -- ------------------------------------------------------------------------
    IF p_text IS NULL THEN
        RAISE EXCEPTION 'invalid_length' USING ERRCODE = 'P0001';
    END IF;

    -- Collapse tab/newline/carriage-return runs to a single space.
    -- (\u escapes are code-point escapes in Postgres ARE, range-safe.)
    v_sanitised := regexp_replace(p_text, '[\u0009\u000A\u000D]+', ' ', 'g');
    -- Strip remaining C0 controls (U+0000–U+001F) and DEL/C1 controls
    -- (U+007F–U+009F). A NUL can never be stored in a text value, so this
    -- only removes genuine control payloads and leaves printable Unicode.
    v_sanitised := regexp_replace(v_sanitised, '[\u0000-\u001F\u007F-\u009F]', '', 'g');
    -- Trim surrounding whitespace.
    v_sanitised := btrim(v_sanitised);

    v_len := char_length(v_sanitised);
    IF v_len < 1 OR v_len > 300 THEN
        -- Empty / whitespace-only / control-only / over-length: reject the
        -- whole submission and persist nothing (Req 21.11, 3.1, 3.2).
        RAISE EXCEPTION 'invalid_length' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 4. Idempotency short-circuit (Req 23.8): if a submission_key was supplied
    --    and a question already exists for (event_id, submission_key), return
    --    that existing row without inserting a duplicate.
    -- ------------------------------------------------------------------------
    IF p_submission_key IS NOT NULL THEN
        SELECT q.* INTO v_row
          FROM questions q
         WHERE q.event_id       = p_event_id
           AND q.submission_key = p_submission_key
         LIMIT 1;

        IF FOUND THEN
            RETURN v_row;
        END IF;
    END IF;

    -- ------------------------------------------------------------------------
    -- 5. Initial status from the event's moderation_mode (Req 3.6, 3.7).
    --    'pre'  → 'pending'  (awaits moderator approval)
    --    'post' → 'approved' (visible to audience immediately)
    -- ------------------------------------------------------------------------
    SELECT e.moderation_mode INTO v_mode
      FROM events e
     WHERE e.id = p_event_id;

    IF NOT FOUND THEN
        -- Should be unreachable (event_is_live already passed), but guard.
        RAISE EXCEPTION 'event_not_live' USING ERRCODE = 'P0001';
    END IF;

    v_status := CASE v_mode
                    WHEN 'pre'  THEN 'pending'::question_status
                    WHEN 'post' THEN 'approved'::question_status
                    ELSE 'pending'::question_status
                END;

    -- ------------------------------------------------------------------------
    -- 6. Insert the question. ON CONFLICT on the partial unique
    --    (event_id, submission_key) index handles the race where a concurrent
    --    retry inserted the same key between the pre-check and here: the
    --    conflicting insert becomes a no-op and we re-select the existing row
    --    (still idempotent — Req 23.8).
    -- ------------------------------------------------------------------------
    INSERT INTO questions (event_id, text, status, vote_count, submission_key)
    VALUES (p_event_id, v_sanitised, v_status, 0, p_submission_key)
    ON CONFLICT (event_id, submission_key)
        WHERE submission_key IS NOT NULL
        DO NOTHING
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        -- Insert was a no-op due to a concurrent idempotent write; fetch the
        -- winning row so the caller still receives the created question.
        SELECT q.* INTO v_row
          FROM questions q
         WHERE q.event_id       = p_event_id
           AND q.submission_key = p_submission_key
         LIMIT 1;
    END IF;

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION submit_question(uuid, text, text, text) IS
    'Question-submit RPC (Task 13.2; Req 3.1-3.3, 3.6-3.7, 22.1, 21.9-21.13, '
    '23.8). SECURITY DEFINER. Order: rate-limit (default 10/60s) -> event live '
    'check -> trim/sanitise + 1-300 code-point length -> submission_key '
    'idempotency -> status from moderation_mode (pre=pending, post=approved) -> '
    'insert & return the question row. Error signals (SQLSTATE P0001, MESSAGE): '
    'rate_limited, event_not_live, invalid_length.';

-- ----------------------------------------------------------------------------
-- Grants. Anonymous participants submit questions, so EXECUTE is granted to
-- anon; authenticated (admins) may also submit. The function is SECURITY
-- DEFINER and mediates the insert into `questions` (which has no anonymous
-- INSERT policy), so this grant does not expose any direct table access.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION submit_question(uuid, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION submit_question(uuid, text, text, text) TO authenticated;
