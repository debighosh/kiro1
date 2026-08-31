-- ============================================================================
-- Migration: 20260101000025_poll_transition_rpc.sql
-- Purpose:   Implement the server-side POLL open/close LIFECYCLE RPC for
--            MSS LivePulse (Task 21.2, Milestone 3 — Polls & Word Cloud). One
--            admin-only `SECURITY DEFINER` PostgreSQL function:
--              1. set_poll_status(...) — advance a poll along the
--                 draft → open → closed lifecycle, guarded by the single-open
--                 partial unique index `one_open_poll_per_event`.
--
-- Ordering: This migration is named `…000025_…` so it sorts (byte-lexicographic,
--           matching the Supabase CLI's directory read order) AFTER
--           `20260101000024_word_cloud_prompt_rpc.sql` (the analogous word-cloud
--           prompt lifecycle RPC, whose pattern this file mirrors). It depends on:
--             * `polls` table + the partial UNIQUE index
--               `one_open_poll_per_event` WHERE status='open'
--               (…000017_polls.sql)                       — update target / guard.
--             * `poll_status` enum ('draft','open','closed')
--               (…000017_polls.sql)                       — status param / column.
--           Both sort before `…000025`, so the ordering is sound.
--
-- Scope (Task 21.2 ONLY):
--   * Implements ONLY the poll open/close lifecycle RPC. It deliberately does
--     NOT implement the poll-create RPC (Task 21.1, …000023) nor the
--     poll-response upsert-replace RPC (Task 21.3).
--
-- ----------------------------------------------------------------------------
-- Behaviour and requirements traceability
-- ----------------------------------------------------------------------------
--   set_poll_status (Req 5.4, 5.5, 5.6, 21.6):
--     * Loads the poll's current status first; if the poll does not exist
--       RAISES 'poll_not_found'.
--     * Enforces the lifecycle draft → open → closed. Only draft→open and
--       open→closed are permitted; a no-op same-status set is also allowed
--       (idempotent). ANY other transition (e.g. closed→open, open→draft,
--       closed→draft, draft→closed) RAISES 'invalid_transition' and changes
--       nothing (Req 5.4).
--     * When transitioning TO 'open', the AUTHORITATIVE at-most-one-open-poll
--       -per-event rule is the partial UNIQUE index `one_open_poll_per_event`
--       (…000017). The UPDATE ... SET status='open' is wrapped in a
--       BEGIN ... EXCEPTION WHEN unique_violation block: a second open poll
--       for the same event trips the index (SQLSTATE 23505), which we CATCH and
--       re-RAISE as 'poll_already_open' (SQLSTATE P0001), leaving BOTH polls'
--       statuses unchanged (Req 5.5, 5.6).
--     * Closing a poll (open→closed) STOPS FURTHER RESPONSES. That guarantee is
--       enforced by the poll-response ("respond") RPC (Task 21.3), which checks
--       the poll's status = 'open' before accepting a response; a 'closed' poll
--       therefore rejects new responses. No extra action is required in THIS
--       RPC — flipping the status to 'closed' is sufficient for the respond RPC
--       to begin rejecting responses (documented here for traceability, Req 5.4).
--     * Returns the updated `polls` row.
--
-- Error signals (for the client / Edge layer to map). All raised with SQLSTATE
-- 'P0001' (raise_exception) and MESSAGE set to the signal string so callers can
-- switch on the message:
--   * 'poll_not_found'     — no poll with the given id (→ 404).
--   * 'invalid_transition' — requested status change is not draft→open→closed
--                            (→ 409); nothing changed.
--   * 'poll_already_open'  — another poll for the same event is already 'open'
--                            (→ 409); both statuses unchanged, surfaced to the
--                            user as the "only one poll may be open per event"
--                            message (Req 5.6).
--
-- Security model:
--   * The function is SECURITY DEFINER with `SET search_path = public,
--     pg_temp` so it mediates writes to `polls` (which has RLS with no
--     anonymous/authenticated UPDATE policy — Task 20) and cannot be hijacked
--     via a caller-controlled search_path.
--   * ADMIN AUTHORISATION: EXECUTE is granted to `authenticated` ONLY (NOT
--     anon), mirroring the word-cloud prompt lifecycle + poll-create RPCs. In
--     V1 ANY authenticated user is treated as an admin; a finer-grained admin
--     role/claim check is a future hardening step. Anonymous participants
--     cannot manage poll lifecycle.
--
-- Design ref: Request/data flows → "Poll lifecycle — single-open guard"
--             (draft → open → closed; opening a second poll while one is open
--             is rejected); Data Models → single-open-poll partial unique
--             index `one_open_poll_per_event`.
--
-- Requirements: 5.4, 5.5, 5.6, 21.6.
--
-- Idempotency (of the migration itself): CREATE OR REPLACE FUNCTION + guarded
--   grants make it safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- set_poll_status(
--     p_poll_id uuid,
--     p_status  poll_status
-- ) RETURNS polls
--
-- Advances a poll along the draft → open → closed lifecycle and returns the
-- updated row. Rejects any other transition. Opening a second poll for the
-- same event while one is already open is rejected via the single-open partial
-- unique index, surfaced as 'poll_already_open'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_poll_status(
    p_poll_id uuid,
    p_status  poll_status
)
RETURNS polls
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_current poll_status;
    v_row     polls%ROWTYPE;
BEGIN
    -- ------------------------------------------------------------------------
    -- Load the current status first so we can validate the requested
    -- transition (Req 5.4). A missing poll is rejected with 'poll_not_found'.
    -- ------------------------------------------------------------------------
    SELECT status INTO v_current
      FROM polls
     WHERE id = p_poll_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'poll_not_found' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- Enforce the lifecycle draft → open → closed (Req 5.4). Permitted moves:
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
    -- single-open-poll-per-event guarantee is the partial UNIQUE index
    -- `one_open_poll_per_event` (…000017). If another poll for the same event
    -- is already open, this UPDATE trips the index and raises a
    -- unique_violation (SQLSTATE 23505); we CATCH it and re-RAISE as
    -- 'poll_already_open' (SQLSTATE P0001), leaving BOTH polls' statuses
    -- unchanged (the failed UPDATE is rolled back within the block) (Req 5.5,
    -- 5.6).
    -- ------------------------------------------------------------------------
    IF p_status = 'open' AND v_current <> 'open' THEN
        BEGIN
            UPDATE polls
               SET status = 'open'::poll_status
             WHERE id = p_poll_id
            RETURNING * INTO v_row;
        EXCEPTION
            WHEN unique_violation THEN
                RAISE EXCEPTION 'poll_already_open' USING ERRCODE = 'P0001';
        END;
    ELSE
        -- Covers open→closed, and idempotent same-status no-ops. Closing a poll
        -- here is sufficient to stop further responses: the respond RPC
        -- (Task 21.3) rejects responses unless the poll status = 'open'.
        UPDATE polls
           SET status = p_status
         WHERE id = p_poll_id
        RETURNING * INTO v_row;
    END IF;

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION set_poll_status(uuid, poll_status) IS
    'Poll status-transition RPC (Task 21.2; Req 5.4, 5.5, 5.6, 21.6). SECURITY '
    'DEFINER, admin-only (EXECUTE granted to authenticated only; V1 = any '
    'authenticated user is admin). Enforces the lifecycle draft->open->closed '
    '(loads current status first); opening a second poll while one is open '
    'trips the one_open_poll_per_event partial unique index. Closing a poll '
    'stops further responses (the respond RPC checks status=open). Error '
    'signals (SQLSTATE P0001, MESSAGE): poll_not_found, invalid_transition, '
    'poll_already_open (both statuses unchanged on the last).';

-- ----------------------------------------------------------------------------
-- Grants. ADMIN AUTHORISATION: poll lifecycle management is an admin action,
-- so EXECUTE is granted to `authenticated` ONLY (NOT anon), mirroring the
-- word-cloud prompt lifecycle + poll-create RPCs. V1 treats ANY authenticated
-- user as an admin. The function is SECURITY DEFINER and mediates the writes to
-- `polls` (which has no anonymous/authenticated write policy), so this grant
-- does not expose any direct table access.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION set_poll_status(uuid, poll_status) TO authenticated;
