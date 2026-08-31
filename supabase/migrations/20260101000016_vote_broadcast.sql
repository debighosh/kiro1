-- ============================================================================
-- Migration: 20260101000016_vote_broadcast.sql
-- Purpose:   Implement and document the vote-count Realtime Broadcast fan-out
--            for MSS LivePulse question voting (Milestone 2, Core Live Q&A,
--            Task 13.4 — Design Decision D9).
--
--            This migration adds a small, reusable helper `broadcast_vote_count`
--            that emits a Supabase Realtime *Broadcast* message carrying the
--            updated vote count, and then CREATE OR REPLACEs the two vote RPCs
--            from …000015 so they call the helper right after the authoritative
--            vote_count is updated. This SUPERSEDES the "(Task 13.4) …
--            deliberately NOT implemented" markers left in …000015; the RPC
--            bodies are otherwise unchanged.
--
-- Ordering: this migration uses the …000016 timestamp so it sorts AFTER
--   …000015_vote_rpc.sql (which defines cast_question_vote / remove_question_vote).
--   It depends on the following already existing:
--     * …000015 vote_rpc            (the two functions being replaced),
--     * …000009 questions           (questions.vote_count),
--     * …000010 question_votes,
--     * …000006 event_is_live(uuid),
--   and on Supabase's built-in `realtime` schema (`realtime.send`), which is
--   provided by the Supabase platform's Realtime extension.
--
-- ----------------------------------------------------------------------------
-- Design Decision D9 — Realtime strategy for high-frequency votes
-- ----------------------------------------------------------------------------
--   The authoritative vote state lives in PostgreSQL: the vote RPCs atomically
--   INSERT/DELETE a `question_votes` row and increment/decrement the cached
--   `questions.vote_count` inside one transaction. Under peak voting, relying
--   SOLELY on per-row change-data-capture (logical-replication / Postgres
--   Changes) to fan the new count out to clients can lag. Per Decision D9, we
--   ALSO push the updated count via Supabase Realtime *Broadcast* — a
--   lightweight, customizable message on a narrow, event-scoped topic — so the
--   count reaches all other connected clients within the 2-second delivery
--   target (Req 4.7, 23.1) even under bursty traffic, while keeping the
--   subscription scope narrow (Req 23.2). This is the D9 broadcast path; it is
--   a *performance optimization*, NOT a source of truth — the DB vote_count
--   remains authoritative.
--
-- ----------------------------------------------------------------------------
-- Channel / topic naming and payload shape (client contract)
-- ----------------------------------------------------------------------------
--   Topic (per EVENT, narrow scope — Req 23.2):
--       'event:{event_id}:votes'
--       e.g. 'event:8f3c…:votes'
--   Event name (snake_case entity_action, per Supabase guidance):
--       'vote_count'
--   Payload (jsonb) — EVENT-SCOPED, PRIVACY-SAFE (Req 20 privacy / 8.6):
--       {
--         "event_id":    "<uuid>",   -- the event the count belongs to
--         "question_id": "<uuid>",   -- which question's count changed
--         "vote_count":  <integer>   -- the NEW authoritative count
--       }
--   The payload MUST NOT contain `participant_identifier` or any per-participant
--   / personal data — only the aggregate count and the ids needed to route it
--   (Req 20 privacy, Req 8.6: participant_identifier is never exposed to
--   clients). Vote *rows* remain unreadable by clients (see …000012 RLS); only
--   the aggregate count is broadcast.
--
--   The client subscribes to the per-event votes topic and updates the matching
--   question's displayed count on each `vote_count` message. The consuming
--   client hook is implemented separately in Task 15.3 (NOT in this migration).
--
--   `realtime.send(...)` is called with `private => false` here: the broadcast
--   carries only a public aggregate count (no PII), so a public channel is
--   acceptable and avoids requiring per-client Broadcast-authorization RLS for
--   an anonymous audience. (If a private channel is later desired, flip this to
--   true and add the corresponding realtime.messages SELECT RLS policy.)
--
-- ----------------------------------------------------------------------------
-- Best-effort semantics (broadcast MUST NOT break the vote)
-- ----------------------------------------------------------------------------
--   The broadcast is a best-effort fan-out layered on top of the authoritative
--   DB write. `broadcast_vote_count` wraps the `realtime.send` call in a
--   BEGIN/EXCEPTION WHEN OTHERS block that swallows (and RAISEs a WARNING for)
--   any error, so a Realtime hiccup — the `realtime` schema being unavailable,
--   an insert into realtime.messages failing, etc. — can NEVER roll back or
--   fail the enclosing vote transaction. Clients that miss a broadcast still
--   converge on the correct value via the authoritative vote_count (the count
--   returned by the RPC and any CDC/refetch path).
--
-- Security model:
--   * `broadcast_vote_count` and both RPCs are SECURITY DEFINER with a locked
--     search_path (public, pg_temp) so they cannot be hijacked via a
--     caller-controlled search_path. `realtime.send` is schema-qualified so the
--     locked search_path does not hide it.
--   * CREATE OR REPLACE preserves existing grants, but EXECUTE is re-issued to
--     anon/authenticated below to be safe. `broadcast_vote_count` is an internal
--     helper invoked only by the SECURITY DEFINER RPCs; it is NOT granted to
--     anon/authenticated (they reach it only indirectly, with definer rights).
--
-- Requirements traceability: 4.7, 23.1, 23.2 (and privacy: Req 20, 8.6).
-- Design ref: Decision D9 (Realtime strategy for high-frequency votes);
--             Request/data flows → Voting with realtime propagation.
--
-- Idempotency of the migration itself: CREATE OR REPLACE FUNCTION makes all
--   three definitions safe to re-run; the GRANTs are naturally idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- broadcast_vote_count(p_event_id uuid, p_question_id uuid, p_vote_count integer)
--   RETURNS void
--
--   Emits a single Supabase Realtime Broadcast message on the per-event votes
--   topic ('event:{event_id}:votes') with event name 'vote_count' and a
--   privacy-safe aggregate payload (event_id, question_id, vote_count). This is
--   the D9 broadcast path.
--
--   BEST-EFFORT: any failure inside is caught and turned into a WARNING so the
--   caller's (the vote RPC's) transaction is never rolled back by a Realtime
--   problem — the DB vote_count is authoritative.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION broadcast_vote_count(
    p_event_id    uuid,
    p_question_id uuid,
    p_vote_count  integer
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Best-effort fan-out. If anything in the Realtime path fails, swallow it
    -- (log a WARNING) so the authoritative vote transaction still commits.
    -- Named arguments are used so the call is unambiguous regardless of the
    -- positional ordering of realtime.send's parameters.
    BEGIN
        PERFORM realtime.send(
            topic   => 'event:' || p_event_id::text || ':votes',
            event   => 'vote_count',
            payload => jsonb_build_object(
                           'event_id',    p_event_id,
                           'question_id', p_question_id,
                           'vote_count',  p_vote_count
                       ),
            private => false
        );
    EXCEPTION
        WHEN OTHERS THEN
            -- Never let a Realtime Broadcast failure break the vote. The
            -- authoritative state is questions.vote_count; this broadcast is a
            -- best-effort optimization (Decision D9). Clients converge via the
            -- authoritative count on the next read/CDC event.
            RAISE WARNING 'broadcast_vote_count: realtime broadcast failed for question % (event %): %',
                p_question_id, p_event_id, SQLERRM;
    END;
END;
$$;

COMMENT ON FUNCTION broadcast_vote_count(uuid, uuid, integer) IS
    'Best-effort Supabase Realtime Broadcast of the updated vote_count on the '
    'per-event topic ''event:{event_id}:votes'' (event ''vote_count''; payload '
    'event_id + question_id + vote_count, NO participant_identifier — Req 20/8.6). '
    'The D9 high-frequency fan-out path (Req 4.7, 23.1, 23.2). Swallows any '
    'Realtime error so a broadcast failure never rolls back the authoritative '
    'vote transaction; the DB vote_count remains the source of truth.';

-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE cast_question_vote — identical to …000015 except the
-- "(Task 13.4) … deliberately NOT implemented" comment is replaced by the real
-- broadcast_vote_count(...) call, emitted AFTER the atomic count update.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cast_question_vote(
    p_question_id            uuid,
    p_participant_identifier text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event_id   uuid;
    v_status     question_status;
    v_new_count  integer;
BEGIN
    -- Defensive input validation.
    IF p_question_id IS NULL OR p_participant_identifier IS NULL THEN
        RAISE EXCEPTION 'question_not_found';
    END IF;

    -- 1. Look up + lock the parent question row. FOR UPDATE serialises
    --    concurrent casts/removes on the same question so the cached count
    --    stays correct under concurrency.
    SELECT q.event_id, q.status
      INTO v_event_id, v_status
      FROM questions q
     WHERE q.id = p_question_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'question_not_found';
    END IF;

    -- 2. Eligibility: only approved/featured questions on a LIVE event may be
    --    voted on; anything else leaves the count unchanged (Req 4.1, 4.8).
    IF v_status NOT IN ('approved', 'featured')
       OR NOT event_is_live(v_event_id) THEN
        RAISE EXCEPTION 'not_eligible';
    END IF;

    -- 3. Rate limit (Req 21.14): 30 votes / 60 s per participant by default.
    IF NOT check_vote_rate_limit(p_participant_identifier, v_event_id) THEN
        RAISE EXCEPTION 'rate_limited';
    END IF;

    -- 4. Atomic insert of the vote row. The AUTHORITATIVE UNIQUE
    --    (participant_identifier, question_id) constraint rejects a duplicate;
    --    we surface that as 'already_voted' WITHOUT touching vote_count
    --    (Req 4.4, 23.8 — retried casts are no-ops at the row level).
    BEGIN
        INSERT INTO question_votes (question_id, event_id, participant_identifier)
        VALUES (p_question_id, v_event_id, p_participant_identifier);
    EXCEPTION
        WHEN unique_violation THEN
            RAISE EXCEPTION 'already_voted';
    END;

    -- Successful insert ⇒ atomically increment the cached count and return it
    -- (Req 4.1). The questions row is already locked (step 1), so this UPDATE
    -- is race-free with concurrent votes on the same question.
    UPDATE questions
       SET vote_count = vote_count + 1
     WHERE id = p_question_id
    RETURNING vote_count INTO v_new_count;

    -- (Task 13.4 / Decision D9) Fan the new authoritative count out to all
    -- other connected clients via Supabase Realtime Broadcast on the per-event
    -- votes topic, within the 2-second target (Req 4.7, 23.1, 23.2). This is a
    -- BEST-EFFORT call: broadcast_vote_count swallows any Realtime error so a
    -- fan-out failure can never roll back this committed vote. The payload is
    -- event-scoped and carries NO participant_identifier (Req 20/8.6).
    PERFORM broadcast_vote_count(v_event_id, p_question_id, v_new_count);

    RETURN v_new_count;
END;
$$;

COMMENT ON FUNCTION cast_question_vote(uuid, text) IS
    'Atomically records an upvote and increments questions.vote_count for an '
    'approved/featured question on a live event; returns the new vote_count '
    '(Req 4.1) and broadcasts it via Realtime (Decision D9; Req 4.7, 23.1, 23.2). '
    'SECURITY DEFINER (server-mediated write; clients have no direct write access '
    'to question_votes). Error signals: question_not_found, not_eligible '
    '(Req 4.8), rate_limited (Req 21.14), already_voted (Req 4.4, 23.8 — '
    'duplicate/retry leaves vote_count unchanged).';

-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE remove_question_vote — identical to …000015 except the
-- "(Task 13.4) … deliberately NOT implemented" comment is replaced by the real
-- broadcast_vote_count(...) call, emitted AFTER the atomic count update.
--
-- Note: to broadcast, we now also capture the parent event_id when locking the
-- question row (the …000015 version only checked existence). This is a
-- non-behavioural addition needed to scope the broadcast to the event.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION remove_question_vote(
    p_question_id            uuid,
    p_participant_identifier text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event_id   uuid;
    v_deleted    integer;
    v_new_count  integer;
BEGIN
    -- Defensive input validation.
    IF p_question_id IS NULL OR p_participant_identifier IS NULL THEN
        RAISE EXCEPTION 'question_not_found';
    END IF;

    -- 1. Lock the parent question row so the delete + decrement is race-free
    --    with concurrent casts/removes on the same question. Capture event_id
    --    so the broadcast (step 4) can be scoped to the event.
    SELECT q.event_id
      INTO v_event_id
      FROM questions q
     WHERE q.id = p_question_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'question_not_found';
    END IF;

    -- 2. Delete the participant's vote row (if any).
    WITH deleted AS (
        DELETE FROM question_votes
         WHERE question_id = p_question_id
           AND participant_identifier = p_participant_identifier
        RETURNING 1
    )
    SELECT count(*) INTO v_deleted FROM deleted;

    IF v_deleted = 0 THEN
        -- 3. No active vote to remove: count is a no-op (unchanged) and we
        --    return an error signal (Req 4.6).
        RAISE EXCEPTION 'no_vote_to_remove';
    END IF;

    -- A vote was removed ⇒ atomically decrement the cached count, guarded so it
    -- never drops below 0 (Req 4.5). GREATEST(...,0) is belt-and-braces
    -- alongside the questions_vote_count_nonneg_chk CHECK constraint.
    UPDATE questions
       SET vote_count = GREATEST(vote_count - 1, 0)
     WHERE id = p_question_id
    RETURNING vote_count INTO v_new_count;

    -- (Task 13.4 / Decision D9) Fan the new authoritative count out to all
    -- other connected clients via Supabase Realtime Broadcast on the per-event
    -- votes topic, within the 2-second target (Req 4.7, 23.1, 23.2). This is a
    -- BEST-EFFORT call: broadcast_vote_count swallows any Realtime error so a
    -- fan-out failure can never roll back this committed removal. The payload is
    -- event-scoped and carries NO participant_identifier (Req 20/8.6).
    PERFORM broadcast_vote_count(v_event_id, p_question_id, v_new_count);

    RETURN v_new_count;
END;
$$;

COMMENT ON FUNCTION remove_question_vote(uuid, text) IS
    'Atomically removes the participant''s vote and decrements '
    'questions.vote_count (guarded ≥ 0); returns the new vote_count (Req 4.5) '
    'and broadcasts it via Realtime (Decision D9; Req 4.7, 23.1, 23.2). '
    'SECURITY DEFINER (server-mediated). Removing when no active vote exists is '
    'a no-op on the count and RAISEs no_vote_to_remove (Req 4.6). Raises '
    'question_not_found when the question id is unknown.';

-- ----------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE preserves existing grants, but we re-issue EXECUTE
-- to anon and authenticated for the two participant-facing RPCs to be safe.
-- broadcast_vote_count is an internal helper reached only through the
-- SECURITY DEFINER RPCs (with definer rights); it is intentionally NOT granted
-- to anon/authenticated.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION cast_question_vote(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION cast_question_vote(uuid, text) TO authenticated;

GRANT EXECUTE ON FUNCTION remove_question_vote(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION remove_question_vote(uuid, text) TO authenticated;
