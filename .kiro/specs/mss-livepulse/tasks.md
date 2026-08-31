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

## Milestone 3: Polls and Word Cloud

Scope: poll admin (create/open/close, 2–10 options, single-open-poll partial unique index),
poll responses with `(participant_identifier, poll_id)` uniqueness and upsert-replace, and
visibility-aware results; word-cloud prompt creation, single-open-prompt enforcement, response
normalisation, hidden-entry moderation, stop-word exclusion, and monotonic-size visualisation;
and the `poll_results` and `word_cloud` presenter display modes wired into the existing
`PresenterView` (M2 shipped join/featured_question/top_questions/waiting). Adds the `polls`,
`poll_options`, `poll_responses`, `word_cloud_prompts`, and `word_cloud_responses` tables with
their RLS policies + indexes + partial unique constraints, plus the server-mediated
(SECURITY DEFINER RPC / service-role Edge Function) write path — NO client write policies,
consistent with the Milestone 2 pattern — and rate-limit reuse where applicable.

Primary requirements: **Req 5, 6, 7** (polls, word cloud, presenter modes), plus the shared
input rules from **Req 22.2–22.4** and the anonymous-write rate-limit reuse from
**Req 21.13–21.15**.

Correctness properties implemented here: Properties 4, 5 (polls), 6, 7, 8, 9 (word cloud), and
the remaining presenter-visibility portion of Property 10 for polls/word-cloud where relevant.

**Implementation note (sandbox realities, same as Milestone 2):** the sandbox has no
Postgres/Deno/`psql`/supabase CLI, so live RLS/RPC integration tests are env-gated (`skipIf`
on `TEST_SUPABASE_*` env vars) and the durable guarantees (single-open enforcement, response
uniqueness, monotonic sizing, normalisation) are locked down by the static schema guard
(`src/db/migrations.test.ts`, extended per task 19.4) plus pure in-memory rule models exercised
by property tests. New migration filenames use byte-lexicographic ordering and MUST sort AFTER
the latest Milestone 2 migration `20260101000016_vote_broadcast.sql` — i.e. use
`20260101000017_*` and upward. Writes are server-mediated (SECURITY DEFINER RPCs / service-role
Edge Functions) with NO client write RLS policies. _Requirements: 21.6, 26.1_.

- [x] 19. Add the polls + word-cloud data model migrations
  - [x] 19.1 Add the poll enums and the `polls` table migration
    - Create migration `20260101000017_polls.sql` (timestamp sorts AFTER
      `20260101000016_vote_broadcast.sql`); add enums `poll_status ('draft','open','closed')`
      and `poll_results_visibility ('show_always','hide_until_closed')`; create the `polls`
      table with `id` (uuid PK), `event_id` (uuid NOT NULL, FK → `events(id)` ON DELETE
      CASCADE), `question_text` (text NOT NULL, CHECK `char_length` 1–200), `status`
      (`poll_status` NOT NULL default `'draft'`), `display_order` (integer NOT NULL, CHECK >0),
      `results_visibility` (`poll_results_visibility` NOT NULL), `created_at`/`updated_at`
      (timestamptz NOT NULL default `now()`); attach the existing `set_updated_at()` trigger; add
      PK on `id` and `idx_polls_event` on `event_id`
    - _Requirements: 5.1, 5.4, 22.2_
    - _Design: Data Models (`polls` table; Enumerated types `poll_status`, `poll_results_visibility`)_

  - [x] 19.2 Add the single-open-poll partial unique index and the `poll_options` table
    - In the same migration add the partial unique index
      `CREATE UNIQUE INDEX one_open_poll_per_event ON polls(event_id) WHERE status='open';`
      (DB-level at-most-one-open-poll-per-event enforcement); create `poll_options` with `id`
      (uuid PK), `poll_id` (uuid NOT NULL, FK → `polls(id)` ON DELETE CASCADE), `text`
      (text NOT NULL, CHECK `char_length` 1–100), `display_order` (integer NOT NULL),
      `response_count` (integer NOT NULL default 0, CHECK ≥0); add `idx_poll_options_poll` on
      `poll_id`; add a CHECK/trigger enforcing 2–10 options per poll
    - _Requirements: 5.1, 5.2, 5.5, 23.3, 22.3_
    - _Design: Data Models (`poll_options`; `one_open_poll_per_event` partial unique index)_

  - [x] 19.3 Add the `poll_responses` table with the response-uniqueness constraint
    - Create migration `20260101000018_poll_responses.sql`; create `poll_responses` with `id`
      (uuid PK), `poll_id` (uuid NOT NULL, FK → `polls(id)` ON DELETE CASCADE), `event_id`
      (uuid NOT NULL, FK → `events(id)` ON DELETE CASCADE, for RLS scoping), `option_id`
      (uuid NOT NULL, FK → `poll_options(id)` ON DELETE CASCADE), `participant_identifier`
      (text NOT NULL, opaque — no personal data), `created_at`/`updated_at` (timestamptz NOT
      NULL default `now()`); add **UNIQUE `(participant_identifier, poll_id)`** (the DB-level
      one-response-per-participant-per-poll rule enabling the upsert-replace path) and
      `idx_poll_responses_poll` on `poll_id`; attach `set_updated_at()`
    - _Requirements: 5.7, 5.8, 23.3, 21.18_
    - _Design: Data Models (`poll_responses`; UNIQUE `(participant_identifier, poll_id)`)_

  - [x] 19.4 Add the `word_cloud_prompts` and `word_cloud_responses` table migrations
    - Create migration `20260101000019_word_cloud.sql`; add enum
      `wordcloud_status ('draft','open','closed')`; create `word_cloud_prompts` with `id`
      (uuid PK), `event_id` (uuid NOT NULL, FK → `events(id)` ON DELETE CASCADE), `prompt_text`
      (text NOT NULL, CHECK `char_length` 1–200), `max_words_per_response` (integer NOT NULL,
      CHECK 1–10), `status` (`wordcloud_status` NOT NULL default `'draft'`),
      `results_visible_while_collecting` (boolean NOT NULL), `created_at`/`updated_at`; add the
      partial unique index `ON word_cloud_prompts(event_id) WHERE status='open'`
      (single-open-prompt-per-event); create `word_cloud_responses` with `id` (uuid PK),
      `prompt_id` (uuid NOT NULL, FK → `word_cloud_prompts(id)` ON DELETE CASCADE), `event_id`
      (uuid NOT NULL, FK → `events(id)` ON DELETE CASCADE), `participant_identifier`
      (text NOT NULL), `raw_text` (text NOT NULL, CHECK `char_length` 1–50), `normalised_text`
      (text NOT NULL — computed on write), `is_hidden` (boolean NOT NULL default false),
      `created_at`/`updated_at`; add **UNIQUE `(participant_identifier, prompt_id)`** and
      `idx_wc_responses_prompt` on `prompt_id`; attach `set_updated_at()` to both tables
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.8, 6.9, 6.12, 22.4, 23.3_
    - _Design: Data Models (`word_cloud_prompts`, `word_cloud_responses`; single-open-prompt
      partial unique index; Enumerated type `wordcloud_status`)_

  - [x]* 19.5 Extend the from-scratch schema/migration static guard for the poll + word-cloud tables
    - Extend the static migration test (`src/db/migrations.test.ts`, mirroring the M2 task 11.4
      approach) to assert the new migrations: define the `poll_status`,
      `poll_results_visibility`, and `wordcloud_status` enum values; create `polls` with the
      `char_length` 1–200 CHECK, `display_order > 0` CHECK, the `one_open_poll_per_event`
      partial unique index and `idx_polls_event`; create `poll_options` with the 1–100 CHECK,
      `response_count ≥ 0` CHECK, the 2–10-options CHECK/trigger, and `idx_poll_options_poll`;
      create `poll_responses` with UNIQUE `(participant_identifier, poll_id)` + CASCADE FKs;
      create `word_cloud_prompts` with the 1–200 and 1–10 CHECKs and the
      `WHERE status='open'` partial unique index; create `word_cloud_responses` with the 1–50
      CHECK, `is_hidden` default false, UNIQUE `(participant_identifier, prompt_id)` + CASCADE
      FKs; and that all four filenames sort after `…000016` so the schema still builds from a
      fresh database
    - _Requirements: 5.1, 5.5, 5.7, 6.1, 6.5, 6.9, 23.3, 26.1_
    - _Design: Data Models; Migrations and seed data_

- [x] 20. Configure RLS for the poll and word-cloud tables
  - [x] 20.1 Enable RLS and add read policies for `polls` and `poll_options`
    - Create migration `20260101000020_polls_rls.sql`; enable RLS (default deny) on `polls` and
      `poll_options`; add an anonymous `SELECT` policy allowed WHERE `event_is_live(event_id)`
      so the audience/presenter read open + closed polls for a live event (draft polls are never
      returned to anon); add an authenticated `SELECT` policy returning all polls/options for
      admins; add NO client `INSERT`/`UPDATE`/`DELETE` policy — poll create/open/close and
      option writes flow through the service-role RPC/Edge Function (task 21)
    - _Requirements: 5.4, 5.11, 21.3, 21.4, 21.5, 21.6_
    - _Design: RLS Design (`polls`, `poll_options` per-table policies; `event_is_live` helper)_

  - [x] 20.2 Enable RLS and add response policies for `poll_responses`
    - In migration `20260101000021_poll_responses_rls.sql`, enable RLS (default deny); add NO
      anonymous `SELECT` of raw `poll_responses` rows (results are read from
      `poll_options.response_count`, so `participant_identifier` is never exposed to clients);
      add NO direct client `INSERT`/`UPDATE`/`DELETE` policy — responses are written via the
      rate-limited upsert-replace RPC (task 21.3) which performs the atomic count maintenance
    - _Requirements: 5.7, 5.8, 8.6, 21.3, 21.4, 21.5, 21.6_
    - _Design: RLS Design (`poll_responses` per-table policies)_

  - [x] 20.3 Enable RLS and add read policies for the word-cloud tables
    - Create migration `20260101000022_word_cloud_rls.sql`; enable RLS (default deny) on
      `word_cloud_prompts` and `word_cloud_responses`; add an anonymous `SELECT` policy on
      `word_cloud_prompts` allowed WHERE `event_is_live(event_id)` (draft prompts hidden from
      anon); for `word_cloud_responses`, add an anonymous `SELECT` policy that returns ONLY rows
      WHERE `is_hidden = false` on a live event (so hidden entries never reach audience/presenter
      per Req 6.13 / 7.9), and NEVER exposes `participant_identifier`; add an authenticated
      `SELECT` for admins (including hidden entries for moderation); add NO client write policy —
      prompt create/open/close, response upsert, and hide/unhide flow through the service-role
      RPCs (task 22)
    - _Requirements: 6.3, 6.13, 7.9, 21.3, 21.4, 21.5, 21.6_
    - _Design: RLS Design (`word_cloud_prompts`, `word_cloud_responses` per-table policies)_

  - [x]* 20.4 Write env-gated RLS integration tests for the poll + word-cloud tables
    - Mirroring `src/db/rls.questions.test.ts` (skip cleanly without `TEST_SUPABASE_*`): assert
      anon `SELECT` on `polls` returns polls for a live event but nothing for a non-live event
      and never a `draft` poll; assert anon cannot `SELECT` raw `poll_responses` rows; assert
      anon `SELECT` on `word_cloud_responses` returns non-hidden entries for a live event but
      NEVER `is_hidden = true` rows and never exposes `participant_identifier`; assert anon
      `INSERT`/`UPDATE` on any of these tables is rejected (writes are RPC-only)
    - _Requirements: 5.11, 6.13, 7.9, 8.6, 26.1_
    - _Design: RLS Design (`polls`, `poll_responses`, `word_cloud_prompts`, `word_cloud_responses`)_

- [x] 21. Implement the server-side poll RPCs (create/open/close, respond)
  - [x] 21.1 Implement the poll create/edit RPC / Edge Function
    - Add an admin-only (service role, JWT-verified) `SECURITY DEFINER` RPC (or Edge Function)
      that validates the poll question 1–200 chars and 2–10 options each 1–100 chars, a positive
      `display_order`, and a `results_visibility` of exactly `show_always` or
      `hide_until_closed`; on any validation failure it rejects the request, retains no partial
      poll, and returns an error identifying the failing field; creates the poll in `draft` with
      its options; enforces single-choice as the only poll type
    - _Requirements: 5.1, 5.2, 5.3, 22.2, 22.3, 10.1, 21.6_
    - _Design: Architecture (privileged mutation Edge Functions); Request/data flows (Poll lifecycle)_

  - [x] 21.2 Implement the poll open/close transition RPC guarded by the single-open rule
    - Add a `SECURITY DEFINER` transition RPC enforcing `draft → open → closed`; when opening,
      rely on the `one_open_poll_per_event` partial unique index so opening a second poll while
      one is already open is rejected leaving both statuses unchanged and returning the
      "only one poll may be open per event" message (Req 5.6); closing a poll stops further
      responses
    - _Requirements: 5.4, 5.5, 5.6, 21.6_
    - _Design: Request/data flows (Poll lifecycle — single-open guard); Data Models
      (`one_open_poll_per_event`)_

  - [x] 21.3 Implement the poll-response upsert-replace RPC with atomic count maintenance
    - Add a `SECURITY DEFINER` respond RPC that upserts on UNIQUE
      `(participant_identifier, poll_id)`: on a first response it inserts and increments the
      chosen `poll_options.response_count`; on a changed response it replaces the prior selection
      (decrement the old option, increment the new) atomically so exactly one response remains
      (Req 5.7, 5.8); rejects a response when the poll status is `closed` leaving the existing
      response unchanged (Req 5.9); rejects a response when the poll status is `draft` (Req 5.10);
      enforces the anonymous participation rate limit by reusing the shared limiter groundwork
      (M2 task 13.1) and accepts an idempotency key
    - _Requirements: 5.7, 5.8, 5.9, 5.10, 21.13, 21.14, 21.15, 23.8_
    - _Design: Request/data flows (Poll lifecycle — upsert replace); RLS Design (rate limiting)_

  - [x] 21.4 Implement and document the poll-results Realtime broadcast (visibility-aware)
    - Broadcast updated `poll_options.response_count` aggregates from the respond RPC on an
      event-scoped channel so visible poll results update on connected clients within 2 s
      without a manual refresh; the payload carries no `participant_identifier`; results for a
      `hide_until_closed` poll are only surfaced once the poll is `closed` (visibility gating
      applied by the read/aggregation layer, task 23.2)
    - _Requirements: 5.11, 5.12, 23.1, 23.2_
    - _Design: Request/data flows (Poll lifecycle — Realtime when visible); Decision D9_

  - [x]* 21.5 Write unit tests for poll create/transition/respond RPC logic
    - Test question 1–200 and option 1–100 boundaries + 2–10 option-count boundaries + invalid
      `results_visibility` rejection identifying the field (no partial poll retained); valid
      transitions `draft→open→closed` accepted and invalid ones rejected; opening a second poll
      while one is open rejected leaving both unchanged; upsert-replace keeps exactly one
      response and moves the count from old to new option; response rejected on `closed`/`draft`
      leaving prior response unchanged; rate-limit reuse rejects on exceed
    - _Requirements: 5.1, 5.2, 5.6, 5.7, 5.8, 5.9, 5.10, 21.13, 22.2, 26.1_
    - _Design: Request/data flows (Poll lifecycle)_

  - [x]* 21.6 Write property tests for poll invariants (Properties 4, 5)
    - **Property 4: One response per participant per poll, latest replaces earlier** — generate
      a participant and a sequence of option selections; upsert each; assert exactly one
      `poll_responses` row remains for `(participant, poll)` whose `option_id` equals the last
      submitted choice. **Validates: Requirements 5.7, 5.8**
    - **Property 5: At most one open poll per event** — fast-check random open/close sequences
      over multiple polls in one event; assert `count(status='open') <= 1` after every step and
      that opening a second poll while one is open is rejected leaving both statuses unchanged.
      **Validates: Requirements 5.5, 5.6**
    - Tag each `Feature: mss-livepulse, Property N: ...`; drive the in-memory poll rule model
      (env-gated where a live DB is needed), mirroring the M2 property-test task 13.6
    - _Requirements: 5.5, 5.6, 5.7, 5.8, 26.1_
    - _Design: Correctness Properties (Properties 4, 5)_

- [x] 22. Implement the server-side word-cloud RPCs (prompt lifecycle, response, moderation)
  - [x] 22.1 Implement the word-cloud normalisation module
    - Add a pure `src/lib/wordcloud.ts` (shared by client preview and the write RPC) exposing a
      `normalise(s)` that lower-cases all letters, trims leading/trailing whitespace, and
      collapses each run of consecutive internal whitespace to a single space — canonical and
      idempotent (`normalise(normalise(s)) === normalise(s)`); add an aggregation helper that
      groups non-hidden responses by `normalised_text`, excludes configured stop words /
      exclusion-list terms (compared using the same normalisation), and returns per-term
      frequency counts with a monotonic size mapping (`f1 <= f2 ⇒ size(f1) <= size(f2)`)
    - _Requirements: 6.10, 6.11, 6.13, 6.14_
    - _Design: Request/data flows (Word cloud — normalisation, aggregation, monotonic sizing);
      Technology Stack (d3-cloud — we own aggregation/sizing)_

  - [x] 22.2 Implement the word-cloud prompt create + open/close RPC guarded by the single-open rule
    - Add an admin-only (service role, JWT-verified) `SECURITY DEFINER` RPC that validates prompt
      text 1–200 chars and `max_words_per_response` 1–10, rejecting creation with the specific
      invalid field and creating no prompt on failure (Req 6.1, 6.2); creates the prompt in
      `draft`; enforces `draft → open → closed` and relies on the `WHERE status='open'` partial
      unique index so setting a second prompt to `open` while one is open is rejected leaving
      both statuses unchanged (Req 6.4, 6.5)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 21.6_
    - _Design: Request/data flows (Word cloud — one prompt open at a time); Data Models
      (single-open-prompt partial unique index)_

  - [x] 22.3 Implement the word-cloud response upsert RPC (normalise on write, gating, rate limit)
    - Add a `SECURITY DEFINER` respond RPC that upserts on UNIQUE
      `(participant_identifier, prompt_id)` while the prompt is `open`, allowing the participant
      to update the response any number of times (Req 6.6); validates length 1–50 and rejects an
      empty/over-length submission retaining any previously stored response (Req 6.8); rejects a
      submit/update when the prompt is not `open` retaining any prior response (Req 6.7); stores
      both `raw_text` and the computed `normalised_text` (task 22.1) on write (Req 6.10);
      enforces the shared anonymous rate limit (M2 task 13.1) and accepts an idempotency key
    - _Requirements: 6.6, 6.7, 6.8, 6.9, 6.10, 21.13, 21.14, 21.15, 23.8_
    - _Design: Request/data flows (Word cloud — one response per participant, updatable while open)_

  - [x] 22.4 Implement the word-cloud entry hide/unhide moderation RPC and visible-aggregation broadcast
    - Add an admin-only (service role, JWT-verified) RPC that sets `word_cloud_responses.is_hidden`
      for the admin's own event (Req 6.12); ensure hidden entries are excluded from all term
      aggregation and from the audience + presenter views (via the RLS read policy in task 20.3
      and the aggregation helper in task 22.1) (Req 6.13); broadcast the recomputed visible
      aggregate on an event-scoped channel (no `participant_identifier`) so visible word-cloud
      results update within 2 s without a manual refresh (Req 6.15)
    - _Requirements: 6.12, 6.13, 6.15, 7.9, 23.1, 23.2_
    - _Design: Request/data flows (Word cloud — hidden entries excluded, Realtime when visible)_

  - [x]* 22.5 Write unit tests for word-cloud RPC logic and moderation
    - Test prompt text 1–200 and `max_words_per_response` 1–10 boundaries with field-specific
      rejection (no prompt created); single-open-prompt guard rejects a second open leaving both
      unchanged; response 1–50 boundary + empty rejection retaining prior response; submit/update
      rejected when prompt not `open` retaining prior response; `normalised_text` stored on
      write; hide marks `is_hidden` and removes the entry from the visible aggregate; stop-word
      terms excluded from aggregation
    - _Requirements: 6.2, 6.4, 6.6, 6.7, 6.8, 6.12, 6.13, 6.14, 26.1_
    - _Design: Request/data flows (Word cloud)_

  - [x]* 22.6 Write property tests for word-cloud invariants (Properties 6, 7, 8, 9)
    - **Property 6: One response per participant per word-cloud prompt** — repeated
      submissions/updates by one participant; assert a single `word_cloud_responses` row remains
      whose value tracks the latest update while open. **Validates: Requirements 6.6, 6.9**
    - **Property 7: At most one open word-cloud prompt per event** — fast-check random open/close
      sequences; assert `count(status='open') <= 1` after every step and the second open
      rejected. **Validates: Requirements 6.4, 6.5**
    - **Property 8: Word-cloud normalisation is idempotent and canonical** — fast-check over
      random Unicode strings with mixed case and whitespace runs; assert
      `normalise(normalise(s)) === normalise(s)`, no leading/trailing whitespace, no consecutive
      internal whitespace, and only lower-case letters. **Validates: Requirements 6.10**
    - **Property 9: Word-cloud aggregation equivalence and monotonic sizing** — generate response
      multisets with random `is_hidden` flags and a stop-word list; assert identical normalised
      terms aggregate into one term whose frequency equals the count of contributing
      (non-hidden, non-excluded) responses, that hidden/stop-word terms contribute nothing, and
      that `f1 <= f2 ⇒ size(f1) <= size(f2)`. **Validates: Requirements 6.11, 6.13, 6.14**
    - Tag each `Feature: mss-livepulse, Property N: ...`; drive the pure normalisation/aggregation
      module (task 22.1) and the in-memory prompt rule model, mirroring M2 property-test tasks
      13.6/17.2
    - _Requirements: 6.4, 6.5, 6.6, 6.9, 6.10, 6.11, 6.13, 6.14, 26.1_
    - _Design: Correctness Properties (Properties 6, 7, 8, 9)_

- [x] 23. Implement the audience poll + word-cloud participation UI (Req 5, 6)
  - [x] 23.1 Implement the `PollCard` audience component
    - Build a single-choice poll component that lists the open poll's options, calls the
      respond RPC (task 21.3), reflects the participant's current selection, and lets the
      participant change their choice (upsert-replace); show the four UX states; never render
      `participant_identifier`; when the event is not live or the poll is `draft`/`closed`,
      withhold the response controls using the existing `participationGate` lib
    - _Requirements: 5.7, 5.9, 5.10, 8.6, 24.7, 2.8_
    - _Design: Components (`PollCard`); Request/data flows (Poll lifecycle)_

  - [x] 23.2 Implement visibility-aware poll results rendering with realtime updates
    - Render poll results (Recharts, ARIA-labelled, non-colour encodings) subscribing to the
      event-scoped poll-results channel (task 21.4) so visible results update within 2 s; for a
      `hide_until_closed` poll, withhold results from the audience (and presenter) until the poll
      status becomes `closed`; for `show_always`, render live tallies while open
    - _Requirements: 5.11, 5.12, 23.2, 24.5_
    - _Design: Frontend Design (Realtime subscription strategy); Technology Stack (Recharts)_

  - [x] 23.3 Implement the `WordCloudCard` audience component with normalised live preview
    - Build a word-cloud response input (1–50 chars) that calls the word-cloud respond RPC
      (task 22.3), shows the participant's current response and allows updates while the prompt
      is open, and previews the client-side `normalise` result (task 22.1); show the four UX
      states, retain entered text on a length-validation error identifying the 1–50 constraint;
      withhold controls when the event is not live or the prompt is not `open`
    - _Requirements: 6.6, 6.7, 6.8, 6.10, 24.7, 2.8_
    - _Design: Components (`WordCloudCard`); Request/data flows (Word cloud)_

  - [x] 23.4 Implement the audience word-cloud visualisation with monotonic sizing
    - Render the aggregated live word cloud (d3-cloud + lightweight React wrapper) from the
      visible-aggregate channel (task 22.4), mapping each term's aggregated frequency to a
      non-decreasing rendered size (task 22.1), excluding hidden entries and stop words; update
      within 2 s when results are visible; provide an accessible text-list fallback for the term
      frequencies
    - _Requirements: 6.11, 6.13, 6.14, 6.15, 24.5_
    - _Design: Technology Stack (d3-cloud — monotonic sizing); Frontend Design (Realtime
      subscription strategy)_

  - [x] 23.5 Wire the poll + word-cloud views into the audience event route
    - Extend `/e/:eventRef` to surface the current active interaction (open poll / open prompt)
      and route the participant to `PollCard` / `WordCloudCard`, reusing the M2
      `useRealtimeChannel` hook (event-scoped subscription only) and `ConnectionStatusIndicator`
    - _Requirements: 2.6, 5.12, 6.15, 23.2_
    - _Design: Frontend Design (Route map — `/e/:eventRef`); Request/data flows (Audience join)_

  - [x]* 23.6 Write unit tests for the poll + word-cloud audience UI
    - Test poll single-choice selection and change-of-choice invoking the respond RPC with
      upsert semantics; results hidden for `hide_until_closed` until closed and shown for
      `show_always`; word-cloud input 1–50 validation retaining text on error; client normalise
      preview matches the shared module; monotonic term sizing (larger frequency ⇒ size not
      smaller); no `participant_identifier` reaches the DOM
    - _Requirements: 5.7, 5.11, 6.8, 6.10, 6.11, 8.6, 26.1_
    - _Design: Components (`PollCard`, `WordCloudCard`)_

- [x] 24. Implement the presenter poll_results + word_cloud display modes (Req 7)
  - [x] 24.1 Add the `poll_results` and `word_cloud` presenter modes to `PresenterView`
    - Extend the existing `/present/:eventRef` view (M2 shipped join/featured_question/
      top_questions/waiting) with the `poll_results` mode (renders the active poll's
      visibility-aware results, projector-optimised) and the `word_cloud` mode (renders the
      aggregated live word cloud); respect `results_visibility` for polls and exclude hidden
      word-cloud entries; switch to the mode selected by the moderator within 2 s via realtime
    - _Requirements: 7.4, 7.5, 7.8, 5.11, 6.13, 7.9_
    - _Design: Request/data flows (Presenter mode switching); Data Models (`presenter_mode`
      enum values `poll_results`, `word_cloud`)_

  - [x] 24.2 Wire realtime updates and retain-last-content on interruption for the new modes
    - Subscribe the `poll_results` and `word_cloud` presenter modes to the event-scoped
      poll-results and word-cloud aggregate channels (tasks 21.4, 22.4) so content updates
      within 2 s; on connection loss retain the last successfully displayed content and show the
      interruption indicator (reuse the M2 presenter reconnect UX)
    - _Requirements: 7.6, 7.7, 5.12, 6.15, 23.2_
    - _Design: Request/data flows (Presenter mode switching — retain last content); Frontend
      Design (Realtime subscription strategy & reconnect UX)_

  - [x]* 24.3 Write the presenter-visibility property + unit tests for polls/word-cloud (Property 10 remainder)
    - **Property 10: Moderation visibility invariant (presenter poll/word-cloud remainder)** —
      generate word-cloud entries with random `is_hidden` flags and polls with each
      `results_visibility`; compute the presenter-visible sets via the RLS-backed read path;
      assert no hidden word-cloud entry ever appears in the presenter word cloud and that a
      `hide_until_closed` poll's results are withheld from the presenter until `closed`,
      completing the presenter-visibility portion of Property 10 for polls/word-cloud. Tag
      `Feature: mss-livepulse, Property 10: ...`. **Validates: Requirements 6.13, 7.9, 5.11**
    - Add unit tests asserting the presenter mode switches within the two new modes and retains
      last content on a simulated connection loss
    - _Requirements: 5.11, 6.13, 7.7, 7.9, 26.1_
    - _Design: Correctness Properties (Property 10); RLS Design (`word_cloud_responses`, `polls`)_

- [x] 25. Milestone 3 checkpoint — verify Polls and Word Cloud completeness
  - [x] 25.1 Verify the Milestone 3 definition of done
    - Confirm the polls/poll_options/poll_responses/word_cloud_prompts/word_cloud_responses
      migrations + RLS build from a fresh database (static guard extended, task 19.5); confirm
      the single-open-poll and single-open-prompt partial unique indexes are enforced; confirm
      poll-response uniqueness `(participant_identifier, poll_id)` with upsert-replace and
      word-cloud response uniqueness `(participant_identifier, prompt_id)`; confirm word-cloud
      normalisation is canonical/idempotent and rendered sizing is monotonic in frequency;
      confirm the presenter `poll_results` and `word_cloud` modes render with realtime updates,
      retain last content on interruption, and respect visibility rules (poll
      `hide_until_closed`; hidden word-cloud entries excluded); and confirm `npm run build`,
      `npm test`, `npm run lint`, and `npm run typecheck:test` all pass before proceeding to
      Milestone 4. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 5.5, 5.7, 5.11, 6.5, 6.9, 6.10, 6.11, 6.13, 7.4, 7.7, 26.3_
    - _Design: Migrations and seed data; RLS Design; Correctness Properties; Request/data flows
      (Poll lifecycle, Word cloud, Presenter mode switching)_

---

## Milestone 4: AI Features (placeholder — to be expanded when this milestone begins)

- [~] 26. Milestone 4: AI Features — expand into detailed tasks when the milestone begins
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

- [~] 27. Milestone 5: Export, Hardening, Event Readiness — expand into detailed tasks when the milestone begins
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

- Milestones 1, 2, and 3 are fully detailed; Milestones 4–5 remain placeholders to be expanded
  into detailed, checkbox-level tasks when each milestone begins.
- **Each milestone must be completed and verified before the next begins** (M1 → M2 → M3 → M4 →
  M5), per the product implementation plan.
- Note: expanding Milestone 2 into an epic-level breakdown consumed top-level task numbers
  11–18; the Milestone 3/4/5 placeholders were therefore renumbered to 19/20/21 (their scope and
  requirement references are unchanged). Milestone 1 tasks (1–10) are not renumbered.
- Note: expanding Milestone 3 into an epic-level breakdown consumed top-level task numbers
  19–25 (starting at the number the M3 placeholder previously held); the Milestone 4 and
  Milestone 5 placeholders were therefore renumbered from 20/21 to 26/27 (their scope and
  requirement references are unchanged). Milestone 1 tasks (1–10) and Milestone 2 tasks (11–18)
  are not renumbered.
- Tasks marked with `*` are optional (tests: unit, property-based, RLS/integration) and can be
  skipped for a faster MVP; core implementation tasks are never optional.
- Every task references specific requirement clauses for traceability and, where relevant, the
  design element it realises.
- Property-based tests validate the design's universal Correctness Properties (referenced by
  number); unit and RLS tests validate specific examples, boundaries, and access rules.
- The Milestone 1 checkpoint (task 10) enforces the foundation definition of done before
  Milestone 2 starts; the Milestone 2 checkpoint (task 18) does the same before Milestone 3; the
  Milestone 3 checkpoint (task 25) does the same before Milestone 4.
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
    { "id": 21, "tasks": ["18.1"] },

    { "id": 22, "tasks": ["19.1", "19.3", "19.4", "22.1"] },
    { "id": 23, "tasks": ["19.2"] },
    { "id": 24, "tasks": ["19.5", "20.1", "20.2", "20.3"] },
    { "id": 25, "tasks": ["20.4", "21.1", "22.2"] },
    { "id": 26, "tasks": ["21.2", "22.3"] },
    { "id": 27, "tasks": ["21.3", "22.4"] },
    { "id": 28, "tasks": ["21.4", "21.5", "21.6", "22.5", "22.6"] },
    { "id": 29, "tasks": ["23.1", "23.3", "24.1"] },
    { "id": 30, "tasks": ["23.2", "23.4", "24.2"] },
    { "id": 31, "tasks": ["23.5", "23.6", "24.3"] },
    { "id": 32, "tasks": ["25.1"] }
  ]
}
```
