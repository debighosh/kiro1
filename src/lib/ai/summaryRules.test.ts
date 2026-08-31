/**
 * Task 33.4 (optional) — unit tests for the end-of-event summary STRUCTURE and
 * the AI failure / degraded-mode BEHAVIOUR, driving the two pure, Node-testable
 * rule modules:
 *   - `src/lib/ai/summaryRules.ts`   (task 33.1)
 *   - `src/lib/ai/degradedMode.ts`   (task 33.2)
 *
 * These tests lock down the observable summary + degraded-mode contract:
 *   - Heading separation + "AI-Generated" prefix (Req 18.4, 18.6):
 *     `buildSummaryMarkdown` renders a "## Calculated Data" section and a
 *     SEPARATE "## AI Interpretation" section; when AI is present the executive
 *     summary and each follow-up action are prefixed with `AI_GENERATED_LABEL`;
 *     calculated figures appear only under Calculated Data.
 *   - Top-questions ordering (Req 18.2): `selectTopQuestions` returns ≤10
 *     (`MAX_TOP_QUESTIONS`), ordered by DESCENDING vote_count with ties broken
 *     by EARLIEST created_at, and caps at 10 with >10 inputs.
 *   - Calculated data (Req 18.4): totals (questions, votes, poll/word-cloud
 *     responses), category counts from `ai_category`, answered/follow-up counts,
 *     and `hasNoInteractions` for an empty event.
 *   - AI-unavailable path (Req 18.7): `buildSummaryMarkdown(calculated, null)`
 *     still emits ALL calculated sections AND the visible AI-unavailable notice
 *     (`AI_UNAVAILABLE_NOTICE`) with no AI executive-summary content.
 *   - Plain-text escaping (Req 14.8): `escapeMarkdownText` neutralises a hostile
 *     string (no raw `<`, no live backtick fence, etc.).
 *   - Degraded-mode indication (Req 19.2): `describeAiUnavailable` /
 *     `indicationForCode` for every failure mode yield a generic "AI unavailable"
 *     message with NO provider internals (no hostname / status / credential).
 *   - Persistence invariants (Req 19.5, 19.6): `applyFailureToPersistedState`
 *     returns the SAME reference (no mutation / partial persist) and
 *     `mayPersistAiOutput` gates on the validation verdict.
 *
 * These are PURE Node tests — no DB, no Deno. They must actually RUN.
 *
 * Requirements: 18.2, 18.4, 18.6, 18.7, 14.8, 19.2, 19.5, 19.6, 26.1.
 * Design: Server-Side AI Gateway Design (End-of-event summary; degraded mode).
 */
import { describe, expect, it } from 'vitest';

import type { AiSummaryResult } from '../../schemas/ai';
import {
  AI_GENERATED_LABEL,
  AI_UNAVAILABLE_NOTICE,
  MAX_TOP_QUESTIONS,
  buildSummaryMarkdown,
  computeCalculatedData,
  computeCategoryCounts,
  escapeMarkdownText,
  selectTopQuestions,
  type CalculatedData,
  type SummaryInputs,
  type SummaryQuestion,
} from './summaryRules';
import {
  AI_FAILURE_MODES,
  applyFailureToPersistedState,
  classifyFailureMode,
  describeAiUnavailable,
  indicationForCode,
  mayPersistAiOutput,
} from './degradedMode';

// -----------------------------------------------------------------------------
// Test fixtures.
// -----------------------------------------------------------------------------

const EVENT: SummaryInputs['event'] = {
  id: 'evt-1',
  name: 'Quarterly Town Hall',
  status: 'ended',
  starts_at: '2026-01-01T09:00:00.000Z',
  ends_at: '2026-01-01T10:00:00.000Z',
};

function question(overrides: Partial<SummaryQuestion>): SummaryQuestion {
  return {
    id: 'q-default',
    text: 'A question',
    status: 'approved',
    vote_count: 0,
    created_at: '2026-01-01T09:00:00.000Z',
    ai_category: null,
    ...overrides,
  };
}

const AI_RESULT: AiSummaryResult = {
  executive_summary: 'Attendance was strong and engagement was high.',
  suggested_follow_up_actions: [
    'Publish answers to the top three questions.',
    'Schedule a follow-up on the security roadmap.',
  ],
};

// -----------------------------------------------------------------------------
// buildSummaryMarkdown — heading separation + "AI-Generated" prefix.
// -----------------------------------------------------------------------------

describe('buildSummaryMarkdown — heading separation & AI-Generated prefix (Req 18.4, 18.6)', () => {
  const calculated: CalculatedData = computeCalculatedData({
    event: EVENT,
    questions: [
      question({ id: 'q1', text: 'What is the plan?', vote_count: 5 }),
    ],
    polls: [{ id: 'p1', question_text: 'Poll one', response_count: 12 }],
  });

  it('renders a "## Calculated Data" section and a SEPARATE "## AI Interpretation" section (Req 18.4)', () => {
    const md = buildSummaryMarkdown(calculated, AI_RESULT);

    expect(md).toContain('## Calculated Data');
    expect(md).toContain('## AI Interpretation');

    // The two headings must be distinct and ordered: Calculated Data first,
    // AI Interpretation strictly after it (separate, non-overlapping sections).
    const calcIndex = md.indexOf('## Calculated Data');
    const aiIndex = md.indexOf('## AI Interpretation');
    expect(calcIndex).toBeGreaterThanOrEqual(0);
    expect(aiIndex).toBeGreaterThan(calcIndex);
  });

  it('prefixes the executive summary and EACH follow-up action with the "AI-Generated" label (Req 18.6)', () => {
    const md = buildSummaryMarkdown(calculated, AI_RESULT);

    expect(AI_GENERATED_LABEL).toBe('AI-Generated');

    // Executive summary carries the label. The AI string itself is rendered as
    // escaped plain text (Req 14.8), so assert against the escaped form.
    expect(md).toContain(
      `**${AI_GENERATED_LABEL}:** ${escapeMarkdownText(AI_RESULT.executive_summary)}`,
    );

    // EACH follow-up action carries the label (count matches actions + summary).
    for (const action of AI_RESULT.suggested_follow_up_actions) {
      expect(md).toContain(
        `- **${AI_GENERATED_LABEL}:** ${escapeMarkdownText(action)}`,
      );
    }
    const labelOccurrences = md.split(`**${AI_GENERATED_LABEL}:**`).length - 1;
    expect(labelOccurrences).toBe(
      AI_RESULT.suggested_follow_up_actions.length + 1,
    );
  });

  it('renders calculated figures ONLY within the Calculated Data section (Req 18.4)', () => {
    const md = buildSummaryMarkdown(calculated, AI_RESULT);
    const aiIndex = md.indexOf('## AI Interpretation');
    const calculatedPortion = md.slice(0, aiIndex);
    const aiPortion = md.slice(aiIndex);

    // A calculated figure (total question votes) lives under Calculated Data...
    expect(calculatedPortion).toContain('Total question votes');
    expect(calculatedPortion).toContain('Total poll responses');
    // ...and NOT under AI Interpretation.
    expect(aiPortion).not.toContain('Total question votes');
    expect(aiPortion).not.toContain('Total poll responses');
  });
});

// -----------------------------------------------------------------------------
// selectTopQuestions — ordering + cap.
// -----------------------------------------------------------------------------

describe('selectTopQuestions — ≤10, descending votes, earliest-submission tie-break (Req 18.2)', () => {
  it('orders by DESCENDING vote count', () => {
    const result = selectTopQuestions([
      question({ id: 'low', vote_count: 1 }),
      question({ id: 'high', vote_count: 10 }),
      question({ id: 'mid', vote_count: 5 }),
    ]);
    expect(result.map((q) => q.id)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks vote ties by EARLIEST created_at (earlier submission first)', () => {
    const result = selectTopQuestions([
      question({
        id: 'later',
        vote_count: 7,
        created_at: '2026-01-01T09:30:00.000Z',
      }),
      question({
        id: 'earlier',
        vote_count: 7,
        created_at: '2026-01-01T09:00:00.000Z',
      }),
    ]);
    // Same votes → the earlier-submitted question wins the tie.
    expect(result.map((q) => q.id)).toEqual(['earlier', 'later']);
  });

  it('caps the result at MAX_TOP_QUESTIONS (10) given more than 10 inputs', () => {
    expect(MAX_TOP_QUESTIONS).toBe(10);

    const many: SummaryQuestion[] = Array.from({ length: 15 }, (_, i) =>
      question({ id: `q${i}`, vote_count: 100 - i }),
    );
    const result = selectTopQuestions(many);

    expect(result).toHaveLength(MAX_TOP_QUESTIONS);
    // The highest-voted 10 are retained, highest first.
    expect(result[0].vote_count).toBe(100);
    expect(result[MAX_TOP_QUESTIONS - 1].vote_count).toBe(100 - 9);
  });

  it('returns an empty list for no questions', () => {
    expect(selectTopQuestions([])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// computeCalculatedData — DB-derived figures.
// -----------------------------------------------------------------------------

describe('computeCalculatedData — DB-derived totals & counts (Req 18.4)', () => {
  it('computes interaction totals, category counts and answered/follow-up counts', () => {
    const data = computeCalculatedData({
      event: EVENT,
      questions: [
        question({ id: 'q1', status: 'answered', vote_count: 3, ai_category: 'Security' }),
        question({ id: 'q2', status: 'approved', vote_count: 2, ai_category: 'Security' }),
        question({ id: 'q3', status: 'featured', vote_count: 5, ai_category: 'Strategy' }),
        question({ id: 'q4', status: 'pending', vote_count: 0, ai_category: null }),
      ],
      polls: [
        { id: 'p1', question_text: 'Poll 1', response_count: 10 },
        { id: 'p2', question_text: 'Poll 2', response_count: 4 },
      ],
      wordClouds: [{ id: 'w1', prompt_text: 'Word 1', response_count: 7 }],
    });

    expect(data.totalQuestions).toBe(4);
    expect(data.totalVotes).toBe(3 + 2 + 5 + 0);
    expect(data.totalPollResponses).toBe(14);
    expect(data.totalWordCloudResponses).toBe(7);

    // answered = only 'answered'; follow-up = approved | featured.
    expect(data.answeredCount).toBe(1);
    expect(data.followUpCount).toBe(2);

    // category counts derived from ai_category, descending count.
    expect(computeCategoryCounts).toBeDefined();
    expect(data.categories).toEqual([
      { category: 'Security', count: 2 },
      { category: 'Strategy', count: 1 },
    ]);

    expect(data.hasNoInteractions).toBe(false);
  });

  it('flags hasNoInteractions for an empty event but still populates every section (Req 18.4, 18.8)', () => {
    const data = computeCalculatedData({ event: EVENT, questions: [] });

    expect(data.totalQuestions).toBe(0);
    expect(data.totalVotes).toBe(0);
    expect(data.totalPollResponses).toBe(0);
    expect(data.totalWordCloudResponses).toBe(0);
    expect(data.topQuestions).toEqual([]);
    expect(data.categories).toEqual([]);
    expect(data.answeredCount).toBe(0);
    expect(data.followUpCount).toBe(0);
    expect(data.hasNoInteractions).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// AI-unavailable rendering path.
// -----------------------------------------------------------------------------

describe('buildSummaryMarkdown — AI-unavailable path (Req 18.7)', () => {
  const calculated: CalculatedData = computeCalculatedData({
    event: EVENT,
    questions: [question({ id: 'q1', text: 'Any updates?', vote_count: 4 })],
    polls: [{ id: 'p1', question_text: 'Poll one', response_count: 3 }],
    wordClouds: [{ id: 'w1', prompt_text: 'One word?', response_count: 2 }],
  });

  it('still emits ALL calculated sections when AI is null', () => {
    const md = buildSummaryMarkdown(calculated, null);

    expect(md).toContain('## Calculated Data');
    expect(md).toContain('### Event Details');
    expect(md).toContain('### Platform Interaction Counts');
    expect(md).toContain('### Top Questions by Votes');
    expect(md).toContain('### Themes and Categories');
    expect(md).toContain('### Poll Results');
    expect(md).toContain('### Word-Cloud Results');
    expect(md).toContain('### Questions Marked Answered');
    expect(md).toContain('### Questions Requiring Follow-Up');
  });

  it('renders the visible AI-unavailable notice and NO AI executive-summary content', () => {
    const md = buildSummaryMarkdown(calculated, null);

    expect(md).toContain('## AI Interpretation');
    expect(md).toContain(AI_UNAVAILABLE_NOTICE);

    // None of the AI-produced interpretation content is present.
    expect(md).not.toContain('### Executive Summary');
    expect(md).not.toContain('### Suggested Follow-Up Actions');
    expect(md).not.toContain(AI_RESULT.executive_summary);
    for (const action of AI_RESULT.suggested_follow_up_actions) {
      expect(md).not.toContain(action);
    }
  });
});

// -----------------------------------------------------------------------------
// escapeMarkdownText — plain-text neutralisation.
// -----------------------------------------------------------------------------

describe('escapeMarkdownText — neutralises hostile markdown/HTML (Req 14.8)', () => {
  it('neutralises HTML angle brackets and markdown control characters', () => {
    const hostile =
      '<script>alert(1)</script> ```js\nrm -rf /\n``` **bold** [x](http://evil)';
    const escaped = escapeMarkdownText(hostile);

    // No raw HTML angle brackets survive.
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).toContain('&lt;');
    expect(escaped).toContain('&gt;');

    // No live triple-backtick code fence survives (backticks are escaped).
    expect(escaped).not.toContain('```');
    expect(escaped).toContain('\\`');

    // Newlines are collapsed so a single value cannot break report structure.
    expect(escaped).not.toContain('\n');
  });

  it('returns an empty string for non-string input', () => {
    expect(escapeMarkdownText(undefined)).toBe('');
    expect(escapeMarkdownText(null)).toBe('');
    expect(escapeMarkdownText(42 as unknown)).toBe('');
  });
});

// -----------------------------------------------------------------------------
// Degraded-mode indication — sanitised, no provider internals.
// -----------------------------------------------------------------------------

describe('describeAiUnavailable / indicationForCode — sanitised indication (Req 19.2)', () => {
  it('every failure mode yields a generic "AI unavailable" message with no provider internals', () => {
    for (const mode of AI_FAILURE_MODES) {
      const indication = describeAiUnavailable(mode);

      expect(indication.available).toBe(false);
      expect(indication.mode).toBe(mode);

      const msg = indication.message;
      // Generic user-facing wording.
      expect(msg).toMatch(/AI is (currently unavailable|not configured)/i);
      expect(msg.toLowerCase()).toContain('rest of the app is unaffected');

      // NO provider internals: no hostname, URL, status code, or credential.
      expect(msg).not.toMatch(/https?:\/\//i);
      expect(msg).not.toMatch(/\b\d{3}\b/); // no HTTP status codes
      expect(msg.toLowerCase()).not.toContain('token');
      expect(msg.toLowerCase()).not.toContain('api key');
      expect(msg.toLowerCase()).not.toContain('bearer');
      expect(msg).not.toMatch(/[a-z0-9.-]+\.(com|net|org|io|ai)\b/i); // no hostnames
    }
  });

  it('classifies sanitised codes and produces the matching indication (Req 19.1, 19.2)', () => {
    expect(classifyFailureMode('timeout')).toBe('timeout');
    expect(classifyFailureMode('credential_resolution_failed')).toBe('auth_failure');
    expect(classifyFailureMode('invalid_ai_response')).toBe('invalid_response');
    expect(classifyFailureMode('not_configured')).toBe('not_configured');
    // Unknown codes collapse to a generic 'unreachable' (never leak specifics).
    expect(classifyFailureMode('some_unmapped_internal_code')).toBe('unreachable');

    const indication = indicationForCode('timeout');
    expect(indication.mode).toBe('timeout');
    expect(indication.available).toBe(false);
    expect(indication.message.toLowerCase()).toContain(
      'rest of the app is unaffected',
    );
  });
});

// -----------------------------------------------------------------------------
// Persistence invariants on failure.
// -----------------------------------------------------------------------------

describe('failure persistence invariants (Req 19.5, 19.6)', () => {
  it('applyFailureToPersistedState returns the SAME reference — no mutation / partial persist', () => {
    const prior = {
      approvedModeration: ['q1', 'q2'],
      aiResults: { categorisation: [{ id: 'q1', category: 'Security' }] },
    };

    const after = applyFailureToPersistedState(prior);

    // Referential identity: the prior persisted state is unchanged.
    expect(after).toBe(prior);
    // And the contents are untouched.
    expect(after).toEqual({
      approvedModeration: ['q1', 'q2'],
      aiResults: { categorisation: [{ id: 'q1', category: 'Security' }] },
    });
  });

  it('mayPersistAiOutput gates on the validation verdict (Req 19.6)', () => {
    expect(mayPersistAiOutput({ ok: false })).toBe(false);
    expect(mayPersistAiOutput({ ok: true })).toBe(true);
  });
});
