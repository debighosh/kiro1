-- ============================================================================
-- Migration: 20260101000020_polls_rls.sql
-- Purpose:   Enable Row Level Security (RLS) on the `polls` and `poll_options`
--            tables and add the client-facing SELECT policies. Establishes
--            default-deny for both tables and constrains anonymous (audience /
--            presenter-via-anon) reads to polls that belong to a live event and
--            are audience-visible (open/closed), plus the options of such polls.
--
-- Ordering: this migration MUST sort AFTER the polls / poll_options table
--           migration (20260101000017_polls.sql) so both tables and their
--           `status` / `event_id` / `poll_id` columns exist, and AFTER the
--           `event_is_live(uuid)` helper migration
--           (20260101000006_event_is_live.sql) whose SECURITY DEFINER predicate
--           the anonymous policies call. The …000020 timestamp places it after
--           the polls table (…000017) and poll_responses (…000018) migrations.
--
-- Scope (Task 20.1 only):
--   * Enable RLS on `polls` and `poll_options`
--     (ALTER TABLE … ENABLE ROW LEVEL SECURITY).
--   * Add an anonymous (`anon`) SELECT policy on `polls` restricted to a live
--     event AND an audience-visible status ('open','closed').
--   * Add an anonymous (`anon`) SELECT policy on `poll_options` gated by the
--     parent poll's visibility via an EXISTS subquery against `polls`.
--   * Add an authenticated (`authenticated`) SELECT policy for ALL polls and
--     ALL poll_options (admins see draft polls / all options for authoring).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * `poll_responses` RLS enablement + policies                   (Task 20.2)
--   * RLS behaviour tests                                          (Task 20.3)
--   * The service-role poll create/open/close + option-write RPC /
--     Edge Function                                                (Task 21)
--
-- Security model (Design → RLS Design, General policy strategy):
--   Three principals interact with `polls` / `poll_options`:
--     1. anonymous     (`anon` role, audience via the anon key)
--     2. authenticated (`authenticated` role, admins/presenters)
--     3. service role  (Edge Functions ONLY — BYPASSES RLS entirely)
--
--   Default deny: enabling RLS with no permissive default means every access
--   path is denied unless an explicit policy grants it. This migration adds
--   ONLY read (SELECT) policies.
--
-- *** NO client INSERT / UPDATE / DELETE POLICY IS DEFINED ON EITHER TABLE. ***
--   This is intentional, mirroring the `questions` / `events` RLS pattern
--   (…000011, …000007):
--     * Poll authoring / lifecycle (INSERT poll + options, open, close) and any
--       option writes are routed through the service-role RPC / Edge Function
--       (Task 21), which validates the request after verifying an authenticated
--       admin JWT and writes with the service role, bypassing RLS
--       (Req 21.4, 21.5, 21.6). There is therefore NO direct client
--       INSERT/UPDATE/DELETE policy on `polls` or `poll_options`.
--   Because RLS is enabled and no write policy exists, direct client
--   (anon/authenticated) writes are default-denied, while the service role
--   continues to operate unaffected.
--
-- DECISION — anonymous-visible poll statuses:
--   A poll's lifecycle is draft → open → closed (…000017). All three belong to
--   a live event, but a `draft` poll is being authored and MUST NOT leak to the
--   audience. The design says the audience reads open + closed polls (an open
--   poll accepts responses; a closed poll shows final results). The anon
--   predicate therefore admits status IN ('open','closed') and EXCLUDES
--   'draft', so draft polls can never be returned to the `anon` role. The
--   security-critical guarantee is that 'draft' is excluded from the predicate;
--   admins/presenters read drafts through the authenticated policy instead.
--
-- DECISION — gating poll_options via the parent poll:
--   `poll_options` has no `event_id` column, so it cannot call
--   `event_is_live(...)` directly. Its anon visibility must mirror the parent
--   poll's: an option is visible to the audience ONLY when its parent poll is
--   itself audience-visible. This is expressed as an EXISTS subquery against
--   `polls` that repeats the parent poll's predicate (live event AND status IN
--   ('open','closed')). Because the correlated lookup runs inside the option
--   policy, options for draft polls (or polls on non-live events) are never
--   returned to anon.
--
-- Requirements traceability:
--   * Req 5.4  — poll results visibility; audience reads open/closed polls.
--   * Req 5.11 — draft polls are not exposed to the audience.
--   * Req 21.3 — RLS enabled on client-exposed tables (default deny).
--   * Req 21.4 — unauthorised row access is rejected.
--   * Req 21.5 — anonymous access confined to active/live event data (via the
--                `event_is_live(event_id)` helper).
--   * Req 21.6 — writes are server-mediated (service-role RPC/Edge Function),
--                not client write policies.
-- Design ref: RLS Design → `polls` / `poll_options` per-table policies;
--             General policy strategy (`event_is_live` helper).
--
-- Idempotency: RLS enablement is naturally idempotent; each policy is dropped
--   with DROP POLICY IF EXISTS before CREATE POLICY so the migration is safe to
--   re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `polls` and `poll_options` (default deny — Req 21.3, 21.4).
-- With RLS enabled and no permissive default, no client role can read or write
-- these rows until an explicit policy grants access. The service role used by
-- Edge Functions bypasses these client policies and is unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE polls        ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_options ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Anonymous SELECT on `polls` — audience-visible polls on a live event only
-- (Req 5.4, 5.11, 21.4, 21.5).
-- The audience (`anon` role via the anon key) may read a poll row ONLY when
-- BOTH conditions hold:
--   1. the parent event is currently live — checked via the SECURITY DEFINER
--      `event_is_live(event_id)` helper (…000006), which avoids RLS recursion
--      on `events` and leaks nothing but a boolean; and
--   2. the poll's status is audience-visible: 'open' or 'closed'.
-- 'draft' is excluded from the predicate, so draft polls can NEVER be returned
-- to anonymous clients — this is the core authoring-privacy guarantee
-- (Req 5.11).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS polls_anon_select_visible ON polls;
CREATE POLICY polls_anon_select_visible
    ON polls
    FOR SELECT
    TO anon
    USING (
        event_is_live(event_id)
        AND status IN ('open', 'closed')
    );

-- ----------------------------------------------------------------------------
-- Anonymous SELECT on `poll_options` — options of an audience-visible poll only
-- (Req 5.4, 5.11, 21.4, 21.5).
-- `poll_options` has no `event_id`, so its visibility is derived from the
-- parent poll via an EXISTS subquery that repeats the parent poll's anon
-- predicate: the option is visible ONLY when its parent poll is on a live event
-- AND has status 'open'/'closed'. Options of draft polls (or polls on non-live
-- events) are therefore never returned to the `anon` role.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS poll_options_anon_select_visible ON poll_options;
CREATE POLICY poll_options_anon_select_visible
    ON poll_options
    FOR SELECT
    TO anon
    USING (
        EXISTS (
            SELECT 1
            FROM polls p
            WHERE p.id = poll_options.poll_id
              AND event_is_live(p.event_id)
              AND p.status IN ('open', 'closed')
        )
    );

-- ----------------------------------------------------------------------------
-- Authenticated SELECT on `polls` — all polls (Req 21.4).
-- Admins/presenters (`authenticated` role) may read EVERY poll regardless of
-- status — including 'draft' — so they can author and manage polls. For V1 all
-- admins are equivalent (mirroring the questions authenticated SELECT policy),
-- so the predicate is USING (true) rather than being scoped to the admin's own
-- events. Read-only: this policy grants SELECT only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS polls_authenticated_select_all ON polls;
CREATE POLICY polls_authenticated_select_all
    ON polls
    FOR SELECT
    TO authenticated
    USING (true);

-- ----------------------------------------------------------------------------
-- Authenticated SELECT on `poll_options` — all options (Req 21.4).
-- Admins/presenters may read EVERY option (including those of draft polls) to
-- author and manage polls, mirroring the `polls` authenticated policy above.
-- Read-only: this policy grants SELECT only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS poll_options_authenticated_select_all ON poll_options;
CREATE POLICY poll_options_authenticated_select_all
    ON poll_options
    FOR SELECT
    TO authenticated
    USING (true);

-- ----------------------------------------------------------------------------
-- NOTE (intentional omission): there is deliberately NO anon or authenticated
-- INSERT / UPDATE / DELETE policy on `polls` or `poll_options`. With RLS
-- enabled, the absence of a write policy means all client writes are
-- default-denied.
--   * Poll authoring / lifecycle (create poll + options, open, close) and any
--     option writes are performed by the service-role RPC / Edge Function
--     (Task 21), which validates the request after verifying an admin JWT and
--     writes with the service role, bypassing RLS (Req 21.4, 21.5, 21.6).
-- Keeping writes server-mediated ensures the single-open-poll invariant, the
-- 2–10 option rule and lifecycle transitions cannot be bypassed by a direct
-- client mutation.
-- ----------------------------------------------------------------------------
