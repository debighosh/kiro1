-- ============================================================================
-- Migration: 20260101000027_poll_respond_rpc.sql
-- Purpose:   Implement the server-side poll-response upsert-replace RPC for MSS
--            LivePulse (Task 21.3, Milestone 3 — Polls & Word Cloud). This is a
--            single `SECURITY DEFINER` PostgreSQL function that anonymous
--            participants invoke to submit — or CHANGE — their single response
--            to an OPEN poll, keeping the denormalised per-option
--            `poll_options.response_count` tallies atomically consistent.
--
--            It mirrors the atomic count-maintenance + row-lock pattern of
--            `cast_question_vote` in 20260101000015_vote_rpc.sql: the parent
--            poll row (and the participant's existing response row) are locked
--            with `SELECT ... FOR UPDATE` before any count is touched, so the
--            response-row write and the option-count UPDATE(s) commit together
--            (all-or-nothing) and stay consistent under concurrency.
--
-- Ordering: This migration is named `…000027_…` so it sorts (byte-lexicographic,
--           matching the Supabase CLI's directory read order) AFTER every
--           earlier Milestone 3 migration — in particular after
--           `20260101000026_word_cloud_respond_rpc.sql` (the word-cloud twin of
--           this RPC). It depends on objects that all sort before it:
--             * `polls` / `poll_options` (…000017)      — poll status/event +
--               the `response_count` tally this RPC maintains.
--             * `poll_responses` (…000018)              — the response table +
--               the AUTHORITATIVE UNIQUE (participant_identifier, poll_id)
--               constraint `uq_poll_responses_participant_poll`.
--             * `events` (…000002)                      — live-event gating.
--             * `event_is_live(uuid)` (…000006)         — live gating helper.
--             * `check_and_record_rate_limit(text, text, uuid, int, int)`
--               (…000013_rate_limiting)                 — shared rate limiter.
--           All of the above sort before `…000027`, so the ordering is sound.
--
-- Scope (Task 21.3 ONLY):
--   * Implements ONLY the poll-response upsert-replace RPC with atomic count
--     maintenance. It deliberately does NOT emit the poll-results Realtime
--     broadcast — that is added by Task 21.4 via CREATE OR REPLACE FUNCTION,
--     mirroring how 20260101000016_vote_broadcast.sql replaced the vote RPC to
--     add the broadcast. A clearly-marked comment below flags where 21.4 will
--     insert the broadcast.
--
-- ----------------------------------------------------------------------------
-- RATE-LIMIT ACTION TYPE — IMPORTANT COMPATIBILITY NOTE
-- ----------------------------------------------------------------------------
--   The shared rate-limit primitive `check_and_record_rate_limit(...)` and the
--   `rate_events.action` CHECK constraint (both defined in
--   20260101000013_rate_limiting.sql) currently accept ONLY the action values
--   `'submit_question'` and `'vote'`. The generic function explicitly returns
--   FALSE for any other action value, and the CHECK constraint would reject an
--   insert of any other value. Introducing a brand-new `'poll_response'` action
--   would therefore make EVERY poll response fail as `rate_limited` (the
--   limiter returns FALSE before any insert) — and it would also require
--   editing the rate-limiting migration, which is out of scope for Task 21.3
--   (this task creates ONLY this file).
--
--   To keep this migration self-contained AND functional, the poll-response
--   action REUSES the existing `'vote'` rate-limit bucket — the SAME decision
--   the word-cloud respond RPC (Task 22.3, …000026) made for the same reason.
--   This is a natural fit: casting/changing a poll answer is, like a question
--   vote, a high-frequency anonymous participant interaction, and the intended
--   limit (30 actions / 60 s) is exactly the vote limit (Req 21.14). The limit
--   is scoped to the resolved event id so it is per-event. If a future task
--   widens the allowed action set (e.g. adds a dedicated `'poll_response'`
--   value to both the CHECK constraint and the primitive's allow-list), this
--   call can be switched to that value with no other change here.
--
-- ----------------------------------------------------------------------------
-- Behaviour and requirements traceability
-- ----------------------------------------------------------------------------
--   Steps, IN ORDER (all inside the single implicit transaction of the function
--   body, so the response write + count moves commit together):
--
--   0. Defensive null checks: a NULL poll id or participant identifier cannot
--      be resolved/gated meaningfully → RAISE 'poll_not_found'.
--
--   1. Resolve + LOCK the poll (SELECT status, event_id FROM polls WHERE id =
--      p_poll_id FOR UPDATE). The row lock serialises concurrent responses on
--      the same poll so the cached per-option counts stay correct. A missing
--      poll → RAISE 'poll_not_found'.
--
--   2. Rate limit FIRST-after-resolve (Req 21.13–21.15): reuse the shared
--      'vote' bucket, event-scoped, 30 / 60 s (see the RATE-LIMIT ACTION TYPE
--      note above). On exceed the primitive returns FALSE and records nothing;
--      we RAISE 'rate_limited' and persist nothing further.
--
--   3. Poll must be 'open' (Req 5.9, 5.10). Two DISTINCT signals so the client
--      can message appropriately:
--        * status = 'draft'  → RAISE 'poll_not_open' (Req 5.10 — reject on a
--                              not-yet-open poll).
--        * status = 'closed' → RAISE 'poll_closed'   (Req 5.9 — reject on a
--                              closed poll, leaving any existing response
--                              unchanged).
--        * status = 'open'   → proceed.
--
--   4. Event must be live (Req 5.9/5.10 gating): NOT event_is_live(v_event_id)
--      → RAISE 'event_not_live'.
--
--   5. Validate the option belongs to THIS poll: a chosen option that is not a
--      row of `poll_options` for `p_poll_id` → RAISE 'invalid_option'.
--
--   6. UPSERT-REPLACE with atomic count maintenance (Req 5.7, 5.8): look up the
--      participant's EXISTING response for this poll FOR UPDATE, then:
--        * NONE exists          → INSERT the response and +1 the chosen
--                                 option's response_count.
--        * EXISTS, same option  → no-op (idempotent): counts unchanged, return
--                                 the existing row (Req 23.8 — a retried submit
--                                 does not double-count).
--        * EXISTS, diff option  → UPDATE the response row's option_id to the
--                                 new option, -1 the OLD option's count
--                                 (GREATEST(..-1,0)) and +1 the NEW option's
--                                 count — so exactly ONE response remains and
--                                 the tally moves atomically from old to new.
--      The poll row is already locked (step 1) and the response row is locked
--      here, so all count moves are race-free.
--
--   7. Return the resulting `poll_responses` row (id, option_id, timestamps,
--      etc.) so the caller sees the current recorded response.
--
-- Error signals (RAISEd as exceptions, SQLSTATE 'P0001' raise_exception with
-- the MESSAGE set to the signal string; the client / Edge layer maps them):
--   * 'poll_not_found' — NULL/unknown poll id or participant id (→ 404/409).
--   * 'rate_limited'   — too many responses in the window (→ HTTP 429).
--   * 'poll_not_open'  — poll status is 'draft' (Req 5.10) (→ 409).
--   * 'poll_closed'    — poll status is 'closed' (Req 5.9); any existing
--                        response is left unchanged (→ 409).
--   * 'event_not_live' — the poll's event is not live (→ 403/409).
--   * 'invalid_option' — the chosen option does not belong to this poll (→ 400).
--
-- Security model:
--   * SECURITY DEFINER with `SET search_path = public, pg_temp` so the function
--     can insert/update `poll_responses` and update `poll_options.response_count`
--     (server-mediated writes; anonymous clients have no direct write policy on
--     those tables — Task 20.x) on behalf of anonymous callers, and cannot be
--     hijacked via a caller-controlled search_path.
--   * EXECUTE is granted to `anon` AND `authenticated` because anonymous
--     participants submit poll responses (like question voting); an
--     authenticated user may also.
--   * `participant_identifier` is opaque and PII-free (Req 21.18).
--
-- Requirements: 5.7, 5.8, 5.9, 5.10, 21.13, 21.14, 21.15, 23.8.
-- Design ref:  Request/data flows → Poll lifecycle (upsert replace);
--              RLS Design → Server-side rate limiting (Req 21.13–21.15).
--
-- Idempotency (of the migration itself): CREATE OR REPLACE FUNCTION + the
--   naturally-idempotent GRANTs make it safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- submit_poll_response(
--     p_poll_id                uuid,
--     p_participant_identifier text,
--     p_option_id              uuid
-- ) RETURNS poll_responses
--
-- Returns the full created-or-updated poll_responses row so the caller has the
-- id, option_id, timestamps, etc. Idempotency (Req 23.8) is provided by the
-- AUTHORITATIVE UNIQUE (participant_identifier, poll_id) constraint together
-- with the explicit same-option no-op branch: a re-submit of the same option
-- neither inserts a duplicate nor double-counts.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_poll_response(
    p_poll_id                uuid,
    p_participant_identifier text,
    p_option_id              uuid
)
RETURNS poll_responses
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status        poll_status;
    v_event_id      uuid;
    v_option_exists boolean;
    v_existing_id   uuid;
    v_existing_opt  uuid;
    v_row           poll_responses%ROWTYPE;
BEGIN
    -- 0. Defensive null checks: cannot resolve/gate a NULL poll or participant.
    IF p_poll_id IS NULL OR p_participant_identifier IS NULL THEN
        RAISE EXCEPTION 'poll_not_found' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1. Resolve + LOCK the parent poll row. FOR UPDATE serialises concurrent
    --    responses on the same poll so the cached per-option response_count
    --    tallies stay correct under concurrency (mirrors cast_question_vote).
    -- ------------------------------------------------------------------------
    SELECT p.status, p.event_id
      INTO v_status, v_event_id
      FROM polls p
     WHERE p.id = p_poll_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'poll_not_found' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 2. Rate limit (Req 21.13–21.15). Reuse the shared 'vote' bucket
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
    -- 3. Poll must be 'open' (Req 5.9, 5.10). Two DISTINCT signals so the
    --    client can message appropriately: a draft poll is "not open yet"; a
    --    closed poll is "closed" and any existing response is left unchanged
    --    (we neither modify nor delete it — we simply do not write).
    -- ------------------------------------------------------------------------
    IF v_status = 'draft' THEN
        RAISE EXCEPTION 'poll_not_open' USING ERRCODE = 'P0001';   -- Req 5.10
    ELSIF v_status = 'closed' THEN
        RAISE EXCEPTION 'poll_closed' USING ERRCODE = 'P0001';     -- Req 5.9
    END IF;
    -- Only status = 'open' proceeds beyond this point.

    -- ------------------------------------------------------------------------
    -- 4. Event must be live (Req 5.9/5.10 gating). The poll's FK guarantees the
    --    event exists; this enforces the live window.
    -- ------------------------------------------------------------------------
    IF NOT event_is_live(v_event_id) THEN
        RAISE EXCEPTION 'event_not_live' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 5. Validate the chosen option belongs to THIS poll. Guards against a
    --    stale/forged option id (or an option from another poll).
    -- ------------------------------------------------------------------------
    SELECT EXISTS (
        SELECT 1
          FROM poll_options po
         WHERE po.id = p_option_id
           AND po.poll_id = p_poll_id
    ) INTO v_option_exists;

    IF NOT v_option_exists THEN
        RAISE EXCEPTION 'invalid_option' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 6. UPSERT-REPLACE with atomic count maintenance (Req 5.7, 5.8). Look up
    --    and LOCK the participant's existing response for this poll (if any) so
    --    the read → mutate → count-move sequence is race-free with concurrent
    --    submissions by the same participant on the same poll.
    -- ------------------------------------------------------------------------
    SELECT pr.id, pr.option_id
      INTO v_existing_id, v_existing_opt
      FROM poll_responses pr
     WHERE pr.participant_identifier = p_participant_identifier
       AND pr.poll_id = p_poll_id
       FOR UPDATE;

    IF NOT FOUND THEN
        -- 6a. No existing response → INSERT and +1 the chosen option's count.
        INSERT INTO poll_responses (
            poll_id,
            event_id,
            option_id,
            participant_identifier
        )
        VALUES (
            p_poll_id,
            v_event_id,
            p_option_id,
            p_participant_identifier
        )
        RETURNING * INTO v_row;

        UPDATE poll_options
           SET response_count = response_count + 1
         WHERE id = p_option_id;

    ELSIF v_existing_opt = p_option_id THEN
        -- 6b. Existing response for the SAME option → idempotent no-op: counts
        --     unchanged, return the existing row (Req 23.8 — no double-count).
        SELECT * INTO v_row
          FROM poll_responses
         WHERE id = v_existing_id;

    ELSE
        -- 6c. Existing response for a DIFFERENT option → move the answer:
        --     update the response row to the new option, DECREMENT the OLD
        --     option's count (guarded ≥ 0) and INCREMENT the NEW option's
        --     count — exactly one response remains and the tally moves
        --     atomically from old to new (Req 5.7, 5.8).
        UPDATE poll_responses
           SET option_id = p_option_id
         WHERE id = v_existing_id
        RETURNING * INTO v_row;

        UPDATE poll_options
           SET response_count = GREATEST(response_count - 1, 0)
         WHERE id = v_existing_opt;

        UPDATE poll_options
           SET response_count = response_count + 1
         WHERE id = p_option_id;
    END IF;

    -- ------------------------------------------------------------------------
    -- (Task 21.4) A poll-results Realtime broadcast for event v_event_id
    -- (payload: poll_id + the per-option response_count tallies, NO
    -- participant_identifier) will be added HERE by Task 21.4 via
    -- CREATE OR REPLACE FUNCTION — mirroring how 20260101000016_vote_broadcast.sql
    -- replaced the vote RPC to add its broadcast. Deliberately NOT emitted in
    -- this task.
    -- ------------------------------------------------------------------------

    -- 7. Return the resulting (created/updated/unchanged) poll_responses row.
    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION submit_poll_response(uuid, text, uuid) IS
    'Poll-response upsert-replace RPC (Task 21.3; Req 5.7-5.10, 21.13-21.15, '
    '23.8). SECURITY DEFINER. Order: resolve+lock poll (FOR UPDATE) -> '
    'rate-limit (30/60s, reuses the shared ''vote'' bucket) -> poll must be '
    '''open'' (draft=>poll_not_open, closed=>poll_closed) -> event must be live '
    '-> option must belong to the poll -> upsert-replace the participant''s '
    'single response with atomic poll_options.response_count maintenance '
    '(new=+1; same option=no-op; changed=move -1 old/+1 new). Returns the '
    'poll_responses row. Error signals (SQLSTATE P0001, MESSAGE): '
    'poll_not_found, rate_limited, poll_not_open, poll_closed, event_not_live, '
    'invalid_option. A poll-results broadcast is added by Task 21.4.';

-- ----------------------------------------------------------------------------
-- Grants. Anonymous participants submit poll responses, so EXECUTE is granted
-- to anon; authenticated users may also submit. The function is SECURITY
-- DEFINER and mediates the writes into `poll_responses` /
-- `poll_options.response_count` (which have no direct anonymous write policy),
-- so this grant does not expose any direct table access.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION submit_poll_response(uuid, text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION submit_poll_response(uuid, text, uuid) TO authenticated;
