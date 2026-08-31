/**
 * Task 32.2 (optional) — unit tests for the pure, Node-testable AI
 * theme-insights RULE module (src/lib/ai/themeRules.ts).
 *
 * These tests lock down the theme-insights BOUNDS + GROUNDING contract
 * (Requirement 17):
 *   - Caps (Req 17.1): the per-category maxima (≤5 top themes, ≤5 emerging
 *     concerns, ≤10 frequent topics, ≤5 notable questions) accept the boundary
 *     and reject one-over; `clampToCap` trims to the max preserving order.
 *   - Notable high-vote threshold (Req 17.2): `computeNotableHighVoteThreshold`
 *     picks the MORE SELECTIVE (fewer-questions) of the top-10% nearest-rank
 *     cutoff vs the fixed ≥10 cutoff, and `selectNotableHighVoteQuestions`
 *     returns highest-votes-first, capped ≤5, with the DB-grounded vote_count.
 *   - Empty-event (Req 17.5): `isEmptyEvent(0)` is true and
 *     `buildEmptyThemeInsightsResult` yields all-empty arrays + `has_data:false`
 *     with no fabricated content.
 *   - Schema validation (Req 17.1): `validateThemeInsightsResult` rejects a
 *     malformed response (over-cap array, bad notable shape) → null, and accepts
 *     a valid one.
 *   - Grounding (Req 17.4): `groundThemeInsightsResult` keeps the model's
 *     (clamped) textual categories but REPLACES notable questions with the
 *     DB-grounded selection and sets `has_data:true`.
 *
 * These are PURE Node tests — no DB, no Deno. They must actually RUN.
 *
 * Requirements: 17.1, 17.2, 17.5, 26.1.
 * Design: Server-Side AI Gateway Design → Theme insights (grounded, no
 * fabrication; caps; notable high-vote threshold = fewer-of top-10%/≥10).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_TOP_THEMES,
  MAX_EMERGING_CONCERNS,
  MAX_FREQUENT_TOPICS,
  MAX_NOTABLE_QUESTIONS,
  NOTABLE_ABSOLUTE_VOTE_THRESHOLD,
  isWithinTopThemesCap,
  isWithinEmergingConcernsCap,
  isWithinFrequentTopicsCap,
  isWithinNotableQuestionsCap,
  clampToCap,
  isEmptyEvent,
  buildEmptyThemeInsightsResult,
  EMPTY_THEME_INSIGHTS_RESULT,
  computeTopPercentileCutoff,
  computeNotableHighVoteThreshold,
  selectNotableHighVoteQuestions,
  groundThemeInsightsResult,
  validateThemeInsightsResult,
  type NotableQuestionCandidate,
} from './themeRules';
import type { AiThemeInsightsResult } from '../../schemas/ai';

/** Builds an array of `n` distinct short label strings. */
function labels(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `label-${i}`);
}

/**
 * Builds a valid, sortable v4-style UUID for the given index. The last 12
 * hex digits encode the (zero-padded) index so ids sort deterministically,
 * while the version (`4`) and variant (`8`) nibbles keep it schema-valid.
 */
function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** Builds a notable-question candidate with a valid, sortable id. */
function candidate(
  index: number,
  vote_count: number,
  text = `q-${index}`,
): NotableQuestionCandidate {
  return { question_id: uuidFor(index), vote_count, text };
}

// -----------------------------------------------------------------------------
// Caps (Req 17.1).
// -----------------------------------------------------------------------------

describe('theme-insights caps (Req 17.1)', () => {
  it('exposes the expected caps: 5 / 5 / 10 / 5 (Req 17.1)', () => {
    expect(MAX_TOP_THEMES).toBe(5);
    expect(MAX_EMERGING_CONCERNS).toBe(5);
    expect(MAX_FREQUENT_TOPICS).toBe(10);
    expect(MAX_NOTABLE_QUESTIONS).toBe(5);
  });

  it('isWithinTopThemesCap accepts ≤5 and rejects 6 (Req 17.1)', () => {
    expect(isWithinTopThemesCap(labels(MAX_TOP_THEMES))).toBe(true);
    expect(isWithinTopThemesCap(labels(MAX_TOP_THEMES + 1))).toBe(false);
    expect(isWithinTopThemesCap([])).toBe(true);
    expect(isWithinTopThemesCap('not-an-array')).toBe(false);
  });

  it('isWithinEmergingConcernsCap accepts ≤5 and rejects 6 (Req 17.1)', () => {
    expect(isWithinEmergingConcernsCap(labels(MAX_EMERGING_CONCERNS))).toBe(true);
    expect(isWithinEmergingConcernsCap(labels(MAX_EMERGING_CONCERNS + 1))).toBe(false);
  });

  it('isWithinFrequentTopicsCap accepts ≤10 and rejects 11 (Req 17.1)', () => {
    expect(isWithinFrequentTopicsCap(labels(MAX_FREQUENT_TOPICS))).toBe(true);
    expect(isWithinFrequentTopicsCap(labels(MAX_FREQUENT_TOPICS + 1))).toBe(false);
  });

  it('isWithinNotableQuestionsCap accepts ≤5 and rejects 6 (Req 17.1, 17.2)', () => {
    expect(isWithinNotableQuestionsCap(labels(MAX_NOTABLE_QUESTIONS))).toBe(true);
    expect(isWithinNotableQuestionsCap(labels(MAX_NOTABLE_QUESTIONS + 1))).toBe(false);
  });

  it('clampToCap trims to the max preserving order (Req 17.1)', () => {
    const items = labels(8); // over the ≤5 cap
    const clamped = clampToCap(items, MAX_TOP_THEMES);
    expect(clamped).toHaveLength(MAX_TOP_THEMES);
    expect(clamped).toEqual(['label-0', 'label-1', 'label-2', 'label-3', 'label-4']);
  });

  it('clampToCap leaves an already-within-cap list unchanged (Req 17.1)', () => {
    const items = labels(3);
    expect(clampToCap(items, MAX_TOP_THEMES)).toEqual(items);
  });

  it('clampToCap fails closed to [] on a non-array (Req 17.1)', () => {
    // Defence-in-depth: a non-array yields an empty list, never a throw.
    expect(clampToCap(undefined as unknown as string[], MAX_TOP_THEMES)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Notable high-vote threshold + selection (Req 17.2, 17.4).
// -----------------------------------------------------------------------------

describe('notable high-vote threshold (Req 17.2)', () => {
  it('computeTopPercentileCutoff uses nearest-rank ceil(0.9*n) (Req 17.2)', () => {
    // n=10 → rank = ceil(0.9*10) = ceil(9.0) = 9 → index 8 → 9th smallest = 9.
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(computeTopPercentileCutoff(counts)).toBe(9);
    // n=11 → rank = ceil(0.9*11) = ceil(9.9) = 10 → index 9 → 10th smallest = 9.
    const counts11 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    expect(computeTopPercentileCutoff(counts11)).toBe(9);
    // Empty input → 0 (no throw).
    expect(computeTopPercentileCutoff([])).toBe(0);
  });

  it('picks the ABSOLUTE ≥10 cutoff when it identifies FEWER (Req 17.2)', () => {
    // 18 low-vote (1) + 2 high-vote (11, 12): percentile cutoff is 1 (matches
    // all 20), absolute ≥10 matches only the 2 high-vote → absolute is the more
    // selective (fewer) threshold.
    const counts = [...Array(18).fill(1), 11, 12];
    const t = computeNotableHighVoteThreshold(counts);
    expect(t.rule).toBe('absolute');
    expect(t.cutoff).toBe(NOTABLE_ABSOLUTE_VOTE_THRESHOLD);
    expect(t.count).toBe(2);
  });

  it('picks the TOP-10% cutoff when it identifies FEWER (Req 17.2)', () => {
    // 8 votes of 10 + 50 + 60 (n=10): absolute ≥10 matches all 10; percentile
    // cutoff (nearest-rank rank=9, index 8 → the 9th value = 50) matches only
    // {50, 60} → top-10% is the more selective (fewer) threshold.
    const counts = [10, 10, 10, 10, 10, 10, 10, 10, 50, 60];
    const t = computeNotableHighVoteThreshold(counts);
    expect(t.rule).toBe('top_percentile');
    expect(t.cutoff).toBe(50);
    expect(t.count).toBe(2);
  });

  it('returns rule "none" for an event with no vote counts (Req 17.2)', () => {
    const t = computeNotableHighVoteThreshold([]);
    expect(t).toEqual({ cutoff: 0, rule: 'none', count: 0 });
  });
});

describe('selectNotableHighVoteQuestions (Req 17.2, 17.4)', () => {
  it('returns highest-votes-first using the more-selective threshold (Req 17.2)', () => {
    // Same shape as the top-10% scenario: cutoff resolves to 50, so only the
    // 50/60-vote questions qualify, highest first.
    const questions: NotableQuestionCandidate[] = [
      ...Array.from({ length: 8 }, (_, i) => candidate(i, 10)),
      candidate(8, 50),
      candidate(9, 60),
    ];
    const selected = selectNotableHighVoteQuestions(questions);
    expect(selected.map((q) => q.vote_count)).toEqual([60, 50]);
    expect(selected[0].question_id).toBe(candidate(9, 60).question_id);
  });

  it('caps the notable selection at ≤5, highest first (Req 17.1, 17.2)', () => {
    // 7 questions all with 10 votes: absolute ≥10 matches all 7; capped to 5.
    const questions = Array.from({ length: 7 }, (_, i) => candidate(i, 10));
    const selected = selectNotableHighVoteQuestions(questions);
    expect(selected).toHaveLength(MAX_NOTABLE_QUESTIONS);
    expect(selected.every((q) => q.vote_count === 10)).toBe(true);
  });

  it('takes vote_count from the candidate (DB), never fabricated (Req 17.4)', () => {
    const questions: NotableQuestionCandidate[] = [
      candidate(0, 42, 'answered question'),
      candidate(1, 3),
    ];
    const selected = selectNotableHighVoteQuestions(questions);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toEqual({
      question_id: candidate(0, 42).question_id,
      vote_count: 42,
      text: 'answered question',
    });
  });

  it('returns [] for no candidates (Req 17.2)', () => {
    expect(selectNotableHighVoteQuestions([])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Empty-event rule (Req 17.5).
// -----------------------------------------------------------------------------

describe('empty-event rule (Req 17.5)', () => {
  it('isEmptyEvent(0) is true and a positive count is false (Req 17.5)', () => {
    expect(isEmptyEvent(0)).toBe(true);
    expect(isEmptyEvent(1)).toBe(false);
    // Fail-closed: non-finite / negative counts are treated as empty.
    expect(isEmptyEvent(-1)).toBe(true);
    expect(isEmptyEvent(Number.NaN)).toBe(true);
  });

  it('buildEmptyThemeInsightsResult yields empty arrays + has_data:false (Req 17.5)', () => {
    const result = buildEmptyThemeInsightsResult();
    expect(result.top_themes).toEqual([]);
    expect(result.emerging_concerns).toEqual([]);
    expect(result.frequent_topics).toEqual([]);
    expect(result.notable_high_vote_questions).toEqual([]);
    expect(result.has_data).toBe(false);
  });

  it('the empty result contains NO fabricated content and validates (Req 17.5)', () => {
    const result = buildEmptyThemeInsightsResult();
    // No fabricated content anywhere in the serialised shape.
    const totalItems =
      result.top_themes.length +
      result.emerging_concerns.length +
      result.frequent_topics.length +
      result.notable_high_vote_questions.length;
    expect(totalItems).toBe(0);
    // It is itself a schema-valid result.
    expect(validateThemeInsightsResult(result)).not.toBeNull();
  });

  it('the shared EMPTY constant matches a freshly built one and is frozen (Req 17.5)', () => {
    expect(EMPTY_THEME_INSIGHTS_RESULT).toEqual(buildEmptyThemeInsightsResult());
    expect(Object.isFrozen(EMPTY_THEME_INSIGHTS_RESULT)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Schema validation (Req 17.1).
// -----------------------------------------------------------------------------

describe('validateThemeInsightsResult (Req 17.1)', () => {
  const validResult: AiThemeInsightsResult = {
    top_themes: ['governance', 'security'],
    emerging_concerns: ['budget'],
    frequent_topics: ['ai', 'compliance'],
    notable_high_vote_questions: [
      {
        question_id: uuidFor(1),
        vote_count: 12,
        text: 'How is data governed?',
      },
    ],
    has_data: true,
  };

  it('accepts a well-formed result (Req 17.1)', () => {
    expect(validateThemeInsightsResult(validResult)).not.toBeNull();
  });

  it('rejects an over-cap top_themes array → null (Req 17.1)', () => {
    const malformed = { ...validResult, top_themes: labels(MAX_TOP_THEMES + 1) };
    expect(validateThemeInsightsResult(malformed)).toBeNull();
  });

  it('rejects an over-cap notable array → null (Req 17.1, 17.2)', () => {
    const notable = Array.from({ length: MAX_NOTABLE_QUESTIONS + 1 }, (_, i) => ({
      question_id: uuidFor(i),
      vote_count: 10,
      text: `q-${i}`,
    }));
    const malformed = { ...validResult, notable_high_vote_questions: notable };
    expect(validateThemeInsightsResult(malformed)).toBeNull();
  });

  it('rejects a bad notable-question shape (non-UUID id) → null (Req 17.1, 17.4)', () => {
    const malformed = {
      ...validResult,
      notable_high_vote_questions: [
        { question_id: 'not-a-uuid', vote_count: 10, text: 'x' },
      ],
    };
    expect(validateThemeInsightsResult(malformed)).toBeNull();
  });

  it('rejects a negative / non-integer vote_count → null (Req 17.2, 17.4)', () => {
    const malformed = {
      ...validResult,
      notable_high_vote_questions: [
        {
          question_id: uuidFor(1),
          vote_count: -1,
          text: 'x',
        },
      ],
    };
    expect(validateThemeInsightsResult(malformed)).toBeNull();
  });

  it('rejects a completely unrelated value → null (Req 17.1)', () => {
    expect(validateThemeInsightsResult('nope')).toBeNull();
    expect(validateThemeInsightsResult(null)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Grounding (Req 17.4).
// -----------------------------------------------------------------------------

describe('groundThemeInsightsResult (Req 17.4)', () => {
  it('keeps clamped model categories but grounds notable questions from DB (Req 17.1, 17.4)', () => {
    const modelResult = {
      // Over-cap on purpose so we can assert clamping.
      top_themes: labels(MAX_TOP_THEMES + 3),
      emerging_concerns: labels(2),
      frequent_topics: labels(MAX_FREQUENT_TOPICS + 2),
      // The model MAY try to smuggle notable questions; grounding must ignore
      // this key entirely and rebuild from the DB candidates.
      notable_high_vote_questions: [
        { question_id: 'fabricated', vote_count: 9999, text: 'invented' },
      ],
    } as unknown as { top_themes: string[]; emerging_concerns: string[]; frequent_topics: string[] };

    const eventQuestions: NotableQuestionCandidate[] = [
      candidate(0, 60),
      candidate(1, 50),
      ...Array.from({ length: 8 }, (_, i) => candidate(i + 2, 10)),
    ];

    const grounded = groundThemeInsightsResult(modelResult, eventQuestions);

    // Textual categories are kept but clamped to caps (Req 17.1).
    expect(grounded.top_themes).toHaveLength(MAX_TOP_THEMES);
    expect(grounded.emerging_concerns).toHaveLength(2);
    expect(grounded.frequent_topics).toHaveLength(MAX_FREQUENT_TOPICS);

    // Notable questions are the DB-grounded selection (cutoff → {60,50}),
    // NOT the model's fabricated entry (Req 17.2, 17.4).
    expect(grounded.notable_high_vote_questions.map((q) => q.vote_count)).toEqual([60, 50]);
    expect(
      grounded.notable_high_vote_questions.some((q) => q.text === 'invented'),
    ).toBe(false);

    // Non-empty event path → has_data is true, and the result is schema-valid.
    expect(grounded.has_data).toBe(true);
    expect(validateThemeInsightsResult(grounded)).not.toBeNull();
  });

  it('defensively treats missing model arrays as empty (Req 17.4)', () => {
    const grounded = groundThemeInsightsResult({}, [candidate(0, 20)]);
    expect(grounded.top_themes).toEqual([]);
    expect(grounded.emerging_concerns).toEqual([]);
    expect(grounded.frequent_topics).toEqual([]);
    expect(grounded.notable_high_vote_questions).toHaveLength(1);
    expect(grounded.notable_high_vote_questions[0].vote_count).toBe(20);
    expect(grounded.has_data).toBe(true);
  });
});
