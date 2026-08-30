/**
 * Question-submit client helper (Task 15.1).
 *
 * This module is the client-side gateway the audience Q&A UI
 * ({@link QuestionSubmissionForm}, task 15.1) uses to submit a question. The SPA
 * never inserts into `questions` directly — there is no anonymous `INSERT`
 * policy on the table (task 12.1); every submission is routed through the
 * rate-limited, `SECURITY DEFINER` `submit_question` RPC (task 13.2), which is
 * the authoritative enforcement point (rate limiting, length/sanitisation,
 * event-status gating, moderation-mode status defaulting, and idempotency).
 *
 * The RPC signature (task 13.2):
 *   submit_question(
 *     p_event_id uuid,
 *     p_participant_identifier text,
 *     p_text text,
 *     p_submission_key text DEFAULT NULL
 *   ) RETURNS questions
 *
 * On rejection it RAISEs a PostgreSQL exception (SQLSTATE `P0001`) whose message
 * is a stable signal string — one of `rate_limited`, `event_not_live`, or
 * `invalid_length`. supabase-js surfaces that message on `error.message`, so we
 * map the signal to a typed {@link QuestionError} with a friendly, user-safe
 * message here.
 *
 * Client-side length validation (1–300 Unicode code points) is performed FIRST
 * for fast feedback (Req 22.1, 3.2), avoiding an obviously-doomed round-trip;
 * the RPC re-validates authoritatively so this is defence-in-depth only.
 *
 * A per-attempt `submission_key` (crypto-random) is generated and passed for
 * write idempotency (Req 23.8): a retried submit that reuses the same key is
 * de-duplicated server-side rather than creating a duplicate question.
 *
 * Requirements traceability: 3.1, 3.2, 3.3, 3.13, 22.1, 23.8.
 * Design references: Request/data flows (Question submit + moderation);
 * Components (`QuestionSubmissionForm`); RLS Design (server-side submit RPC /
 * rate limiting).
 *
 * IMPORTANT — the participant identifier is opaque and MUST NEVER be rendered
 * in the UI (Req 8.6, 24.8). This module only hands it to the RPC as a
 * parameter; it never returns it to callers.
 */

import { supabase } from './supabaseClient';
import { getParticipantIdentifier } from './participant';

/** Minimum question length in Unicode code points (Req 22.1, 3.1). */
export const QUESTION_TEXT_MIN = 1;
/** Maximum question length in Unicode code points (Req 22.1, 3.1). */
export const QUESTION_TEXT_MAX = 300;

/** Name of the server-side submit RPC (task 13.2). */
export const SUBMIT_QUESTION_RPC = 'submit_question' as const;

/**
 * The user-facing message identifying the 1–300 character length constraint
 * (Req 3.2, 22.1). Exported so the form and its tests can assert the exact
 * copy without duplicating the wording.
 */
export const QUESTION_LENGTH_MESSAGE = `Your question must be between ${QUESTION_TEXT_MIN} and ${QUESTION_TEXT_MAX} characters.`;

/**
 * Counts the number of Unicode code points in a string (Req 22.1 — each code
 * point counts as one character). `String.prototype.length` counts UTF-16 code
 * units, so characters outside the Basic Multilingual Plane (e.g. many emoji)
 * would over-count; spreading iterates by code point.
 */
export function countQuestionCodePoints(value: string): number {
  return [...value].length;
}

/**
 * Returns `true` when `text` is a valid question length (1–300 Unicode code
 * points) after trimming. Trimming means a whitespace-only submission is
 * rejected as empty, matching the DB `char_length` 1–300 CHECK and the
 * "empty / whitespace-only / >300" rejection in Req 3.2.
 */
export function isValidQuestionLength(text: string): boolean {
  const count = countQuestionCodePoints(text.trim());
  return count >= QUESTION_TEXT_MIN && count <= QUESTION_TEXT_MAX;
}

/** Stable, machine-readable classification of a question-submit failure. */
export type QuestionErrorKind =
  /** Length outside 1–300 code points (client-side or the RPC `invalid_length`). */
  | 'invalid_length'
  /** The submission rate limit was exceeded (RPC `rate_limited`). */
  | 'rate_limited'
  /** The event is not live, so submissions are closed (RPC `event_not_live`). */
  | 'event_not_live'
  /** Any other/unexpected failure (network, malformed response, unknown signal). */
  | 'unknown';

/**
 * Typed error thrown by {@link submitQuestion}.
 *
 * Carries a `kind` for branching plus a sanitised, user-safe `message` (never
 * raw provider/internal detail). The form branches on `kind` to decide whether
 * to retain the entered text (for `invalid_length`) and which inline message to
 * show.
 */
export class QuestionError extends Error {
  readonly kind: QuestionErrorKind;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: { kind: QuestionErrorKind; cause?: unknown },
  ) {
    super(message);
    this.name = 'QuestionError';
    this.kind = options.kind;
    this.cause = options.cause;
  }
}

/**
 * The subset of the created question returned to the UI on a successful submit.
 *
 * Only non-sensitive fields are surfaced. In particular the
 * `participant_identifier`/`submission_key` are NEVER returned (Req 8.6, 24.8).
 * `status` is `pending` (pre-moderation) or `approved` (post-moderation) per the
 * event's `moderation_mode`, decided authoritatively by the RPC (Req 3.6, 3.7).
 */
export interface SubmittedQuestion {
  readonly id: string;
  readonly status: string;
}

/** Input to {@link submitQuestion}. */
export interface SubmitQuestionInput {
  /** The id of the (live) event the question is submitted to. */
  readonly eventId: string;
  /** The plain-text question (validated to 1–300 code points). */
  readonly text: string;
  /**
   * Optional idempotency key (Req 23.8). When omitted a fresh crypto-random key
   * is generated per attempt. Callers that retry the SAME logical submission
   * (e.g. after a reconnect) should pass the SAME key so the retry is
   * de-duplicated server-side rather than creating a duplicate question.
   */
  readonly submissionKey?: string;
}

/**
 * Generates a crypto-random idempotency key for a submission attempt (Req 23.8).
 * Prefers `crypto.randomUUID()`; falls back to a hex token from
 * `crypto.getRandomValues`. This carries no personal data.
 */
export function generateSubmissionKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    let hex = '';
    for (const b of bytes) {
      hex += b.toString(16).padStart(2, '0');
    }
    return hex;
  }
  // No secure random source — surface loudly rather than emit a weak key.
  throw new QuestionError(
    'Your question could not be submitted. Please try again.',
    { kind: 'unknown' },
  );
}

/**
 * Maps a supabase-js RPC error to a typed {@link QuestionError}.
 *
 * The submit RPC RAISEs with a stable signal as the exception message
 * (`rate_limited` / `event_not_live` / `invalid_length`). supabase-js exposes
 * that on `error.message`; we match on a substring (the message may be wrapped
 * with context) and translate to a friendly, user-safe message.
 */
function toQuestionError(error: { message?: string } | null): QuestionError {
  const raw = (error?.message ?? '').toLowerCase();

  if (raw.includes('rate_limited')) {
    return new QuestionError(
      "You're doing that too fast. Please wait a moment and try again.",
      { kind: 'rate_limited', cause: error },
    );
  }
  if (raw.includes('event_not_live')) {
    return new QuestionError(
      'Submissions are closed. This event is not currently live.',
      { kind: 'event_not_live', cause: error },
    );
  }
  if (raw.includes('invalid_length')) {
    return new QuestionError(QUESTION_LENGTH_MESSAGE, {
      kind: 'invalid_length',
      cause: error,
    });
  }
  return new QuestionError(
    'Your question could not be submitted. Please check your connection and try again.',
    { kind: 'unknown', cause: error },
  );
}

/**
 * Narrows an unknown RPC payload to the created question row we care about.
 * The RPC `RETURNS questions`, so supabase-js returns the full row; we only
 * read `id` and `status`.
 */
function isQuestionRow(value: unknown): value is { id: string; status: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.status === 'string';
}

/**
 * Submits a question via the rate-limited `submit_question` RPC (task 13.2).
 *
 * Flow:
 *  1. Validate length 1–300 Unicode code points client-side for fast feedback
 *     (Req 22.1, 3.2). On failure, throw a {@link QuestionError} of kind
 *     `invalid_length` — no RPC call is made.
 *  2. Resolve (or reuse) an idempotency `submission_key` (Req 23.8) and the
 *     opaque participant identifier via {@link getParticipantIdentifier}.
 *  3. Call `supabase.rpc('submit_question', …)`.
 *  4. On success return the created question `{ id, status }`; on the RPC's
 *     signalled rejection map it to a typed {@link QuestionError}.
 *
 * @throws {QuestionError} on client-side length failure, an RPC rejection
 *   signal (`rate_limited` / `event_not_live` / `invalid_length`), a malformed
 *   response, or any transport failure.
 */
export async function submitQuestion(
  input: SubmitQuestionInput,
): Promise<SubmittedQuestion> {
  const { eventId, text } = input;

  // 1) Client-side length validation (fast feedback; the RPC re-validates).
  if (!isValidQuestionLength(text)) {
    throw new QuestionError(QUESTION_LENGTH_MESSAGE, { kind: 'invalid_length' });
  }

  // 2) Idempotency key (reuse the caller's key on a retry) + opaque identifier.
  const submissionKey = input.submissionKey ?? generateSubmissionKey();
  const participantIdentifier = getParticipantIdentifier();

  // Send the trimmed text so leading/trailing whitespace does not count toward
  // the stored length (consistent with the length check above).
  const trimmed = text.trim();

  // 3) Invoke the RPC.
  const { data, error } = await supabase.rpc(SUBMIT_QUESTION_RPC, {
    p_event_id: eventId,
    p_participant_identifier: participantIdentifier,
    p_text: trimmed,
    p_submission_key: submissionKey,
  });

  // 4a) Map a signalled rejection to a typed error.
  if (error) {
    throw toQuestionError(error);
  }

  // 4b) `RETURNS questions` yields the row (or an array containing it in some
  //     supabase-js paths); accept either shape defensively.
  const row = Array.isArray(data) ? data[0] : data;
  if (!isQuestionRow(row)) {
    throw new QuestionError(
      'Your question was submitted but the server response was malformed.',
      { kind: 'unknown', cause: data },
    );
  }

  return { id: row.id, status: row.status };
}
