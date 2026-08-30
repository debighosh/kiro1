-- ============================================================================
-- Migration: 20260101000008_admin_audit_rls.sql
-- Purpose:   Enable Row Level Security (RLS) on the `admin_profiles` and
--            `audit_log` tables and define their access policies.
--
-- Security model (design ref: RLS Design → General policy strategy):
--   * RLS is ENABLED on both tables with a DEFAULT-DENY posture. Enabling RLS
--     with no permissive default means every access is denied unless an
--     explicit policy grants it (Req 21.3).
--   * NO ANONYMOUS ACCESS to either table. There are deliberately no policies
--     targeting the `anon` role, so the audience (anon key) can neither read
--     nor write these tables (Req 21.4).
--   * ALL WRITES occur via the SERVICE ROLE inside Edge Functions. The service
--     role bypasses RLS, so no client INSERT/UPDATE/DELETE policy is defined:
--       - admin_profiles rows are written on first admin sign-in (task 6.1).
--       - audit_log rows are written by privileged Edge Functions when
--         moderation, event-status, AI-endpoint and credential-rotation
--         changes occur (Req 21.6, 21.19).
--   * Only AUTHENTICATED SELECT is granted to clients, per the design note that
--     `admin_profiles` and `audit_log` allow "authenticated read for own scope;
--     no anonymous access; writes via service role" (RLS Design → Per-table
--     policies).
--
-- Ordering:  Sorts AFTER 20260101000007_events_rls.sql (task 5.1). The tables
--            targeted here (admin_profiles, audit_log) were created by
--            20260101000003 and 20260101000004 respectively, so they already
--            exist when this migration runs.
--
-- Scope (Task 5.2, Milestone 1 only):
--   * Enables RLS + defines SELECT policies ONLY for admin_profiles and
--     audit_log. Events RLS (task 5.1) and all other tables are out of scope.
--
-- Requirements traceability:
--   * Req 10.1  — authenticated Administrator access.
--   * Req 21.3  — RLS enabled on client-exposed tables (default deny).
--   * Req 21.4  — unauthorised / anonymous access is rejected.
--   * Req 21.6  — privileged writes performed via service role in Edge Functions.
-- Design ref:   RLS Design → admin_profiles, audit_log.
--
-- Idempotency: RLS enablement is naturally idempotent (ALTER ... ENABLE is a
-- no-op if already enabled). Policies use DROP POLICY IF EXISTS + CREATE POLICY
-- so the migration is safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- admin_profiles
-- ----------------------------------------------------------------------------
-- Enable RLS (default deny): with RLS on and no permissive default, every
-- access is denied until an explicit policy allows it (Req 21.3).
ALTER TABLE admin_profiles ENABLE ROW LEVEL SECURITY;

-- Authenticated SELECT, owner-scoped. An authenticated admin may read ONLY
-- their own profile row (id = auth.uid()). For V1 all admins are equivalent,
-- so owner-scoped read is the minimal, safe default that still satisfies the
-- design's "authenticated read for own scope" (Req 10.1, 21.4). No anonymous
-- policy exists, so the anon role has no access.
DROP POLICY IF EXISTS admin_profiles_select_own ON admin_profiles;
CREATE POLICY admin_profiles_select_own
    ON admin_profiles
    FOR SELECT
    TO authenticated
    USING (id = auth.uid());

-- NOTE: No INSERT/UPDATE/DELETE policy is defined for admin_profiles. Profile
-- rows are created on first admin sign-in by an Edge Function using the service
-- role (task 6.1), which bypasses RLS (Req 21.6).

-- ----------------------------------------------------------------------------
-- audit_log
-- ----------------------------------------------------------------------------
-- Enable RLS (default deny) (Req 21.3).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Authenticated SELECT of all audit rows. Audit entries are event-scoped or
-- global (event_id may be NULL, e.g. credential rotation). Because all admins
-- are equivalent in V1, any authenticated admin may read audit rows, per the
-- design's "authenticated read for own scope" for equivalent admins
-- (Req 10.1, 21.4). No anonymous policy exists, so the anon role has no access.
DROP POLICY IF EXISTS audit_log_select_authenticated ON audit_log;
CREATE POLICY audit_log_select_authenticated
    ON audit_log
    FOR SELECT
    TO authenticated
    USING (true);

-- NOTE: No INSERT/UPDATE/DELETE policy is defined for audit_log. Audit entries
-- are written exclusively by privileged Edge Functions using the service role,
-- which bypasses RLS (Req 21.6, 21.19).
