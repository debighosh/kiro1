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

## Milestone 4: AI Features

Scope: the single server-side **AI Gateway** Edge Function (the only egress from the system to
any AI provider); write-only credential storage (managed `secret_reference` preferred, AES-256-GCM
AEAD fallback, XOR rule, plaintext never stored); endpoint allowlist / SSRF protection with
TLS-preserving resolved-IP validation; a sanitised connection test; a provider-agnostic adapter
layer with a first-class `openai_compatible` chat-completions adapter and a documented
`custom_adapter` extension point; server-side structured-output (Zod) validation with bounded
retries; question categorisation into the fixed 8 categories; prompt-based clustering; grounded
theme insights; the Markdown end-of-event summary (calculated-data vs AI-interpretation
separation); and the failure/degraded mode that keeps the entire core flow functional. Adds the
`ai_provider_settings`, `ai_jobs`, and `question_clusters` tables (and the deferred
`questions.cluster_id → question_clusters(id)` FK) plus their RLS rules, and the admin AI UI
(settings/config + connection test, moderation-queue categorisation integration, presenter
`ai_themes` mode, and summary generation/display).

Primary requirements: **Req 11–20** (AI config, credential protection, SSRF, structured output,
categorisation, clustering, theme insights, summary, failure/degraded mode, privacy), plus the
admin-only authorisation from **Req 10.1, 20.4** and the write-only secret handling from
**Req 21.8**.

Correctness properties implemented here: Properties 12, 13 (credentials — no credential in read
APIs/logs, XOR storage, write-only), 14 (structured-output schema validation with bounded
retries), 15 (AI failure never blocks the core flow), 16 (SSRF allowlist), 17 (categorisation
preserves original question text byte-for-byte), 18 (cluster vote total = sum of member votes),
and 19 (outbound AI payloads exclude participant identifiers).

**Implementation note (sandbox realities, same as Milestones 2/3):** the sandbox has no
Postgres/Deno/`psql`/supabase CLI, so live RLS/RPC integration tests and the Deno/Edge-Function
integration tests are env-gated (`skipIf` on `TEST_SUPABASE_*` env vars / the AI Gateway's own
integration harness) and the durable guarantees (XOR credential storage, no-secret reads, SSRF
allow/deny, structured-output validation, categorisation text preservation, computed cluster vote
totals) are locked down by the static schema guard (`src/db/migrations.test.ts`, extended per task
26.4) plus pure in-memory rule models exercised by property tests. The AI Gateway is
Deno/Edge-Function code under `supabase/functions/` (excluded from the SPA `tsc` build + ESLint,
like the existing `create-event` / `moderate-question` / `transition-event-status` functions), so
its logic that CAN be unit-tested in Node — SSRF IP-range checks, credential XOR/AEAD rules,
structured-output Zod validation, and payload participant-identifier exclusion — is factored into
pure, Node-testable modules where practical, mirroring how M2/M3 factored `qaRules.ts` /
`wordcloud.ts`. New migration filenames use byte-lexicographic ordering and MUST sort AFTER the
latest Milestone 3 migration `20260101000029_poll_broadcast.sql` — i.e. use `20260101000030_*` and
upward. AI egress and all credential/config writes are server-mediated (the AI Gateway / a
service-role AI Config Edge Function) with NO client write RLS policies; credentials are
write-only. _Requirements: 21.6, 21.8, 26.1_.

- [x] 26. Add the AI data model migrations (ai_provider_settings, ai_jobs, question_clusters)
  - [x] 26.1 Add the AI enums and the `ai_provider_settings` table migration
    - Create migration `20260101000030_ai_provider_settings.sql` (timestamp sorts AFTER
      `20260101000029_poll_broadcast.sql`); add enums `provider_type ('openai_compatible',
      'custom_adapter')`, `ai_auth_type ('bearer','api_key_header','none')`, `ai_job_type
      ('categorisation','clustering','theme_insights','summary','connection_test')`, and
      `ai_job_status ('pending','running','succeeded','failed')`; create `ai_provider_settings`
      (single active global config) with `id` (uuid PK), `is_active` (boolean NOT NULL default
      true), `ai_enabled` (boolean NOT NULL default false), `display_name` (text NOT NULL, CHECK
      `char_length` 1–100), `provider_type`, `base_url` (text NOT NULL, CHECK 1–2048, absolute
      URL), `chat_completions_path` (text NOT NULL, CHECK 1–512), `auth_type`,
      `api_key_header_name` (text NULL, CHECK 1–100), `model_id` (text NOT NULL, CHECK 1–200),
      `temperature` (numeric(3,2) NOT NULL, CHECK 0.0–2.0), `max_output_tokens` (integer NOT NULL,
      CHECK 1–128000), `request_timeout_seconds` (integer NOT NULL, CHECK 1–300),
      `tls_verify_required` (boolean NOT NULL default true), `secret_reference` (text NULL),
      `encrypted_credential` (bytea NULL), `credential_state` (text GENERATED —
      `'configured'`/`'not_configured'`), `created_at`/`updated_at` (timestamptz NOT NULL default
      `now()`); add the partial unique index `ON ai_provider_settings(is_active) WHERE is_active`
      (at most one active config), the **XOR CHECK
      `(num_nonnulls(secret_reference, encrypted_credential) <= 1)`** (never both — Req 12.6), and
      attach the existing `set_updated_at()` trigger; the plaintext credential is NEVER stored
      (Req 12.4)
    - _Requirements: 11.1, 11.5, 11.7, 11.8, 11.9, 12.4, 12.6, 13.12, 19.1_
    - _Design: Data Models (`ai_provider_settings` table; Enumerated types `provider_type`,
      `ai_auth_type`, `ai_job_type`, `ai_job_status`; partial unique index; XOR CHECK)_

  - [x] 26.2 Add the `ai_jobs` audit-log table migration
    - Create migration `20260101000031_ai_jobs.sql`; create `ai_jobs` with `id` (uuid PK),
      `event_id` (uuid NULL, FK → `events(id)` ON DELETE CASCADE), `job_type` (`ai_job_type` NOT
      NULL), `status` (`ai_job_status` NOT NULL), `model_id` (text NULL), `started_at` (timestamptz
      NOT NULL), `ended_at` (timestamptz NULL), `attempt_count` (integer NOT NULL default 0),
      `sanitised_error` (text NULL); add `idx_ai_jobs_event` on `event_id`; document at the schema
      level that `ai_jobs` NEVER stores credentials or full prompt text (Req 12.9, 20.7)
    - _Requirements: 14.6, 19.3, 20.6, 20.7, 12.9_
    - _Design: Data Models (`ai_jobs` table)_

  - [x] 26.3 Add the `question_clusters` table migration and the deferred `questions.cluster_id` FK
    - Create migration `20260101000032_question_clusters.sql`; create `question_clusters` with `id`
      (uuid PK), `event_id` (uuid NOT NULL, FK → `events(id)` ON DELETE CASCADE), `label` (text NOT
      NULL, CHECK `char_length` 1–100), `created_at`/`updated_at` (timestamptz NOT NULL default
      `now()`); add `idx_question_clusters_event` on `event_id` and attach `set_updated_at()`; then
      **add the deferred FK** `questions.cluster_id → question_clusters(id) ON DELETE SET NULL`
      (the M2 `questions` migration deliberately declared `cluster_id` as a plain nullable `uuid`
      with NO FK because `question_clusters` is a Milestone-4 table — see the Notes decision — so
      this migration introduces the FK now, leaving questions intact on cluster deletion)
    - _Requirements: 16.1, 16.4, 16.7, 16.9, 16.10, 3.4_
    - _Design: Data Models (`question_clusters` table; single-membership via `questions.cluster_id`
      FK ON DELETE SET NULL); Notes decision on the deferred cluster FK_

  - [x]* 26.4 Extend the from-scratch schema/migration static guard for the AI tables
    - Extend the static migration test (`src/db/migrations.test.ts`, mirroring the M3 task 19.5
      approach) to assert the new migrations: define the `provider_type`, `ai_auth_type`,
      `ai_job_type`, and `ai_job_status` enum values; create `ai_provider_settings` with the
      `display_name` 1–100, `base_url` 1–2048, `chat_completions_path` 1–512, `model_id` 1–200,
      `temperature` 0.0–2.0, `max_output_tokens` 1–128000, and `request_timeout_seconds` 1–300
      CHECKs, the `tls_verify_required` default true, the `WHERE is_active` partial unique index,
      the XOR CHECK `num_nonnulls(secret_reference, encrypted_credential) <= 1`, and the GENERATED
      `credential_state`; create `ai_jobs` with the `ai_job_type`/`ai_job_status` columns and the
      CASCADE FK; create `question_clusters` with the `label` 1–100 CHECK and CASCADE FK, and the
      `questions.cluster_id → question_clusters(id) ON DELETE SET NULL` FK; and that all three
      filenames sort after `…000029` so the schema still builds from a fresh database
    - _Requirements: 11.1, 11.7, 12.4, 12.6, 16.1, 16.4, 26.1_
    - _Design: Data Models; Migrations and seed data_

- [x] 27. Configure RLS for the AI tables
  - [x] 27.1 Enable RLS and add the no-secret read policy for `ai_provider_settings`
    - Create migration `20260101000033_ai_provider_settings_rls.sql`; enable RLS (default deny) on
      `ai_provider_settings`; add NO anonymous access at all; expose authenticated admin read of
      **non-secret columns ONLY** via a column-restricted view / `SECURITY DEFINER` read function
      that whitelists non-secret columns, and do NOT grant `SELECT` on `secret_reference` /
      `encrypted_credential` (nor any resolved secret) to the `authenticated` role — these are
      NEVER selectable by any client (Req 12.8, 12.10, 21.8); add NO client `INSERT`/`UPDATE`/
      `DELETE` policy — all config/secret writes occur only inside the service-role AI Config /
      AI Gateway Edge Functions (task 28.2 / task 29.1)
    - _Requirements: 12.8, 12.10, 21.3, 21.4, 21.8, 21.6_
    - _Design: RLS Design (`ai_provider_settings` — no anonymous access, non-secret columns only via
      column-restricted view / SECURITY DEFINER read fn)_

  - [x] 27.2 Enable RLS and add read policies for `ai_jobs` and `question_clusters`
    - Create migration `20260101000034_ai_jobs_clusters_rls.sql`; enable RLS (default deny) on
      `ai_jobs` and `question_clusters`; add an authenticated admin `SELECT` policy scoped to the
      admin's own event scope; add NO anonymous access; add NO client write policy — `ai_jobs`
      rows and cluster create/dissolve are written only via the service-role AI Gateway
      (tasks 29.1, 31.1)
    - _Requirements: 20.6, 16.10, 21.3, 21.4, 21.6_
    - _Design: RLS Design (`ai_jobs`, `question_clusters` — authenticated read for own scope, no
      anonymous access, writes service-role only)_

  - [x]* 27.3 Write env-gated RLS integration tests for the AI tables
    - Mirroring `src/db/rls.questions.test.ts` (skip cleanly without `TEST_SUPABASE_*`): assert
      anonymous access to `ai_provider_settings`, `ai_jobs`, and `question_clusters` is denied
      entirely; assert an authenticated admin read of `ai_provider_settings` returns non-secret
      columns and that `secret_reference` / `encrypted_credential` are NOT selectable by any client
      (the whitelisted read path never exposes them); assert authenticated admin can read
      `ai_jobs`/`question_clusters` for their own scope; assert client `INSERT`/`UPDATE` on all
      three tables is rejected (writes are service-role only)
    - _Requirements: 12.10, 21.8, 20.6, 16.10, 26.1_
    - _Design: RLS Design (`ai_provider_settings`, `ai_jobs`, `question_clusters`)_

- [x] 28. Implement the shared AI schemas and the server-side credential module
  - [x] 28.1 Define the shared AI Zod schemas (provider settings input + structured-output contracts)
    - Add shared Zod schemas (single source of truth, importable by the SPA and the Edge
      Functions) for: (a) the AI provider settings input — `display_name` 1–100, `provider_type`,
      `base_url` 1–2048 absolute URL, `chat_completions_path` 1–512, `auth_type`,
      `api_key_header_name` 1–100 (required when `api_key_header`), `model_id` 1–200,
      `temperature` 0.0–2.0, `max_output_tokens` 1–128000, `request_timeout_seconds` 1–300,
      `tls_verify_required`, and the write-only `credential` 1–8192 chars (Req 11.1, 11.5, 12.2);
      and (b) the AI structured-output contracts — categorisation result, cluster result, theme
      insights, and summary — used for server-side response validation (Req 14.2)
    - _Requirements: 11.1, 11.5, 12.2, 14.1, 14.2_
    - _Design: Error Handling (Validation errors — shared Zod schemas); Structured output
      validation (same Zod schema server-side)_

  - [x] 28.2 Implement the Edge-Function-only credential module (write-only, XOR, AEAD fallback)
    - Add an Edge-Function-only credential module (never imported by the SPA) implementing the
      write-only credential handling: prefer a managed **`secret_reference`**; use the AEAD
      fallback = AES-256-GCM (Web/Node Crypto) with the key from the `AI_CREDENTIAL_ENCRYPTION_KEY`
      deployment secret, storing only ciphertext in `encrypted_credential`; enforce the XOR rule
      (never both `secret_reference` and `encrypted_credential`); NEVER store the plaintext; on a
      resolve/decrypt failure abort with an error containing no plaintext or partial credential;
      ensure credentials never appear in logs, errors, telemetry, exports, or `ai_jobs`
      (Req 12.3–12.9); factor the pure XOR/AEAD rule logic into a Node-testable module for the
      property tests in task 35
    - _Requirements: 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9_
    - _Design: Server-Side AI Gateway Design (Credential handling — secret_reference preferred,
      AEAD fallback, XOR, plaintext never stored); Technology Stack (Crypto AEAD fallback)_

  - [x]* 28.3 Write unit tests for the shared AI schemas and credential module rules
    - Test the provider-settings schema boundaries (display_name 1–100, base_url 1–2048 absolute
      URL, model_id 1–200, temperature 0.0–2.0, max_output_tokens 1–128000, request_timeout_seconds
      1–300, api_key_header_name required only when `api_key_header`, credential 1–8192) with
      field-specific rejection; test the credential module's XOR enforcement (never both), that the
      plaintext is never returned/stored, and that a resolve/decrypt failure produces an error
      containing no plaintext
    - _Requirements: 11.1, 11.5, 12.2, 12.4, 12.6, 12.8, 26.1_
    - _Design: Error Handling; Server-Side AI Gateway Design (Credential handling)_

- [x] 29. Implement the AI Gateway Edge Function (single server-side egress)
  - [x] 29.1 Implement the AI Gateway core (auth, enablement precondition, credential resolve, logging)
    - Add the `supabase/functions/ai-gateway` Edge Function (service role, reusing the existing
      `_shared` JWT-verification pattern from `moderate-question`): verify the caller is an
      Administrator and reject non-admins with an insufficient-privileges error (Req 20.4); enforce
      the **AI enablement precondition** — when `ai_enabled = true` AND `auth_type != 'none'`,
      require a `secret_reference` OR `encrypted_credential`; if neither is present, treat AI as
      effectively unconfigured and return the degraded 'AI unavailable' / not-configured state
      WITHOUT making an unauthenticated call (Req 11.1, 11.9, 12.3, 12.5, 12.6, 19.1); resolve the
      credential in-process immediately before use and discard the plaintext afterwards (Req 12.7);
      build a minimal payload (question text ≤10,000 chars + aggregate metadata only, NO participant
      identifiers) (Req 20.1, 20.3); enforce a hard timeout using the admin-configured
      `request_timeout_seconds` (default/cap ≤30 s) (Req 14.5, 19.1); and log each operation to
      `ai_jobs` (type, status, timestamps, model id, sanitised error, attempt count) WITHOUT
      credentials or full prompt text (Req 20.6, 20.7)
    - _Requirements: 11.1, 11.9, 12.3, 12.5, 12.6, 12.7, 14.5, 19.1, 20.1, 20.3, 20.4, 20.6, 20.7_
    - _Design: Server-Side AI Gateway Design (Responsibilities; AI enablement precondition; AI job
      sequence); Architecture (single AI egress)_

  - [x] 29.2 Implement the SSRF protection with TLS-preserving resolved-IP validation
    - Factor a pure, Node-testable SSRF module: accept only `https`/`http` schemes (reject others);
      resolve the destination address and BLOCK by default link-local/metadata (`169.254.0.0/16`
      incl. `169.254.169.254`), loopback (`127.0.0.0/8`, `::1`), and private ranges
      (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`); permit private/on-prem ONLY if
      the resolved destination is in the deployment `AI_ENDPOINT_ALLOWLIST`; reject a
      non-allowlisted destination WITHOUT sending the request (disallowed-destination error). Wire
      the module into the Gateway with **TLS-preserving SSRF resolution** — validate the RESOLVED
      IP for the allow/deny decision WITHOUT breaking HTTPS SNI or certificate-hostname
      verification, pinning the validated IP to the connection while preserving the SNI hostname
      (respecting `tls_verify_required`) to close the DNS-rebinding gap; never return provider
      headers, credentials, or raw diagnostics to the browser (Req 13.1, 13.10)
    - _Requirements: 13.4, 13.6, 13.7, 13.8, 13.9, 13.10, 13.12, 13.1_
    - _Design: Server-Side AI Gateway Design (SSRF protection; TLS-preserving SSRF resolution)_

  - [x] 29.3 Implement the provider adapter layer (openai_compatible + custom_adapter extension point)
    - Add a provider-agnostic adapter interface with a first-class `openai_compatible`
      chat-completions adapter and a documented `custom_adapter` extension point; request native
      JSON mode when the provider supports it, otherwise request JSON in-prompt and extract
      candidate JSON server-side (Req 14.1, 14.3); the adapter normalises provider differences
      behind one interface and constructs the chat-completions call from the resolved config
    - _Requirements: 11.3, 16.1, 14.1, 14.3_
    - _Design: Server-Side AI Gateway Design (provider-agnostic adapter; openai_compatible adapter;
      custom_adapter extension point)_

  - [x] 29.4 Implement server-side structured-output validation with bounded retries
    - Factor a pure, Node-testable validation step that validates every provider response against
      the shared Zod contract (task 28.1) server-side BEFORE storing/displaying; on validation
      failure (or no extractable candidate JSON) reject without storing, leave prior data
      unchanged, and return a recoverable error, retrying up to 2 additional attempts and recording
      `attempt_count` (Req 14.2, 14.3, 14.4, 14.6, 14.7); render nothing as executable HTML/script
      — all AI-produced text is plain text (Req 14.8)
    - _Requirements: 14.2, 14.3, 14.4, 14.6, 14.7, 14.8_
    - _Design: Server-Side AI Gateway Design (Structured output validation)_

  - [x] 29.5 Implement the connection-test operation (sanitised results, dual-check compatibility)
    - Implement the `connection_test` job type: server-side send a minimal ≤256-char non-sensitive
      prompt and verify a non-empty usable response; return only sanitised results (outcome, HTTP
      status category 2xx/3xx/4xx/5xx, model id, round-trip ms, ISO 8601 UTC timestamp) and on
      failure a sanitised category (invalid URL scheme, timeout, disallowed destination, connection
      error, invalid response) with NO persisted config change (Req 13.1–13.5); report compatibility
      as "established" ONLY when BOTH the connection test AND a representative structured-output test
      succeed (Req 13.11)
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.11, 25.7_
    - _Design: Server-Side AI Gateway Design (Connection test)_

  - [x]* 29.6 Write unit tests for the Gateway core, adapter, validation, and connection test
    - Test admin-only authorisation (non-admin rejected); the AI enablement precondition (ai_enabled
      + auth_type != none + no credential → degraded 'AI unavailable' with no outbound call); the
      minimal payload excludes participant identifiers; the timeout uses the admin-configured
      `request_timeout_seconds`; the openai_compatible adapter constructs the chat-completions call
      and falls back to in-prompt JSON extraction; structured-output validation rejects malformed
      responses leaving prior data unchanged and retries at most twice; the connection test returns
      only sanitised fields and reports compatibility only on the dual success
    - _Requirements: 11.9, 14.3, 14.4, 14.6, 19.1, 20.4, 20.1, 13.11, 26.1_
    - _Design: Server-Side AI Gateway Design (Responsibilities; adapter; validation; connection test)_

  - [x]* 29.7 Write a property test for SSRF allowlist enforcement (Property 16)
    - **Property 16: SSRF allowlist enforcement** — fast-check generates random URLs and resolved
      IPs spanning public, link-local (`169.254.0.0/16`), loopback (`127.0.0.0/8`, `::1`), and
      private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), with/without allowlist
      entries; assert the "send" decision is true **iff** the scheme is `http`/`https` AND the
      resolved destination is public or allowlisted, and that no blocked request is dispatched. Tag
      `Feature: mss-livepulse, Property 16: ...`. **Validates: Requirements 13.6, 13.7, 13.8, 13.9**
    - Drive the pure SSRF module (task 29.2)
    - _Requirements: 13.6, 13.7, 13.8, 13.9, 26.1_
    - _Design: Correctness Properties (Property 16); Server-Side AI Gateway Design (SSRF protection)_

- [x] 30. Implement question categorisation (Req 15)
  - [x] 30.1 Implement the categorisation AI Gateway job
    - Add the `categorisation` job type that classifies each approved question into exactly one of
      the fixed 8 categories `{Technology, Governance, Security, Operations, Workforce, Compliance,
      Strategy, Other}` in batches ≤100 within ≤30 s (Req 15.1); validate each returned category by
      exact, case-sensitive match and reject the WHOLE response if any category is invalid
      (Req 15.3, 15.4); store the category + optional confidence (numeric 0.00–1.00, or absent) on
      the question, preserving the original `text` byte-for-byte (Req 15.5, 15.6, 15.9); exclude
      hidden questions unless explicitly requested (Req 15.10); implement the moderator override so
      it must be one of the 8 categories, records `ai_prior_category`, and retains the prior
      assignment on an invalid override (Req 15.7, 15.8)
    - _Requirements: 15.1, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10_
    - _Design: Server-Side AI Gateway Design (AI features — Categorisation); Data Models
      (`questions.ai_category`, `ai_category_confidence`, `ai_prior_category`)_

  - [x]* 30.2 Write a property test for categorisation text preservation (Property 17)
    - **Property 17: Categorisation preserves original question text** — generate questions; run
      categorisation (mocked provider) and moderator overrides; assert the stored question `text`
      is byte-for-byte identical before and after and only category metadata changes. Tag
      `Feature: mss-livepulse, Property 17: ...`. **Validates: Requirements 15.9**
    - _Requirements: 15.9, 26.1_
    - _Design: Correctness Properties (Property 17)_

  - [x]* 30.3 Write unit tests for categorisation validation and override rules
    - Test exact case-sensitive category validation (a single invalid category rejects the whole
      response, no category stored); confidence stored 0.00–1.00 or absent; hidden questions
      excluded unless explicitly requested; moderator override rejected when not one of the 8 and
      the prior assignment retained; `ai_prior_category` recorded on override
    - _Requirements: 15.3, 15.4, 15.5, 15.7, 15.8, 15.10, 26.1_
    - _Design: Server-Side AI Gateway Design (AI features — Categorisation)_

- [x] 31. Implement prompt-based clustering (Req 16)
  - [x] 31.1 Implement the clustering AI Gateway job (prompt-based only)
    - Add the `clustering` job type that performs PROMPT-BASED semantic grouping ONLY (no vector
      embeddings / pairwise similarity): submit the approved-question set to the chat-completions
      endpoint with a grouping prompt and validate the structured JSON clusters (each cluster
      2–500 members, `label` 1–100) against the shared schema (Req 16.1); if <2 approved questions,
      return zero clusters with an insufficient-data indication (Req 16.2); validate that every
      returned question id belongs to the current event and otherwise reject the whole response
      (Req 16.10); create clusters additively as `question_clusters` rows and set members'
      `questions.cluster_id`, never deleting/merging originals (Req 16.4); dissolving a cluster
      deletes the cluster row and sets its members' `cluster_id` NULL (Req 16.9); compute the
      cluster vote total as the sum of member `vote_count` (never stored) (Req 16.5, 16.6)
    - _Requirements: 16.1, 16.2, 16.4, 16.5, 16.6, 16.7, 16.9, 16.10_
    - _Design: Server-Side AI Gateway Design (AI features — Clustering, prompt-based only); Data
      Models (`question_clusters`; computed cluster vote total)_

  - [x]* 31.2 Write a property test for the cluster vote total (Property 18)
    - **Property 18: Cluster vote total equals sum of member votes** — generate clusters with
      random member `vote_count`s; assert the computed total equals the arithmetic sum; mutate
      membership (add/remove members) and assert the total equals the new sum, and that the total
      is never stored. Tag `Feature: mss-livepulse, Property 18: ...`.
      **Validates: Requirements 16.5, 16.6**
    - Drive an in-memory cluster model
    - _Requirements: 16.5, 16.6, 26.1_
    - _Design: Correctness Properties (Property 18)_

  - [x]* 31.3 Write unit tests for clustering validation and dissolution
    - Test <2 approved questions → zero clusters + insufficient-data indication; a returned question
      id not belonging to the current event rejects the whole response; cluster member-count 2–500
      and `label` 1–100 boundaries; clusters are additive (originals not deleted/merged); dissolving
      a cluster deletes the row and NULLs members' `cluster_id`
    - _Requirements: 16.2, 16.4, 16.7, 16.9, 16.10, 26.1_
    - _Design: Server-Side AI Gateway Design (AI features — Clustering)_

- [x] 32. Implement grounded theme insights (Req 17)
  - [x] 32.1 Implement the theme-insights AI Gateway job
    - Add the `theme_insights` job type that generates ≤5 top themes, ≤5 emerging concerns, ≤10
      frequent topics, and ≤5 notable high-vote questions within 10 s (Req 17.1); compute "notable
      high-vote" as the top 10% of vote counts OR vote count ≥10 (Req 17.2); ground the output ONLY
      in the selected event's data — the prompt instructs the model not to invent counts, votes, or
      questions (Req 17.3, 17.4); for an empty event return an empty result set with a status
      indication and no fabrication (Req 17.5); validate the response against the shared theme
      schema before returning
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_
    - _Design: Server-Side AI Gateway Design (AI features — Theme insights)_

  - [x]* 32.2 Write unit tests for theme-insights bounds and grounding
    - Test the caps (≤5 themes, ≤5 emerging concerns, ≤10 frequent topics, ≤5 notable questions);
      the notable-high-vote threshold (top 10% OR ≥10); the empty-event case returns an empty result
      + status indication with no fabricated content; schema validation rejects a malformed response
    - _Requirements: 17.1, 17.2, 17.5, 26.1_
    - _Design: Server-Side AI Gateway Design (AI features — Theme insights)_

- [x] 33. Implement the end-of-event summary and the AI failure / degraded mode (Req 18, 19)
  - [x] 33.1 Implement the end-of-event summary AI Gateway job (calculated vs AI-interpretation)
    - Add the `summary` job type that produces a Markdown report in which ALL calculated data is
      computed directly from the DB independent of the model under a "Calculated Data" heading, and
      AI interpretation lives under a separate "AI Interpretation" heading with the AI executive
      summary + follow-up actions prefixed "AI-Generated" (Req 18.1, 18.4, 18.5, 18.6); include top
      questions ≤10 by descending votes, ties broken by earliest submission (Req 18.2); complete
      within 30 s (Req 18.3); if AI is unavailable, produce all calculated sections plus a visible
      notice that AI content could not be produced (Req 18.7)
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7_
    - _Design: Server-Side AI Gateway Design (AI features — End-of-event summary)_

  - [x] 33.2 Implement the AI failure / degraded-mode handling across AI operations
    - Ensure any AI failure (not configured, unreachable, auth failure, invalid response, or timeout
      at the admin-configured `request_timeout_seconds`) keeps the ENTIRE core flow fully functional
      with no AI-attributable error surfaced to the user, and that AI features fail independently
      (Req 19.1); bound automatic retries to max 3 per operation with exponential backoff and then
      stop until an admin manual retry that executes exactly one attempt reporting within 2 s
      (Req 19.3, 19.4); never mutate/delete prior approved moderation decisions or valid AI results
      and never persist partial/invalid output (Req 19.5, 19.6); no silent provider switching /
      automatic failover (Req 19.7); the initiating AI control shows an "AI unavailable" indication
      within 2 s without provider internals (Req 19.2)
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7_
    - _Design: Server-Side AI Gateway Design (Failure handling / degraded mode)_

  - [x]* 33.3 Write a property test for AI failure never blocking the core flow (Property 15)
    - **Property 15: AI failure never blocks the core flow** — parameterised injection of each AI
      failure mode (not configured, unreachable, auth failure, invalid response, timeout at the
      admin-configured timeout); run each core operation (Q&A, moderation, voting, polls, word
      clouds, presenter controls, analytics, CSV export) and assert it completes successfully with
      no AI-attributable error surfaced. Tag `Feature: mss-livepulse, Property 15: ...`.
      **Validates: Requirements 19.1, 27.6**
    - _Requirements: 19.1, 26.1_
    - _Design: Correctness Properties (Property 15); Server-Side AI Gateway Design (degraded mode)_

  - [x]* 33.4 Write unit tests for the summary structure and degraded-mode behaviour
    - Test the summary's Calculated-Data vs AI-Interpretation heading separation and the
      "AI-Generated" prefix; top-questions ≤10 ordering by descending votes with earliest-submission
      tie-break; the AI-unavailable path emits all calculated sections + the visible AI-unavailable
      notice; a failure leaves prior approved moderation/AI results unchanged and persists no
      partial output; the "AI unavailable" indication surfaces without provider internals
    - _Requirements: 18.2, 18.4, 18.7, 19.2, 19.5, 19.6, 26.1_
    - _Design: Server-Side AI Gateway Design (End-of-event summary; degraded mode)_

- [x] 34. Implement the admin AI UI (settings/config, moderation categorisation, presenter, summary)
  - [x] 34.1 Build the AI settings/config screen with write-only credential entry and connection test
    - Add an admin-only route (under `RequireAuth`) with the provider-config form validated by the
      shared schema (task 28.1); implement write-only credential entry with **Replace/Remove**
      requiring an authenticated session established or re-verified within 300 s and Remove
      requiring explicit confirmation (Req 11.12, 11.13, 12.11); surface the `credential_state`
      (configured/required); add a connection-test button that invokes the Gateway `connection_test`
      (task 29.5) and surfaces the sanitised results within 30 s (Req 13.1, 25.7); show a visible
      notice that event text will be sent to the endpoint before any AI operation (Req 20.5); never
      display any stored credential (write-only, Req 12.1, 12.10)
    - _Requirements: 11.12, 11.13, 12.1, 12.10, 12.11, 13.1, 20.5, 25.7_
    - _Design: Server-Side AI Gateway Design (Credential handling — Replace/Remove; Connection test);
      Frontend Design (Protected-route strategy)_

  - [x] 34.2 Integrate categorisation into the moderation queue (category filter + override)
    - Extend the existing `ModerationQueue` (M2 task 16.2) with the AI category display, the
      category filter, and a moderator override control that calls the categorisation override path
      (task 30.1), constraining the override to the 8 categories and retaining the prior category on
      an invalid selection; a "categorise" action triggers the categorisation job via the Gateway
    - _Requirements: 15.7, 15.8, 3.11, 3.12, 24.7_
    - _Design: Components (`ModerationQueue`); Server-Side AI Gateway Design (AI features —
      Categorisation)_

  - [x] 34.3 Add the presenter `ai_themes` display mode
    - Extend the existing `PresenterView` (`/present/:eventRef`) with the `ai_themes` mode that
      renders the theme-insights output (top themes, emerging concerns, frequent topics, notable
      high-vote questions), projector-optimised and ARIA-labelled; render all AI text as plain text
      (Req 14.8); switch to this mode via the moderator-selected `active_presenter_mode` within 2 s
    - _Requirements: 7.4, 7.5, 17.1, 14.8_
    - _Design: Data Models (`presenter_mode` value `ai_themes`); Server-Side AI Gateway Design (AI
      features — Theme insights); Request/data flows (Presenter mode switching)_

  - [x] 34.4 Build the end-of-event summary generation and display UI
    - Add an admin-only summary view that triggers the summary job (task 33.1) and renders the
      returned Markdown as plain text (no executable HTML — Req 14.8), showing the Calculated-Data
      and AI-Interpretation sections and, when AI is unavailable, the calculated sections plus the
      visible AI-unavailable notice (Req 18.7)
    - _Requirements: 18.1, 18.4, 18.7, 14.8, 25.4_
    - _Design: Server-Side AI Gateway Design (AI features — End-of-event summary); Frontend Design
      (Protected-route strategy)_

  - [x]* 34.5 Write unit tests for the admin AI UI
    - Test the config form validation surfacing field errors; Replace/Remove gated by a
      re-verified-within-300 s session and Remove requiring explicit confirmation; the connection
      test surfaces only sanitised results; no credential value is ever rendered; the moderation
      category filter/override behaviour; the presenter `ai_themes` mode renders theme output as
      plain text; the summary view renders calculated + AI sections and the AI-unavailable notice
    - _Requirements: 11.12, 11.13, 12.10, 13.1, 15.7, 18.7, 26.1_
    - _Design: Components (`ModerationQueue`, `PresenterView`); Server-Side AI Gateway Design_

- [x] 35. Write the credential-protection and privacy property tests (Properties 12, 13, 19)
  - [x]* 35.1 Write property tests for credential protection (Properties 12, 13)
    - **Property 12: Credential never present in any read API response or log** — generate random
      AI provider configs; invoke every read API and capture emitted logs/telemetry/export lines;
      assert none contain the plaintext credential, the `encrypted_credential` ciphertext, the
      `secret_reference` target value, or any resolved secret. **Validates: Requirements 12.8, 12.9,
      12.10, 21.8**
    - **Property 13: Credential storage is exclusive (XOR)** — generate random save operations over
      both the `secret_reference` path and the encryption-fallback path; assert the XOR CHECK holds
      (`num_nonnulls(secret_reference, encrypted_credential) <= 1`) and no plaintext column
      exists/holds a credential. **Validates: Requirements 12.4, 12.6**
    - Tag each `Feature: mss-livepulse, Property N: ...`; drive the pure credential module
      (task 28.2) and the whitelisted read path (task 27.1), env-gating any live-DB portion
    - _Requirements: 12.4, 12.6, 12.8, 12.9, 12.10, 21.8, 26.1_
    - _Design: Correctness Properties (Properties 12, 13); Server-Side AI Gateway Design (Credential
      handling)_

  - [x]* 35.2 Write a property test for AI payloads excluding participant identifiers (Property 19)
    - **Property 19: AI payloads exclude participant identifiers** — generate event data including
      identifier-shaped fields (name, email, phone, user id, IP); build the outbound Gateway payload
      and assert it contains no participant identifier, and that if an identifier is detected prior
      to transmission the request is blocked and no call is made. Tag
      `Feature: mss-livepulse, Property 19: ...`. **Validates: Requirements 20.1, 20.2, 20.3**
    - Drive the pure payload-builder / pre-transmission guard from the Gateway (task 29.1)
    - _Requirements: 20.1, 20.2, 20.3, 26.1_
    - _Design: Correctness Properties (Property 19); Server-Side AI Gateway Design (AI data handling
      / privacy)_

- [x] 36. Milestone 4 checkpoint — verify AI Features completeness
  - [x] 36.1 Verify the Milestone 4 definition of done
    - Confirm the `ai_provider_settings`/`ai_jobs`/`question_clusters` migrations + the deferred
      `questions.cluster_id` FK + their RLS build from a fresh database (static guard extended, task
      26.4); confirm NO credential (plaintext, `encrypted_credential`, `secret_reference`, or any
      resolved secret) is selectable by any client or appears in `ai_jobs`/logs, and that the XOR +
      write-only rules are enforced; confirm the SSRF allowlist blocks non-allowlisted / link-local /
      loopback / private destinations WITHOUT sending while preserving TLS SNI/cert verification;
      confirm structured-output validation rejects invalid responses without storing (prior data
      unchanged) with bounded retries; confirm categorisation preserves the original question text
      byte-for-byte and clustering is prompt-based with computed (never stored) cluster vote totals;
      confirm theme insights + summary are grounded / calculated-vs-AI-separated; confirm ANY AI
      failure leaves the core flow fully functional (degraded mode); and confirm `npm run build`,
      `npm test`, `npm run lint`, and `npm run typecheck:test` all pass before proceeding to
      Milestone 5. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 12.6, 12.10, 13.8, 14.4, 15.9, 16.5, 19.1, 20.7, 21.8, 26.3_
    - _Design: Data Models; RLS Design; Correctness Properties; Server-Side AI Gateway Design_

---

## Milestone 5: Export, Hardening, and Event Readiness

Scope: pure CSV serialisation (RFC-4180) for questions, polls, and word-cloud exports plus the
Markdown end-of-event summary export wired to the existing M4 summary job; the analytics
dashboard (unique-participant count, question status counts, vote/poll/word-cloud response
counts, 5-minute engagement-over-time) with the admin export panel; hardening of the
server-side rate limits, input validation/sanitisation, and the shared error contract; a
mobile-first accessibility/responsive audit and per-screen fixes; the eight Playwright E2E
flows and the k6 500-VU load-test script with a results template; and the ≥80% coverage gate
plus the moderator operating guide and deployment/rollback documentation.

Primary requirements: **Req 8, 9, 18, 21, 24, 26** (analytics, export, summary, security/RLS/
governance, accessibility/UX, testing/load validation), plus the input-length rules from
**Req 22.1–22.7** exercised by the sanitisation hardening.

Correctness properties implemented here: no new universal properties are introduced; the M5
property tests reinforce existing invariants — export identifier-exclusion (Req 9.5, 8.6) and
the sanitisation allow-list / max-length rules (Req 21.9–21.12) — via pure, Node-testable
modules, mirroring the M2/M3/M4 property-test style.

**Implementation note (sandbox realities, same as Milestones 2/3/4):** the sandbox has no
Postgres/Deno/`psql`/supabase CLI and no browser or live Supabase, so live RLS/RPC integration
tests, the Playwright E2E specs, and the k6 load script are env-gated (`skipIf` on
`TEST_SUPABASE_*` / a target base-URL env var, mirroring `src/db/rls.*.test.ts`) and the durable
guarantees are locked down by pure, Node-testable modules under `src/lib/` (CSV serialisation,
analytics aggregation, sanitisation) exercised by unit + fast-check property tests, plus the
static schema guard (`src/db/migrations.test.ts`) for any new migration. New migration filenames
use byte-lexicographic ordering and MUST sort AFTER the latest Milestone 4 migration
`20260101000034_ai_jobs_clusters_rls.sql` — i.e. use `20260101000035_*` and upward. All
anonymous writes remain server-mediated (SECURITY DEFINER RPCs / service-role Edge Functions)
with NO client write RLS policies; the analytics/export read paths use the authenticated admin
read path only. k6 is a separate binary (not npm) — these tasks author the script + docs;
running it is an ops step. _Requirements: 21.6, 26.1_.

- [ ] 37. Implement the pure CSV serialisation and export builders (Req 9)
  - [ ] 37.1 Implement the pure RFC-4180 CSV serialisation module
    - Add a pure, Node-testable `src/lib/csv.ts` exposing a `toCsv(rows, columns)` serialiser
      that quotes fields containing commas, double-quotes, CR, or LF, escapes embedded
      double-quotes by doubling them, and emits a header row followed by one row per record with
      `\r\n` line endings; the module holds no I/O and no participant-identifier fields
    - _Requirements: 9.1, 9.2, 9.3, 9.5_
    - _Design: Components and Interfaces (Export_Service — CSV serialisation); Error Handling_

  - [ ] 37.2 Implement the questions / polls / word-cloud CSV export builders
    - Add pure builder functions (e.g. in `src/lib/exports.ts`) that map query results to CSV
      rows using `csv.ts` (37.1): questions → `text` (≤1000 chars) + `vote_count`; polls → poll
      question text + option text + `response_count`; word cloud → distinct `normalised_text`
      word + frequency; each builder excludes Participant_Identifiers entirely (Req 9.5);
      empty-data input yields a header-only CSV plus a no-data indication flag (Req 9.6); the
      builders are synchronous/pure so a serialisation failure produces no partial output
      (Req 9.7) and complete well within 10 s for up to 10,000 rows
    - _Requirements: 9.1, 9.2, 9.3, 9.5, 9.6, 9.7_
    - _Design: Components and Interfaces (Export_Service — per-type builders); Data Models
      (`questions.vote_count`, `poll_options.response_count`, `word_cloud_responses`)_

  - [ ] 37.3 Wire the Markdown end-of-event summary export to the existing M4 summary job
    - Add a summary-export path that invokes the existing client `runSummary` in
      `src/lib/aiClient.ts` (which calls the M4 `supabase/functions/ai-gateway/jobs/summary.ts`
      Markdown producer) and downloads the returned Markdown as a `.md` file; when the summary
      job reports AI unavailable, still download the calculated-data-only Markdown with the
      visible AI-unavailable notice (Req 18.7); on job failure produce no partial file and
      surface the failed export type (Req 9.7)
    - _Requirements: 9.4, 18.1, 18.7, 9.7_
    - _Design: Server-Side AI Gateway Design (End-of-event summary); Components and Interfaces
      (Export_Service — Markdown summary)_

  - [ ]* 37.4 Write property + unit tests for the CSV module and export builders
    - **Property (export identifier-exclusion):** generate export rows containing
      identifier-shaped fields; assert no serialised CSV output contains any Participant_Identifier
      (Req 9.5, 8.6). Unit-test RFC-4180 quoting/escaping (commas, quotes, CR/LF, doubled quotes);
      the header-only + no-data indication on empty input (Req 9.6); the ≤1000/word-frequency
      shaping; and that a builder never emits a partial file on failure (Req 9.7)
    - _Requirements: 9.5, 9.6, 9.7, 8.6, 26.1_
    - _Design: Components and Interfaces (Export_Service); Testing Strategy_

- [ ] 38. Implement the analytics dashboard and admin export UI (Req 8, 9, 25.6)
  - [ ] 38.1 Implement the pure analytics aggregation module
    - Add a pure, Node-testable `src/lib/analytics.ts` computing from query inputs: the count of
      distinct Participant_Identifiers as a non-negative integer (never exposing the raw values —
      Req 8.6), question status counts (approved/featured/answered/hidden) and the total submitted
      count, total question votes, poll response counts, word-cloud response counts, and an
      engagement-over-time series bucketed into fixed 5-minute intervals spanning event start to
      the current time (Req 8.1–8.4); a zero-interaction event yields 0 for every metric (Req 8.8)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.8_
    - _Design: Components and Interfaces (Analytics_Service — aggregation); Data Models_

  - [ ] 38.2 Implement the authenticated analytics read path
    - Add an admin-only read helper (e.g. in `src/lib/analytics.ts` or a thin client module) that
      fetches the aggregate counts via the authenticated admin read path (DB aggregation queries,
      no raw `participant_identifier` selection) and feeds `analytics.ts` (38.1); if retrieval
      fails, surface an error state and return no partial or stale metrics (Req 8.7)
    - _Requirements: 8.1, 8.6, 8.7_
    - _Design: Components and Interfaces (Analytics_Service); RLS Design (authenticated admin read)_

  - [ ] 38.3 Build the admin analytics dashboard view with recharts
    - Add an admin-only analytics route/view (under `RequireAuth`) rendering the metrics from
      38.1/38.2 with recharts (already a dependency, used in M3), ARIA-labelled charts and
      non-colour encodings; label every metric as representing platform interaction counts rather
      than verified attendees (Req 8.5); never render any Participant_Identifier (Req 8.6); wire
      the loading / empty / success / error UX states, showing the unavailable-analytics error
      state on retrieval failure (Req 8.7, 24.7)
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 24.5, 24.7_
    - _Design: Frontend Design (Admin analytics screen); Technology Stack (Recharts)_

  - [ ] 38.4 Build the admin export panel UI
    - Add the export panel (on the AI provider configuration screen per Req 25.6, or the admin
      dashboard) with buttons to download the questions / polls / word-cloud CSVs (via the 37.2
      builders) and the Markdown summary (via 37.3); show a no-data indication when a requested
      export is empty (Req 9.6) and a per-type failure indication with no partial download on
      failure (Req 9.7); wire loading/success/error states (Req 24.7)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 25.6, 24.7_
    - _Design: Frontend Design (Route map — AI config export panel); Components and Interfaces
      (Export_Service)_

  - [ ]* 38.5 Write unit tests for the analytics aggregation and dashboard
    - Test the 5-minute bucketing spanning start→now; status/vote/response counts; the
      zero-interaction all-zeros case (Req 8.8); the platform-interaction labelling (Req 8.5); the
      retrieval-failure error state with no partial/stale metrics (Req 8.7); and that no
      Participant_Identifier reaches the DOM or chart data (Req 8.6)
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.8, 26.1_
    - _Design: Components and Interfaces (Analytics_Service); Frontend Design (Admin analytics)_

- [ ] 39. Harden server-side rate limiting, input validation, and the error contract (Req 21, 22)
  - [ ] 39.1 Extend/confirm the server-side rate-limit action set for all anonymous writes
    - Review the generic `check_and_record_rate_limit(participant, action, event_id, limit,
      window)` RPC (`20260101000013_rate_limiting.sql`) and the submit/vote RPCs
      (`20260101000014_submit_question_rpc.sql`, `20260101000015_vote_rpc.sql`); confirm the
      question-submit limit (10 / 60 s) and vote limit (30 / 60 s) are enforced server-side
      (Req 21.13, 21.14). Inspect `src/lib/polls.ts`, `src/lib/wordCloudClient.ts`, and the poll/
      word-cloud respond RPCs (`20260101000026`, `20260101000027`); if any anonymous
      poll/word-cloud response path relies on client-side limiting only, add a new migration
      `20260101000035_rate_limit_actions.sql` extending the allowed action set (e.g.
      `poll_respond`, `word_cloud_respond`) and wire those RPCs through the shared limiter so an
      exceeded limit rejects the request and records nothing (Req 21.15)
    - _Requirements: 21.13, 21.14, 21.15_
    - _Design: RLS Design (Server-side rate limiting); Request/data flows (submit/vote/respond)_

  - [ ] 39.2 Implement the pure input sanitisation / allow-list module
    - Add a pure, Node-testable `src/lib/sanitise.ts` enforcing a configurable allow-list of
      permitted characters and a configurable maximum length (default 500) applied before
      persistence, returning a validation-failure reason (field name + limit) on violation
      without mutating input (Req 21.9, 21.10, 21.11, 22.7); provide an inert-text helper ensuring
      submitted text is treated as plain text and never rendered as executable HTML/script
      (Req 21.12, 24.8)
    - _Requirements: 21.9, 21.10, 21.11, 21.12, 22.7, 24.8_
    - _Design: Error Handling (Validation and sanitisation); Frontend Design (inert text rendering)_

  - [ ] 39.3 Wire the sanitisation module into the submit paths as defence-in-depth
    - Apply `sanitise.ts` (39.2) in the shared question/poll/word-cloud input schemas and the
      client submit helpers (`src/lib/questions.ts`, `src/lib/polls.ts`,
      `src/lib/wordCloudClient.ts`) as defence-in-depth alongside the existing DB CHECK
      constraints and Edge Function validation, rejecting the whole submission and retaining
      entered values on a sanitisation/length violation (Req 21.11, 22.7)
    - _Requirements: 21.9, 21.11, 21.12, 22.7_
    - _Design: Error Handling (Validation errors — shared schemas); Request/data flows_

  - [ ] 39.4 Confirm and align the sanitised shared error contract across Edge Functions/RPCs
    - Review the shared `supabase/functions/_shared/http.ts` error contract and the Edge
      Functions/RPCs; confirm every error response is sanitised (no stack traces, provider
      internals, credentials, or SQL detail leaked) and returns a consistent shape with a
      caller-facing reason; align any function that diverges from the contract
    - _Requirements: 21.8, 19.2_
    - _Design: Error Handling (Sanitised error contract); Server-Side AI Gateway Design_

  - [ ]* 39.5 Write property + unit tests for sanitisation and rate-limit action set
    - **Property (sanitisation allow-list + max length):** fast-check over random strings; assert
      input is accepted iff every character is in the allow-list AND length ≤ the configured max,
      and rejected with a field/limit reason otherwise, with input never mutated (Req 21.9, 21.10,
      21.11). Unit-test the inert-text helper never yields executable HTML/script (Req 21.12); and
      an env-gated assertion that the poll/word-cloud respond paths reject on an exceeded
      server-side limit recording nothing (Req 21.15)
    - _Requirements: 21.9, 21.10, 21.11, 21.12, 21.15, 26.1_
    - _Design: Error Handling; RLS Design (rate limiting)_

- [ ] 40. Accessibility and mobile-first responsive audit + fixes (Req 24)
  - [ ] 40.1 Add shared accessibility utilities
    - Add reusable helpers (e.g. `src/lib/a11y.ts` and/or a `usePrefersReducedMotion` hook and a
      focus-ring utility) that expose a reduced-motion preference, a standard visible focus-ring
      class meeting ≥3:1 contrast, and helpers for non-colour status indicators (text/icon/shape),
      for reuse across screens
    - _Requirements: 24.3, 24.4, 24.6_
    - _Design: Frontend Design (Mobile-first & accessibility approach)_

  - [ ] 40.2 Apply mobile-first responsive + touch-target fixes to audience screens
    - Audit and fix the audience screens (`EventJoinCard`, `QuestionSubmissionForm`,
      `QuestionListAndVoting`, `PollCard`, `WordCloudCard`, audience route) to reflow without
      horizontal scroll at 320–768 CSS px with primary actions in the bottom 60% of the viewport
      (Req 24.1), interactive touch targets ≥44×44 px with ≥8 px spacing (Req 24.2), and text
      contrast ≥4.5:1 / ≥3:1 (Req 24.9)
    - _Requirements: 24.1, 24.2, 24.9_
    - _Design: Frontend Design (Mobile-first layout)_

  - [ ] 40.3 Apply keyboard-nav, labelling, and non-colour-status fixes across admin/presenter screens
    - Audit and fix the admin/presenter screens (login, event editor, `StatusTransitionControl`,
      `ModerationQueue`, poll/word-cloud editors, analytics, AI config, `PresenterView`) for
      logical keyboard tab order with a visible focus indicator ≥3:1 (Req 24.3), non-colour status
      indicators (Req 24.4), programmatically-associated accessible labels for all form fields,
      controls, and charts (Req 24.5), reduced-motion honoring via the 40.1 hook (Req 24.6), and
      consistent loading/empty/success/error states with a retry action (Req 24.7); ensure no
      Participant_Identifier is rendered in any element, attribute, tooltip, or chart data
      (Req 24.8)
    - _Requirements: 24.3, 24.4, 24.5, 24.6, 24.7, 24.8_
    - _Design: Frontend Design (Accessibility & UX states)_

  - [ ]* 40.4 Write jsdom + testing-library a11y invariant tests
    - Using `@testing-library`: assert form fields/controls/charts expose non-empty accessible
      names (Req 24.5); status is conveyed with a non-colour indicator (Req 24.4); each async
      surface renders empty/loading/success/error states with a retry action (Req 24.7); the
      reduced-motion path disables non-essential animation (Req 24.6); and no Participant_Identifier
      string reaches the DOM (Req 24.8)
    - _Requirements: 24.4, 24.5, 24.6, 24.7, 24.8, 26.1_
    - _Design: Frontend Design (Accessibility & UX states); Testing Strategy_

- [ ] 41. Author the Playwright E2E suite (Req 26.4)
  - [ ] 41.1 Add Playwright config, scripts, and env-gated fixtures
    - Add `@playwright/test` as a devDependency, a `playwright.config.ts`, an `e2e/` directory,
      and npm scripts (`e2e`, `e2e:headed`); add a shared fixture that reads the target base URL
      and Supabase env and `skip`s cleanly when they are absent (mirroring the DB-less env-gating
      in `src/db/rls.*.test.ts`)
    - _Requirements: 26.4_
    - _Design: Testing Strategy (End-to-end tests); Deployment and Environment_

  - [ ] 41.2 Implement the admin event lifecycle + participant Q&A E2E specs
    - Author E2E specs for: (a) an Administrator creating and launching an event; (b) a Participant
      joining and submitting a question; (c) a Moderator approving and featuring a question; each
      asserting the expected observable outcome and env-gated per 41.1
    - _Requirements: 26.4_
    - _Design: Testing Strategy (End-to-end tests)_

  - [ ] 41.3 Implement the voting + poll + word-cloud E2E specs
    - Author E2E specs for: (d) multiple Participants voting with updating counts; (e) an
      Administrator opening a poll and receiving responses; (f) an Administrator opening a
      word-cloud prompt and receiving responses; each asserting the expected observable outcome
      and env-gated per 41.1
    - _Requirements: 26.4_
    - _Design: Testing Strategy (End-to-end tests)_

  - [ ] 41.4 Implement the presenter + end-and-export E2E specs
    - Author E2E specs for: (g) a Presenter switching modes; (h) an Administrator ending an event
      and exporting results; each asserting the expected observable outcome and env-gated per 41.1
    - _Requirements: 26.4_
    - _Design: Testing Strategy (End-to-end tests); Components and Interfaces (Export_Service)_

- [ ] 42. Author the k6 load-test script and the coverage gate (Req 26.5, 26.6, 26.7, 26.1, 26.2, 26.3)
  - [ ] 42.1 Author the k6 500-VU load-test script
    - Add a k6 script under `load/` simulating a configurable number of Participants (default 500
      concurrent) performing join, concurrent question submissions, concurrent votes, poll
      responses, word-cloud responses, and presenter/moderator realtime subscriptions (Req 26.5);
      define k6 thresholds and custom metrics capturing per-operation P50/P95 response times, error
      rate, and max sustained concurrency (Req 26.6); parameterise the VU count and target env
    - _Requirements: 26.5, 26.6_
    - _Design: Testing Strategy (Load tests); Non-functional (Realtime performance targets)_

  - [ ] 42.2 Add the load-test results template and 500-user claim gate documentation
    - Add `load/README.md` documenting the load-test configuration, how to run k6 against a hosted
      target, a results template for identified bottlenecks and measured limits (per-operation P50/
      P95 ms, error-rate %, max sustained concurrent users), and the explicit 500-user claim gate:
      the platform may claim 500-concurrent support only when a hosted run holds error rate ≤1% and
      P95 ≤2000 ms (Req 26.6, 26.7)
    - _Requirements: 26.6, 26.7_
    - _Design: Testing Strategy (Load tests); Non-functional (500-user validation gate)_

  - [ ] 42.3 Establish the ≥80% coverage gate and positive+negative behaviour coverage
    - Using the existing `test:coverage` script, verify the Vitest suite achieves ≥80% line
      coverage across the modules implementing the Req-26.1/26.2 behaviours (event status rules,
      question validation, moderation visibility, duplicate-vote prevention, poll response
      uniqueness/updates, word-cloud uniqueness/normalisation, admin authorisation; presenter
      visibility, AI failure handling, AI-config authorisation, write-only credential behaviour,
      credential encryption/Secret_Reference, endpoint validation/allowlist, sanitised provider
      errors, structured-output validation); add any missing passing + negative (rejection) test so
      each listed behaviour has both, and confirm the suite runs with no failures and a
      machine-readable report (Req 26.1, 26.2, 26.3)
    - _Requirements: 26.1, 26.2, 26.3_
    - _Design: Testing Strategy (Automated tests, coverage)_

- [ ] 43. Author the moderator guide and deployment/rollback documentation (Req 26, event readiness)
  - [ ] 43.1 Write the moderator operating guide
    - Add `docs/moderator-guide.md` covering how to run an event end-to-end: create/launch an
      event and its status transitions, moderation-queue actions (approve/feature/answer/hide) and
      filters, presenter modes (join/featured/top-questions/poll-results/word-cloud/ai-themes),
      opening/closing polls and word-cloud prompts, the AI features (categorise/cluster/theme
      insights/summary), and running the CSV/Markdown exports
    - _Requirements: 26.4_
    - _Design: Deployment and Environment (Operating guidance)_

  - [ ] 43.2 Write the deployment and rollback documentation
    - Add `docs/deployment.md` covering Supabase project setup, applying the `supabase/migrations`
      in order, deploying the Edge Functions (`create-event`, `moderate-question`,
      `transition-event-status`, `ai-gateway`, …), the required env/secrets (`SUPABASE_URL`,
      `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AI_CREDENTIAL_ENCRYPTION_KEY`,
      `AI_ENDPOINT_ALLOWLIST`, `VITE_*`), the Playwright and k6 run steps, and a rollback
      procedure (schema/migration and Edge Function rollback)
    - _Requirements: 21.8, 26.5_
    - _Design: Deployment and Environment (Environment variables; deploy/rollback)_

- [ ] 44. Milestone 5 checkpoint — verify Export, Hardening, and Event Readiness completeness
  - [ ] 44.1 Verify the Milestone 5 definition of done
    - Confirm the CSV export builders exclude Participant_Identifiers and produce header-only CSVs
      with a no-data indication on empty input and no partial file on failure; confirm the Markdown
      summary export downloads the M4 summary (with the AI-unavailable notice path); confirm the
      analytics dashboard renders all metrics (labelled as platform interaction counts, zero-safe,
      no identifiers) with an unavailable error state; confirm the server-side rate limits cover
      all anonymous write paths and the sanitisation allow-list/max-length + inert-text rendering
      are enforced; confirm the accessibility/responsive fixes (320–768 px reflow, 44×44 targets,
      keyboard/focus, labels, reduced motion, non-colour status, contrast, no identifiers); confirm
      the eight Playwright E2E flows are authored + env-gated and the k6 500-VU script + results
      template are present; confirm the Vitest suite meets ≥80% coverage with passing + negative
      tests for the Req-26.1/26.2 behaviours; confirm the moderator guide and deployment/rollback
      docs exist; and confirm `npm run build`, `npm test`, `npm run lint`, and
      `npm run typecheck:test` all pass. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 8.5, 8.6, 9.5, 9.6, 21.13, 21.15, 24.1, 24.8, 26.1, 26.4, 26.7_
    - _Design: Components and Interfaces (Export_Service, Analytics_Service); Error Handling; RLS
      Design; Frontend Design; Testing Strategy; Deployment and Environment_

---

## Notes

- Milestones 1, 2, 3, 4, and 5 are fully detailed at the checkbox level.
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
- Note: expanding Milestone 4 into an epic-level breakdown consumed top-level task numbers
  26–36 (starting at the number the M4 placeholder previously held, task 26); the Milestone 5
  placeholder was therefore renumbered from 27 to 37 (its scope and requirement references are
  unchanged). Milestone 1 tasks (1–10), Milestone 2 tasks (11–18), and Milestone 3 tasks (19–25)
  are not renumbered.
- Note: expanding Milestone 5 into an epic-level breakdown consumed top-level task numbers
  37–44 (starting at the number the M5 placeholder previously held, task 37); this is the final
  milestone, so no later placeholders required renumbering (its scope and requirement references
  are unchanged). Milestone 1 tasks (1–10), Milestone 2 tasks (11–18), Milestone 3 tasks (19–25),
  and Milestone 4 tasks (26–36) are not renumbered.
- Tasks marked with `*` are optional (tests: unit, property-based, RLS/integration) and can be
  skipped for a faster MVP; core implementation tasks are never optional.
- Every task references specific requirement clauses for traceability and, where relevant, the
  design element it realises.
- Property-based tests validate the design's universal Correctness Properties (referenced by
  number); unit and RLS tests validate specific examples, boundaries, and access rules.
- The Milestone 1 checkpoint (task 10) enforces the foundation definition of done before
  Milestone 2 starts; the Milestone 2 checkpoint (task 18) does the same before Milestone 3; the
  Milestone 3 checkpoint (task 25) does the same before Milestone 4; the Milestone 4 checkpoint
  (task 36) does the same before Milestone 5; and the Milestone 5 checkpoint (task 44) verifies
  the final export, hardening, and event-readiness definition of done.
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
    { "id": 32, "tasks": ["25.1"] },

    { "id": 33, "tasks": ["26.1", "26.2", "26.3"] },
    { "id": 34, "tasks": ["26.4", "27.1", "27.2"] },
    { "id": 35, "tasks": ["27.3", "28.1", "28.2"] },
    { "id": 36, "tasks": ["28.3", "29.1"] },
    { "id": 37, "tasks": ["29.2", "29.3", "29.4", "29.5"] },
    { "id": 38, "tasks": ["29.6", "29.7", "30.1", "31.1", "32.1"] },
    { "id": 39, "tasks": ["30.2", "30.3", "31.2", "31.3", "32.2", "33.1"] },
    { "id": 40, "tasks": ["33.2", "33.3", "33.4"] },
    { "id": 41, "tasks": ["34.1", "34.2", "34.3", "34.4"] },
    { "id": 42, "tasks": ["34.5", "35.1", "35.2"] },
    { "id": 43, "tasks": ["36.1"] },

    { "id": 44, "tasks": ["37.1", "39.1", "39.2", "40.1", "41.1", "42.1", "43.1", "43.2"] },
    { "id": 45, "tasks": ["37.2", "37.3", "38.1", "39.3", "39.4", "40.2", "40.3", "42.2"] },
    { "id": 46, "tasks": ["37.4", "38.2", "39.5", "41.2", "41.3", "41.4"] },
    { "id": 47, "tasks": ["38.3", "38.4", "40.4", "42.3"] },
    { "id": 48, "tasks": ["38.5"] },
    { "id": 49, "tasks": ["44.1"] }
  ]
}
```
