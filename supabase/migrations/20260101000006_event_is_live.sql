-- ============================================================================
-- Migration: 20260101000006_event_is_live.sql
-- Purpose:   Create the `event_is_live(p_event_id uuid)` SQL helper predicate —
--            a small, reusable boolean function that reports whether the parent
--            event of a child row is currently in the `live` status.
--
-- Ordering: this migration MUST sort AFTER the events table migration
--           (20260101000002_events.sql), because the function reads
--           `events.status`, and after the events indexes migration
--           (20260101000005_events_indexes.sql, added by Task 4.3). The
--           …000006 timestamp places it after both, so `events` (and its
--           `status` column / status index) already exist when this runs.
--
-- Scope (Task 4.6, Milestone 1 only):
--   * Creates ONLY the `event_is_live(uuid)` helper function and its EXECUTE
--     grants to the `anon` and `authenticated` roles.
--   * Deliberately does NOT add any RLS policies that USE this helper — the
--     anonymous SELECT policies for `questions`, `question_votes`, etc. that
--     call `event_is_live(...)` are owned by the RLS tasks (5.x).
--
-- Why SECURITY DEFINER:
--   Anonymous (the `anon` role) audience clients must be able to read child
--   rows (e.g. approved questions) ONLY while the parent event is live. The
--   anonymous SELECT policy on `events` itself is restricted to
--   `status = 'live'` rows, so a child-table policy that tried to look up the
--   parent event's status directly (via a correlated subquery against `events`)
--   would be re-filtered by the caller's own RLS on `events` — and for
--   not-yet-live or ended events it could not even see the row to evaluate its
--   status. Wrapping the lookup in a STABLE SECURITY DEFINER function lets the
--   child policy evaluate the parent event's live status reliably, without
--   granting anonymous broad SELECT access to `events` and without RLS
--   recursion/visibility issues.
--
-- Safety:
--   * The function returns ONLY a boolean; it never returns or otherwise leaks
--     any event data (name, tokens, timestamps, etc.). The single boolean
--     answer ("is this event live?") is exactly what the anonymous policies
--     already need to make an access decision.
--   * It reads a single column (`events.status`) keyed by primary key `id`.
--   * `search_path` is locked to `public, pg_temp` so the definer-rights
--     execution cannot be hijacked by a caller-controlled search_path
--     (guards against object-shadowing / privilege-escalation).
--   * It is marked STABLE (no writes; result is fixed within a statement) so
--     the planner can use it efficiently inside RLS predicates.
--
-- Requirements traceability:
--   * Req 1.7  — participation (child-row access) permitted only while the
--                event is live.
--   * Req 21.5 — anonymous access confined to active/live event data; provide
--                a reusable helper for anonymous RLS policies.
-- Design ref: RLS Design → General policy strategy (`event_is_live` helper).
--
-- Idempotency: CREATE OR REPLACE FUNCTION makes the definition safe to re-run;
--   the GRANTs are naturally idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- event_is_live(p_event_id uuid) RETURNS boolean
-- Returns TRUE when an `events` row exists with id = p_event_id AND
-- status = 'live'; otherwise FALSE (including when the event does not exist).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION event_is_live(p_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM events
        WHERE id = p_event_id
          AND status = 'live'
    );
$$;

COMMENT ON FUNCTION event_is_live(uuid) IS
    'Reusable RLS helper (Req 1.7, 21.5): returns TRUE iff the event with the '
    'given id has status = ''live''. SECURITY DEFINER with a locked search_path '
    'so anonymous policies on child tables can check the parent event''s live '
    'status without broad SELECT access to events. Exposes only a boolean, '
    'never any event data.';

-- Allow both anonymous (audience) and authenticated (admin) clients to call the
-- helper from their RLS policies. EXECUTE only — no data access is granted.
GRANT EXECUTE ON FUNCTION event_is_live(uuid) TO anon;
GRANT EXECUTE ON FUNCTION event_is_live(uuid) TO authenticated;
