// =============================================================================
// AI GATEWAY — THEME-INSIGHTS JOB (Supabase Edge Functions / Deno runtime)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module implements the `theme_insights` AI job for the Server-Side AI
//  Gateway (Requirement 17). Like `jobs/categorisation.ts` and
//  `jobs/clustering.ts` it is a small, COMPOSING module: it reuses the validated
//  egress runner in `gateway.ts` (`runValidatedOperation` → SSRF preflight →
//  pinned fetch → resolved credential → hard timeout → provider call →
//  server-side structured-output validation with bounded retries) and the shared
//  theme contract from `structuredOutput.ts`
//  (`aiThemeInsightsResultSchema` / `validateStructuredOutput('theme_insights', …)`).
//  It does NOT re-implement any SSRF, timeout, credential, or retry logic.
//
//  =============================================================================
//  GROUNDED-IN-EVENT-DATA ONLY — NO FABRICATION
//  =============================================================================
//  Theme insights are GROUNDED in a SINGLE selected event's stored questions and
//  their vote counts (Req 17.1, 17.3). The model is asked to surface themes /
//  concerns / topics from ONLY the provided event data and is INSTRUCTED NOT to
//  invent participant counts, vote totals, or questions (Req 17.4). The prompt
//  carries ONLY the event's own question texts + aggregate, non-identifying
//  counts (Req 20.1, 20.3).
//
//  The `notable_high_vote_questions` set is NOT trusted from the model: it is a
//  DETERMINISTIC selection over the event's ACTUAL DB vote counts, computed here
//  by the pure threshold (top 10% OR ≥10, whichever identifies fewer, Req 17.2).
//  We ground the returned vote_count from the DB rather than accepting the
//  model's number, so a vote total can never be fabricated (Req 17.4).
//
//  WHAT A THEME-INSIGHTS JOB DOES (Req 17.1, 17.2, 17.3, 17.4, 17.5):
//    1. LOAD the selected event's questions (id, text, vote_count). If there are
//       NONE, return an empty result set for all four categories + `has_data:
//       false` WITHOUT calling the provider and WITHOUT fabricating content
//       (Req 17.5).
//    2. Otherwise submit the event's question texts with a GROUNDING PROMPT via
//       `runValidatedOperation`, so the response is validated server-side against
//       `aiThemeInsightsResultSchema` (≤5 top themes, ≤5 emerging concerns, ≤10
//       frequent topics, ≤5 notable questions) with bounded retries (Req 17.1).
//    3. GROUND the result: keep the model's textual theme/concern/topic labels
//       (each clamped to its cap, Req 17.1) but REPLACE
//       `notable_high_vote_questions` with the DB-grounded, deterministic
//       selection so vote counts are never invented (Req 17.2, 17.4).
//    4. VALIDATE the grounded result against the shared schema before returning
//       (Req 17.1).
//
//  PERFORMANCE (Req 17.1): the result must be produced within 10 s. The Gateway's
//  hard timeout already caps every AI request at 30 s; this job targets the
//  tighter 10 s envelope. (The Gateway timeout is admin-configured and clamped to
//  ≤30 s; a deployment that wants the strict 10 s bound sets
//  `request_timeout_seconds` to 10.)
//
//  -----------------------------------------------------------------------------
//  SHARED-LOGIC NOTE — keep in sync with `src/lib/ai/themeRules.ts`
//  -----------------------------------------------------------------------------
//  The AUTHORITATIVE, Node-testable copy of the PURE theme-insights rules
//  (caps, empty-event rule, notable-high-vote threshold + selection, grounding)
//  lives at `src/lib/ai/themeRules.ts` (the unit tests in task 32.2 import it).
//  Deno cannot import a `src/` path at runtime, so this module RE-DECLARES an
//  identical copy of that pure logic — mirroring the
//  `src/lib/ai/clusterRules.ts` ⇄ `jobs/clustering.ts` pattern. If a rule
//  changes in one place, mirror it in the other.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` and the
//  `jsr:` supabase import are resolved by the Supabase Edge Functions / Deno
//  toolchain at deploy time.
//
//  Requirements traceability: 17.1, 17.2, 17.3, 17.4, 17.5, 20.1, 20.3.
//  Design references: Server-Side AI Gateway Design (AI features — Theme
//  insights).
// =============================================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  type ActiveProviderConfig,
  type AiJobRecorder,
  type GatewayRequest,
  runValidatedOperation,
} from '../gateway.ts';
import { aiThemeInsightsResultSchema } from '../structuredOutput.ts';

// -----------------------------------------------------------------------------
// PURE RULES — mirror of `src/lib/ai/themeRules.ts` (keep in sync).
//
// These re-declare the pure theme-insights decision logic EXACTLY as defined in
// the authoritative Node-testable module. Only the shape/rules matter; per-item
// message strings are omitted where they do not affect behaviour.
// -----------------------------------------------------------------------------

/** Theme-insights caps (Req 17.1) — mirror of the shared schema bounds. */
export const MAX_TOP_THEMES = 5;
export const MAX_EMERGING_CONCERNS = 5;
export const MAX_FREQUENT_TOPICS = 10;
export const MAX_NOTABLE_QUESTIONS = 5;

/** The theme-insights target latency in seconds (Req 17.1). */
export const THEME_INSIGHTS_TARGET_SECONDS = 10;

/** The fixed absolute notable-vote threshold (Req 17.2): vote_count ≥ 10. */
export const NOTABLE_ABSOLUTE_VOTE_THRESHOLD = 10;

/** The top-percentile fraction used for "top 10%" (Req 17.2). */
export const NOTABLE_TOP_PERCENTILE_FRACTION = 0.9;

/** A notable high-vote question (grounded from DB, Req 17.2, 17.4). */
export interface AiNotableQuestion {
  readonly question_id: string;
  readonly vote_count: number;
  readonly text: string;
}

/** The full theme-insights response shape (Req 17.1, 17.5). */
export interface AiThemeInsightsResult {
  readonly top_themes: readonly string[];
  readonly emerging_concerns: readonly string[];
  readonly frequent_topics: readonly string[];
  readonly notable_high_vote_questions: readonly AiNotableQuestion[];
  readonly has_data: boolean;
}

/** Clamps a list to at most `max` items, preserving order (Req 17.1). */
export function clampToCap<T>(items: readonly T[], max: number): T[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const bound = Math.max(0, Math.floor(max));
  return items.slice(0, bound);
}

/** Whether the selected event has NO stored questions (Req 17.5). */
export function isEmptyEvent(questionCount: number): boolean {
  if (!Number.isFinite(questionCount)) {
    return true;
  }
  return questionCount <= 0;
}

/** Builds the empty-event result (Req 17.5): empty everywhere + has_data:false. */
export function buildEmptyThemeInsightsResult(): AiThemeInsightsResult {
  return {
    top_themes: [],
    emerging_concerns: [],
    frequent_topics: [],
    notable_high_vote_questions: [],
    has_data: false,
  };
}

/** Which of the two Req 17.2 rules produced the selected (more selective) threshold. */
export type NotableThresholdRule = 'top_percentile' | 'absolute' | 'none';

/** The resolved notable-high-vote threshold for an event (Req 17.2). */
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
 * using the nearest-rank method (Req 17.2). A question is in the top 10% when
 * `vote_count >= cutoff`. Returns 0 for an empty input.
 */
export function computeTopPercentileCutoff(
  voteCounts: readonly number[],
): number {
  if (!Array.isArray(voteCounts) || voteCounts.length === 0) {
    return 0;
  }
  const sorted = voteCounts.map(safeVoteCount).sort((a, b) => a - b);
  const rank = Math.ceil(NOTABLE_TOP_PERCENTILE_FRACTION * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/** Counts how many of `voteCounts` are >= `cutoff`. */
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
 * Resolves the notable-high-vote threshold (Req 17.2): the more SELECTIVE of the
 * top-10% percentile cutoff and the fixed ≥10 cutoff — "whichever threshold
 * identifies fewer questions". Ties break toward the higher cutoff.
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
  if (absoluteCutoff >= percentileCutoff) {
    return { cutoff: absoluteCutoff, rule: 'absolute', count: absoluteCount };
  }
  return {
    cutoff: percentileCutoff,
    rule: 'top_percentile',
    count: percentileCount,
  };
}

/** A DB-grounded candidate for the notable-high-vote selection (Req 17.4). */
export interface NotableQuestionCandidate {
  readonly question_id: string;
  readonly vote_count: number;
  readonly text: string;
}

/**
 * Selects the NOTABLE HIGH-VOTE questions from the event's actual questions + DB
 * vote counts (Req 17.2, 17.4): keep those at/above the resolved threshold,
 * highest votes first (ties by question_id), capped at ≤5. The returned
 * `vote_count` is ALWAYS the DB value — never the model's.
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

/**
 * Grounds a model result against the event's ACTUAL DB data (Req 17.4): keeps
 * the model's textual categories (each clamped, Req 17.1) but REPLACES
 * `notable_high_vote_questions` with the DB-grounded selection (Req 17.2, 17.4).
 * `has_data` is true (non-empty event path).
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
    notable_high_vote_questions: selectNotableHighVoteQuestions(eventQuestions),
    has_data: true,
  };
}

// -----------------------------------------------------------------------------
// Theme-insights prompt (Req 17.3, 17.4) — GROUNDED, no fabrication.
//
// The prompt instructs the model to base its output ONLY on the provided event
// data and to NOT invent participant counts, vote totals, or questions. It
// carries ONLY the (already minimal-payload) question texts and non-identifying
// aggregate metadata — no participant identifiers (Req 20.1).
// -----------------------------------------------------------------------------

/**
 * The grounding instruction included with the batch. It asks the model to
 * produce the four capped insight categories and EXPLICITLY forbids inventing
 * counts, votes, or questions (Req 17.1, 17.3, 17.4).
 */
export const THEME_INSIGHTS_INSTRUCTION =
  'Analyse ONLY the audience questions provided for this single event and ' +
  'return a JSON object { "top_themes": string[], "emerging_concerns": ' +
  'string[], "frequent_topics": string[], "notable_high_vote_questions": ' +
  '[], "has_data": true } with at most 5 top themes, at most 5 emerging ' +
  'concerns, and at most 10 frequent topics. Base every theme, concern, and ' +
  'topic STRICTLY on the provided question text. Do NOT invent participant ' +
  'counts, vote totals, or questions, and do NOT reference any data outside ' +
  'the provided questions. Leave notable_high_vote_questions as an empty ' +
  'array — it is computed separately from the stored vote counts.';

/**
 * Builds the aggregate metadata that specialises the batch as a theme-insights
 * request. NON-identifying only (Req 20.1, 20.3): the instruction and the
 * question count.
 */
export function buildThemeInsightsMetadata(
  questionCount: number,
): Record<string, number | string> {
  return {
    operation: 'theme_insights',
    instruction: THEME_INSIGHTS_INSTRUCTION,
    question_count: questionCount,
  };
}

/**
 * Encodes the event's questions as the `question_texts` for the minimal payload,
 * prefixing each with its question id so the model keys back to rows. The id
 * prefix is a UUID — NOT a participant identifier — and the text is the question
 * body only (Req 20.1).
 */
export function encodeThemeInsightsQuestionTexts(
  questions: readonly EventQuestion[],
): string[] {
  return questions.map((q) => `[${q.id}] ${q.text}`);
}

// -----------------------------------------------------------------------------
// DB row shapes + selection (Req 17.3).
// -----------------------------------------------------------------------------

/** An event question row: id, text (for the prompt), and current vote count. */
export interface EventQuestion {
  readonly id: string;
  readonly text: string;
  readonly vote_count: number;
}

/**
 * Loads the selected event's questions via the service role, grounded ONLY in
 * this event's data (Req 17.3). Returns the rows (id, text, vote_count) or an
 * empty list on error / none. Theme insights consider the full stored question
 * set for the event (all statuses) — the notable-high-vote selection is over the
 * event's actual vote counts regardless of moderation state.
 */
export async function loadEventQuestions(
  admin: SupabaseClient,
  eventId: string,
): Promise<EventQuestion[]> {
  const { data, error } = await admin
    .from('questions')
    .select('id, text, vote_count')
    .eq('event_id', eventId);

  if (error || !Array.isArray(data)) {
    if (error) {
      console.error(
        `[ai-gateway] theme-insights question load failed for event ` +
          `${eventId}: ${error.message}`,
      );
    }
    return [];
  }
  return data as EventQuestion[];
}

// -----------------------------------------------------------------------------
// The theme-insights job (Req 17.1, 17.2, 17.3, 17.4, 17.5).
// -----------------------------------------------------------------------------

/** Sanitised, client-safe result of a theme-insights run. */
export type ThemeInsightsJobResult =
  | {
      readonly ok: true;
      /** The (grounded, schema-valid) theme-insights result. */
      readonly insights: AiThemeInsightsResult;
      /** Number of questions considered for the event. */
      readonly question_count: number;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
      readonly question_count: number;
    };

/**
 * Runs the theme-insights job for an event (Req 17.1, 17.2, 17.3, 17.4, 17.5):
 *   1. LOAD the event's questions (id, text, vote_count), grounded ONLY in this
 *      event's data (Req 17.3). If NONE, return an empty result set + `has_data:
 *      false` WITHOUT calling the provider and WITHOUT fabrication (Req 17.5).
 *   2. Submit the event's question texts with a GROUNDING PROMPT via the
 *      VALIDATED runner — the model is instructed NOT to invent counts, votes, or
 *      questions (Req 17.3, 17.4) — validated server-side against
 *      `aiThemeInsightsResultSchema` (Req 17.1).
 *   3. GROUND the result: keep the model's textual categories (clamped to their
 *      caps, Req 17.1) but REPLACE `notable_high_vote_questions` with the
 *      DB-grounded, deterministic selection (top 10% OR ≥10, whichever fewer)
 *      so vote counts are never fabricated (Req 17.2, 17.4).
 *   4. VALIDATE the grounded result against the shared schema before returning
 *      (Req 17.1).
 */
export async function runThemeInsights(
  admin: SupabaseClient,
  config: ActiveProviderConfig,
  request: GatewayRequest,
  recorder: AiJobRecorder,
): Promise<ThemeInsightsJobResult> {
  const eventId = request.eventId;
  if (eventId == null) {
    // Theme insights are scoped to a selected event; with none there is no
    // audience data → empty result + has_data:false (Req 17.5). No outbound call.
    await recorder.markSucceeded(0, config.modelId);
    return {
      ok: true,
      insights: buildEmptyThemeInsightsResult(),
      question_count: 0,
    };
  }

  const questions = await loadEventQuestions(admin, eventId);

  // Req 17.5 — no stored questions → empty result set + status indication
  // (has_data:false), WITHOUT calling the provider and WITHOUT fabrication.
  if (isEmptyEvent(questions.length)) {
    await recorder.markSucceeded(0, config.modelId);
    return {
      ok: true,
      insights: buildEmptyThemeInsightsResult(),
      question_count: questions.length,
    };
  }

  // Build the validated request: only truncated question texts + non-identifying
  // theme-insights metadata are transmitted (Req 20.1, 20.3). GROUNDING PROMPT.
  const themeRequest: GatewayRequest = {
    jobType: 'theme_insights',
    eventId,
    questionTexts: encodeThemeInsightsQuestionTexts(questions),
    aggregateMetadata: buildThemeInsightsMetadata(questions.length),
  };

  const validated = await runValidatedOperation(config, themeRequest, recorder);
  if (!validated.ok) {
    // Provider / timeout / validation failure — preserve stored event data
    // unchanged, return the sanitised error (Req 17.6; the validated runner
    // already recorded the failure).
    return {
      ok: false,
      error: validated.error,
      question_count: questions.length,
    };
  }

  // Re-parse to obtain the typed, schema-valid model output (Req 17.1).
  const parsed = aiThemeInsightsResultSchema.safeParse(validated.result.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_ai_response',
        message: 'The theme-insights response could not be validated.',
      },
      question_count: questions.length,
    };
  }

  // GROUND the result against the DB: keep the model's textual categories
  // (clamped) but replace notable_high_vote_questions with the DB-grounded
  // selection so vote counts are never fabricated (Req 17.2, 17.4).
  const candidates: NotableQuestionCandidate[] = questions.map((q) => ({
    question_id: q.id,
    vote_count: q.vote_count,
    text: q.text,
  }));
  const grounded = groundThemeInsightsResult(
    parsed.data as {
      top_themes?: readonly string[];
      emerging_concerns?: readonly string[];
      frequent_topics?: readonly string[];
    },
    candidates,
  );

  // VALIDATE the grounded result against the shared schema before returning
  // (Req 17.1) — defence-in-depth after grounding.
  const revalidated = aiThemeInsightsResultSchema.safeParse(grounded);
  if (!revalidated.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_ai_response',
        message: 'The theme-insights response could not be validated.',
      },
      question_count: questions.length,
    };
  }

  return {
    ok: true,
    insights: revalidated.data as AiThemeInsightsResult,
    question_count: questions.length,
  };
}
