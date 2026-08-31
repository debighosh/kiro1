-- ============================================================================
-- Migration: 20260101000035_rate_limit_actions.sql
-- Purpose:   Extend the server-side rate-limit action set so anonymous poll
--            responses and word-cloud responses are rate-limited under their
--            OWN dedicated buckets instead of piggy-backing on the shared
--            'vote' bucket (Milestone 5 — Hardening & Readiness, Task 39.1).
--
--            When the poll-response RPC (…000027, broadcast added in …000029)
--            and the word-cloud response RPC (…000026) were first authored, the
--            shared rate-limit primitive `check_and_record_rate_limit(...)` and
--            the `rate_events.action` CHECK constraint — both defined in
--            20260101000013_rate_limiting.sql — accepted ONLY the action values
--            `'submit_question'` and `'vote'`. Adding a brand-new action value
--            without also widening BOTH the primitive's allow-list guard AND the
--            CHECK constraint would have made EVERY such response fail as
--            `rate_limited` (the primitive returns FALSE for an unknown action
--            before it ever inserts). So both respond RPCs deliberately REUSED
--            the `'vote'` bucket, and each left an explicit note that "if a
--            future task widens the allowed action set … this call can be
--            switched to that value with no other change here". THIS migration
--            is that future task. It:
--              1. Widens the `rate_events_action_chk` CHECK constraint to also
--                 permit `'poll_respond'` and `'word_cloud_respond'`.
--              2. CREATE OR REPLACEs BOTH overloads of
--                 `check_and_record_rate_limit(...)` (the 5-arg and the
--                 6-arg-with-fingerprint versions) so their internal
--                 `IF p_action NOT IN (...)` allow-list guard also accepts the
--                 two new actions — ALL other behaviour (advisory lock, sliding
--                 window, SECURITY DEFINER, locked search_path, grants) is
--                 preserved verbatim.
--              3. Adds two thin convenience wrappers
--                 (`check_poll_respond_rate_limit` / `check_word_cloud_respond_rate_limit`)
--                 mirroring `check_submit_rate_limit` / `check_vote_rate_limit`,
--                 baking in the same 30 / 60 s limit.
--              4. CREATE OR REPLACEs `submit_poll_response(...)` and
--                 `submit_word_cloud_response(...)` so they call the limiter with
--                 their DEDICATED action (`'poll_respond'` / `'word_cloud_respond'`)
--                 instead of `'vote'`, keeping the SAME 30 / 60 s limit and every
--                 other line of logic identical. For `submit_poll_response` the
--                 replacement is based on the CURRENT definition in
--                 20260101000029_poll_broadcast.sql (which added the Task 21.4
--                 poll-results broadcast), so the broadcast is PRESERVED.
--
-- Ordering: this migration is named `…000035_…` so it sorts (byte-lexicographic,
--           matching the Supabase CLI's directory read order) AFTER every
--           earlier migration — in particular after
--           `20260101000034_ai_jobs_clusters_rls.sql` (the latest Milestone 4
--           migration). It depends on objects that all sort before it:
--             * `rate_events` + `rate_events_action_chk` CHECK, and BOTH
--               overloads of `check_and_record_rate_limit(...)` plus the default
--               wrappers (…000013_rate_limiting) — the constraint/functions this
--               migration widens.
--             * `submit_word_cloud_response(uuid, text, text)` (…000026) — the
--               word-cloud respond RPC re-created here.
--             * `submit_poll_response(uuid, text, uuid)` — first authored in
--               …000027 and CURRENTLY defined (with the poll-results broadcast)
--               in …000029_poll_broadcast; the definition re-created here is
--               based on that latest version so the broadcast is not regressed.
--             * `broadcast_poll_results(uuid, uuid)` (…000029) — invoked, still
--               PERFORMed by the re-created submit_poll_response.
--             * `polls` / `poll_options` (…000017), `poll_responses` (…000018),
--               `word_cloud_prompts` / `word_cloud_responses` (…000019),
--               `events` (…000002), `event_is_live(uuid)` (…000006).
--           All of the above sort before `…000035`, so the ordering is sound.
--
-- Scope (Task 39.1 ONLY):
--   * Extends the rate-limit action set and rewires the two respond RPCs onto
--     their dedicated buckets. It deliberately does NOT change the 30 / 60 s
--     limit values, the question-submit (10 / 60 s) or question-vote (30 / 60 s)
--     limits, or any client code — the action bucket is a SERVER-SIDE-ONLY
--     concept, and every respond RPC already enforces the limit server-side, so
--     no client change is required. `src/lib/polls.ts` and
--     `src/lib/wordCloudClient.ts` merely invoke the RPCs by name via
--     `supabase.rpc(...)` and continue to map the same `rate_limited` signal.
--
-- ----------------------------------------------------------------------------
-- Behaviour and requirements traceability
-- ----------------------------------------------------------------------------
--   * Server-side submit limit UNCHANGED (Req 21.13): question submissions
--     remain 10 / 60 s, enforced by submit_question via check_submit_rate_limit
--     → the 'submit_question' bucket. This migration does not touch that path.
--   * Server-side vote limit UNCHANGED (Req 21.14): question votes remain
--     30 / 60 s, enforced by cast_question_vote via check_vote_rate_limit → the
--     'vote' bucket. This migration does not touch that path.
--   * Dedicated respond buckets (Req 21.15): poll responses and word-cloud
--     responses are now counted under `'poll_respond'` / `'word_cloud_respond'`
--     respectively (each 30 / 60 s, event-scoped) rather than sharing the 'vote'
--     bucket. On exceed the primitive returns FALSE and records NOTHING, and the
--     RPC RAISEs 'rate_limited' (SQLSTATE P0001) persisting nothing further —
--     exactly as before, only under a distinct, non-interfering counter. Poll
--     responses, word-cloud responses and question votes no longer contend for
--     the same 30-action window.
--
-- Security model (UNCHANGED):
--   * `rate_events` keeps its RLS default-deny posture with no client policies;
--     access is only ever through the SECURITY DEFINER helpers / service role.
--   * Both `check_and_record_rate_limit(...)` overloads and both respond RPCs
--     remain SECURITY DEFINER with a locked `search_path = public, pg_temp`.
--   * `broadcast_poll_results` remains an internal helper reached only through
--     the SECURITY DEFINER RPC; it is NOT granted to anon/authenticated.
--   * EXECUTE grants are re-issued idempotently below (CREATE OR REPLACE
--     preserves grants, but re-issuing is belt-and-braces).
--
-- Requirements: 21.13, 21.14, 21.15.
-- Design ref:  RLS Design → Server-side rate limiting (Req 21.13–21.15);
--              Request/data flows → submit / vote / respond; Decision D8
--              (server-side rate limiting via RPC/Edge Function).
--
-- Idempotency (of the migration itself): the CHECK swap uses DROP CONSTRAINT
--   IF EXISTS + ADD CONSTRAINT; all functions use CREATE OR REPLACE; the GRANTs
--   are naturally idempotent. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Widen the rate_events.action CHECK to permit the two new dedicated
--    actions alongside the original 'submit_question' / 'vote'. Done as
--    DROP IF EXISTS + ADD so the migration is idempotent and the constraint
--    ends in a known-good state regardless of prior runs.
-- ----------------------------------------------------------------------------
ALTER TABLE rate_events DROP CONSTRAINT IF EXISTS rate_events_action_chk;
ALTER TABLE rate_events ADD CONSTRAINT rate_events_action_chk
    CHECK (action IN ('submit_question', 'vote', 'poll_respond', 'word_cloud_respond'));

-- ----------------------------------------------------------------------------
-- 2. Re-create BOTH overloads of check_and_record_rate_limit so the allow-list
--    guard also accepts 'poll_respond' and 'word_cloud_respond'. Everything
--    else (defensive input validation, non-positive limit/window guard, the
--    per-participant+action transaction-scoped advisory lock, the sliding
--    window count, the record-nothing-on-exceed behaviour, SECURITY DEFINER,
--    the locked search_path) is preserved verbatim from …000013.
-- ----------------------------------------------------------------------------

-- 2a. The base 5-arg primitive.
CREATE OR REPLACE FUNCTION check_and_record_rate_limit(
    p_participant_identifier text,
    p_action                 text,
    p_event_id               uuid,
    p_max                    int,
    p_window_seconds         int
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count       int;
    v_window_start timestamptz;
BEGIN
    -- Validate inputs defensively; treat missing/invalid config as "no allow".
    IF p_participant_identifier IS NULL
       OR p_action IS NULL
       OR p_max IS NULL
       OR p_window_seconds IS NULL THEN
        RETURN false;
    END IF;

    -- Allow-list guard. Widened (Task 39.1) to also accept the dedicated poll /
    -- word-cloud respond actions alongside the original submit / vote actions.
    -- Must stay in lock-step with the rate_events_action_chk CHECK above.
    IF p_action NOT IN ('submit_question', 'vote', 'poll_respond', 'word_cloud_respond') THEN
        RETURN false;
    END IF;

    -- A non-positive limit means "never allow"; a non-positive window is invalid.
    IF p_max <= 0 OR p_window_seconds <= 0 THEN
        RETURN false;
    END IF;

    v_window_start := now() - make_interval(secs => p_window_seconds);

    -- Serialise concurrent calls for the same participant + action so the
    -- count-then-insert sequence is race-free. Transaction-scoped advisory lock
    -- (released at COMMIT/ROLLBACK). hashtextextended gives a stable 64-bit key.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_participant_identifier || '|' || p_action, 0)
    );

    -- Count actions in the sliding window for this participant + action.
    SELECT count(*)
      INTO v_count
      FROM rate_events re
     WHERE re.participant_identifier = p_participant_identifier
       AND re.action                 = p_action
       AND re.occurred_at           >= v_window_start
       AND (
             p_event_id IS NULL
          OR re.event_id IS NULL
          OR re.event_id = p_event_id
           );

    -- Limit exceeded: reject and record NOTHING (Req 21.15).
    IF v_count >= p_max THEN
        RETURN false;
    END IF;

    -- Within limit: record the action and allow it.
    INSERT INTO rate_events (participant_identifier, client_fingerprint, action, event_id)
    VALUES (p_participant_identifier, NULL, p_action, p_event_id);

    RETURN true;
END;
$$;

COMMENT ON FUNCTION check_and_record_rate_limit(text, text, uuid, int, int) IS
    'Generic server-side rate-limit primitive (Req 21.13-21.15). Returns TRUE '
    'and records the action when the participant is within p_max actions of the '
    'given type over the last p_window_seconds; returns FALSE and records '
    'nothing when the limit is exceeded. SECURITY DEFINER with a locked '
    'search_path; serialises concurrent calls per participant+action. Allowed '
    'actions (Task 39.1): submit_question, vote, poll_respond, word_cloud_respond.';

-- 2b. The 6-arg overload that also records a coarse, non-PII client fingerprint.
CREATE OR REPLACE FUNCTION check_and_record_rate_limit(
    p_participant_identifier text,
    p_client_fingerprint     text,
    p_action                 text,
    p_event_id               uuid,
    p_max                    int,
    p_window_seconds         int
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count        int;
    v_window_start timestamptz;
BEGIN
    IF p_participant_identifier IS NULL
       OR p_action IS NULL
       OR p_max IS NULL
       OR p_window_seconds IS NULL THEN
        RETURN false;
    END IF;

    -- Allow-list guard, widened for the dedicated respond actions (Task 39.1),
    -- kept identical to the 5-arg overload above and the CHECK constraint.
    IF p_action NOT IN ('submit_question', 'vote', 'poll_respond', 'word_cloud_respond') THEN
        RETURN false;
    END IF;

    IF p_max <= 0 OR p_window_seconds <= 0 THEN
        RETURN false;
    END IF;

    v_window_start := now() - make_interval(secs => p_window_seconds);

    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_participant_identifier || '|' || p_action, 0)
    );

    SELECT count(*)
      INTO v_count
      FROM rate_events re
     WHERE re.participant_identifier = p_participant_identifier
       AND re.action                 = p_action
       AND re.occurred_at           >= v_window_start
       AND (
             p_event_id IS NULL
          OR re.event_id IS NULL
          OR re.event_id = p_event_id
           );

    IF v_count >= p_max THEN
        RETURN false;
    END IF;

    INSERT INTO rate_events (participant_identifier, client_fingerprint, action, event_id)
    VALUES (p_participant_identifier, p_client_fingerprint, p_action, p_event_id);

    RETURN true;
END;
$$;

COMMENT ON FUNCTION check_and_record_rate_limit(text, text, text, uuid, int, int) IS
    'Overload of the rate-limit primitive that also records a coarse, non-PII '
    'client fingerprint (Req 21.13-21.15). The window key remains the opaque '
    'participant_identifier; the fingerprint is stored only as an additional '
    'non-PII hint. Allowed actions (Task 39.1): submit_question, vote, '
    'poll_respond, word_cloud_respond.';

-- ----------------------------------------------------------------------------
-- 3. Thin convenience wrappers baking in the DEFAULT respond thresholds
--    (30 / 60 s — the same limit the respond RPCs already used, Req 21.14),
--    mirroring check_submit_rate_limit / check_vote_rate_limit. These keep the
--    default respond policy in one place; the RPCs below call the generic
--    primitive directly with explicit limits (matching the prior code path),
--    but these wrappers are available for callers that prefer the default.
-- ----------------------------------------------------------------------------

-- Default: 30 poll responses per anonymous client / 60 s (Req 21.14-style).
CREATE OR REPLACE FUNCTION check_poll_respond_rate_limit(
    p_participant_identifier text,
    p_event_id               uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT check_and_record_rate_limit(
        p_participant_identifier,
        'poll_respond',
        p_event_id,
        30,   -- default max poll responses in the window
        60    -- default window seconds
    );
$$;

COMMENT ON FUNCTION check_poll_respond_rate_limit(text, uuid) IS
    'Default poll-response rate limit (Task 39.1; Req 21.15): 30 responses / '
    '60 s per anonymous participant under the dedicated ''poll_respond'' bucket. '
    'Delegates to check_and_record_rate_limit.';

-- Default: 30 word-cloud responses per anonymous client / 60 s.
CREATE OR REPLACE FUNCTION check_word_cloud_respond_rate_limit(
    p_participant_identifier text,
    p_event_id               uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT check_and_record_rate_limit(
        p_participant_identifier,
        'word_cloud_respond',
        p_event_id,
        30,   -- default max word-cloud responses in the window
        60    -- default window seconds
    );
$$;

COMMENT ON FUNCTION check_word_cloud_respond_rate_limit(text, uuid) IS
    'Default word-cloud response rate limit (Task 39.1; Req 21.15): 30 '
    'responses / 60 s per anonymous participant under the dedicated '
    '''word_cloud_respond'' bucket. Delegates to check_and_record_rate_limit.';

-- ----------------------------------------------------------------------------
-- 4a. Re-create submit_word_cloud_response so it counts under the dedicated
--     'word_cloud_respond' action instead of the shared 'vote' bucket. This is
--     the EXACT switch the …000026 header said a future task could make "with
--     no other change here": the ONLY difference from the …000026 definition is
--     the action argument passed to check_and_record_rate_limit. Every other
--     line — the prompt/event resolution, the open + live gating, the 1–50
--     length validation, the normalise-on-write rule, and the upsert preserving
--     is_hidden — is IDENTICAL. CREATE OR REPLACE re-emits the FULL body.
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
    -- 1. Rate limit FIRST (Req 21.13–21.15). Uses the DEDICATED
    --    'word_cloud_respond' bucket (30 / 60 s, event-scoped) — switched from
    --    the shared 'vote' bucket by Task 39.1 now that the action set has been
    --    widened. On exceed the primitive returns FALSE and records nothing; we
    --    reject and persist nothing further. This runs FIRST so an abusive
    --    client is throttled before any other work.
    -- ------------------------------------------------------------------------
    IF NOT check_and_record_rate_limit(
               p_participant_identifier,
               'word_cloud_respond',
               v_event_id,
               30,   -- max responses in the window (Req 21.14-style limit)
               60    -- window seconds
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
    '23.8) rewired by Task 39.1 to the dedicated ''word_cloud_respond'' rate '
    'bucket. SECURITY DEFINER. Order: resolve prompt event_id -> rate-limit '
    '(30/60s, ''word_cloud_respond'' bucket) -> prompt must be ''open'' -> '
    'event must be live -> trim + 1-50 code-point length -> normalise on write '
    '(lower/trim/collapse internal whitespace, twin of src/lib/wordcloud.ts) -> '
    'upsert on UNIQUE (participant_identifier, prompt_id), preserving is_hidden '
    'on resubmit. Error signals (SQLSTATE P0001, MESSAGE): rate_limited, '
    'prompt_not_found, prompt_not_open, event_not_live, invalid_length.';

-- ----------------------------------------------------------------------------
-- 4b. Re-create submit_poll_response so it counts under the dedicated
--     'poll_respond' action instead of the shared 'vote' bucket. The body is
--     based on the CURRENT definition in 20260101000029_poll_broadcast.sql
--     (which added the Task 21.4 poll-results Realtime broadcast) so the
--     PERFORM broadcast_poll_results(...) call is PRESERVED — the ONLY change
--     versus …000029 is the action argument passed to
--     check_and_record_rate_limit. Every other line — resolve+lock poll, the
--     open/live gating, option validity, the atomic upsert-replace with
--     response_count maintenance, and the best-effort broadcast — is IDENTICAL.
--     CREATE OR REPLACE re-emits the FULL body.
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
    -- 2. Rate limit (Req 21.13–21.15). Uses the DEDICATED 'poll_respond' bucket
    --    (30 / 60 s, event-scoped) — switched from the shared 'vote' bucket by
    --    Task 39.1 now that the action set has been widened. On exceed the
    --    primitive returns FALSE and records nothing; we reject and persist
    --    nothing further.
    -- ------------------------------------------------------------------------
    IF NOT check_and_record_rate_limit(
               p_participant_identifier,
               'poll_respond',
               v_event_id,
               30,   -- max responses in the window (Req 21.14-style limit)
               60    -- window seconds
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
    '(Decision D9; Req 5.11, 5.12, 23.1, 23.2), rewired by Task 39.1 to the '
    'dedicated ''poll_respond'' rate bucket. SECURITY DEFINER. Order: '
    'resolve+lock poll (FOR UPDATE) -> rate-limit (30/60s, ''poll_respond'' '
    'bucket) -> poll must be ''open'' (draft=>poll_not_open, closed=>poll_closed) '
    '-> event must be live -> option must belong to the poll -> upsert-replace '
    'the participant''s single response with atomic poll_options.response_count '
    'maintenance (new=+1; same option=no-op; changed=move -1 old/+1 new) -> '
    'best-effort broadcast_poll_results. Returns the poll_responses row. Error '
    'signals (SQLSTATE P0001, MESSAGE): poll_not_found, rate_limited, '
    'poll_not_open, poll_closed, event_not_live, invalid_option.';

-- ----------------------------------------------------------------------------
-- 5. Grants. CREATE OR REPLACE preserves existing grants, but we re-issue
--    EXECUTE idempotently to be safe. The primitives + participant-facing RPCs
--    are invoked by anonymous participants, so both anon and authenticated must
--    be able to EXECUTE them; all are SECURITY DEFINER and mediate every access
--    to rate_events / poll_responses / word_cloud_responses, so no direct table
--    privilege is exposed. broadcast_poll_results is intentionally NOT granted
--    to anon/authenticated (reached only indirectly, with definer rights).
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, uuid, int, int) TO anon;
GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, uuid, int, int) TO authenticated;

GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, text, uuid, int, int) TO anon;
GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, text, uuid, int, int) TO authenticated;

GRANT EXECUTE ON FUNCTION check_poll_respond_rate_limit(text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION check_poll_respond_rate_limit(text, uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION check_word_cloud_respond_rate_limit(text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION check_word_cloud_respond_rate_limit(text, uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION submit_word_cloud_response(uuid, text, text) TO anon;
GRANT EXECUTE ON FUNCTION submit_word_cloud_response(uuid, text, text) TO authenticated;

GRANT EXECUTE ON FUNCTION submit_poll_response(uuid, text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION submit_poll_response(uuid, text, uuid) TO authenticated;
