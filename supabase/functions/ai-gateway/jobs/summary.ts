// =============================================================================
// AI GATEWAY — END-OF-EVENT SUMMARY JOB (Supabase Edge Functions / Deno runtime)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module implements the `summary` AI job for the Server-Side AI Gateway
//  (Requirement 18). Like `jobs/categorisation.ts`, `jobs/clustering.ts`, and
//  `jobs/themeInsights.ts` it is a small, COMPOSING module: it reuses the
//  validated egress runner in `gateway.ts` (`runValidatedOperation` → SSRF
//  preflight → pinned fetch → resolved credential → hard timeout → provider
//  call → server-side structured-output validation with bounded retries) and
//  the shared summary contract from `structuredOutput.ts`
//  (`aiSummaryResultSchema` / `validateStructuredOutput('summary', …)`). It does
//  NOT re-implement any SSRF, timeout, credential, or retry logic.
//
//  =============================================================================
//  CALCULATED DATA IS ALWAYS FROM THE DB — NEVER FROM THE MODEL
//  =============================================================================
//  The end-of-event summary is a Markdown report with TWO clearly separated,
//  non-overlapping sections (Req 18.5):
//
//    - "## Calculated Data" — EVERY figure (platform interaction counts, top
//      questions by votes, themes/categories, poll/word-cloud results,
//      questions answered, questions requiring follow-up) is computed DIRECTLY
//      from the database, INDEPENDENTLY of the AI model (Req 18.1, 18.4). This
//      section is produced BEFORE any provider call and does not depend on it.
//    - "## AI Interpretation" — the AI executive summary and suggested follow-up
//      actions ONLY, each prefixed with the visible "AI-Generated" label
//      (Req 18.6). When the AI is unavailable/failed, this section instead
//      carries a visible notice that AI content could not be produced, and the
//      calculated sections are STILL fully present (Req 18.7).
//
//  IMPORTANT — the calculated report is ALWAYS produced. If the AI interpretation
//  fails for ANY reason (provider unreachable, timeout at the admin-configured
//  request timeout, invalid/unvalidatable response), this job STILL returns a
//  successful Markdown report built from the calculated (DB) sections plus the
//  visible "AI content could not be produced" notice (Req 18.7). The AI failure
//  never blocks the summary (Req 19.1).
//
//  PERFORMANCE (Req 18.3): the report must be produced within 30 s. The
//  calculated sections are local/instant; the AI-interpretation call is the only
//  potentially slow step and is bounded by the Gateway's hard timeout (≤30 s).
//
//  -----------------------------------------------------------------------------
//  SHARED-LOGIC NOTE — keep in sync with `src/lib/ai/summaryRules.ts`
//  -----------------------------------------------------------------------------
//  The AUTHORITATIVE, Node-testable copy of the PURE summary rules
//  (top-questions selection, calculated-data computation, plain-text escaping,
//  Markdown assembly) lives at `src/lib/ai/summaryRules.ts` (the unit tests in
//  task 33.4 import it). Deno cannot import a `src/` path at runtime, so this
//  module RE-DECLARES an identical copy of that pure logic — mirroring the
//  `src/lib/ai/themeRules.ts` ⇄ `jobs/themeInsights.ts` pattern. If a rule
//  changes in one place, mirror it in the other.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` and the
//  `jsr:` supabase import are resolved by the Supabase Edge Functions / Deno
//  toolchain at deploy time.
//
//  Requirements traceability: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8,
//  14.8, 20.1, 20.3.
//  Design references: Server-Side AI Gateway Design (AI features — End-of-event
//  summary).
// =============================================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  type ActiveProviderConfig,
  type AiJobRecorder,
  type GatewayRequest,
  runValidatedOperation,
} from '../gateway.ts';
import { aiSummaryResultSchema } from '../structuredOutput.ts';

// -----------------------------------------------------------------------------
// PURE RULES — mirror of `src/lib/ai/summaryRules.ts` (keep in sync).
//
// These re-declare the pure summary logic EXACTLY as defined in the
// authoritative Node-testable module. Only the shape/rules matter; per-message
// strings are kept identical where they appear in the rendered report.
// -----------------------------------------------------------------------------

/** The maximum number of top questions rendered by votes (Req 18.2). */
export const MAX_TOP_QUESTIONS = 10;

/** The end-of-event summary target latency in seconds (Req 18.3). */
export const SUMMARY_TARGET_SECONDS = 30;

/** The visible label prefixing every AI-produced string (Req 18.6). */
export const AI_GENERATED_LABEL = 'AI-Generated';

/** The visible notice rendered when the AI model is unavailable (Req 18.7). */
export const AI_UNAVAILABLE_NOTICE =
  'AI-generated content could not be produced. All calculated data above is ' +
  'computed directly from the database and is unaffected.';

/** The moderation status that counts as a question having been answered (Req 18.1). */
export const ANSWERED_QUESTION_STATUS = 'answered';

/** The AI-produced portion of the summary (Req 18.6) — mirror of aiSummaryResultSchema. */
export interface AiSummaryResult {
  readonly executive_summary: string;
  readonly suggested_follow_up_actions: string[];
}

/** A question row loaded from the DB for the summary calculation (Req 18.4). */
export interface SummaryQuestion {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly vote_count: number;
  readonly created_at: string;
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

/** The fully-computed "Calculated Data" structure (Req 18.4). */
export interface CalculatedData {
  readonly event: SummaryEventDetails;
  readonly totalQuestions: number;
  readonly totalVotes: number;
  readonly totalPollResponses: number;
  readonly totalWordCloudResponses: number;
  readonly topQuestions: readonly TopQuestion[];
  readonly categories: readonly CategoryCount[];
  readonly polls: readonly SummaryPoll[];
  readonly wordClouds: readonly SummaryWordCloud[];
  readonly answeredCount: number;
  readonly followUpCount: number;
  readonly hasNoInteractions: boolean;
}

/** Normalises a vote/response count to a non-negative integer (fail closed to 0). */
function safeVoteCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Parses an ISO 8601 timestamp to epoch ms; unparseable sorts LAST (Req 18.2). */
function submissionTime(value: unknown): number {
  if (typeof value !== 'string') {
    return Number.POSITIVE_INFINITY;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Selects the top questions by votes (Req 18.2): ≤10 by DESCENDING vote count,
 * ties broken by EARLIEST submission (created_at ascending), then id.
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
      if (b.vote_count !== a.vote_count) {
        return b.vote_count - a.vote_count;
      }
      const ta = submissionTime(a.created_at);
      const tb = submissionTime(b.created_at);
      if (ta !== tb) {
        return ta - tb;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  return sorted.slice(0, MAX_TOP_QUESTIONS);
}

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

/** Computes the category/theme breakdown from the DB `ai_category` column (Req 18.1). */
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
 * Computes the ENTIRE "Calculated Data" structure directly from the DB data,
 * INDEPENDENTLY of the AI model (Req 18.4). Empty-event case (Req 18.8) is
 * flagged via `hasNoInteractions`; every section is still populated.
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

/**
 * Escapes a value so it renders as INERT plain text inside a Markdown document
 * (Req 14.8): backslash-escapes Markdown control characters, neutralises HTML
 * angle brackets, and collapses newlines. Non-string input → empty string.
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

  lines.push('### Event Details');
  lines.push('');
  lines.push(`- **Name:** ${escapeMarkdownText(data.event.name)}`);
  lines.push(`- **Status:** ${escapeMarkdownText(data.event.status)}`);
  lines.push(`- **Starts:** ${formatTimestamp(data.event.starts_at)}`);
  lines.push(`- **Ends:** ${formatTimestamp(data.event.ends_at)}`);
  lines.push('');

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

  lines.push('### Questions Marked Answered');
  lines.push('');
  lines.push(`- **Answered:** ${data.answeredCount}`);
  lines.push('');

  lines.push('### Questions Requiring Follow-Up');
  lines.push('');
  lines.push(`- **Requiring follow-up:** ${data.followUpCount}`);

  return lines.join('\n');
}

/** Renders the "## AI Interpretation" section (Req 18.5, 18.6, 18.7). */
function buildAiInterpretationSection(
  aiInterpretation: AiSummaryResult | null,
): string {
  const lines: string[] = [];
  lines.push('## AI Interpretation');
  lines.push('');

  if (aiInterpretation == null) {
    lines.push(
      `> **${AI_GENERATED_LABEL} content unavailable.** ${AI_UNAVAILABLE_NOTICE}`,
    );
    return lines.join('\n');
  }

  lines.push('### Executive Summary');
  lines.push('');
  lines.push(
    `**${AI_GENERATED_LABEL}:** ${escapeMarkdownText(
      aiInterpretation.executive_summary,
    )}`,
  );
  lines.push('');

  lines.push('### Suggested Follow-Up Actions');
  lines.push('');
  const actions = Array.isArray(aiInterpretation.suggested_follow_up_actions)
    ? aiInterpretation.suggested_follow_up_actions
    : [];
  if (actions.length === 0) {
    lines.push(
      `- **${AI_GENERATED_LABEL}:** _No follow-up actions were suggested._`,
    );
  } else {
    for (const action of actions) {
      lines.push(`- **${AI_GENERATED_LABEL}:** ${escapeMarkdownText(action)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Assembles the full end-of-event summary Markdown report (Req 18.1, 18.5,
 * 18.6, 18.7): a "## Calculated Data" section (always, from the DB) followed by
 * a separate "## AI Interpretation" section (AI-Generated content OR the
 * unavailable notice).
 */
export function buildSummaryMarkdown(
  calculatedData: CalculatedData,
  aiInterpretation: AiSummaryResult | null,
): string {
  const parts: string[] = [];
  parts.push(
    `# End-of-Event Summary: ${escapeMarkdownText(calculatedData.event.name)}`,
  );
  parts.push('');
  parts.push(buildCalculatedSection(calculatedData));
  parts.push('');
  parts.push(buildAiInterpretationSection(aiInterpretation));
  parts.push('');
  return parts.join('\n');
}

// -----------------------------------------------------------------------------
// Summary prompt (Req 18.6, 20.1, 20.3) — AI Interpretation ONLY.
//
// The prompt asks ONLY for the AI-produced portion: an executive summary and
// suggested follow-up actions. The calculated data is NOT trusted from the model
// (Req 18.4). It carries ONLY the (already minimal-payload) question texts and
// non-identifying aggregate counts — no participant identifiers (Req 20.1, 20.3).
// -----------------------------------------------------------------------------

/**
 * The summary-interpretation instruction. It asks the model to produce ONLY an
 * executive summary + suggested follow-up actions from the provided event data,
 * and NOT to invent counts or figures — those are computed separately from the
 * DB (Req 18.4, 20.1).
 */
export const SUMMARY_INSTRUCTION =
  'You are producing ONLY the interpretation portion of an end-of-event ' +
  'summary. Return a JSON object { "executive_summary": string, ' +
  '"suggested_follow_up_actions": string[] }. Base your interpretation ONLY ' +
  'on the provided audience questions and the aggregate counts. Do NOT invent ' +
  'participant counts, vote totals, or figures — all quantitative data is ' +
  'computed separately from the database. Keep the executive summary concise ' +
  'and the follow-up actions specific and actionable.';

/**
 * Builds the aggregate metadata that specialises the batch as a summary request.
 * NON-identifying only (Req 20.1, 20.3): the instruction and the aggregate
 * counts the model may reference in prose.
 */
export function buildSummaryMetadata(
  calculated: CalculatedData,
): Record<string, number | string> {
  return {
    operation: 'summary',
    instruction: SUMMARY_INSTRUCTION,
    total_questions: calculated.totalQuestions,
    total_votes: calculated.totalVotes,
    total_poll_responses: calculated.totalPollResponses,
    total_word_cloud_responses: calculated.totalWordCloudResponses,
    answered_count: calculated.answeredCount,
    follow_up_count: calculated.followUpCount,
  };
}

/** Encodes the event's questions as the `question_texts` for the minimal payload. */
export function encodeSummaryQuestionTexts(
  questions: readonly SummaryQuestion[],
): string[] {
  return questions.map((q) => `[${q.id}] ${q.text}`);
}

// -----------------------------------------------------------------------------
// DB loading (Req 18.4) — the calculated data ALWAYS comes from the DB.
// -----------------------------------------------------------------------------

/** Loads the event details for the summary header (Req 18.1). */
export async function loadEventDetails(
  admin: SupabaseClient,
  eventId: string,
): Promise<SummaryEventDetails | null> {
  const { data, error } = await admin
    .from('events')
    .select('id, name, status, starts_at, ends_at')
    .eq('id', eventId)
    .maybeSingle<SummaryEventDetails>();

  if (error || !data) {
    if (error) {
      console.error(
        `[ai-gateway] summary event load failed for event ${eventId}: ` +
          `${error.message}`,
      );
    }
    return null;
  }
  return data;
}

/** Loads the event's questions (id, text, status, vote_count, created_at, ai_category) (Req 18.4). */
export async function loadSummaryQuestions(
  admin: SupabaseClient,
  eventId: string,
): Promise<SummaryQuestion[]> {
  const { data, error } = await admin
    .from('questions')
    .select('id, text, status, vote_count, created_at, ai_category')
    .eq('event_id', eventId);

  if (error || !Array.isArray(data)) {
    if (error) {
      console.error(
        `[ai-gateway] summary question load failed for event ${eventId}: ` +
          `${error.message}`,
      );
    }
    return [];
  }
  return data as SummaryQuestion[];
}

/** Loads the event's polls, each with its total recorded response count (Req 18.1). */
export async function loadSummaryPolls(
  admin: SupabaseClient,
  eventId: string,
): Promise<SummaryPoll[]> {
  const { data, error } = await admin
    .from('polls')
    .select('id, question_text')
    .eq('event_id', eventId);

  if (error || !Array.isArray(data)) {
    if (error) {
      console.error(
        `[ai-gateway] summary poll load failed for event ${eventId}: ` +
          `${error.message}`,
      );
    }
    return [];
  }

  const polls: SummaryPoll[] = [];
  for (const poll of data as { id: string; question_text: string }[]) {
    const { count, error: countError } = await admin
      .from('poll_responses')
      .select('id', { count: 'exact', head: true })
      .eq('poll_id', poll.id);
    if (countError) {
      console.error(
        `[ai-gateway] summary poll-response count failed for poll ${poll.id}: ` +
          `${countError.message}`,
      );
    }
    polls.push({
      id: poll.id,
      question_text: poll.question_text,
      response_count: typeof count === 'number' ? count : 0,
    });
  }
  return polls;
}

/** Loads the event's word-cloud prompts, each with its total response count (Req 18.1). */
export async function loadSummaryWordClouds(
  admin: SupabaseClient,
  eventId: string,
): Promise<SummaryWordCloud[]> {
  const { data, error } = await admin
    .from('word_cloud_prompts')
    .select('id, prompt_text')
    .eq('event_id', eventId);

  if (error || !Array.isArray(data)) {
    if (error) {
      console.error(
        `[ai-gateway] summary word-cloud load failed for event ${eventId}: ` +
          `${error.message}`,
      );
    }
    return [];
  }

  const wordClouds: SummaryWordCloud[] = [];
  for (const prompt of data as { id: string; prompt_text: string }[]) {
    const { count, error: countError } = await admin
      .from('word_cloud_responses')
      .select('id', { count: 'exact', head: true })
      .eq('prompt_id', prompt.id);
    if (countError) {
      console.error(
        `[ai-gateway] summary word-cloud-response count failed for prompt ` +
          `${prompt.id}: ${countError.message}`,
      );
    }
    wordClouds.push({
      id: prompt.id,
      prompt_text: prompt.prompt_text,
      response_count: typeof count === 'number' ? count : 0,
    });
  }
  return wordClouds;
}

// -----------------------------------------------------------------------------
// The summary job (Req 18.1–18.8, 19.1).
// -----------------------------------------------------------------------------

/**
 * Sanitised, client-safe result of a summary run. The calculated report is
 * ALWAYS produced (Req 18.7); `ai_available` conveys whether the AI
 * Interpretation section carries AI-Generated content or the unavailable notice.
 */
export type SummaryJobResult =
  | {
      readonly ok: true;
      /** The full Markdown report (calculated + AI-interpretation/notice). */
      readonly markdown: string;
      /** True when the AI Interpretation section contains AI-Generated content. */
      readonly ai_available: boolean;
      /** Number of questions considered for the event. */
      readonly question_count: number;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
      readonly question_count: number;
    };

/**
 * Runs the end-of-event summary job for an event (Req 18.1–18.8, 19.1):
 *   1. LOAD the event's questions, polls, and word-cloud results from the DB and
 *      compute the "Calculated Data" section INDEPENDENTLY of the model
 *      (Req 18.4). This is always produced.
 *   2. ATTEMPT the AI interpretation via the VALIDATED runner against
 *      `aiSummaryResultSchema` (Req 18.6). The prompt carries ONLY question text
 *      + non-identifying aggregate counts (Req 20.1, 20.3).
 *   3. If the AI succeeds → assemble the full Markdown with both sections, the AI
 *      content prefixed "AI-Generated" (Req 18.1, 18.5, 18.6).
 *   4. If the AI is unavailable/fails (unreachable, timeout, invalid response)
 *      → assemble the Markdown with the calculated sections PLUS the visible
 *      "AI content could not be produced" notice, and STILL return success —
 *      the calculated report is always produced (Req 18.7, 19.1).
 *
 * Targets ≤30 s (Req 18.3); the Gateway hard timeout caps the AI call at ≤30 s.
 */
export async function runSummary(
  admin: SupabaseClient,
  config: ActiveProviderConfig,
  request: GatewayRequest,
  recorder: AiJobRecorder,
): Promise<SummaryJobResult> {
  const eventId = request.eventId;
  if (eventId == null) {
    // The summary is scoped to a selected event; with none there is nothing to
    // report. No outbound call is made.
    await recorder.markFailed(0, 'no event selected', config.modelId);
    return {
      ok: false,
      error: {
        code: 'event_required',
        message: 'An event must be selected to generate a summary.',
      },
      question_count: 0,
    };
  }

  // 1) Load the event details + all calculated data DIRECTLY from the DB.
  const event = await loadEventDetails(admin, eventId);
  if (event == null) {
    await recorder.markFailed(0, 'event not found', config.modelId);
    return {
      ok: false,
      error: {
        code: 'event_not_found',
        message: 'The requested event could not be found.',
      },
      question_count: 0,
    };
  }

  const [questions, polls, wordClouds] = await Promise.all([
    loadSummaryQuestions(admin, eventId),
    loadSummaryPolls(admin, eventId),
    loadSummaryWordClouds(admin, eventId),
  ]);

  // Compute the calculated data INDEPENDENTLY of the model (Req 18.4). This is
  // always produced and never depends on the AI call succeeding.
  const calculated = computeCalculatedData({
    event,
    questions,
    polls,
    wordClouds,
  });

  // 2) ATTEMPT the AI interpretation via the VALIDATED runner (Req 18.6). Only
  // truncated question texts + non-identifying aggregate counts are transmitted
  // (Req 20.1, 20.3).
  const summaryRequest: GatewayRequest = {
    jobType: 'summary',
    eventId,
    questionTexts: encodeSummaryQuestionTexts(questions),
    aggregateMetadata: buildSummaryMetadata(calculated),
  };

  const validated = await runValidatedOperation(config, summaryRequest, recorder);

  // 4) AI unavailable / failed → STILL produce the calculated report + visible
  // notice, and return success (Req 18.7, 19.1). The validated runner already
  // recorded the failure; the calculated data is unaffected.
  if (!validated.ok) {
    return {
      ok: true,
      markdown: buildSummaryMarkdown(calculated, null),
      ai_available: false,
      question_count: questions.length,
    };
  }

  // Re-parse to obtain the typed, schema-valid AI interpretation (Req 18.6).
  const parsed = aiSummaryResultSchema.safeParse(validated.result.data);
  if (!parsed.success) {
    // An unvalidatable interpretation is treated as AI-unavailable for the
    // report: calculated sections + visible notice, still successful (Req 18.7).
    return {
      ok: true,
      markdown: buildSummaryMarkdown(calculated, null),
      ai_available: false,
      question_count: questions.length,
    };
  }

  // 3) AI succeeded → assemble the full Markdown with both sections, the AI
  // content prefixed "AI-Generated" (Req 18.1, 18.5, 18.6).
  const interpretation = parsed.data as AiSummaryResult;
  return {
    ok: true,
    markdown: buildSummaryMarkdown(calculated, interpretation),
    ai_available: true,
    question_count: questions.length,
  };
}
