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
  /** No question exists with the given id (vote RPC `question_not_found`). */
  | 'question_not_found'
  /** The question is not approved/featured or its event is not live (vote RPC `not_eligible`). */
  | 'not_eligible'
  /** A duplicate cast — the participant already has an active vote (vote RPC `already_voted`). */
  | 'already_voted'
  /** A remove requested with no active vote to remove (vote RPC `no_vote_to_remove`). */
  | 'no_vote_to_remove'
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
function isQuestionRow(
  value: unknown,
): value is { id: string; status: string } {
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
    throw new QuestionError(QUESTION_LENGTH_MESSAGE, {
      kind: 'invalid_length',
    });
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

// ============================================================================
// Question voting + audience list read helpers (Task 15.2).
//
// This section adds the client-side gateway the audience voting UI
// (`QuestionListAndVoting`, task 15.2) uses to (a) read the questions it may
// display and (b) cast/remove an upvote. It is ADDITIVE — it reuses the
// QuestionError / QuestionErrorKind pattern above and does not alter the
// existing submit helper or its exports.
//
// As with submission, the SPA never mutates `question_votes` /
// `questions.vote_count` directly — there is no client write policy that trusts
// the client (task 12.2). Every cast/remove is routed through the
// `SECURITY DEFINER` vote RPCs (task 13.3), which are the authoritative
// enforcement point (eligibility by status + live event, rate limiting, the
// one-active-vote-per-participant-per-question unique constraint, and the
// atomic vote_count maintenance).
//
// The RPC signatures (supabase/migrations/20260101000015_vote_rpc.sql):
//   cast_question_vote(p_question_id uuid, p_participant_identifier text)
//     RETURNS integer  -- the new vote_count
//   remove_question_vote(p_question_id uuid, p_participant_identifier text)
//     RETURNS integer  -- the new vote_count
//
// On rejection each RPC RAISEs a PostgreSQL exception whose message is a stable
// signal string — one of `question_not_found`, `not_eligible`, `rate_limited`,
// `already_voted`, or `no_vote_to_remove`. supabase-js surfaces that message on
// `error.message`, so we map the signal to a typed {@link QuestionError} with a
// friendly, user-safe message here.
//
// The audience read helper ({@link readAudienceQuestions}) fetches only the
// non-sensitive columns (`id`, `text`, `status`, `vote_count`, `created_at`)
// for `approved`/`featured` questions on the event via the anon client — it
// NEVER selects `participant_identifier` (Req 8.6). This mirrors
// `readPresenterQuestions` in `../lib/presenter` but is kept here so the
// audience surface owns its own read (and so `../lib/presenter` is untouched).
//
// IMPORTANT — the participant identifier is opaque and MUST NEVER be rendered
// (Req 8.6, 24.8). It is derived here via {@link getParticipantIdentifier};
// callers never supply it and it is never returned.
//
// Requirements traceability: 3.9, 3.11, 4.1, 4.5, 8.6.
// Design references: Components (`QuestionListAndVoting`); Request/data flows
// (Voting with realtime propagation); RLS Design (`questions`,
// `question_votes`).
// ============================================================================

/** Name of the server-side cast-vote RPC (task 13.3). */
export const CAST_QUESTION_VOTE_RPC = 'cast_question_vote' as const;
/** Name of the server-side remove-vote RPC (task 13.3). */
export const REMOVE_QUESTION_VOTE_RPC = 'remove_question_vote' as const;

/**
 * The question statuses the audience may ever see and vote on (Req 3.9, 4.1).
 * `pending`/`hidden`/`answered` are DELIBERATELY excluded from the audience
 * voting list — voting is only permitted on `approved`/`featured` questions on
 * a live event, and RLS already restricts anon reads to these two statuses.
 */
export const VOTABLE_QUESTION_STATUSES = ['approved', 'featured'] as const;

/** A single audience-votable question status. */
export type VotableQuestionStatus = (typeof VOTABLE_QUESTION_STATUSES)[number];

/**
 * The minimal, non-sensitive projection of a question the audience voting list
 * renders. Deliberately excludes `participant_identifier` and any
 * moderation-internal fields (Req 8.6).
 */
export interface AudienceQuestion {
  readonly id: string;
  readonly text: string;
  readonly status: VotableQuestionStatus;
  readonly vote_count: number;
  readonly created_at: string;
}

/** The columns the anon client requests for the audience list — minimal. */
const AUDIENCE_QUESTION_COLUMNS =
  'id, text, status, vote_count, created_at' as const;

/**
 * Type guard narrowing an untyped Supabase row to {@link AudienceQuestion},
 * ALSO enforcing the votable-status allow-list. A row whose status is not in
 * {@link VOTABLE_QUESTION_STATUSES} (which RLS should already exclude) is
 * rejected here too — belt-and-braces for Req 3.9/8.6.
 */
function isAudienceQuestion(value: unknown): value is AudienceQuestion {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.text === 'string' &&
    typeof v.status === 'string' &&
    (VOTABLE_QUESTION_STATUSES as readonly string[]).includes(v.status) &&
    typeof v.vote_count === 'number' &&
    typeof v.created_at === 'string'
  );
}

/** How the audience list is ordered (task 15.2 sort control). */
export type QuestionSort = 'most_votes' | 'most_recent';

/** The default sort — most votes descending (task 15.2). */
export const DEFAULT_QUESTION_SORT: QuestionSort = 'most_votes';

/**
 * Reads the `approved`/`featured` questions for an event through the anonymous
 * browser client, ordered per {@link QuestionSort}.
 *
 * Visibility (Req 3.9, 8.6): the query is filtered to
 * {@link VOTABLE_QUESTION_STATUSES}; combined with RLS (anon reads are limited
 * to `approved`/`featured` on a live event) `pending`/`hidden` are NEVER
 * returned, and `participant_identifier` is never selected. Every row is passed
 * through {@link isAudienceQuestion}, dropping anything not well-formed and
 * votable.
 *
 *  - `most_votes` (default): `vote_count` desc, then most-recent as a stable
 *    tie-break.
 *  - `most_recent`: `created_at` desc.
 *
 * This never throws for "no data"; it returns `[]`. A transport/query error is
 * likewise surfaced as a thrown {@link QuestionError} so the list can render
 * its error state.
 *
 * @param eventId The event whose questions to read.
 * @param sort    The ordering (defaults to {@link DEFAULT_QUESTION_SORT}).
 * @returns The votable questions (possibly empty), in the requested order.
 * @throws {QuestionError} on a transport/query failure.
 */
export async function readAudienceQuestions(
  eventId: string,
  sort: QuestionSort = DEFAULT_QUESTION_SORT,
): Promise<AudienceQuestion[]> {
  if (!eventId) return [];

  let query = supabase
    .from('questions')
    .select(AUDIENCE_QUESTION_COLUMNS)
    .eq('event_id', eventId)
    // Defence-in-depth alongside RLS: never even ask for pending/hidden.
    .in('status', VOTABLE_QUESTION_STATUSES as unknown as string[]);

  query =
    sort === 'most_recent'
      ? query.order('created_at', { ascending: false })
      : query
          .order('vote_count', { ascending: false })
          .order('created_at', { ascending: false });

  const { data, error } = await query;

  if (error) {
    throw new QuestionError(
      'The questions could not be loaded. Please check your connection and try again.',
      { kind: 'unknown', cause: error },
    );
  }
  if (!Array.isArray(data)) return [];

  return data.filter(isAudienceQuestion);
}

/**
 * Maps a supabase-js vote-RPC error to a typed {@link QuestionError}.
 *
 * The vote RPCs RAISE with a stable signal as the exception message
 * (`question_not_found` / `not_eligible` / `rate_limited` / `already_voted` /
 * `no_vote_to_remove`). supabase-js exposes that on `error.message`; we match
 * on a substring (the message may be wrapped with context) and translate to a
 * friendly, user-safe message.
 */
function toVoteError(error: { message?: string } | null): QuestionError {
  const raw = (error?.message ?? '').toLowerCase();

  if (raw.includes('rate_limited')) {
    return new QuestionError(
      "You're voting too fast. Please wait a moment and try again.",
      { kind: 'rate_limited', cause: error },
    );
  }
  if (raw.includes('not_eligible')) {
    return new QuestionError('This question is no longer open for voting.', {
      kind: 'not_eligible',
      cause: error,
    });
  }
  if (raw.includes('question_not_found')) {
    return new QuestionError('That question could not be found.', {
      kind: 'question_not_found',
      cause: error,
    });
  }
  if (raw.includes('already_voted')) {
    return new QuestionError('You have already voted on this question.', {
      kind: 'already_voted',
      cause: error,
    });
  }
  if (raw.includes('no_vote_to_remove')) {
    return new QuestionError('You have no vote to remove on this question.', {
      kind: 'no_vote_to_remove',
      cause: error,
    });
  }
  return new QuestionError(
    'Your vote could not be recorded. Please check your connection and try again.',
    { kind: 'unknown', cause: error },
  );
}

/**
 * Narrows an unknown RPC payload to the returned integer `vote_count`. The vote
 * RPCs `RETURN integer`; supabase-js may surface it as a bare number or wrapped
 * in a single-element array, so accept either defensively.
 */
function toVoteCount(data: unknown): number {
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new QuestionError(
    'Your vote was recorded but the server response was malformed.',
    { kind: 'unknown', cause: data },
  );
}

/**
 * Casts an upvote on a question via the atomic `cast_question_vote` RPC
 * (task 13.3).
 *
 * The opaque participant identifier is derived via
 * {@link getParticipantIdentifier} — it is NEVER accepted from the caller and
 * NEVER returned (Req 8.6). The server enforces eligibility (approved/featured
 * on a live event), the vote rate limit, and the one-active-vote-per-
 * participant-per-question unique constraint; a duplicate cast RAISEs
 * `already_voted` leaving the count unchanged (Req 4.4).
 *
 * @param questionId The id of the question to upvote.
 * @returns The new `vote_count` after the cast (Req 4.1).
 * @throws {QuestionError} on an RPC rejection signal or a transport failure.
 */
export async function castQuestionVote(questionId: string): Promise<number> {
  const participantIdentifier = getParticipantIdentifier();

  const { data, error } = await supabase.rpc(CAST_QUESTION_VOTE_RPC, {
    p_question_id: questionId,
    p_participant_identifier: participantIdentifier,
  });

  if (error) {
    throw toVoteError(error);
  }
  return toVoteCount(data);
}

/**
 * Removes the participant's upvote on a question via the atomic
 * `remove_question_vote` RPC (task 13.3).
 *
 * The opaque participant identifier is derived via
 * {@link getParticipantIdentifier} — it is NEVER accepted from the caller and
 * NEVER returned (Req 8.6). Removing when no active vote exists RAISEs
 * `no_vote_to_remove` and leaves the count unchanged (Req 4.6); a successful
 * removal decrements the count (Req 4.5).
 *
 * @param questionId The id of the question to remove the vote from.
 * @returns The new `vote_count` after the removal (Req 4.5).
 * @throws {QuestionError} on an RPC rejection signal or a transport failure.
 */
export async function removeQuestionVote(questionId: string): Promise<number> {
  const participantIdentifier = getParticipantIdentifier();

  const { data, error } = await supabase.rpc(REMOVE_QUESTION_VOTE_RPC, {
    p_question_id: questionId,
    p_participant_identifier: participantIdentifier,
  });

  if (error) {
    throw toVoteError(error);
  }
  return toVoteCount(data);
}

// ============================================================================
// Event-scoped realtime subscription for the audience Q&A surface (Task 15.3).
//
// The audience event view needs to reflect new/approved questions and updated
// vote counts within the 2-second delivery target (Req 23.1) WITHOUT a manual
// refresh, while keeping the subscription scope NARROW — a single event, never
// the full dataset (Req 23.2). This helper opens ONE Supabase Realtime channel
// scoped to a single `event_id` that combines the two propagation paths the
// design specifies:
//
//   1. Postgres Changes (CDC) on the `questions` table, FILTERED to
//      `event_id=eq.${eventId}` — surfaces new/approved/updated questions
//      (Req 23.1, 23.2). This mirrors the `questions` subscription in
//      `subscribeToPresenter` (../lib/presenter) but is owned here so the
//      audience surface has its own read/subscribe path.
//   2. The vote-count Broadcast fan-out (Decision D9) on the per-event topic
//      `event:{event_id}:votes`, event `vote_count`, produced by the vote RPCs
//      (migration 20260101000016_vote_broadcast.sql). Under peak voting the
//      Broadcast path keeps the displayed count within the 2-second target
//      even when per-row CDC lags (Req 4.7, 23.1). The payload is the
//      privacy-safe aggregate `{ event_id, question_id, vote_count }` — it
//      carries NO `participant_identifier` (Req 8.6, 20).
//
// Connection-state transitions drive `onConnectionChange` so the consuming hook
// ({@link useRealtimeChannel}, task 15.3) can surface a reconnecting indicator
// and drive its exponential-backoff resubscribe (Req 23.5, 23.6, 23.7). This
// keeps the hook/view free of any direct Supabase import, so they remain
// unit-testable by mocking `../lib/questions` alone (as the screen tests do).
//
// SCOPE INVARIANT: the channel NEVER subscribes to the full dataset. Both the
// Postgres-changes filter and the Broadcast topic are pinned to this single
// `eventId`. Callers must pass a concrete event id.
//
// Requirements traceability: 23.1, 23.2, 4.7, 8.6.
// Design references: Frontend Design (Realtime subscription strategy & reconnect
// UX); Decision D9 (Realtime strategy for high-frequency votes); Request/data
// flows (Voting with realtime propagation).
// ============================================================================

/**
 * The privacy-safe vote-count Broadcast payload emitted by the vote RPCs on the
 * per-event topic `event:{event_id}:votes` (event `vote_count`), as documented
 * in migration `20260101000016_vote_broadcast.sql`. It carries ONLY the
 * aggregate count and the ids needed to route it — never a
 * `participant_identifier` or any personal data (Req 8.6, 20).
 */
export interface VoteCountBroadcast {
  readonly event_id: string;
  readonly question_id: string;
  readonly vote_count: number;
}

/**
 * Callbacks the audience Q&A surface (via {@link useRealtimeChannel}) supplies
 * to {@link subscribeToEventQuestions}.
 */
export interface EventQuestionsSubscriptionHandlers {
  /**
   * Called (debounced by Realtime delivery) whenever a `questions` row for THIS
   * event is inserted/updated/deleted, so the view can re-read the current list
   * (Req 23.1).
   */
  readonly onQuestionsChange?: () => void;
  /**
   * Called with the aggregate {@link VoteCountBroadcast} on each `vote_count`
   * Broadcast message for THIS event (Decision D9; Req 4.7). The payload is
   * privacy-safe (no `participant_identifier`).
   */
  readonly onVoteCount?: (payload: VoteCountBroadcast) => void;
  /**
   * Called with `true` when the live connection is interrupted (channel error /
   * timeout / close) and `false` when it (re)subscribes, so the consumer can
   * show/clear the reconnecting indicator and drive its backoff (Req 23.5–23.7).
   */
  readonly onConnectionChange?: (interrupted: boolean) => void;
}

/** Handle returned by {@link subscribeToEventQuestions}; call it to unsubscribe. */
export type EventQuestionsUnsubscribe = () => void;

/**
 * Narrows an untyped Broadcast payload to a {@link VoteCountBroadcast}. Anything
 * malformed (missing ids, non-numeric count) is rejected so a bad message can
 * never crash the consuming hook.
 */
function isVoteCountBroadcast(value: unknown): value is VoteCountBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.event_id === 'string' &&
    typeof v.question_id === 'string' &&
    typeof v.vote_count === 'number' &&
    Number.isFinite(v.vote_count)
  );
}

/**
 * Opens a Supabase Realtime channel scoped to a SINGLE event and wires it to the
 * audience Q&A handlers (Req 23.1, 23.2, 4.7). It subscribes to:
 *  - `questions` Postgres changes filtered to this `event_id` — new/approved/
 *    updated questions (Req 23.1);
 *  - the per-event vote-count Broadcast topic `event:{event_id}:votes`
 *    (event `vote_count`) — the D9 high-frequency count fan-out (Req 4.7).
 *
 * Connection-state transitions drive `onConnectionChange` so the consumer can
 * surface a reconnecting indicator and drive an exponential-backoff resubscribe
 * (Req 23.5–23.7). This keeps the consuming hook/view free of any direct
 * Supabase import.
 *
 * SCOPE INVARIANT (Req 23.2): the channel NEVER subscribes to the full dataset —
 * both the Postgres-changes filter and the Broadcast topic are pinned to
 * `eventId`. A falsy `eventId` yields a no-op unsubscribe (nothing is opened).
 *
 * @returns an unsubscribe function that removes the channel.
 */
export function subscribeToEventQuestions(
  eventId: string,
  handlers: EventQuestionsSubscriptionHandlers,
): EventQuestionsUnsubscribe {
  // Never open a full-dataset / unscoped channel: an absent event id is a no-op.
  if (!eventId) {
    return () => {};
  }

  const channel = supabase
    .channel(`event:${eventId}:questions`)
    // 1) Per-row CDC on questions, FILTERED to this event only (Req 23.2).
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'questions',
        filter: `event_id=eq.${eventId}`,
      },
      () => {
        handlers.onQuestionsChange?.();
      },
    )
    // 2) The D9 vote-count Broadcast on the per-event topic (Req 4.7). The topic
    //    is `event:{event_id}:votes`; here we subscribe with the channel's own
    //    `broadcast` binding for the `vote_count` event and re-scope the payload
    //    to this event id defensively.
    .on(
      'broadcast',
      { event: 'vote_count' },
      (message: { payload?: unknown }) => {
        const payload = (message as { payload?: unknown })?.payload;
        if (isVoteCountBroadcast(payload) && payload.event_id === eventId) {
          handlers.onVoteCount?.(payload);
        }
      },
    )
    .subscribe((state: string) => {
      // Drive the reconnect UX (Req 23.5–23.7): flag an interruption on any
      // non-subscribed transport state; clear it once (re)subscribed.
      if (state === 'SUBSCRIBED') {
        handlers.onConnectionChange?.(false);
      } else if (
        state === 'CHANNEL_ERROR' ||
        state === 'TIMED_OUT' ||
        state === 'CLOSED'
      ) {
        handlers.onConnectionChange?.(true);
      }
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}
