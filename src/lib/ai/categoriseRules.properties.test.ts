/**
 * Task 30.2 — Property-based test for the categorisation TEXT-PRESERVATION
 * invariant (Property 17), exercised against the pure, Node-testable rule module
 * src/lib/ai/categoriseRules.ts (task 30.1) — imported, NEVER reimplemented.
 *
 * WHY A PURE MODULE AND NOT THE LIVE EDGE FUNCTION
 * ------------------------------------------------
 * The authoritative categorisation write path lives in the Deno edge function
 * (supabase/functions/ai-gateway/jobs/categorisation.ts), which issues the real
 * DB UPDATE. That path cannot execute under Node / Vitest in this sandbox (no
 * Deno globals, no DB). src/lib/ai/categoriseRules.ts is the AUTHORITATIVE,
 * runtime-agnostic definition of the DECISION logic: it produces the exact row
 * patches (`CategoryStorePatch`, `CategoryOverridePatch`) the UPDATE applies.
 *
 * THE INVARIANT (Req 15.9)
 * ------------------------
 * The patch types the module produces DELIBERATELY carry NO `text` field, so a
 * categorisation store or a moderator override can only ever set category
 * metadata — `ai_category`, `ai_category_confidence`, `ai_prior_category`. The
 * original question `text` is therefore byte-for-byte preserved BY CONSTRUCTION.
 *
 * This property models a question record and applies the store patch (from
 * buildCategoryStorePatch) followed by a moderator override (computeOverride) as
 * the DB UPDATE would — merging each patch onto the record — and asserts:
 *   (a) `text` is IDENTICAL (===, byte-for-byte) before and after;
 *   (b) ONLY ai_category / ai_category_confidence / ai_prior_category may differ
 *       (id and every other field are untouched);
 *   (c) an INVALID override leaves the record's category unchanged (prior
 *       retained) AND leaves `text` unchanged.
 *
 * Validates: Requirements 15.9
 * Design: Correctness Properties (Property 17).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { AI_QUESTION_CATEGORIES, type AiCategory } from '../../schemas/ai';
import {
  buildCategoryStorePatch,
  computeOverride,
  type CategorisationItem,
} from './categoriseRules';

// ---------------------------------------------------------------------------
// The question record the DB UPDATE targets. Only the category-metadata fields
// are writable through the module's patches; `id` and `text` must be inert.
// ---------------------------------------------------------------------------

interface QuestionRecord {
  readonly id: string;
  readonly text: string;
  readonly ai_category: string | null;
  readonly ai_category_confidence: number | null;
  readonly ai_prior_category: string | null;
}

/** The eight valid categories (single source of truth via the shared schema). */
const VALID_CATEGORIES: readonly AiCategory[] = AI_QUESTION_CATEGORIES;

/**
 * Tricky text generator: ordinary strings plus unicode, whitespace-only,
 * emoji, control chars, and empty — exactly the byte-sequences a naive
 * "sanitising" write might silently mutate.
 */
const trickyTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  // Full unicode code points (incl. astral plane / emoji) as a string.
  fc
    .array(
      fc
        .integer({ min: 0, max: 0x10ffff })
        .filter((c) => c < 0xd800 || c > 0xdfff),
    )
    .map((cps) => String.fromCodePoint(...cps)),
  fc.constantFrom(
    '',
    ' ',
    '   ',
    '\t\n\r',
    '  leading and trailing  ',
    '🙂🚀🇬🇧',
    'café \u2013 naïve — façade',
    'line1\nline2\nline3',
    'null\0byte',
    'emoji + text 🔥 mixed 中文 العربية',
    'trailing newline\n',
    'Security', // a value that collides with a category name
  ),
);

/** A valid category drawn from the eight, or `null` (never categorised yet). */
const priorCategoryArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.constantFrom<string>(...VALID_CATEGORIES),
);

/** A confidence in [0,1], out-of-range, or absent. */
const confidenceArb: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.double({ min: -5, max: 5, noNaN: true }), // some out of [0,1]
);

/** An arbitrary starting question record. */
const questionRecordArb: fc.Arbitrary<QuestionRecord> = fc.record({
  id: fc.uuid(),
  text: trickyTextArb,
  ai_category: priorCategoryArb,
  ai_category_confidence: fc.oneof(
    fc.constant<number | null>(null),
    fc.double({ min: 0, max: 1, noNaN: true }),
  ),
  ai_prior_category: priorCategoryArb,
});

/**
 * A proposed override category: mostly valid (the 8) but frequently invalid —
 * wrong case, padded, empty, non-category strings and non-strings — so branch
 * (c) is exercised hard.
 */
const proposedOverrideArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(...VALID_CATEGORIES),
  fc.constantFrom<unknown>(
    'security', // wrong case
    ' Security', // padded
    'SECURITY',
    'Technology ',
    '',
    'NotACategory',
    'Other ',
  ),
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
);

/** The set of field names a categorisation write is EVER permitted to change. */
const MUTABLE_FIELDS = new Set<keyof QuestionRecord>([
  'ai_category',
  'ai_category_confidence',
  'ai_prior_category',
]);

/**
 * Asserts that `after` differs from `before` ONLY in the allowed category
 * fields — in particular `id` and `text` are byte-for-byte identical.
 */
function assertOnlyCategoryMetadataChanged(
  before: QuestionRecord,
  after: QuestionRecord,
): void {
  // (a) text preserved byte-for-byte.
  expect(after.text).toBe(before.text);
  // id (a stand-in for every non-category field) is inert.
  expect(after.id).toBe(before.id);
  // (b) no field outside the mutable set may differ.
  for (const key of Object.keys(before) as (keyof QuestionRecord)[]) {
    if (!MUTABLE_FIELDS.has(key)) {
      expect(after[key]).toBe(before[key]);
    }
  }
}

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 17: Categorisation preserves original
// question text. For any question record with arbitrary (unicode / whitespace /
// emoji / empty-adjacent) text, applying a categorisation store patch and then a
// moderator override — merged onto the record exactly as the DB UPDATE would —
// leaves `text` byte-for-byte identical; only ai_category / ai_category_confidence
// / ai_prior_category may change. An INVALID override retains the prior category
// AND leaves text unchanged. Validates Req 15.9.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 17: Categorisation preserves original question text', () => {
  it('store patch then override only ever touch category metadata; text is byte-for-byte unchanged', () => {
    fc.assert(
      fc.property(
        questionRecordArb,
        fc.constantFrom<AiCategory>(...VALID_CATEGORIES),
        confidenceArb,
        proposedOverrideArb,
        (record, aiCategory, confidence, proposedOverride) => {
          const original: QuestionRecord = { ...record };

          // --- Step 1: apply the AI categorisation store patch (mocked model
          // result). The patch is category-only by type, so the merge cannot
          // introduce a `text` key. ---
          const item: CategorisationItem = {
            question_id: record.id,
            category: aiCategory,
            confidence,
          };
          const storePatch = buildCategoryStorePatch(item);
          // aiCategory is always one of the 8, so a patch is always produced.
          expect(storePatch).not.toBeNull();

          const afterStore: QuestionRecord = { ...record, ...storePatch! };

          // The store patch set the AI category and a storable/absent confidence.
          expect(afterStore.ai_category).toBe(aiCategory);
          assertOnlyCategoryMetadataChanged(original, afterStore);

          // --- Step 2: apply a moderator override on top of the stored state. ---
          const outcome = computeOverride(
            { ai_category: afterStore.ai_category },
            proposedOverride,
          );

          let afterOverride: QuestionRecord;
          if (outcome.applied) {
            // Valid override: merge the override patch (category-only).
            afterOverride = { ...afterStore, ...outcome.patch };

            // The new category is the (valid) proposed one, and the prior
            // category was recorded from the pre-override state (Req 15.7).
            expect(afterOverride.ai_category).toBe(proposedOverride);
            expect(afterOverride.ai_prior_category).toBe(
              afterStore.ai_category,
            );
          } else {
            // (c) Invalid override: RETAIN prior assignment — nothing changes.
            expect(outcome.reason).toBe('invalid_category');
            afterOverride = { ...afterStore };
            expect(afterOverride.ai_category).toBe(afterStore.ai_category);
            expect(afterOverride.ai_prior_category).toBe(
              afterStore.ai_prior_category,
            );
          }

          // Across BOTH steps, from the ORIGINAL record: text (and id and every
          // other non-category field) is byte-for-byte preserved.
          assertOnlyCategoryMetadataChanged(original, afterOverride);
          // Redundant-but-explicit byte-for-byte text check (the headline claim).
          expect(afterOverride.text).toBe(original.text);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('a valid override never fabricates or drops text, even when the text equals a category name', () => {
    fc.assert(
      fc.property(
        // Text deliberately equal to a category-name string to prove the merge
        // never confuses the `text` field with the `ai_category` field.
        fc.constantFrom<string>(...VALID_CATEGORIES),
        priorCategoryArb,
        fc.constantFrom<AiCategory>(...VALID_CATEGORIES),
        (textEqualToCategory, prior, override) => {
          const record: QuestionRecord = {
            id: '00000000-0000-4000-8000-000000000000',
            text: textEqualToCategory,
            ai_category: prior,
            ai_category_confidence: null,
            ai_prior_category: null,
          };

          const outcome = computeOverride(
            { ai_category: record.ai_category },
            override,
          );
          expect(outcome.applied).toBe(true);
          if (!outcome.applied) return; // narrow

          const after: QuestionRecord = { ...record, ...outcome.patch };
          expect(after.text).toBe(textEqualToCategory);
          expect(after.ai_category).toBe(override);
          expect(after.ai_prior_category).toBe(prior);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('example: an invalid override on an emoji/unicode question leaves both text and category untouched', () => {
    const record: QuestionRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      text: 'When do we ship? 🚀 — 中文 café',
      ai_category: 'Security',
      ai_category_confidence: 0.42,
      ai_prior_category: null,
    };

    const outcome = computeOverride(
      { ai_category: record.ai_category },
      'security', // wrong case → invalid (Req 15.8)
    );
    expect(outcome).toEqual({ applied: false, reason: 'invalid_category' });

    // The write path applies no patch on an invalid override: record is intact.
    expect(record.text).toBe('When do we ship? 🚀 — 中文 café');
    expect(record.ai_category).toBe('Security');
  });
});
