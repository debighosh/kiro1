# Implementation Plan: MSS LivePulse

## Overview

This plan is organised by milestone. **Milestone 1: Foundation** is fully detailed as a
sequence of discrete, incremental, test-driven coding steps. **Milestones 2–5** are included
as clearly-marked higher-level placeholder sections so the overall plan is visible; each will
be expanded into detailed tasks when that milestone begins. Per the product implementation
plan, **each milestone must be completed and verified before the next begins** (M1 → M2 → M3 →
M4 → M5).

The implementation language is **TypeScript** throughout (SPA + Supabase Edge Functions), as
mandated by the design's *Technology Stack and Dependencies* section; no separate language
selection is required. Because the design includes a *Correctness Properties* section,
property-based tests (fast-check) are included where the Milestone-1 groundwork exercises those
properties (notably Property 11 event-status gating, and Properties 12/13 for any
`ai_provider_settings` credential-schema groundwork).

Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core
implementation tasks are never optional. Each task references the specific requirement clauses
it implements and, where relevant, the design element (table, RLS policy, or component).

---

## Tasks

## Milestone 1: Foundation

Scope: initialise React/TypeScript/Vite/Tailwind CSS; establish environment configuration;
create Supabase migrations and seed data; configure administrator authentication; configure Row
Level Security; build event creation and event-status management.

- [x] 1. Scaffold the React + TypeScript + Vite project and developer tooling
  - [x] 1.1 Initialise the Vite React + TypeScript SPA and base project structure
    - Create a Vite React-TS project at the repo root with `src/` split into `routes/`,
      `components/`, `lib/`, and `schemas/`; add `tsconfig` with strict mode
    - Add npm scripts (`dev`, `build`, `preview`, `test`, `lint`, `format`) to `package.json`
    - _Requirements: 25.1, 25.4_
    - _Design: Technology Stack and Dependencies (React 18, Vite, TypeScript); Frontend Design (Route map)_

  - [x] 1.2 Add Tailwind CSS and base mobile-first design tokens
    - Configure `tailwind.config` and PostCSS; add a global stylesheet with contrast/focus
      tokens and a mobile-first container
    - _Requirements: 24.1, 24.3, 24.9_
    - _Design: Technology Stack (Tailwind CSS); Mobile-first & accessibility approach_

  - [x] 1.3 Add React Router and define the top-level route skeleton with role layouts
    - Install React Router; create `Public`, `Audience`, `Admin`, and `Presenter` layout
      wrappers and register placeholder routes (`/`, `/join/:eventRef`, `/e/:eventRef`,
      `/admin/login`, `/admin`, `/admin/events/:id`, `/present/:eventRef`)
    - _Requirements: 25.1, 25.4, 25.5_
    - _Design: Frontend Design (Route map)_

  - [x] 1.4 Configure ESLint + Prettier
    - Add ESLint (TypeScript + React rules) and Prettier config; wire `lint`/`format` scripts
    - _Requirements: 26.3_
    - _Design: Technology Stack (Lint / format)_

  - [x] 1.5 Configure Vitest and fast-check
    - Add Vitest with a jsdom environment and a test setup file; add fast-check as a dev
      dependency; add a trivial passing smoke test to prove the runner and coverage reporter work
    - _Requirements: 26.1, 26.3_
    - _Design: Technology Stack (Vitest, fast-check); Testing Strategy_

- [x] 2. Establish environment configuration and `.env.example`
  - [x] 2.1 Create typed environment configuration and `.env.example` (names only)
    - Add a `.env.example` containing variable NAMES ONLY with no secret values:
      `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only),
      `AI_CREDENTIAL_ENCRYPTION_KEY` (server-only), `AI_ENDPOINT_ALLOWLIST` (server-only),
      `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
    - Add a small client-side env loader that reads only `VITE_`-prefixed variables and throws
      if a server-only secret name is ever referenced from client code
    - Ensure `.env*` (except `.env.example`) is git-ignored so no secrets are committed
    - _Requirements: 21.8_
    - _Design: Deployment and Environment (Environment variables)_

  - [x]* 2.2 Write a unit test asserting no server-only secret is referenced in client code
    - Assert the client env loader exposes only `VITE_`-prefixed variables and rejects
      `SUPABASE_SERVICE_ROLE_KEY` / `AI_CREDENTIAL_ENCRYPTION_KEY` / `AI_ENDPOINT_ALLOWLIST`
    - _Requirements: 21.8_
    - _Design: Deployment and Environment_

- [x] 3. Set up Supabase project structure and client wiring
  - [x] 3.1 Initialise Supabase local dev / migrations directory
    - Create the `supabase/` project structure with a `migrations/` folder and a `seed.sql`
      placeholder, and a `functions/` folder for Edge Functions
    - _Requirements: 21.1_
    - _Design: Architecture (Supabase managed services); Migrations and seed data_

  - [x] 3.2 Wire the Supabase browser client (anon key only)
    - Create `lib/supabaseClient.ts` using `@supabase/supabase-js` with the anon key from
      `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`; never reference the service role key here
    - _Requirements: 21.8_
    - _Design: Architecture (React SPA talks to Supabase with anon key); Component responsibilities_

  - [x] 3.3 Create a shared server-side Supabase client helper for Edge Functions (service role)
    - Add an Edge-Function-only helper that constructs a service-role client from
      `SUPABASE_SERVICE_ROLE_KEY`; document that this module must never be imported by the SPA
    - _Requirements: 21.6, 21.8_
    - _Design: Architecture (Edge Functions use service role); Component responsibilities_

- [x] 4. Create the initial database migration (enums + foundation tables)
  - [x] 4.1 Create enumerated types needed for Milestone 1
    - Migration creates `event_status ('draft','live','ended','archived')`,
      `moderation_mode ('pre','post')`, and `presenter_mode ('join','featured_question',
      'top_questions','poll_results','word_cloud','ai_themes','waiting')`
    - _Requirements: 1.5, 3.6, 3.7, 7.4_
    - _Design: Data Models (Enumerated types)_

  - [x] 4.2 Create the `events` table with columns, keys, and CHECK constraints
    - Columns per design: `id`, `name` (CHECK char_length 1–100), `description`
      (CHECK char_length ≤500, nullable), `slug` (citext, nullable, format `[A-Za-z0-9-]` 1–64),
      `status` (default `'draft'`), `moderation_mode` (default `'pre'`), `starts_at`, `ends_at`
      (CHECK `ends_at > starts_at`), `presenter_token` (NOT NULL, CHECK ≥32 alphanumeric),
      `active_presenter_mode` (default `'join'`), `brand_colour`, `logo_path`, `stop_words`
      (default `'{}'`), `created_at`, `updated_at`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.6, 3.8, 7.3, 7.4, 21.19, 22.5, 22.6_
    - _Design: Data Models (`events` table)_

  - [x] 4.3 Add required indexes and uniqueness constraints on `events`
    - PK on `id`; UNIQUE on `slug`; UNIQUE on `presenter_token`; `idx_events_status` on `status`
    - _Requirements: 1.3, 1.4, 7.3, 23.3_
    - _Design: Data Models (`events` indexes)_

  - [x] 4.4 Create the `admin_profiles` table linked to `auth.users`
    - Columns: `id` (PK, FK → `auth.users(id)` ON DELETE CASCADE), `display_name`, `created_at`
    - _Requirements: 10.1, 10.3, 21.19_
    - _Design: Data Models (`admin_profiles`)_

  - [x] 4.5 Create the `audit_log` table
    - Columns: `id` (PK), `change_type` (NOT NULL; e.g. `event_status`, `moderation`,
      `ai_endpoint`, `credential_rotation`), `event_id` (nullable FK → `events(id)`),
      `occurred_at` (default `now()`, UTC)
    - _Requirements: 21.19_
    - _Design: Data Models (`audit_log`)_
    - Note: full schema for questions/votes/polls/word-cloud/AI tables is deferred to Milestones
      2–4; this migration creates only the foundation tables above. Later milestones add their
      own tables.

  - [x] 4.6 Create the `event_is_live(event_id)` SQL helper predicate
    - Add a SQL function returning true when the parent event's `status = 'live'`, for reuse by
      anonymous RLS policies in this and later milestones
    - _Requirements: 1.7, 21.5_
    - _Design: RLS Design (General policy strategy — `event_is_live` helper)_

  - [x]* 4.7 Write a migration/schema unit test that builds the schema from scratch
    - Apply migrations to a fresh test database; assert enums exist, `events`/`admin_profiles`/
      `audit_log` exist with the expected columns, and the CHECK constraints reject an event
      whose name is empty/>100 chars, whose `ends_at <= starts_at`, or whose `presenter_token`
      is <32 chars
    - _Requirements: 1.1, 1.2, 7.3, 22.5, 26.1_
    - _Design: Data Models; Migrations and seed data_

- [x] 5. Configure Row Level Security for the foundation tables
  - [x] 5.1 Enable RLS and add read policies for `events`
    - Enable RLS on `events` (default deny); add anonymous `SELECT` policy allowed ONLY WHERE
      `status = 'live'`; add authenticated `SELECT` policy for all events; add NO client
      insert/update/delete policy (mutations occur via Edge Function/service role)
    - _Requirements: 1.6, 1.9, 10.1, 21.3, 21.4, 21.5, 21.6_
    - _Design: RLS Design (`events` per-table policies)_

  - [x] 5.2 Enable RLS on `admin_profiles` and `audit_log`
    - Enable RLS (default deny); authenticated `SELECT` scoped to the owner/admin scope; no
      anonymous access; writes only via service role
    - _Requirements: 10.1, 21.3, 21.4, 21.6_
    - _Design: RLS Design (`admin_profiles`, `audit_log`)_

  - [x]* 5.3 Write RLS tests for event visibility (anonymous)
    - Using the anon client, assert anonymous `SELECT` returns a `live` event but returns NO
      rows for `draft`, `ended`, or `archived` events
    - _Requirements: 1.6, 1.9, 21.4, 21.5, 26.1_
    - _Design: RLS Design (`events`)_

  - [x]* 5.4 Write RLS tests for event mutation denial (anonymous)
    - Assert anonymous `INSERT`/`UPDATE`/`DELETE` on `events` is rejected with an authorization
      failure and no row is created or changed
    - _Requirements: 10.5, 21.4, 21.6, 26.1_
    - _Design: RLS Design (`events` — no anonymous/client mutation policy)_

- [x] 6. Configure administrator authentication (Supabase Auth, admin-only)
  - [x] 6.1 Implement the admin auth client and session helpers
    - Add sign-in / sign-out / `getSession` helpers over Supabase Auth; on first sign-in ensure
      a matching `admin_profiles` row exists (linked to `auth.users`)
    - _Requirements: 10.1, 10.2, 10.3_
    - _Design: Frontend Design (Protected-route strategy); Data Models (`admin_profiles`)_

  - [x] 6.2 Build the `/admin/login` route and login form
    - Implement an accessible login form (labelled fields, loading/success/error states) that
      authenticates via the auth client and redirects to `/admin` on success
    - _Requirements: 24.5, 24.7, 25.4, 25.8_
    - _Design: Frontend Design (Route map — `/admin/login`)_

  - [x] 6.3 Implement the `RequireAuth` protected-route wrapper
    - Wrap all `/admin/*` routes except `/admin/login`; redirect unauthenticated users to
      `/admin/login` and render none of the protected content; allow all admin routes while
      authenticated
    - _Requirements: 10.1, 25.8, 25.9_
    - _Design: Frontend Design (Protected-route strategy — `RequireAuth`)_

  - [x]* 6.4 Write unit tests for `RequireAuth` and administrator authorisation
    - Assert an unauthenticated session is redirected and renders nothing; assert an
      authenticated session renders the protected route; assert admin-only intent is enforced
    - _Requirements: 10.1, 10.2, 25.8, 25.9, 26.1_
    - _Design: Frontend Design (Protected-route strategy)_

- [x] 7. Implement event creation and event-status management (authenticated Edge Function)
  - [x] 7.1 Define shared Zod schemas for event create/edit input
    - Add Zod schemas (shared by client and Edge Function) validating: name 1–100 (Unicode code
      points), optional description ≤500, optional slug format `[A-Za-z0-9-]` 1–64,
      `ends_at > starts_at`
    - _Requirements: 1.1, 1.2, 1.3, 22.5, 22.6_
    - _Design: Error Handling (Validation errors — shared Zod schemas)_

  - [x] 7.2 Implement the authenticated event-create Edge Function
    - Verify admin JWT (service role); validate input via the shared schema; on success generate
      event `id`, audience URL, presenter URL + a `presenter_token` (≥32 alphanumeric chars), and
      QR code data resolving to the audience URL; set `status` default `draft`; reject with a
      per-field validation message on invalid input (retaining no partial event); reject a
      duplicate slug identifying the conflict
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.3, 10.1, 21.6, 21.19_
    - _Design: Architecture (privileged mutation Edge Functions); Data Models (`events`)_

  - [x] 7.3 Implement the event-status transition Edge Function
    - Enforce transitions `draft → live → ended → archived`; on `ended` close question
      submission, voting, poll responses, and word-cloud responses for the event; on `archived`
      prevent modification; reject reactivating an archived event with the V1 message; write an
      `audit_log` entry (`change_type='event_status'`, UTC timestamp) for each transition
    - _Requirements: 1.5, 1.8, 1.9, 1.10, 1.11, 21.19_
    - _Design: Architecture; Data Models (`events`, `audit_log`); Error Handling_

  - [x]* 7.4 Write unit tests for event validation and status-transition rules
    - Positive + negative tests: name 1–100 boundaries, `ends_at > starts_at`, description ≤500,
      slug format + duplicate-slug rejection; valid transitions accepted, invalid transitions
      (e.g. `ended → live`, reactivating `archived`) rejected; `ended` closes participation
    - _Requirements: 1.1, 1.2, 1.4, 1.8, 1.10, 1.11, 26.1_
    - _Design: Data Models; Error Handling_

  - [x]* 7.5 Write a property-based test for event-status gating groundwork (Property 11)
    - **Property 11: Event-status gating of participation**
    - **Validates: Requirements 1.6, 1.7, 1.9, 2.8**
    - Generate events with random statuses; via the RLS-backed anonymous read path assert an
      event is participation-eligible (visible) **iff** its status is `live`, rejected/withheld
      otherwise (participation-write actions themselves are exercised in Milestone 2)
    - _Design: Correctness Properties (Property 11); RLS Design (`events`)_

- [x] 8. Build the minimal admin event UI and QR display
  - [x] 8.1 Build the event create/edit form (event editor route)
    - Implement `/admin/events/:id` editor calling the event-create/edit Edge Function; wire the
      four UX states (empty, loading, success, error) and inline per-field validation error
      states that retain entered values
    - _Requirements: 1.1, 1.2, 1.3, 24.7, 25.4_
    - _Design: Components and Interfaces (event editor); Error Handling (Validation errors)_

  - [x] 8.2 Build the status-transition control
    - Add controls to move an event through `draft → live → ended → archived` via the transition
      Edge Function, disabling illegal transitions and surfacing rejection messages
    - _Requirements: 1.8, 1.9, 1.11, 24.7_
    - _Design: Components and Interfaces; Error Handling_

  - [x] 8.3 Implement the `QrDisplay` component
    - Render an SVG QR code (via `qrcode`) resolving to the event's audience URL, with a
      non-empty accessible name; reused by the join screen and later the presenter join mode
    - _Requirements: 1.1, 24.5_
    - _Design: Components and Interfaces (`QrDisplay`); Technology Stack (qrcode)_

- [x] 9. Create Milestone 1 seed data
  - [x] 9.1 Add seed data for a demo event
    - Seed a `draft` "MSS AI Demo Day 2026" event with `moderation_mode='pre'` and a generated
      presenter token, so the foundation flow can be exercised end-to-end without AI configured
    - _Requirements: 3.8_
    - _Design: Migrations and seed data_

- [x] 10. Milestone 1 checkpoint — verify foundation completeness
  - [x] 10.1 Verify the Milestone 1 definition of done
    - Confirm migrations build the schema from scratch on a fresh database; confirm RLS is
      enabled and the event visibility + mutation-denial tests pass; confirm no secrets appear
      in the frontend bundle or in `.env.example`; confirm an authenticated admin can create an
      event that yields a working audience URL + QR code + presenter token before proceeding to
      Milestone 2. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 1.1, 7.3, 21.3, 21.8, 26.3_
    - _Design: Migrations and seed data; RLS Design; Deployment and Environment_

---

## Milestone 2: Core Live Q&A

Scope: audience joining + anonymous participant identity (localStorage with ≥128-bit entropy
and session-scoped fallback); question submission with 1–300 char validation and server-side
rate limiting; pre/post moderation modes and the moderation queue; question voting with a DB
unique constraint on `(participant_identifier, question_id)` and atomic vote-count
maintenance; scoped Realtime updates within 2 s (with a Broadcast fan-out path for
high-frequency votes); and a basic presenter question view. Adds the `questions` and
`question_votes` tables plus their RLS policies, and the server-side submit/vote RPCs with
rate limiting.

Primary requirements: **Req 2, 3, 4, 23** (participant identity, Q&A submission/moderation,
voting/uniqueness, realtime/performance/reliability), plus the anonymous submit/vote
rate-limit groundwork from **Req 21.13–21.15** and input rules from **Req 21.9–21.12, 22.1**.

Correctness properties implemented here: Properties 1, 2, 3 (voting), 10 (moderation
visibility), and the participation-write portion of Property 11.

**Implementation note (Realtime for high-frequency votes):** the vote RPC updates the cached
`vote_count` in PostgreSQL atomically and fans out updates via Supabase Realtime Broadcast (or
an optimized/throttled aggregate broadcast) rather than relying solely on per-row CDC, to
avoid replication lag under peak voting while keeping the 2-second delivery target. See design
Decision D9 and the Voting flow. _Requirements: 4.1, 4.7, 23.1, 23.2_.

- [x] 11. Add the Q&A data model (questions + question_votes migrations)
  - [x] 11.1 Add the `question_status` enum and the `questions` table migration
    - Create migration `20260101000009_questions.sql` (timestamp sorts AFTER
      `20260101000008_admin_audit_rls.sql`); add enum
      `question_status ('pending','approved','featured','answered','hidden')`; create the
      `questions` table with `id` (uuid PK), `event_id` (uuid NOT NULL, FK → `events(id)`
      ON DELETE CASCADE), `text` (NOT NULL, CHECK `char_length` 1–300), `status`
      (`question_status`, NOT NULL, default set per moderation mode via the submit RPC/trigger),
      `vote_count` (integer NOT NULL default 0, CHECK ≥0), `ai_category` (text NULL),
      `ai_category_confidence` (numeric(3,2) NULL), `ai_prior_category` (text NULL),
      `cluster_id` (uuid NULL — **decision:** `question_clusters` is a Milestone-4 table, so
      for M2 declare `cluster_id` as a plain nullable `uuid` with NO FK yet and document that
      the `FK → question_clusters(id) ON DELETE SET NULL` is deferred to the M4 clusters
      migration), `submission_key` (text NULL), `created_at`/`updated_at` (timestamptz NOT
      NULL default `now()`); attach the existing `set_updated_at()` trigger to `questions`
    - _Requirements: 3.4, 3.5, 22.1, 21.18, 23.8_
    - _Design: Data Models (`questions` table; Enumerated types); Decision on deferred cluster FK_

  - [x] 11.2 Add the `questions` indexes and the idempotency uniqueness constraint
    - In the same migration add: PK on `id`; `idx_questions_event` on `event_id`;
      `idx_questions_status` on `(event_id, status)`; `idx_questions_created` on
      `(event_id, created_at)`; `idx_questions_votes` on `(event_id, vote_count DESC)`; and a
      partial UNIQUE `(event_id, submission_key)` WHERE `submission_key IS NOT NULL` for
      write idempotency
    - _Requirements: 23.3, 23.8_
    - _Design: Data Models (`questions` indexes)_

  - [x] 11.3 Add the `question_votes` table migration
    - Create migration `20260101000010_question_votes.sql`; create `question_votes` with `id`
      (uuid PK), `question_id` (uuid NOT NULL, FK → `questions(id)` ON DELETE CASCADE),
      `event_id` (uuid NOT NULL, FK → `events(id)` ON DELETE CASCADE), `participant_identifier`
      (text NOT NULL, opaque — no personal data), `created_at` (timestamptz NOT NULL default
      `now()`); add **UNIQUE `(participant_identifier, question_id)`** (the DB-level
      one-vote-per-participant-per-question rule) and `idx_votes_question` on `question_id`
    - _Requirements: 4.3, 2.5, 23.3, 21.18_
    - _Design: Data Models (`question_votes` table); DB-layer uniqueness_

  - [x]* 11.4 Extend the from-scratch schema/migration static guard for the Q&A tables
    - Extend the Milestone-1 static migration test (mirroring `src/db/migrations.test.ts`) to
      assert the new migrations define the `question_status` enum values, create `questions`
      with the required columns + `char_length` 1–300 and `vote_count ≥0` CHECKs + the five
      indexes + the partial unique `(event_id, submission_key)`, create `question_votes` with
      the `UNIQUE (participant_identifier, question_id)` constraint and CASCADE FKs, and that
      the file names sort after `…000008` so the schema still builds from a fresh database
    - _Requirements: 3.4, 4.3, 22.1, 23.3, 26.1_
    - _Design: Data Models; Migrations and seed data_

- [x] 12. Configure RLS for questions and question_votes
  - [x] 12.1 Enable RLS and add read/moderation policies for `questions`
    - Create migration `20260101000011_questions_rls.sql`; enable RLS (default deny); add an
      anonymous `SELECT` policy allowed WHERE `event_is_live(event_id)` AND
      `status IN ('approved','featured')` (so `pending`/`hidden` are NEVER returned to anon —
      audience and presenter read via this anon-equivalent path); add an authenticated `SELECT`
      policy returning all questions for admins (including `pending`/`hidden`) and allowing
      moderation `UPDATE`s for their events; add NO direct anonymous `INSERT` policy — anonymous
      submission is routed through the rate-limited submit RPC/Edge Function (task 13.2)
    - _Requirements: 3.9, 3.10, 7.9, 21.3, 21.4, 21.5, 3.11, 3.12_
    - _Design: RLS Design (`questions` per-table policies)_

  - [x] 12.2 Enable RLS and add vote policies for `question_votes`
    - In a migration `20260101000012_question_votes_rls.sql`, enable RLS (default deny); allow
      anonymous `INSERT`/`DELETE` ONLY for questions in an eligible status (`approved`/
      `featured`) on a live event (the vote RPC performs the atomic count change; the unique
      constraint enforces one vote); add NO anonymous `SELECT` of raw vote rows (counts are read
      from `questions.vote_count`), ensuring `participant_identifier` is never exposed to clients
    - _Requirements: 4.2, 4.3, 4.4, 4.8, 8.6, 21.3, 21.4, 21.5_
    - _Design: RLS Design (`question_votes` per-table policies)_

  - [x]* 12.3 Write env-gated RLS integration tests for questions + votes
    - Mirroring `src/db/rls.events.test.ts` (skip cleanly without `TEST_SUPABASE_*`): assert
      anon `SELECT` on `questions` returns `approved`/`featured` for a live event but NEVER
      `pending`/`hidden` and returns nothing for a non-live event; assert anon cannot `SELECT`
      raw `question_votes` rows; assert a duplicate vote insert is rejected by the unique
      constraint
    - _Requirements: 3.9, 3.10, 4.3, 4.4, 8.6, 26.1_
    - _Design: RLS Design (`questions`, `question_votes`)_

- [x] 13. Implement server-side submit, vote, and rate-limiting RPCs
  - [x] 13.1 Add the rate-limiting groundwork (rate_events + limit helper)
    - Create migration `20260101000013_rate_limiting.sql` with a short-lived `rate_events`
      table (or KV-style structure) keyed by `participant_identifier` + coarse client
      fingerprint + action type, and a `SECURITY DEFINER` helper enforcing configurable limits
      (defaults **10 submissions / 60 s**, **30 votes / 60 s**); on exceed it returns a
      rate-limit-exceeded signal and records nothing. This is shared groundwork used by the
      submit and vote RPCs
    - _Requirements: 21.13, 21.14, 21.15_
    - _Design: RLS Design (Server-side rate limiting)_

  - [x] 13.2 Implement the question-submit RPC / Edge Function
    - Add a `SECURITY DEFINER` submit RPC (or Edge Function) that: enforces the rate limit
      (13.1); validates length 1–300 Unicode code points and sanitises/allow-lists input,
      rejecting the whole submission on failure (Req 21.9–21.12, 22.1); rejects submission when
      the event is not live (Req 3.3); sets `status` to `pending` (pre) or `approved` (post) per
      `event.moderation_mode` (Req 3.6, 3.7); and de-duplicates on `submission_key` so a retried
      write is idempotent (Req 23.8). Returns the created/idempotent question
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7, 22.1, 21.9, 21.10, 21.11, 21.12, 21.13, 23.8_
    - _Design: Request/data flows (Question submit + moderation); RLS Design (rate limiting)_

  - [x] 13.3 Implement the atomic cast/remove vote RPC
    - Add a `SECURITY DEFINER` vote RPC that atomically inserts into `question_votes` and
      increments `questions.vote_count` (cast), or deletes the row and decrements (remove);
      rejects votes on `pending`/`hidden` or non-live events leaving the count unchanged
      (Req 4.1, 4.5, 4.8); relies on the unique constraint to reject a duplicate vote leaving
      the count unchanged (Req 4.4); a remove with no existing vote is a no-op on the count
      (Req 4.6); enforces the vote rate limit (13.1) and accepts an idempotency key (Req 23.8)
    - _Requirements: 4.1, 4.4, 4.5, 4.6, 4.8, 21.14, 23.8_
    - _Design: Request/data flows (Voting with realtime propagation); DB-layer uniqueness_

  - [x] 13.4 Implement and document the vote-count Realtime Broadcast fan-out (Decision D9)
    - Broadcast the updated `vote_count` from the vote RPC (or a lightweight trigger/channel)
      via Supabase Realtime Broadcast (or an optimized/throttled aggregate broadcast) rather
      than relying solely on per-row CDC, keeping delivery within the 2-second target under
      peak voting; document the channel naming and payload shape (event-scoped, no
      `participant_identifier`)
    - _Requirements: 4.7, 23.1, 23.2_
    - _Design: Decision D9; Request/data flows (Voting)_

  - [x]* 13.5 Write unit tests for submit + vote RPC logic and rate limiting
    - Test moderation-mode status defaulting (pre → `pending`, post → `approved`); length 1–300
      boundaries + sanitisation rejection; submit rejected when event not live; `submission_key`
      idempotency (retry returns the same row, no duplicate); vote cast/remove increments/
      decrements; duplicate vote rejected leaving count unchanged; vote rejected on
      `pending`/`hidden`/non-live; remove-with-no-vote no-op; rate-limit thresholds (10/60s
      submissions, 30/60s votes) reject on exceed
    - _Requirements: 3.3, 3.6, 3.7, 4.4, 4.6, 4.8, 21.13, 21.14, 21.15, 22.1, 26.1_
    - _Design: Request/data flows; RLS Design (rate limiting)_

  - [x]* 13.6 Write property tests for voting invariants (Properties 1, 2, 3)
    - **Property 1: One active vote per participant per question** — random vote/duplicate
      sequences; assert ≤1 vote row per `(participant, question)` and duplicate rejected with
      `vote_count` unchanged. **Validates: Requirements 4.2, 4.3, 4.4**
    - **Property 2: Vote add/remove round trip preserves count** — add-then-remove restores the
      original count; remove-with-no-vote is a no-op. **Validates: Requirements 4.1, 4.5, 4.6**
    - **Property 3: Vote eligibility by status** — a vote succeeds iff status ∈ {approved,
      featured}; otherwise rejected with count unchanged. **Validates: Requirements 4.1, 4.8**
    - Tag each `Feature: mss-livepulse, Property N: ...`; drive the data-access layer / an
      in-memory model where a live DB is unavailable (env-gated where needed)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 26.1_
    - _Design: Correctness Properties (Properties 1, 2, 3)_

- [x] 14. Implement anonymous participant identity and audience joining (Req 2)
  - [x] 14.1 Implement the participant-identifier module
    - Add `src/lib/participant.ts` generating a ≥128-bit random identifier via
      `crypto.getRandomValues` under a namespaced `localStorage` key on first entry; reuse the
      stored identifier on re-entry; fall back to a session-scoped identifier (in-memory /
      `sessionStorage`) if `localStorage` is unavailable or a write fails; the identifier
      carries no personal data and is never rendered in the UI
    - _Requirements: 2.3, 2.4, 2.5, 2.7, 8.6, 24.8_
    - _Design: Frontend Design (Participant identity handling)_

  - [x]* 14.2 Write unit tests for participant-identifier generation/reuse/fallback
    - Assert ≥128-bit entropy on first generation; reuse of the stored value on re-entry; a
      new value is NOT generated when one already exists; session-scoped fallback when
      `localStorage` throws; and that the value is never surfaced through a UI-facing accessor
    - _Requirements: 2.3, 2.4, 2.7, 8.6, 26.1_
    - _Design: Frontend Design (Participant identity handling)_

  - [x] 14.3 Implement the landing event-code entry and join resolution
    - Build the `/` landing event-code entry and the `/join/:eventRef` flow using an
      `EventJoinCard`: resolve the event by slug/URL/QR; on an unknown code reject the join,
      show an "Event_Code is invalid" error, and keep the participant on the landing page
    - _Requirements: 2.1, 2.2_
    - _Design: Frontend Design (Route map — `/`, `/join/:eventRef`); Components (`EventJoinCard`)_

  - [x] 14.4 Implement the audience event view and participation gating
    - Build `/e/:eventRef` showing event name, status, current active interaction, and
      navigation to the Q&A / poll / word-cloud views within 3 s; when the event is not live,
      display the status and withhold all participation controls using the existing
      `participationGate` lib
    - _Requirements: 2.6, 2.8, 1.9_
    - _Design: Frontend Design (Route map — `/e/:eventRef`); Request/data flows (Audience join)_

- [x] 15. Implement the audience Live Q&A + voting UI (Req 3, 4)
  - [x] 15.1 Implement `QuestionSubmissionForm`
    - Build a validated 1–300 char question input that calls the submit RPC (task 13.2), shows
      the four UX states, retains entered text on a validation error identifying the 1–300 char
      constraint, and shows a success confirmation within 2 s of a successful submission
    - _Requirements: 3.1, 3.2, 3.13, 22.1, 24.7_
    - _Design: Components (`QuestionSubmissionForm`); Request/data flows (Question submit)_

  - [x] 15.2 Implement `QuestionListAndVoting`
    - List `approved`/`featured` questions with a sort control (most votes desc / most recent
      desc); render an upvote/remove control that calls the vote RPC (task 13.3) enforcing one
      active vote per participant per question; never render `participant_identifier`
    - _Requirements: 3.9, 3.11, 4.1, 4.5, 8.6_
    - _Design: Components (`QuestionListAndVoting`); Request/data flows (Voting)_

  - [x] 15.3 Implement the `useRealtimeChannel` hook and `ConnectionStatusIndicator`
    - Add a `useRealtimeChannel` hook subscribing ONLY to `questions` + vote-count updates
      (via the CDC/Broadcast path from 13.4) scoped by `event_id` (never the full dataset);
      show a reconnecting indicator + enabled manual-refresh control after >3 s interruption;
      retry safe reads with exponential backoff starting at 1 s doubling to a 30 s cap for max
      5 attempts, then stop with an error state; add a `ConnectionStatusIndicator` component
    - _Requirements: 23.2, 23.5, 23.6, 23.7, 4.7, 23.1_
    - _Design: Frontend Design (Realtime subscription strategy & reconnect UX); Components
      (`ConnectionStatusIndicator`)_

  - [x]* 15.4 Write unit tests for the realtime hook and Q&A voting UI
    - Test reconnect indicator appears after >3 s; backoff sequence 1→2→4→…→30 s capped, max 5
      attempts, then error state with manual refresh enabled; question sort ordering (votes vs
      recent); upvote toggles the vote RPC call and one-active-vote behaviour; no
      `participant_identifier` reaches the DOM
    - _Requirements: 3.11, 4.1, 4.5, 8.6, 23.5, 23.6, 23.7, 26.1_
    - _Design: Frontend Design (Realtime subscription strategy); Components_

- [x] 16. Implement the admin moderation queue (Req 3.11, 3.12)
  - [x] 16.1 Implement the authenticated moderation-mutation Edge Function / RPC
    - Add an admin-only (service role, JWT-verified) function to approve/feature/answer/hide a
      question for the admin's own event; each moderation change writes an `audit_log` entry
      with `change_type='moderation'` (UTC timestamp); anonymous callers are denied
    - _Requirements: 3.11, 3.12, 10.1, 21.6, 21.19_
    - _Design: Architecture (privileged mutation Edge Functions); Data Models (`audit_log`)_

  - [x] 16.2 Build the `ModerationQueue` route and component
    - Build `/admin/events/:id/moderation` listing questions (including `pending`/`hidden` via
      the authenticated read path) with status / AI-category / search-text filters (all
      selected criteria combined, case-insensitive search) and approve/feature/answer/hide
      actions calling the mutation from 16.1
    - _Requirements: 3.11, 3.12, 24.7, 25.4_
    - _Design: Frontend Design (Route map — `/admin/events/:id/moderation`); Components
      (`ModerationQueue`)_

  - [x]* 16.3 Write unit tests for moderation authorisation and filtering
    - Assert anonymous/unauthenticated moderation attempts are denied with no state change
      (Req 10.5); assert the filter combines status + category + case-insensitive search text;
      assert each moderation action requests an `audit_log` `change_type='moderation'` entry
    - _Requirements: 3.11, 3.12, 10.5, 21.19, 26.1_
    - _Design: Components (`ModerationQueue`); RLS Design_

- [x] 17. Implement the basic presenter question view (Req 7 subset for M2)
  - [x] 17.1 Build the basic presenter question modes
    - Extend `/present/:eventRef` (token- or session-scoped read path) with the join screen
      (QR + Event_Code), featured-question, and top-questions modes needed for the Q&A demo;
      exclude `pending`/`hidden` questions from every mode; update via realtime within 2 s and
      retain last content with an interruption indicator on connection loss (poll/word-cloud/
      AI presenter modes are Milestone 3+)
    - _Requirements: 7.9, 7.6, 7.7, 7.5, 7.10_
    - _Design: Request/data flows (Presenter mode switching); Frontend Design (Route map —
      `/present/:eventRef`)_

  - [x]* 17.2 Write property + unit tests for presenter/audience moderation visibility (Property 10)
    - **Property 10: Moderation visibility invariant** — generate questions across all statuses;
      compute audience and presenter visible sets via the RLS-backed read path; assert neither
      set contains any `pending`/`hidden` question (only `approved`/`featured`, and `answered`
      where shown). Tag `Feature: mss-livepulse, Property 10: ...`.
      **Validates: Requirements 3.9, 3.10, 7.9**
    - _Requirements: 3.9, 3.10, 7.9, 26.1_
    - _Design: Correctness Properties (Property 10); RLS Design (`questions`)_

  - [x]* 17.3 Write a property test for the participation-write portion of Property 11
    - **Property 11: Event-status gating of participation** — generate events across all
      statuses; attempt each participation WRITE (question submit, vote) via the submit/vote
      RPC path; assert acceptance iff the event status is `live`, rejection otherwise
      (completing the write half of the M1 read-gating groundwork in task 7.5). Tag
      `Feature: mss-livepulse, Property 11: ...`. **Validates: Requirements 1.6, 1.7, 1.9, 2.8**
    - _Requirements: 1.7, 1.9, 2.8, 3.3, 4.8, 26.1_
    - _Design: Correctness Properties (Property 11); RLS Design (`events`, `questions`)_

- [x] 18. Milestone 2 checkpoint — verify Core Live Q&A completeness
  - [x] 18.1 Verify the Milestone 2 definition of done
    - Confirm the questions/question_votes migrations + RLS build from a fresh database (static
      guard extended); confirm RLS hides `pending`/`hidden` from anon/presenter and denies raw
      vote-row reads (tests); confirm duplicate votes are prevented by the DB unique constraint;
      confirm the vote-count realtime/Broadcast path delivers updates; confirm moderation
      visibility and the submit/vote rate limits; and confirm `npm run build`, `npm test`,
      `npm run lint`, and `npm run typecheck:test` all pass before proceeding to Milestone 3.
      Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 3.9, 3.10, 4.3, 4.7, 21.3, 21.13, 21.14, 23.1, 26.3_
    - _Design: Migrations and seed data; RLS Design; Correctness Properties; Decision D9_

---

## Milestone 3: Polls and Word Cloud (placeholder — to be expanded when this milestone begins)

- [~] 19. Milestone 3: Polls and Word Cloud — expand into detailed tasks when the milestone begins
  - Scope: poll admin (create/open/close, 2–10 options, single-open-poll partial unique index),
    poll responses with `(participant_identifier, poll_id)` uniqueness and upsert-replace, and
    visibility-aware results; word-cloud prompt creation, single-open-prompt enforcement,
    response normalisation, hidden-entry moderation, stop-word exclusion, and monotonic-size
    visualisation; and presenter display modes. Adds `polls`, `poll_options`, `poll_responses`,
    `word_cloud_prompts`, `word_cloud_responses` tables with RLS policies and RPCs.
  - Primary requirements: **Req 5, 6, 7** (polls, word cloud, presenter modes).
  - Correctness properties to implement here: Properties 4, 5 (polls), 6, 7, 8, 9 (word cloud),
    and the remaining presenter-visibility portion of Property 10.
  - _Requirements: 5, 6, 7_

---

## Milestone 4: AI Features (placeholder — to be expanded when this milestone begins)

- [~] 20. Milestone 4: AI Features — expand into detailed tasks when the milestone begins
  - Scope: the single server-side AI Gateway Edge Function; write-only credential storage
    (managed secret reference preferred, AEAD fallback, XOR rule); endpoint allowlist / SSRF
    protection; connection test; OpenAI-compatible adapter + custom-adapter extension point;
    server-side structured-output (Zod) validation with bounded retries; question categorisation
    (fixed 8 categories); prompt-based clustering; grounded theme insights; and the Markdown
    end-of-event summary. Adds `ai_provider_settings` and `ai_jobs` tables with their RLS rules.
  - Primary requirements: **Req 11–20** (AI config, credential protection, SSRF, structured
    output, categorisation, clustering, theme insights, summary, failure/degraded mode, privacy).
  - Correctness properties to implement here: Properties 12, 13 (credentials), 14 (schema
    validation), 15 (AI failure never blocks core flow), 16 (SSRF allowlist), 17 (categorisation
    preserves text), 18 (cluster vote total), 19 (payloads exclude identifiers).
  - Note: any `ai_provider_settings` credential-schema groundwork touched earlier must uphold
    Properties 12/13 (no credential in read APIs/logs; XOR storage).
  - Implementation note (Deno SSRF & TLS): the AI Gateway SSRF resolution + allowlist check must validate the resolved destination IP for the allow/deny decision WITHOUT breaking HTTPS SNI or TLS certificate verification — the outbound fetch connects using the original hostname (respecting tls_verify_required), pinning the validated IP to the connection to close the DNS-rebinding gap. See design 'SSRF protection'. _Requirements: 13.7, 13.8, 13.12_.
  - Implementation note (AI enabled vs. credential check): server-side business logic must validate that when ai_enabled = true and auth_type != 'none', a valid secret_reference or encrypted_credential is present; if neither is present, treat AI as effectively unconfigured and return the degraded 'AI unavailable' state instead of making an unauthenticated call, and surface in the UI that a credential is required. See design 'AI enablement precondition'. _Requirements: 11.1, 11.9, 12.3, 12.5, 12.6, 19.1_.
  - _Requirements: 11, 12, 13, 14, 15, 16, 17, 18, 19, 20_

---

## Milestone 5: Export, Hardening, and Event Readiness (placeholder — to be expanded when this milestone begins)

- [~] 21. Milestone 5: Export, Hardening, Event Readiness — expand into detailed tasks when the milestone begins
  - Scope: CSV exports (questions, polls, word cloud) and the Markdown end-of-event summary
    (calculated-data vs AI-interpretation separation); analytics dashboard; input
    validation/sanitisation, server-side rate limiting, and consistent error handling;
    the full automated test suite (Vitest + fast-check) and eight Playwright E2E flows;
    accessibility checks; k6 load tests (P50/P95/error-rate at 500 VUs); and deployment/rollback
    and moderator-guide documentation.
  - Primary requirements: **Req 8, 9, 18, 21, 24, 26** (analytics, export, summary, security/RLS/
    governance, accessibility/UX, testing/load validation).
  - _Requirements: 8, 9, 18, 21, 24, 26_

---

## Notes

- Milestones 1 and 2 are fully detailed; Milestones 3–5 remain placeholders to be expanded into
  detailed, checkbox-level tasks when each milestone begins.
- **Each milestone must be completed and verified before the next begins** (M1 → M2 → M3 → M4 →
  M5), per the product implementation plan.
- Note: expanding Milestone 2 into an epic-level breakdown consumed top-level task numbers
  11–18; the Milestone 3/4/5 placeholders were therefore renumbered to 19/20/21 (their scope and
  requirement references are unchanged). Milestone 1 tasks (1–10) are not renumbered.
- Tasks marked with `*` are optional (tests: unit, property-based, RLS/integration) and can be
  skipped for a faster MVP; core implementation tasks are never optional.
- Every task references specific requirement clauses for traceability and, where relevant, the
  design element it realises.
- Property-based tests validate the design's universal Correctness Properties (referenced by
  number); unit and RLS tests validate specific examples, boundaries, and access rules.
- The Milestone 1 checkpoint (task 10) enforces the foundation definition of done before
  Milestone 2 starts; the Milestone 2 checkpoint (task 18) does the same before Milestone 3.
- Milestone 2 decision: `questions.cluster_id` is a plain nullable `uuid` (no FK yet) because
  the `question_clusters` table it references is introduced in Milestone 4; the deferred
  `FK → question_clusters(id) ON DELETE SET NULL` is added by the M4 clusters migration.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "3.2", "3.3"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "4.4", "4.5"] },
    { "id": 6, "tasks": ["4.3", "4.6"] },
    { "id": 7, "tasks": ["4.7", "5.1", "5.2"] },
    { "id": 8, "tasks": ["5.3", "5.4", "6.1", "7.1"] },
    { "id": 9, "tasks": ["6.2", "6.3", "7.2"] },
    { "id": 10, "tasks": ["6.4", "7.3", "8.3"] },
    { "id": 11, "tasks": ["7.4", "7.5", "8.1"] },
    { "id": 12, "tasks": ["8.2", "9.1"] },
    { "id": 13, "tasks": ["10.1"] },

    { "id": 14, "tasks": ["11.1", "13.1", "14.1"] },
    { "id": 15, "tasks": ["11.2", "11.3", "14.2", "14.3"] },
    { "id": 16, "tasks": ["11.4", "12.1", "12.2", "14.4"] },
    { "id": 17, "tasks": ["12.3", "13.2", "13.3"] },
    { "id": 18, "tasks": ["13.4", "13.5", "15.1", "16.1", "17.1"] },
    { "id": 19, "tasks": ["13.6", "15.2", "15.3", "16.2", "17.2", "17.3"] },
    { "id": 20, "tasks": ["15.4", "16.3"] },
    { "id": 21, "tasks": ["18.1"] }
  ]
}
```
