-- ============================================================================
-- Migration: 20260101000009_questions_indexes.sql
-- Purpose:   Add the secondary indexes on the `questions` table plus the
--            idempotency uniqueness constraint required by Milestone 2
--            (Core Live Q&A) of MSS LivePulse.
--
-- Ordering:  The Supabase CLI applies migrations in the byte-lexicographic
--            order returned by its directory read (Go's ReadDir sorts entries
--            by filename using byte comparison, NOT locale collation). This
--            file is named so it sorts immediately after the table-creation
--            migration and before the question_votes migration:
--              20260101000009_questions.sql            (creates the table)
--              20260101000009_questions_indexes.sql    (THIS file)
--              20260101000010_question_votes.sql       (later table)
--            Verification (byte-by-byte):
--              * `20260101000009_questions.sql` vs
--                `20260101000009_questions_indexes.sql` — identical through the
--                shared prefix `20260101000009_questions`, then `.` (0x2E) vs
--                `_` (0x5F); since `.` < `_`, the table migration sorts FIRST
--                and this indexes migration SECOND. Correct.
--              * `20260101000009_questions_indexes.sql` vs
--                `20260101000010_question_votes.sql` — identical through the
--                shared prefix `2026010100000`, then `9` (0x39) vs `1` (0x31);
--                since `1` < `9`, every `...000010_*` filename sorts AFTER every
--                `...000009_*` filename, so this file sorts BEFORE the votes
--                migration. Correct.
--            Note: the CLI derives a migration's *version* from the leading 14
--            digits only, so this file shares version `20260101000009` with the
--            table migration — intentional, as these indexes conceptually
--            belong to Task 11.1's table (split into a separate file only to
--            avoid an edit conflict). Apply order is decided by the byte-order
--            filename sort above, under which the table migration always runs
--            first. Index creation here requires only that the `questions`
--            table exist (created in 20260101000009_questions.sql); it does not
--            depend on question_votes, so the ordering above is sound.
--
-- Scope (Task 11.2 only):
--   * idx_questions_event   on questions(event_id)
--   * idx_questions_status  on questions(event_id, status)
--   * idx_questions_created on questions(event_id, created_at)
--   * idx_questions_votes   on questions(event_id, vote_count DESC)
--   * partial UNIQUE (event_id, submission_key) WHERE submission_key IS NOT NULL
--     — write idempotency so a retried submit is not duplicated (Req 23.8).
--
-- Already established elsewhere — DELIBERATELY NOT re-declared here:
--   * The `questions` table, its PRIMARY KEY on `id`, the `event_id`
--     FK → events(id) ON DELETE CASCADE, CHECK constraints, and the
--     set_updated_at() trigger — all created in 20260101000009_questions.sql.
--   Re-creating any of the above would raise a duplicate-object error, so this
--   migration adds ONLY the secondary indexes and the partial unique index.
--
-- Requirements: 23.3 (secondary indexes for performant scoped queries),
--               23.8 (idempotent writes via the partial unique constraint).
-- Design ref:  Data Models → `questions` (Indexes: PK on id; idx_questions_event
--              on event_id; idx_questions_status on (event_id, status);
--              idx_questions_created on (event_id, created_at); idx_questions_votes
--              on (event_id, vote_count DESC); UNIQUE (event_id, submission_key)
--              where submission_key IS NOT NULL).
--
-- Idempotency: every index is guarded with IF NOT EXISTS so the migration is
-- safe to re-run.
-- ============================================================================

-- Look up all questions for an event (the most common scoping key). (Req 23.3)
CREATE INDEX IF NOT EXISTS idx_questions_event
    ON questions (event_id);

-- Moderation-queue / status-filtered reads scoped to an event, e.g. fetching
-- pending questions for moderators or approved/featured for the audience.
-- (Req 23.3)
CREATE INDEX IF NOT EXISTS idx_questions_status
    ON questions (event_id, status);

-- Chronological ordering of an event's questions (newest/oldest first).
-- (Req 23.3)
CREATE INDEX IF NOT EXISTS idx_questions_created
    ON questions (event_id, created_at);

-- Top-questions ordering by popularity within an event; DESC on vote_count so
-- the highest-voted questions are read efficiently. (Req 23.3)
CREATE INDEX IF NOT EXISTS idx_questions_votes
    ON questions (event_id, vote_count DESC);

-- Write idempotency (Req 23.8): a client-supplied submission_key makes a
-- retried submit for the same event a no-op rather than a duplicate. The
-- uniqueness is partial — enforced only when submission_key IS NOT NULL — so
-- rows without an idempotency key are unconstrained and multiple NULLs are
-- permitted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_questions_event_submission_key
    ON questions (event_id, submission_key)
    WHERE submission_key IS NOT NULL;
