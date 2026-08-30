-- ============================================================================
-- Migration: 20260101000003_admin_profiles.sql
-- Purpose:   Create the `admin_profiles` table, which holds administrator /
--            moderator identity for MSS LivePulse and links each profile
--            one-to-one to a Supabase auth user (auth.users).
--
-- Ordering:  This migration sorts AFTER the enums migration
--            (20260101000001_enums.sql) and AFTER the events table migration
--            (20260101000002_events.sql). It has no dependency on the events
--            table; the numbering simply keeps the foundation tables grouped.
--
-- Roles (V1):
--   For V1 there is NO separate moderator role. Any authenticated user that
--   has an `admin_profiles` row is treated as a full Administrator and is
--   granted the same interface access and the same set of permissions as an
--   Administrator (Req 10.3). Fine-grained RBAC is intentionally out of scope
--   for Milestone 1.
--
-- Scope (Milestone 1, this task only):
--   * admin_profiles table + its FK to auth.users.
--   Row Level Security is intentionally NOT enabled here — RLS on
--   admin_profiles is handled by a later migration (task 5.2). The
--   audit_log table and the event_is_live helper are likewise out of scope
--   for this migration.
--
-- Requirements: 10.1 (authenticated Administrator access), 10.3 (moderator ==
--               administrator for V1), 21.19 (UTC audit/created timestamps).
-- Design ref:   Data Models → `admin_profiles`.
--
-- Idempotency: uses CREATE TABLE IF NOT EXISTS so the migration is safe to
-- re-run against a database where the table already exists.
-- ============================================================================

-- admin_profiles — administrator / moderator identity (Req 10, 25.4).
-- Each profile is keyed by the Supabase auth user id (auth.users.id). Deleting
-- the underlying auth user cascades to remove the profile (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS admin_profiles (
    -- Primary key IS the Supabase auth user id; one profile per auth user.
    id           uuid        PRIMARY KEY
                             REFERENCES auth.users (id) ON DELETE CASCADE,

    -- Human-readable name shown in the admin interface.
    display_name text        NOT NULL,

    -- UTC creation timestamp for the profile (Req 21.19).
    created_at   timestamptz NOT NULL DEFAULT now()
);
