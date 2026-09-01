/**
 * `QuestionListAndVoting` — audience question list + upvoting (Task 15.2).
 *
 * A mobile-first, accessible component that lists the `approved`/`featured`
 * questions for a LIVE event and lets a Participant upvote (or remove their
 * upvote on) each one. It delegates the authoritative reads/writes to the
 * `../lib/questions` client helpers:
 *   - {@link readAudienceQuestions} — the RLS-gated anon read (never selects
 *     `participant_identifier`).
 *   - {@link castQuestionVote} / {@link removeQuestionVote} — the atomic,
 *     rate-limited `SECURITY DEFINER` vote RPCs (task 13.3) that enforce the
 *     one-active-vote-per-participant-per-question rule.
 *
 * Sort control (task 15.2): a `<select>` toggles between "Most votes" (default,
 * `vote_count` desc) and "Most recent" (`created_at` desc). Changing it re-reads
 * the list in the chosen order.
 *
 * Upvote toggle: each question has a single button that reflects whether THIS
 * participant has voted on it. Tapping it optimistically toggles the local
 * "voted" state and the displayed count, then calls the cast/remove RPC; on a
 * server rejection the optimistic change is rolled back and a sanitised message
 * is announced. The single-active-vote rule is enforced authoritatively by the
 * DB unique constraint — the local `votedIds` set is UX only.
 *
 * Four UX states (Req 24.7):
 *  - **loading**: a polite progress indicator while the initial/sort read runs.
 *  - **empty**: a friendly "no questions yet" message when the list is empty.
 *  - **list**: the ordered questions with per-question vote controls.
 *  - **error**: a sanitised message (announced via `role="alert"`) when the
 *    read fails, with a retry affordance.
 *
 * Accessibility (Req 24.5): the sort control has an associated `<label>`; each
 * vote button exposes a descriptive accessible name and `aria-pressed` state,
 * meets the ≥44×44px touch target (`.touch-target`), and vote feedback is
 * announced via an `aria-live` status region. Mirrors the conventions in
 * {@link QuestionSubmissionForm}.
 *
 * Security note: UI gating is defence-in-depth only; the server (RLS +
 * `SECURITY DEFINER` vote RPCs with rate limiting) is the authoritative
 * enforcement point. The participant identifier is opaque and is NEVER rendered
 * (Req 8.6, 24.8) — this component never receives, stores, or displays it.
 *
 * Requirements traceability: 3.9, 3.11, 4.1, 4.5, 8.6.
 * Design references: Components (`QuestionListAndVoting`); Request/data flows
 * (Voting with realtime propagation).
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { cx, FOCUS_RING } from '../lib/a11y';
import {
  readAudienceQuestions,
  castQuestionVote,
  removeQuestionVote,
  QuestionError,
  DEFAULT_QUESTION_SORT,
  type AudienceQuestion,
  type QuestionSort,
} from '../lib/questions';

/** The list's load state driving the four UX states (Req 24.7). */
type ListState = 'loading' | 'empty' | 'list' | 'error';

export interface QuestionListAndVotingProps {
  /** The id of the (live) event whose questions to list and vote on. */
  readonly eventId: string;
  /**
   * Optional monotonically-increasing signal (task 15.3). When it changes, the
   * list re-reads itself in the current sort order. The audience event view
   * increments this on each realtime question/vote update so the displayed list
   * and counts stay current within the 2-second target (Req 23.1, 4.7) without
   * this component needing a direct realtime/Supabase dependency. Omitting it
   * (the default) preserves the original mount-and-sort-only behaviour.
   */
  readonly refreshSignal?: number;
}

/** The selectable sort options and their user-facing labels (task 15.2). */
const SORT_OPTIONS: readonly { value: QuestionSort; label: string }[] = [
  { value: 'most_votes', label: 'Most votes' },
  { value: 'most_recent', label: 'Most recent' },
];

/**
 * Maps a caught error to a sanitised, user-facing message. Known
 * {@link QuestionError}s already carry a safe message; anything else falls back
 * to a neutral message that never leaks internals (Req 24.7).
 */
function toDisplayMessage(error: unknown): string {
  if (error instanceof QuestionError) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

export function QuestionListAndVoting({
  eventId,
  refreshSignal = 0,
}: QuestionListAndVotingProps): JSX.Element {
  const sortLabelId = useId();
  const statusId = useId();

  const [state, setState] = useState<ListState>('loading');
  const [questions, setQuestions] = useState<AudienceQuestion[]>([]);
  const [sort, setSort] = useState<QuestionSort>(DEFAULT_QUESTION_SORT);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Which questions THIS participant has an active vote on (UX state only; the
  // DB unique constraint is the authoritative one-active-vote rule).
  const [votedIds, setVotedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Questions with an in-flight vote toggle, so the button can disable + busy.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // A transient, sanitised message announced after a vote action (Req 24.7).
  const [voteMessage, setVoteMessage] = useState<string | null>(null);

  /** Loads (or reloads) the list in the current sort order (Req 3.9, 3.11). */
  const load = useCallback(
    async (currentSort: QuestionSort): Promise<void> => {
      if (!eventId) {
        setQuestions([]);
        setState('empty');
        return;
      }
      setState('loading');
      setErrorMessage(null);
      try {
        const list = await readAudienceQuestions(eventId, currentSort);
        setQuestions(list);
        setState(list.length === 0 ? 'empty' : 'list');
      } catch (error) {
        setErrorMessage(toDisplayMessage(error));
        setState('error');
      }
    },
    [eventId],
  );

  // Initial load + reload whenever the event, the chosen sort, or the external
  // `refreshSignal` (task 15.3 realtime nudge) changes. `refreshSignal` is
  // intentionally a dependency so a realtime question/vote update re-reads the
  // list; when the prop is omitted it defaults to 0 and never changes, so the
  // original mount-and-sort-only behaviour is preserved.
  useEffect(() => {
    void load(sort);
  }, [load, sort, refreshSignal]);

  const addTo = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    next.add(id);
    return next;
  };
  const removeFrom = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    next.delete(id);
    return next;
  };

  /**
   * Toggles the participant's upvote on a question. Optimistically flips the
   * local voted state + count, calls the cast/remove RPC, and rolls back on a
   * server rejection (announcing a sanitised message). The server + DB unique
   * constraint remain authoritative (Req 4.1, 4.5).
   */
  const handleToggleVote = useCallback(
    async (question: AudienceQuestion): Promise<void> => {
      const id = question.id;
      if (pendingIds.has(id)) return; // ignore re-taps while in flight

      const currentlyVoted = votedIds.has(id);
      setPendingIds((prev) => addTo(prev, id));
      setVoteMessage(null);

      // Optimistic update: toggle voted set + nudge the displayed count.
      setVotedIds((prev) =>
        currentlyVoted ? removeFrom(prev, id) : addTo(prev, id),
      );
      setQuestions((prev) =>
        prev.map((q) =>
          q.id === id
            ? {
                ...q,
                vote_count: Math.max(
                  0,
                  q.vote_count + (currentlyVoted ? -1 : 1),
                ),
              }
            : q,
        ),
      );

      try {
        const newCount = currentlyVoted
          ? await removeQuestionVote(id)
          : await castQuestionVote(id);
        // Reconcile with the authoritative server count.
        setQuestions((prev) =>
          prev.map((q) => (q.id === id ? { ...q, vote_count: newCount } : q)),
        );
        setVoteMessage(
          currentlyVoted ? 'Your vote was removed.' : 'Your vote was recorded.',
        );
      } catch (error) {
        // Roll back the optimistic changes on rejection.
        setVotedIds((prev) =>
          currentlyVoted ? addTo(prev, id) : removeFrom(prev, id),
        );
        setQuestions((prev) =>
          prev.map((q) =>
            q.id === id
              ? {
                  ...q,
                  vote_count: Math.max(
                    0,
                    q.vote_count + (currentlyVoted ? 1 : -1),
                  ),
                }
              : q,
          ),
        );
        setVoteMessage(toDisplayMessage(error));
      } finally {
        setPendingIds((prev) => removeFrom(prev, id));
      }
    },
    [pendingIds, votedIds],
  );

  const sortSelect = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <label
          id={sortLabelId}
          htmlFor={`${sortLabelId}-select`}
          className="font-medium text-ink"
        >
          Sort questions
        </label>
        <select
          id={`${sortLabelId}-select`}
          value={sort}
          onChange={(event) => setSort(event.target.value as QuestionSort)}
          className={cx(
            'touch-target rounded border border-ink-muted px-3 py-2 text-ink',
            FOCUS_RING,
          )}
          data-testid="question-sort"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    ),
    [sort, sortLabelId],
  );

  return (
    <section
      aria-label="Questions and voting"
      className="flex flex-col gap-4"
      data-testid="question-list-and-voting"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">
          Questions from the audience
        </h3>
        {sortSelect}
      </div>

      {/* Transient vote feedback announced to AT (Req 24.5, 24.7). */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className="text-sm text-ink-muted"
      >
        {voteMessage}
      </p>

      {/* Loading state (Req 24.7). */}
      {state === 'loading' ? (
        <p role="status" aria-live="polite" className="text-ink-muted">
          Loading questions…
        </p>
      ) : null}

      {/* Error state (Req 24.7): sanitised message + retry. */}
      {state === 'error' ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-ink">
            {errorMessage ?? 'The questions could not be loaded.'}
          </p>
          <button
            type="button"
            onClick={() => {
              void load(sort);
            }}
            className={cx(
              'touch-target self-start rounded border border-ink-muted px-4 py-2 font-medium text-ink',
              FOCUS_RING,
            )}
          >
            Try again
          </button>
        </div>
      ) : null}

      {/* Empty state (Req 24.7). */}
      {state === 'empty' ? (
        <p className="text-ink-muted" data-testid="question-list-empty">
          No questions yet. Be the first to ask one!
        </p>
      ) : null}

      {/* List state (Req 3.9, 3.11, 4.1). */}
      {state === 'list' ? (
        <ul className="flex flex-col gap-3" data-testid="question-list">
          {questions.map((question) => {
            const voted = votedIds.has(question.id);
            const pending = pendingIds.has(question.id);
            return (
              <li
                key={question.id}
                className="flex items-start gap-3 rounded-lg border border-ink-muted/40 p-3"
              >
                <button
                  type="button"
                  onClick={() => {
                    void handleToggleVote(question);
                  }}
                  disabled={pending}
                  aria-pressed={voted}
                  aria-busy={pending}
                  aria-label={
                    voted
                      ? `Remove your upvote. ${question.vote_count} votes.`
                      : `Upvote this question. ${question.vote_count} votes.`
                  }
                  className={cx(
                    'touch-target flex min-w-[3.5rem] flex-col items-center rounded px-3 py-2 font-medium disabled:opacity-60',
                    voted
                      ? 'bg-focus text-surface'
                      : 'border border-ink-muted text-ink',
                    FOCUS_RING,
                  )}
                >
                  <span aria-hidden="true">▲</span>
                  <span data-testid="vote-count">{question.vote_count}</span>
                </button>
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                  {question.text}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
