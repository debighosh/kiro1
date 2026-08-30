-- ============================================================================
-- Migration: 20260101000007_events_rls.sql
-- Purpose:   Enable Row Level Security (RLS) on the `events` table and add the
--            client-facing SELECT policies. This is the first RLS migration of
--            the security model and establishes default-deny for `events`.
--
-- Ordering: this migration MUST sort AFTER the events table migration
--           (20260101000002_events.sql), so the `events` table and its
--           `status` column already exist. The …000007 timestamp places it
--           after all existing migrations (…000001 … …000006).
--
-- Scope (Task 5.1 only):
--   * Enable RLS on `events` (ALTER TABLE … ENABLE ROW LEVEL SECURITY).
--   * Add an anonymous (`anon`) SELECT policy restricted to `status = 'live'`.
--   * Add an authenticated (`authenticated`) SELECT policy for all events.
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * `admin_profiles` / `audit_log` RLS enablement + policies      (Task 5.2)
--   * RLS behaviour tests                                       (Tasks 5.3/5.4)
--
-- Security model (Design → RLS Design, General policy strategy):
--   Three principals interact with `events`:
--     1. anonymous     (`anon` role, audience via the anon key)
--     2. authenticated (`authenticated` role, admins)
--     3. service role  (Edge Functions ONLY — BYPASSES RLS entirely)
--
--   Default deny: enabling RLS with no permissive default means every access
--   path is denied unless an explicit policy grants it. This migration adds
--   ONLY read (SELECT) policies.
--
--   *** NO client INSERT / UPDATE / DELETE POLICY IS DEFINED ON `events`. ***
--   This is intentional (Req 21.6). All event mutations — creation, edits and
--   status transitions (draft → live → ended → archived) — flow through Edge
--   Functions that connect with the Supabase SERVICE ROLE, which bypasses RLS
--   after verifying an authenticated admin JWT. Because RLS is enabled and no
--   write policy exists, direct client (anon/authenticated) writes are
--   default-denied, while the service role continues to operate unaffected.
--   Archived-event immutability is enforced in the mutation Edge Function, not
--   here (Req 1.10, 1.11).
--
-- Requirements traceability:
--   * Req 1.6  — event visibility rules per principal.
--   * Req 1.9  — draft/ended/archived events are not shown to the audience.
--   * Req 10.1 — privileged admin actions go through authenticated server path.
--   * Req 21.3 — RLS enabled on client-exposed tables.
--   * Req 21.4 — unauthorised row access is rejected.
--   * Req 21.5 — anonymous access confined to active/live event data.
--   * Req 21.6 — mutations performed via Edge Functions (service role), not
--                client-side RLS write policies.
-- Design ref: RLS Design → `events` per-table policies; General policy strategy.
--
-- Idempotency: RLS enablement is naturally idempotent; each policy is dropped
--   with DROP POLICY IF EXISTS before CREATE POLICY so the migration is safe to
--   re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `events` (default deny — Req 21.3).
-- With RLS enabled and no permissive default, no client role can read or write
-- `events` rows until an explicit policy grants access. The service role used
-- by Edge Functions bypasses RLS and is unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Anonymous SELECT — live events only (Req 1.6, 1.9, 21.5).
-- The audience (`anon` role via the anon key) may read an event row ONLY while
-- it is live. Draft, ended and archived events are invisible to anonymous
-- clients because the USING predicate excludes every non-live status.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS events_anon_select_live ON events;
CREATE POLICY events_anon_select_live
    ON events
    FOR SELECT
    TO anon
    USING (status = 'live');

-- ----------------------------------------------------------------------------
-- Authenticated SELECT — all events (Req 1.6, 25.9).
-- Admins (`authenticated` role) may read every event regardless of status,
-- including drafts, so they can manage events before going live and review
-- ended/archived events. Read-only: this policy grants SELECT only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS events_authenticated_select_all ON events;
CREATE POLICY events_authenticated_select_all
    ON events
    FOR SELECT
    TO authenticated
    USING (true);

-- ----------------------------------------------------------------------------
-- NOTE (intentional omission): there is deliberately NO anon or authenticated
-- INSERT / UPDATE / DELETE policy on `events`. With RLS enabled, the absence of
-- a write policy means all client writes are default-denied. Event mutations
-- are performed exclusively by Edge Functions using the service role, which
-- bypasses RLS after verifying an authenticated admin JWT (Req 21.6, 10.1).
-- ----------------------------------------------------------------------------
