/**
 * Task 4.7 — Milestone 1 schema / migration verification test.
 *
 * WHAT THIS TEST DOES
 * -------------------
 * This is a STATIC, source-level verification of the Milestone 1 Supabase
 * migrations in `supabase/migrations/`. It reads the actual migration SQL files
 * that ship in the repo and asserts, from scratch, that:
 *   - the enum migration defines `event_status`, `moderation_mode` and
 *     `presenter_mode` with exactly the expected values;
 *   - the `events` migration creates an `events` table containing every column
 *     the design requires, and declares the CHECK constraints that reject an
 *     invalid event — an empty / >100-char `name`, `ends_at <= starts_at`, a
 *     `description` over 500 chars, and a `presenter_token` shorter than 32
 *     characters (or non-alphanumeric) — plus UNIQUE on `slug` and
 *     `presenter_token`;
 *   - `admin_profiles` links its PK to `auth.users(id)`;
 *   - `audit_log` has the `change_type` CHECK and the `event_id` FK to
 *     `events(id)`;
 *   - the migration file names are ordered so the schema builds cleanly from a
 *     fresh database (enums before the tables that reference them, `events`
 *     before the tables/functions that reference it).
 *
 * WHY STATIC RATHER THAN A LIVE DATABASE APPLY
 * --------------------------------------------
 * The design's intent for this task is to prove the migrations build the schema
 * from scratch and that the CHECK constraints reject invalid events. The most
 * faithful way to do that is to apply the real SQL to a real PostgreSQL and
 * INSERT good/bad rows. That was investigated for THIS environment and is not
 * feasible here:
 *   - No `psql`, `initdb`, or `supabase` CLI is installed, so a local Postgres
 *     cannot be initialised.
 *   - `pg-mem` (in-process JS Postgres emulator) cannot apply these migrations
 *     as written: it has no `citext` extension and, critically, does NOT
 *     implement the regex match operator `~`. The real `events` table uses
 *     `citext` for `slug` and regex CHECKs for both `slug` and
 *     `presenter_token`, so pg-mem cannot even CREATE the table, let alone
 *     evaluate those constraints. Emulating them in JS would test a fabricated
 *     schema, not the shipped migrations, so that route was rejected.
 *   - A containerised Postgres cannot be started as a background service from
 *     the test runner in this sandbox.
 *
 * A live-DB apply (real INSERTs against the real constraints) is therefore
 * deferred to CI, where a PostgreSQL service is available. This static test is
 * the always-on regression guard: if a future edit drops a column, weakens a
 * CHECK, or reorders the migrations, it fails here regardless of DB access.
 *
 * The assertions are written against the specific constraint SEMANTICS the task
 * calls out (the numeric bounds 1/100/500/32 and the `ends_at > starts_at`
 * comparison), not just the presence of the word "CHECK", so a constraint that
 * was silently loosened (e.g. name length raised, or the token minimum reduced)
 * is caught.
 *
 * Requirements: 1.1, 1.2, 7.3, 22.5, 26.1
 * Design: Data Models; Migrations and seed data.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Locate `supabase/migrations` by walking up from this test file until we find
 * the directory. This keeps the test independent of the process CWD.
 */
function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'supabase', 'migrations');
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('Could not locate supabase/migrations directory');
}

/**
 * Collapse SQL whitespace so multi-line constraint declarations can be matched
 * with simple regexes regardless of how the DDL is line-wrapped/indented.
 */
function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

const MIGRATIONS_DIR = findMigrationsDir();

/** All migration filenames, in the lexicographic order Postgres applies them. */
let migrationFiles: string[] = [];
/** Raw contents keyed by filename. */
const raw: Record<string, string> = {};
/** Whitespace-normalised contents keyed by filename. */
const flat: Record<string, string> = {};
/** Every migration's SQL concatenated (raw and normalised). */
let allSql = '';
let allFlat = '';

beforeAll(() => {
  migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of migrationFiles) {
    const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    raw[f] = content;
    flat[f] = normaliseSql(content);
  }
  allSql = migrationFiles.map((f) => raw[f]).join('\n');
  allFlat = normaliseSql(allSql);
});

const ENUMS_FILE = '20260101000001_enums.sql';
const EVENTS_FILE = '20260101000002_events.sql';
const ADMIN_PROFILES_FILE = '20260101000003_admin_profiles.sql';
const AUDIT_LOG_FILE = '20260101000004_audit_log.sql';

describe('Milestone 1 schema / migrations', () => {
  it('ships the expected Milestone 1 migration files in dependency order', () => {
    // enums must sort first; events before the things that reference it.
    expect(migrationFiles).toContain(ENUMS_FILE);
    expect(migrationFiles).toContain(EVENTS_FILE);
    expect(migrationFiles).toContain(ADMIN_PROFILES_FILE);
    expect(migrationFiles).toContain(AUDIT_LOG_FILE);

    const idx = (f: string) => migrationFiles.indexOf(f);
    // Enums are created before the events table that references them.
    expect(idx(ENUMS_FILE)).toBeLessThan(idx(EVENTS_FILE));
    // events exists before audit_log (whose event_id FK targets events).
    expect(idx(EVENTS_FILE)).toBeLessThan(idx(AUDIT_LOG_FILE));
  });

  describe('enumerated types', () => {
    it('defines event_status with the four lifecycle values', () => {
      const sql = flat[ENUMS_FILE];
      expect(sql).toMatch(/CREATE TYPE event_status AS ENUM \(([^)]*)\)/i);
      const values = sql.match(
        /CREATE TYPE event_status AS ENUM \(([^)]*)\)/i,
      )![1];
      for (const v of ['draft', 'live', 'ended', 'archived']) {
        expect(values).toContain(`'${v}'`);
      }
    });

    it('defines moderation_mode as pre/post', () => {
      const sql = flat[ENUMS_FILE];
      const m = sql.match(/CREATE TYPE moderation_mode AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      expect(m![1]).toContain("'pre'");
      expect(m![1]).toContain("'post'");
    });

    it('defines presenter_mode with all seven presenter view modes', () => {
      const sql = flat[ENUMS_FILE];
      const m = sql.match(/CREATE TYPE presenter_mode AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      for (const v of [
        'join',
        'featured_question',
        'top_questions',
        'poll_results',
        'word_cloud',
        'ai_themes',
        'waiting',
      ]) {
        expect(m![1]).toContain(`'${v}'`);
      }
    });
  });

  describe('events table', () => {
    it('creates the events table', () => {
      expect(flat[EVENTS_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?events \(/i,
      );
    });

    it('declares every column the design requires', () => {
      const sql = flat[EVENTS_FILE];
      const expectedColumns = [
        'id',
        'name',
        'description',
        'slug',
        'status',
        'moderation_mode',
        'starts_at',
        'ends_at',
        'presenter_token',
        'active_presenter_mode',
        'brand_colour',
        'logo_path',
        'stop_words',
        'created_at',
        'updated_at',
      ];
      for (const col of expectedColumns) {
        // Column name followed by a type token (word or citext/uuid/text[] etc).
        expect(sql).toMatch(new RegExp(`\\b${col}\\b\\s+\\w`, 'i'));
      }
    });

    it('constrains name length to 1..100 characters (rejects empty and >100)', () => {
      const sql = flat[EVENTS_FILE];
      // char_length(name) BETWEEN 1 AND 100 (whitespace-insensitive).
      expect(sql).toMatch(
        /CHECK\s*\(\s*char_length\(name\)\s+BETWEEN\s+1\s+AND\s+100\s*\)/i,
      );
    });

    it('constrains description to <= 500 characters when present', () => {
      const sql = flat[EVENTS_FILE];
      expect(sql).toMatch(/char_length\(description\)\s*<=\s*500/i);
    });

    it('requires ends_at to be strictly after starts_at', () => {
      const sql = flat[EVENTS_FILE];
      expect(sql).toMatch(/CHECK\s*\(\s*ends_at\s*>\s*starts_at\s*\)/i);
    });

    it('requires presenter_token to be >=32 chars and alphanumeric', () => {
      const sql = flat[EVENTS_FILE];
      // length floor
      expect(sql).toMatch(/char_length\(presenter_token\)\s*>=\s*32/i);
      // alphanumeric-only regex CHECK
      expect(sql).toMatch(/presenter_token\s*~\s*'\^\[A-Za-z0-9\]\+\$'/i);
    });

    it('constrains slug to the [A-Za-z0-9-] 1..64 format', () => {
      const sql = flat[EVENTS_FILE];
      expect(sql).toMatch(/slug\s*~\s*'\^\[A-Za-z0-9-\]\{1,64\}\$'/i);
    });

    it('marks slug and presenter_token UNIQUE', () => {
      const sql = flat[EVENTS_FILE];
      // slug ... UNIQUE
      expect(sql).toMatch(/\bslug\b[^,]*\bUNIQUE\b/i);
      // presenter_token ... UNIQUE
      expect(sql).toMatch(/\bpresenter_token\b[^,]*\bUNIQUE\b/i);
    });

    it('defaults status to draft and moderation_mode to pre', () => {
      const sql = flat[EVENTS_FILE];
      expect(sql).toMatch(
        /status\s+event_status\s+NOT NULL\s+DEFAULT\s+'draft'/i,
      );
      expect(sql).toMatch(
        /moderation_mode\s+moderation_mode\s+NOT NULL\s+DEFAULT\s+'pre'/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[EVENTS_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });

  describe('idx_events_status index', () => {
    it('creates the status index somewhere in the migrations', () => {
      expect(allFlat).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_events_status ON events \(status\)/i,
      );
    });
  });

  describe('admin_profiles table', () => {
    it('creates admin_profiles keyed to auth.users(id) with cascade delete', () => {
      const sql = flat[ADMIN_PROFILES_FILE];
      expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?admin_profiles \(/i);
      expect(sql).toMatch(/REFERENCES\s+auth\.users\s*\(\s*id\s*\)/i);
      expect(sql).toMatch(/ON DELETE CASCADE/i);
    });
  });

  describe('audit_log table', () => {
    it('creates audit_log with a change_type CHECK over the known change types', () => {
      const sql = flat[AUDIT_LOG_FILE];
      expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?audit_log \(/i);
      // change_type restricted to a known set.
      expect(sql).toMatch(/change_type\s+text\s+NOT NULL/i);
      const m = sql.match(/change_type\s+IN\s*\(([^)]*)\)/i);
      expect(m).not.toBeNull();
      for (const v of [
        'moderation',
        'event_status',
        'ai_endpoint',
        'credential_rotation',
      ]) {
        expect(m![1]).toContain(`'${v}'`);
      }
    });

    it('references events(id) via the event_id foreign key', () => {
      const sql = flat[AUDIT_LOG_FILE];
      expect(sql).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)/i,
      );
    });
  });
});

/**
 * Task 11.4 — Milestone 2 (Core Live Q&A) schema / migration verification.
 *
 * WHAT THIS BLOCK ADDS
 * --------------------
 * This extends the static, source-level migration guard above to cover the
 * Milestone 2 Q&A data model, using the SAME approach as the Milestone-1
 * assertions: it reads the actual migration SQL files that ship in the repo
 * (whitespace-normalised) and asserts, from scratch — WITHOUT a live database —
 * that:
 *   - the `question_status` enum is defined with EXACTLY the five values
 *     pending / approved / featured / answered / hidden;
 *   - the `questions` table is created with every required column, the
 *     `char_length(text) BETWEEN 1 AND 300` CHECK, the `vote_count >= 0` CHECK,
 *     and the `event_id` FK → events(id) ON DELETE CASCADE;
 *   - the questions-indexes migration declares idx_questions_event,
 *     idx_questions_status, idx_questions_created, idx_questions_votes, and the
 *     partial UNIQUE (event_id, submission_key) WHERE submission_key IS NOT NULL;
 *   - `question_votes` is created with the UNIQUE (participant_identifier,
 *     question_id) one-vote rule, the question_id FK → questions(id) ON DELETE
 *     CASCADE, the event_id FK → events(id) ON DELETE CASCADE, and
 *     idx_votes_question;
 *   - the migration file names sort so the schema still builds cleanly from a
 *     fresh database: the questions table migration sorts before its votes
 *     migration (which FK-references questions), and both sort after the
 *     Milestone-1 …000008 migration.
 *
 * As with Milestone 1, a live-DB apply (real INSERTs exercising the CHECKs and
 * the UNIQUE constraint) is DEFERRED TO CI, where a PostgreSQL service is
 * available — no Postgres/psql/pg-mem can faithfully apply these migrations in
 * this sandbox (see the Milestone-1 rationale above). This static block is the
 * always-on regression guard: the assertions match the constraint SEMANTICS
 * (the 1..300 bound, the >= 0 bound, the specific FK targets and cascade, the
 * partial-unique predicate) rather than merely the word "CHECK"/"UNIQUE", so a
 * silent weakening — e.g. raising the 300-char cap, dropping the non-negative
 * guard, or removing the one-vote unique — fails the test here.
 *
 * Requirements: 3.4, 4.3, 22.1, 23.3, 26.1
 * Design: Data Models (`questions`, `question_votes`); Migrations and seed data.
 */
const QUESTIONS_FILE = '20260101000009_questions.sql';
const QUESTIONS_INDEXES_FILE = '20260101000009_questions_indexes.sql';
const QUESTION_VOTES_FILE = '20260101000010_question_votes.sql';
const ADMIN_AUDIT_RLS_FILE = '20260101000008_admin_audit_rls.sql';

describe('Milestone 2 schema / migrations (Q&A tables)', () => {
  it('ships the Q&A migration files ordered so the schema builds from scratch', () => {
    expect(migrationFiles).toContain(QUESTIONS_FILE);
    expect(migrationFiles).toContain(QUESTIONS_INDEXES_FILE);
    expect(migrationFiles).toContain(QUESTION_VOTES_FILE);
    expect(migrationFiles).toContain(ADMIN_AUDIT_RLS_FILE);

    const idx = (f: string) => migrationFiles.indexOf(f);
    // Both Q&A migrations sort AFTER the last Milestone-1 migration (…000008),
    // so the foundation tables/enums they build on already exist.
    expect(idx(ADMIN_AUDIT_RLS_FILE)).toBeLessThan(idx(QUESTIONS_FILE));
    expect(idx(ADMIN_AUDIT_RLS_FILE)).toBeLessThan(idx(QUESTION_VOTES_FILE));
    // The questions table is created before its indexes reference it.
    expect(idx(QUESTIONS_FILE)).toBeLessThan(idx(QUESTIONS_INDEXES_FILE));
    // questions exists before question_votes, whose question_id FK targets it.
    expect(idx(QUESTIONS_FILE)).toBeLessThan(idx(QUESTION_VOTES_FILE));
    expect(idx(QUESTIONS_INDEXES_FILE)).toBeLessThan(idx(QUESTION_VOTES_FILE));
  });

  describe('question_status enum', () => {
    it('defines question_status with exactly the five lifecycle values', () => {
      const sql = flat[QUESTIONS_FILE];
      const m = sql.match(/CREATE TYPE question_status AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = [
        'pending',
        'approved',
        'featured',
        'answered',
        'hidden',
      ];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      // Exactly five values — no more were silently added/removed.
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });
  });

  describe('questions table', () => {
    it('creates the questions table', () => {
      expect(flat[QUESTIONS_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?questions \(/i,
      );
    });

    it('declares every column the design requires', () => {
      const sql = flat[QUESTIONS_FILE];
      const expectedColumns = [
        'id',
        'event_id',
        'text',
        'status',
        'vote_count',
        'ai_category',
        'ai_category_confidence',
        'ai_prior_category',
        'cluster_id',
        'submission_key',
        'created_at',
        'updated_at',
      ];
      for (const col of expectedColumns) {
        // Column name followed by a type token (uuid/text/integer/numeric/etc).
        expect(sql).toMatch(new RegExp(`\\b${col}\\b\\s+\\w`, 'i'));
      }
    });

    it('constrains text length to 1..300 characters (rejects empty and >300)', () => {
      const sql = flat[QUESTIONS_FILE];
      expect(sql).toMatch(
        /CHECK\s*\(\s*char_length\(text\)\s+BETWEEN\s+1\s+AND\s+300\s*\)/i,
      );
    });

    it('requires vote_count to be non-negative', () => {
      const sql = flat[QUESTIONS_FILE];
      expect(sql).toMatch(/CHECK\s*\(\s*vote_count\s*>=\s*0\s*\)/i);
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      const sql = flat[QUESTIONS_FILE];
      // event_id uuid ... REFERENCES events (id) ON DELETE CASCADE
      expect(sql).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[QUESTIONS_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });

  describe('questions indexes migration', () => {
    it('declares idx_questions_event on (event_id)', () => {
      expect(flat[QUESTIONS_INDEXES_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_questions_event ON questions \(event_id\)/i,
      );
    });

    it('declares idx_questions_status on (event_id, status)', () => {
      expect(flat[QUESTIONS_INDEXES_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_questions_status ON questions \(event_id, status\)/i,
      );
    });

    it('declares idx_questions_created on (event_id, created_at)', () => {
      expect(flat[QUESTIONS_INDEXES_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_questions_created ON questions \(event_id, created_at\)/i,
      );
    });

    it('declares idx_questions_votes on (event_id, vote_count DESC)', () => {
      expect(flat[QUESTIONS_INDEXES_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_questions_votes ON questions \(event_id, vote_count DESC\)/i,
      );
    });

    it('declares the partial UNIQUE (event_id, submission_key) WHERE submission_key IS NOT NULL', () => {
      const sql = flat[QUESTIONS_INDEXES_FILE];
      // A UNIQUE index on (event_id, submission_key) that is PARTIAL — enforced
      // only where submission_key IS NOT NULL. The partial predicate is
      // semantically essential (dropping it would break idempotency), so it is
      // asserted explicitly rather than just matching "UNIQUE".
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX (IF NOT EXISTS )?\w+ ON questions \(event_id, submission_key\)\s+WHERE submission_key IS NOT NULL/i,
      );
    });
  });

  describe('question_votes table', () => {
    it('creates the question_votes table', () => {
      expect(flat[QUESTION_VOTES_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?question_votes \(/i,
      );
    });

    it('enforces one vote per participant per question via a UNIQUE constraint', () => {
      const sql = flat[QUESTION_VOTES_FILE];
      // UNIQUE (participant_identifier, question_id) — the authoritative
      // one-vote rule. Column order within the constraint is not significant
      // for uniqueness, but both columns must be present.
      expect(sql).toMatch(
        /UNIQUE\s*\(\s*participant_identifier\s*,\s*question_id\s*\)/i,
      );
    });

    it('references questions(id) via the question_id FK with ON DELETE CASCADE', () => {
      const sql = flat[QUESTION_VOTES_FILE];
      expect(sql).toMatch(
        /question_id\s+uuid[^,]*REFERENCES\s+questions\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      const sql = flat[QUESTION_VOTES_FILE];
      expect(sql).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[QUESTION_VOTES_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });

    it('creates idx_votes_question on (question_id)', () => {
      expect(flat[QUESTION_VOTES_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_votes_question ON question_votes \(question_id\)/i,
      );
    });
  });
});

/**
 * Task 19.5 — Milestone 3 (Polls & Word Cloud) schema / migration verification.
 *
 * WHAT THIS BLOCK ADDS
 * --------------------
 * This extends the static, source-level migration guard above to cover the
 * Milestone 3 Polls & Word Cloud data model, using the SAME approach as the
 * Milestone-1 and Milestone-2 assertions: it reads the actual migration SQL
 * files that ship in the repo (whitespace-normalised via `normaliseSql`) and
 * asserts, from scratch — WITHOUT a live database — that:
 *   - the `poll_status` enum is defined with EXACTLY draft/open/closed, the
 *     `poll_results_visibility` enum with EXACTLY show_always/hide_until_closed,
 *     and the `wordcloud_status` enum with EXACTLY draft/open/closed;
 *   - the `polls` table is created with the `char_length(question_text)
 *     BETWEEN 1 AND 200` CHECK, the `display_order > 0` CHECK, the partial
 *     UNIQUE index `one_open_poll_per_event ON polls(event_id) WHERE
 *     status='open'`, the `event_id` FK → events(id) ON DELETE CASCADE, and
 *     `idx_polls_event`;
 *   - the `poll_options` table is created with the `char_length(text) BETWEEN
 *     1 AND 100` CHECK, the `response_count >= 0` CHECK, the DEFERRABLE
 *     INITIALLY DEFERRED constraint trigger enforcing 2–10 options per poll
 *     (the `enforce_poll_option_count()` function / `trg_poll_options_enforce_count`
 *     trigger with the numeric bounds 2 and 10), and `idx_poll_options_poll`;
 *   - the `poll_responses` table enforces one response per participant per poll
 *     via UNIQUE (participant_identifier, poll_id) and cascades from polls /
 *     events / poll_options via ON DELETE CASCADE FKs;
 *   - the `word_cloud_prompts` table is created with the
 *     `char_length(prompt_text) BETWEEN 1 AND 200` CHECK, the
 *     `max_words_per_response BETWEEN 1 AND 10` CHECK, and the partial UNIQUE
 *     index `one_open_prompt_per_event ON word_cloud_prompts(event_id) WHERE
 *     status='open'`;
 *   - the `word_cloud_responses` table is created with the
 *     `char_length(raw_text) BETWEEN 1 AND 50` CHECK, `is_hidden boolean NOT
 *     NULL DEFAULT false`, `normalised_text` NOT NULL, UNIQUE
 *     (participant_identifier, prompt_id), and cascade FKs to
 *     word_cloud_prompts / events;
 *   - RLS is ENABLED on polls, poll_options, poll_responses, word_cloud_prompts
 *     and word_cloud_responses; the anon SELECT predicates exclude draft polls /
 *     prompts (status IN ('open','closed')) and exclude hidden word-cloud
 *     responses (is_hidden = false); and NO client INSERT/UPDATE/DELETE policy
 *     is defined on poll_responses (server-mediated writes, mirroring the M2
 *     question_votes reasoning);
 *   - all six new migration file names sort AFTER 20260101000016_vote_broadcast.sql
 *     (and in dependency order among themselves) so the schema still builds
 *     cleanly from a fresh database.
 *
 * As with Milestone 1 and 2, a live-DB apply (real INSERTs exercising the
 * CHECKs, the partial-unique indexes, the constraint trigger and the UNIQUE
 * constraints) is DEFERRED TO CI, where a PostgreSQL service is available — no
 * Postgres/psql/pg-mem can faithfully apply these migrations in this sandbox
 * (see the Milestone-1 rationale above). This static block is the always-on
 * regression guard: the assertions match the constraint SEMANTICS (the 1..200 /
 * 1..100 / 1..50 bounds, the 1..10 words bound, the > 0 and >= 0 bounds, the
 * WHERE status='open' partial predicate, the specific FK targets and cascade,
 * the DEFERRABLE trigger and its 2/10 bounds, the is_hidden default and anon
 * exclusions) rather than merely the words "CHECK"/"UNIQUE"/"POLICY", so a
 * silent weakening fails the test here.
 *
 * Requirements: 5.1, 5.5, 5.7, 6.1, 6.5, 6.9, 23.3, 26.1
 * Design: Data Models (`polls`, `poll_options`, `poll_responses`,
 * `word_cloud_prompts`, `word_cloud_responses`); Migrations and seed data.
 */
const VOTE_BROADCAST_FILE = '20260101000016_vote_broadcast.sql';
const POLLS_FILE = '20260101000017_polls.sql';
const POLL_RESPONSES_FILE = '20260101000018_poll_responses.sql';
const WORD_CLOUD_FILE = '20260101000019_word_cloud.sql';
const POLLS_RLS_FILE = '20260101000020_polls_rls.sql';
const POLL_RESPONSES_RLS_FILE = '20260101000021_poll_responses_rls.sql';
const WORD_CLOUD_RLS_FILE = '20260101000022_word_cloud_rls.sql';

describe('Milestone 3 schema / migrations (Polls & Word Cloud tables)', () => {
  it('ships the M3 migration files ordered so the schema builds from scratch', () => {
    for (const f of [
      POLLS_FILE,
      POLL_RESPONSES_FILE,
      WORD_CLOUD_FILE,
      POLLS_RLS_FILE,
      POLL_RESPONSES_RLS_FILE,
      WORD_CLOUD_RLS_FILE,
    ]) {
      expect(migrationFiles).toContain(f);
    }

    const idx = (f: string) => migrationFiles.indexOf(f);
    // Every new M3 migration sorts AFTER the last Milestone-2 migration
    // (…000016_vote_broadcast), so the foundation + Q&A tables/enums/helpers
    // they build on already exist when the schema is applied from scratch.
    for (const f of [
      POLLS_FILE,
      POLL_RESPONSES_FILE,
      WORD_CLOUD_FILE,
      POLLS_RLS_FILE,
      POLL_RESPONSES_RLS_FILE,
      WORD_CLOUD_RLS_FILE,
    ]) {
      expect(idx(VOTE_BROADCAST_FILE)).toBeLessThan(idx(f));
    }

    // polls (+ poll_options, appended to …017) is created before
    // poll_responses, whose poll_id/option_id FKs target polls/poll_options.
    expect(idx(POLLS_FILE)).toBeLessThan(idx(POLL_RESPONSES_FILE));
    // The polls tables exist before their RLS migration references them.
    expect(idx(POLLS_FILE)).toBeLessThan(idx(POLLS_RLS_FILE));
    // poll_responses exists before its RLS migration.
    expect(idx(POLL_RESPONSES_FILE)).toBeLessThan(idx(POLL_RESPONSES_RLS_FILE));
    // The word-cloud tables exist before their RLS migration references them.
    expect(idx(WORD_CLOUD_FILE)).toBeLessThan(idx(WORD_CLOUD_RLS_FILE));
  });

  describe('poll enumerated types', () => {
    it('defines poll_status with exactly draft/open/closed', () => {
      const sql = flat[POLLS_FILE];
      const m = sql.match(/CREATE TYPE poll_status AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = ['draft', 'open', 'closed'];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });

    it('defines poll_results_visibility with exactly show_always/hide_until_closed', () => {
      const sql = flat[POLLS_FILE];
      const m = sql.match(
        /CREATE TYPE poll_results_visibility AS ENUM \(([^)]*)\)/i,
      );
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = ['show_always', 'hide_until_closed'];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });

    it('defines wordcloud_status with exactly draft/open/closed', () => {
      const sql = flat[WORD_CLOUD_FILE];
      const m = sql.match(/CREATE TYPE wordcloud_status AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = ['draft', 'open', 'closed'];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });
  });

  describe('polls table', () => {
    it('creates the polls table', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?polls \(/i,
      );
    });

    it('constrains question_text length to 1..200 characters', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(question_text\)\s+BETWEEN\s+1\s+AND\s+200\s*\)/i,
      );
    });

    it('requires display_order to be strictly positive (> 0)', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CHECK\s*\(\s*display_order\s*>\s*0\s*\)/i,
      );
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('declares the one_open_poll_per_event partial UNIQUE index WHERE status=open', () => {
      // The partial predicate is the whole point: dropping it would allow
      // multiple open polls per event, so it is asserted explicitly.
      expect(flat[POLLS_FILE]).toMatch(
        /CREATE UNIQUE INDEX (IF NOT EXISTS )?one_open_poll_per_event\s+ON polls \(event_id\)\s+WHERE status = 'open'/i,
      );
    });

    it('creates idx_polls_event on (event_id)', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_polls_event ON polls \(event_id\)/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[POLLS_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });

  describe('poll_options table', () => {
    it('creates the poll_options table', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?poll_options \(/i,
      );
    });

    it('constrains text length to 1..100 characters', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(text\)\s+BETWEEN\s+1\s+AND\s+100\s*\)/i,
      );
    });

    it('requires response_count to be non-negative (>= 0)', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CHECK\s*\(\s*response_count\s*>=\s*0\s*\)/i,
      );
    });

    it('references polls(id) via the poll_id FK with ON DELETE CASCADE', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /poll_id\s+uuid[^,]*REFERENCES\s+polls\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('creates idx_poll_options_poll on (poll_id)', () => {
      expect(flat[POLLS_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_poll_options_poll ON poll_options \(poll_id\)/i,
      );
    });

    it('enforces 2..10 options per poll via a DEFERRABLE constraint trigger', () => {
      const sql = flat[POLLS_FILE];
      // A plain CHECK cannot count sibling rows, so the 2–10 rule is a
      // CONSTRAINT TRIGGER. Assert the function, the trigger, the DEFERRABLE
      // INITIALLY DEFERRED clause, and that both numeric bounds (2 and 10)
      // appear in the enforcement logic.
      expect(sql).toMatch(
        /CREATE (OR REPLACE )?FUNCTION enforce_poll_option_count\(\)/i,
      );
      expect(sql).toMatch(
        /CREATE CONSTRAINT TRIGGER trg_poll_options_enforce_count/i,
      );
      expect(sql).toMatch(/DEFERRABLE INITIALLY DEFERRED/i);
      // The lower/upper bounds of the count check (v_count < 2 OR v_count > 10).
      expect(sql).toMatch(/<\s*2\b/);
      expect(sql).toMatch(/>\s*10\b/);
    });
  });

  describe('poll_responses table', () => {
    it('creates the poll_responses table', () => {
      expect(flat[POLL_RESPONSES_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?poll_responses \(/i,
      );
    });

    it('enforces one response per participant per poll via UNIQUE (participant_identifier, poll_id)', () => {
      expect(flat[POLL_RESPONSES_FILE]).toMatch(
        /UNIQUE\s*\(\s*participant_identifier\s*,\s*poll_id\s*\)/i,
      );
    });

    it('references polls(id) via the poll_id FK with ON DELETE CASCADE', () => {
      expect(flat[POLL_RESPONSES_FILE]).toMatch(
        /poll_id\s+uuid[^,]*REFERENCES\s+polls\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      expect(flat[POLL_RESPONSES_FILE]).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('references poll_options(id) via the option_id FK with ON DELETE CASCADE', () => {
      expect(flat[POLL_RESPONSES_FILE]).toMatch(
        /option_id\s+uuid[^,]*REFERENCES\s+poll_options\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[POLL_RESPONSES_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });

  describe('word_cloud_prompts table', () => {
    it('creates the word_cloud_prompts table', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?word_cloud_prompts \(/i,
      );
    });

    it('constrains prompt_text length to 1..200 characters', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(prompt_text\)\s+BETWEEN\s+1\s+AND\s+200\s*\)/i,
      );
    });

    it('constrains max_words_per_response to 1..10', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /CHECK\s*\(\s*max_words_per_response\s+BETWEEN\s+1\s+AND\s+10\s*\)/i,
      );
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('declares the one_open_prompt_per_event partial UNIQUE index WHERE status=open', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /CREATE UNIQUE INDEX (IF NOT EXISTS )?one_open_prompt_per_event\s+ON word_cloud_prompts \(event_id\)\s+WHERE status = 'open'/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });

  describe('word_cloud_responses table', () => {
    it('creates the word_cloud_responses table', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?word_cloud_responses \(/i,
      );
    });

    it('constrains raw_text length to 1..50 characters', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(raw_text\)\s+BETWEEN\s+1\s+AND\s+50\s*\)/i,
      );
    });

    it('defaults is_hidden to false (boolean NOT NULL DEFAULT false)', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /is_hidden\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i,
      );
    });

    it('requires normalised_text to be NOT NULL', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /normalised_text\s+text\s+NOT NULL/i,
      );
    });

    it('enforces one response per participant per prompt via UNIQUE (participant_identifier, prompt_id)', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /UNIQUE\s*\(\s*participant_identifier\s*,\s*prompt_id\s*\)/i,
      );
    });

    it('references word_cloud_prompts(id) via the prompt_id FK with ON DELETE CASCADE', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /prompt_id\s+uuid[^,]*REFERENCES\s+word_cloud_prompts\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[WORD_CLOUD_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });

  describe('Milestone 3 RLS', () => {
    it('enables RLS on polls and poll_options', () => {
      const sql = flat[POLLS_RLS_FILE];
      expect(sql).toMatch(/ALTER TABLE polls\s+ENABLE ROW LEVEL SECURITY/i);
      expect(sql).toMatch(
        /ALTER TABLE poll_options\s+ENABLE ROW LEVEL SECURITY/i,
      );
    });

    it('enables RLS on poll_responses', () => {
      expect(flat[POLL_RESPONSES_RLS_FILE]).toMatch(
        /ALTER TABLE poll_responses\s+ENABLE ROW LEVEL SECURITY/i,
      );
    });

    it('enables RLS on word_cloud_prompts and word_cloud_responses', () => {
      const sql = flat[WORD_CLOUD_RLS_FILE];
      expect(sql).toMatch(
        /ALTER TABLE word_cloud_prompts\s+ENABLE ROW LEVEL SECURITY/i,
      );
      expect(sql).toMatch(
        /ALTER TABLE word_cloud_responses\s+ENABLE ROW LEVEL SECURITY/i,
      );
    });

    it('excludes draft polls from the anon SELECT predicate (status IN open/closed)', () => {
      // The security-critical guarantee: draft polls never reach the audience.
      expect(flat[POLLS_RLS_FILE]).toMatch(/status IN \('open', 'closed'\)/i);
    });

    it('excludes draft prompts from the anon word_cloud_prompts predicate', () => {
      expect(flat[WORD_CLOUD_RLS_FILE]).toMatch(
        /status IN \('open', 'closed'\)/i,
      );
    });

    it('excludes hidden responses from the anon word_cloud_responses predicate (is_hidden = false)', () => {
      expect(flat[WORD_CLOUD_RLS_FILE]).toMatch(/is_hidden = false/i);
    });

    it('defines NO client INSERT/UPDATE/DELETE policy on poll_responses (server-mediated writes)', () => {
      // Mirrors the M2 question_votes reasoning: response writes flow through
      // the SECURITY DEFINER upsert-replace RPC / service role, so there must
      // be no client write policy on the table.
      const sql = flat[POLL_RESPONSES_RLS_FILE];
      expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR INSERT/i);
      expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR UPDATE/i);
      expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR DELETE/i);
    });
  });
});

/**
 * Task 26.4 — Milestone 4 (AI Features) schema / migration verification.
 *
 * WHAT THIS BLOCK ADDS
 * --------------------
 * This extends the static, source-level migration guard above to cover the
 * Milestone 4 AI data model, using the SAME approach as the Milestone-1/2/3
 * assertions: it reads the actual migration SQL files that ship in the repo
 * (whitespace-normalised via `normaliseSql` + `flat[FILENAME]`) and asserts,
 * from scratch — WITHOUT a live database — that:
 *   - the four M4 enums are defined with EXACTLY the expected values:
 *       * provider_type ('openai_compatible','custom_adapter'),
 *       * ai_auth_type  ('bearer','api_key_header','none'),
 *       * ai_job_type   ('categorisation','clustering','theme_insights',
 *                        'summary','connection_test'),
 *       * ai_job_status ('pending','running','succeeded','failed')
 *     (all in 20260101000030_ai_provider_settings.sql);
 *   - the `ai_provider_settings` table declares the design's CHECK semantics:
 *     display_name 1..100, base_url 1..2048 AND an absolute-URL regex CHECK
 *     (base_url ~ '^https?://'), chat_completions_path 1..512, model_id 1..200,
 *     temperature BETWEEN 0.0 AND 2.0, max_output_tokens BETWEEN 1 AND 128000,
 *     request_timeout_seconds BETWEEN 1 AND 300, tls_verify_required DEFAULT
 *     true; the partial UNIQUE index `one_active_ai_provider ON
 *     ai_provider_settings(is_active) WHERE is_active`; the credential XOR CHECK
 *     `num_nonnulls(secret_reference, encrypted_credential) <= 1`; and the
 *     GENERATED `credential_state ... GENERATED ALWAYS AS ... STORED` column;
 *   - `ai_jobs` (20260101000031_ai_jobs.sql) has job_type ai_job_type / status
 *     ai_job_status columns, an event_id FK → events(id) ON DELETE CASCADE, the
 *     `attempt_count >= 0` CHECK, and idx_ai_jobs_event;
 *   - `question_clusters` (20260101000032_question_clusters.sql) has the
 *     `char_length(label) BETWEEN 1 AND 100` CHECK, the event_id FK → events(id)
 *     ON DELETE CASCADE, and the DEFERRED FK attached to the existing
 *     questions.cluster_id column (ALTER TABLE questions ... FOREIGN KEY
 *     (cluster_id) REFERENCES question_clusters (id) ON DELETE SET NULL);
 *   - all three M4 migration file names sort AFTER
 *     20260101000029_poll_broadcast.sql, and in intra-M4 dependency order
 *     (…030 before …031 before …032) so the schema builds cleanly from a fresh
 *     database: …030 defines the ai_job enums …031 uses, and …032's deferred FK
 *     references the question_clusters table it just created.
 *
 * As with Milestone 1/2/3, a live-DB apply (real INSERTs exercising the CHECKs,
 * the partial-unique index, the XOR and the generated column) is DEFERRED TO CI,
 * where a PostgreSQL service is available — no Postgres/psql/pg-mem can
 * faithfully apply these migrations in this sandbox (see the Milestone-1
 * rationale above). This static block is the always-on regression guard: the
 * assertions match the constraint SEMANTICS (the numeric bounds, the absolute
 * URL regex, the WHERE is_active partial predicate, the num_nonnulls XOR, the
 * GENERATED ... STORED clause, the specific FK targets/cascades and the SET
 * NULL deferred FK) rather than merely the word "CHECK", so a silent weakening
 * fails the test here.
 *
 * Requirements: 11.1, 11.5, 11.7, 11.8, 11.9, 12.6, 14.6, 16.1, 16.4, 16.9,
 * 19.3, 20.6, 26.1
 * Design: Data Models (`ai_provider_settings`, `ai_jobs`, `question_clusters`);
 * Enumerated types; credential XOR CHECK; deferred cluster FK; Migrations.
 */
const POLL_BROADCAST_FILE = '20260101000029_poll_broadcast.sql';
const AI_PROVIDER_SETTINGS_FILE = '20260101000030_ai_provider_settings.sql';
const AI_JOBS_FILE = '20260101000031_ai_jobs.sql';
const QUESTION_CLUSTERS_FILE = '20260101000032_question_clusters.sql';

describe('Milestone 4 schema / migrations (AI tables)', () => {
  it('ships the M4 migration files ordered so the schema builds from scratch', () => {
    for (const f of [
      AI_PROVIDER_SETTINGS_FILE,
      AI_JOBS_FILE,
      QUESTION_CLUSTERS_FILE,
    ]) {
      expect(migrationFiles).toContain(f);
    }

    const idx = (f: string) => migrationFiles.indexOf(f);
    // Every M4 migration sorts AFTER the last Milestone-3 migration
    // (…000029_poll_broadcast), so the foundation + Q&A + polls tables/enums/
    // helpers they build on already exist when applied from scratch.
    for (const f of [
      AI_PROVIDER_SETTINGS_FILE,
      AI_JOBS_FILE,
      QUESTION_CLUSTERS_FILE,
    ]) {
      expect(idx(POLL_BROADCAST_FILE)).toBeLessThan(idx(f));
    }

    // …030 defines the ai_job_type / ai_job_status enums that …031's ai_jobs
    // columns reference, so it must sort before …031.
    expect(idx(AI_PROVIDER_SETTINGS_FILE)).toBeLessThan(idx(AI_JOBS_FILE));
    // …032 creates question_clusters and then attaches the deferred FK that
    // references it, so it must sort after …031 (intra-M4 order …030<…031<…032).
    expect(idx(AI_JOBS_FILE)).toBeLessThan(idx(QUESTION_CLUSTERS_FILE));
  });

  describe('AI enumerated types', () => {
    it('defines provider_type with exactly openai_compatible/custom_adapter', () => {
      const sql = flat[AI_PROVIDER_SETTINGS_FILE];
      const m = sql.match(/CREATE TYPE provider_type AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = ['openai_compatible', 'custom_adapter'];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });

    it('defines ai_auth_type with exactly bearer/api_key_header/none', () => {
      const sql = flat[AI_PROVIDER_SETTINGS_FILE];
      const m = sql.match(/CREATE TYPE ai_auth_type AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = ['bearer', 'api_key_header', 'none'];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });

    it('defines ai_job_type with exactly the five job categories', () => {
      const sql = flat[AI_PROVIDER_SETTINGS_FILE];
      const m = sql.match(/CREATE TYPE ai_job_type AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = [
        'categorisation',
        'clustering',
        'theme_insights',
        'summary',
        'connection_test',
      ];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });

    it('defines ai_job_status with exactly pending/running/succeeded/failed', () => {
      const sql = flat[AI_PROVIDER_SETTINGS_FILE];
      const m = sql.match(/CREATE TYPE ai_job_status AS ENUM \(([^)]*)\)/i);
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = ['pending', 'running', 'succeeded', 'failed'];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });
  });

  describe('ai_provider_settings table', () => {
    it('creates the ai_provider_settings table', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?ai_provider_settings \(/i,
      );
    });

    it('constrains display_name length to 1..100 characters', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(display_name\)\s+BETWEEN\s+1\s+AND\s+100\s*\)/i,
      );
    });

    it('constrains base_url length to 1..2048 characters', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(base_url\)\s+BETWEEN\s+1\s+AND\s+2048\s*\)/i,
      );
    });

    it('requires base_url to be an absolute http(s) URL via a regex CHECK', () => {
      // The absolute-URL guard is security/correctness-relevant (rejects
      // relative or non-http schemes), so it is asserted explicitly rather
      // than only checking the length bound.
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*base_url\s*~\s*'\^https\?:\/\/'\s*\)/i,
      );
    });

    it('constrains chat_completions_path length to 1..512 characters', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(chat_completions_path\)\s+BETWEEN\s+1\s+AND\s+512\s*\)/i,
      );
    });

    it('constrains model_id length to 1..200 characters', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(model_id\)\s+BETWEEN\s+1\s+AND\s+200\s*\)/i,
      );
    });

    it('constrains temperature to the range 0.0..2.0', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*temperature\s+BETWEEN\s+0\.0\s+AND\s+2\.0\s*\)/i,
      );
    });

    it('constrains max_output_tokens to the range 1..128000', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*max_output_tokens\s+BETWEEN\s+1\s+AND\s+128000\s*\)/i,
      );
    });

    it('constrains request_timeout_seconds to the range 1..300', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*request_timeout_seconds\s+BETWEEN\s+1\s+AND\s+300\s*\)/i,
      );
    });

    it('defaults tls_verify_required to true (boolean NOT NULL DEFAULT true)', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /tls_verify_required\s+boolean\s+NOT NULL\s+DEFAULT\s+true/i,
      );
    });

    it('declares the one_active_ai_provider partial UNIQUE index WHERE is_active', () => {
      // The partial predicate is the whole point: dropping WHERE is_active
      // would forbid more than one row entirely (including historical
      // inactive configs), so the predicate is asserted explicitly.
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CREATE UNIQUE INDEX (IF NOT EXISTS )?one_active_ai_provider\s+ON ai_provider_settings \(is_active\)\s+WHERE is_active/i,
      );
    });

    it('enforces the credential XOR via num_nonnulls(...) <= 1', () => {
      // secret_reference and encrypted_credential are never BOTH populated —
      // assert the exact num_nonnulls semantics rather than just "CHECK".
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /CHECK\s*\(\s*num_nonnulls\(\s*secret_reference\s*,\s*encrypted_credential\s*\)\s*<=\s*1\s*\)/i,
      );
    });

    it('declares credential_state as a GENERATED ALWAYS ... STORED column', () => {
      // The state is a derived, always-stored column — never a client-writable
      // one — so assert the GENERATED ALWAYS AS ... STORED clause explicitly.
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /credential_state\s+text\s+GENERATED ALWAYS AS \(.*\) STORED/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[AI_PROVIDER_SETTINGS_FILE]).toMatch(
        /\bid\b[^,]*PRIMARY KEY/i,
      );
    });
  });

  describe('ai_jobs table', () => {
    it('creates the ai_jobs table', () => {
      expect(flat[AI_JOBS_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?ai_jobs \(/i,
      );
    });

    it('types job_type as ai_job_type and status as ai_job_status', () => {
      const sql = flat[AI_JOBS_FILE];
      expect(sql).toMatch(/job_type\s+ai_job_type\s+NOT NULL/i);
      expect(sql).toMatch(/status\s+ai_job_status\s+NOT NULL/i);
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      expect(flat[AI_JOBS_FILE]).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('requires attempt_count to be non-negative (>= 0)', () => {
      expect(flat[AI_JOBS_FILE]).toMatch(
        /CHECK\s*\(\s*attempt_count\s*>=\s*0\s*\)/i,
      );
    });

    it('creates idx_ai_jobs_event on (event_id)', () => {
      expect(flat[AI_JOBS_FILE]).toMatch(
        /CREATE INDEX (IF NOT EXISTS )?idx_ai_jobs_event\s+ON ai_jobs \(event_id\)/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[AI_JOBS_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });

  describe('question_clusters table', () => {
    it('creates the question_clusters table', () => {
      expect(flat[QUESTION_CLUSTERS_FILE]).toMatch(
        /CREATE TABLE (IF NOT EXISTS )?question_clusters \(/i,
      );
    });

    it('constrains label length to 1..100 characters', () => {
      expect(flat[QUESTION_CLUSTERS_FILE]).toMatch(
        /CHECK\s*\(\s*char_length\(label\)\s+BETWEEN\s+1\s+AND\s+100\s*\)/i,
      );
    });

    it('references events(id) via the event_id FK with ON DELETE CASCADE', () => {
      expect(flat[QUESTION_CLUSTERS_FILE]).toMatch(
        /event_id\s+uuid[^,]*REFERENCES\s+events\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i,
      );
    });

    it('attaches the deferred questions.cluster_id FK → question_clusters(id) ON DELETE SET NULL', () => {
      // The M2 questions migration left cluster_id as a plain nullable uuid;
      // this migration adds the FK once question_clusters exists. ON DELETE SET
      // NULL (NOT CASCADE) is the semantically essential behaviour — deleting a
      // cluster clears, rather than deletes, its member questions.
      expect(flat[QUESTION_CLUSTERS_FILE]).toMatch(
        /ALTER TABLE questions\s+ADD CONSTRAINT \w+\s+FOREIGN KEY \(cluster_id\)\s+REFERENCES question_clusters \(id\)\s+ON DELETE SET NULL/i,
      );
    });

    it('declares id as the primary key', () => {
      expect(flat[QUESTION_CLUSTERS_FILE]).toMatch(/\bid\b[^,]*PRIMARY KEY/i);
    });
  });
});

/**
 * Task 39.1 — Milestone 5 (Hardening & Readiness) rate-limit-action migration
 * verification.
 *
 * WHAT THIS BLOCK ADDS
 * --------------------
 * This extends the static, source-level migration guard above to cover the
 * Milestone 5 rate-limit-action extension, using the SAME approach as the
 * Milestone-1..4 assertions: it reads the actual migration SQL files that ship
 * in the repo (whitespace-normalised via `normaliseSql`) and asserts, from
 * scratch — WITHOUT a live database — that:
 *   - `20260101000035_rate_limit_actions.sql` exists and sorts AFTER the latest
 *     Milestone-4 migration `20260101000034_ai_jobs_clusters_rls.sql`, so the
 *     rate_events table + check_and_record_rate_limit primitives + the two
 *     respond RPCs it widens/re-creates all exist when it is applied from
 *     scratch;
 *   - the `rate_events_action_chk` CHECK is re-declared (DROP IF EXISTS + ADD)
 *     to permit EXACTLY the four action values 'submit_question', 'vote',
 *     'poll_respond' and 'word_cloud_respond' — the two new dedicated respond
 *     actions are present ALONGSIDE the original two (a silent removal of the
 *     originals or absence of a new one fails here);
 *   - BOTH check_and_record_rate_limit allow-list guards (the `IN (...)`
 *     predicate) list all four actions including the two new respond actions,
 *     so the primitive no longer returns FALSE for them;
 *   - `submit_poll_response` is re-created (CREATE OR REPLACE) and now passes
 *     the dedicated 'poll_respond' action to check_and_record_rate_limit —
 *     and, crucially, STILL PERFORMs broadcast_poll_results so the Task 21.4
 *     poll-results broadcast added in …000029 is not regressed;
 *   - `submit_word_cloud_response` is re-created (CREATE OR REPLACE) and now
 *     passes the dedicated 'word_cloud_respond' action to
 *     check_and_record_rate_limit;
 *   - neither respond RPC still routes its rate limit through the shared 'vote'
 *     bucket in this migration (the switch to the dedicated buckets is
 *     complete).
 *
 * As with Milestone 1/2/3/4, a live-DB apply (actually exceeding a limit and
 * observing that nothing is recorded, and that poll/word-cloud/vote counters no
 * longer contend) is DEFERRED TO CI, where a PostgreSQL service is available —
 * no Postgres/psql/pg-mem can faithfully apply these migrations in this sandbox
 * (see the Milestone-1 rationale above). This static block is the always-on
 * regression guard: the assertions match the SEMANTICS (the exact four allowed
 * action values, the dedicated action argument each RPC now passes, and the
 * preserved poll broadcast) rather than merely the word "CHECK", so a silent
 * regression — dropping a new action, reverting an RPC to the 'vote' bucket, or
 * losing the poll broadcast — fails the test here.
 *
 * Requirements: 21.13, 21.15, 26.1
 * Design: RLS Design (Server-side rate limiting); Request/data flows
 * (submit / vote / respond); Decision D8.
 */
const AI_JOBS_CLUSTERS_RLS_FILE = '20260101000034_ai_jobs_clusters_rls.sql';
const RATE_LIMIT_ACTIONS_FILE = '20260101000035_rate_limit_actions.sql';

describe('Milestone 5 schema / migrations (rate-limit actions)', () => {
  it('ships the M5 rate-limit-actions migration after the last M4 migration', () => {
    expect(migrationFiles).toContain(RATE_LIMIT_ACTIONS_FILE);
    expect(migrationFiles).toContain(AI_JOBS_CLUSTERS_RLS_FILE);

    const idx = (f: string) => migrationFiles.indexOf(f);
    // The rate-limit-actions migration sorts AFTER the latest M4 migration
    // (…000034_ai_jobs_clusters_rls), so rate_events, the rate-limit primitives
    // and the two respond RPCs it widens/re-creates already exist when applied
    // from scratch.
    expect(idx(AI_JOBS_CLUSTERS_RLS_FILE)).toBeLessThan(
      idx(RATE_LIMIT_ACTIONS_FILE),
    );
  });

  describe('rate_events action CHECK widening', () => {
    it('re-declares rate_events_action_chk via DROP IF EXISTS + ADD (idempotent)', () => {
      const sql = flat[RATE_LIMIT_ACTIONS_FILE];
      expect(sql).toMatch(
        /ALTER TABLE rate_events DROP CONSTRAINT IF EXISTS rate_events_action_chk/i,
      );
      expect(sql).toMatch(
        /ALTER TABLE rate_events ADD CONSTRAINT rate_events_action_chk\s+CHECK \(action IN \(/i,
      );
    });

    it('permits exactly the four action values incl. the two new dedicated respond actions', () => {
      const sql = flat[RATE_LIMIT_ACTIONS_FILE];
      // The widened CHECK lists all four allowed action values. The two new
      // dedicated buckets must be present ALONGSIDE the original submit/vote
      // actions — dropping either original, or omitting a new one, fails here.
      const m = sql.match(
        /ADD CONSTRAINT rate_events_action_chk\s+CHECK \(action IN \(([^)]*)\)\)/i,
      );
      expect(m).not.toBeNull();
      const values = m![1];
      const expected = [
        'submit_question',
        'vote',
        'poll_respond',
        'word_cloud_respond',
      ];
      for (const v of expected) {
        expect(values).toContain(`'${v}'`);
      }
      const quoted = values.match(/'[^']+'/g) ?? [];
      expect(quoted).toHaveLength(expected.length);
    });
  });

  describe('check_and_record_rate_limit allow-list widening', () => {
    it('widens BOTH overload allow-list guards to include the two new respond actions', () => {
      const sql = flat[RATE_LIMIT_ACTIONS_FILE];
      // Both overloads are re-created; each has an `IF p_action NOT IN (...)`
      // guard that must now list all four actions. There are two such guards
      // (5-arg + 6-arg-with-fingerprint) — assert both mention the new buckets.
      const guards = sql.match(
        /p_action NOT IN \('submit_question', 'vote', 'poll_respond', 'word_cloud_respond'\)/gi,
      );
      expect(guards).not.toBeNull();
      expect(guards!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('respond RPCs rewired to dedicated buckets', () => {
    it('re-creates submit_poll_response using the dedicated poll_respond action', () => {
      const sql = flat[RATE_LIMIT_ACTIONS_FILE];
      // The poll-response RPC is re-created and now passes 'poll_respond' as the
      // action argument to the shared limiter (previously 'vote').
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION submit_poll_response\(/i);
      expect(sql).toMatch(
        /check_and_record_rate_limit\(\s*p_participant_identifier,\s*'poll_respond',/i,
      );
    });

    it('preserves the Task 21.4 poll-results broadcast in the re-created submit_poll_response', () => {
      // Re-creating submit_poll_response must NOT regress the broadcast added in
      // …000029 — the re-created body must still PERFORM broadcast_poll_results.
      expect(flat[RATE_LIMIT_ACTIONS_FILE]).toMatch(
        /PERFORM broadcast_poll_results\(v_event_id, p_poll_id\)/i,
      );
    });

    it('re-creates submit_word_cloud_response using the dedicated word_cloud_respond action', () => {
      const sql = flat[RATE_LIMIT_ACTIONS_FILE];
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION submit_word_cloud_response\(/i,
      );
      expect(sql).toMatch(
        /check_and_record_rate_limit\(\s*p_participant_identifier,\s*'word_cloud_respond',/i,
      );
    });

    it('no longer routes either respond RPC through the shared vote bucket in this migration', () => {
      const sql = flat[RATE_LIMIT_ACTIONS_FILE];
      // After the switch, this migration's respond-RPC rate-limit calls use the
      // dedicated buckets; there must be NO `check_and_record_rate_limit(
      // p_participant_identifier, 'vote', ...)` call left in the re-created RPCs.
      expect(sql).not.toMatch(
        /check_and_record_rate_limit\(\s*p_participant_identifier,\s*'vote',/i,
      );
    });
  });
});
