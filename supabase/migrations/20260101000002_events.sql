-- ============================================================================
-- Migration: 20260101000002_events.sql
-- Purpose:   Create the `events` table — one row per engagement session — the
--            foundation table of MSS LivePulse Milestone 1.
--
-- This migration MUST sort AFTER 20260101000001_enums.sql because the events
-- table references the event_status, moderation_mode and presenter_mode enums
-- defined there.
--
-- Scope (Task 4.2 only):
--   * Enable the `citext` extension (required for the case-insensitive `slug`).
--   * Create a reusable BEFORE UPDATE trigger function `set_updated_at()` that
--     refreshes the `updated_at` column on any row update (Req 21.19). It is
--     created here (the first table with an `updated_at` column) so later
--     tables can reuse it.
--   * Create the `events` table with all columns, PK, column-level UNIQUE on
--     `slug` and `presenter_token`, and CHECK constraints per design.
--   * Attach the updated_at trigger to `events`.
--
-- Deliberately NOT in this migration (owned by later tasks):
--   * `idx_events_status` secondary index                     (Task 4.3)
--   * RLS enablement / policies                               (Task 5.1)
--   * `admin_profiles` / `audit_log` tables                   (Tasks 4.4, 4.5)
--   * `event_is_live(event_id)` helper predicate              (Task 4.6)
--
-- NOTE for Task 4.3: column-level UNIQUE constraints on `slug` and
-- `presenter_token` are already created here (the design lists them as UNIQUE,
-- so it is natural to declare them inline). Task 4.3 therefore only needs to
-- add the `idx_events_status` index and should NOT re-declare these unique
-- constraints.
--
-- Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.6, 3.8, 7.3, 7.4, 21.19, 22.5, 22.6
-- Design ref:  Data Models → `events` table.
--
-- Idempotency: guarded with IF NOT EXISTS where the DDL supports it so the
-- migration is safe to re-run.
-- ============================================================================

-- The `citext` extension provides the case-insensitive text type used by the
-- `slug` column so that event codes are matched case-insensitively (Req 1.4).
CREATE EXTENSION IF NOT EXISTS citext;

-- ----------------------------------------------------------------------------
-- Reusable updated_at maintenance trigger function (Req 21.19).
-- Sets NEW.updated_at to the current transaction time on every UPDATE, so the
-- column always reflects the last modification regardless of the caller. This
-- function is intentionally table-agnostic so all mutable tables can share it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- events — one row per engagement session (Req 1).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id                    uuid            PRIMARY KEY DEFAULT gen_random_uuid(),                       -- Req 1.1
    name                  text            NOT NULL
                                          CONSTRAINT events_name_length_chk
                                              CHECK (char_length(name) BETWEEN 1 AND 100),            -- Req 1.1, 22.5
    description           text
                                          CONSTRAINT events_description_length_chk
                                              CHECK (description IS NULL OR char_length(description) <= 500), -- Req 1.3, 22.6
    slug                  citext          UNIQUE
                                          CONSTRAINT events_slug_format_chk
                                              CHECK (slug IS NULL OR slug ~ '^[A-Za-z0-9-]{1,64}$'),  -- Req 1.3, 1.4
    status                event_status    NOT NULL DEFAULT 'draft',                                   -- Req 1.5
    moderation_mode       moderation_mode NOT NULL DEFAULT 'pre',                                     -- Req 3.6, 3.8
    starts_at             timestamptz     NOT NULL,                                                   -- Req 1.1
    ends_at               timestamptz     NOT NULL
                                          CONSTRAINT events_ends_after_starts_chk
                                              CHECK (ends_at > starts_at),                            -- Req 1.1, 1.2
    presenter_token       text            NOT NULL UNIQUE
                                          CONSTRAINT events_presenter_token_chk
                                              CHECK (char_length(presenter_token) >= 32
                                                     AND presenter_token ~ '^[A-Za-z0-9]+$'),         -- Req 7.3
    active_presenter_mode presenter_mode  NOT NULL DEFAULT 'join',                                    -- Req 7.4, 7.5
    brand_colour          text,                                                                       -- Req 1.3
    logo_path             text,                                                                       -- Req 1.3
    stop_words            text[]          NOT NULL DEFAULT '{}',                                       -- Req 6.14
    created_at            timestamptz     NOT NULL DEFAULT now(),                                      -- Req 21.19
    updated_at            timestamptz     NOT NULL DEFAULT now()                                       -- Req 21.19
);

-- Refresh updated_at on every UPDATE to events (Req 21.19).
DROP TRIGGER IF EXISTS trg_events_set_updated_at ON events;
CREATE TRIGGER trg_events_set_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
