-- ============================================================================
-- Migration: 20260101000023_create_poll_rpc.sql
-- Purpose:   Implement the server-side poll-create RPC for MSS LivePulse
--            (Task 21.1, Milestone 3 — Polls & Word Cloud). This is a single
--            `SECURITY DEFINER` PostgreSQL function that an admin invokes to
--            author a new poll together with its answer options, atomically, in
--            one transaction. It performs, in order:
--              1. Full server-side validation of question text, display order,
--                 results visibility, and the option set (count + each text).
--              2. On ANY validation failure: RAISE EXCEPTION (SQLSTATE P0001)
--                 with a stable field-identifying signal message and persist
--                 NOTHING — a plpgsql function is atomic, so a RAISE aborts all
--                 inserts made so far and no partial poll survives.
--              3. Insert of the poll (status defaults to 'draft') and its
--                 options (display_order = array index + 1, response_count 0).
--              4. Return of the created `polls` row.
--
-- Ordering: This migration is named `…000023_…` so it sorts (byte-lexicographic,
--           matching the Supabase CLI's directory read order) AFTER
--           `20260101000022_word_cloud_rls.sql` — the last Milestone-3 schema
--           migration on disk — and, crucially, after:
--             * `20260101000017_polls.sql` — defines the `polls` and
--               `poll_options` tables (the insert targets and the RETURNS row
--               type), the `poll_results_visibility` enum, the `polls`
--               question_text 1–200 / display_order > 0 CHECK constraints, the
--               `poll_options` text 1–100 / response_count ≥ 0 CHECKs, and the
--               DEFERRABLE INITIALLY DEFERRED `trg_poll_options_enforce_count`
--               constraint trigger that validates the 2–10 options-per-poll
--               rule at COMMIT.
--             * `20260101000020_polls_rls.sql` /
--               `20260101000021_poll_responses_rls.sql` — RLS on polls /
--               poll_options (which have NO direct client INSERT policy; this
--               SECURITY DEFINER RPC is the sanctioned write path).
--           All of the above sort before `…000023`, so the ordering is sound.
--
-- Scope (Task 21.1 ONLY):
--   * Implements ONLY the poll-create RPC. It deliberately does NOT implement
--     the poll open/close transition RPC (Task 21.2) nor the poll-respond RPC
--     (Task 21.3). It creates only the `create_poll(...)` function.
--
-- ----------------------------------------------------------------------------
-- Behaviour and requirements traceability
-- ----------------------------------------------------------------------------
--   * Poll + options authored atomically in 'draft' (Req 5.1, 5.2, 5.3, 10.1):
--     the poll is inserted with its column-default status 'draft' (not visible
--     to the audience until later opened — Task 21.2), immediately followed by
--     its 2–10 options. Because the whole function body runs in one implicit
--     transaction, and the 2–10 option-count trigger (Task 19.2) is DEFERRABLE
--     INITIALLY DEFERRED, the complete option set is validated as a SET at the
--     function's implicit commit — inserting the options incrementally never
--     trips the lower bound mid-transaction.
--
--   * Question text 1–200 chars (Req 5.1, 22.2): `char_length` (Unicode code
--     points) of `p_question_text` must be BETWEEN 1 AND 200 after trim. NULL,
--     empty, whitespace-only, or over-length ⇒ RAISE 'invalid_question_text'.
--     (This mirrors the `polls_question_text_length_chk` CHECK, validating the
--     same bound up-front so the error carries the stable field signal.)
--
--   * Positive display_order (Req 5.1): `p_display_order` must be NOT NULL and
--     > 0 (mirrors `polls_display_order_positive_chk`). Otherwise RAISE
--     'invalid_display_order'.
--
--   * Results visibility exactly show_always | hide_until_closed (Req 5.3):
--     the `poll_results_visibility` enum type structurally guarantees the value
--     is one of the two members, so the only additional guard needed is
--     rejecting NULL ⇒ RAISE 'invalid_results_visibility'.
--
--   * Option set 2–10, each 1–100 chars (Req 5.1, 5.2, 22.3):
--       - `p_options` must be NON-NULL with BETWEEN 2 AND 10 entries, else
--         RAISE 'invalid_option_count'. (The DB's deferred count trigger is the
--         backstop; checking here yields the specific field signal and a clear
--         up-front rejection.)
--       - EACH option, after btrim, must be 1–100 code points; a NULL element,
--         an empty/whitespace-only element, or an over-length element ⇒ RAISE
--         'invalid_option_text' (mirrors `poll_options_text_length_chk`). The
--         trimmed value is what gets stored.
--
--   * Single-choice is the ONLY poll type (Req 5.1, 5.2): the schema has NO
--     poll-type column — single-choice selection is IMPLICIT in the data model
--     (a poll_response references exactly one poll_option; see Task 19.3). This
--     RPC therefore takes no type parameter and encodes single-choice by
--     construction: it simply creates the poll and its options with no
--     multi-select affordance. Documented here so the implicit contract is
--     explicit.
--
--   * Reject-whole-on-failure / no partial poll (Req 5.3): every validation
--     RAISE occurs with SQLSTATE 'P0001'. In plpgsql the function executes
--     within a single (sub)transaction, so a RAISE rolls back any inserts made
--     earlier in the call — no orphan poll and no orphan options can persist.
--
-- Error signals (for the client / Edge layer to map — Req 5.3):
--   * 'invalid_question_text'       — NULL/empty/whitespace-only/over-200 text.
--   * 'invalid_display_order'       — NULL or display_order <= 0.
--   * 'invalid_results_visibility'  — NULL results_visibility.
--   * 'invalid_option_count'        — options array NULL or not 2–10 entries.
--   * 'invalid_option_text'         — some option NULL/empty/whitespace-only or
--                                     over-100 chars after trim.
--   All are raised with SQLSTATE 'P0001' (raise_exception) and the MESSAGE set
--   to the signal string above so callers can switch on the message and map it
--   to the failing field (→ HTTP 400).
--
-- Security / authorisation model (Req 10.1, 21.6):
--   * SECURITY DEFINER with `SET search_path = public, pg_temp` so the function
--     can insert into `polls` / `poll_options` (which have RLS with NO direct
--     client INSERT policy — Task 20) on behalf of the admin caller, and cannot
--     be hijacked via a caller-controlled search_path.
--   * ADMIN-ONLY: EXECUTE is granted to `authenticated` ONLY — NOT to `anon`.
--     Supabase verifies the JWT before assigning the `authenticated` role, and
--     the GRANT-to-authenticated boundary is the authorisation gate: an
--     anonymous participant simply has no privilege to call this function.
--     V1 POSTURE: any authenticated user is treated as an admin (mirroring the
--     questions/events V1 posture); a dedicated admin role/claim can tighten
--     this later without changing callers.
--
-- Design ref: Architecture → privileged mutation Edge Functions (server-side,
--             JWT-verified, SECURITY DEFINER mediated writes); Request/data
--             flows → Poll lifecycle (author a draft poll with its options).
--
-- Requirements: 5.1, 5.2, 5.3, 22.2, 22.3, 10.1, 21.6.
--
-- Idempotency (of the migration itself): CREATE OR REPLACE FUNCTION + guarded
--   grants make it safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- create_poll(
--     p_event_id           uuid,
--     p_question_text      text,
--     p_display_order      integer,
--     p_results_visibility poll_results_visibility,
--     p_options            text[]
-- ) RETURNS polls
--
-- Creates a 'draft' poll for the given event together with its 2–10 answer
-- options in a single atomic transaction and returns the full created `polls`
-- row (id, status='draft', timestamps, etc.). Single-choice is the only poll
-- type and is implicit in the data model (see header).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_poll(
    p_event_id           uuid,
    p_question_text      text,
    p_display_order      integer,
    p_results_visibility poll_results_visibility,
    p_options            text[]
)
RETURNS polls
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_question   text;
    v_qlen       int;
    v_n_options  int;
    v_idx        int;
    v_opt_raw    text;
    v_opt        text;
    v_opt_len    int;
    v_poll       polls%ROWTYPE;
BEGIN
    -- ------------------------------------------------------------------------
    -- 1a. Validate the parent event id. A NULL event id cannot own a poll; the
    --     FK on polls.event_id would reject it, but we surface it up-front as an
    --     invalid_display_order-adjacent structural error is inappropriate, so
    --     treat an absent event as an option/field-independent bad request via
    --     the question-text signal is also wrong. Reject a NULL event id plainly
    --     as a P0001 with a dedicated signal.
    -- ------------------------------------------------------------------------
    IF p_event_id IS NULL THEN
        RAISE EXCEPTION 'invalid_event' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1b. Validate question text (Req 5.1, 22.2): trim, then require 1–200
    --     Unicode code points. NULL/empty/whitespace-only/over-length reject.
    --     The trimmed value is stored.
    -- ------------------------------------------------------------------------
    IF p_question_text IS NULL THEN
        RAISE EXCEPTION 'invalid_question_text' USING ERRCODE = 'P0001';
    END IF;

    v_question := btrim(p_question_text);
    v_qlen := char_length(v_question);
    IF v_qlen < 1 OR v_qlen > 200 THEN
        RAISE EXCEPTION 'invalid_question_text' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1c. Validate display_order (Req 5.1): NOT NULL and strictly positive.
    -- ------------------------------------------------------------------------
    IF p_display_order IS NULL OR p_display_order <= 0 THEN
        RAISE EXCEPTION 'invalid_display_order' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1d. Validate results_visibility (Req 5.3): the enum type structurally
    --     restricts the value to 'show_always' | 'hide_until_closed', so only
    --     NULL needs to be rejected here.
    -- ------------------------------------------------------------------------
    IF p_results_visibility IS NULL THEN
        RAISE EXCEPTION 'invalid_results_visibility' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1e. Validate the option COUNT (Req 5.1, 5.2): 2–10 entries. A NULL array
    --     has cardinality treated as 0 and is rejected. (The DEFERRABLE 2–10
    --     count trigger is the DB backstop; this up-front check produces the
    --     specific 'invalid_option_count' field signal.)
    -- ------------------------------------------------------------------------
    v_n_options := COALESCE(cardinality(p_options), 0);
    IF v_n_options < 2 OR v_n_options > 10 THEN
        RAISE EXCEPTION 'invalid_option_count' USING ERRCODE = 'P0001';
    END IF;

    -- ------------------------------------------------------------------------
    -- 1f. Validate EACH option's text (Req 5.1, 22.3): after btrim, require
    --     1–100 code points. A NULL / empty / whitespace-only / over-length
    --     element rejects the whole request with 'invalid_option_text'. We
    --     validate all options BEFORE inserting anything so no partial poll is
    --     even begun on a bad option set (belt-and-braces atop atomicity).
    -- ------------------------------------------------------------------------
    FOR v_idx IN 1 .. v_n_options LOOP
        v_opt_raw := p_options[v_idx];
        IF v_opt_raw IS NULL THEN
            RAISE EXCEPTION 'invalid_option_text' USING ERRCODE = 'P0001';
        END IF;
        v_opt := btrim(v_opt_raw);
        v_opt_len := char_length(v_opt);
        IF v_opt_len < 1 OR v_opt_len > 100 THEN
            RAISE EXCEPTION 'invalid_option_text' USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    -- ------------------------------------------------------------------------
    -- 2. Insert the poll. status uses its column DEFAULT 'draft' (Req 5.1,
    --    10.1): a newly authored poll is not visible to the audience until it
    --    is later opened (Task 21.2). created_at/updated_at/id use defaults.
    -- ------------------------------------------------------------------------
    INSERT INTO polls (event_id, question_text, display_order, results_visibility)
    VALUES (p_event_id, v_question, p_display_order, p_results_visibility)
    RETURNING * INTO v_poll;

    -- ------------------------------------------------------------------------
    -- 3. Insert the options with display_order = array index + 1 (1-based, in
    --    the order supplied) and response_count 0. Single-choice is implicit —
    --    no poll-type column exists (see header). Because the 2–10 count
    --    trigger is DEFERRABLE INITIALLY DEFERRED, inserting these rows one at
    --    a time is fine: the set is validated at the function's implicit
    --    commit.
    -- ------------------------------------------------------------------------
    FOR v_idx IN 1 .. v_n_options LOOP
        v_opt := btrim(p_options[v_idx]);
        INSERT INTO poll_options (poll_id, text, display_order, response_count)
        VALUES (v_poll.id, v_opt, v_idx, 0);
    END LOOP;

    -- ------------------------------------------------------------------------
    -- 4. Return the created poll row.
    -- ------------------------------------------------------------------------
    RETURN v_poll;
END;
$$;

COMMENT ON FUNCTION create_poll(uuid, text, integer, poll_results_visibility, text[]) IS
    'Poll-create RPC (Task 21.1; Req 5.1-5.3, 22.2-22.3, 10.1, 21.6). '
    'SECURITY DEFINER. Validates question_text 1-200 chars, display_order > 0, '
    'non-null results_visibility, and 2-10 options each 1-100 chars (all after '
    'trim); on any failure RAISEs P0001 with a field signal and creates no poll '
    '(atomic rollback). Creates the poll in status draft with its options '
    '(display_order = index+1, response_count 0) in one transaction and returns '
    'the polls row. Single-choice is the only poll type (implicit; no type '
    'column). Error signals (SQLSTATE P0001, MESSAGE): invalid_event, '
    'invalid_question_text, invalid_display_order, invalid_results_visibility, '
    'invalid_option_count, invalid_option_text. V1: any authenticated user is '
    'an admin.';

-- ----------------------------------------------------------------------------
-- Grants. ADMIN-ONLY: EXECUTE is granted to `authenticated` ONLY (NOT anon).
-- Supabase verifies the caller's JWT before assigning the `authenticated` role,
-- so this GRANT is the authorisation gate. For V1, any authenticated user is
-- treated as an admin (mirroring the questions/events V1 posture); this can be
-- tightened to a dedicated admin role/claim later without changing callers.
-- The function is SECURITY DEFINER and mediates the inserts into polls /
-- poll_options (which have no direct client INSERT policy), so this grant does
-- not expose any direct table access.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION create_poll(uuid, text, integer, poll_results_visibility, text[]) TO authenticated;
