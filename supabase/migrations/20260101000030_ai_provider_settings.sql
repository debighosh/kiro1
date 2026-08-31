-- ============================================================================
-- Migration: 20260101000030_ai_provider_settings.sql
-- Purpose:   Create the Milestone 4 (AI Features) enumerated types and the
--            `ai_provider_settings` table — the single active, global AI
--            provider configuration for MSS LivePulse.
--
-- This migration MUST sort AFTER 20260101000029_poll_broadcast.sql (and after
-- 20260101000002_events.sql, which defines the reusable `set_updated_at()`
-- trigger function reused here — it is NOT redefined in this migration).
--
-- Scope (Task 26.1):
--   * Create the Milestone 4 AI enums (Req 11.3, 11.5, 20.6):
--       - provider_type ('openai_compatible','custom_adapter')       (Req 11.3)
--       - ai_auth_type  ('bearer','api_key_header','none')            (Req 11.5)
--       - ai_job_type   ('categorisation','clustering','theme_insights',
--                        'summary','connection_test')                 (Req 20.6)
--       - ai_job_status ('pending','running','succeeded','failed')    (Req 20.6)
--     (The `ai_jobs` / `question_clusters` tables that consume the job enums
--     are created by later tasks 26.2 / 26.3; the enums are defined here up
--     front, matching the "enums first" convention of 20260101000001_enums.sql.)
--   * Create the `ai_provider_settings` table — a single active global config
--     (Req 11.1, 11.5, 11.9, 13.12) — with all columns, PK, and CHECK
--     constraints per design.
--   * Add the partial UNIQUE `one_active_ai_provider` index enforcing that AT
--     MOST ONE config row may be active at the DB level              (Req 11.7, 11.8).
--   * Add the credential XOR CHECK so `secret_reference` and
--     `encrypted_credential` are never BOTH populated                (Req 12.6).
--   * Attach the existing reusable BEFORE UPDATE `set_updated_at()` trigger to
--     keep `updated_at` current on every update                      (Req 19.1).
--
-- CREDENTIAL SECURITY (Req 12.4):
--   The plaintext credential is NEVER stored. There is deliberately NO
--   plaintext credential column on this table. A configured credential is held
--   EITHER as a pointer to an external secret store (`secret_reference`) OR as
--   ciphertext (`encrypted_credential`), but never both (see the XOR CHECK),
--   and never in cleartext. The GENERATED `credential_state` column exposes
--   only whether a credential is configured — not its value (Req 11.9).
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * The `ai_jobs` table                                            (Task 26.2).
--   * The `question_clusters` table                                  (Task 26.3).
--   * RLS enablement / policies for `ai_provider_settings`           (Task 27).
--   * The static analysis guard forbidding plaintext-credential columns (Task 26.4).
--
-- Requirements: 11.1, 11.5, 11.7, 11.8, 11.9, 12.4, 12.6, 13.12, 19.1
-- Design ref:  Data Models → `ai_provider_settings` table; Enumerated types;
--              `one_active_ai_provider` partial unique index; credential XOR CHECK.
--
-- Idempotency: the enums are guarded with DO $$ IF NOT EXISTS blocks, the table
-- with IF NOT EXISTS, the index with IF NOT EXISTS, and the trigger is
-- dropped-then-created, so the migration is safe to re-run.
-- ============================================================================

-- provider_type — how the provider's HTTP contract is shaped (Req 11.3):
-- openai_compatible (a standard /chat/completions-style endpoint) or
-- custom_adapter (a bespoke request/response adapter).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'provider_type') THEN
        CREATE TYPE provider_type AS ENUM (
            'openai_compatible',
            'custom_adapter'
        );
    END IF;
END
$$;

-- ai_auth_type — how the provider authenticates requests (Req 11.5): bearer
-- (Authorization: Bearer <token>), api_key_header (a custom header named by
-- `api_key_header_name`), or none (no credential required).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_auth_type') THEN
        CREATE TYPE ai_auth_type AS ENUM (
            'bearer',
            'api_key_header',
            'none'
        );
    END IF;
END
$$;

-- ai_job_type — the kind of AI operation recorded in the job audit log
-- (Req 20.6). Consumed by the `ai_jobs` table created in Task 26.2.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_job_type') THEN
        CREATE TYPE ai_job_type AS ENUM (
            'categorisation',
            'clustering',
            'theme_insights',
            'summary',
            'connection_test'
        );
    END IF;
END
$$;

-- ai_job_status — the lifecycle state of an AI job (Req 20.6). Consumed by the
-- `ai_jobs` table created in Task 26.2.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_job_status') THEN
        CREATE TYPE ai_job_status AS ENUM (
            'pending',
            'running',
            'succeeded',
            'failed'
        );
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- ai_provider_settings — the single active, global AI provider configuration
-- (Req 11). At most one row is active at a time (enforced by the partial unique
-- index below). Credentials are never stored in plaintext: a configured
-- credential lives EITHER as a pointer (`secret_reference`) OR as ciphertext
-- (`encrypted_credential`) — never both (XOR CHECK) and never in cleartext
-- (Req 12.4, 12.6). The GENERATED `credential_state` column surfaces only
-- whether a credential is configured (Req 11.9).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_provider_settings (
    id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),                    -- Req 11.1
    is_active               boolean       NOT NULL DEFAULT true,                                    -- Req 11.7, 11.8
    ai_enabled              boolean       NOT NULL DEFAULT false,                                   -- Req 11.1
    display_name            text          NOT NULL
                                          CONSTRAINT ai_provider_settings_display_name_length_chk
                                              CHECK (char_length(display_name) BETWEEN 1 AND 100),  -- Req 11.1
    provider_type           provider_type NOT NULL,                                                 -- Req 11.3
    base_url                text          NOT NULL
                                          CONSTRAINT ai_provider_settings_base_url_length_chk
                                              CHECK (char_length(base_url) BETWEEN 1 AND 2048)
                                          CONSTRAINT ai_provider_settings_base_url_absolute_chk
                                              CHECK (base_url ~ '^https?://'),                       -- Req 11.1 (absolute URL)
    chat_completions_path   text          NOT NULL
                                          CONSTRAINT ai_provider_settings_chat_path_length_chk
                                              CHECK (char_length(chat_completions_path) BETWEEN 1 AND 512), -- Req 11.1
    auth_type               ai_auth_type  NOT NULL,                                                 -- Req 11.5
    api_key_header_name     text          NULL
                                          CONSTRAINT ai_provider_settings_api_key_header_name_length_chk
                                              CHECK (api_key_header_name IS NULL
                                                     OR char_length(api_key_header_name) BETWEEN 1 AND 100), -- Req 11.5
    model_id                text          NOT NULL
                                          CONSTRAINT ai_provider_settings_model_id_length_chk
                                              CHECK (char_length(model_id) BETWEEN 1 AND 200),      -- Req 11.1
    temperature             numeric(3,2)  NOT NULL
                                          CONSTRAINT ai_provider_settings_temperature_range_chk
                                              CHECK (temperature BETWEEN 0.0 AND 2.0),              -- Req 11.1
    max_output_tokens       integer       NOT NULL
                                          CONSTRAINT ai_provider_settings_max_output_tokens_range_chk
                                              CHECK (max_output_tokens BETWEEN 1 AND 128000),       -- Req 11.1
    request_timeout_seconds integer       NOT NULL
                                          CONSTRAINT ai_provider_settings_request_timeout_range_chk
                                              CHECK (request_timeout_seconds BETWEEN 1 AND 300),    -- Req 11.1, 19.1
    tls_verify_required     boolean       NOT NULL DEFAULT true,                                    -- Req 11.1, 13.12
    secret_reference        text          NULL,                                                     -- Req 12.3 (pointer only)
    encrypted_credential    bytea         NULL,                                                     -- Req 12.5 (ciphertext only)
    credential_state        text          GENERATED ALWAYS AS (
                                              CASE
                                                  WHEN secret_reference IS NOT NULL
                                                       OR encrypted_credential IS NOT NULL
                                                  THEN 'configured'
                                                  ELSE 'not_configured'
                                              END
                                          ) STORED,                                                 -- Req 11.9
    created_at              timestamptz   NOT NULL DEFAULT now(),                                   -- Req 19.1
    updated_at              timestamptz   NOT NULL DEFAULT now(),                                   -- Req 19.1

    -- Credential XOR: `secret_reference` and `encrypted_credential` are never
    -- BOTH populated (Req 12.6). num_nonnulls(...) <= 1 permits 0 (not
    -- configured) or exactly 1 (configured via one storage mechanism).
    CONSTRAINT ai_provider_settings_credential_xor_chk
        CHECK (num_nonnulls(secret_reference, encrypted_credential) <= 1)
);

-- ----------------------------------------------------------------------------
-- one_active_ai_provider — partial UNIQUE index enforcing, at the DB level,
-- that AT MOST ONE `ai_provider_settings` row may be active at any time
-- (Req 11.7, 11.8). Because the index only covers rows WHERE is_active, any
-- number of inactive (historical) configs remain allowed; a second attempt to
-- mark a config active while another is already active raises a
-- unique-violation. Enforcing this in the schema makes the single-active-config
-- invariant race-safe under concurrent updates.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ai_provider
    ON ai_provider_settings (is_active)
    WHERE is_active;

-- Refresh updated_at on every UPDATE to ai_provider_settings (Req 19.1),
-- reusing the table-agnostic set_updated_at() trigger function created in
-- 20260101000002_events.sql (NOT redefined here).
DROP TRIGGER IF EXISTS trg_ai_provider_settings_set_updated_at ON ai_provider_settings;
CREATE TRIGGER trg_ai_provider_settings_set_updated_at
    BEFORE UPDATE ON ai_provider_settings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
