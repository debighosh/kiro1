-- ============================================================================
-- Migration: 20260101000034_ai_jobs_clusters_rls.sql
-- Purpose:   Enable Row Level Security (RLS) on the `ai_jobs` and
--            `question_clusters` tables and add the client-facing SELECT
--            policies. Establishes default-deny for both Milestone 4 (AI
--            Features) tables and grants authenticated admins read access,
--            while adding NO anonymous access and NO client write policies —
--            all writes are performed by the service role.
--
-- Ordering: this migration MUST sort AFTER 20260101000031_ai_jobs.sql (task
--           26.2), which creates the `ai_jobs` table, and AFTER
--           20260101000032_question_clusters.sql (task 26.3), which creates
--           the `question_clusters` table. The …000034 timestamp places it
--           after both AI data-model migrations (and after the intervening
--           …000033 migration), matching the questions RLS pattern (…000011).
--
-- Scope (Task 27.2 only):
--   * Enable RLS on `ai_jobs` and `question_clusters`
--     (ALTER TABLE … ENABLE ROW LEVEL SECURITY — default deny).
--   * ai_jobs:           add an authenticated (`authenticated`) SELECT policy
--     for all rows (USING (true) — V1 admins are equivalent).
--   * question_clusters: add an authenticated (`authenticated`) SELECT policy
--     for all rows (USING (true) — V1 admins are equivalent).
--   * NO anonymous (`anon`) policy on either table.
--   * NO client INSERT / UPDATE / DELETE policy on either table.
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * The service-role AI Gateway that WRITES `ai_jobs` audit rows (Task 29.1).
--   * Cluster create/dissolve, performed by service-role only (Task 31.1).
--   * RLS behaviour tests for the AI tables.
--
-- Security model (Design → RLS Design, General policy strategy):
--   Two principals interact with these tables:
--     1. authenticated (`authenticated` role, admins) — read access only.
--     2. service role  (AI Gateway / RPCs ONLY — BYPASSES RLS entirely) —
--                       the sole writer of both tables.
--
--   Default deny: enabling RLS with no permissive default means every access
--   path is denied unless an explicit policy grants it. This migration adds
--   ONLY read (SELECT) policies, and ONLY for the authenticated role.
--
-- DECISION — authenticated read for own scope; V1 posture is USING (true):
--   The design describes these tables as "authenticated read for own scope,
--   no anonymous access, writes service-role only". For V1 all admins are
--   equivalent — mirroring the `events` and `questions` authenticated SELECT
--   policies (…000007, …000011), which use USING (true) rather than scoping to
--   the admin's own events. The authenticated SELECT policies below therefore
--   use USING (true), scoped to the `authenticated` role only. Should a
--   stricter per-admin scoping later be preferred, only the authenticated
--   USING predicate changes; the exclusion of anonymous access and the absence
--   of client write policies are the invariants.
--
-- DECISION — NO anonymous access:
--   Neither `ai_jobs` (operational audit metadata, Req 20.6) nor
--   `question_clusters` (AI/presenter-curated grouping, Req 16.10) is
--   audience-facing, so NO `anon` SELECT policy is added. With RLS enabled and
--   no anon policy, the audience (`anon` role via the anon key) is
--   default-denied all access to both tables (Req 21.3, 21.4).
--
-- *** NO client INSERT / UPDATE / DELETE POLICY IS DEFINED ON EITHER TABLE. ***
--   This is intentional, mirroring the `questions` / Word Cloud RLS patterns
--   (…000011, …000022). Every write to these tables is server-mediated:
--     * `ai_jobs` rows are written ONLY by the service-role AI Gateway, which
--       records each AI operation's sanitised audit metadata (Task 29.1,
--       Req 20.6). There is NO client INSERT/UPDATE/DELETE path.
--     * `question_clusters` create/dissolve is service-role only (Task 31.1) —
--       clusters are created and dissolved by the AI clustering / presenter
--       actions running under the service role, never by a direct client
--       mutation (Req 16.10, 21.6).
--   Because RLS is enabled and no write policy exists, direct client
--   (anon/authenticated) writes are default-denied, while the service role
--   continues to operate unaffected (it bypasses RLS entirely).
--
-- Requirements traceability:
--   * Req 20.6 — the `ai_jobs` audit log is protected: admins read it, no
--                anonymous access, writes are service-role only.
--   * Req 16.10 — clusters are managed server-side (create/dissolve service
--                role only); admins read, audience has no access.
--   * Req 21.3 — RLS enabled on client-exposed tables (default deny).
--   * Req 21.4 — unauthorised row access is rejected (no anon policy; no write
--                policies).
--   * Req 21.6 — admin/management writes are server-mediated (service-role AI
--                Gateway / RPCs); no client write policy exists.
-- Design ref: RLS Design → `ai_jobs` / `question_clusters` per-table policies
--             (authenticated read for own scope, no anonymous access, writes
--             service-role only); General policy strategy (default deny;
--             server-mediated writes).
--
-- Idempotency: RLS enablement is naturally idempotent (ALTER … ENABLE is a
-- no-op if already enabled); each policy is dropped with DROP POLICY IF EXISTS
-- before CREATE POLICY so the migration is safe to re-run.
-- ============================================================================

-- ============================================================================
-- ai_jobs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `ai_jobs` (default deny — Req 21.3, 21.4).
-- With RLS enabled and no permissive default, no client role can read or write
-- `ai_jobs` rows until an explicit policy grants access. The service-role AI
-- Gateway (Task 29.1) that writes audit rows bypasses these client policies
-- and is unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE ai_jobs ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Authenticated SELECT — all AI-job audit rows (Req 20.6, 21.6).
-- Admins (`authenticated` role) may read EVERY `ai_jobs` row to inspect the AI
-- operation audit trail. For V1 all admins are equivalent (mirroring the
-- events/questions authenticated SELECT policies), so the predicate is
-- USING (true) rather than being scoped to the admin's own events. Read-only:
-- this policy grants SELECT only.
-- NO `anon` policy exists on `ai_jobs`, so the audience is default-denied.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS ai_jobs_authenticated_select_all ON ai_jobs;
CREATE POLICY ai_jobs_authenticated_select_all
    ON ai_jobs
    FOR SELECT
    TO authenticated
    USING (true);

-- ============================================================================
-- question_clusters
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `question_clusters` (default deny — Req 21.3, 21.4).
-- With RLS enabled and no permissive default, no client role can read or write
-- `question_clusters` rows until an explicit policy grants access. The
-- service-role cluster create/dissolve path (Task 31.1) bypasses these client
-- policies and is unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE question_clusters ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Authenticated SELECT — all clusters (Req 16.10, 21.6).
-- Admins (`authenticated` role) may read EVERY cluster so they can review and
-- present AI-generated / curated question groupings. For V1 all admins are
-- equivalent (mirroring the events/questions authenticated SELECT policies),
-- so the predicate is USING (true) rather than being scoped to the admin's own
-- events. Read-only: this policy grants SELECT only.
-- NO `anon` policy exists on `question_clusters`, so the audience is
-- default-denied.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS question_clusters_authenticated_select_all ON question_clusters;
CREATE POLICY question_clusters_authenticated_select_all
    ON question_clusters
    FOR SELECT
    TO authenticated
    USING (true);

-- ----------------------------------------------------------------------------
-- NOTE (intentional omission): there is deliberately NO anon or authenticated
-- INSERT / UPDATE / DELETE policy on `ai_jobs` or `question_clusters`, and NO
-- `anon` SELECT policy on either table. With RLS enabled, the absence of a
-- write policy means all client writes are default-denied, and the absence of
-- an anon policy means the audience is denied all access.
--   * `ai_jobs` rows are written ONLY by the service-role AI Gateway (Task
--     29.1), which records sanitised AI-operation audit metadata (Req 20.6).
--   * `question_clusters` create/dissolve is service-role only (Task 31.1);
--     clusters are never created or dissolved by a direct client mutation
--     (Req 16.10, 21.6).
-- The service role bypasses RLS. Keeping every write server-mediated ensures
-- the AI audit trail and cluster lifecycle cannot be tampered with by a direct
-- client mutation.
-- ----------------------------------------------------------------------------
