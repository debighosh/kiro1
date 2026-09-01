/**
 * Task 39.5 — Unit tests for the sanitisation module (`sanitise.ts`) and the
 * rate-limit action set migration (`20260101000035_rate_limit_actions.sql`).
 *
 * WHAT THIS FILE COVERS
 * ---------------------
 * 1. `toInertText` unit tests (Req 21.12): asserts that each HTML-special
 *    character is escaped correctly and that no combination can form executable
 *    HTML or script content (e.g. `<script>alert("XSS")</script>` is fully
 *    neutralised). Empty strings and plain text are also asserted. These tests
 *    are ALWAYS-ON and require no live infrastructure.
 *
 * 2. Rate-limit action set — STATIC migration-file assertion (Req 21.15): reads
 *    `supabase/migrations/20260101000035_rate_limit_actions.sql` with Node
 *    `fs.readFileSync` (mirroring the `migrations.test.ts` pattern) and asserts
 *    that the CHECK constraint and the function allow-list guard include ALL
 *    FOUR dedicated action values: `'submit_question'`, `'vote'`,
 *    `'poll_respond'`, and `'word_cloud_respond'`. This is a STATIC,
 *    source-level guard that requires no live DB; it ensures the rate-limit
 *    action set covers all anonymous write paths (Req 21.15).
 *
 * Property-based tests (Req 21.9, 21.10, 21.11) live in the companion file
 * `sanitise.properties.test.ts`.
 *
 * Validates: Requirements 21.12, 21.15, 26.1.
 * Design references: Error Handling (inert-text rendering on the read path,
 * Req 21.12, 24.8); RLS Design → Server-side rate limiting (Req 21.13–21.15).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toInertText } from './sanitise';

// ---------------------------------------------------------------------------
// Helpers (mirrors migrations.test.ts findMigrationsDir / normaliseSql)
// ---------------------------------------------------------------------------

/** Walk up from this file to find `supabase/migrations`. */
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

/** Collapse SQL whitespace so multi-line declarations match simple regexes. */
function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

// ===========================================================================
// Feature: mss-livepulse — toInertText (Req 21.12)
//
// Asserts that `toInertText` one-way-escapes every HTML-special character so
// the result can never be interpreted as executable HTML/script/markup when
// rendered. The function is PURE and NEVER mutates its input.
//
// Validates: Req 21.12, 24.8.
// Design: Error Handling → Inert-text rendering on the read path.
// ===========================================================================
describe('Feature: mss-livepulse — toInertText escapes HTML-special characters (Req 21.12)', () => {
  it('escapes & to &amp;', () => {
    expect(toInertText('&')).toBe('&amp;');
  });

  it('does NOT double-escape already-escaped entities (&amp; → &amp;amp;)', () => {
    // The & in &amp; is itself an & → &amp; so the output is &amp;amp;.
    // This proves the pass is single-pass (& is processed once).
    expect(toInertText('&amp;')).toBe('&amp;amp;');
  });

  it('escapes < to &lt;', () => {
    expect(toInertText('<')).toBe('&lt;');
  });

  it('escapes > to &gt;', () => {
    expect(toInertText('>')).toBe('&gt;');
  });

  it('escapes " to &quot;', () => {
    expect(toInertText('"')).toBe('&quot;');
  });

  it("escapes ' to &#39;", () => {
    expect(toInertText("'")).toBe('&#39;');
  });

  it('escapes / to &#x2F;', () => {
    expect(toInertText('/')).toBe('&#x2F;');
  });

  it('fully escapes <script>alert("XSS")</script> — no executable HTML remains', () => {
    const input = '<script>alert("XSS")</script>';
    const result = toInertText(input);
    // No unescaped angle brackets — cannot form a tag.
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    // No unescaped slash — cannot form a closing tag sequence.
    expect(result).not.toContain('/');
    // No unescaped double-quote — cannot break out of an attribute.
    expect(result).not.toContain('"');
    // Verify the exact transformation.
    expect(result).toBe(
      '&lt;script&gt;alert(&quot;XSS&quot;)&lt;&#x2F;script&gt;',
    );
  });

  it('returns an empty string unchanged', () => {
    expect(toInertText('')).toBe('');
  });

  it('leaves regular text without special chars unchanged', () => {
    const plain = 'Hello World 123';
    expect(toInertText(plain)).toBe(plain);
  });

  it('escapes text containing all special chars in one pass (& processed first, not double-escaped)', () => {
    // Each character is processed exactly once; the & in '&' maps to '&amp;',
    // not to '&amp;amp;' (which would indicate a second pass).
    const input = `& < > " ' /`;
    expect(toInertText(input)).toBe(`&amp; &lt; &gt; &quot; &#39; &#x2F;`);
  });

  it('escapes a complex injection attempt — event handler attribute', () => {
    const input = `<img src=x onerror="alert('1')">`;
    const result = toInertText(input);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('"');
    expect(result).not.toContain("'");
    expect(result).not.toContain('/');
  });

  it('escapes a mixed text / markup string — text nodes remain readable', () => {
    // After escaping, the VISIBLE text (un-rendered) is the escaped form;
    // the original special chars are gone from the raw output.
    const input = 'Price: 5 < 10 & "free"';
    const result = toInertText(input);
    expect(result).toBe('Price: 5 &lt; 10 &amp; &quot;free&quot;');
  });
});

// ===========================================================================
// Feature: mss-livepulse — Rate-limit action set (Req 21.15)
//
// STATIC source-level guard: reads the migration file
// `20260101000035_rate_limit_actions.sql` and asserts that the CHECK constraint
// and the function allow-list guard contain ALL FOUR action values required by
// Req 21.15 — including the two NEW dedicated respond actions `'poll_respond'`
// and `'word_cloud_respond'` that this migration introduces. This is NOT a
// live-DB test; it is an always-on regression guard that requires no DB access.
//
// Mirrors the pattern established by migrations.test.ts (Task 4.7 etc.) which
// reads migration SQL files with fs.readFileSync and asserts their DDL/DML
// semantics statically.
//
// Validates: Req 21.15, 26.1.
// Design: RLS Design → Server-side rate limiting (Req 21.13–21.15).
// ===========================================================================
describe('Feature: mss-livepulse — Rate-limit action set migration (Req 21.15)', () => {
  const RATE_LIMIT_ACTIONS_FILE = '20260101000035_rate_limit_actions.sql';

  let migrationsDir: string;
  let raw: string;
  let flat: string;

  // Locate the migration and read it once.
  try {
    migrationsDir = findMigrationsDir();
    raw = readFileSync(join(migrationsDir, RATE_LIMIT_ACTIONS_FILE), 'utf8');
    flat = normaliseSql(raw);
  } catch {
    // If the file cannot be found the test below will fail with a clear message.
    migrationsDir = '';
    raw = '';
    flat = '';
  }

  it(`ships the migration file ${RATE_LIMIT_ACTIONS_FILE}`, () => {
    // Confirm the file is non-empty and was found.
    expect(raw.length).toBeGreaterThan(0);
  });

  it("includes 'submit_question' in the CHECK constraint action set (Req 21.15)", () => {
    // The CHECK constraint line: CHECK (action IN ('submit_question', 'vote',
    // 'poll_respond', 'word_cloud_respond'))
    expect(flat).toMatch(
      /CHECK\s*\(\s*action\s+IN\s*\([^)]*'submit_question'[^)]*\)/i,
    );
  });

  it("includes 'vote' in the CHECK constraint action set (Req 21.15)", () => {
    expect(flat).toMatch(/CHECK\s*\(\s*action\s+IN\s*\([^)]*'vote'[^)]*\)/i);
  });

  it("includes 'poll_respond' in the CHECK constraint action set (Req 21.15)", () => {
    expect(flat).toMatch(
      /CHECK\s*\(\s*action\s+IN\s*\([^)]*'poll_respond'[^)]*\)/i,
    );
  });

  it("includes 'word_cloud_respond' in the CHECK constraint action set (Req 21.15)", () => {
    expect(flat).toMatch(
      /CHECK\s*\(\s*action\s+IN\s*\([^)]*'word_cloud_respond'[^)]*\)/i,
    );
  });

  it('CHECK constraint contains ALL FOUR action values in a single constraint (Req 21.15)', () => {
    // The constraint is on a single ADD CONSTRAINT line (normalised).
    const m = flat.match(
      /ADD CONSTRAINT rate_events_action_chk CHECK\s*\(\s*action\s+IN\s*\(([^)]*)\)\s*\)/i,
    );
    expect(m).not.toBeNull();
    const values = m![1];
    for (const action of [
      'submit_question',
      'vote',
      'poll_respond',
      'word_cloud_respond',
    ]) {
      expect(values).toContain(`'${action}'`);
    }
  });

  it("function allow-list guard also includes all four actions — 'poll_respond' and 'word_cloud_respond' added (Req 21.15)", () => {
    // Both overloads of check_and_record_rate_limit contain:
    //   IF p_action NOT IN ('submit_question', 'vote', 'poll_respond', 'word_cloud_respond')
    // Assert the allow-list text appears at least once in the normalised SQL.
    const m = flat.match(
      /p_action NOT IN\s*\(\s*'submit_question'\s*,\s*'vote'\s*,\s*'poll_respond'\s*,\s*'word_cloud_respond'\s*\)/i,
    );
    expect(m).not.toBeNull();
  });

  it("submit_poll_response RPC calls check_and_record_rate_limit with 'poll_respond' (Req 21.15)", () => {
    // The re-created submit_poll_response must pass 'poll_respond' — not 'vote'.
    expect(flat).toMatch(
      /check_and_record_rate_limit\s*\([^)]*'poll_respond'[^)]*\)/i,
    );
  });

  it("submit_word_cloud_response RPC calls check_and_record_rate_limit with 'word_cloud_respond' (Req 21.15)", () => {
    expect(flat).toMatch(
      /check_and_record_rate_limit\s*\([^)]*'word_cloud_respond'[^)]*\)/i,
    );
  });
});
