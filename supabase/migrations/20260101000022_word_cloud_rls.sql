-- ============================================================================
-- Migration: 20260101000022_word_cloud_rls.sql
-- Purpose:   Enable Row Level Security (RLS) on the `word_cloud_prompts` and
--            `word_cloud_responses` tables and add the client-facing SELECT
--            policies. Establishes default-deny for both Word Cloud tables and
--            constrains anonymous (audience/presenter) reads to a live event,
--            hiding draft prompts and hidden (moderated) responses, while
--            granting authenticated admins full read access for moderation.
--
-- Ordering: this migration MUST sort AFTER 20260101000019_word_cloud.sql (task
--           19.4), which creates the `word_cloud_prompts` / `word_cloud_responses`
--           tables together with their `status`, `event_id` and `is_hidden`
--           columns, and AFTER the `event_is_live(uuid)` helper migration
--           (20260101000006_event_is_live.sql) whose SECURITY DEFINER predicate
--           the anonymous policies call. The …000022 timestamp places it after
--           the Word Cloud data-model migration and after the Polls migrations
--           (…000017/…000018), matching the questions RLS pattern (…000011).
--
-- Scope (Task 20.3 only):
--   * Enable RLS on `word_cloud_prompts` and `word_cloud_responses`
--     (ALTER TABLE … ENABLE ROW LEVEL SECURITY — default deny).
--   * word_cloud_prompts:  add an anonymous (`anon`) SELECT policy restricted
--     to a live event AND status IN ('open','closed') so DRAFT prompts are
--     hidden from anon; add an authenticated (`authenticated`) SELECT policy
--     for all prompts (admins see draft prompts too).
--   * word_cloud_responses: add an anonymous (`anon`) SELECT policy that
--     returns ONLY non-hidden rows on a live event; add an authenticated
--     (`authenticated`) SELECT policy for all responses (admins see hidden
--     entries for moderation).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * Prompt create/open/close, response upsert, and hide/unhide RPCs
--     (SECURITY DEFINER / service-role)                              (Task 22).
--   * RLS behaviour tests for the Word Cloud tables.
--
-- Security model (Design → RLS Design, General policy strategy):
--   Three principals interact with these tables:
--     1. anonymous     (`anon` role, audience/presenter via the anon key)
--     2. authenticated (`authenticated` role, admins/moderators)
--     3. service role  (Edge Functions / RPCs ONLY — BYPASSES RLS entirely)
--
--   Default deny: enabling RLS with no permissive default means every access
--   path is denied unless an explicit policy grants it. This migration adds
--   ONLY read (SELECT) policies.
--
-- *** NO client INSERT / UPDATE / DELETE POLICY IS DEFINED ON EITHER TABLE. ***
--   This is intentional, mirroring the `questions` / `question_votes` RLS
--   patterns (…000011, …000012). Every Word Cloud write is server-mediated:
--     * PROMPT lifecycle (create / open / close) and RESPONSE upsert flow
--       through SECURITY DEFINER / service-role RPCs (Task 22), which enforce
--       the single-open-prompt rule (Req 6.5), the one-response-per-participant
--       UNIQUE rule (Req 6.9), length/normalisation (Req 6.8, 6.10) and rate
--       limits — inserting/updating with the definer's rights.
--     * MODERATION (hide / unhide of a response) is likewise performed by a
--       service-role RPC (Task 22) after verifying an authenticated admin JWT,
--       toggling `is_hidden` (Req 6.12, 6.13). No direct client UPDATE/DELETE
--       policy is added — keeping the RPC the single mutation path.
--   Because RLS is enabled and no write policy exists, direct client
--   (anon/authenticated) writes are default-denied, while the service role and
--   the SECURITY DEFINER RPCs continue to operate unaffected.
--
-- PARTICIPANT PRIVACY (Req 2.5, 8.6, 21.18) — READ-LAYER responsibility:
--   `word_cloud_responses` carries `participant_identifier`, an opaque,
--   PII-free anonymous token (Req 2.5). RLS gates ROWS, not COLUMNS: the anon
--   SELECT policy below restricts WHICH rows are returned but cannot, by
--   itself, hide the `participant_identifier` column. Therefore the READ LAYER
--   / aggregation helper is responsible for column projection — the app read
--   path selects ONLY the non-sensitive columns (id, normalised_text,
--   is_hidden, event_id, prompt_id) and NEVER selects `participant_identifier`
--   for client consumption (Req 8.6). Any per-participant analytics is
--   service-role only (the service role bypasses RLS). RLS confines rows to a
--   live event and excludes hidden entries; the read layer confines columns.
--
-- DECISION — anonymous-visible prompt statuses:
--   The audience/presenter must be able to see a prompt while it is collecting
--   ('open') and after collection ends ('closed', to show final results), but
--   MUST NOT see a 'draft' prompt that has not been published (Req 6.3). The
--   anon SELECT predicate therefore admits status IN ('open','closed') and
--   excludes 'draft'. Admins (authenticated) see every status including draft.
--
-- DECISION — hidden responses never reach audience/presenter:
--   A moderated response (`is_hidden = true`) MUST NEVER be returned to the
--   audience or presenter (Req 6.13, 7.9). The anon SELECT predicate on
--   `word_cloud_responses` requires `is_hidden = false`, so hidden entries are
--   excluded at the row level and can never be aggregated into the anon word
--   cloud. Admins (authenticated) still see hidden entries for moderation.
--
-- Requirements traceability:
--   * Req 6.3  — a prompt is draft/open/closed; draft prompts are not published
--                to the audience (excluded from the anon prompt predicate).
--   * Req 6.13 — hidden word-cloud entries are excluded from results shown to
--                the audience/presenter (anon response predicate: is_hidden=false).
--   * Req 7.9  — hidden/unpublished content never appears in the presenter view.
--   * Req 21.3 — RLS enabled on client-exposed tables (default deny).
--   * Req 21.4 — unauthorised row access is rejected (no write policies; anon
--                reads gated by the predicates below).
--   * Req 21.5 — anonymous access confined to active/live event data (via the
--                `event_is_live(event_id)` helper on both tables).
--   * Req 21.6 — admin/moderation writes are server-mediated (service-role
--                RPCs, Task 22); no client write policy exists.
-- Design ref: RLS Design → `word_cloud_prompts` / `word_cloud_responses`
--             per-table policies; General policy strategy (`event_is_live`
--             helper; default deny; server-mediated writes).
--
-- Idempotency: RLS enablement is naturally idempotent (ALTER … ENABLE is a
-- no-op if already enabled); each policy is dropped with DROP POLICY IF EXISTS
-- before CREATE POLICY so the migration is safe to re-run.
-- ============================================================================

-- ============================================================================
-- word_cloud_prompts
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `word_cloud_prompts` (default deny — Req 21.3, 21.4).
-- With RLS enabled and no permissive default, no client role can read or write
-- prompt rows until an explicit policy grants access. The service role used by
-- the Word Cloud RPCs (Task 22) bypasses these client policies and is
-- unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE word_cloud_prompts ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Anonymous SELECT — published prompts on a live event only
-- (Req 6.3, 7.9, 21.4, 21.5).
-- The audience/presenter (`anon` role via the anon key) may read a prompt row
-- ONLY when BOTH conditions hold:
--   1. the parent event is currently live — checked via the SECURITY DEFINER
--      `event_is_live(event_id)` helper (…000006), which avoids RLS recursion
--      on `events` and leaks nothing but a boolean; and
--   2. the prompt's status is audience-visible: 'open' (collecting) or
--      'closed' (final results).
-- 'draft' is excluded from the predicate, so an unpublished draft prompt can
-- NEVER be returned to anonymous clients (Req 6.3).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS word_cloud_prompts_anon_select_visible ON word_cloud_prompts;
CREATE POLICY word_cloud_prompts_anon_select_visible
    ON word_cloud_prompts
    FOR SELECT
    TO anon
    USING (
        event_is_live(event_id)
        AND status IN ('open', 'closed')
    );

-- ----------------------------------------------------------------------------
-- Authenticated SELECT — all prompts (Req 21.6).
-- Admins/moderators (`authenticated` role) may read EVERY prompt regardless of
-- status — including 'draft' — so they can prepare and manage prompts. For V1
-- all admins are equivalent (mirroring the questions authenticated SELECT
-- policy), so the predicate is USING (true) rather than being scoped to the
-- admin's own events. Read-only: this policy grants SELECT only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS word_cloud_prompts_authenticated_select_all ON word_cloud_prompts;
CREATE POLICY word_cloud_prompts_authenticated_select_all
    ON word_cloud_prompts
    FOR SELECT
    TO authenticated
    USING (true);

-- ============================================================================
-- word_cloud_responses
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `word_cloud_responses` (default deny — Req 21.3, 21.4).
-- With RLS enabled and no permissive default, no client role can read or write
-- response rows until an explicit policy grants access. The service role used
-- by the submit / hide-unhide RPCs (Task 22) bypasses these client policies and
-- is unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE word_cloud_responses ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Anonymous SELECT — non-hidden responses on a live event only
-- (Req 6.13, 7.9, 21.4, 21.5).
-- The audience/presenter (`anon` role via the anon key) may read a response row
-- ONLY when BOTH conditions hold:
--   1. the response's parent event is currently live — checked via the
--      SECURITY DEFINER `event_is_live(event_id)` helper (…000006). The
--      `word_cloud_responses.event_id` column duplicates the parent prompt's
--      event (see …000019), so `event_is_live(event_id)` is the simplest
--      correct predicate — no join to word_cloud_prompts is required; and
--   2. the response is NOT hidden (`is_hidden = false`).
-- Hidden (moderated) responses are excluded at the ROW level, so they can NEVER
-- reach the audience/presenter or be aggregated into the anon word cloud
-- (Req 6.13, 7.9).
--
-- NOTE (participant privacy — read layer): this row-level policy does NOT
-- restrict COLUMNS. `word_cloud_responses` still contains
-- `participant_identifier`; the READ LAYER / aggregation helper is responsible
-- for selecting ONLY non-sensitive columns (id, normalised_text, is_hidden,
-- event_id, prompt_id) and NEVER `participant_identifier` (Req 2.5, 8.6). RLS
-- gates rows; the app read path gates columns.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS word_cloud_responses_anon_select_visible ON word_cloud_responses;
CREATE POLICY word_cloud_responses_anon_select_visible
    ON word_cloud_responses
    FOR SELECT
    TO anon
    USING (
        event_is_live(event_id)
        AND is_hidden = false
    );

-- ----------------------------------------------------------------------------
-- Authenticated SELECT — all responses (Req 21.6).
-- Admins/moderators (`authenticated` role) may read EVERY response regardless
-- of `is_hidden` — including hidden entries — so they can moderate the word
-- cloud (review and unhide entries). For V1 all admins are equivalent
-- (mirroring the questions authenticated SELECT policy), so the predicate is
-- USING (true). Read-only: this policy grants SELECT only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS word_cloud_responses_authenticated_select_all ON word_cloud_responses;
CREATE POLICY word_cloud_responses_authenticated_select_all
    ON word_cloud_responses
    FOR SELECT
    TO authenticated
    USING (true);

-- ----------------------------------------------------------------------------
-- NOTE (intentional omission): there is deliberately NO anon or authenticated
-- INSERT / UPDATE / DELETE policy on `word_cloud_prompts` or
-- `word_cloud_responses`. With RLS enabled, the absence of a write policy means
-- all client writes are default-denied.
--   * Prompt create/open/close and response upsert flow through the SECURITY
--     DEFINER / service-role Word Cloud RPCs (Task 22), which enforce the
--     single-open-prompt rule (Req 6.5), the one-response-per-participant
--     UNIQUE rule (Req 6.9), length/normalisation (Req 6.8, 6.10) and rate
--     limits, inserting/updating with the definer's rights.
--   * Hide/unhide (moderation) is performed by a service-role RPC (Task 22),
--     which toggles `is_hidden` after verifying an admin JWT (Req 6.12, 6.13,
--     21.6). The service role bypasses RLS.
-- Keeping every write server-mediated ensures the single-open-prompt rule,
-- one-response rule, normalisation and moderation cannot be bypassed by a
-- direct client mutation.
-- ----------------------------------------------------------------------------
