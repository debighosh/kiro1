/**
 * AI end-of-event SUMMARY rules — the SHARED, framework-agnostic, PURE contract
 * (task 33.1, Req 18).
 *
 * =============================================================================
 * CALCULATED DATA IS ALWAYS FROM THE DB — NEVER FROM THE MODEL
 * =============================================================================
 * The end-of-event summary is a Markdown report with TWO clearly separated,
 * non-overlapping sections (Req 18.5):
 *
 *   - "## Calculated Data" — EVERY figure here (platform interaction counts,
 *     top questions by votes, themes/categories, poll/word-cloud results,
 *     questions answered, questions requiring follow-up) is computed DIRECTLY
 *     from the database, INDEPENDENTLY of the AI model (Req 18.1, 18.4). The
 *     functions in this module take already-loaded DB data and derive these
 *     figures deterministically — no model output is ever consulted.
 *   - "## AI Interpretation" — the AI executive summary and suggested follow-up
 *     actions ONLY. Each is rendered with a visible "AI-Generated" label
 *     (Req 18.6). When the AI is unavailable/failed, this section instead
 *     carries a visible notice that AI content could not be produced, and the
 *     calculated sections are still fully present (Req 18.7).
 *
 * The shared contract for the AI-produced portion is `aiSummaryResultSchema`
 * in `src/schemas/ai.ts` ({ executive_summary, suggested_follow_up_actions }).
 * That schema validates ONLY the AI Interpretation content; the calculated data
 * is never part of a model-output contract (Req 18.4).
 *
 * =============================================================================
 * PLAIN-TEXT RENDERING — NO HTML/MARKDOWN INJECTION FROM AI STRINGS (Req 14.8)
 * =============================================================================
 * Every AI-produced string is rendered as PLAIN TEXT: this module escapes
 * Markdown control characters in any model-produced string before embedding it
 * in the report, so a hostile model response can never inject Markdown/HTML
 * structure. Calculated (DB) strings such as question text are likewise escaped
 * defensively.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node unit tests (task 33.4). This
 * pure module is therefore the AUTHORITATIVE, Node-testable copy. Because it
 * lives under `src/` it imports the shared summary contract type from
 * `src/schemas/ai.ts` DIRECTLY.
 *
 * The Deno Edge Function cannot import a `src/` path at runtime, so the job
 * module (`supabase/functions/ai-gateway/jobs/summary.ts`) re-declares an
 * identical copy of this pure logic — exactly the `src/lib/ai/themeRules.ts` ⇄
 * `jobs/themeInsights.ts` pattern. If a rule changes here, mirror it there too.
 *
 * Requirements traceability: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 14.8.
 * Design references: Server-Side AI Gateway Design (AI features — End-of-event
 * summary).
 */

import type { AiSummaryResult } from '../../schemas/ai';

// -----------------------------------------------------------------------------
// Performance envelope (Req 18.3).
// -----------------------------------------------------------------------------

/**
 * The end-of-event summary MUST be produced within 30 s (Req 18.3). The
 * Gateway's hard timeout already caps every AI request at 30 s; the calculated
 * sections are pure/local and effectively instant, so the AI-interpretation
 * call is the only potentially slow step and is bounded by this envelope.
 */
export const SUMMARY_TARGET_SECONDS = 30;

/** The maximum number of top questions rendered by votes (Req 18.2). */
export const MAX_TOP_QUESTIONS = 10;

/** The visible label prefixing every AI-produced string (Req 18.6). */
export const AI_GENERATED_LABEL = 'AI-Generated';

/**
 * The visible notice rendered under "AI Interpretation" when the AI model is
 * unavailable or failed to return a result within the timeout (Req 18.7).
 */
export const AI_UNAVAILABLE_NOTICE =
  'AI-generated content could not be produced. All calculated data above is ' +
  'computed directly from the database and is unaffected.';

// -----------------------------------------------------------------------------
// DB row shapes (input to the pure calculations, Req 18.4).
//
// These are the already-loaded DB rows the Deno write path passes in. All
// calculated figures are derived from these — never from the AI model.
// -----------------------------------------------------------------------------

/** The moderation statuses that count as a question having been answered (Req 18.1). */
export const ANSWERED_QUESTION_STATUS = 'answered';

/**
 * A question row as loaded from the DB for the summary calculation. `status`,
 * `vote_count`, and `created_at` drive the top-questions ordering and the
 * answered / follow-up counts; `ai_category` (nullable) drives the
 * themes/categories breakdown. All figures are DB-derived (Req 18.4).
 */
export interface SummaryQuestion {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly vote_count: number;
  /** ISO 8601 submission timestamp — the earliest-submission tie-break (Req 18.2). */
  readonly created_at: string;
  /** The assigned AI category, or null when uncategorised (Req 15). */
  readonly ai_category?: string | null;
}

/** Event details rendered in the calculated report (Req 18.1). */
export interface SummaryEventDetails {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly starts_at?: string | null;
  readonly ends_at?: string | null;
}

/** A poll and its total recorded responses (Req 18.1). */
export interface SummaryPoll {
  readonly id: string;
  readonly question_text: string;
  readonly response_count: number;
}

/** A word-cloud prompt and its total recorded responses (Req 18.1). */
export interface SummaryWordCloud {
  readonly id: string;
  readonly prompt_text: string;
  readonly response_count: number;
}

/** The raw DB inputs the calculated-data computation operates on (Req 18.4). */
export interface SummaryInputs {
  readonly event: SummaryEventDetails;
  readonly questions: readonly SummaryQuestion[];
  readonly polls?: readonly SummaryPoll[];
  readonly wordClouds?: readonly SummaryWordCloud[];
}

// -----------------------------------------------------------------------------
// Calculated-data output shape (Req 18.4, 18.5).
// -----------------------------------------------------------------------------

/** A single top-question entry (Req 18.2). */
export interface TopQuestion {
  readonly id: string;
  readonly text: string;
  readonly vote_count: number;
  readonly created_at: string;
}

/** A category/theme count derived from the DB `ai_category` column (Req 18.1). */
export interface CategoryCount {
  readonly category: string;
  readonly count: number;
}

/**
 * The fully-computed "Calculated Data" structure (Req 18.4). Every field is
 * derived deterministically from {@link SummaryInputs}; NONE of it depends on
 * the AI model.
 */
export interface CalculatedData {
  readonly event: SummaryEventDetails;
  /** Total questions submitted (all statuses) — a platform interaction count. */
  readonly totalQuestions: number;
  /** Total votes across all questions — a platform interaction count. */
  readonly totalVotes: number;
  /** Total poll responses across all polls — a platform interaction count. */
  readonly totalPollResponses: number;
  /** Total word-cloud responses across all prompts — a platform interaction count. */
  readonly totalWordCloudResponses: number;
  /** ≤10 top questions by descending votes, ties by earliest submission (Req 18.2). */
  readonly topQuestions: readonly TopQuestion[];
  /** Category/theme breakdown from `ai_category` (Req 18.1). */
  readonly categories: readonly CategoryCount[];
  /** Poll results (question text + response count) (Req 18.1). */
  readonly polls: readonly SummaryPoll[];
  /** Word-cloud results (prompt text + response count) (Req 18.1). */
  readonly wordClouds: readonly SummaryWordCloud[];
  /** Count of questions marked answered (Req 18.1). */
  readonly answeredCount: number;
  /** Questions requiring follow-up: visible but not yet answered (Req 18.1). */
  readonly followUpCount: number;
  /**
   * Whether the event has ZERO recorded platform interactions (Req 18.8): no
   * questions, votes, poll responses, or word-cloud responses. When true the
   * report still renders every calculated section with a 0 / empty-state.
   */
  readonly hasNoInteractions: boolean;
}

// -----------------------------------------------------------------------------
// Top-questions selection (Req 18.2).
// -----------------------------------------------------------------------------

/** Normalises a vote count to a non-negative integer (fail closed to 0). */
function safeVoteCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Parses an ISO 8601 timestamp to epoch milliseconds for the earliest-submission
 * tie-break (Req 18.2). An unparseable value sorts LAST (treated as +Infinity)
 * so a well-formed earlier submission always wins the tie.
 */
function submissionTime(value: unknown): number {
  if (typeof value !== 'string') {
    return Number.POSITIVE_INFINITY;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Selects the top questions by votes (Req 18.2): at most
 * {@link MAX_TOP_QUESTIONS} (10) questions ordered by DESCENDING vote count,
 * with ties broken by EARLIEST submission timestamp (created_at ascending).
 * A final id tie-break keeps the ordering fully deterministic. PURE; never
 * throws; does not mutate its input.
 */
export function selectTopQuestions(
  questions: readonly SummaryQuestion[],
): TopQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    return [];
  }
  const sorted = questions
    .map<TopQuestion>((q) => ({
      id: q.id,
      text: q.text,
      vote_count: safeVoteCount(q.vote_count),
      created_at: q.created_at,
    }))
    .sort((a, b) => {
      // 1) descending vote count.
      if (b.vote_count !== a.vote_count) {
        return b.vote_count - a.vote_count;
      }
      // 2) earliest submission wins the tie (ascending created_at).
      const ta = submissionTime(a.created_at);
      const tb = submissionTime(b.created_at);
      if (ta !== tb) {
        return ta - tb;
      }
      // 3) id tie-break for full determinism.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  return sorted.slice(0, MAX_TOP_QUESTIONS);
}

// -----------------------------------------------------------------------------
// Calculated-data computation (Req 18.4) — ALL figures directly from the DB.
// -----------------------------------------------------------------------------

/** Sums a list of non-negative response counts, failing closed to 0 per item. */
function sumResponseCounts(
  items: readonly { readonly response_count: number }[] | undefined,
): number {
  if (!Array.isArray(items)) {
    return 0;
  }
  let total = 0;
  for (const item of items) {
    total += safeVoteCount(item.response_count);
  }
  return total;
}

/**
 * Computes the category/theme breakdown from the DB `ai_category` column
 * (Req 18.1). Counts questions per assigned category, sorted by descending
 * count (ties alphabetical). Uncategorised questions are excluded. PURE.
 */
export function computeCategoryCounts(
  questions: readonly SummaryQuestion[],
): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const q of questions) {
    const category = q.ai_category;
    if (typeof category === 'string' && category.trim().length > 0) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map<CategoryCount>(([category, count]) => ({ category, count }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
    });
}

/**
 * Computes the ENTIRE "Calculated Data" structure directly from the provided DB
 * data, INDEPENDENTLY of the AI model (Req 18.4). This is a pure, deterministic
 * derivation — no model output is ever consulted. The empty-event case (Req 18.8)
 * is signalled by {@link CalculatedData.hasNoInteractions}; every section is
 * still populated (with 0 counts / empty lists).
 */
export function computeCalculatedData(inputs: SummaryInputs): CalculatedData {
  const questions = Array.isArray(inputs?.questions) ? inputs.questions : [];
  const polls = Array.isArray(inputs?.polls) ? inputs.polls : [];
  const wordClouds = Array.isArray(inputs?.wordClouds) ? inputs.wordClouds : [];

  const totalQuestions = questions.length;
  const totalVotes = questions.reduce(
    (sum, q) => sum + safeVoteCount(q.vote_count),
    0,
  );
  const totalPollResponses = sumResponseCounts(polls);
  const totalWordCloudResponses = sumResponseCounts(wordClouds);

  const answeredCount = questions.filter(
    (q) => q.status === ANSWERED_QUESTION_STATUS,
  ).length;
  // "Requiring follow-up": audience-visible, moderator-approved questions that
  // have NOT yet been marked answered (Req 18.1). Pending/hidden are excluded.
  const followUpCount = questions.filter(
    (q) => q.status === 'approved' || q.status === 'featured',
  ).length;

  const hasNoInteractions =
    totalQuestions === 0 &&
    totalVotes === 0 &&
    totalPollResponses === 0 &&
    totalWordCloudResponses === 0;

  return {
    event: inputs.event,
    totalQuestions,
    totalVotes,
    totalPollResponses,
    totalWordCloudResponses,
    topQuestions: selectTopQuestions(questions),
    categories: computeCategoryCounts(questions),
    polls,
    wordClouds,
    answeredCount,
    followUpCount,
    hasNoInteractions,
  };
}

// -----------------------------------------------------------------------------
// Plain-text escaping (Req 14.8) — no Markdown/HTML injection from any string.
// -----------------------------------------------------------------------------

/**
 * Escapes a value so it renders as INERT plain text inside a Markdown document
 * (Req 14.8): backslash-escapes Markdown control characters and neutralises HTML
 * angle brackets, and collapses newlines to spaces so a single embedded value
 * cannot break the report structure. Non-string input becomes an empty string.
 * PURE; never throws.
 */
export function escapeMarkdownText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[`*_{}[\]()#+\-.!|>~]/g, (ch) => `\\${ch}`)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n|\r|\n/g, ' ');
}

// -----------------------------------------------------------------------------
// Markdown assembly (Req 18.1, 18.5, 18.6, 18.7).
// -----------------------------------------------------------------------------

/** Formats an optional ISO timestamp for display, or a dash when absent. */
function formatTimestamp(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return '—';
  }
  return escapeMarkdownText(value);
}

/** Renders the always-present "## Calculated Data" section (Req 18.4, 18.5). */
function buildCalculatedSection(data: CalculatedData): string {
  const lines: string[] = [];
  lines.push('## Calculated Data');
  lines.push('');
  lines.push(
    'All figures in this section are computed directly from the database, ' +
      'independently of the AI model.',
  );
  lines.push('');

  // Event details.
  lines.push('### Event Details');
  lines.push('');
  lines.push(`- **Name:** ${escapeMarkdownText(data.event.name)}`);
  lines.push(`- **Status:** ${escapeMarkdownText(data.event.status)}`);
  lines.push(`- **Starts:** ${formatTimestamp(data.event.starts_at)}`);
  lines.push(`- **Ends:** ${formatTimestamp(data.event.ends_at)}`);
  lines.push('');

  // Platform interaction counts (Req 18.1, 18.4, 18.8).
  lines.push('### Platform Interaction Counts');
  lines.push('');
  if (data.hasNoInteractions) {
    lines.push('_No platform interactions were recorded for this event._');
    lines.push('');
  }
  lines.push(`- **Total questions:** ${data.totalQuestions}`);
  lines.push(`- **Total question votes:** ${data.totalVotes}`);
  lines.push(`- **Total poll responses:** ${data.totalPollResponses}`);
  lines.push(
    `- **Total word-cloud responses:** ${data.totalWordCloudResponses}`,
  );
  lines.push('');

  // Top questions by votes (Req 18.2).
  lines.push('### Top Questions by Votes');
  lines.push('');
  if (data.topQuestions.length === 0) {
    lines.push('_No questions were submitted._');
  } else {
    data.topQuestions.forEach((q, index) => {
      lines.push(
        `${index + 1}. ${escapeMarkdownText(q.text)} — ${q.vote_count} vote(s)`,
      );
    });
  }
  lines.push('');

  // Themes and categories (Req 18.1).
  lines.push('### Themes and Categories');
  lines.push('');
  if (data.categories.length === 0) {
    lines.push('_No categorised questions._');
  } else {
    for (const c of data.categories) {
      lines.push(`- **${escapeMarkdownText(c.category)}:** ${c.count}`);
    }
  }
  lines.push('');

  // Poll results (Req 18.1).
  lines.push('### Poll Results');
  lines.push('');
  if (data.polls.length === 0) {
    lines.push('_No polls were created._');
  } else {
    for (const p of data.polls) {
      lines.push(
        `- ${escapeMarkdownText(p.question_text)} — ${safeVoteCount(
          p.response_count,
        )} response(s)`,
      );
    }
  }
  lines.push('');

  // Word-cloud results (Req 18.1).
  lines.push('### Word-Cloud Results');
  lines.push('');
  if (data.wordClouds.length === 0) {
    lines.push('_No word-cloud prompts were created._');
  } else {
    for (const w of data.wordClouds) {
      lines.push(
        `- ${escapeMarkdownText(w.prompt_text)} — ${safeVoteCount(
          w.response_count,
        )} response(s)`,
      );
    }
  }
  lines.push('');

  // Questions marked answered (Req 18.1).
  lines.push('### Questions Marked Answered');
  lines.push('');
  lines.push(`- **Answered:** ${data.answeredCount}`);
  lines.push('');

  // Questions requiring follow-up (Req 18.1).
  lines.push('### Questions Requiring Follow-Up');
  lines.push('');
  lines.push(`- **Requiring follow-up:** ${data.followUpCount}`);

  return lines.join('\n');
}

/**
 * Renders the "## AI Interpretation" section (Req 18.5, 18.6, 18.7).
 *
 * When `aiInterpretation` is present, its executive summary and each suggested
 * follow-up action are rendered under this heading, EACH prefixed with the
 * visible "AI-Generated" label (Req 18.6). Every AI string is escaped to plain
 * text (Req 14.8).
 *
 * When `aiInterpretation` is null (AI unavailable / failed, Req 18.7), the
 * executive summary and follow-up actions are OMITTED and a visible notice that
 * AI content could not be produced is rendered instead.
 */
function buildAiInterpretationSection(
  aiInterpretation: AiSummaryResult | null,
): string {
  const lines: string[] = [];
  lines.push('## AI Interpretation');
  lines.push('');

  if (aiInterpretation == null) {
    // Req 18.7 — AI unavailable: omit AI content, show the visible notice.
    lines.push(`> **${AI_GENERATED_LABEL} content unavailable.** ${AI_UNAVAILABLE_NOTICE}`);
    return lines.join('\n');
  }

  // Executive summary — prefixed with the visible "AI-Generated" label (Req 18.6).
  lines.push('### Executive Summary');
  lines.push('');
  lines.push(
    `**${AI_GENERATED_LABEL}:** ${escapeMarkdownText(
      aiInterpretation.executive_summary,
    )}`,
  );
  lines.push('');

  // Suggested follow-up actions — each prefixed "AI-Generated" (Req 18.6).
  lines.push('### Suggested Follow-Up Actions');
  lines.push('');
  const actions = Array.isArray(aiInterpretation.suggested_follow_up_actions)
    ? aiInterpretation.suggested_follow_up_actions
    : [];
  if (actions.length === 0) {
    lines.push(`- **${AI_GENERATED_LABEL}:** _No follow-up actions were suggested._`);
  } else {
    for (const action of actions) {
      lines.push(`- **${AI_GENERATED_LABEL}:** ${escapeMarkdownText(action)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Assembles the full end-of-event summary Markdown report (Req 18.1, 18.5,
 * 18.6, 18.7).
 *
 * The report ALWAYS contains a "## Calculated Data" section built entirely from
 * the DB-derived {@link CalculatedData} (Req 18.4, 18.5) followed by a SEPARATE,
 * non-overlapping "## AI Interpretation" section (Req 18.5). When
 * `aiInterpretation` is present its executive summary + follow-up actions are
 * rendered under that heading, each prefixed with the visible "AI-Generated"
 * label (Req 18.6). When `aiInterpretation` is null (AI unavailable, Req 18.7)
 * the calculated sections are STILL fully present and the AI Interpretation
 * section carries a visible "AI content could not be produced" notice. PURE;
 * never throws.
 */
export function buildSummaryMarkdown(
  calculatedData: CalculatedData,
  aiInterpretation: AiSummaryResult | null,
): string {
  const parts: string[] = [];
  parts.push(`# End-of-Event Summary: ${escapeMarkdownText(calculatedData.event.name)}`);
  parts.push('');
  parts.push(buildCalculatedSection(calculatedData));
  parts.push('');
  parts.push(buildAiInterpretationSection(aiInterpretation));
  parts.push('');
  return parts.join('\n');
}
