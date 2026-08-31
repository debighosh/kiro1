-- ============================================================================
-- Migration: 20260101000033_ai_provider_settings_rls.sql
-- Purpose:   Enable Row Level Security (RLS) on the `ai_provider_settings`
--            table and establish its access posture. The net effect is: RLS
--            ENABLED, DEFAULT-DENY, NO anonymous access at all, and NO client
--            (anon/authenticated) SELECT/INSERT/UPDATE/DELETE policy on the
--            base table. The ONLY client-reachable read path is the
--            SECURITY DEFINER function `read_ai_provider_settings()` (with a
--            companion column-restricted view `ai_provider_settings_public`),
--            which returns ONLY whitelisted NON-SECRET columns of the active
--            config and DELIBERATELY excludes `secret_reference` and
--            `encrypted_credential`. All config/secret writes occur only inside
--            the service-role AI Config / AI Gateway Edge Functions.
--
-- Ordering: this migration MUST sort AFTER the `ai_provider_settings` table
--           migration (20260101000030_ai_provider_settings.sql, Task 26.1) so
--           the table and all of its columns exist. The …000033 timestamp
--           places it after …000030 (the table), …000031 (`ai_jobs`) and
--           …000032 (`question_clusters`), and before the AI-jobs/clusters RLS
--           migration (…000034, Task 27.2). This migration owns a DIFFERENT
--           file from the concurrently-authored Task 27.2 (…000034), so there
--           is no conflict.
--
-- Scope (Task 27.1 only):
--   * Enable RLS on `ai_provider_settings` (ALTER TABLE … ENABLE ROW LEVEL
--     SECURITY) — default deny, NO permissive base-table policies.
--   * Provide the authenticated-admin read path over NON-SECRET columns only:
--       - Primary path: the SECURITY DEFINER function
--         `read_ai_provider_settings()` returning a table of only the
--         whitelisted non-secret columns of the active config, with EXECUTE
--         granted to `authenticated` (NOT `anon`).
--       - Companion: the column-restricted view `ai_provider_settings_public`
--         selecting only those same non-secret columns, with SELECT granted to
--         `authenticated` (NOT `anon`).
--   * Add NO anonymous (`anon`) access of any kind.
--   * Add NO client INSERT/UPDATE/DELETE policy (writes are service-role only).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * RLS enablement / policies for `ai_jobs` + `question_clusters` (Task 27.2).
--   * Env-gated RLS integration tests for the AI tables            (Task 27.3).
--   * The service-role AI Config Edge Function (config/secret writes) (Task 28.2).
--   * The service-role AI Gateway Edge Function (secret resolution)   (Task 29.1).
--
-- ---------------------------------------------------------------------------
-- SECURITY MODEL — why NO anonymous access, and NO base-table SELECT
-- ---------------------------------------------------------------------------
-- `ai_provider_settings` is an ADMIN-ONLY configuration table. The audience
-- (`anon` role) has NO legitimate reason to read or write any part of it, so
-- there is NO anonymous policy and NO anonymous grant of ANY kind — anonymous
-- access is denied entirely (Req 21.4, 21.6).
--
-- Even for authenticated admins, the base table is NEVER directly readable:
-- with RLS enabled and no SELECT policy on the base table, a direct
-- `SELECT … FROM ai_provider_settings` by any client role returns nothing.
-- This is intentional and is the mechanism that keeps the SECRET columns
-- (`secret_reference`, `encrypted_credential`, and any resolved secret) out of
-- reach of every client (Req 12.8, 12.10, 21.8): there is simply NO
-- client-reachable path — policy or grant — that can return those columns.
--
-- ---------------------------------------------------------------------------
-- SECRET-EXCLUSION INVARIANT (Req 12.8, 12.10, 21.8) — the whitelist
-- ---------------------------------------------------------------------------
-- The authenticated-admin read path exposes ONLY the following NON-SECRET
-- columns of the active config:
--     id, is_active, ai_enabled, display_name, provider_type, base_url,
--     chat_completions_path, auth_type, api_key_header_name, model_id,
--     temperature, max_output_tokens, request_timeout_seconds,
--     tls_verify_required, credential_state, created_at, updated_at
-- The SECRET columns `secret_reference` and `encrypted_credential` are
-- DELIBERATELY OMITTED from both the function's return type and the view's
-- select list, and are NEVER granted to `authenticated` (nor `anon`) via any
-- policy or column grant. `credential_state` (a GENERATED column) is included
-- because it surfaces only WHETHER a credential is configured
-- ('configured' / 'not_configured') — never the credential value itself
-- (Req 11.9). Any resolved plaintext secret is produced only transiently inside
-- the service-role AI Gateway Edge Function and is never stored or exposed on
-- any read path (Req 12.10). The KEY invariant of this migration is therefore:
-- NO client-reachable path exposes `secret_reference` or `encrypted_credential`.
--
-- ---------------------------------------------------------------------------
-- SECURITY MODEL — why NO client write policy (service-mediated by design)
-- ---------------------------------------------------------------------------
-- No anon/authenticated INSERT/UPDATE/DELETE policy is defined. With RLS
-- enabled and no write policy, all direct client writes are default-denied.
-- Creating/updating a provider config and, crucially, writing the credential
-- columns is performed EXCLUSIVELY by the service-role AI Config Edge Function
-- (Task 28.2) — and the AI Gateway (Task 29.1) resolves secrets server-side —
-- both using the SERVICE ROLE, which BYPASSES RLS after verifying an
-- authenticated admin JWT (Req 21.6, 12.8, 12.10). This mirrors the
-- server-mediated posture of `questions` (…000011) and `question_votes`
-- (…000012): keeping every write server-mediated ensures the credential-
-- protection and single-active-config invariants cannot be bypassed by a
-- direct client mutation.
--
-- ---------------------------------------------------------------------------
-- NET EFFECT:
--   RLS ENABLED, DEFAULT DENY, NO anonymous access, NO base-table client
--   SELECT/INSERT/UPDATE/DELETE. The only client-reachable read is
--   `read_ai_provider_settings()` (and the `ai_provider_settings_public` view),
--   granted to `authenticated` only, returning whitelisted NON-SECRET columns
--   of the active config. Secret columns are never selectable by any client.
--   The service role (Edge Functions) operates outside these client policies
--   and is unaffected.
--
-- Requirements traceability:
--   * Req 12.8  — the stored credential (reference/ciphertext) is never
--                 returned to any client; the read path whitelists non-secret
--                 columns and the secret columns are ungranted/omitted.
--   * Req 12.10 — no resolved/plaintext secret is exposed on any read path;
--                 secrets are resolved only transiently server-side.
--   * Req 21.3  — RLS enabled on this client-exposed table (default deny).
--   * Req 21.4  — unauthorised/anonymous row access is rejected (no anon path).
--   * Req 21.8  — sensitive credential material is never client-readable.
--   * Req 21.6  — config/secret mutations are performed server-side via the
--                 service role (no client write policy).
-- Design ref:   RLS Design → `ai_provider_settings` (no anonymous access,
--               non-secret columns only via column-restricted view /
--               SECURITY DEFINER read fn; secret writes service-role only).
--
-- Idempotency: RLS enablement is naturally idempotent (ALTER … ENABLE is a
--   no-op if already enabled). The read function uses CREATE OR REPLACE
--   FUNCTION, the view uses CREATE OR REPLACE VIEW, and grants are naturally
--   re-runnable, so the migration is safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enable RLS on `ai_provider_settings` (default deny — Req 21.3, 21.4).
-- With RLS enabled and NO permissive base-table policy, no client role (anon or
-- authenticated) can read or write `ai_provider_settings` rows directly. The
-- service role used by the AI Config / AI Gateway Edge Functions bypasses these
-- client policies; the SECURITY DEFINER read function below operates with the
-- definer's rights and is the ONLY client-reachable read path.
-- ----------------------------------------------------------------------------
ALTER TABLE ai_provider_settings ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- read_ai_provider_settings() — PRIMARY client read path (Req 12.8, 12.10,
-- 21.8). A SECURITY DEFINER function that returns ONLY the whitelisted
-- NON-SECRET columns of the single ACTIVE config (is_active = true). It
-- DELIBERATELY excludes `secret_reference` and `encrypted_credential` from its
-- return type, so those secret columns can NEVER be projected through this
-- path. Returns zero rows when no active config exists.
--
-- SECURITY DEFINER + `SET search_path = public, pg_temp`: the function reads
-- the base table with the definer's rights (bypassing the base-table default
-- deny) and cannot be hijacked via a caller-controlled search_path. EXECUTE is
-- granted to `authenticated` ONLY (NOT `anon`) — see grants below. This is the
-- ONLY client read path for AI provider configuration.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION read_ai_provider_settings()
RETURNS TABLE (
    id                      uuid,
    is_active               boolean,
    ai_enabled              boolean,
    display_name            text,
    provider_type           provider_type,
    base_url                text,
    chat_completions_path   text,
    auth_type               ai_auth_type,
    api_key_header_name     text,
    model_id                text,
    temperature             numeric(3,2),
    max_output_tokens       integer,
    request_timeout_seconds integer,
    tls_verify_required     boolean,
    credential_state        text,
    created_at              timestamptz,
    updated_at              timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    -- WHITELIST ONLY: secret_reference and encrypted_credential are
    -- intentionally NOT selected here and are absent from the return type.
    SELECT
        s.id,
        s.is_active,
        s.ai_enabled,
        s.display_name,
        s.provider_type,
        s.base_url,
        s.chat_completions_path,
        s.auth_type,
        s.api_key_header_name,
        s.model_id,
        s.temperature,
        s.max_output_tokens,
        s.request_timeout_seconds,
        s.tls_verify_required,
        s.credential_state,
        s.created_at,
        s.updated_at
    FROM ai_provider_settings s
    WHERE s.is_active
    LIMIT 1;
$$;

COMMENT ON FUNCTION read_ai_provider_settings() IS
    'Client read path for the active AI provider config (Task 27.1; Req 12.8, '
    '12.10, 21.8). SECURITY DEFINER, EXECUTE to authenticated only (not anon). '
    'Returns ONLY whitelisted NON-SECRET columns of the active config; '
    'secret_reference and encrypted_credential are deliberately excluded and '
    'are never selectable by any client. This is the ONLY client read path — '
    'the base table has RLS enabled with no client SELECT policy.';

-- ----------------------------------------------------------------------------
-- ai_provider_settings_public — companion column-restricted VIEW selecting the
-- SAME whitelisted NON-SECRET columns of the active config. Provided for
-- convenience/consistency with the design's "column-restricted view" option;
-- the SECURITY DEFINER function above is the primary path. The view selects
-- ONLY non-secret columns (secret_reference / encrypted_credential are omitted)
-- and SELECT is granted to `authenticated` ONLY (see grants below). Because the
-- view is not SECURITY DEFINER, it is additionally protected by the base
-- table's default-deny RLS; the enduring guarantee — that the secret columns
-- are never in a client-reachable projection — is provided by the omission of
-- those columns here regardless.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW ai_provider_settings_public AS
    SELECT
        s.id,
        s.is_active,
        s.ai_enabled,
        s.display_name,
        s.provider_type,
        s.base_url,
        s.chat_completions_path,
        s.auth_type,
        s.api_key_header_name,
        s.model_id,
        s.temperature,
        s.max_output_tokens,
        s.request_timeout_seconds,
        s.tls_verify_required,
        s.credential_state,
        s.created_at,
        s.updated_at
    FROM ai_provider_settings s
    WHERE s.is_active;

COMMENT ON VIEW ai_provider_settings_public IS
    'Column-restricted view of the active AI provider config (Task 27.1; Req '
    '12.8, 12.10, 21.8): whitelisted NON-SECRET columns only. secret_reference '
    'and encrypted_credential are deliberately omitted. SELECT granted to '
    'authenticated only (not anon).';

-- ----------------------------------------------------------------------------
-- Grants. The read path is for authenticated admins ONLY; anonymous clients get
-- NOTHING (no grant, no policy). We do NOT grant anything to `anon`.
--   * EXECUTE on the SECURITY DEFINER read function → authenticated only.
--   * SELECT on the column-restricted view          → authenticated only.
-- We deliberately do NOT grant SELECT on the base `ai_provider_settings` table
-- to `anon` OR `authenticated`; base-table reads stay default-denied by RLS,
-- so the ONLY client-reachable projections are the whitelisted, secret-free
-- function/view above.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION read_ai_provider_settings() TO authenticated;
GRANT SELECT   ON ai_provider_settings_public          TO authenticated;

-- ----------------------------------------------------------------------------
-- NOTE (intentional omissions):
--   * NO anon access of ANY kind — no policy, no grant. Anonymous read/write of
--     `ai_provider_settings` (and its view/function) is denied entirely
--     (Req 21.4, 21.6).
--   * NO client SELECT policy on the base table — base-table reads are
--     default-denied so the SECRET columns (`secret_reference`,
--     `encrypted_credential`) can never be projected to a client. The only
--     read path is the whitelisted, secret-free function/view (Req 12.8,
--     12.10, 21.8).
--   * NO client INSERT/UPDATE/DELETE policy — with RLS enabled, all client
--     writes are default-denied. Creating/updating configs and writing the
--     credential columns is performed EXCLUSIVELY by the service-role AI Config
--     Edge Function (Task 28.2); secret resolution happens server-side in the
--     AI Gateway (Task 29.1). The service role bypasses RLS after verifying an
--     admin JWT (Req 21.6, 12.8, 12.10). Keeping writes server-mediated ensures
--     credential protection and the single-active-config invariant cannot be
--     bypassed by a direct client mutation.
-- ----------------------------------------------------------------------------
