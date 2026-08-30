/**
 * Word-cloud client helper (Task 23.3).
 *
 * This module is the client-side gateway the audience word-cloud UI
 * ({@link WordCloudCard}, task 23.3) uses to (a) read the active word-cloud
 * prompt for a live event and (b) submit / update the participant's single
 * response. It is deliberately named `wordCloudClient.ts` to avoid clashing
 * with the pure, framework-agnostic normalisation/aggregation module
 * `src/lib/wordcloud.ts` (which owns `normalise()` / `aggregateWordCloud()` and
 * MUST NOT be modified here — this module IMPORTS from it conceptually via the
 * component; the client module here owns the network/RPC surface).
 *
 * It mirrors the conventions of `src/lib/questions.ts`:
 *   - The SPA NEVER inserts into `word_cloud_responses` directly — there is no
 *     anonymous write policy on the table (task 20.3). Every submission is
 *     routed through the rate-limited, `SECURITY DEFINER`
 *     `submit_word_cloud_response` RPC (task 22.3), which is the authoritative
 *     enforcement point (rate limiting, prompt-open gating, event-live gating,
 *     1–50 length validation, normalise-on-write, and the upsert on the
 *     participant/prompt unique key).
 *   - Client-side length validation (1–50 Unicode code points) is performed
 *     FIRST for fast feedback, avoiding an obviously-doomed round-trip; the RPC
 *     re-validates authoritatively so this is defence-in-depth only, mirroring
 *     how `questions.ts` validates 1–300 first.
 *
 * The RPC signature (supabase/migrations/20260101000026_word_cloud_respond_rpc.sql):
 *   submit_word_cloud_response(
 *     p_prompt_id              uuid,
 *     p_participant_identifier text,
 *     p_raw_text               text
 *   ) RETURNS word_cloud_responses
 *
 * On rejection it RAISEs a PostgreSQL exception (SQLSTATE `P0001`) whose message
 * is a stable signal string — one of `rate_limited`, `prompt_not_found`,
 * `prompt_not_open`, `event_not_live`, or `invalid_length`. supabase-js surfaces
 * that message on `error.message`, so we map the signal to a typed
 * {@link WordCloudClientError} with a friendly, user-safe message here.
 *
 * IMPORTANT — the participant identifier is opaque and MUST NEVER be rendered in
 * the UI (Req 8.6, 24.8). This module derives it internally via
 * {@link getParticipantIdentifier} and hands it to the RPC as a parameter only;
 * it is NEVER accepted from callers and NEVER returned. Likewise the active
 * prompt read NEVER selects any participant data.
 *
 * Requirements traceability: 6.6, 6.7, 6.8, 6.10, 24.7, 2.8.
 * Design references: Components (`WordCloudCard`); Request/data flows (Word
 * cloud — one response per participant, updatable while open).
 */

import { supabase } from './supabaseClient';
import { getParticipantIdentifier } from './participant';

/** The lifecycle status of a word-cloud prompt (mirrors the `wordcloud_status` enum). */
export type WordCloudStatus = 'draft' | 'open' | 'closed';

/** Minimum word-cloud response length in Unicode code points (Req 6.8). */
export const WORD_CLOUD_TEXT_MIN = 1;
/** Maximum word-cloud response length in Unicode code points (Req 6.8). */
export const WORD_CLOUD_TEXT_MAX = 50;

/** Name of the server-side response-upsert RPC (task 22.3). */
export const SUBMIT_WORD_CLOUD_RESPONSE_RPC =
  'submit_word_cloud_response' as const;

/**
 * The user-facing message identifying the 1–50 character length constraint
 * (Req 6.8). Exported so the card and its tests can assert the exact copy
 * without duplicating the wording.
 */
export const WORD_CLOUD_LENGTH_MESSAGE = `Your response must be between ${WORD_CLOUD_TEXT_MIN} and ${WORD_CLOUD_TEXT_MAX} characters.`;

/**
 * The non-sensitive projection of a word-cloud prompt the audience card reads.
 * Deliberately excludes any participant/response data. `results_visible_while_collecting`
 * governs whether the aggregated visualisation (task 23.4) may be shown while the
 * prompt is still open.
 */
export interface WordCloudPrompt {
  readonly id: string;
  readonly event_id: string;
  readonly prompt_text: string;
  readonly max_words_per_response: number;
  readonly status: WordCloudStatus;
  readonly results_visible_while_collecting: boolean;
}

/** The columns the anon client requests for the active prompt — minimal, no participant data. */
const WORD_CLOUD_PROMPT_COLUMNS =
  'id, event_id, prompt_text, max_words_per_response, status, results_visible_while_collecting' as const;

/**
 * The prompt statuses an anonymous participant may ever read. RLS excludes
 * `draft` prompts from anonymous readers; we additionally filter here as
 * defence-in-depth so a `draft` prompt is never surfaced even if a policy
 * regresses (Req 6.7). `open` and `closed` prompts are readable so the audience
 * can see the prompt text / final state.
 */
export const READABLE_WORD_CLOUD_STATUSES = ['open', 'closed'] as const;

/** Stable, machine-readable classification of a word-cloud client failure. */
export type WordCloudErrorKind =
  /** Length outside 1–50 code points (client-side or the RPC `invalid_length`). */
  | 'invalid_length'
  /** The submission rate limit was exceeded (RPC `rate_limited`). */
  | 'rate_limited'
  /** No prompt exists with the given id (RPC `prompt_not_found`). */
  | 'prompt_not_found'
  /** The prompt is not open (draft/closed), so responses are closed (RPC `prompt_not_open`). */
  | 'prompt_not_open'
  /** The event is not live, so responses are closed (RPC `event_not_live`). */
  | 'event_not_live'
  /** Any other/unexpected failure (network, malformed response, unknown signal). */
  | 'unknown';

/**
 * Typed error thrown by {@link submitWordCloudResponse} (and surfaced by
 * {@link readActivePrompt} on a transport failure).
 *
 * Carries a `kind` for branching plus a sanitised, user-safe `message` (never
 * raw provider/internal detail). The card branches on `kind` to decide whether
 * to retain the entered text (for `invalid_length`) and which inline message to
 * show.
 */
export class WordCloudClientError extends Error {
  readonly kind: WordCloudErrorKind;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: { kind: WordCloudErrorKind; cause?: unknown },
  ) {
    super(message);
    this.name = 'WordCloudClientError';
    this.kind = options.kind;
    this.cause = options.cause;
  }
}

/**
 * Counts the number of Unicode code points in a string (Req 6.8 — each code
 * point counts as one character). `String.prototype.length` counts UTF-16 code
 * units, so characters outside the Basic Multilingual Plane (e.g. many emoji)
 * would over-count; spreading iterates by code point. Mirrors
 * `countQuestionCodePoints` in `./questions`.
 */
export function countWordCloudCodePoints(value: string): number {
  return [...value].length;
}

/**
 * Returns `true` when `text` is a valid word-cloud response length (1–50
 * Unicode code points) after trimming. Trimming means a whitespace-only
 * submission is rejected as empty, matching the RPC's `btrim` + 1–50
 * `char_length` check (Req 6.8).
 */
export function isValidWordCloudLength(text: string): boolean {
  const count = countWordCloudCodePoints(text.trim());
  return count >= WORD_CLOUD_TEXT_MIN && count <= WORD_CLOUD_TEXT_MAX;
}

/**
 * Type guard narrowing an untyped Supabase row to {@link WordCloudPrompt},
 * ALSO enforcing the readable-status allow-list. A row whose status is `draft`
 * (which RLS should already exclude) is rejected here too — belt-and-braces for
 * Req 6.7. Never inspects/accepts participant data.
 */
function isWordCloudPrompt(value: unknown): value is WordCloudPrompt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.event_id === 'string' &&
    typeof v.prompt_text === 'string' &&
    typeof v.max_words_per_response === 'number' &&
    typeof v.status === 'string' &&
    (READABLE_WORD_CLOUD_STATUSES as readonly string[]).includes(v.status) &&
    typeof v.results_visible_while_collecting === 'boolean'
  );
}

/**
 * Reads the active (open/closed) word-cloud prompt for an event through the
 * anonymous browser client.
 *
 * Visibility (Req 6.7, 8.6): the query filters to
 * {@link READABLE_WORD_CLOUD_STATUSES}; combined with RLS (anon reads exclude
 * `draft` prompts and require the event to be live) a `draft` prompt is NEVER
 * returned, and NO participant/response data is ever selected. The row is passed
 * through {@link isWordCloudPrompt}, dropping anything not well-formed or
 * readable.
 *
 * A prompt lifecycle typically has at most one active (open/closed) prompt at a
 * time; if multiple are present the most-recently-created is preferred so the
 * card reflects the current prompt.
 *
 * This never throws for "no active prompt"; it returns `null`. A transport/query
 * error is surfaced as a thrown {@link WordCloudClientError} so the card can
 * render its error state.
 *
 * @param eventId The event whose active prompt to read.
 * @returns The active prompt, or `null` when there is none.
 * @throws {WordCloudClientError} on a transport/query failure.
 */
export async function readActivePrompt(
  eventId: string,
): Promise<WordCloudPrompt | null> {
  if (!eventId) return null;

  const { data, error } = await supabase
    .from('word_cloud_prompts')
    .select(WORD_CLOUD_PROMPT_COLUMNS)
    .eq('event_id', eventId)
    // Defence-in-depth alongside RLS: never even ask for draft prompts.
    .in('status', READABLE_WORD_CLOUD_STATUSES as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new WordCloudClientError(
      'The word cloud could not be loaded. Please check your connection and try again.',
      { kind: 'unknown', cause: error },
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (row === undefined || row === null) return null;
  return isWordCloudPrompt(row) ? row : null;
}

/**
 * Maps a supabase-js RPC error to a typed {@link WordCloudClientError}.
 *
 * The submit RPC RAISEs with a stable signal as the exception message
 * (`rate_limited` / `prompt_not_found` / `prompt_not_open` / `event_not_live` /
 * `invalid_length`). supabase-js exposes that on `error.message`; we match on a
 * substring (the message may be wrapped with context) and translate to a
 * friendly, user-safe message.
 */
function toWordCloudError(
  error: { message?: string } | null,
): WordCloudClientError {
  const raw = (error?.message ?? '').toLowerCase();

  if (raw.includes('rate_limited')) {
    return new WordCloudClientError(
      "You're doing that too fast. Please wait a moment and try again.",
      { kind: 'rate_limited', cause: error },
    );
  }
  if (raw.includes('prompt_not_open')) {
    return new WordCloudClientError(
      'This word cloud is not currently accepting responses.',
      { kind: 'prompt_not_open', cause: error },
    );
  }
  if (raw.includes('prompt_not_found')) {
    return new WordCloudClientError('That word cloud could not be found.', {
      kind: 'prompt_not_found',
      cause: error,
    });
  }
  if (raw.includes('event_not_live')) {
    return new WordCloudClientError(
      'Responses are closed. This event is not currently live.',
      { kind: 'event_not_live', cause: error },
    );
  }
  if (raw.includes('invalid_length')) {
    return new WordCloudClientError(WORD_CLOUD_LENGTH_MESSAGE, {
      kind: 'invalid_length',
      cause: error,
    });
  }
  return new WordCloudClientError(
    'Your response could not be submitted. Please check your connection and try again.',
    { kind: 'unknown', cause: error },
  );
}

/**
 * Submits (or updates) the participant's single word-cloud response via the
 * rate-limited `submit_word_cloud_response` RPC (task 22.3).
 *
 * Flow:
 *  1. Validate length 1–50 Unicode code points client-side for fast feedback
 *     (Req 6.8). On failure, throw a {@link WordCloudClientError} of kind
 *     `invalid_length` — no RPC call is made.
 *  2. Resolve the opaque participant identifier via
 *     {@link getParticipantIdentifier} (NEVER accepted from the caller, NEVER
 *     returned — Req 8.6).
 *  3. Call `supabase.rpc('submit_word_cloud_response', …)` with the trimmed text.
 *  4. On success resolve; on the RPC's signalled rejection map it to a typed
 *     {@link WordCloudClientError}.
 *
 * The RPC upserts on the `(participant_identifier, prompt_id)` unique key, so a
 * repeat submission UPDATES the participant's single response rather than
 * creating a duplicate — this is how an update-while-open works (Req 6.6, 6.9).
 * The response's `normalised_text` is computed authoritatively on write using
 * the same rule as the client-side `normalise()` preview.
 *
 * @param promptId The id of the open word-cloud prompt to respond to.
 * @param rawText The participant's raw response text (validated to 1–50 code points).
 * @throws {WordCloudClientError} on client-side length failure, an RPC rejection
 *   signal, or a transport failure.
 */
export async function submitWordCloudResponse(
  promptId: string,
  rawText: string,
): Promise<void> {
  // 1) Client-side length validation (fast feedback; the RPC re-validates).
  if (!isValidWordCloudLength(rawText)) {
    throw new WordCloudClientError(WORD_CLOUD_LENGTH_MESSAGE, {
      kind: 'invalid_length',
    });
  }

  // 2) Opaque participant identifier (derived internally; never rendered).
  const participantIdentifier = getParticipantIdentifier();

  // Send the trimmed text so leading/trailing whitespace does not count toward
  // the stored length (consistent with the length check above and the RPC's btrim).
  const trimmed = rawText.trim();

  // 3) Invoke the RPC.
  const { error } = await supabase.rpc(SUBMIT_WORD_CLOUD_RESPONSE_RPC, {
    p_prompt_id: promptId,
    p_participant_identifier: participantIdentifier,
    p_raw_text: trimmed,
  });

  // 4) Map a signalled rejection to a typed error.
  if (error) {
    throw toWordCloudError(error);
  }
}


// ============================================================================
// Word-cloud VISIBLE-AGGREGATE read + event-scoped Realtime subscription
// (Task 23.4 — audience word-cloud visualisation, additive to task 23.3).
//
// The audience visualisation ({@link WordCloudCard} mount point, task 23.4)
// needs two things beyond the response surface above:
//
//   (a) an initial READ of the prompt's VISIBLE responses so it can render the
//       aggregated cloud immediately (before any broadcast arrives), and
//   (b) a live SUBSCRIPTION so the cloud updates within the 2-second target
//       when an entry's visibility changes or new responses arrive (Req 6.15).
//
// Both are deliberately NARROW and PRIVACY-SAFE:
//   - The read selects ONLY `normalised_text` + `is_hidden` — NEVER
//     `participant_identifier` or any personal data (Req 2.5, 8.6). RLS
//     (…000022_word_cloud_rls.sql) already restricts anon reads to non-hidden
//     rows on a live event, so hidden entries never reach the client; we still
//     re-filter defensively and let the pure `aggregateWordCloud()` exclude
//     hidden entries as the single source of truth.
//   - The subscription is pinned to a SINGLE event's Broadcast topic
//     `event:{event_id}:wordcloud` (event `word_cloud`) — NEVER the full
//     dataset (Req 23.2). The topic + payload shape match
//     `broadcast_word_cloud` in
//     supabase/migrations/20260101000028_word_cloud_moderation_rpc.sql:
//       { event_id, prompt_id, terms: [{ term, frequency }] }
//     carrying the RAW visible term/frequency pairs (stop-word exclusion +
//     monotonic sizing are applied client-side by `aggregateWordCloud()` /
//     `sizeForFrequency()` in src/lib/wordcloud.ts).
//
// This helper mirrors {@link subscribeToPollResults} (../lib/polls) and
// {@link subscribeToEventQuestions} (../lib/questions).
//
// Requirements traceability: 6.11, 6.13, 6.14, 6.15, 23.1, 23.2, 8.6, 24.5.
// Design references: Technology Stack (d3-cloud — monotonic sizing; we own the
// aggregation/sizing in wordcloud.ts); Frontend Design (Realtime subscription
// strategy).
// ============================================================================

/**
 * The minimal, PRIVACY-SAFE projection of a visible word-cloud response the
 * audience visualisation reads. Deliberately excludes `participant_identifier`
 * and every other column (Req 2.5, 8.6). Shaped to satisfy
 * {@link WordCloudResponseLike} so it can be fed straight into
 * `aggregateWordCloud()`.
 */
export interface VisibleWordCloudResponse {
  /** The already-normalised term computed on write (task 22.3). */
  readonly normalised_text: string;
  /**
   * Whether the entry is hidden. RLS already excludes hidden rows for anon
   * readers, so this is `false` for anon reads; it is selected (and re-checked
   * by `aggregateWordCloud()`) as defence-in-depth (Req 6.13).
   */
  readonly is_hidden: boolean;
}

/** The columns the anon client requests for visible responses — NEVER participant data. */
const WORD_CLOUD_RESPONSE_COLUMNS = 'normalised_text, is_hidden' as const;

/**
 * A single aggregate term inside a {@link WordCloudBroadcast}. Carries ONLY the
 * normalised term and its visible frequency — never a `participant_identifier`
 * or any personal data (Req 8.6, 8.20).
 */
export interface WordCloudBroadcastTerm {
  readonly term: string;
  readonly frequency: number;
}

/**
 * The privacy-safe word-cloud Broadcast payload emitted by
 * `broadcast_word_cloud` on the per-event topic `event:{event_id}:wordcloud`
 * (event `word_cloud`), as documented in migration
 * `20260101000028_word_cloud_moderation_rpc.sql`. It carries ONLY the RAW
 * VISIBLE aggregate term/frequency pairs and the ids needed to route it —
 * never a `participant_identifier` or any personal data (Req 8.6, 8.20).
 * Stop-word exclusion and monotonic sizing are applied client-side via
 * `aggregateWordCloud()` / `sizeForFrequency()`.
 */
export interface WordCloudBroadcast {
  readonly event_id: string;
  readonly prompt_id: string;
  readonly terms: readonly WordCloudBroadcastTerm[];
}

/** Callbacks the audience word-cloud surface supplies to {@link subscribeToWordCloud}. */
export interface WordCloudSubscriptionHandlers {
  /**
   * Called with the aggregate {@link WordCloudBroadcast} on each `word_cloud`
   * Broadcast message for THIS event (Req 6.15, 23.1). The payload is
   * privacy-safe (no `participant_identifier`); the consumer filters to the
   * prompt it is displaying.
   */
  readonly onWordCloud?: (payload: WordCloudBroadcast) => void;
  /**
   * Called with `true` when the live connection is interrupted (channel error /
   * timeout / close) and `false` when it (re)subscribes, so the consumer can
   * show/clear the reconnecting indicator and drive its backoff (Req 23.5–23.7).
   */
  readonly onConnectionChange?: (interrupted: boolean) => void;
}

/** Handle returned by {@link subscribeToWordCloud}; call it to unsubscribe. */
export type WordCloudUnsubscribe = () => void;

/**
 * Type guard narrowing an untyped Supabase row to {@link VisibleWordCloudResponse}.
 * Rejects anything not well-formed so a malformed row can never crash the
 * consuming component. Never inspects/accepts participant data.
 */
function isVisibleWordCloudResponse(
  value: unknown,
): value is VisibleWordCloudResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.normalised_text === 'string' && typeof v.is_hidden === 'boolean'
  );
}

/**
 * Narrows an untyped Broadcast payload to a {@link WordCloudBroadcast}. Anything
 * malformed (missing ids, non-array/invalid terms) is rejected so a bad message
 * can never crash the consuming component (mirrors `isPollResultsBroadcast`).
 */
function isWordCloudBroadcast(value: unknown): value is WordCloudBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.event_id !== 'string' ||
    typeof v.prompt_id !== 'string' ||
    !Array.isArray(v.terms)
  ) {
    return false;
  }
  return v.terms.every((term) => {
    if (typeof term !== 'object' || term === null) return false;
    const t = term as Record<string, unknown>;
    return (
      typeof t.term === 'string' &&
      typeof t.frequency === 'number' &&
      Number.isFinite(t.frequency)
    );
  });
}

/**
 * Reads the VISIBLE word-cloud responses for a prompt through the anonymous
 * browser client, for the audience visualisation's initial render (Req 6.13,
 * 6.15, 8.6).
 *
 * PRIVACY (Req 2.5, 8.6): selects ONLY `normalised_text` + `is_hidden` — NEVER
 * `participant_identifier`. RLS (…000022) additionally restricts anon reads to
 * non-hidden rows on a live event, so hidden entries never reach the client;
 * the returned rows are still safe to pass straight to `aggregateWordCloud()`,
 * which excludes any `is_hidden === true` row as the single source of truth
 * (Req 6.13).
 *
 * Returns the raw per-response rows (NOT yet aggregated) so the caller can feed
 * them through the pure `aggregateWordCloud()` (which applies stop-word
 * exclusion + monotonic sizing). This never throws for "no responses"; it
 * returns `[]`. A transport/query error is surfaced as a thrown
 * {@link WordCloudClientError} so the card can render its error state.
 *
 * @param promptId The prompt whose visible responses to read.
 * @returns The visible responses (possibly empty).
 * @throws {WordCloudClientError} on a transport/query failure.
 */
export async function readVisibleResponses(
  promptId: string,
): Promise<VisibleWordCloudResponse[]> {
  if (!promptId) return [];

  const { data, error } = await supabase
    .from('word_cloud_responses')
    .select(WORD_CLOUD_RESPONSE_COLUMNS)
    .eq('prompt_id', promptId)
    // Defence-in-depth alongside RLS: never even ask for hidden rows.
    .eq('is_hidden', false);

  if (error) {
    throw new WordCloudClientError(
      'The word cloud could not be loaded. Please check your connection and try again.',
      { kind: 'unknown', cause: error },
    );
  }

  const rows = Array.isArray(data) ? data : [];
  // Drop anything malformed; keep only the privacy-safe projection.
  return rows.filter(isVisibleWordCloudResponse);
}

/**
 * Opens a Supabase Realtime channel scoped to a SINGLE event and wires it to the
 * word-cloud aggregate handlers (Req 6.15, 23.1, 23.2). It subscribes ONLY to
 * the per-event word-cloud Broadcast topic `event:{event_id}:wordcloud` (event
 * `word_cloud`) — the fan-out produced by `broadcast_word_cloud`
 * (…000028_word_cloud_moderation_rpc.sql). The payload is the privacy-safe RAW
 * VISIBLE aggregate term/frequency pairs (no `participant_identifier`, Req 8.6);
 * stop-word exclusion and monotonic sizing are applied client-side via
 * `aggregateWordCloud()` / `sizeForFrequency()`.
 *
 * Connection-state transitions drive `onConnectionChange` so the consumer can
 * surface a reconnecting indicator and drive an exponential-backoff resubscribe
 * (Req 23.5–23.7). This keeps the consuming component free of any direct
 * Supabase import (mirrors {@link subscribeToPollResults}).
 *
 * SCOPE INVARIANT (Req 23.2): the channel NEVER subscribes to the full dataset —
 * the Broadcast topic is pinned to `eventId`. A falsy `eventId` yields a no-op
 * unsubscribe (nothing is opened).
 *
 * @returns an unsubscribe function that removes the channel.
 */
export function subscribeToWordCloud(
  eventId: string,
  handlers: WordCloudSubscriptionHandlers,
): WordCloudUnsubscribe {
  // Never open a full-dataset / unscoped channel: an absent event id is a no-op.
  if (!eventId) {
    return () => {};
  }

  const channel = supabase
    // The channel name IS the Broadcast topic the RPC emits on
    // (`event:{event_id}:wordcloud`), pinned to this single event (Req 23.2).
    .channel(`event:${eventId}:wordcloud`)
    .on(
      'broadcast',
      { event: 'word_cloud' },
      (message: { payload?: unknown }) => {
        const payload = (message as { payload?: unknown })?.payload;
        // Defensively re-scope to this event id and drop malformed messages.
        if (isWordCloudBroadcast(payload) && payload.event_id === eventId) {
          handlers.onWordCloud?.(payload);
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
