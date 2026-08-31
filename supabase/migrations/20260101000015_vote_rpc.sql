-- ============================================================================
-- Migration: 20260101000015_vote_rpc.sql
-- Purpose:   Implement the atomic cast/remove vote RPCs for question upvoting —
--            the server-mediated write path for MSS LivePulse question voting
--            (Milestone 2, Core Live Q&A, Task 13.3).
--
--            Two clearly-named SECURITY DEFINER functions are provided:
--              * cast_question_vote(p_question_id, p_participant_identifier)
--                  → inserts a vote row and atomically increments the cached
--                    questions.vote_count; returns the new count.
--              * remove_question_vote(p_question_id, p_participant_identifier)
--                  → deletes the participant's vote row and atomically
--                    decrements the cached count; returns the new count.
--
-- Ordering: this migration uses the …000015 timestamp so it sorts AFTER:
--   * …000009 questions            (the `questions` table + vote_count column),
--   * …000010 question_votes       (the vote table + the AUTHORITATIVE
--                                    UNIQUE (participant_identifier, question_id)
--                                    constraint `uq_question_votes_participant_question`),
--   * …000011 questions_rls        (RLS on questions),
--   * …000012 question_votes_rls   (RLS on question_votes — server-mediated,
--                                    no client write policies rely on THIS RPC),
--   * …000013 rate_limiting        (check_vote_rate_limit / the generic
--                                    check_and_record_rate_limit primitive),
--   * …000014 submit_question_rpc  (Task 13.2, concurrently authored — this
--                                    migration owns …000015 and does not touch it).
--   It also depends on …000006 event_is_live(uuid). All of these already exist.
--
-- Scope (Task 13.3 ONLY):
--   * Implements ONLY the DB-side cast/remove vote RPCs.
--   * Does NOT implement the Realtime Broadcast fan-out (Task 13.4) nor the
--     client voting UI (Task 15.2). A comment marks where a broadcast/NOTIFY
--     could later be emitted, but none is emitted here.
--
-- Concurrency / atomicity model:
--   Each function performs its read → mutate → count-update sequence inside the
--   single implicit transaction of the function body. The parent `questions`
--   row is locked with `SELECT ... FOR UPDATE` before the count is changed so
--   concurrent casts/removes for the same question serialise and the cached
--   vote_count stays consistent. The vote-row INSERT/DELETE and the vote_count
--   UPDATE therefore commit together (all-or-nothing).
--
-- Idempotency (Req 23.8):
--   The AUTHORITATIVE UNIQUE (participant_identifier, question_id) constraint
--   makes a *retried* cast a no-op at the row level: a client retry after a
--   network blip cannot double-count. Rather than silently swallowing it, the
--   cast path catches unique_violation and RAISEs 'already_voted' so the caller
--   can distinguish "you already voted" from "your vote was just recorded",
--   while leaving vote_count unchanged (Req 4.4, 23.8).
--
-- Documented error signals (RAISEd as exceptions; callers map to responses):
--   * 'question_not_found' — no question exists with the given id.
--   * 'not_eligible'       — question status is not approved/featured, OR the
--                            parent event is not live (Req 4.1, 4.8).
--   * 'rate_limited'       — the participant exceeded the vote rate limit
--                            (30 / 60 s default) (Req 21.14).
--   * 'already_voted'      — a duplicate cast; vote_count unchanged (Req 4.4).
--   * 'no_vote_to_remove'  — remove requested but the participant had no active
--                            vote; vote_count unchanged (Req 4.6).
--
-- Security model:
--   * Both functions are SECURITY DEFINER with a locked search_path
--     (public, pg_temp) so they run with the definer's rights and cannot be
--     hijacked via a caller-controlled search_path. This is what lets an
--     anonymous participant mutate `question_votes` / `questions.vote_count`
--     even though RLS grants clients no direct write access to those tables
--     (writes are server-mediated by THIS RPC — see …000012 question_votes_rls).
--   * EXECUTE is granted to `anon` and `authenticated`.
--   * `participant_identifier` is opaque and PII-free; it is never returned to
--     the client (both functions return only an integer vote_count).
--
-- Requirements traceability: 4.1, 4.4, 4.5, 4.6, 4.8, 21.14, 23.8.
-- Design ref: Request/data flows → Voting with realtime propagation;
--             Data Models → DB-layer uniqueness (`question_votes`).
--
-- Idempotency of the migration itself: CREATE OR REPLACE FUNCTION makes both
--   definitions safe to re-run; the GRANTs are naturally idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- cast_question_vote(p_question_id uuid, p_participant_identifier text)
--   RETURNS integer  -- the NEW questions.vote_count after the cast.
--
-- Steps (in one transaction, so insert + increment are atomic):
--   1. Look up the question's event_id + status, taking a row lock
--      (FOR UPDATE) so concurrent casts/removes on the same question serialise.
--      If the question does not exist → RAISE 'question_not_found'.
--   2. Eligibility (Req 4.1, 4.8): status MUST be 'approved' or 'featured' AND
--      the parent event MUST be live (event_is_live). Otherwise RAISE
--      'not_eligible' and change nothing.
--   3. Rate limit (Req 21.14): check_vote_rate_limit(...) → false ⇒
--      RAISE 'rate_limited'.
--   4. INSERT the vote row. A duplicate (unique_violation on
--      uq_question_votes_participant_question) ⇒ RAISE 'already_voted' with
--      vote_count unchanged (Req 4.4, 23.8). On success, atomically increment
--      questions.vote_count by 1 and return the new count (Req 4.1).
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

    -- (Task 13.4) A vote-count Realtime Broadcast / NOTIFY for event
    -- v_event_id (payload: question_id + v_new_count, no participant_identifier)
    -- could be emitted here. Deliberately NOT implemented in this task.

    RETURN v_new_count;
END;
$$;

COMMENT ON FUNCTION cast_question_vote(uuid, text) IS
    'Atomically records an upvote and increments questions.vote_count for an '
    'approved/featured question on a live event; returns the new vote_count '
    '(Req 4.1). SECURITY DEFINER (server-mediated write; clients have no direct '
    'write access to question_votes). Error signals: question_not_found, '
    'not_eligible (Req 4.8), rate_limited (Req 21.14), already_voted (Req 4.4, '
    '23.8 — duplicate/retry leaves vote_count unchanged).';

-- ----------------------------------------------------------------------------
-- remove_question_vote(p_question_id uuid, p_participant_identifier text)
--   RETURNS integer  -- the NEW questions.vote_count after the removal.
--
-- Steps (in one transaction, so delete + decrement are atomic):
--   1. Look up + lock the question row (FOR UPDATE). If the question does not
--      exist → RAISE 'question_not_found'.
--   2. DELETE the participant's vote row. If a row was deleted, atomically
--      decrement questions.vote_count by 1 (guarded so it never goes below 0 —
--      the questions_vote_count_nonneg_chk CHECK also protects) and return the
--      new count (Req 4.5).
--   3. If NO vote row existed, leave vote_count unchanged and RAISE
--      'no_vote_to_remove' (Req 4.6 — return an error indicating no vote exists
--      to remove; the count is a no-op, unchanged).
--
-- Note: removal is intentionally NOT rate-limited or eligibility-gated — a
-- participant must always be able to withdraw a vote they already cast, even if
-- the question's status changed after they voted. This preserves the
-- add/remove round-trip (Correctness Property 2).
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
    v_exists     boolean;
    v_deleted    integer;
    v_new_count  integer;
BEGIN
    -- Defensive input validation.
    IF p_question_id IS NULL OR p_participant_identifier IS NULL THEN
        RAISE EXCEPTION 'question_not_found';
    END IF;

    -- 1. Lock the parent question row so the delete + decrement is race-free
    --    with concurrent casts/removes on the same question.
    SELECT true
      INTO v_exists
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

    -- (Task 13.4) A vote-count Realtime Broadcast / NOTIFY could be emitted
    -- here for the parent event. Deliberately NOT implemented in this task.

    RETURN v_new_count;
END;
$$;

COMMENT ON FUNCTION remove_question_vote(uuid, text) IS
    'Atomically removes the participant''s vote and decrements '
    'questions.vote_count (guarded ≥ 0); returns the new vote_count (Req 4.5). '
    'SECURITY DEFINER (server-mediated). Removing when no active vote exists is '
    'a no-op on the count and RAISEs no_vote_to_remove (Req 4.6). Raises '
    'question_not_found when the question id is unknown.';

-- ----------------------------------------------------------------------------
-- Grants. Anonymous participants invoke these RPCs, so EXECUTE is granted to
-- both anon and authenticated. The functions are SECURITY DEFINER and mediate
-- all access to question_votes / questions.vote_count; no direct table write
-- privileges are granted to anon/authenticated.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION cast_question_vote(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION cast_question_vote(uuid, text) TO authenticated;

GRANT EXECUTE ON FUNCTION remove_question_vote(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION remove_question_vote(uuid, text) TO authenticated;
