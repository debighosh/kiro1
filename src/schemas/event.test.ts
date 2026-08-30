/**
 * Task 7.4 (Part A) — Unit tests for event input validation.
 *
 * These tests exercise the shared Zod schema `eventCreateInputSchema`
 * (src/schemas/event.ts) — the single source of truth used by both the client
 * event editor and the authenticated event-create Edge Function. Positive +
 * negative cases per Req 26.1, with each failure asserted against the correct
 * field path.
 *
 * Requirements traceability: 1.1, 1.2, 1.4, 26.1.
 * Design references: Data Models (`events`); Error Handling (Validation errors —
 * shared Zod schemas, Unicode code-point counting, per-field error paths).
 */
import { describe, expect, it } from 'vitest';
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_NAME_MAX,
  countCodePoints,
  eventCreateInputSchema,
} from './event';

/** A far-future / valid ISO 8601 datetime pair (ends after starts). */
const STARTS_AT = '2026-01-01T10:00:00.000Z';
const ENDS_AT = '2026-01-01T12:00:00.000Z';

/** A minimal valid create-input payload; individual tests override one field. */
function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'MSS AI Demo Day 2026',
    starts_at: STARTS_AT,
    ends_at: ENDS_AT,
    ...overrides,
  };
}

/** Returns the set of dotted field paths that failed validation. */
function failedPaths(result: ReturnType<typeof eventCreateInputSchema.safeParse>): string[] {
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('countCodePoints — Unicode code-point counting (Req 22.5)', () => {
  it('counts an emoji outside the BMP as a single code point', () => {
    // '😀' is 2 UTF-16 code units but 1 Unicode code point.
    expect('😀'.length).toBe(2);
    expect(countCodePoints('😀')).toBe(1);
  });
});

describe('eventCreateInputSchema — name (Req 1.1)', () => {
  it('accepts a 1 code point name (lower boundary)', () => {
    const result = eventCreateInputSchema.safeParse(validInput({ name: 'A' }));
    expect(result.success).toBe(true);
  });

  it('accepts a 100 code point name (upper boundary)', () => {
    const name = 'x'.repeat(EVENT_NAME_MAX);
    expect(countCodePoints(name)).toBe(100);
    const result = eventCreateInputSchema.safeParse(validInput({ name }));
    expect(result.success).toBe(true);
  });

  it('accepts 100 emoji (each counts as one code point)', () => {
    const name = '😀'.repeat(EVENT_NAME_MAX);
    expect(countCodePoints(name)).toBe(100);
    // 100 emoji are 200 UTF-16 code units — proves length is NOT used.
    expect(name.length).toBe(200);
    const result = eventCreateInputSchema.safeParse(validInput({ name }));
    expect(result.success).toBe(true);
  });

  it('rejects an empty name against the name field', () => {
    const result = eventCreateInputSchema.safeParse(validInput({ name: '' }));
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('name');
  });

  it('rejects a whitespace-only name (trimmed to empty) against the name field', () => {
    const result = eventCreateInputSchema.safeParse(validInput({ name: '   ' }));
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('name');
  });

  it('rejects a 101 code point name against the name field', () => {
    const name = 'x'.repeat(EVENT_NAME_MAX + 1);
    const result = eventCreateInputSchema.safeParse(validInput({ name }));
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('name');
  });

  it('rejects 101 emoji against the name field (code-point counting)', () => {
    const name = '😀'.repeat(EVENT_NAME_MAX + 1);
    expect(countCodePoints(name)).toBe(101);
    const result = eventCreateInputSchema.safeParse(validInput({ name }));
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('name');
  });
});

describe('eventCreateInputSchema — description (Req 1.1)', () => {
  it('accepts a description of exactly 500 code points', () => {
    const description = 'd'.repeat(EVENT_DESCRIPTION_MAX);
    const result = eventCreateInputSchema.safeParse(validInput({ description }));
    expect(result.success).toBe(true);
  });

  it('accepts an omitted description', () => {
    const result = eventCreateInputSchema.safeParse(validInput());
    expect(result.success).toBe(true);
  });

  it('rejects a description of 501 code points against the description field', () => {
    const description = 'd'.repeat(EVENT_DESCRIPTION_MAX + 1);
    const result = eventCreateInputSchema.safeParse(validInput({ description }));
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('description');
  });
});

describe('eventCreateInputSchema — slug (Req 1.4)', () => {
  it('accepts a valid slug of letters, digits, and hyphens', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ slug: 'mss-ai-demo-2026' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a 64 character slug (upper boundary)', () => {
    const slug = 'a'.repeat(64);
    const result = eventCreateInputSchema.safeParse(validInput({ slug }));
    expect(result.success).toBe(true);
  });

  it('rejects a slug with invalid characters against the slug field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ slug: 'invalid slug!' }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('slug');
  });

  it('rejects a 65 character slug against the slug field', () => {
    const slug = 'a'.repeat(65);
    const result = eventCreateInputSchema.safeParse(validInput({ slug }));
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('slug');
  });
});

describe('eventCreateInputSchema — starts_at / ends_at ordering (Req 1.1, 1.2)', () => {
  it('accepts ends_at strictly after starts_at', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ starts_at: STARTS_AT, ends_at: ENDS_AT }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects ends_at equal to starts_at against the ends_at field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ starts_at: STARTS_AT, ends_at: STARTS_AT }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('ends_at');
  });

  it('rejects ends_at earlier than starts_at against the ends_at field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ starts_at: ENDS_AT, ends_at: STARTS_AT }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('ends_at');
  });

  it('rejects a non-ISO starts_at datetime against the starts_at field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ starts_at: 'not-a-date', ends_at: ENDS_AT }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('starts_at');
  });

  it('rejects a non-ISO ends_at datetime against the ends_at field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ starts_at: STARTS_AT, ends_at: '01/01/2026' }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('ends_at');
  });
});

describe('eventCreateInputSchema — moderation_mode (Req 1.1)', () => {
  it("defaults to 'pre' when omitted", () => {
    const result = eventCreateInputSchema.safeParse(validInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.moderation_mode).toBe('pre');
    }
  });

  it("accepts 'pre'", () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ moderation_mode: 'pre' }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts 'post'", () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ moderation_mode: 'post' }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.moderation_mode).toBe('post');
    }
  });

  it('rejects an unknown moderation_mode against the moderation_mode field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ moderation_mode: 'auto' }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('moderation_mode');
  });
});

describe('eventCreateInputSchema — brand_colour (Req 1.1)', () => {
  it('accepts a 3-digit hex colour (#0af)', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ brand_colour: '#0af' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a 6-digit hex colour (#00aaff)', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ brand_colour: '#00aaff' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a non-hex brand colour against the brand_colour field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ brand_colour: 'red' }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('brand_colour');
  });

  it('rejects a hex colour missing the # prefix against the brand_colour field', () => {
    const result = eventCreateInputSchema.safeParse(
      validInput({ brand_colour: '00aaff' }),
    );
    expect(result.success).toBe(false);
    expect(failedPaths(result)).toContain('brand_colour');
  });
});
