/**
 * Poll client helper (Task 23.1).
 *
 * This module is the client-side gateway the audience poll UI ({@link PollCard},
 * task 23.1) uses to (a) read the current open/closed poll it may display and
 * (b) submit / change its single-choice response. It mirrors the structure and
 * conventions of `../lib/questions` (the M2 Q&A client helper).
 *
 * As with question submission/voting, the SPA never mutates `poll_responses` /
 * `poll_options.response_count` directly — there is NO client write policy that
 * trusts the client (task 20.2). Every response is routed through the
 * rate-limited, `SECURITY DEFINER` `submit_poll_response` RPC (task 21.3), which
 * is the authoritative enforcement point (rate limiting, poll-status gating,
 * event-live gating, option validity, the one-response-per-participant-per-poll
 * unique constraint, and the atomic upsert-replace `response_count`
 * maintenance).
 *
 * The RPC signature (supabase/migrations/20260101000027_poll_respond_rpc.sql):
 *   submit_poll_response(
 *     p_poll_id                uuid,
 *     p_participant_identifier text,
 *     p_option_id              uuid
 *   ) RETURNS poll_responses
 *
 * On rejection it RAISEs a PostgreSQL exception (SQLSTATE `P0001`) whose message
 * is a stable signal string — one of `poll_not_found`, `rate_limited`,
 * `poll_not_open`, `poll_closed`, `event_not_live`, or `invalid_option`.
 * supabase-js surfaces that message on `error.message`, so we map the signal to
 * a typed {@link PollError} with a friendly, user-safe message here (the same
 * pattern as `QuestionError` in `../lib/questions`).
 *
 * The anon poll read ({@link readActivePoll}) fetches only the non-sensitive
 * poll + option columns via the anon client — it NEVER selects
 * `participant_identifier` (Req 8.6). RLS (task 20.1) restricts anon reads to
 * open/closed polls on a live event (draft polls are never returned to anon).
 *
 * IMPORTANT — the participant identifier is opaque and MUST NEVER be rendered
 * in the UI (Req 8.6, 24.8). It is derived here via
 * {@link getParticipantIdentifier}; callers never supply it and it is never
 * returned.
 *
 * Requirements traceability: 5.7, 5.9, 5.10, 8.6.
 * Design references: Components (`PollCard`); Request/data flows (Poll
 * lifecycle); RLS Design (`polls`, `poll_options`, `poll_responses`).
 */

import { supabase } from './supabaseClient';
import { getParticipantIdentifier } from './participant';

/** Name of the server-side poll-response RPC (task 21.3). */
export const SUBMIT_POLL_RESPONSE_RPC = 'submit_poll_response' as const;

/** The poll lifecycle statuses (mirrors the DB `poll_status` enum). */
export type PollStatus = 'draft' | 'open' | 'closed';

/**
 * When poll results are revealed to the audience/presenter (mirrors the DB
 * `poll_results_visibility` enum). Consumed by the visibility-aware results
 * surface (task 23.2); carried here so the poll read exposes it in one place.
 */
export type PollResultsVisibility = 'show_always' | 'hide_until_closed';

/**
 * The non-sensitive projection of a `polls` row the audience surface reads.
 * Deliberately excludes any moderation-internal / identity fields (Req 8.6).
 */
export interface Poll {
  readonly id: string;
  readonly event_id: string;
  readonly question_text: string;
  readonly status: PollStatus;
  readonly display_order: number;
  readonly results_visibility: PollResultsVisibility;
}

/**
 * The non-sensitive projection of a `poll_options` row. `response_count` is the
 * denormalised tally maintained atomically by the respond RPC; it NEVER exposes
 * any `participant_identifier` (Req 8.6). The audience RESPONSE surface
 * (`PollCard`, task 23.1) does not render the count — results rendering is
 * task 23.2 — but it is read so the (later) results surface can reuse it.
 */
export interface PollOption {
  readonly id: string;
  readonly poll_id: string;
  readonly text: string;
  readonly display_order: number;
  readonly response_count: number;
}

/** A poll combined with its ordered options — the {@link readActivePoll} shape. */
export interface PollWithOptions extends Poll {
  readonly options: readonly PollOption[];
}

/** Stable, machine-readable classification of a poll-response failure. */
export type PollErrorKind =
  /** No poll exists / is visible for the id (RPC `poll_not_found`). */
  | 'poll_not_found'
  /** The response rate limit was exceeded (RPC `rate_limited`). */
  | 'rate_limited'
  /** The poll is still `draft`, so responses are not yet open (RPC `poll_not_open`). */
  | 'poll_not_open'
  /** The poll is `closed`, so responses are no longer accepted (RPC `poll_closed`). */
  | 'poll_closed'
  /** The event is not live, so participation is closed (RPC `event_not_live`). */
  | 'event_not_live'
  /** The chosen option does not belong to this poll (RPC `invalid_option`). */
  | 'invalid_option'
  /** Any other/unexpected failure (network, malformed response, unknown signal). */
  | 'unknown';

/**
 * Typed error thrown by {@link submitPollResponse} (and by the read helper on a
 * transport failure). Carries a `kind` for branching plus a sanitised,
 * user-safe `message` (never raw provider/internal detail). This reuses the
 * `QuestionError`-style pattern from `../lib/questions`, kept local to
 * `polls.ts`.
 */
export class PollError extends Error {
  readonly kind: PollErrorKind;
  readonly cause?: unknown;

  constructor(message: string, options: { kind: PollErrorKind; cause?: unknown }) {
    super(message);
    this.name = 'PollError';
    this.kind = options.kind;
    this.cause = options.cause;
  }
}

/** The columns the anon client requests for a poll — minimal, non-sensitive. */
const POLL_COLUMNS =
  'id, event_id, question_text, status, display_order, results_visibility' as const;

/** The columns the anon client requests for each option — minimal, non-sensitive. */
const POLL_OPTION_COLUMNS =
  'id, poll_id, text, display_order, response_count' as const;

/** The poll statuses anon may ever read (RLS returns only these on a live event). */
const READABLE_POLL_STATUSES: readonly PollStatus[] = ['open', 'closed'] as const;

/** Type guard narrowing an untyped Supabase row to {@link PollOption}. */
function isPollOption(value: unknown): value is PollOption {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.poll_id === 'string' &&
    typeof v.text === 'string' &&
    typeof v.display_order === 'number' &&
    typeof v.response_count === 'number'
  );
}

/**
 * Type guard narrowing an untyped Supabase row to {@link Poll}, ALSO enforcing
 * the readable-status allow-list. A row whose status is not in
 * {@link READABLE_POLL_STATUSES} (which RLS should already exclude — draft polls
 * are never returned to anon) is rejected here too — belt-and-braces for
 * Req 5.11/8.6.
 */
function isReadablePoll(value: unknown): value is Poll {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.event_id === 'string' &&
    typeof v.question_text === 'string' &&
    typeof v.status === 'string' &&
    (READABLE_POLL_STATUSES as readonly string[]).includes(v.status) &&
    typeof v.display_order === 'number' &&
    typeof v.results_visibility === 'string'
  );
}

/**
 * Reads the current active poll for an event through the anonymous browser
 * client, with its options ordered by `display_order`.
 *
 * "Active" means the poll a participant should currently see: the OPEN poll if
 * one exists, otherwise the most recent open/closed poll. RLS (task 20.1)
 * already restricts anon reads to open/closed polls on a live event, so this
 * helper simply orders by `status='open'` first (an open poll wins) then by
 * `display_order` descending as a stable tie-break, and takes the first row.
 *
 * Visibility (Req 5.11, 8.6): the query never selects `participant_identifier`
 * (there is no such column on `polls`/`poll_options` anyway), and combined with
 * RLS a `draft` poll is NEVER returned. The poll row is passed through
 * {@link isReadablePoll} (dropping anything not well-formed / not readable) and
 * each option through {@link isPollOption}.
 *
 * This never throws for "no data"; it returns `null`. A transport/query error
 * is surfaced as a thrown {@link PollError} so the card can render its error
 * state.
 *
 * @param eventId The event whose active poll to read.
 * @returns The active {@link PollWithOptions}, or `null` when there is none.
 * @throws {PollError} on a transport/query failure.
 */
export async function readActivePoll(
  eventId: string,
): Promise<PollWithOptions | null> {
  if (!eventId) return null;

  // 1) Read the candidate polls for the event (RLS returns only open/closed on a
  //    live event). Prefer an OPEN poll, then the most recent by display_order.
  const { data: pollRows, error: pollError } = await supabase
    .from('polls')
    .select(POLL_COLUMNS)
    .eq('event_id', eventId)
    // Defence-in-depth alongside RLS: never even ask for draft polls.
    .in('status', READABLE_POLL_STATUSES as unknown as string[])
    // An open poll should win over a closed one; PostgreSQL orders text
    // descending as 'open' > 'closed' > … so `status` desc surfaces 'open'
    // first, then `display_order` desc as a stable, most-recent-first tie-break.
    .order('status', { ascending: false })
    .order('display_order', { ascending: false });

  if (pollError) {
    throw new PollError(
      'The poll could not be loaded. Please check your connection and try again.',
      { kind: 'unknown', cause: pollError },
    );
  }

  const rows = Array.isArray(pollRows) ? pollRows : [];
  const poll = rows.find(isReadablePoll);
  if (!poll) return null;

  // 2) Read that poll's options, ordered by display_order (Req 5.1).
  const { data: optionRows, error: optionError } = await supabase
    .from('poll_options')
    .select(POLL_OPTION_COLUMNS)
    .eq('poll_id', poll.id)
    .order('display_order', { ascending: true });

  if (optionError) {
    throw new PollError(
      'The poll options could not be loaded. Please check your connection and try again.',
      { kind: 'unknown', cause: optionError },
    );
  }

  const options = (Array.isArray(optionRows) ? optionRows : []).filter(
    isPollOption,
  );

  return { ...poll, options };
}

/**
 * Maps a supabase-js RPC error to a typed {@link PollError}.
 *
 * The respond RPC RAISEs with a stable signal as the exception message
 * (`poll_not_found` / `rate_limited` / `poll_not_open` / `poll_closed` /
 * `event_not_live` / `invalid_option`). supabase-js exposes that on
 * `error.message`; we match on a substring (the message may be wrapped with
 * context) and translate to a friendly, user-safe message.
 */
function toPollError(error: { message?: string } | null): PollError {
  const raw = (error?.message ?? '').toLowerCase();

  if (raw.includes('rate_limited')) {
    return new PollError(
      "You're responding too fast. Please wait a moment and try again.",
      { kind: 'rate_limited', cause: error },
    );
  }
  if (raw.includes('poll_not_open')) {
    return new PollError('This poll is not open for responses yet.', {
      kind: 'poll_not_open',
      cause: error,
    });
  }
  if (raw.includes('poll_closed')) {
    return new PollError('This poll is closed. Responses are no longer accepted.', {
      kind: 'poll_closed',
      cause: error,
    });
  }
  if (raw.includes('poll_not_found')) {
    return new PollError('That poll could not be found.', {
      kind: 'poll_not_found',
      cause: error,
    });
  }
  if (raw.includes('event_not_live')) {
    return new PollError('Responses are closed. This event is not currently live.', {
      kind: 'event_not_live',
      cause: error,
    });
  }
  if (raw.includes('invalid_option')) {
    return new PollError('That answer is not a valid option for this poll.', {
      kind: 'invalid_option',
      cause: error,
    });
  }
  return new PollError(
    'Your response could not be recorded. Please check your connection and try again.',
    { kind: 'unknown', cause: error },
  );
}

/**
 * Submits (or changes) the participant's single-choice poll response via the
 * atomic upsert-replace `submit_poll_response` RPC (task 21.3).
 *
 * The opaque participant identifier is derived via
 * {@link getParticipantIdentifier} — it is NEVER accepted from the caller and
 * NEVER returned (Req 8.6). The server enforces poll-status gating (rejecting a
 * `draft` poll with `poll_not_open` — Req 5.10 — and a `closed` poll with
 * `poll_closed` — Req 5.9), event-live gating, option validity, the response
 * rate limit, and the one-response-per-participant-per-poll unique constraint
 * enabling the upsert-replace: a first response inserts, a changed response
 * moves the count from the old option to the new so exactly one response
 * remains (Req 5.7, 5.8).
 *
 * @param pollId   The id of the poll to respond to.
 * @param optionId The id of the chosen option (must belong to the poll).
 * @throws {PollError} on an RPC rejection signal or a transport failure.
 */
export async function submitPollResponse(
  pollId: string,
  optionId: string,
): Promise<void> {
  const participantIdentifier = getParticipantIdentifier();

  const { error } = await supabase.rpc(SUBMIT_POLL_RESPONSE_RPC, {
    p_poll_id: pollId,
    p_participant_identifier: participantIdentifier,
    p_option_id: optionId,
  });

  if (error) {
    throw toPollError(error);
  }
}
