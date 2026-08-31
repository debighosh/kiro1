-- ============================================================================
-- Migration: 20260101000029_poll_broadcast.sql
-- Purpose:   Implement and document the poll-results Realtime Broadcast fan-out
--            for MSS LivePulse polls (Milestone 3 — Polls & Word Cloud,
--            Task 21.4 — Design Decision D9).
--
--            This migration adds a small, reusable helper `broadcast_poll_results`
--            that emits a Supabase Realtime *Broadcast* message carrying the
--            updated per-option tallies for a poll, and then CREATE OR REPLACEs
--            the `submit_poll_response` RPC from …000027 so it calls the helper
--            right after the response write + count maintenance. This SUPERSEDES
--            the "(Task 21.4) … will be added HERE" marker left in …000027; the
--            RPC body is otherwise IDENTICAL (signature, SECURITY DEFINER,
--            search_path, error signals, grants).
--
--            It mirrors EXACTLY how 20260101000016_vote_broadcast.sql added
--            `broadcast_vote_count` and replaced the vote RPCs to call it.
--
-- Ordering: this migration uses the …000029 timestamp so it sorts (byte-
--   lexicographic, matching the Supabase CLI's directory read order) AFTER
--   20260101000028_word_cloud_moderation_rpc.sql and, crucially, after
--   20260101000027_poll_respond_rpc.sql (the function being replaced here). It
--   depends on the following already existing:
--     * …000027 poll_respond_rpc     (the submit_poll_response function replaced),
--     * …000017 polls                (poll_options.response_count / display_order),
--     * …000018 poll_responses,
--     * …000006 event_is_live(uuid),
--     * …000013 rate_limiting        (check_and_record_rate_limit),
--   and on Supabase's built-in `realtime` schema (`realtime.send`), which is
--   provided by the Supabase platform's Realtime extension. All of the above
--   sort before …000029, so the ordering is sound.
--
-- ----------------------------------------------------------------------------
-- Design Decision D9 — Realtime strategy (poll-results fan-out)
-- ----------------------------------------------------------------------------
--   The authoritative poll state lives in PostgreSQL: submit_poll_response
--   atomically writes the poll_responses row and increments/decrements the
--   cached poll_options.response_count tallies inside one transaction. Per
--   Decision D9 — the same strategy used for high-frequency question votes —
--   we ALSO push the updated per-option tallies via Supabase Realtime
--   *Broadcast* on a narrow, event-scoped topic so results reach all other
--   connected clients within the delivery target (Req 5.11, 5.12, 23.1) even
--   under bursty responding, while keeping the subscription scope narrow
--   (Req 23.2). This is a *performance optimization*, NOT a source of truth —
--   the DB response_count tallies remain authoritative.
--
-- ----------------------------------------------------------------------------
-- Channel / topic naming and payload shape (client contract)
-- ----------------------------------------------------------------------------
--   Topic (per EVENT, narrow scope — Req 23.2):
--       'event:{event_id}:polls'
--       e.g. 'event:8f3c…:polls'
--   Event name (snake_case entity_action, per Supabase guidance):
--       'poll_results'
--   Payload (jsonb) — EVENT-SCOPED, PRIVACY-SAFE (Req 20 privacy / 8.6):
--       {
--         "event_id": "<uuid>",       -- the event the poll belongs to
--         "poll_id":  "<uuid>",       -- which poll's tallies changed
--         "options": [               -- per-option tallies, in display_order
--           { "option_id": "<uuid>", "response_count": <integer> },
--           ...
--         ]
--       }
--   The payload MUST NOT contain `participant_identifier` or any per-participant
--   / personal data — only the aggregate per-option counts and the ids needed to
--   route it (Req 20 privacy, Req 8.6: participant_identifier is never exposed
--   to clients). Response *rows* remain unreadable by clients (see …000021 RLS);
--   only the aggregate tallies are broadcast.
--
--   `realtime.send(...)` is called with `private => false` here: the broadcast
--   carries only public aggregate counts (no PII), so a public channel is
--   acceptable and avoids requiring per-client Broadcast-authorization RLS for
--   an anonymous audience (mirrors broadcast_vote_count). If a private channel
--   is later desired, flip this to true and add the corresponding
--   realtime.messages SELECT RLS policy.
--
-- ----------------------------------------------------------------------------
-- VISIBILITY NOTE — the broadcast carries RAW tallies; the CLIENT withholds
-- display for hide_until_closed polls until status = 'closed'
-- ----------------------------------------------------------------------------
--   The broadcast ALWAYS fans out the CURRENT per-option counts. It does NOT
--   attempt to encode the poll's results_visibility gating. A poll configured
--   `hide_until_closed` (Req 5.4) must not SHOW its results to the audience
--   until the poll is closed — but that gating is applied by the READ / RENDER
--   layer (Task 23.2) and by the presenter surface, NOT by this broadcast:
--     * The broadcast payload is the RAW aggregate tallies.
--     * For a `hide_until_closed` poll, the audience client WITHHOLDS display
--       of those tallies until the poll's status becomes 'closed'; for a
--       `show_always` poll the client renders them immediately.
--   Encoding visibility into the broadcast for M3 is deliberately avoided: the
--   presenter still needs live tallies for a hidden poll, and status changes
--   arrive on their own channel, so the client is the correct place to gate
--   *display*. Keeping the broadcast payload uniform (raw tallies) mirrors the
--   authoritative-state / best-effort-fan-out model of broadcast_vote_count.
--
-- ----------------------------------------------------------------------------
-- Best-effort semantics (broadcast MUST NOT break the poll response)
-- ----------------------------------------------------------------------------
--   The broadcast is a best-effort fan-out layered on top of the authoritative
--   DB write. `broadcast_poll_results` wraps the `realtime.send` call in a
--   BEGIN/EXCEPTION WHEN OTHERS block that swallows (and RAISEs a WARNING for)
--   any error, so a Realtime hiccup — the `realtime` schema being unavailable,
--   an insert into realtime.messages failing, etc. — can NEVER roll back or
--   fail the enclosing poll-response transaction. Clients that miss a broadcast
--   still converge on the correct tallies via the authoritative response_count
--   (any CDC/refetch path).
--
-- Security model:
--   * `broadcast_poll_results` and `submit_poll_response` are SECURITY DEFINER
--     with a locked search_path (public, pg_temp) so they cannot be hijacked via
--     a caller-controlled search_path. `realtime.send` is schema-qualified so the
--     locked search_path does not hide it.
--   * CREATE OR REPLACE preserves existing grants, but EXECUTE is re-issued to
--     anon/authenticated below to be safe. `broadcast_poll_results` is an
--     internal helper invoked only by the SECURITY DEFINER RPC; it is NOT granted
--     to anon/authenticated (they reach it only indirectly, with definer rights).
--
-- Requirements traceability: 5.11, 5.12, 23.1, 23.2 (and privacy: Req 20, 8.6).
-- Design ref: Decision D9 (Realtime strategy for high-frequency votes, reused
--             for poll results); Request/data flows → Poll lifecycle (Realtime
--             when visible).
--
-- Idempotency of the migration itself: CREATE OR REPLACE FUNCTION makes both
--   definitions safe to re-run; the GRANTs are naturally idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- broadcast_poll_results(p_event_id uuid, p_poll_id uuid) RETURNS void
--
--   Emits a single Supabase Realtime Broadcast message on the per-event polls
--   topic ('event:{event_id}:polls') with event name 'poll_results' and a
--   privacy-safe aggregate payload (event_id, poll_id, and the per-option
--   response_count tallies ordered by display_order). This is the D9 broadcast
--   path for polls.
--
--   BEST-EFFORT: any failure inside is caught and turned into a WARNING so the
--   caller's (the poll-response RPC's) transaction is never rolled back by a
--   Realtime problem — the DB response_count tallies are authoritative.
--
--   VISIBILITY: the payload is the RAW current tallies; a hide_until_closed
--   poll's results are withheld from the audience by the client until the poll
--   is closed (see the VISIBILITY NOTE above). Modelled EXACTLY on
--   broadcast_vote_count (20260101000016_vote_broadcast.sql).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION broadcast_poll_results(
    p_event_id uuid,
    p_poll_id  uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_options jsonb;
BEGIN
    -- Compute the per-option tallies for this poll, ordered by display_order,
    -- aggregated into a jsonb array of {option_id, response_count}. This is the
    -- authoritative aggregate (poll_options.response_count) — no per-participant
    -- data is read or exposed.
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'option_id',      po.id,
                       'response_count', po.response_count
                   )
                   ORDER BY po.display_order
               ),
               '[]'::jsonb
           )
      INTO v_options
      FROM poll_options po
     WHERE po.poll_id = p_poll_id;

    -- Best-effort fan-out. If anything in the Realtime path fails, swallow it
    -- (log a WARNING) so the authoritative poll-response transaction still
    -- commits. Named arguments are used so the call is unambiguous regardless of
    -- the positional ordering of realtime.send's parameters.
    BEGIN
        PERFORM realtime.send(
            topic   => 'event:' || p_event_id::text || ':polls',
            event   => 'poll_results',
            payload => jsonb_build_object(
                           'event_id', p_event_id,
                           'poll_id',  p_poll_id,
                           'options',  v_options
                       ),
            private => false
        );
    EXCEPTION
        WHEN OTHERS THEN
            -- Never let a Realtime Broadcast failure break the poll response.
            -- The authoritative state is poll_options.response_count; this
            -- broadcast is a best-effort optimization (Decision D9). Clients
            -- converge via the authoritative tallies on the next read/CDC event.
            RAISE WARNING 'broadcast_poll_results: realtime broadcast failed for poll % (event %): %',
                p_poll_id, p_event_id, SQLERRM;
    END;
END;
$$;

COMMENT ON FUNCTION broadcast_poll_results(uuid, uuid) IS
    'Best-effort Supabase Realtime Broadcast of a poll''s updated per-option '
    'response_count tallies on the per-event topic ''event:{event_id}:polls'' '
    '(event ''poll_results''; payload event_id + poll_id + options[]{option_id, '
    'response_count}, ordered by display_order, NO participant_identifier — '
    'Req 20/8.6). The D9 fan-out path for poll results (Req 5.11, 5.12, 23.1, '
    '23.2). The payload is the RAW tallies; a hide_until_closed poll''s results '
    'are withheld from the audience by the CLIENT until status=closed (gating '
    'lives in the read/render layer, Task 23.2). Swallows any Realtime error so '
    'a broadcast failure never rolls back the authoritative poll-response '
    'transaction; the DB response_count tallies remain the source of truth.';

-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE submit_poll_response — identical to …000027 except the
-- "(Task 21.4) … will be added HERE" comment is replaced by the real
-- broadcast_poll_results(...) call, emitted once just before RETURN v_row; so it
-- covers ALL branches (new-response, changed-option, and — harmlessly — the
-- idempotent same-option no-op). Signature, SECURITY DEFINER, search_path,
-- error signals and grants are UNCHANGED. This mirrors how
-- 20260101000016_vote_broadcast.sql replaced the vote RPC to add its broadcast.
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
    --    header of …000027 for why we reuse 'vote' rather than a new action
    --    value. On exceed the primitive returns FALSE and records nothing; we
    --    reject and persist nothing further.
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
    -- (Task 21.4 / Decision D9) Fan the poll's updated per-option tallies out to
    -- all other connected clients via Supabase Realtime Broadcast on the
    -- per-event polls topic, within the delivery target (Req 5.11, 5.12, 23.1,
    -- 23.2). Emitted ONCE here — just before RETURN — so it covers every
    -- state-changing branch above (new response, changed option) and, harmlessly,
    -- the idempotent same-option no-op. This is a BEST-EFFORT call:
    -- broadcast_poll_results swallows any Realtime error so a fan-out failure can
    -- never roll back this committed response. The payload is event-scoped and
    -- carries the RAW aggregate tallies with NO participant_identifier
    -- (Req 20/8.6); the client withholds display of a hide_until_closed poll's
    -- results until it is closed (read/render layer, Task 23.2).
    -- ------------------------------------------------------------------------
    PERFORM broadcast_poll_results(v_event_id, p_poll_id);

    -- 7. Return the resulting (created/updated/unchanged) poll_responses row.
    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION submit_poll_response(uuid, text, uuid) IS
    'Poll-response upsert-replace RPC (Task 21.3; Req 5.7-5.10, 21.13-21.15, '
    '23.8) with the poll-results Realtime broadcast added by Task 21.4 '
    '(Decision D9; Req 5.11, 5.12, 23.1, 23.2). SECURITY DEFINER. Order: '
    'resolve+lock poll (FOR UPDATE) -> rate-limit (30/60s, reuses the shared '
    '''vote'' bucket) -> poll must be ''open'' (draft=>poll_not_open, '
    'closed=>poll_closed) -> event must be live -> option must belong to the '
    'poll -> upsert-replace the participant''s single response with atomic '
    'poll_options.response_count maintenance (new=+1; same option=no-op; '
    'changed=move -1 old/+1 new) -> best-effort broadcast_poll_results. Returns '
    'the poll_responses row. Error signals (SQLSTATE P0001, MESSAGE): '
    'poll_not_found, rate_limited, poll_not_open, poll_closed, event_not_live, '
    'invalid_option.';

-- ----------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE preserves existing grants, but we re-issue EXECUTE
-- to anon and authenticated for the participant-facing RPC to be safe.
-- broadcast_poll_results is an internal helper reached only through the
-- SECURITY DEFINER RPC (with definer rights); it is intentionally NOT granted to
-- anon/authenticated.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION submit_poll_response(uuid, text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION submit_poll_response(uuid, text, uuid) TO authenticated;
