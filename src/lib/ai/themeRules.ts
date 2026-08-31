/**
 * AI audience theme-insights RULES — the SHARED, framework-agnostic, PURE
 * contract (task 32.1, Req 17).
 *
 * =============================================================================
 * GROUNDED-IN-EVENT-DATA ONLY — NO FABRICATION
 * =============================================================================
 * This module (and its Deno mirror, `supabase/functions/ai-gateway/jobs/
 * themeInsights.ts`) implements AI audience theme insights as a GROUNDED,
 * PROMPT-BASED operation over a SINGLE selected event's stored questions and
 * their vote counts (Req 17.1, 17.3, 17.4). The model is asked to surface
 * themes / concerns / topics, but it is instructed NOT to invent participant
 * counts, vote totals, or questions (Req 17.4) — the prompt (built by the Deno
 * write path) carries ONLY the event's own question text + aggregate,
 * non-identifying counts.
 *
 * Crucially, the `notable_high_vote_questions` set is NOT trusted from the
 * model: it is a DETERMINISTIC selection over the event's ACTUAL DB vote counts,
 * computed by the pure functions here (Req 17.2, 17.4). The gateway grounds the
 * returned vote_count from the DB rather than accepting whatever the model
 * emits, so a vote total can never be fabricated.
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI CRITICAL WRITE PATH
 * =============================================================================
 * This is the canonical, Node-testable definition of the PURE theme-insights
 * DECISION logic (Requirement 17). It answers, deterministically and WITHOUT any
 * network / DB I/O:
 *
 *   - EMPTY-EVENT RULE (Req 17.5): zero stored questions → an empty result set
 *     for all four categories plus `has_data: false`, WITHOUT calling the
 *     provider and WITHOUT any fabricated content ({@link EMPTY_THEME_INSIGHTS_RESULT},
 *     {@link isEmptyEvent}, {@link buildEmptyThemeInsightsResult}).
 *   - NOTABLE HIGH-VOTE THRESHOLD (Req 17.2): a question is "notable high-vote"
 *     when its vote count is within the TOP 10% of the event's vote counts OR is
 *     ≥ 10 — "whichever threshold identifies FEWER questions" (the more selective
 *     of the two candidate sets). See {@link computeNotableHighVoteThreshold} and
 *     {@link selectNotableHighVoteQuestions} (capped at ≤5, highest votes first).
 *   - CAPS (Req 17.1): standalone predicates / clampers for ≤5 top themes,
 *     ≤5 emerging concerns, ≤10 frequent topics, ≤5 notable questions. The shared
 *     schema already enforces the maxima; these mirror them for the write path
 *     and the unit tests (task 32.2).
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node unit tests (task 32.2). This
 * pure module is therefore the AUTHORITATIVE, Node-testable copy. Because it
 * lives under `src/` it imports the shared theme contract and its caps from
 * `src/schemas/ai.ts` DIRECTLY, so the ≤5/≤5/≤10/≤5 caps are NOT duplicated
 * here: the schema is the single source of truth.
 *
 * The Deno Edge Function cannot import a `src/` path at runtime, so the job
 * module (`supabase/functions/ai-gateway/jobs/themeInsights.ts`) re-declares an
 * identical copy of this pure logic against its Deno-side mirrored schema —
 * exactly the `src/lib/ai/clusterRules.ts` ⇄ `jobs/clustering.ts` pattern. If a
 * rule changes here, mirror it there too.
 *
 * Requirements traceability: 17.1, 17.2, 17.3, 17.4, 17.5.
 * Design references: Server-Side AI Gateway Design (AI features — Theme
 * insights).
 */

import {
  AI_MAX_EMERGING_CONCERNS,
  AI_MAX_FREQUENT_TOPICS,
  AI_MAX_NOTABLE_QUESTIONS,
  AI_MAX_TOP_THEMES,
  aiThemeInsightsResultSchema,
  type AiNotableQuestion,
  type AiThemeInsightsResult,
} from '../../schemas/ai';

// -----------------------------------------------------------------------------
// Performance envelope (Req 17.1).
// -----------------------------------------------------------------------------

/**
 * The theme-insights TARGET latency in seconds (Req 17.1): the result set must
 * be produced within 10 s. The Gateway's hard timeout caps every AI request at
 * 30 s ({@link import('...').MAX_REQUEST_TIMEOUT_SECONDS}); this constant records
 * the tighter 10 s theme-insights target so the write path can clamp its own
 * deadline to it (Req 17.1, 17.6). It is a NON-storage, documentation + clamping
 * constant only.
 */
export const THEME_INSIGHTS_TARGET_SECONDS = 10;

// -----------------------------------------------------------------------------
// Caps (Req 17.1) — standalone predicates / clampers.
//
// The shared `aiThemeInsightsResultSchema` already enforces the four maxima
// (≤5 top themes, ≤5 emerging concerns, ≤10 frequent topics, ≤5 notable
// questions) during structured-output validation. These re-export the caps and
// provide standalone predicates/clampers so the write path and the unit tests
// (task 32.2) can assert the bounds directly, independent of Zod.
// -----------------------------------------------------------------------------

/** Maximum number of top themes (Req 17.1). Re-exported from the shared schema. */
export const MAX_TOP_THEMES = AI_MAX_TOP_THEMES;
/** Maximum number of emerging concerns (Req 17.1). */
export const MAX_EMERGING_CONCERNS = AI_MAX_EMERGING_CONCERNS;
/** Maximum number of frequent topics (Req 17.1). */
export const MAX_FREQUENT_TOPICS = AI_MAX_FREQUENT_TOPICS;
/** Maximum number of notable high-vote questions (Req 17.1, 17.2). */
export const MAX_NOTABLE_QUESTIONS = AI_MAX_NOTABLE_QUESTIONS;

/**
 * Whether `items` is within the cap `max` (Req 17.1). PURE and total: a
 * non-array is treated as out of bounds (fail closed).
 */
export function isWithinCap(items: unknown, max: number): boolean {
  if (!Array.isArray(items)) {
    return false;
  }
  return items.length <= max;
}

/** Whether the top-themes list is within its ≤5 cap (Req 17.1). */
export function isWithinTopThemesCap(items: unknown): boolean {
  return isWithinCap(items, MAX_TOP_THEMES);
}

/** Whether the emerging-concerns list is within its ≤5 cap (Req 17.1). */
export function isWithinEmergingConcernsCap(items: unknown): boolean {
  return isWithinCap(items, MAX_EMERGING_CONCERNS);
}

/** Whether the frequent-topics list is within its ≤10 cap (Req 17.1). */
export function isWithinFrequentTopicsCap(items: unknown): boolean {
  return isWithinCap(items, MAX_FREQUENT_TOPICS);
}

/** Whether the notable-questions list is within its ≤5 cap (Req 17.1, 17.2). */
export function isWithinNotableQuestionsCap(items: unknown): boolean {
  return isWithinCap(items, MAX_NOTABLE_QUESTIONS);
}

/**
 * Clamps a list to at most `max` items, preserving order (Req 17.1). PURE; a
 * non-array yields an empty array. Used as defence-in-depth so a value can never
 * exceed its cap even before the schema validates it.
 */
export function clampToCap<T>(items: readonly T[], max: number): T[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const bound = Math.max(0, Math.floor(max));
  return items.slice(0, bound);
}

// -----------------------------------------------------------------------------
// Empty-event rule (Req 17.5).
// -----------------------------------------------------------------------------

/**
 * The empty-event result (Req 17.5): an empty result set for ALL FOUR insight
 * categories plus `has_data: false` — the "no audience data" status indication.
 * NO provider call is made and NO content is fabricated. A frozen constant so
 * callers cannot mutate the shared value.
 */
export const EMPTY_THEME_INSIGHTS_RESULT: AiThemeInsightsResult = Object.freeze(
  {
    top_themes: [],
    emerging_concerns: [],
    frequent_topics: [],
    notable_high_vote_questions: [],
    has_data: false,
  },
) as AiThemeInsightsResult;

/**
 * Whether the selected event has NO stored questions (Req 17.5). PURE and total:
 * a non-finite / negative count is treated as empty (fail closed to the
 * no-fabrication path). With `true`, the caller returns
 * {@link EMPTY_THEME_INSIGHTS_RESULT} WITHOUT calling the provider.
 */
export function isEmptyEvent(questionCount: number): boolean {
  if (!Number.isFinite(questionCount)) {
    return true;
  }
  return questionCount <= 0;
}

/**
 * Builds the empty-event result (Req 17.5): a FRESH copy of
 * {@link EMPTY_THEME_INSIGHTS_RESULT} (so the frozen shared constant is never
 * handed out mutably). Every category is empty and `has_data` is false; there is
 * no fabricated content of any kind.
 */
export function buildEmptyThemeInsightsResult(): AiThemeInsightsResult {
  return {
    top_themes: [],
    emerging_concerns: [],
    frequent_topics: [],
    notable_high_vote_questions: [],
    has_data: false,
  };
}

// -----------------------------------------------------------------------------
// Notable high-vote threshold (Req 17.2).
//
// A question is "notable high-vote" when its vote count is within the TOP 10%
// of the event's vote counts OR its vote count is ≥ 10 — "whichever threshold
// identifies FEWER questions" (Req 17.2). We therefore compute BOTH candidate
// sets and keep the SMALLER (more selective) one; on a tie we keep the set with
// the higher cutoff (still the more selective threshold), so the reported
// threshold is unambiguous.
//
// "TOP 10%": the 90th-percentile cutoff over the event's vote counts. We use the
// nearest-rank definition: sort the counts ascending and take the value at rank
// ceil(0.90 * n) (1-based). A question is in the top 10% when its vote count is
// >= that cutoff. This is deterministic and testable, and degrades sensibly for
// small n (with n < 10 the cutoff is the maximum vote count, so only the
// top-voted question(s) qualify).
// -----------------------------------------------------------------------------

/** The fixed absolute notable-vote threshold (Req 17.2): vote_count ≥ 10. */
export const NOTABLE_ABSOLUTE_VOTE_THRESHOLD = 10;

/** The top-percentile fraction used for "top 10%" (Req 17.2). */
export const NOTABLE_TOP_PERCENTILE_FRACTION = 0.9;

/** Which of the two Req 17.2 rules produced the selected (more selective) threshold. */
export type NotableThresholdRule = 'top_percentile' | 'absolute' | 'none';

/**
 * The resolved notable-high-vote threshold for an event (Req 17.2):
 *   - `cutoff`  — the minimum vote_count a question needs to be notable (a
 *     question qualifies when `vote_count >= cutoff`).
 *   - `rule`    — which of the two candidate rules was selected (the one that
 *     identifies FEWER questions), or `'none'` when there are no vote counts.
 *   - `count`   — how many questions the selected threshold identifies.
 */
export interface NotableHighVoteThreshold {
  readonly cutoff: number;
  readonly rule: NotableThresholdRule;
  readonly count: number;
}

/** Normalises a vote count to a non-negative integer (fail closed to 0). */
function safeVoteCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Computes the 90th-percentile ("top 10%") cutoff over the event's vote counts
 * using the nearest-rank method (Req 17.2). Returns the vote_count at rank
 * ceil(0.90 * n) of the ascending-sorted counts; a question is in the top 10%
 * when `vote_count >= cutoff`. Returns 0 for an empty input. PURE; never throws.
 */
export function computeTopPercentileCutoff(
  voteCounts: readonly number[],
): number {
  if (!Array.isArray(voteCounts) || voteCounts.length === 0) {
    return 0;
  }
  const sorted = voteCounts.map(safeVoteCount).sort((a, b) => a - b);
  // Nearest-rank: rank = ceil(fraction * n), 1-based → 0-based index rank-1.
  const rank = Math.ceil(NOTABLE_TOP_PERCENTILE_FRACTION * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/** Counts how many of `voteCounts` are >= `cutoff`. PURE. */
function countAtOrAbove(voteCounts: readonly number[], cutoff: number): number {
  let n = 0;
  for (const value of voteCounts) {
    if (safeVoteCount(value) >= cutoff) {
      n++;
    }
  }
  return n;
}

/**
 * Resolves the notable-high-vote threshold for an event's vote counts (Req 17.2).
 *
 * Computes BOTH candidate cutoffs — the top-10% percentile cutoff and the fixed
 * absolute cutoff of {@link NOTABLE_ABSOLUTE_VOTE_THRESHOLD} (10) — counts how
 * many questions each identifies, and returns the one that identifies FEWER
 * questions (the more selective threshold, "whichever threshold identifies fewer
 * questions"). Ties are broken toward the HIGHER cutoff (equally selective by
 * count, but a stricter bar). With no vote counts, returns `rule: 'none'`,
 * `cutoff: 0`, `count: 0`. PURE; never throws.
 */
export function computeNotableHighVoteThreshold(
  voteCounts: readonly number[],
): NotableHighVoteThreshold {
  if (!Array.isArray(voteCounts) || voteCounts.length === 0) {
    return { cutoff: 0, rule: 'none', count: 0 };
  }
  const counts = voteCounts.map(safeVoteCount);

  const percentileCutoff = computeTopPercentileCutoff(counts);
  const percentileCount = countAtOrAbove(counts, percentileCutoff);

  const absoluteCutoff = NOTABLE_ABSOLUTE_VOTE_THRESHOLD;
  const absoluteCount = countAtOrAbove(counts, absoluteCutoff);

  // "Whichever threshold identifies fewer questions" (Req 17.2). On a tie in
  // count, prefer the higher cutoff (the stricter bar) for an unambiguous result.
  if (absoluteCount < percentileCount) {
    return { cutoff: absoluteCutoff, rule: 'absolute', count: absoluteCount };
  }
  if (percentileCount < absoluteCount) {
    return {
      cutoff: percentileCutoff,
      rule: 'top_percentile',
      count: percentileCount,
    };
  }
  // Equal counts → higher cutoff wins (more selective bar).
  if (absoluteCutoff >= percentileCutoff) {
    return { cutoff: absoluteCutoff, rule: 'absolute', count: absoluteCount };
  }
  return {
    cutoff: percentileCutoff,
    rule: 'top_percentile',
    count: percentileCount,
  };
}

// -----------------------------------------------------------------------------
// Notable high-vote SELECTION (Req 17.2, 17.4) — grounded in DB vote counts.
// -----------------------------------------------------------------------------

/**
 * The minimal question shape the notable-high-vote selection operates on: the
 * question id, its GROUNDED (DB) vote count, and its text. This is exactly the
 * `AiNotableQuestion` shape, so a selected question drops straight into the
 * `notable_high_vote_questions` array with a DB-grounded `vote_count` — never a
 * model-invented one (Req 17.4).
 */
export interface NotableQuestionCandidate {
  readonly question_id: string;
  readonly vote_count: number;
  readonly text: string;
}

/**
 * Selects the NOTABLE HIGH-VOTE questions for an event (Req 17.2, 17.4) from the
 * event's actual questions + DB vote counts:
 *   1. resolve the notable threshold via {@link computeNotableHighVoteThreshold}
 *      (top-10% OR ≥10, whichever identifies fewer);
 *   2. keep every question whose (grounded) vote_count is >= the resolved cutoff;
 *   3. sort HIGHEST votes first (ties broken by question_id for determinism);
 *   4. cap at {@link MAX_NOTABLE_QUESTIONS} (≤5, Req 17.1).
 *
 * The returned `vote_count` is ALWAYS the candidate's DB value — the model's
 * output is never trusted for counts (Req 17.4). Returns an empty array for no
 * candidates. PURE; never throws.
 */
export function selectNotableHighVoteQuestions(
  questions: readonly NotableQuestionCandidate[],
): AiNotableQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    return [];
  }
  const voteCounts = questions.map((q) => safeVoteCount(q.vote_count));
  const threshold = computeNotableHighVoteThreshold(voteCounts);
  if (threshold.rule === 'none') {
    return [];
  }

  const notable = questions
    .filter((q) => safeVoteCount(q.vote_count) >= threshold.cutoff)
    .map<AiNotableQuestion>((q) => ({
      question_id: q.question_id,
      vote_count: safeVoteCount(q.vote_count),
      text: q.text,
    }))
    .sort((a, b) => {
      if (b.vote_count !== a.vote_count) {
        return b.vote_count - a.vote_count;
      }
      return a.question_id < b.question_id
        ? -1
        : a.question_id > b.question_id
          ? 1
          : 0;
    });

  return clampToCap(notable, MAX_NOTABLE_QUESTIONS);
}

// -----------------------------------------------------------------------------
// Result grounding + validation (Req 17.1, 17.4).
// -----------------------------------------------------------------------------

/**
 * Grounds a model-produced theme-insights result against the event's ACTUAL DB
 * data (Req 17.4): it takes the model's textual insight categories (top themes,
 * emerging concerns, frequent topics) — each clamped to its cap (Req 17.1) — but
 * REPLACES `notable_high_vote_questions` with the DETERMINISTIC, DB-grounded
 * selection so vote counts are never fabricated (Req 17.2, 17.4). `has_data` is
 * set true (this path is only reached for a non-empty event). PURE; never throws.
 *
 * `modelResult` may be a loosely-typed parsed object; only its three textual
 * arrays are read (defensively) and clamped. The returned object is validated by
 * the caller against {@link aiThemeInsightsResultSchema} before returning.
 */
export function groundThemeInsightsResult(
  modelResult: {
    readonly top_themes?: readonly string[];
    readonly emerging_concerns?: readonly string[];
    readonly frequent_topics?: readonly string[];
  },
  eventQuestions: readonly NotableQuestionCandidate[],
): AiThemeInsightsResult {
  const topThemes = Array.isArray(modelResult?.top_themes)
    ? modelResult.top_themes
    : [];
  const emergingConcerns = Array.isArray(modelResult?.emerging_concerns)
    ? modelResult.emerging_concerns
    : [];
  const frequentTopics = Array.isArray(modelResult?.frequent_topics)
    ? modelResult.frequent_topics
    : [];

  return {
    top_themes: clampToCap(topThemes, MAX_TOP_THEMES),
    emerging_concerns: clampToCap(emergingConcerns, MAX_EMERGING_CONCERNS),
    frequent_topics: clampToCap(frequentTopics, MAX_FREQUENT_TOPICS),
    // Grounded from DB, NEVER from the model (Req 17.2, 17.4).
    notable_high_vote_questions: selectNotableHighVoteQuestions(eventQuestions),
    has_data: true,
  };
}

/**
 * Parses AND validates a candidate theme-insights result against the shared
 * schema (Req 17.1). Returns the typed result on success or `null` on any schema
 * violation (over-cap arrays, bad notable-question shape, etc.). PURE; never
 * throws. The Deno write path uses this to VALIDATE the response before
 * returning (Req 17.1).
 */
export function validateThemeInsightsResult(
  result: unknown,
): AiThemeInsightsResult | null {
  const parsed = aiThemeInsightsResultSchema.safeParse(result);
  return parsed.success ? (parsed.data as AiThemeInsightsResult) : null;
}
