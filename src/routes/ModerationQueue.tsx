import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { useParams } from 'react-router-dom';
import {
  filterModerationQuestions,
  moderateQuestion,
  ModerationError,
  MODERATION_ACTIONS,
  MODERATION_QUESTION_STATUSES,
  readModerationQuestions,
  type ModerationAction,
  type ModerationQuestion,
  type ModerationQuestionStatus,
} from '../lib/moderation';

/**
 * `/admin/events/:id/moderation` — the admin moderation queue (Task 16.2).
 *
 * Lists EVERY question for an event — including `pending` and `hidden` rows the
 * audience never sees — read through the AUTHENTICATED admin session
 * ({@link readModerationQuestions}; Req 3.11). The moderator can narrow the
 * queue with three combinable filters (status + AI-category + case-insensitive
 * search text — ALL selected criteria are AND-combined via the pure
 * {@link filterModerationQuestions} helper) and apply one of four moderation
 * actions per question (approve / feature / answer / hide) via the authenticated
 * `moderate-question` Edge Function ({@link moderateQuestion}; Req 3.12). After a
 * successful action the queue is re-read so the row reflects its new status.
 *
 * Four UX states (Design → Frontend Design → four UX states; Req 24.7):
 *  - loading: a polite `role="status"` progress indicator while the queue loads.
 *  - empty: a clear "no questions" message when the event has none (or none
 *    match the active filters).
 *  - list: the filtered queue with per-row status label + action buttons.
 *  - error: a `role="alert"` message with a retry affordance when the load fails.
 *
 * Accessibility & mobile-first (Design → Mobile-first & accessibility approach;
 * Req 24.5, 25.4):
 *  - every filter control has a programmatically associated `<label>` (htmlFor/id);
 *  - the loading/empty states use `role="status"`, errors use `role="alert"`;
 *  - action buttons meet the ≥44×44px touch target (`.touch-target`) and are
 *    keyboard-navigable with the global `:focus-visible` ring.
 *
 * PRIVACY: `participant_identifier` is NEVER read (the lib does not select it)
 * and NEVER rendered (Req 8.6, 24.8).
 *
 * Requirements traceability: 3.11, 3.12, 24.7, 25.4.
 * Design references: Frontend Design (Route map — `/admin/events/:id/moderation`);
 * Components (`ModerationQueue`).
 */

/** Resolution state of the queue load (Req 24.7 four UX states). */
type QueueStatus = 'loading' | 'ready' | 'error';

/** Human-readable label for each moderation action button. */
const ACTION_LABELS: Readonly<Record<ModerationAction, string>> = {
  approve: 'Approve',
  feature: 'Feature',
  answer: 'Mark answered',
  hide: 'Hide',
};

/** Human-readable label for each question status (shown on every row). */
const STATUS_LABELS: Readonly<Record<ModerationQuestionStatus, string>> = {
  pending: 'Pending',
  approved: 'Approved',
  featured: 'Featured',
  answered: 'Answered',
  hidden: 'Hidden',
};

/** The action that would be a no-op for a question already in a given status. */
const STATUS_FOR_ACTION: Readonly<Record<ModerationAction, ModerationQuestionStatus>> =
  {
    approve: 'approved',
    feature: 'featured',
    answer: 'answered',
    hide: 'hidden',
  };

export function ModerationQueue(): JSX.Element {
  const { id: eventId } = useParams();

  // Stable ids so the filter labels associate with their controls (Req 24.5).
  const statusFilterId = useId();
  const categoryFilterId = useId();
  const searchFilterId = useId();

  const [status, setStatus] = useState<QueueStatus>('loading');
  const [questions, setQuestions] = useState<ModerationQuestion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filter controls. Empty string means "no filter" for each.
  const [statusFilter, setStatusFilter] = useState<'' | ModerationQuestionStatus>(
    '',
  );
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [searchText, setSearchText] = useState<string>('');

  // Per-question action progress + inline error (keyed by question id).
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadQueue = useCallback(async (): Promise<void> => {
    if (!eventId) {
      setStatus('error');
      setLoadError('No event was specified.');
      return;
    }
    setStatus('loading');
    setLoadError(null);
    try {
      const rows = await readModerationQuestions(eventId);
      setQuestions(rows);
      setStatus('ready');
    } catch (error) {
      const message =
        error instanceof ModerationError
          ? error.message
          : 'The moderation queue could not be loaded. Please try again.';
      setLoadError(message);
      setStatus('error');
    }
  }, [eventId]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // The distinct AI categories present in the queue, for the category select.
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const q of questions) {
      if (q.ai_category !== null && q.ai_category.trim() !== '') {
        set.add(q.ai_category);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [questions]);

  // Combined, case-insensitive filtering (Req 3.11, 3.12) via the pure helper.
  const visibleQuestions = useMemo(
    () =>
      filterModerationQuestions(questions, {
        status: statusFilter === '' ? undefined : statusFilter,
        category: categoryFilter === '' ? undefined : categoryFilter,
        searchText,
      }),
    [questions, statusFilter, categoryFilter, searchText],
  );

  async function handleAction(
    questionId: string,
    action: ModerationAction,
  ): Promise<void> {
    if (pendingActionId) return;
    setPendingActionId(questionId);
    setActionError(null);
    try {
      await moderateQuestion({ questionId, action });
      // Re-read so the row reflects its new status (and any concurrent changes).
      await loadQueue();
    } catch (error) {
      const message =
        error instanceof ModerationError
          ? error.message
          : 'The question could not be moderated. Please try again.';
      setActionError(message);
    } finally {
      setPendingActionId(null);
    }
  }

  const hasAnyQuestions = questions.length > 0;
  const hasVisibleQuestions = visibleQuestions.length > 0;

  return (
    <main className="app-container py-8">
      <h1 className="text-2xl font-semibold text-ink">Moderation queue</h1>
      <p className="mt-2 text-ink-muted">
        Review submitted questions — including pending and hidden ones — and
        approve, feature, mark answered, or hide them.
      </p>

      {/* Filter controls — combined (AND), case-insensitive search (Req 3.11). */}
      <section
        aria-label="Filter questions"
        className="mt-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={statusFilterId} className="font-medium text-ink">
            Status
          </label>
          <select
            id={statusFilterId}
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as '' | ModerationQuestionStatus)
            }
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          >
            <option value="">All statuses</option>
            {MODERATION_QUESTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={categoryFilterId} className="font-medium text-ink">
            AI category
          </label>
          <select
            id={categoryFilterId}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            disabled={availableCategories.length === 0}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink disabled:opacity-60"
          >
            <option value="">All categories</option>
            {availableCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={searchFilterId} className="font-medium text-ink">
            Search text
          </label>
          <input
            id={searchFilterId}
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder="Find in question text…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
        </div>
      </section>

      {/* An action-level error (e.g. session expiry) surfaced separately. */}
      {actionError ? (
        <p role="alert" className="mt-4 text-ink">
          {actionError}
        </p>
      ) : null}

      {/* LOADING state (Req 24.7). */}
      {status === 'loading' ? (
        <p role="status" aria-live="polite" className="mt-6 text-ink-muted">
          Loading the moderation queue…
        </p>
      ) : null}

      {/* ERROR state (Req 24.7) with retry. */}
      {status === 'error' ? (
        <div className="mt-6 flex flex-col gap-3">
          <p role="alert" className="text-ink">
            {loadError ?? 'The moderation queue could not be loaded.'}
          </p>
          <button
            type="button"
            onClick={() => void loadQueue()}
            className="touch-target self-start rounded bg-focus px-4 py-2 font-medium text-surface"
          >
            Try again
          </button>
        </div>
      ) : null}

      {/* READY — EMPTY state (Req 24.7): no questions at all, or none match. */}
      {status === 'ready' && !hasVisibleQuestions ? (
        <p role="status" className="mt-6 text-ink-muted">
          {hasAnyQuestions
            ? 'No questions match the current filters.'
            : 'No questions have been submitted for this event yet.'}
        </p>
      ) : null}

      {/* READY — LIST state (Req 24.7). */}
      {status === 'ready' && hasVisibleQuestions ? (
        <ul className="mt-6 flex flex-col gap-4">
          {visibleQuestions.map((q) => {
            const isRowBusy = pendingActionId === q.id;
            return (
              <li
                key={q.id}
                className="flex flex-col gap-3 rounded border border-ink-muted p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-surface px-2 py-1 text-sm font-medium text-ink ring-1 ring-ink-muted">
                    {STATUS_LABELS[q.status]}
                  </span>
                  {q.ai_category ? (
                    <span className="rounded bg-surface px-2 py-1 text-sm text-ink-muted ring-1 ring-ink-muted">
                      {q.ai_category}
                    </span>
                  ) : null}
                  <span className="text-sm text-ink-muted">
                    {q.vote_count} vote{q.vote_count === 1 ? '' : 's'}
                  </span>
                </div>

                <p className="whitespace-pre-wrap break-words text-ink">
                  {q.text}
                </p>

                <div className="flex flex-wrap gap-2">
                  {MODERATION_ACTIONS.map((action) => {
                    const isNoOp = q.status === STATUS_FOR_ACTION[action];
                    return (
                      <button
                        key={action}
                        type="button"
                        disabled={isRowBusy || isNoOp}
                        aria-busy={isRowBusy || undefined}
                        onClick={() => void handleAction(q.id, action)}
                        className="touch-target rounded border border-ink-muted px-3 py-2 font-medium text-ink disabled:opacity-60"
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    );
                  })}
                </div>

                {isRowBusy ? (
                  <span
                    role="status"
                    aria-live="polite"
                    className="text-sm text-ink-muted"
                  >
                    Applying…
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </main>
  );
}

export default ModerationQueue;
