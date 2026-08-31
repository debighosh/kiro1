/**
 * Task 39.5 — Property-based tests for the sanitisation module (`sanitise.ts`).
 *
 * WHAT THIS FILE COVERS
 * ---------------------
 * Four fast-check properties exercised against the PUBLIC API of `sanitise.ts`.
 * All properties use `numRuns: 500` and import ONLY public exports — no source
 * is reimplemented here. The module is pure (no I/O, no DB, no network) so
 * these tests are ALWAYS-ON and never need env-gating.
 *
 * Property 1 — Slug allow-list + max-length acceptance (Req 21.9, 21.10, 21.11):
 *   For random Unicode strings, `sanitise` with `SLUG_ALLOW_LIST` and
 *   `maxLength: 20` returns `ok: true` iff EVERY code point is `[A-Za-z0-9-]`
 *   AND the code-point count is ≤ 20; otherwise `ok: false` with
 *   `reason.field === 'test'` and `reason.limit === 20`. Also asserts that on
 *   success `result.value === input` (input never mutated).
 *
 * Property 2 — Plain-text allow-list (Req 21.9, 21.10):
 *   With `PLAIN_TEXT_ALLOW_LIST` and `maxLength: 100`, asserts `sanitise`
 *   returns `ok: true` iff every code point is NOT a disallowed C0 control
 *   (U+0000–U+001F excluding TAB/LF/CR) and NOT DEL (U+007F), AND the
 *   code-point count is ≤ 100. Also asserts TAB/LF/CR always pass when alone,
 *   and strings containing U+0001 always fail.
 *
 * Property 3 — Length boundary (Req 21.10):
 *   For printable-ASCII strings (allow-list `/[\x20-\x7E]/`) and varying
 *   `maxLength`, asserts `ok` iff code-point-count ≤ `maxLength` (boundary
 *   inclusive on equality, exclusive when one over).
 *
 * Property 4 — Field + limit in failure reason (Req 21.11, 22.7):
 *   For any rejected input, `reason.field` equals the configured `field` string
 *   and `reason.limit` equals the configured `maxLength`.
 *
 * Validates: Requirements 21.9, 21.10, 21.11, 22.7, 26.1.
 * Design references: Error Handling (Validation errors — allow-list + length cap
 * before persistence, reject whole submission with field + limit, Req 21.9–21.11,
 * 22.7).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  PLAIN_TEXT_ALLOW_LIST,
  SLUG_ALLOW_LIST,
  allowListFromRegExp,
  sanitise,
} from './sanitise';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts Unicode code points in `s` (same semantics as the source module and
 * the DB `char_length`). Uses the spread iterator which iterates by code point.
 */
function countCodePoints(s: string): number {
  return [...s].length;
}

/**
 * Returns `true` iff every code point in `s` matches `/^[A-Za-z0-9-]$/`.
 * Used as the ground-truth for the slug allow-list property.
 */
function allSlugChars(s: string): boolean {
  return [...s].every((cp) => /^[A-Za-z0-9-]$/.test(cp));
}

/**
 * Returns `true` iff every code point in `s` is permitted by the plain-text
 * allow-list: NOT a C0 control (U+0000–U+001F) except TAB (0x09), LF (0x0A),
 * CR (0x0D), and NOT DEL (U+007F).
 */
function allPlainTextChars(s: string): boolean {
  return [...s].every((cp) => {
    const v = cp.codePointAt(0)!;
    if (v === 0x09 || v === 0x0a || v === 0x0d) return true;
    if (v <= 0x1f || v === 0x7f) return false;
    return true;
  });
}

// ===========================================================================
// Feature: mss-livepulse, Property 1 — Slug allow-list + max-length acceptance
// Validates: Req 21.9, 21.10, 21.11.
// ===========================================================================
describe('Feature: mss-livepulse, Property 1: sanitise with SLUG_ALLOW_LIST — acceptance iff slug chars AND length ≤ 20 (Req 21.9, 21.10, 21.11)', () => {
  it('returns ok:true iff every code point is [A-Za-z0-9-] AND length ≤ 20; ok:false with field+limit otherwise', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const MAX = 20;
        const result = sanitise(s, {
          field: 'test',
          maxLength: MAX,
          allowList: SLUG_ALLOW_LIST,
        });

        const cpCount = countCodePoints(s);
        const expectedOk = cpCount <= MAX && allSlugChars(s);

        if (expectedOk) {
          // Must succeed and return the ORIGINAL reference (no mutation).
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(s);
          }
        } else {
          // Must fail with the correct field and limit.
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason.field).toBe('test');
            expect(result.reason.limit).toBe(MAX);
            // The failure kind is consistent with what was violated:
            // length check runs first (Req 21.10), so if length > MAX the
            // kind MUST be 'too_long'; otherwise it is 'disallowed_char'.
            if (cpCount > MAX) {
              expect(result.reason.kind).toBe('too_long');
            } else {
              expect(result.reason.kind).toBe('disallowed_char');
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('input is never mutated: result.value === input on success (Req 21.9 — no silent rewriting)', () => {
    fc.assert(
      fc.property(
        // Generate strings likely to pass SLUG_ALLOW_LIST for a mix of
        // success cases alongside the general-string test above.
        fc.stringMatching(/^[A-Za-z0-9-]{0,20}$/),
        (s) => {
          const result = sanitise(s, {
            field: 'slug',
            maxLength: 20,
            allowList: SLUG_ALLOW_LIST,
          });
          // All generated strings satisfy the allow-list + length — they must
          // succeed and return the original reference.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(s);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ===========================================================================
// Feature: mss-livepulse, Property 2 — Plain-text allow-list
// Validates: Req 21.9, 21.10.
// ===========================================================================
describe('Feature: mss-livepulse, Property 2: sanitise with PLAIN_TEXT_ALLOW_LIST — rejects C0 controls (excluding TAB/LF/CR) and DEL (Req 21.9, 21.10)', () => {
  it('returns ok:true iff no disallowed C0/DEL and length ≤ 100', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const MAX = 100;
        const result = sanitise(s, {
          field: 'body',
          maxLength: MAX,
          allowList: PLAIN_TEXT_ALLOW_LIST,
        });

        const cpCount = countCodePoints(s);
        const allAllowed = allPlainTextChars(s);
        const expectedOk = cpCount <= MAX && allAllowed;

        if (expectedOk) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('TAB (U+0009) is always accepted by PLAIN_TEXT_ALLOW_LIST', () => {
    const result = sanitise('\t', {
      field: 'body',
      maxLength: 100,
      allowList: PLAIN_TEXT_ALLOW_LIST,
    });
    expect(result.ok).toBe(true);
  });

  it('LF (U+000A) is always accepted by PLAIN_TEXT_ALLOW_LIST', () => {
    const result = sanitise('\n', {
      field: 'body',
      maxLength: 100,
      allowList: PLAIN_TEXT_ALLOW_LIST,
    });
    expect(result.ok).toBe(true);
  });

  it('CR (U+000D) is always accepted by PLAIN_TEXT_ALLOW_LIST', () => {
    const result = sanitise('\r', {
      field: 'body',
      maxLength: 100,
      allowList: PLAIN_TEXT_ALLOW_LIST,
    });
    expect(result.ok).toBe(true);
  });

  it('strings containing U+0001 (SOH — disallowed C0 control) always fail', () => {
    fc.assert(
      fc.property(
        // Strings that include at least one U+0001 character within the length limit.
        fc
          .tuple(fc.string({ maxLength: 49 }), fc.string({ maxLength: 49 }))
          .map(([pre, post]) => pre + '\u0001' + post),
        (s) => {
          const result = sanitise(s, {
            field: 'body',
            maxLength: 200,
            allowList: PLAIN_TEXT_ALLOW_LIST,
          });
          // If the string is within the length cap it must fail on
          // disallowed_char; if over-length it may fail on too_long first.
          // Either way it must NOT be ok:true.
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('DEL (U+007F) always fails with PLAIN_TEXT_ALLOW_LIST', () => {
    const result = sanitise('\u007F', {
      field: 'body',
      maxLength: 100,
      allowList: PLAIN_TEXT_ALLOW_LIST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe('disallowed_char');
    }
  });
});

// ===========================================================================
// Feature: mss-livepulse, Property 3 — Length boundary
// Validates: Req 21.10.
// ===========================================================================
describe('Feature: mss-livepulse, Property 3: sanitise length boundary — ok iff code-point-count ≤ maxLength (Req 21.10)', () => {
  // Use a printable-ASCII allow-list so every character in our generated
  // strings is unconditionally accepted, making length the SOLE variable.
  const printableAsciiAllowList = allowListFromRegExp(/^[\x20-\x7E]$/);

  it('accepts exactly at the boundary (code-point-count === maxLength) and rejects one over', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }), // maxLength varies
        fc.integer({ min: 0, max: 201 }), // length of generated string varies
        (maxLength, strLen) => {
          // Build a printable-ASCII string of exactly `strLen` code points.
          const input = 'a'.repeat(strLen);
          const result = sanitise(input, {
            field: 'content',
            maxLength,
            allowList: printableAsciiAllowList,
          });
          const cpCount = countCodePoints(input);
          if (cpCount <= maxLength) {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.reason.kind).toBe('too_long');
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('exactly at maxLength === code-point-count: always ok (boundary inclusive)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (n) => {
        const input = 'x'.repeat(n);
        const result = sanitise(input, {
          field: 'f',
          maxLength: n,
          allowList: printableAsciiAllowList,
        });
        expect(result.ok).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('one over maxLength: always fails with too_long', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (n) => {
        const input = 'x'.repeat(n + 1);
        const result = sanitise(input, {
          field: 'f',
          maxLength: n,
          allowList: printableAsciiAllowList,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason.kind).toBe('too_long');
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ===========================================================================
// Feature: mss-livepulse, Property 4 — Field + limit in failure reason
// Validates: Req 21.11, 22.7.
// ===========================================================================
describe('Feature: mss-livepulse, Property 4: failure reason always carries the configured field and limit (Req 21.11, 22.7)', () => {
  it('reason.field equals the configured field string for any rejected input', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }), // arbitrary field name
        fc.integer({ min: 0, max: 50 }), // arbitrary maxLength
        fc.string(), // arbitrary input
        (field, maxLength, input) => {
          const result = sanitise(input, {
            field,
            maxLength,
            allowList: SLUG_ALLOW_LIST, // strict allow-list to force failures
          });
          if (!result.ok) {
            expect(result.reason.field).toBe(field);
            expect(result.reason.limit).toBe(maxLength);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('reason.limit equals the configured maxLength for every too_long failure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }), // maxLength
        fc.integer({ min: 1, max: 50 }), // extra chars over the limit
        (maxLength, extra) => {
          // Build a slug-valid string just over the limit.
          const input = 'a'.repeat(maxLength + extra);
          const result = sanitise(input, {
            field: 'slug',
            maxLength,
            allowList: SLUG_ALLOW_LIST,
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason.kind).toBe('too_long');
            expect(result.reason.limit).toBe(maxLength);
            expect(result.reason.field).toBe('slug');
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('reason.limit equals the configured maxLength for every disallowed_char failure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }), // maxLength
        fc
          .string({ minLength: 1, maxLength: 1 })
          .filter((cp) => !/^[A-Za-z0-9-]$/.test(cp)), // one disallowed char
        (maxLength, disallowedChar) => {
          // Single disallowed character — within the length limit.
          const result = sanitise(disallowedChar, {
            field: 'myField',
            maxLength,
            allowList: SLUG_ALLOW_LIST,
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason.kind).toBe('disallowed_char');
            expect(result.reason.limit).toBe(maxLength);
            expect(result.reason.field).toBe('myField');
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
