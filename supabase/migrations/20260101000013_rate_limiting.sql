-- ============================================================================
-- Migration: 20260101000013_rate_limiting.sql
-- Purpose:   Shared server-side rate-limiting groundwork for anonymous
--            participant actions (question submit + vote). Creates:
--              1. A short-lived `rate_events` table recording recent anonymous
--                 actions (keyed by participant identifier + coarse client
--                 fingerprint + action type), used to compute a sliding window.
--              2. A `SECURITY DEFINER` helper `check_and_record_rate_limit(...)`
--                 that atomically checks the sliding window and, if within the
--                 configured limit, records the action and returns TRUE; if the
--                 limit is exceeded it returns FALSE and records NOTHING.
--              3. Thin convenience wrappers baking in the DEFAULT thresholds
--                 that the submit / vote RPCs (tasks 13.2 / 13.3) will use.
--
-- Default thresholds (configurable — passed by the calling RPCs):
--   * Question submissions: 10 submissions per anonymous client / 60 s (Req 21.13).
--   * Votes:                30 votes       per anonymous client / 60 s (Req 21.14).
-- On exceed, the enforcement returns a rate-limit-exceeded signal (FALSE) and
-- records NOTHING (Req 21.15).
--
-- Ordering: this migration sorts AFTER the questions/votes/RLS migrations
--           (…000009 questions, …000010 question_votes, …000011 questions_rls,
--           …000012 question_votes_rls). Using …000013 is correct per the plan.
--           It depends only on the `events` table (…000002) for the optional
--           `event_id` FK scoping, which already exists. It does NOT depend on
--           `questions`/`question_votes`, so there is no conflict with the
--           concurrently-authored task 11.1 (…000009) migration — this owns a
--           different file.
--
-- Scope (Task 13.1, Milestone 2 only):
--   * Creates ONLY the rate-limiting groundwork (rate_events table + limit
--     helper + default wrappers). It deliberately does NOT implement the
--     question-submit RPC (task 13.2) or the vote RPC (task 13.3); those tasks
--     call the helper defined here.
--
-- Privacy (Req 21.16): `participant_identifier` is an opaque, client-generated
--   value carrying NO personal data; `client_fingerprint` is a coarse,
--   non-PII client hint (optional). No names, emails, or IP addresses are
--   stored here.
--
-- Security model:
--   * RLS is ENABLED on `rate_events` with a DEFAULT-DENY posture and NO client
--     policies. The table is written/read ONLY by the SECURITY DEFINER helper
--     functions below (and by the service role, which bypasses RLS). Anonymous
--     and authenticated clients therefore cannot read or write it directly
--     (Req 21.3, 21.4).
--   * The helper functions are SECURITY DEFINER with a locked `search_path`
--     (public, pg_temp) so they enforce limits reliably under RLS and cannot be
--     hijacked via a caller-controlled search_path. EXECUTE is granted to `anon`
--     and `authenticated` because the submit/vote RPCs (which anon invokes)
--     call these helpers.
--
-- Requirements traceability:
--   * Req 21.13 — configurable server-side limit on anonymous submissions
--                 (default 10 / 60 s).
--   * Req 21.14 — configurable server-side limit on anonymous votes
--                 (default 30 / 60 s).
--   * Req 21.15 — on exceed: reject, signal rate-limit-exceeded, record nothing.
-- Design ref:   RLS Design → Server-side rate limiting (Req 21.13–21.15);
--               Decision D8 (server-side rate limiting via RPC/Edge Function).
--
-- Idempotency: table/index use IF NOT EXISTS; functions use CREATE OR REPLACE;
--   RLS enablement is naturally idempotent. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- rate_events
-- Short-lived ledger of recent anonymous actions. Rows are only needed within
-- the rate-limit window (default 60 s) plus a small margin; older rows can be
-- pruned (see prune_rate_events below). Intentionally minimal and PII-free.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_events (
    -- Unique event id.
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Opaque, client-generated participant identifier. Carries NO personal
    -- data (Req 21.16). This is the primary key for the sliding-window count.
    participant_identifier text        NOT NULL,

    -- Coarse, non-PII client hint (optional). May be used to make the window
    -- key slightly more robust; never contains personal information.
    client_fingerprint     text        NULL,

    -- The rate-limited action type. For Milestone 2 the only rate-limited
    -- actions are anonymous question submission and voting.
    action                 text        NOT NULL
                                       CONSTRAINT rate_events_action_chk
                                       CHECK (action IN ('submit_question', 'vote')),

    -- Optional event scoping. If a caller passes an event id, limits can be
    -- reasoned about per event; when NULL the limit is global to the
    -- participant + action. FK CASCADE keeps the ledger clean when an event is
    -- deleted (Req 21.17 event deletion).
    event_id               uuid        NULL REFERENCES events (id) ON DELETE CASCADE,

    -- When the action occurred (UTC). Drives the sliding-window comparison.
    occurred_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE rate_events IS
    'Short-lived ledger of recent anonymous actions used for server-side rate '
    'limiting (Req 21.13-21.15). PII-free: participant_identifier is opaque and '
    'client_fingerprint is a coarse non-PII hint. Written/read only by the '
    'SECURITY DEFINER rate-limit helpers / service role; RLS default-deny with '
    'no client policies.';

-- Index supporting the sliding-window count: given a participant + action, find
-- rows within the recent window quickly (occurred_at ordered for range scans).
CREATE INDEX IF NOT EXISTS idx_rate_events_participant_action_time
    ON rate_events (participant_identifier, action, occurred_at);

-- Enable RLS (default deny). No client policies are defined: the table is
-- accessed exclusively by the SECURITY DEFINER helpers below (which run with
-- the definer's rights) and by the service role (which bypasses RLS). This
-- ensures anonymous / authenticated clients can neither read nor write it
-- directly (Req 21.3, 21.4).
ALTER TABLE rate_events ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- check_and_record_rate_limit(
--     p_participant_identifier text,
--     p_action                 text,
--     p_event_id               uuid,
--     p_max                    int,
--     p_window_seconds         int
-- ) RETURNS boolean
--
-- The generic, configurable rate-limit primitive (the deliverable of task 13.1).
-- Behaviour:
--   * Counts rows in `rate_events` for (participant_identifier, action) whose
--     `occurred_at` falls within the last `p_window_seconds` seconds.
--     (Event scoping: when p_event_id IS NOT NULL the count is restricted to
--     that event OR global rows; when NULL, all rows for the participant/action
--     in the window are counted.)
--   * If the count is >= p_max, the limit is exceeded: returns FALSE and
--     records NOTHING (Req 21.15).
--   * Otherwise it inserts a new `rate_events` row (recording the action) and
--     returns TRUE (allowed).
--
-- Concurrency: a transaction-scoped advisory lock keyed by the participant +
--   action is taken so concurrent calls for the same participant serialise,
--   preventing a check/insert race from allowing more than p_max actions.
--
-- SECURITY DEFINER + locked search_path so it enforces the limit reliably under
-- RLS and cannot be hijacked via a caller-controlled search_path.
-- ----------------------------------------------------------------------------
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

    IF p_action NOT IN ('submit_question', 'vote') THEN
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
    'search_path; serialises concurrent calls per participant+action.';

-- ----------------------------------------------------------------------------
-- Optional overload accepting a coarse client fingerprint. The submit/vote RPCs
-- may pass a non-PII client hint; it is recorded alongside the action but does
-- NOT change the window key (the participant_identifier remains authoritative).
-- ----------------------------------------------------------------------------
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

    IF p_action NOT IN ('submit_question', 'vote') THEN
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
    'non-PII hint.';

-- ----------------------------------------------------------------------------
-- Thin convenience wrappers baking in the DEFAULT thresholds the submit/vote
-- RPCs (tasks 13.2 / 13.3) will use. These keep the default policy in one place
-- while the generic function above remains the reusable primitive. The RPCs may
-- call these wrappers or the generic function directly with explicit limits.
-- ----------------------------------------------------------------------------

-- Default: 10 question submissions per anonymous client / 60 s (Req 21.13).
CREATE OR REPLACE FUNCTION check_submit_rate_limit(
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
        'submit_question',
        p_event_id,
        10,   -- default max submissions (Req 21.13)
        60    -- default window seconds (Req 21.13)
    );
$$;

COMMENT ON FUNCTION check_submit_rate_limit(text, uuid) IS
    'Default question-submit rate limit (Req 21.13): 10 submissions / 60 s per '
    'anonymous participant. Delegates to check_and_record_rate_limit.';

-- Default: 30 votes per anonymous client / 60 s (Req 21.14).
CREATE OR REPLACE FUNCTION check_vote_rate_limit(
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
        'vote',
        p_event_id,
        30,   -- default max votes (Req 21.14)
        60    -- default window seconds (Req 21.14)
    );
$$;

COMMENT ON FUNCTION check_vote_rate_limit(text, uuid) IS
    'Default vote rate limit (Req 21.14): 30 votes / 60 s per anonymous '
    'participant. Delegates to check_and_record_rate_limit.';

-- ----------------------------------------------------------------------------
-- prune_rate_events(p_retain_seconds int)
-- Optional maintenance helper: deletes rate_events older than the retention
-- window (default 300 s = 5 minutes, comfortably larger than the 60 s limit
-- window). Keeps the ledger small. This can be invoked opportunistically by an
-- RPC or on a schedule.
--
-- NOTE: No pg_cron dependency is introduced here. If a scheduler is available,
-- a periodic call such as `SELECT prune_rate_events(300);` (e.g. every few
-- minutes) is recommended to bound table size; otherwise the table stays small
-- because entries are only meaningful within the short limit window.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_rate_events(p_retain_seconds int DEFAULT 300)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    DELETE FROM rate_events
    WHERE occurred_at < now() - make_interval(secs => GREATEST(p_retain_seconds, 0));
$$;

COMMENT ON FUNCTION prune_rate_events(int) IS
    'Maintenance helper: removes rate_events older than the retention window '
    '(default 300 s). No pg_cron dependency; call opportunistically or on a '
    'schedule to bound table size.';

-- ----------------------------------------------------------------------------
-- Grants. The submit/vote RPCs are invoked by anonymous participants, so both
-- anon and authenticated must be able to EXECUTE the rate-limit helpers (which
-- themselves are SECURITY DEFINER and mediate all access to rate_events). No
-- direct table privileges are granted to anon/authenticated — access is only
-- ever through these functions.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, uuid, int, int) TO anon;
GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, uuid, int, int) TO authenticated;

GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, text, uuid, int, int) TO anon;
GRANT EXECUTE ON FUNCTION check_and_record_rate_limit(text, text, text, uuid, int, int) TO authenticated;

GRANT EXECUTE ON FUNCTION check_submit_rate_limit(text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION check_submit_rate_limit(text, uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION check_vote_rate_limit(text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION check_vote_rate_limit(text, uuid) TO authenticated;

-- prune_rate_events is a maintenance/service-role operation; it is NOT granted
-- to anon (clients must never trigger bulk deletes). Authenticated admins /
-- service role may run it.
GRANT EXECUTE ON FUNCTION prune_rate_events(int) TO authenticated;
