/**
 * Authenticated analytics read path (Task 38.2).
 *
 * This thin, admin-only module is responsible for loading the raw query inputs
 * from the Supabase database via the authenticated admin session, then delegating
 * all computation to {@link computeEventAnalytics} in `./analytics` (task 38.1).
 *
 * ── Architectural role ───────────────────────────────────────────────────────
 * This module is the I/O layer; `./analytics.ts` is the pure computation layer.
 * The separation keeps the computation deterministic and testable without any
 * database dependency.
 *
 * ── Privacy (Req 8.6) ────────────────────────────────────────────────────────
 * `participant_identifier` values are opaque, high-entropy anonymous tokens.
 * This module loads them from the `questions` table SOLELY to pass the list to
 * {@link computeEventAnalytics}, which counts distinct values via `new Set().size`
 * and immediately discards the list — the identifiers NEVER appear in the
 * returned {@link EventAnalytics} result, are never logged, and never leave the
 * local computation (Req 8.6). The identifiers are loaded because the
 * `questions` table is the only client-accessible table with a `participant_identifier`
 * column AND an authenticated SELECT policy; `question_votes` and
 * `poll_responses` carry NO client SELECT policy (default-deny RLS).
 *
 * ── RLS access summary ───────────────────────────────────────────────────────
 * | Table                  | Authenticated role access           |
 * |------------------------|-------------------------------------|
 * | events                 | SELECT all rows                     |
 * | questions              | SELECT all rows (incl. pending/hidden, participant_identifier) |
 * | question_votes         | NO client SELECT (default deny)     |
 * | polls                  | SELECT all rows                     |
 * | poll_options           | SELECT all rows (with response_count cache) |
 * | poll_responses         | NO client SELECT (default deny)     |
 * | word_cloud_responses   | SELECT all rows (incl. hidden)      |
 *
 * Because `question_votes` and `poll_responses` deny client reads:
 *   - `totalVotes` is derived from `SUM(questions.vote_count)` (the DB-maintained
 *     cached aggregate, Req 4.1, 23.4).
 *   - `pollResponses` is derived from `SUM(poll_options.response_count)` across
 *     all options of all polls for the event (the DB-maintained cached aggregate,
 *     Req 5.8, 23.4).
 *   - The engagement time series (Req 8.4) includes interaction timestamps from
 *     `questions.created_at` and `word_cloud_responses.created_at` only (the two
 *     tables with an authenticated SELECT policy). Vote and poll-response
 *     timestamps are not accessible to the browser client.
 *
 * ── Error handling (Req 8.7) ────────────────────────────────────────────────
 * ANY failure — missing/expired session, or a DB read error from any of the
 * above sources — throws an {@link AnalyticsClientError}. Partial results are
 * NEVER returned: a thrown error is the ONLY failure signal (Req 8.7). The
 * caller (task 38.3 dashboard) should show the unavailable-analytics error state
 * without displaying stale or partial metrics.
 *
 * Requirements traceability: 8.1, 8.6, 8.7.
 * Design references: Components and Interfaces (Analytics_Service);
 * RLS Design (authenticated admin read).
 */

import { getSession } from './auth';
import { supabase } from './supabaseClient';
import {
  computeEventAnalytics,
  type EventAnalytics,
  type InteractionEvent,
  type QuestionStatus,
} from './analytics';

// ----------------------------------------------------------------------------
// Typed error.
// ----------------------------------------------------------------------------

/**
 * Stable, machine-readable classification of an analytics-client failure
 * (mirrors the {@link AiClientError} pattern from `./aiClient`).
 */
export type AnalyticsClientErrorKind =
  /** No authenticated admin session, or the session token was rejected. */
  | 'unauthorized'
  /** A DB read failed for one or more of the required tables/queries. */
  | 'load_failed'
  /** Any other/unexpected failure (network, malformed response, etc.). */
  | 'unknown';

/**
 * Typed error thrown by {@link readEventAnalytics} on any retrieval failure.
 *
 * Callers should branch on `kind` and surface the appropriate UI state.
 * Per Req 8.7, partial/stale metrics are NEVER returned: this error is the
 * ONLY failure signal.
 */
export class AnalyticsClientError extends Error {
  readonly kind: AnalyticsClientErrorKind;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      kind: AnalyticsClientErrorKind;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'AnalyticsClientError';
    this.kind = options.kind;
    this.cause = options.cause;
  }
}

// ----------------------------------------------------------------------------
// Read path.
// ----------------------------------------------------------------------------

/**
 * Reads all event-analytics data for the given event from the database via the
 * authenticated admin session, then delegates to {@link computeEventAnalytics}
 * to produce the fully-aggregated {@link EventAnalytics}.
 *
 * ── Session requirement ──────────────────────────────────────────────────────
 * Requires a valid admin session (verified via {@link getSession}). If the
 * session is missing or expired, throws an `AnalyticsClientError` with
 * `kind: 'unauthorized'` immediately, BEFORE any DB reads.
 *
 * ── What is loaded ───────────────────────────────────────────────────────────
 *  1. **Event start** — `events.starts_at` for `as-of` alignment and the
 *     engagement bucket series origin.
 *  2. **Participant identifiers** (Req 8.6) — `questions.participant_identifier`
 *     for all questions of the event, loaded into memory SOLELY for
 *     `new Set().size` inside {@link computeEventAnalytics}. They are never
 *     returned, logged, or stored (Req 8.6).
 *  3. **Question status counts** — `questions.status` grouped in JS.
 *  4. **Total votes** — `SUM(questions.vote_count)` over the event's questions
 *     (the DB-maintained cached aggregate; `question_votes` has no client SELECT
 *     policy, Req 4.1, 23.4).
 *  5. **Poll responses** — `SUM(poll_options.response_count)` over all options of
 *     all polls for the event (the DB-maintained cached aggregate;
 *     `poll_responses` has no client SELECT policy, Req 5.8, 23.4).
 *  6. **Word-cloud responses** — count of non-hidden `word_cloud_responses` rows
 *     for the event.
 *  7. **Engagement time series** — `created_at` timestamps from `questions` and
 *     `word_cloud_responses` combined into {@link InteractionEvent}[].
 *
 * ── Failure guarantee (Req 8.7) ─────────────────────────────────────────────
 * Any DB error from ANY of the reads causes an immediate throw of an
 * {@link AnalyticsClientError} with `kind: 'load_failed'`. No partial or stale
 * metrics are returned (Req 8.7).
 *
 * @param eventId UUID of the event to fetch analytics for.
 * @returns The fully-aggregated {@link EventAnalytics}.
 * @throws {AnalyticsClientError} on missing session or any DB retrieval failure.
 */
export async function readEventAnalytics(
  eventId: string,
): Promise<EventAnalytics> {
  // ── Step 0: require authenticated admin session ───────────────────────────
  const session = await getSession();
  if (!session?.access_token) {
    throw new AnalyticsClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }

  // ── Step 1: event start (events.starts_at) ────────────────────────────────
  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select('starts_at')
    .eq('id', eventId)
    .maybeSingle();

  if (eventError) {
    throw new AnalyticsClientError(
      'Analytics could not be loaded: failed to read event data.',
      { kind: 'load_failed', cause: eventError },
    );
  }

  const eventStart: string | undefined =
    (eventRow as { starts_at?: string } | null)?.starts_at ?? undefined;

  // ── Step 2: questions (participant_identifiers, statuses, vote_count, created_at) ─
  //
  // We select participant_identifier ONLY to compute `new Set().size` inside
  // computeEventAnalytics. The identifier list is passed directly to the pure
  // aggregation function and never stored, returned, or logged (Req 8.6).
  const { data: questionRows, error: questionsError } = await supabase
    .from('questions')
    .select('participant_identifier, status, vote_count, created_at')
    .eq('event_id', eventId);

  if (questionsError) {
    throw new AnalyticsClientError(
      'Analytics could not be loaded: failed to read question data.',
      { kind: 'load_failed', cause: questionsError },
    );
  }

  const questions =
    (questionRows as Array<{
      participant_identifier: string;
      status: string;
      vote_count: number;
      created_at: string;
    }>) ?? [];

  // Participant identifiers — for distinct-count only (Req 8.6).
  const participantIdentifiers: string[] = questions.map(
    (q) => q.participant_identifier,
  );

  // Question status counts — grouped in JS from the fetched rows.
  const questionStatusCounts: Partial<Record<QuestionStatus, number>> = {};
  for (const q of questions) {
    const status = q.status as QuestionStatus;
    questionStatusCounts[status] = (questionStatusCounts[status] ?? 0) + 1;
  }

  // Total votes — SUM of the DB-maintained vote_count cache (Req 4.1, 23.4).
  // question_votes has no authenticated client SELECT policy, so we use the
  // cached integer on the questions table instead.
  const totalVotes = questions.reduce((sum, q) => sum + (q.vote_count ?? 0), 0);

  // Interaction timestamps from questions.
  const questionTimestamps: InteractionEvent[] = questions.map((q) => ({
    at: q.created_at,
  }));

  // ── Step 3: poll responses count via poll_options.response_count cache ─────
  //
  // poll_responses has NO authenticated client SELECT policy (default-deny RLS).
  // We instead sum poll_options.response_count, which is the DB-maintained
  // cached aggregate updated atomically inside the poll_respond RPC (Req 5.8, 23.4).
  //
  // Strategy: fetch all polls for this event, then fetch all options for those
  // polls and sum response_count.
  const { data: pollRows, error: pollsError } = await supabase
    .from('polls')
    .select('id')
    .eq('event_id', eventId);

  if (pollsError) {
    throw new AnalyticsClientError(
      'Analytics could not be loaded: failed to read poll data.',
      { kind: 'load_failed', cause: pollsError },
    );
  }

  const pollIds: string[] = ((pollRows as Array<{ id: string }>) ?? []).map(
    (p) => p.id,
  );

  let pollResponses = 0;
  if (pollIds.length > 0) {
    const { data: optionRows, error: optionsError } = await supabase
      .from('poll_options')
      .select('response_count')
      .in('poll_id', pollIds);

    if (optionsError) {
      throw new AnalyticsClientError(
        'Analytics could not be loaded: failed to read poll option data.',
        { kind: 'load_failed', cause: optionsError },
      );
    }

    pollResponses = (
      (optionRows as Array<{ response_count: number }>) ?? []
    ).reduce((sum, opt) => sum + (opt.response_count ?? 0), 0);
  }

  // ── Step 4: word-cloud responses (non-hidden count + created_at timestamps) ─
  const { data: wcRows, error: wcError } = await supabase
    .from('word_cloud_responses')
    .select('created_at, is_hidden')
    .eq('event_id', eventId);

  if (wcError) {
    throw new AnalyticsClientError(
      'Analytics could not be loaded: failed to read word-cloud data.',
      { kind: 'load_failed', cause: wcError },
    );
  }

  const wordCloudRows =
    (wcRows as Array<{ created_at: string; is_hidden: boolean }>) ?? [];

  // Only non-hidden responses count toward the word-cloud metric (Req 8.3).
  const wordCloudResponses = wordCloudRows.filter((r) => !r.is_hidden).length;

  // Interaction timestamps from word_cloud_responses (all, including hidden —
  // participation happened regardless of visibility state).
  const wordCloudTimestamps: InteractionEvent[] = wordCloudRows.map((r) => ({
    at: r.created_at,
  }));

  // ── Step 5: assemble interaction events for the engagement series ──────────
  //
  // Interactions = question submissions + word-cloud responses. Vote and
  // poll-response timestamps are not available via client-side reads (their
  // tables have default-deny RLS). This is a known limitation of the client read
  // path; a future service-role RPC could surface these if needed.
  const interactions: InteractionEvent[] = [
    ...questionTimestamps,
    ...wordCloudTimestamps,
  ];

  // ── Step 6: delegate all arithmetic to the pure aggregation module ─────────
  //
  // participantIdentifiers are passed here solely for `new Set().size` inside
  // computeEventAnalytics; they are never returned in EventAnalytics (Req 8.6).
  return computeEventAnalytics({
    participantIdentifiers,
    questionStatusCounts,
    totalVotes,
    pollResponses,
    wordCloudResponses,
    eventStart,
    asOf: new Date().toISOString(),
    interactions,
  });
}
