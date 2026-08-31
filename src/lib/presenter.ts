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
 * @returns an unsubscribe function that removes the channel.
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

  return () => {
    void supabase.removeChannel(channel);
  };
}
