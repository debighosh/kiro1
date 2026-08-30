-- =============================================================================
-- MSS LivePulse — Database seed data
-- =============================================================================
--
-- PURPOSE
--   This file seeds a fresh local/dev database with demo data so the core
--   engagement flow can be exercised end-to-end WITHOUT any AI provider
--   configured (Req 3.8, 19.1, 27.4). It provisions a single demo event —
--   "MSS AI Demo Day 2026" — in `draft` status with pre-moderation enabled, so
--   an operator can walk the foundation/core flow (event lookup, presenter
--   access, moderation defaults) immediately after a database reset.
--
--   The Supabase CLI applies this file automatically AFTER all migrations have
--   run (e.g. on `supabase db reset`). Because it runs post-migration, every
--   table, enum, constraint and trigger referenced below already exists.
--
-- IDEMPOTENCY
--   The seed must be safe to run repeatedly (each `supabase db reset` re-applies
--   it). `slug` and `presenter_token` are both UNIQUE on `events`, so a naive
--   re-insert would raise a duplicate-key error. We use a FIXED demo `slug` plus
--   a FIXED demo `presenter_token` and guard the INSERT with `ON CONFLICT (slug)
--   DO NOTHING`. On the first run the row is created; on every subsequent run the
--   slug already exists so the statement is a no-op — which also means the fixed
--   presenter_token never gets a chance to collide.
--
-- SCOPE (Milestone 1)
--   Only the `events` table is seeded here. The questions / question_votes /
--   polls / poll_options / poll_responses / word_cloud_prompts /
--   word_cloud_responses / ai_* tables do NOT exist until Milestones 2–3, so no
--   rows are seeded for them yet. Sample poll and word-cloud prompts (mentioned
--   in design.md → "Migrations and seed data") will be added to this seed once
--   those tables are introduced.
--
--   No `admin_profiles` row is seeded either: `admin_profiles.id` is an FK to
--   `auth.users`, and inserting a profile for a non-existent auth user would
--   fail. Administrator accounts are provisioned separately via Supabase Auth
--   (Supabase dashboard / CLI), and the matching `admin_profiles` row is created
--   on first sign-in.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Demo event: "MSS AI Demo Day 2026" (Req 3.8 — default pre-moderated demo event)
-- -----------------------------------------------------------------------------
--   * status                = 'draft'  (default lifecycle state; Req 1.5)
--   * moderation_mode       = 'pre'    (pre-moderation for the demo event; Req 3.8)
--   * slug                  = 'mss-ai-demo-day-2026' (matches ^[A-Za-z0-9-]{1,64}$)
--   * presenter_token       = 40-char fixed alphanumeric demo constant
--                             (satisfies CHECK: length >= 32 AND ^[A-Za-z0-9]+$; Req 7.3)
--   * active_presenter_mode = default 'join'  (left to column default)
--   * stop_words            = default '{}'    (left to column default)
--   * starts_at / ends_at   = now() .. now() + 8h (ends_at > starts_at; Req 1.1, 1.2)
INSERT INTO events (
    name,
    description,
    slug,
    status,
    moderation_mode,
    starts_at,
    ends_at,
    presenter_token
)
VALUES (
    'MSS AI Demo Day 2026',
    'Demo event seeded for local development so the core engagement flow can be exercised end-to-end without an AI provider configured.',
    'mss-ai-demo-day-2026',
    'draft',
    'pre',
    now(),
    now() + interval '8 hours',
    -- Fixed, clearly-demo presenter token (40 alphanumeric chars). DEMO ONLY —
    -- real events must mint a fresh unguessable token.
    'MSSLIVEPULSEDEMODAYPRESENTERTOKEN2026XYZ'
)
ON CONFLICT (slug) DO NOTHING;
