import { useCallback, useEffect, useId, useMemo, useState } from 'react';
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
import {
  AiClientError,
  overrideQuestionCategory,
  runCategorisation,
} from '../lib/aiClient';
import { AI_QUESTION_CATEGORIES, type AiCategory } from '../schemas/ai';
import { cx, FOCUS_RING, statusIndicator } from '../lib/a11y';
// Req 24.6: no JS-driven animation in this component; the global CSS
// `@media (prefers-reduced-motion: reduce)` rule in index.css covers all CSS
// transitions. No JS animation guard is needed here.
// Req 24.8: `participant_identifier` is never selected nor rendered by the
// moderation helpers; only question text, status, vote count, and AI category
// flow through this component.

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
 * AI categorisation (Task 34.2):
 *  - an event-level "Categorise questions" action triggers the categorisation
 *    JOB via the AI Gateway ({@link runCategorisation}); on success the queue is
 *    re-read so newly-assigned categories appear. A busy `role="status"`
 *    indicator and a sanitised error/degraded notice are shown (Req 24.7).
 *  - a per-row moderator OVERRIDE control ({@link overrideQuestionCategory})
 *    lets an admin set a question's AI category. The `<select>` is CONSTRAINED
 *    to the eight allowed categories ({@link AI_QUESTION_CATEGORIES}) plus a
 *    "No change" option, so an invalid category can never be chosen client-side.
 *    Server-side the override records the prior category into `ai_prior_category`
 *    (Req 15.7) and RETAINS the prior assignment on an invalid value (Req 15.8).
 *
 * PRIVACY: `participant_identifier` is NEVER read (the lib does not select it)
 * and NEVER rendered (Req 8.6, 24.8).
 *
 * Requirements traceability: 3.11, 3.12, 15.7, 15.8, 24.7, 25.4.
 * Design references: Frontend Design (Route map — `/admin/events/:id/moderation`);
 * Components (`ModerationQueue`); Server-Side AI Gateway Design (AI features —
 * Categorisation).
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

/**
 * Maps each question status to a non-colour indicator icon (Req 24.4). These
 * icons augment the text label so status is never conveyed by colour alone.
 */
const STATUS_ICONS: Readonly<Record<ModerationQuestionStatus, string>> = {
  pending: statusIndicator('info').icon, // ℹ — awaiting review
  approved: statusIndicator('success').icon, // ✓ — visible to audience
  featured: statusIndicator('success').icon, // ✓ — prominently shown
  answered: statusIndicator('success').icon, // ✓ — answered
  hidden: statusIndicator('warning').icon, // ⚠ — not visible
};

/** The action that would be a no-op for a question already in a given status. */
const STATUS_FOR_ACTION: Readonly<
  Record<ModerationAction, ModerationQuestionStatus>
> = {
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
  const overrideSelectBaseId = useId();

  const [status, setStatus] = useState<QueueStatus>('loading');
  const [questions, setQuestions] = useState<ModerationQuestion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filter controls. Empty string means "no filter" for each.
  const [statusFilter, setStatusFilter] = useState<
    '' | ModerationQuestionStatus
  >('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [searchText, setSearchText] = useState<string>('');

  // Per-question action progress + inline error (keyed by question id).
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Per-question override selection ('' = "no change"), keyed by question id.
  const [overrideSelection, setOverrideSelection] = useState<
    Record<string, '' | AiCategory>
  >({});
  // The question whose override write is currently in flight (one at a time).
  const [pendingOverrideId, setPendingOverrideId] = useState<string | null>(
    null,
  );
  const [overrideError, setOverrideError] = useState<string | null>(null);

  // Event-level "Categorise questions" job progress + result/error.
  const [categoriseBusy, setCategoriseBusy] = useState(false);
  const [categoriseNotice, setCategoriseNotice] = useState<string | null>(null);
  const [categoriseError, setCategoriseError] = useState<string | null>(null);

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

  /**
   * Applies a MODERATOR OVERRIDE of a question's AI category (Req 15.7, 15.8).
   * The selection is constrained to the eight allowed categories by the
   * `<select>` options, so an invalid category can never be chosen here; the
   * server ADDITIONALLY records the prior category into `ai_prior_category`
   * (Req 15.7) and RETAINS the prior assignment on an invalid value (Req 15.8).
   * On success the queue is re-read so the row reflects the new category.
   */
  async function handleOverride(questionId: string): Promise<void> {
    if (pendingOverrideId || categoriseBusy) return;
    const selected = overrideSelection[questionId];
    // "No change" selected — nothing to apply.
    if (!selected) return;

    setPendingOverrideId(questionId);
    setOverrideError(null);
    try {
      await overrideQuestionCategory({
        questionId,
        category: selected,
        ...(eventId ? { eventId } : {}),
      });
      // Reset this row's selection back to "no change" and re-read the queue so
      // the row shows its new AI category (and any concurrent changes).
      setOverrideSelection((prev) => ({ ...prev, [questionId]: '' }));
      await loadQueue();
    } catch (error) {
      const message =
        error instanceof AiClientError
          ? error.kind === 'not_implemented'
            ? 'Overriding a category is not available yet.'
            : error.message
          : 'The category could not be updated. Please try again.';
      setOverrideError(message);
    } finally {
      setPendingOverrideId(null);
    }
  }

  /**
   * Triggers the AI categorisation JOB for the event via the Gateway (task
   * 30.1) and, on success, re-reads the queue so newly-assigned categories
   * appear. AI being unavailable/degraded is a normal, non-error state that the
   * core moderation flow is unaffected by (Req 19.1, 24.7).
   */
  async function handleCategorise(): Promise<void> {
    if (!eventId || categoriseBusy || pendingOverrideId || pendingActionId) {
      return;
    }
    setCategoriseBusy(true);
    setCategoriseNotice(null);
    setCategoriseError(null);
    try {
      const response = await runCategorisation(eventId);
      if (!response.available) {
        // Degraded — AI disabled / not configured / credential required.
        setCategoriseNotice(response.unavailable.message);
        return;
      }
      const { categorised_count, candidate_count } = response.summary;
      setCategoriseNotice(
        candidate_count === 0
          ? 'There were no questions to categorise.'
          : `Categorised ${categorised_count} of ${candidate_count} question${candidate_count === 1 ? '' : 's'}.`,
      );
      await loadQueue();
    } catch (error) {
      const message =
        error instanceof AiClientError
          ? error.message
          : 'Categorising the questions could not be completed. Please try again.';
      setCategoriseError(message);
    } finally {
      setCategoriseBusy(false);
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
            className={cx(
              'touch-target rounded border border-ink-muted px-3 py-2 text-ink',
              FOCUS_RING,
            )}
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
            className={cx(
              'touch-target rounded border border-ink-muted px-3 py-2 text-ink disabled:opacity-60',
              FOCUS_RING,
            )}
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
            className={cx(
              'touch-target rounded border border-ink-muted px-3 py-2 text-ink',
              FOCUS_RING,
            )}
          />
        </div>

        {/* Event-level AI categorisation action (Req 15.1, 24.7). */}
        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={
              categoriseBusy ||
              pendingOverrideId !== null ||
              pendingActionId !== null ||
              !eventId
            }
            aria-busy={categoriseBusy || undefined}
            onClick={() => void handleCategorise()}
            className={cx(
              'touch-target self-start rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60',
              FOCUS_RING,
            )}
          >
            Categorise questions
          </button>
        </div>
      </section>

      {/* Categorisation busy indicator + result/error (Req 24.7). */}
      {categoriseBusy ? (
        <p role="status" aria-live="polite" className="mt-4 text-ink-muted">
          Categorising the questions…
        </p>
      ) : null}
      {categoriseNotice && !categoriseBusy ? (
        <p role="status" aria-live="polite" className="mt-4 text-ink">
          {categoriseNotice}
        </p>
      ) : null}
      {categoriseError ? (
        <p role="alert" className="mt-4 text-ink">
          {categoriseError}
        </p>
      ) : null}

      {/* An override-level error surfaced separately (Req 15.7, 15.8). */}
      {overrideError ? (
        <p role="alert" className="mt-4 text-ink">
          {overrideError}
        </p>
      ) : null}

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
            className={cx(
              'touch-target self-start rounded bg-focus px-4 py-2 font-medium text-surface',
              FOCUS_RING,
            )}
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
                  {/* Status badge: text label + non-colour icon (Req 24.4). */}
                  <span className="rounded bg-surface px-2 py-1 text-sm font-medium text-ink ring-1 ring-ink-muted">
                    <span aria-hidden="true">{STATUS_ICONS[q.status]} </span>
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
                        className={cx(
                          'touch-target rounded border border-ink-muted px-3 py-2 font-medium text-ink disabled:opacity-60',
                          FOCUS_RING,
                        )}
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

                {/* Moderator category OVERRIDE — constrained to the 8 allowed
                    categories so an invalid category cannot be chosen; the
                    server records the prior category (Req 15.7) and retains it
                    on an invalid selection (Req 15.8). */}
                {(() => {
                  const overrideSelectId = `${overrideSelectBaseId}-${q.id}`;
                  const selected = overrideSelection[q.id] ?? '';
                  const isOverrideBusy = pendingOverrideId === q.id;
                  return (
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-end">
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={overrideSelectId}
                          className="text-sm font-medium text-ink"
                        >
                          Override AI category
                        </label>
                        <select
                          id={overrideSelectId}
                          value={selected}
                          disabled={isOverrideBusy || categoriseBusy}
                          onChange={(e) =>
                            setOverrideSelection((prev) => ({
                              ...prev,
                              [q.id]: e.target.value as '' | AiCategory,
                            }))
                          }
                          className={cx(
                            'touch-target rounded border border-ink-muted px-3 py-2 text-ink disabled:opacity-60',
                            FOCUS_RING,
                          )}
                        >
                          <option value="">No change</option>
                          {AI_QUESTION_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        disabled={
                          selected === '' || isOverrideBusy || categoriseBusy
                        }
                        aria-busy={isOverrideBusy || undefined}
                        onClick={() => void handleOverride(q.id)}
                        className={cx(
                          'touch-target self-start rounded border border-ink-muted px-3 py-2 font-medium text-ink disabled:opacity-60',
                          FOCUS_RING,
                        )}
                      >
                        Apply category
                      </button>
                      {isOverrideBusy ? (
                        <span
                          role="status"
                          aria-live="polite"
                          className="text-sm text-ink-muted"
                        >
                          Updating category…
                        </span>
                      ) : null}
                    </div>
                  );
                })()}
              </li>
            );
          })}
        </ul>
      ) : null}
    </main>
  );
}

export default ModerationQueue;
