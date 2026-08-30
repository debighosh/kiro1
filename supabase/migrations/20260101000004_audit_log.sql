-- ============================================================================
-- Migration: 20260101000004_audit_log.sql
-- Purpose:   Create the `audit_log` table — the change audit trail that records
--            when moderation, event-status, AI-endpoint and credential-rotation
--            changes occur (Req 21.19).
--
-- Ordering: this migration MUST sort AFTER the events table migration
--           (20260101000002_events.sql) because `audit_log.event_id` carries a
--           foreign key to `events(id)`. The 20260101000004 timestamp places it
--           after the enums (…000001), events (…000002) and admin_profiles
--           (…000003) migrations, so the FK target already exists.
--
-- Scope (Task 4.5, Milestone 1 only):
--   * Creates ONLY the audit_log table and its FK/CHECK constraints.
--   * Row-Level Security is intentionally NOT enabled here; RLS on audit_log is
--     added by a later task (task 5.2).
--   * No other tables are created here.
--
-- Requirements traceability: Req 21.19 (UTC audit timestamps for moderation,
--   event-status, AI-endpoint and credential-rotation changes).
-- Design ref: Data Models → `audit_log`.
--
-- Idempotency: the table creation is guarded with IF NOT EXISTS so the
-- migration is safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    -- Unique audit-record id.
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The category of change being audited. Constrained to the known set of
    -- Milestone 1 change types (Req 21.19).
    change_type  text NOT NULL
        CHECK (change_type IN (
            'moderation',
            'event_status',
            'ai_endpoint',
            'credential_rotation'
        )),

    -- Optional event this change relates to. Nullable because some changes
    -- (e.g. credential rotation) are not scoped to a single event. When the
    -- referenced event is deleted, its audit rows are removed as well
    -- (ON DELETE CASCADE), consistent with the event-delete behaviour.
    event_id     uuid NULL REFERENCES events (id) ON DELETE CASCADE,

    -- UTC timestamp of when the change occurred (Req 21.19).
    occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- Index supporting lookups of audit rows scoped to a given event.
CREATE INDEX IF NOT EXISTS idx_audit_log_event_id ON audit_log (event_id);
