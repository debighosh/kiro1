/**
 * Task 30.3 (optional) — unit tests for the pure, Node-testable question
 * categorisation RULE module (src/lib/ai/categoriseRules.ts, task 30.1).
 *
 * These tests lock down the categorisation DECISION contract (Requirement 15):
 *   - Category validation is EXACT and case-sensitive; a single invalid
 *     category rejects the WHOLE batch and stores nothing (Req 15.3, 15.4).
 *   - Confidence is stored only when in [0.00, 1.00]; absent / out-of-range /
 *     non-finite → null (Req 15.5).
 *   - Hidden questions are excluded from a batch UNLESS explicitly requested
 *     (Req 15.10).
 *   - A larger candidate set chunks into ordered batches of ≤100 whose
 *     concatenation equals the input (Req 15.1).
 *   - A moderator override is rejected when the proposed value is not one of
 *     the 8 (prior assignment retained, nothing changed, Req 15.8); a valid
 *     override records the current category into `ai_prior_category`
 *     (Req 15.7). No patch this module produces carries a `text` field
 *     (Req 15.9).
 *
 * These are PURE Node tests — no DB, no Deno, no network. They must actually
 * RUN and pass.
 *
 * Requirements: 15.1, 15.3, 15.4, 15.5, 15.7, 15.8, 15.10, 26.1.
 * Design: Server-Side AI Gateway Design (AI features — Categorisation);
 * Data Models (`questions.ai_category`, `ai_category_confidence`,
 * `ai_prior_category`).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_CATEGORISATION_BATCH,
  buildBatchStorePatches,
  buildCategoryStorePatch,
  chunkForCategorisation,
  computeOverride,
  isEligibleForCategorisation,
  isValidCategorisationBatch,
  isValidCategory,
  normaliseConfidence,
  selectCategorisationCandidates,
  type CandidateQuestion,
  type CategorisationItem,
} from './categoriseRules';
import { AI_QUESTION_CATEGORIES } from '../../schemas/ai';

// ===========================================================================
// Category validation — exact, case-sensitive match to the 8 (Req 15.3, 15.4)
// ===========================================================================
describe('isValidCategory — exact case-sensitive match to the 8 (Req 15.3)', () => {
  it('accepts each of the eight canonical categories', () => {
    for (const category of AI_QUESTION_CATEGORIES) {
      expect(isValidCategory(category)).toBe(true);
    }
  });

  it('rejects a wrong-case variant ("security")', () => {
    expect(isValidCategory('security')).toBe(false);
  });

  it('rejects a padded variant (" Security")', () => {
    expect(isValidCategory(' Security')).toBe(false);
    expect(isValidCategory('Security ')).toBe(false);
  });

  it('rejects a value that is not one of the 8 ("Nonsense")', () => {
    expect(isValidCategory('Nonsense')).toBe(false);
  });

  it('rejects non-string / empty values', () => {
    expect(isValidCategory(undefined)).toBe(false);
    expect(isValidCategory(null)).toBe(false);
    expect(isValidCategory('')).toBe(false);
    expect(isValidCategory(42)).toBe(false);
    expect(isValidCategory({})).toBe(false);
  });
});

describe('isValidCategorisationBatch — one invalid rejects the whole batch (Req 15.4)', () => {
  it('accepts a batch where every category is valid', () => {
    const items: CategorisationItem[] = [
      { question_id: 'q1', category: 'Technology', confidence: 0.9 },
      { question_id: 'q2', category: 'Security' },
      { question_id: 'q3', category: 'Other', confidence: 0.1 },
    ];
    expect(isValidCategorisationBatch(items)).toBe(true);
  });

  it('treats an empty batch as trivially valid', () => {
    expect(isValidCategorisationBatch([])).toBe(true);
  });

  it('rejects the WHOLE batch when a single item is invalid', () => {
    const items: CategorisationItem[] = [
      { question_id: 'q1', category: 'Technology' },
      { question_id: 'q2', category: 'security' }, // wrong case → whole batch invalid
      { question_id: 'q3', category: 'Other' },
    ];
    expect(isValidCategorisationBatch(items)).toBe(false);
  });
});

// ===========================================================================
// Batch storage patches — null when any invalid; category-only otherwise
// (Req 15.4, 15.9)
// ===========================================================================
describe('buildBatchStorePatches — reject-whole-batch, category-only patches (Req 15.4, 15.9)', () => {
  it('returns null when ANY item is invalid (nothing stored, Req 15.4)', () => {
    const items: CategorisationItem[] = [
      { question_id: 'q1', category: 'Technology', confidence: 0.8 },
      { question_id: 'q2', category: 'Nonsense' }, // invalid
    ];
    expect(buildBatchStorePatches(items)).toBeNull();
  });

  it('returns a map of category-only patches for a valid batch (no text field, Req 15.9)', () => {
    const items: CategorisationItem[] = [
      { question_id: 'q1', category: 'Technology', confidence: 0.75 },
      { question_id: 'q2', category: 'Governance' }, // no confidence
    ];
    const patches = buildBatchStorePatches(items);
    expect(patches).not.toBeNull();
    expect(patches!.size).toBe(2);
    expect(patches!.get('q1')).toEqual({
      ai_category: 'Technology',
      ai_category_confidence: 0.75,
    });
    expect(patches!.get('q2')).toEqual({
      ai_category: 'Governance',
      ai_category_confidence: null,
    });
    // No patch carries a `text` field (Req 15.9).
    for (const patch of patches!.values()) {
      expect(patch).not.toHaveProperty('text');
    }
  });

  it('buildCategoryStorePatch returns null for an invalid single item', () => {
    expect(
      buildCategoryStorePatch({ question_id: 'q1', category: 'security' }),
    ).toBeNull();
  });

  it('buildCategoryStorePatch produces a category-only patch (no text field)', () => {
    const patch = buildCategoryStorePatch({
      question_id: 'q1',
      category: 'Compliance',
      confidence: 0.5,
    });
    expect(patch).toEqual({
      ai_category: 'Compliance',
      ai_category_confidence: 0.5,
    });
    expect(patch).not.toHaveProperty('text');
  });
});

// ===========================================================================
// Confidence normalisation — 0.00–1.00 kept, else null (Req 15.5)
// ===========================================================================
describe('normaliseConfidence — storable in [0.00, 1.00] or null (Req 15.5)', () => {
  it('keeps in-range values including the boundaries', () => {
    expect(normaliseConfidence(0)).toBe(0);
    expect(normaliseConfidence(1)).toBe(1);
    expect(normaliseConfidence(0.42)).toBe(0.42);
  });

  it('maps absent (undefined / null) to null', () => {
    expect(normaliseConfidence(undefined)).toBeNull();
    expect(normaliseConfidence(null)).toBeNull();
  });

  it('maps out-of-range values to null', () => {
    expect(normaliseConfidence(-0.01)).toBeNull();
    expect(normaliseConfidence(1.01)).toBeNull();
    expect(normaliseConfidence(2)).toBeNull();
    expect(normaliseConfidence(-5)).toBeNull();
  });

  it('maps non-finite values to null', () => {
    expect(normaliseConfidence(Number.NaN)).toBeNull();
    expect(normaliseConfidence(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normaliseConfidence(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

// ===========================================================================
// Hidden exclusion — excluded unless includeHidden (Req 15.10)
// ===========================================================================
describe('isEligibleForCategorisation — hidden excluded unless requested (Req 15.10)', () => {
  it('excludes a hidden question by default', () => {
    expect(
      isEligibleForCategorisation({ id: 'q1', status: 'hidden' }, false),
    ).toBe(false);
  });

  it('includes a hidden question only when includeHidden is true', () => {
    expect(
      isEligibleForCategorisation({ id: 'q1', status: 'hidden' }, true),
    ).toBe(true);
  });

  it('always includes a non-hidden question regardless of the flag', () => {
    expect(
      isEligibleForCategorisation({ id: 'q1', status: 'visible' }, false),
    ).toBe(true);
    expect(
      isEligibleForCategorisation({ id: 'q2', status: 'answered' }, false),
    ).toBe(true);
    expect(
      isEligibleForCategorisation({ id: 'q3', status: 'visible' }, true),
    ).toBe(true);
  });
});

describe('selectCategorisationCandidates — filters by hidden rule, preserves order (Req 15.10)', () => {
  const questions: CandidateQuestion[] = [
    { id: 'q1', status: 'visible' },
    { id: 'q2', status: 'hidden' },
    { id: 'q3', status: 'answered' },
    { id: 'q4', status: 'hidden' },
  ];

  it('excludes hidden questions by default, preserving order', () => {
    const selected = selectCategorisationCandidates(questions, false);
    expect(selected.map((q) => q.id)).toEqual(['q1', 'q3']);
  });

  it('includes hidden questions when explicitly requested, preserving order', () => {
    const selected = selectCategorisationCandidates(questions, true);
    expect(selected.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('does not mutate the input array', () => {
    const before = questions.slice();
    selectCategorisationCandidates(questions, false);
    expect(questions).toEqual(before);
  });
});

// ===========================================================================
// Chunking — chunks of ≤100, order preserved, concatenation = input (Req 15.1)
// ===========================================================================
describe('chunkForCategorisation — chunks ≤100, order preserved (Req 15.1)', () => {
  it('returns no chunks for an empty input', () => {
    expect(chunkForCategorisation([])).toEqual([]);
  });

  it('keeps a small set in a single chunk', () => {
    const items = [1, 2, 3];
    expect(chunkForCategorisation(items)).toEqual([[1, 2, 3]]);
  });

  it('splits into chunks of at most MAX_CATEGORISATION_BATCH, and the concatenation equals the input in order', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkForCategorisation(items);
    // Every chunk is within the ≤100 bound.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CATEGORISATION_BATCH);
    }
    // 250 items → 100 + 100 + 50.
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    // Concatenation preserves order and drops/duplicates nothing.
    expect(chunks.flat()).toEqual(items);
  });

  it('clamps an out-of-policy size request into [1, MAX] (never exceeds the cap)', () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    const chunks = chunkForCategorisation(items, 10_000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CATEGORISATION_BATCH);
    }
    expect(chunks.flat()).toEqual(items);
  });
});

// ===========================================================================
// Moderator override (Req 15.7, 15.8)
// ===========================================================================
describe('computeOverride — valid override records the prior category (Req 15.7)', () => {
  it('applies a valid override, setting the new category and recording the current as ai_prior_category', () => {
    const outcome = computeOverride({ ai_category: 'Technology' }, 'Security');
    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      expect(outcome.patch).toEqual({
        ai_category: 'Security',
        ai_prior_category: 'Technology',
        ai_category_confidence: null,
      });
      // The override patch never carries a `text` field (Req 15.9).
      expect(outcome.patch).not.toHaveProperty('text');
    }
  });

  it('records a null prior when the question had no prior category', () => {
    const outcome = computeOverride({ ai_category: null }, 'Other');
    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      expect(outcome.patch).toEqual({
        ai_category: 'Other',
        ai_prior_category: null,
        ai_category_confidence: null,
      });
    }
  });
});

describe('computeOverride — invalid override retains the prior (Req 15.8)', () => {
  it('rejects an override whose category is not one of the 8, changing nothing', () => {
    const outcome = computeOverride({ ai_category: 'Technology' }, 'Nonsense');
    expect(outcome).toEqual({ applied: false, reason: 'invalid_category' });
  });

  it('rejects a wrong-case override ("security") and retains the prior', () => {
    const outcome = computeOverride({ ai_category: 'Governance' }, 'security');
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.reason).toBe('invalid_category');
    }
  });

  it('rejects a padded override (" Security") and retains the prior', () => {
    const outcome = computeOverride({ ai_category: 'Governance' }, ' Security');
    expect(outcome).toEqual({ applied: false, reason: 'invalid_category' });
  });
});
