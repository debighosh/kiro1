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
