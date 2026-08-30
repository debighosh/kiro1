-- ============================================================================
-- Migration: 20260101000011_questions_rls.sql
-- Purpose:   Enable Row Level Security (RLS) on the `questions` table and add
--            the client-facing SELECT policies. Establishes default-deny for
--            `questions` and constrains anonymous (audience) reads to
--            moderation-approved rows on a live event.
--
-- Ordering: this migration MUST sort AFTER the `questions` table migration
--           (20260101000009_questions.sql) so the table and its `status` /
--           `event_id` columns exist, and AFTER the `event_is_live(uuid)`
--           helper migration (20260101000006_event_is_live.sql) whose
--           SECURITY DEFINER predicate the anonymous policy calls. The
--           …000011 timestamp places it after the questions table
--           (…000009) and question_votes (…000010) migrations and before the
--           rate-limiting migration (…000013).
--
-- Scope (Task 12.1 only):
--   * Enable RLS on `questions` (ALTER TABLE … ENABLE ROW LEVEL SECURITY).
--   * Add an anonymous (`anon`) SELECT policy restricted to a live event AND
--     an audience-visible status.
--   * Add an authenticated (`authenticated`) SELECT policy for all questions
--     (admins see pending/hidden for moderation).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * `question_votes` RLS enablement + policies                   (Task 12.2)
--   * RLS behaviour tests                                          (Task 12.3)
--   * The rate-limited submit RPC (SECURITY DEFINER)               (Task 13.2)
--   * The service-role moderation Edge Function                    (Task 16.1)
--
-- Security model (Design → RLS Design, General policy strategy):
--   Three principals interact with `questions`:
--     1. anonymous     (`anon` role, audience via the anon key)
--     2. authenticated (`authenticated` role, admins/moderators)
--     3. service role  (Edge Functions ONLY — BYPASSES RLS entirely)
--
--   Default deny: enabling RLS with no permissive default means every access
--   path is denied unless an explicit policy grants it. This migration adds
--   ONLY read (SELECT) policies.
--
-- *** NO client INSERT / UPDATE / DELETE POLICY IS DEFINED ON `questions`. ***
--   This is intentional, mirroring the `events` RLS pattern (…000007):
--     * SUBMISSION (INSERT) is routed through the rate-limited submit RPC
--       (Task 13.2), a SECURITY DEFINER function that validates length /
--       sanitisation / rate limits and inserts with the definer's rights,
--       setting status per the event's `moderation_mode` (pending for pre-,
--       approved for post-moderation) (Req 3.1–3.3, 3.6, 3.7, 21.9–21.15).
--       There is therefore NO direct anonymous INSERT policy.
--     * MODERATION (UPDATE: approve/feature/answer/hide) is performed by the
--       authenticated moderation Edge Function using the SERVICE ROLE, which
--       bypasses RLS after verifying an authenticated admin JWT (Task 16.1,
--       Req 3.11, 3.12, 21.6, 10.1). No direct client UPDATE/DELETE policy is
--       added — keeping every write server-mediated. This is authoritative;
--       an authenticated client UPDATE policy is deliberately omitted so the
--       Edge Function remains the single moderation path.
--   Because RLS is enabled and no write policy exists, direct client
--   (anon/authenticated) writes are default-denied, while the service role and
--   the SECURITY DEFINER submit RPC continue to operate unaffected.
--
-- DECISION — anonymous-visible statuses:
--   Design Property 10 requires that `pending` and `hidden` questions are
--   NEVER visible to the audience/presenter, that `approved`/`featured` are
--   always visible, and that `answered` is shown "where shown". The design's
--   per-table note lists anon SELECT as status IN ('approved','featured').
--   For Milestone 2 this migration ALSO admits 'answered' so that a question
--   that has been answered remains visible to the audience as historical
--   context rather than disappearing from the list; presenter top/featured
--   views filter further in the read layer. The security-critical guarantee
--   is unchanged: 'pending' and 'hidden' are excluded from the predicate and
--   can never be returned to the `anon` role (Req 3.9, 3.10, 7.9). If a
--   stricter ('approved','featured') set is later preferred, only the anon
--   USING list changes; the exclusion of pending/hidden is the invariant.
--
-- Requirements traceability:
--   * Req 3.9  — pending questions are never visible to the audience.
--   * Req 3.10 — hidden questions are never visible to the audience.
--   * Req 7.9  — pending/hidden questions never appear in the presenter view.
--   * Req 21.3 — RLS enabled on client-exposed tables (default deny).
--   * Req 21.4 — unauthorised row access is rejected.
--   * Req 21.5 — anonymous access confined to active/live event data (via the
--                `event_is_live(event_id)` helper).
--   * Req 3.11 — admins can read all questions (incl. pending/hidden) for
--                moderation.
--   * Req 3.12 — admins moderate (approve/feature/answer/hide); performed via
--                the service-role Edge Function, not a client write policy.
-- Design ref: RLS Design → `questions` per-table policies; General policy
--             strategy (`event_is_live` helper).
--
-- Idempotency: RLS enablement is naturally idempotent; each policy is dropped
--   with DROP POLICY IF EXISTS before CREATE POLICY so the migration is safe to
--   re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `questions` (default deny — Req 21.3, 21.4).
-- With RLS enabled and no permissive default, no client role can read or write
-- `questions` rows until an explicit policy grants access. The service role
-- used by Edge Functions, and the SECURITY DEFINER submit RPC, bypass/operate
-- outside these client policies and are unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Anonymous SELECT — audience-visible questions on a live event only
-- (Req 3.9, 3.10, 7.9, 21.4, 21.5).
-- The audience (`anon` role via the anon key) may read a question row ONLY when
-- BOTH conditions hold:
--   1. the parent event is currently live — checked via the SECURITY DEFINER
--      `event_is_live(event_id)` helper (…000006), which avoids RLS recursion
--      on `events` and leaks nothing but a boolean; and
--   2. the question's status is audience-visible: 'approved', 'featured' or
--      'answered'.
-- 'pending' and 'hidden' are excluded from the predicate, so they can NEVER be
-- returned to anonymous clients (audience or presenter reading via the anon
-- path) — this is the core moderation-privacy guarantee (Req 3.9, 3.10, 7.9).
-- See the header DECISION note for why 'answered' is included for M2.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS questions_anon_select_visible ON questions;
CREATE POLICY questions_anon_select_visible
    ON questions
    FOR SELECT
    TO anon
    USING (
        event_is_live(event_id)
        AND status IN ('approved', 'featured', 'answered')
    );

-- ----------------------------------------------------------------------------
-- Authenticated SELECT — all questions (Req 3.11).
-- Admins/moderators (`authenticated` role) may read EVERY question regardless
-- of status — including 'pending' and 'hidden' — so they can moderate the
-- queue. For V1 all admins are equivalent (mirroring the events authenticated
-- SELECT policy), so the predicate is USING (true) rather than being scoped to
-- the admin's own events. Read-only: this policy grants SELECT only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS questions_authenticated_select_all ON questions;
CREATE POLICY questions_authenticated_select_all
    ON questions
    FOR SELECT
    TO authenticated
    USING (true);

-- ----------------------------------------------------------------------------
-- NOTE (intentional omission): there is deliberately NO anon or authenticated
-- INSERT / UPDATE / DELETE policy on `questions`. With RLS enabled, the absence
-- of a write policy means all client writes are default-denied.
--   * Submission (INSERT) flows through the rate-limited SECURITY DEFINER
--     submit RPC (Task 13.2), which inserts with the definer's rights after
--     enforcing validation/rate limits (Req 3.1–3.3, 21.9–21.15).
--   * Moderation (UPDATE: approve/feature/answer/hide) is performed by the
--     authenticated moderation Edge Function using the service role, which
--     bypasses RLS after verifying an admin JWT (Task 16.1, Req 3.11, 3.12,
--     21.6, 10.1).
-- Keeping writes server-mediated ensures moderation and rate-limiting cannot be
-- bypassed by a direct client mutation.
-- ----------------------------------------------------------------------------
