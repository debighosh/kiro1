/**
 * Moderation client helper (Task 16.2).
 *
 * This module is the client-side gateway the admin moderation queue
 * ({@link ModerationQueue}, task 16.2) uses to (a) read the FULL question list
 * for an event — including `pending`/`hidden` rows that the audience never sees
 * — and (b) apply a moderation action (approve/feature/answer/hide) to a
 * question.
 *
 * ── Read path (authenticated) ────────────────────────────────────────────────
 * Migration `20260101000011_questions_rls.sql` adds an authenticated SELECT
 * policy on `questions` with `USING (true)`, so a signed-in admin may read
 * EVERY question regardless of status (including `pending` and `hidden`). We
 * therefore read directly through the browser {@link supabase} client while the
 * admin session is active — the anon read path (`readAudienceQuestions` in
 * `../lib/questions`) is deliberately NOT reused because it filters to
 * `approved`/`featured` only.
 *
 * We select only the non-sensitive columns the queue needs — `id`, `text`,
 * `status`, `ai_category`, `vote_count`, `created_at`, `event_id`. We NEVER
 * select `participant_identifier` (Req 8.6, 24.8); it must never reach the UI.
 *
 * NOTE on `ai_category`: the column DOES exist on the `questions` table (see
 * migration `20260101000009_questions.sql` — `ai_category text` nullable). For
 * Milestone 2 it is populated by a later AI-categorisation task, so it will be
 * `null` for most/all rows; the category filter therefore operates over a real
 * DB column that is simply mostly-null today.
 *
 * ── Mutation path (authenticated Edge Function) ──────────────────────────────
 * The SPA never updates `questions.status` directly — there is no client UPDATE
 * policy on `questions` (task 12.1). Every moderation change is routed through
 * the authenticated `moderate-question` Edge Function (task 16.1), which
 * verifies the admin JWT, applies the change with the service role (bypassing
 * RLS), and writes an `audit_log` entry (`change_type='moderation'`).
 * `supabase.functions.invoke` attaches the caller's `Authorization: Bearer
 * <access_token>` automatically.
 *
 * The Edge Function contract (supabase/functions/moderate-question/index.ts):
 *   POST body: { question_id: uuid, action: 'approve'|'feature'|'answer'|'hide' }
 *   200 body:  { question: { id, status }, status, previous_status, audit_written }
 *   error:     { error: { code, message, fields? } } with an HTTP status —
 *              401 unauthorized, 400 validation_failed/invalid_json,
 *              404 question_not_found, 405 method_not_allowed, 5xx *_failed.
 *
 * This mirrors the typed-error pattern used by {@link EventError} in
 * `../lib/events` and {@link QuestionError} in `../lib/questions`, but keeps its
 * own {@link ModerationError} so this module stands alone.
 *
 * Requirements traceability: 3.11, 3.12, 24.7, 25.4.
 * Design references: Frontend Design (Route map — `/admin/events/:id/moderation`);
 * Components (`ModerationQueue`); Architecture (privileged mutation Edge
 * Functions); RLS Design (`questions` authenticated SELECT).
 */

import { getSession } from './auth';
import { supabase } from './supabaseClient';

// ----------------------------------------------------------------------------
// Domain types.
// ----------------------------------------------------------------------------

/**
 * The full `question_status` enum (migration `20260101000009_questions.sql`).
 * The moderation queue shows ALL of these — including `pending` and `hidden` —
 * clearly labelled, so a moderator can act on the whole queue.
 */
export type ModerationQuestionStatus =
  'pending' | 'approved' | 'featured' | 'answered' | 'hidden';

/** All moderation statuses, in a natural queue ordering (for filter controls). */
export const MODERATION_QUESTION_STATUSES: readonly ModerationQuestionStatus[] =
  ['pending', 'approved', 'featured', 'answered', 'hidden'] as const;

/**
 * The moderation actions a moderator may apply. These are the moderator-facing
 * verbs accepted by the `moderate-question` Edge Function; each maps
 * server-side to exactly one target `question_status`
 * (approve→approved, feature→featured, answer→answered, hide→hidden).
 */
export type ModerationAction = 'approve' | 'feature' | 'answer' | 'hide';

/** All moderation actions, for rendering per-question action controls. */
export const MODERATION_ACTIONS: readonly ModerationAction[] = [
  'approve',
  'feature',
  'answer',
  'hide',
] as const;

/**
 * A moderation-queue question row. This is the admin projection: it includes
 * `pending`/`hidden` (unlike the audience projection) and the moderation-facing
 * `ai_category`, but DELIBERATELY excludes `participant_identifier` and every
 * other sensitive field (Req 8.6, 24.8).
 */
export interface ModerationQuestion {
  readonly id: string;
  readonly text: string;
  readonly status: ModerationQuestionStatus;
  /**
   * The AI-assigned category, or `null` when uncategorised. The column exists
   * on `questions` but is populated by a later AI task, so it is `null` for
   * most M2 rows.
   */
  readonly ai_category: string | null;
  readonly vote_count: number;
  readonly created_at: string;
  readonly event_id: string;
}

/** Stable, machine-readable classification of a moderation failure. */
export type ModerationErrorKind =
  /** No authenticated admin session / rejected token (401). */
  | 'unauthorized'
  /** The target question does not exist (404). */
  | 'not_found'
  /** Client- or server-side input validation failed (400). */
  | 'validation'
  /** A read/query failure loading the queue. */
  | 'load_failed'
  /** Any other/unexpected failure (network, 5xx, malformed response). */
  | 'unknown';

/**
 * Typed error thrown by {@link readModerationQuestions} and
 * {@link moderateQuestion}. Carries a `kind` for branching plus a sanitised,
 * user-safe `message` (never raw provider/internal detail).
 */
export class ModerationError extends Error {
  readonly kind: ModerationErrorKind;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: { kind: ModerationErrorKind; status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'ModerationError';
    this.kind = options.kind;
    this.status = options.status;
    this.cause = options.cause;
  }
}

/** Name of the authenticated moderation-mutation Edge Function (task 16.1). */
export const MODERATE_QUESTION_FUNCTION = 'moderate-question' as const;

/**
 * The non-sensitive columns the moderation queue reads. `participant_identifier`
 * is intentionally absent — it must NEVER be selected or surfaced (Req 8.6).
 */
const MODERATION_QUESTION_COLUMNS =
  'id, text, status, ai_category, vote_count, created_at, event_id' as const;

// ----------------------------------------------------------------------------
// Read path — authenticated full-queue read.
// ----------------------------------------------------------------------------

/**
 * Type guard narrowing an untyped Supabase row to {@link ModerationQuestion}.
 * `ai_category` may be `null`; every other field is required and typed.
 */
function isModerationQuestion(value: unknown): value is ModerationQuestion {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.text === 'string' &&
    typeof v.status === 'string' &&
    (MODERATION_QUESTION_STATUSES as readonly string[]).includes(
      v.status as string,
    ) &&
    (v.ai_category === null || typeof v.ai_category === 'string') &&
    typeof v.vote_count === 'number' &&
    typeof v.created_at === 'string' &&
    typeof v.event_id === 'string'
  );
}

/**
 * Reads ALL questions for an event through the AUTHENTICATED admin session
 * (Req 3.11). Because the authenticated SELECT policy on `questions` is
 * `USING (true)`, this returns every status — including `pending` and `hidden`
 * — which the moderation queue needs. Rows are ordered newest-first so the
 * freshest submissions surface at the top of the queue.
 *
 * This requires an active admin session; without one it throws a
 * {@link ModerationError} of kind `unauthorized` rather than performing an
 * anonymous read (which RLS would silently narrow to `approved`/`featured`).
 *
 * Returns `[]` when the event has no questions; never returns
 * `participant_identifier` (Req 8.6).
 *
 * @param eventId The event whose questions to moderate.
 * @throws {ModerationError} on a missing session (`unauthorized`) or a
 *   transport/query failure (`load_failed`).
 */
export async function readModerationQuestions(
  eventId: string,
): Promise<ModerationQuestion[]> {
  if (!eventId) return [];

  // Require an authenticated admin session. Reading anonymously would be
  // silently narrowed by RLS to approved/featured, hiding the pending/hidden
  // rows the queue exists to moderate — so fail fast with a clear signal.
  const session = await getSession();
  if (!session?.access_token) {
    throw new ModerationError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }

  const { data, error } = await supabase
    .from('questions')
    .select(MODERATION_QUESTION_COLUMNS)
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new ModerationError(
      'The moderation queue could not be loaded. Please check your connection and try again.',
      { kind: 'load_failed', cause: error },
    );
  }
  if (!Array.isArray(data)) return [];

  return data.filter(isModerationQuestion);
}

// ----------------------------------------------------------------------------
// Pure client-side filter helper.
// ----------------------------------------------------------------------------

/** Criteria for {@link filterModerationQuestions}; all supplied are combined (AND). */
export interface ModerationFilter {
  /** Keep only questions with this status. Omitted/undefined → no status filter. */
  readonly status?: ModerationQuestionStatus;
  /**
   * Keep only questions whose `ai_category` equals this value. Omitted →
   * no category filter. (Rows with a `null` category never match a non-empty
   * category filter.)
   */
  readonly category?: string;
  /**
   * Keep only questions whose `text` contains this substring,
   * case-insensitively. Omitted/blank → no text filter.
   */
  readonly searchText?: string;
}

/**
 * Filters a moderation-queue list by combining ALL supplied criteria with AND
 * (Req 3.11, 3.12). Search is a case-insensitive substring match on `text`.
 *
 * A criterion is only applied when it is meaningfully present:
 *  - `status`: applied when defined.
 *  - `category`: applied when a non-empty (trimmed) string; a row with a `null`
 *    `ai_category` never matches.
 *  - `searchText`: applied when a non-empty (trimmed) string; matched
 *    case-insensitively as a substring of `text`.
 *
 * This is a PURE function (no I/O, does not mutate its input) so it can be
 * unit-tested directly (task 16.3) and reused for live re-filtering in the UI.
 *
 * @returns a new array containing only the questions that match every applied
 *   criterion; the input order is preserved.
 */
export function filterModerationQuestions(
  questions: readonly ModerationQuestion[],
  filter: ModerationFilter = {},
): ModerationQuestion[] {
  const { status, category } = filter;

  const trimmedCategory = typeof category === 'string' ? category.trim() : '';
  const trimmedSearch =
    typeof filter.searchText === 'string' ? filter.searchText.trim() : '';
  const needle = trimmedSearch.toLowerCase();

  return questions.filter((q) => {
    // status (AND)
    if (status !== undefined && q.status !== status) {
      return false;
    }
    // ai-category (AND) — a null category can never match a non-empty filter.
    if (trimmedCategory !== '') {
      if (q.ai_category === null || q.ai_category !== trimmedCategory) {
        return false;
      }
    }
    // case-insensitive substring search on text (AND)
    if (needle !== '' && !q.text.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}

// ----------------------------------------------------------------------------
// Mutation path — authenticated moderation Edge Function.
// ----------------------------------------------------------------------------

/** The subset of the moderated question echoed back by the Edge Function (200). */
export interface ModeratedQuestion {
  readonly id: string;
  readonly status: ModerationQuestionStatus;
}

/** The success payload returned by the `moderate-question` Edge Function (200). */
export interface ModerateQuestionResult {
  readonly question: ModeratedQuestion;
  readonly status: ModerationQuestionStatus;
  readonly previousStatus: ModerationQuestionStatus;
  readonly auditWritten: boolean;
}

/** Input to {@link moderateQuestion}. */
export interface ModerateQuestionInput {
  /** The id of the question to moderate. */
  readonly questionId: string;
  /** The moderation action to apply. */
  readonly action: ModerationAction;
}

/**
 * Narrows an unknown value to the Edge Function's structured error body:
 * `{ error: { code, message } }`.
 */
interface EdgeErrorBody {
  error: {
    code?: string;
    message?: string;
  };
}

function isEdgeErrorBody(value: unknown): value is EdgeErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null;
}

/** Narrows an unknown value to the moderation success payload. */
function isModerateSuccess(value: unknown): value is {
  question: { id: string; status: string };
  status: string;
  previous_status: string;
  audit_written?: boolean;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const question = v.question as Record<string, unknown> | undefined;
  return (
    typeof v.status === 'string' &&
    typeof v.previous_status === 'string' &&
    typeof question === 'object' &&
    question !== null &&
    typeof question.id === 'string' &&
    typeof question.status === 'string'
  );
}

/**
 * Maps a `moderate-question` Edge Function error body + HTTP status to a typed
 * {@link ModerationError}. Messages are always sanitised, user-safe strings
 * (the Edge Function never leaks internals — Design → Error Handling).
 */
function toModerationError(
  status: number,
  body: EdgeErrorBody,
): ModerationError {
  const code = body.error.code;
  const message = body.error.message;

  if (status === 401 || code === 'unauthorized') {
    return new ModerationError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized', status },
    );
  }
  if (status === 404 || code === 'question_not_found') {
    return new ModerationError(
      message ?? 'That question could not be found. It may have been removed.',
      { kind: 'not_found', status },
    );
  }
  if (
    status === 400 ||
    code === 'validation_failed' ||
    code === 'invalid_json'
  ) {
    return new ModerationError(message ?? 'The request was invalid.', {
      kind: 'validation',
      status,
    });
  }
  return new ModerationError(
    message ?? 'The question could not be moderated. Please try again.',
    { kind: 'unknown', status },
  );
}

/**
 * Applies a moderation action to a question via the authenticated
 * `moderate-question` Edge Function (task 16.1).
 *
 * Flow (mirrors {@link import('./events').transitionEventStatus}):
 *  1. Require an authenticated admin session (access token). If absent, throw a
 *     {@link ModerationError} of kind `unauthorized` — no network call is made.
 *  2. Invoke the Edge Function with `supabase.functions.invoke`, which attaches
 *     the caller's `Authorization: Bearer <access_token>` automatically.
 *  3. On success return the updated question + previous status; on a structured
 *     error map it to a typed {@link ModerationError}.
 *
 * @throws {ModerationError} on a missing session or any error returned by (or
 *   transport failure invoking) the Edge Function.
 */
export async function moderateQuestion(
  input: ModerateQuestionInput,
): Promise<ModerateQuestionResult> {
  // 1) Require an authenticated admin session; fail fast with a clear message
  //    and avoid an unauthenticated round-trip (Design → Authorization errors).
  const session = await getSession();
  if (!session?.access_token) {
    throw new ModerationError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }

  // 2) Invoke the Edge Function. `functions.invoke` attaches the current
  //    session's `Authorization: Bearer <access_token>` header automatically.
  const { data, error } = await supabase.functions.invoke(
    MODERATE_QUESTION_FUNCTION,
    { body: { question_id: input.questionId, action: input.action } },
  );

  // 3a) Transport/non-2xx error surfaced by supabase-js. The structured JSON
  //     error body (with status + `error.code`) is available on
  //     `FunctionsHttpError.context` (a `Response`); read it when present.
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      let parsedBody: unknown = null;
      try {
        parsedBody = await context.clone().json();
      } catch {
        parsedBody = null;
      }
      if (isEdgeErrorBody(parsedBody)) {
        throw toModerationError(context.status, parsedBody);
      }
      if (context.status === 401) {
        throw new ModerationError(
          'Your session has expired. Please sign in again.',
          { kind: 'unauthorized', status: context.status, cause: error },
        );
      }
      throw new ModerationError(
        'The question could not be moderated. Please try again.',
        { kind: 'unknown', status: context.status, cause: error },
      );
    }
    // No response context (e.g. network failure) — generic unknown error.
    throw new ModerationError(
      'The question could not be moderated. Please check your connection and try again.',
      { kind: 'unknown', cause: error },
    );
  }

  // 3b) supabase-js sometimes returns a non-2xx body without throwing; guard by
  //     detecting a structured error body in the success channel too.
  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status =
      code === 'unauthorized'
        ? 401
        : code === 'question_not_found'
          ? 404
          : code === 'validation_failed' || code === 'invalid_json'
            ? 400
            : 500;
    throw toModerationError(status, data);
  }

  if (!isModerateSuccess(data)) {
    throw new ModerationError(
      'The question may have been moderated but the server response was malformed.',
      { kind: 'unknown', cause: data },
    );
  }

  return {
    question: {
      id: data.question.id,
      status: data.question.status as ModerationQuestionStatus,
    },
    status: data.status as ModerationQuestionStatus,
    previousStatus: data.previous_status as ModerationQuestionStatus,
    auditWritten: data.audit_written ?? true,
  };
}
