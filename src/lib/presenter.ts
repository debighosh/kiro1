/**
 * Presenter read helpers (Task 17.1).
 *
 * The presenter view (`/present/:eventRef`) is a DISPLAY-ONLY, projector-
 * optimised surface. It resolves the event (via {@link findEventByRef}), reads
 * the event's currently-selected {@link PresenterMode}, and — for the question
 * modes shipped in Milestone 2 — reads the questions it should display through
 * the anonymous browser client.
 *
 * Security / visibility invariant (Design → Request/data flows → "Presenter
 * mode switching"; RLS Design → `questions`): the anon client can ONLY read a
 * question while its parent event is `live` AND its status is `approved` or
 * `featured` (task 12.1 RLS). Consequently the presenter — which reads via this
 * same anon-equivalent path — can NEVER see `pending` or `hidden` questions
 * (Req 7.9). As defence-in-depth this module ALSO explicitly filters the query
 * to the presentable statuses and never renders `pending`/`hidden`, so the
 * exclusion holds even if RLS were mis-scoped.
 *
 * Only the minimal, non-sensitive columns are selected (`id`, `text`,
 * `status`, `vote_count`). Vote rows and `participant_identifier` are never
 * read here (Req 8.6).
 *
 * Requirements traceability: 7.5 (mode selection), 7.6/7.7 (realtime + last-
 * content-on-loss handled by the view), 7.9 (exclude pending/hidden), 7.10
 * (join screen QR + Event_Code — handled by the view).
 * Design: Request/data flows (Presenter mode switching); RLS Design
 * (`questions`); Frontend Design (Route map — `/present/:eventRef`).
 */

import { supabase } from './supabaseClient';

/**
 * The presenter display modes (mirrors the DB `presenter_mode` enum, Req 7.4).
 * Milestone 2 implements the `join`, `featured_question`, `top_questions`, and
 * `waiting` modes in the presenter view; `poll_results`, `word_cloud`, and
 * `ai_themes` are Milestone 3+ and fall back to the waiting screen for now.
 */
export type PresenterMode =
  | 'join'
  | 'featured_question'
  | 'top_questions'
  | 'poll_results'
  | 'word_cloud'
  | 'ai_themes'
  | 'waiting';

/** All presenter modes, matching the DB enum declaration order. */
export const PRESENTER_MODES: readonly PresenterMode[] = [
  'join',
  'featured_question',
  'top_questions',
  'poll_results',
  'word_cloud',
  'ai_themes',
  'waiting',
];

/**
 * Narrows an arbitrary value to a {@link PresenterMode}. Used to validate the
 * `active_presenter_mode` read back from the event row (which the type system
 * types loosely) before the view switches on it. An unknown/absent value is
 * treated by the caller as the `waiting` fallback.
 */
export function isPresenterMode(value: unknown): value is PresenterMode {
  return (
    typeof value === 'string' &&
    (PRESENTER_MODES as readonly string[]).includes(value)
  );
}

/**
 * The question statuses the presenter is ever allowed to display (Req 7.9).
 * `pending` and `hidden` are DELIBERATELY excluded. `answered` is included so a
 * question the moderator has marked answered can still be shown in context.
 */
export const PRESENTABLE_QUESTION_STATUSES = [
  'approved',
  'featured',
  'answered',
] as const;

/** A single presentable question status. */
export type PresentableQuestionStatus =
  (typeof PRESENTABLE_QUESTION_STATUSES)[number];

/**
 * The minimal, non-sensitive projection of a question the presenter renders.
 * Deliberately excludes any moderation-internal or identity fields.
 */
export interface PresenterQuestion {
  readonly id: string;
  readonly text: string;
  readonly status: PresentableQuestionStatus;
  readonly vote_count: number;
}

/** The columns the anon client requests for the presenter — minimal. */
const PRESENTER_QUESTION_COLUMNS = 'id, text, status, vote_count' as const;

/**
 * The default number of questions the `top_questions` mode displays. Kept small
 * so the projector view stays readable at ≥24px on a 16:9 screen (Req 7.1).
 */
export const DEFAULT_TOP_QUESTIONS_LIMIT = 5;

/**
 * Type guard narrowing an untyped Supabase row to {@link PresenterQuestion},
 * ALSO enforcing the presentable-status allow-list. A row whose status is not
 * in {@link PRESENTABLE_QUESTION_STATUSES} (i.e. `pending`/`hidden`, which RLS
 * should already exclude) is rejected here too — belt-and-braces for Req 7.9.
 */
function isPresenterQuestion(value: unknown): value is PresenterQuestion {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.text === 'string' &&
    typeof v.status === 'string' &&
    (PRESENTABLE_QUESTION_STATUSES as readonly string[]).includes(v.status) &&
    typeof v.vote_count === 'number'
  );
}

/**
 * Reads the presentable questions for an event, ordered by `vote_count`
 * descending (then most-recent first as a stable tie-break), through the
 * anonymous browser client.
 *
 * Visibility (Req 7.9): the query is filtered to
 * {@link PRESENTABLE_QUESTION_STATUSES} (`approved`/`featured`/`answered`);
 * combined with RLS (which already restricts anon reads to `approved`/
 * `featured` on a live event), `pending`/`hidden` questions are NEVER returned.
 * The result is additionally passed through {@link isPresenterQuestion}, which
 * drops any row that is not both well-formed and presentable.
 *
 * This never throws for "no data"; it returns `[]`. A transport/query error is
 * likewise swallowed to `[]` so the presenter uniformly shows an empty/waiting
 * state rather than leaking internals — and, per Req 7.7, the VIEW retains the
 * previously-displayed content on a subsequent failure.
 *
 * @param eventId The event whose questions to read.
 * @param limit   Maximum rows to return (defaults to
 *   {@link DEFAULT_TOP_QUESTIONS_LIMIT}). Pass `1` for the featured-question
 *   mode to fetch just the top question.
 * @returns The presentable questions (possibly empty), highest-voted first.
 */
export async function readPresenterQuestions(
  eventId: string,
  limit: number = DEFAULT_TOP_QUESTIONS_LIMIT,
): Promise<PresenterQuestion[]> {
  if (!eventId) return [];

  const { data, error } = await supabase
    .from('questions')
    .select(PRESENTER_QUESTION_COLUMNS)
    .eq('event_id', eventId)
    // Defence-in-depth alongside RLS: never even ask for pending/hidden.
    .in('status', PRESENTABLE_QUESTION_STATUSES as unknown as string[])
    .order('vote_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.max(1, limit));

  if (error || !Array.isArray(data)) return [];

  return data.filter(isPresenterQuestion);
}

/**
 * Reads the single highest-priority FEATURED question for an event (Req 7.4
 * featured-question mode). "Highest-priority" is the featured question with the
 * most votes; ties fall back to the most recent. Returns `null` when the event
 * has no featured question currently visible.
 *
 * Only status `featured` is considered here (the featured-question mode shows
 * the moderator's explicitly-featured question, not merely an approved one).
 *
 * @param eventId The event whose featured question to read.
 * @returns The top featured question, or `null` if there is none.
 */
export async function readFeaturedQuestion(
  eventId: string,
): Promise<PresenterQuestion | null> {
  if (!eventId) return null;

  const { data, error } = await supabase
    .from('questions')
    .select(PRESENTER_QUESTION_COLUMNS)
    .eq('event_id', eventId)
    .eq('status', 'featured')
    .order('vote_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !isPresenterQuestion(data)) return null;
  return data;
}

// ============================================================================
// Task 24.2 — event-scoped poll-results + word-cloud broadcast payloads.
// ============================================================================
//
// In addition to the M2 `events`/`questions` postgres_changes above, the
// presenter's Milestone-3 `poll_results` and `word_cloud` modes need the live
// aggregate tallies to update within the 2-second delivery target (Req 5.12,
// 6.15, 23.2) WITHOUT a manual refresh. Those aggregates arrive on the SAME two
// event-scoped Broadcast topics the audience surfaces subscribe to
// (`subscribeToPollResults` in `../lib/polls`; the word-cloud broadcast in
// migration …000028):
//
//   * topic `event:{event_id}:polls`, event `poll_results`, payload
//     `{ event_id, poll_id, options: [{ option_id, response_count }] }`
//     (migration …000029_poll_broadcast.sql);
//   * topic `event:{event_id}:wordcloud`, event `word_cloud`, payload
//     `{ event_id, prompt_id, terms: [{ term, frequency }] }`
//     (migration …000028_word_cloud_moderation_rpc.sql).
//
// Both payloads are privacy-safe aggregates — NEVER a `participant_identifier`
// (Req 8.6, 20). Because a Supabase Broadcast is delivered to the channel whose
// NAME equals the emitted topic, these two bindings live on their OWN channels
// (named after each topic), NOT on the `presenter:{eventId}` postgres_changes
// channel; `subscribeToPresenter` opens all three and returns a single
// unsubscribe that tears them all down.

/** A single per-option tally inside a {@link PresenterPollResultsPayload}. */
export interface PresenterPollResultsOption {
  readonly option_id: string;
  readonly response_count: number;
}

/**
 * The privacy-safe poll-results Broadcast payload the presenter receives on the
 * per-event topic `event:{event_id}:polls` (event `poll_results`), emitted by
 * the poll-response RPC (migration …000029). Carries ONLY the aggregate
 * per-option counts + routing ids — never a `participant_identifier` (Req 8.6).
 */
export interface PresenterPollResultsPayload {
  readonly event_id: string;
  readonly poll_id: string;
  readonly options: readonly PresenterPollResultsOption[];
}

/** A single aggregated term inside a {@link PresenterWordCloudPayload}. */
export interface PresenterWordCloudTermPayload {
  readonly term: string;
  readonly frequency: number;
}

/**
 * The privacy-safe word-cloud Broadcast payload the presenter receives on the
 * per-event topic `event:{event_id}:wordcloud` (event `word_cloud`), emitted by
 * the word-cloud response/moderation path (migration …000028). Carries ONLY the
 * visible aggregate term/frequency pairs + routing ids — never a
 * `participant_identifier` (Req 8.6).
 */
export interface PresenterWordCloudPayload {
  readonly event_id: string;
  readonly prompt_id: string;
  readonly terms: readonly PresenterWordCloudTermPayload[];
}

/** Narrows an untyped Broadcast payload to {@link PresenterPollResultsPayload}. */
function isPresenterPollResultsPayload(
  value: unknown,
): value is PresenterPollResultsPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.event_id !== 'string' ||
    typeof v.poll_id !== 'string' ||
    !Array.isArray(v.options)
  ) {
    return false;
  }
  return v.options.every((option) => {
    if (typeof option !== 'object' || option === null) return false;
    const o = option as Record<string, unknown>;
    return (
      typeof o.option_id === 'string' &&
      typeof o.response_count === 'number' &&
      Number.isFinite(o.response_count)
    );
  });
}

/** Narrows an untyped Broadcast payload to {@link PresenterWordCloudPayload}. */
function isPresenterWordCloudPayload(
  value: unknown,
): value is PresenterWordCloudPayload {
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
 * Callbacks the presenter view supplies to {@link subscribeToPresenter}.
 */
export interface PresenterSubscriptionHandlers {
  /**
   * Called with the new {@link PresenterMode} when the moderator changes the
   * event's `active_presenter_mode` (Req 7.5, 7.6). The mode is validated by
   * {@link isPresenterMode} before this fires.
   */
  readonly onModeChange: (mode: PresenterMode) => void;
  /**
   * Called (debounced by Realtime delivery) whenever a question for this event
   * is inserted/updated/deleted, so the view can re-read the current mode's
   * content (Req 7.6).
   */
  readonly onQuestionsChange: () => void;
  /**
   * Called with `true` when the live connection is interrupted and `false`
   * when it (re)subscribes, so the view can show/clear the interruption
   * indicator while retaining the last content (Req 7.7).
   */
  readonly onConnectionChange: (interrupted: boolean) => void;
  /**
   * OPTIONAL (task 24.2). Called with the privacy-safe aggregate
   * {@link PresenterPollResultsPayload} on each `poll_results` Broadcast for
   * THIS event, so the `poll_results` mode can update the per-option tallies
   * within the 2-second target (Req 5.12, 23.2) without a re-read. Payload is
   * defensively re-scoped to this event; malformed messages are dropped.
   */
  readonly onPollResults?: (payload: PresenterPollResultsPayload) => void;
  /**
   * OPTIONAL (task 24.2). Called with the privacy-safe aggregate
   * {@link PresenterWordCloudPayload} on each `word_cloud` Broadcast for THIS
   * event, so the `word_cloud` mode can refresh the sized terms within the
   * 2-second target (Req 6.15, 23.2) without a re-read. Payload is defensively
   * re-scoped to this event; malformed messages are dropped.
   */
  readonly onWordCloud?: (payload: PresenterWordCloudPayload) => void;
}

/** Handle returned by {@link subscribeToPresenter}; call it to unsubscribe. */
export type PresenterUnsubscribe = () => void;

/**
 * Opens a Supabase Realtime channel scoped to a single event and wires it to
 * the presenter view's handlers (Req 7.6, 7.7). It subscribes to:
 *  - `events` UPDATEs filtered to this `id` — for `active_presenter_mode`
 *    changes (the moderator switching modes, Req 7.5);
 *  - `questions` changes filtered to this `event_id` — for new questions and
 *    vote-count updates (Req 7.6).
 *
 * Connection-state transitions drive `onConnectionChange` so the view can
 * surface an interruption indicator while retaining the last-displayed content
 * (Req 7.7). This keeps the presenter view free of any direct Supabase import,
 * so it can be unit-tested by mocking `../lib/presenter` alone.
 *
 * Task 24.2 — Milestone-3 realtime: when the OPTIONAL `onPollResults` /
 * `onWordCloud` handlers are supplied, this ALSO opens the two event-scoped
 * Broadcast topics the M3 presenter modes need — `event:{eventId}:polls`
 * (event `poll_results`) and `event:{eventId}:wordcloud` (event `word_cloud`) —
 * so the `poll_results` / `word_cloud` modes update within the 2-second target
 * (Req 5.12, 6.15, 23.2). These are SEPARATE channels (a Supabase Broadcast is
 * delivered on the channel whose NAME equals the emitted topic, so they cannot
 * ride on the `presenter:{eventId}` postgres_changes channel). Only the primary
 * channel's transport state drives `onConnectionChange`, so the M2 interruption
 * UX (Req 7.7) is unchanged and the last-good content is retained beneath the
 * banner. All channels are torn down by the returned unsubscribe.
 *
 * @returns an unsubscribe function that removes every opened channel.
 */
export function subscribeToPresenter(
  eventId: string,
  handlers: PresenterSubscriptionHandlers,
): PresenterUnsubscribe {
  const channel = supabase
    .channel(`presenter:${eventId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'events',
        filter: `id=eq.${eventId}`,
      },
      (payload: { new?: Record<string, unknown> }) => {
        const next = payload.new?.active_presenter_mode;
        if (isPresenterMode(next)) handlers.onModeChange(next);
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'questions',
        filter: `event_id=eq.${eventId}`,
      },
      () => {
        handlers.onQuestionsChange();
      },
    )
    .subscribe((state: string) => {
      // Req 7.7: retain last content and flag an interruption on any non-
      // subscribed transport state; clear it once (re)subscribed.
      if (state === 'SUBSCRIBED') {
        handlers.onConnectionChange(false);
      } else if (
        state === 'CHANNEL_ERROR' ||
        state === 'TIMED_OUT' ||
        state === 'CLOSED'
      ) {
        handlers.onConnectionChange(true);
      }
    });

  // Track every channel opened so the returned unsubscribe tears them ALL down.
  const channels = [channel];

  // Task 24.2: only open the M3 poll-results Broadcast channel when the view
  // supplies the handler (keeps the M2 behaviour and its tests unchanged when
  // the optional handler is absent). The channel name IS the topic the RPC
  // emits on (`event:{eventId}:polls`); the payload is a privacy-safe aggregate
  // (no participant_identifier, Req 8.6) which we re-scope to this event.
  const onPollResults = handlers.onPollResults;
  if (onPollResults) {
    const pollChannel = supabase
      .channel(`event:${eventId}:polls`)
      .on(
        'broadcast',
        { event: 'poll_results' },
        (message: { payload?: unknown }) => {
          const payload = message?.payload;
          if (
            isPresenterPollResultsPayload(payload) &&
            payload.event_id === eventId
          ) {
            onPollResults(payload);
          }
        },
      )
      .subscribe();
    channels.push(pollChannel);
  }

  // Task 24.2: likewise the word-cloud Broadcast channel — topic
  // `event:{eventId}:wordcloud`, event `word_cloud`, privacy-safe aggregate
  // term/frequency payload (Req 8.6), re-scoped to this event.
  const onWordCloud = handlers.onWordCloud;
  if (onWordCloud) {
    const wordCloudChannel = supabase
      .channel(`event:${eventId}:wordcloud`)
      .on(
        'broadcast',
        { event: 'word_cloud' },
        (message: { payload?: unknown }) => {
          const payload = message?.payload;
          if (
            isPresenterWordCloudPayload(payload) &&
            payload.event_id === eventId
          ) {
            onWordCloud(payload);
          }
        },
      )
      .subscribe();
    channels.push(wordCloudChannel);
  }

  return () => {
    for (const ch of channels) {
      void supabase.removeChannel(ch);
    }
  };
}

// ============================================================================
// Task 24.1 — Presenter poll_results + word_cloud reads (Milestone 3).
// ============================================================================
//
// The presenter view (`/present/:eventRef`) gains two Milestone-3 display
// modes: `poll_results` (the active poll's visibility-aware tallies) and
// `word_cloud` (the aggregated live word cloud for the active prompt). Both are
// DISPLAY-ONLY, projector-optimised surfaces that read through the same
// anonymous browser client as the M2 question modes above.
//
// Security / visibility invariants (RLS Design → `polls` / `word_cloud_*`;
// Req 5.11, 6.13, 7.9, 8.6):
//   * The anon client can ONLY read a poll while its parent event is `live`
//     AND its status is `open` or `closed` (task 20.1 RLS) — so a `draft` poll
//     is NEVER returned to the presenter. This helper additionally filters to
//     the readable statuses as defence-in-depth.
//   * The anon client can ONLY read a word-cloud prompt while the event is
//     `live` AND its status is `open`/`closed`, and can ONLY read responses
//     that are on a live event AND `is_hidden = false` (task 20.3 RLS). Hidden
//     entries are therefore excluded at the row level and never aggregated.
//   * NEITHER helper ever selects `participant_identifier` — the response read
//     projects only `normalised_text` + `is_hidden` (Req 8.6).
//
// These helpers live here (rather than importing `../lib/polls`) so the
// presenter keeps a SINGLE presenter-read module: the view mocks
// `../lib/presenter` alone in tests, and there is no risk of a client-write
// module (polls.ts, which imports the participant identifier) being pulled into
// the presenter graph. The queries are small, dedicated, presenter-only reads.
//
// Requirements traceability: 7.4, 7.5, 7.8, 5.11, 6.13, 7.9.
// Design: Request/data flows (Presenter mode switching); Data Models
// (`presenter_mode` enum values `poll_results`, `word_cloud`).

/** The poll lifecycle statuses the presenter may read (mirrors DB `poll_status`). */
export type PresenterPollStatus = 'open' | 'closed';

/**
 * When poll results are revealed (mirrors the DB `poll_results_visibility`
 * enum). `hide_until_closed` withholds the tallies until the poll is `closed`;
 * `show_always` renders the per-option tallies while the poll is still open.
 */
export type PresenterPollResultsVisibility =
  'show_always' | 'hide_until_closed';

/**
 * A single poll option projected for the presenter results surface — the option
 * text, its display order, and the denormalised `response_count` tally. NEVER
 * includes any participant data (Req 8.6).
 */
export interface PresenterPollOption {
  readonly id: string;
  readonly text: string;
  readonly display_order: number;
  readonly response_count: number;
}

/**
 * The active poll + its ordered options as read for the presenter
 * `poll_results` mode. `results_visibility` drives whether the tallies are
 * shown while the poll is `open` (Req 5.11).
 */
export interface PresenterActivePoll {
  readonly id: string;
  readonly question_text: string;
  readonly status: PresenterPollStatus;
  readonly results_visibility: PresenterPollResultsVisibility;
  readonly options: readonly PresenterPollOption[];
}

/** The poll statuses anon may ever read (RLS returns only these on a live event). */
const PRESENTER_READABLE_POLL_STATUSES: readonly PresenterPollStatus[] = [
  'open',
  'closed',
] as const;

/** The columns the anon client requests for the presenter poll — minimal, non-sensitive. */
const PRESENTER_POLL_COLUMNS =
  'id, question_text, status, results_visibility' as const;

/** The columns the anon client requests for each presenter poll option — minimal. */
const PRESENTER_POLL_OPTION_COLUMNS =
  'id, text, display_order, response_count' as const;

/** Type guard narrowing an untyped Supabase row to {@link PresenterPollOption}. */
function isPresenterPollOption(value: unknown): value is PresenterPollOption {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.text === 'string' &&
    typeof v.display_order === 'number' &&
    typeof v.response_count === 'number'
  );
}

/**
 * Type guard narrowing an untyped Supabase poll row to the readable shape,
 * ALSO enforcing the readable-status allow-list (`open`/`closed`). A `draft`
 * poll — which RLS should already exclude — is rejected here too, belt-and-
 * braces for Req 5.11.
 */
function isPresenterReadablePoll(value: unknown): value is {
  id: string;
  question_text: string;
  status: PresenterPollStatus;
  results_visibility: PresenterPollResultsVisibility;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.question_text === 'string' &&
    typeof v.status === 'string' &&
    (PRESENTER_READABLE_POLL_STATUSES as readonly string[]).includes(
      v.status,
    ) &&
    (v.results_visibility === 'show_always' ||
      v.results_visibility === 'hide_until_closed')
  );
}

/**
 * Reads the current active poll for an event (with its options ordered by
 * `display_order`) through the anonymous browser client, for the presenter
 * `poll_results` mode (Req 7.4, 5.11).
 *
 * "Active" is the poll the presenter should currently show: the OPEN poll if
 * one exists, otherwise the most recent open/closed poll. RLS (task 20.1)
 * already restricts anon reads to open/closed polls on a live event, so this
 * orders `status` descending (`'open'` sorts before `'closed'`, so an open poll
 * wins) then `display_order` descending as a stable most-recent-first
 * tie-break, and takes the first row.
 *
 * Visibility (Req 5.11, 8.6): the query never selects `participant_identifier`
 * (there is no such column on `polls`/`poll_options` anyway), and combined with
 * RLS a `draft` poll is NEVER returned. This never throws — it swallows a
 * transport/query error to `null` so the presenter uniformly shows a waiting/
 * empty state (and the view retains the last-good content, Req 7.7/7.8, wired
 * in task 24.2).
 *
 * @param eventId The event whose active poll to read.
 * @returns The active {@link PresenterActivePoll}, or `null` when there is none.
 */
export async function readPresenterActivePoll(
  eventId: string,
): Promise<PresenterActivePoll | null> {
  if (!eventId) return null;

  // 1) Read the candidate polls (RLS returns only open/closed on a live event).
  //    Prefer an OPEN poll, then the most recent by display_order.
  const { data: pollRows, error: pollError } = await supabase
    .from('polls')
    .select(PRESENTER_POLL_COLUMNS)
    .eq('event_id', eventId)
    // Defence-in-depth alongside RLS: never even ask for draft polls.
    .in('status', PRESENTER_READABLE_POLL_STATUSES as unknown as string[])
    // 'open' sorts after 'closed' descending, so status desc surfaces the open
    // poll first; display_order desc is a stable most-recent-first tie-break.
    .order('status', { ascending: false })
    .order('display_order', { ascending: false });

  if (pollError || !Array.isArray(pollRows)) return null;

  const poll = pollRows.find(isPresenterReadablePoll);
  if (!poll) return null;

  // 2) Read that poll's options, ordered by display_order (Req 5.1).
  const { data: optionRows, error: optionError } = await supabase
    .from('poll_options')
    .select(PRESENTER_POLL_OPTION_COLUMNS)
    .eq('poll_id', poll.id)
    .order('display_order', { ascending: true });

  if (optionError || !Array.isArray(optionRows)) {
    // Options unreadable → show the question with no tallies rather than fail.
    return { ...poll, options: [] };
  }

  return { ...poll, options: optionRows.filter(isPresenterPollOption) };
}

/**
 * The active word-cloud prompt projected for the presenter `word_cloud` mode.
 * `results_visible_while_collecting` is carried so the view can decide whether
 * to render the cloud while the prompt is still `open`.
 */
export interface PresenterWordCloudPrompt {
  readonly id: string;
  readonly prompt_text: string;
  readonly status: 'open' | 'closed';
  readonly results_visible_while_collecting: boolean;
}

/**
 * A single VISIBLE word-cloud response, projecting ONLY the two columns
 * aggregation needs. `participant_identifier` is NEVER selected (Req 8.6).
 */
export interface PresenterWordCloudResponse {
  readonly normalised_text: string;
  readonly is_hidden: boolean;
}

/** The presenter word-cloud read result: the active prompt (or null) + its visible responses. */
export interface PresenterWordCloud {
  readonly prompt: PresenterWordCloudPrompt | null;
  readonly responses: readonly PresenterWordCloudResponse[];
}

/** The prompt statuses anon may ever read (RLS returns only these on a live event). */
const PRESENTER_READABLE_PROMPT_STATUSES: readonly ('open' | 'closed')[] = [
  'open',
  'closed',
] as const;

/** The columns the anon client requests for the presenter prompt — minimal, non-sensitive. */
const PRESENTER_PROMPT_COLUMNS =
  'id, prompt_text, status, results_visible_while_collecting' as const;

/**
 * The columns the anon client requests for each response — ONLY the two
 * aggregation needs. `participant_identifier` is DELIBERATELY absent (Req 8.6).
 */
const PRESENTER_WC_RESPONSE_COLUMNS = 'normalised_text, is_hidden' as const;

/** Type guard narrowing an untyped Supabase prompt row to {@link PresenterWordCloudPrompt}. */
function isPresenterReadablePrompt(
  value: unknown,
): value is PresenterWordCloudPrompt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.prompt_text === 'string' &&
    typeof v.status === 'string' &&
    (PRESENTER_READABLE_PROMPT_STATUSES as readonly string[]).includes(
      v.status,
    ) &&
    typeof v.results_visible_while_collecting === 'boolean'
  );
}

/** Type guard narrowing an untyped Supabase response row to {@link PresenterWordCloudResponse}. */
function isPresenterWordCloudResponse(
  value: unknown,
): value is PresenterWordCloudResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.normalised_text === 'string' && typeof v.is_hidden === 'boolean'
  );
}

/**
 * Reads the active word-cloud prompt AND its VISIBLE responses for an event
 * through the anonymous browser client, for the presenter `word_cloud` mode
 * (Req 7.4, 6.13, 7.9).
 *
 * "Active" is the prompt the presenter should currently show: the OPEN prompt
 * if one exists, otherwise the most recent open/closed prompt. RLS (task 20.3)
 * restricts anon reads to open/closed prompts on a live event, so a `draft`
 * prompt is NEVER returned.
 *
 * Responses are read filtered to `is_hidden = false` (defence-in-depth on top
 * of RLS, which already excludes hidden responses at the row level, Req 6.13),
 * projecting ONLY `normalised_text` + `is_hidden` — NEVER `participant_identifier`
 * (Req 8.6). The caller aggregates the visible responses via
 * {@link aggregateWordCloud} (`../lib/wordcloud`).
 *
 * This never throws; it swallows any transport/query error to
 * `{ prompt: null, responses: [] }` so the presenter uniformly shows a waiting/
 * empty state (the view retains last-good content per Req 7.7/7.8, wired in
 * task 24.2). Returns `prompt = null` when the event has no readable prompt.
 *
 * @param eventId The event whose active prompt + visible responses to read.
 * @returns The active prompt (or `null`) and its visible responses.
 */
export async function readPresenterWordCloud(
  eventId: string,
): Promise<PresenterWordCloud> {
  const EMPTY: PresenterWordCloud = { prompt: null, responses: [] };
  if (!eventId) return EMPTY;

  // 1) Resolve the active prompt (RLS returns only open/closed on a live event).
  //    Prefer an OPEN prompt, then the most recent by created_at.
  const { data: promptRows, error: promptError } = await supabase
    .from('word_cloud_prompts')
    .select(PRESENTER_PROMPT_COLUMNS)
    .eq('event_id', eventId)
    // Defence-in-depth alongside RLS: never even ask for draft prompts.
    .in('status', PRESENTER_READABLE_PROMPT_STATUSES as unknown as string[])
    // 'open' sorts after 'closed' descending, so status desc surfaces the open
    // prompt first; created_at desc is a stable most-recent-first tie-break.
    .order('status', { ascending: false })
    .order('created_at', { ascending: false });

  if (promptError || !Array.isArray(promptRows)) return EMPTY;

  const prompt = promptRows.find(isPresenterReadablePrompt);
  if (!prompt) return EMPTY;

  // 2) Read that prompt's VISIBLE responses only (is_hidden = false). RLS also
  //    excludes hidden rows; we filter explicitly as belt-and-braces (Req 6.13).
  //    Only normalised_text + is_hidden are projected — never participant data.
  const { data: responseRows, error: responseError } = await supabase
    .from('word_cloud_responses')
    .select(PRESENTER_WC_RESPONSE_COLUMNS)
    .eq('prompt_id', prompt.id)
    .eq('is_hidden', false);

  if (responseError || !Array.isArray(responseRows)) {
    // Prompt readable but responses not → render an empty cloud, not a failure.
    return { prompt, responses: [] };
  }

  return {
    prompt,
    responses: responseRows.filter(isPresenterWordCloudResponse),
  };
}
