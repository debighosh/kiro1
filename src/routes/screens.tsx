import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AdminAuthError,
  ensureAdminProfile,
  signInWithPassword,
} from '../lib/auth';
import { findEventByRef, type PublicEvent } from '../lib/eventLookup';
import { isParticipationEligible } from '../lib/participationGate';
import { getParticipantIdentifier } from '../lib/participant';
import {
  isPresenterMode,
  readFeaturedQuestion,
  readPresenterActivePoll,
  readPresenterQuestions,
  readPresenterWordCloud,
  subscribeToPresenter,
  type PresenterActivePoll,
  type PresenterMode,
  type PresenterPollResultsPayload,
  type PresenterQuestion,
  type PresenterWordCloudPayload,
} from '../lib/presenter';
import {
  aggregateWordCloud,
  sizeForFrequency,
  DEFAULT_MIN_SIZE,
  DEFAULT_MAX_SIZE,
  type WordCloudTerm,
} from '../lib/wordcloud';
import { runThemeInsights } from '../lib/aiClient';
import type { AiThemeInsightsResult } from '../schemas/ai';
import { EventJoinCard } from '../components/EventJoinCard';
import { QrDisplay } from '../components/QrDisplay';
import { QuestionSubmissionForm } from '../components/QuestionSubmissionForm';
import { QuestionListAndVoting } from '../components/QuestionListAndVoting';
import { PollCard } from '../components/PollCard';
import { WordCloudCard } from '../components/WordCloudCard';
import { ConnectionStatusIndicator } from '../components/ConnectionStatusIndicator';
import { useRealtimeChannel } from '../hooks/useRealtimeChannel';
import { cx, FOCUS_RING } from '../lib/a11y';
/*
 * Req 24.6 — reduced motion: no JS-driven animation is used in any screen in
 * this file. All CSS transitions and animations are covered by the global
 * `@media (prefers-reduced-motion: reduce)` rule in `src/index.css`, which
 * unconditionally disables them when the user has requested reduced motion.
 * Screens that would add JS-controlled animation (e.g. recharts or a
 * third-party word-cloud library) MUST import `usePrefersReducedMotion` from
 * `../hooks/usePrefersReducedMotion` and guard each animation prop.
 *
 * Req 24.8 — no `participant_identifier` in DOM: `getParticipantIdentifier()`
 * is called for its side effect only; the return value is intentionally
 * discarded in EventView so the identifier can never reach the UI.
 */

/**
 * Minimal placeholder screens for the Milestone 1 routing skeleton (task 1.3).
 *
 * Each screen renders only a heading naming the screen (and echoes the route
 * param where relevant) so routes resolve and are verifiable. No feature logic
 * lives here — Q&A, polls, word cloud, auth, event editor forms, QR, etc. are
 * implemented in later tasks (3.x–8.x).
 *
 * Requirements traceability: 25.1 (audience join + event-view routes),
 * 25.4 (admin routes), 25.5 (presenter view route).
 */

/**
 * `/` — public landing (task 14.3).
 *
 * Presents the accessible Event_Code entry form (via {@link EventJoinCard} in
 * `code-entry` mode). Submitting a known/live code navigates to
 * `/join/:eventRef`; an unknown code shows the invalid-code error and keeps the
 * participant here (Req 2.1, 2.2). The card owns its own resolution + four UX
 * states, so this screen is a thin, mobile-first `.app-container` wrapper.
 *
 * Requirements traceability: 2.1, 2.2, 24.5, 24.7.
 * Design: Frontend Design (Route map — `/`); Request/data flows (Audience join).
 */
export function PublicLanding(): JSX.Element {
  return (
    <div className="app-container flex flex-col gap-6 py-8">
      <header>
        <h1 className="text-2xl font-semibold text-ink">MSS LivePulse</h1>
        <p className="mt-2 text-ink-muted">
          Join a live event to ask questions, vote, and take part.
        </p>
      </header>
      <EventJoinCard mode="code-entry" />
    </div>
  );
}

/** Resolution state of the join-screen event lookup (Req 24.7 four UX states). */
type JoinResolveStatus = 'loading' | 'found' | 'not-found';

/**
 * `/join/:eventRef` — audience join screen (task 14.3).
 *
 * Resolves the event referenced by `:eventRef` (a slug or id) via the anon
 * Supabase client ({@link findEventByRef}) and renders the {@link EventJoinCard}
 * in `join-card` mode: the event name + status plus an "Enter event" CTA to the
 * event view (`/e/:eventRef`, task 14.4). Because anon reads are RLS-gated to
 * live events, a missing/non-live/unknown ref resolves to `null` and the card
 * shows a friendly not-found/unavailable state (Req 2.2, 1.9).
 *
 * Four UX states (Req 24.7): loading (a polite progress indicator while the
 * lookup is in flight), success (the resolved join card), and error/not-found
 * (the unavailable card). There is no user-triggered error branch here beyond
 * not-found; a transport failure also lands on not-found (see `findEventByRef`).
 *
 * Requirements traceability: 2.1, 2.2, 24.5, 24.7.
 * Design: Frontend Design (Route map — `/join/:eventRef`); Request/data flows
 * (Audience join).
 */
export function JoinScreen(): JSX.Element {
  const { eventRef } = useParams();

  const [status, setStatus] = useState<JoinResolveStatus>('loading');
  const [event, setEvent] = useState<PublicEvent | null>(null);

  useEffect(() => {
    // Guard against a state update after unmount / a superseded ref change.
    let active = true;
    setStatus('loading');
    setEvent(null);

    void (async () => {
      const resolved = await findEventByRef(eventRef);
      if (!active) return;
      if (resolved) {
        setEvent(resolved);
        setStatus('found');
      } else {
        setStatus('not-found');
      }
    })();

    return () => {
      active = false;
    };
  }, [eventRef]);

  return (
    <div className="app-container flex flex-col gap-6 py-8">
      <h1 className="text-2xl font-semibold text-ink">Join event</h1>

      {status === 'loading' ? (
        <p role="status" aria-live="polite" className="text-ink-muted">
          Looking up that event…
        </p>
      ) : (
        <EventJoinCard mode="join-card" event={event} eventRef={eventRef} />
      )}
    </div>
  );
}

/** Resolution state of the event-view lookup (Req 24.7 four UX states). */
type EventViewStatus = 'loading' | 'found' | 'not-found';

/**
 * Human-readable, NON-COLOUR-ONLY label for each event status shown in the
 * event view (Req 24.4/2.6 — status conveyed as text, not colour alone).
 */
const EVENT_STATUS_LABEL: Record<PublicEvent['status'], string> = {
  draft: 'Not started',
  live: 'Live',
  ended: 'Ended',
  archived: 'Archived',
};

/**
 * The three audience interaction views the event exposes (Req 2.6). Each hosts
 * a real UI for a live/eligible event: the Q&A section (tasks 15.x), the poll
 * section ({@link PollCard}, tasks 23.1/23.2), and the word-cloud section
 * ({@link WordCloudCard}, tasks 23.3/23.4). The participant switches between
 * them via the accessible tablist.
 */
const INTERACTION_VIEWS = [
  { key: 'qa', label: 'Q&A', suffix: 'qa' },
  { key: 'poll', label: 'Poll', suffix: 'poll' },
  { key: 'cloud', label: 'Word cloud', suffix: 'cloud' },
] as const;

type InteractionKey = (typeof INTERACTION_VIEWS)[number]['key'];

/**
 * The live audience Q&A section (tasks 15.1–15.3). Rendered ONLY for a
 * live/eligible event (the caller gates on participation eligibility, so this
 * never appears when the event is not live — participation gating is unchanged).
 *
 * It mounts the {@link QuestionSubmissionForm} and {@link QuestionListAndVoting}
 * widgets and wires the event-scoped realtime channel via
 * {@link useRealtimeChannel} (task 15.3): question/vote updates for THIS event
 * trigger a lightweight re-read of the list (via a monotonically-increasing
 * `refreshSignal` passed to {@link QuestionListAndVoting}, which owns its own
 * list state), and the connection's reconnect UX is surfaced by
 * {@link ConnectionStatusIndicator} (reconnecting indicator + enabled manual
 * refresh after a >3 s interruption; terminal error after the retry budget is
 * exhausted — Req 23.5–23.7).
 *
 * The subscription is scoped to `eventId` only — never the full dataset
 * (Req 23.2) — enforced inside `subscribeToEventQuestions`.
 *
 * Requirements traceability: 2.6, 23.1, 23.2, 23.5, 23.6, 23.7, 4.7.
 * Design: Frontend Design (Realtime subscription strategy & reconnect UX);
 * Components (`ConnectionStatusIndicator`).
 */
function LiveQaSection({ eventId }: { eventId: string }): JSX.Element {
  // A monotonically-increasing signal the list watches to re-read itself when a
  // realtime question/vote update arrives. Kept minimal: the list owns its own
  // state, so we only nudge it to refetch rather than pushing data into it.
  const [refreshSignal, setRefreshSignal] = useState(0);

  const bumpRefresh = useCallback(() => {
    setRefreshSignal((n) => n + 1);
  }, []);

  const { status, refresh } = useRealtimeChannel({
    eventId,
    // New/approved/updated questions for this event → re-read the list (Req 23.1).
    onQuestionsChange: bumpRefresh,
    // A vote-count Broadcast for this event → re-read so counts stay current
    // within the 2-second target under peak voting (Decision D9; Req 4.7).
    onVoteCount: bumpRefresh,
  });

  const handleRefresh = useCallback(() => {
    refresh();
    bumpRefresh();
  }, [refresh, bumpRefresh]);

  return (
    <div
      data-testid="qa-section"
      className="rounded-lg border border-ink-muted/40 p-4"
    >
      <h2 className="text-lg font-semibold text-ink">Questions</h2>
      <p className="mt-1 text-ink-muted">
        Ask a question or vote on questions from others.
      </p>

      {/* Reconnect UX (Req 23.5–23.7): a reconnecting indicator + enabled manual
          refresh after a >3 s interruption; a terminal error once retries stop.
          Hidden (sr-only status) while connected. */}
      <div className="mt-4">
        <ConnectionStatusIndicator status={status} onRefresh={handleRefresh} />
      </div>

      {/* MOUNT POINT (tasks 15.x): the audience Q&A widgets. The list re-reads
          itself when `refreshSignal` changes (driven by realtime updates). */}
      <div data-testid="qa-mount-point" className="mt-4 flex flex-col gap-6">
        <QuestionSubmissionForm eventId={eventId} />
        <QuestionListAndVoting
          eventId={eventId}
          refreshSignal={refreshSignal}
        />
      </div>
    </div>
  );
}

/**
 * `/e/:eventRef` — audience event view + participation gating (task 14.4).
 *
 * Resolves the referenced event via {@link findEventByRef} (loading / found /
 * not-found states, Req 24.7). When found and LIVE, it shows the event name,
 * the status as text (non-colour-only, Req 24.4), the current active
 * interaction, and navigation to the Q&A / poll / word-cloud views within the
 * 3-second target (Req 2.6) — no artificial delay. The Q&A section is the
 * active one for M2 and exposes a clearly-marked mount point that the real Q&A
 * widgets (tasks 15.x: `QuestionSubmissionForm` + `QuestionListAndVoting`) slot
 * into; the poll and word-cloud sections are "coming up" placeholders.
 *
 * Participation gating (Req 2.8, 1.9): the decision to render participation
 * controls is driven by {@link isParticipationEligible}. When the event is not
 * live (or is not resolvable at all — anonymous readers can only see live
 * events via RLS, so a non-live/unknown event surfaces as not-found), the
 * current status is shown and ALL participation controls are withheld — the
 * Q&A mount point is replaced with a status/closed notice and no submit/vote UI
 * is rendered.
 *
 * On entry the participant identifier is established via
 * {@link getParticipantIdentifier} so it exists for later submit/vote calls
 * (tasks 15.x). It is opaque and MUST NEVER be rendered (Req 8.6, 24.8) — it is
 * intentionally not placed in state or the DOM here.
 *
 * Accessibility (Req 24.5, 24.7): headings/labels, keyboard-navigable tab-style
 * navigation, status announced to assistive tech, mobile-first `.app-container`
 * and ≥44×44px touch targets. UI gating is defence-in-depth only; the server
 * (RLS + rate-limited RPCs) remains the authoritative enforcement point.
 *
 * Requirements traceability: 2.6, 2.8, 1.9, 8.6, 24.8, 24.7.
 * Design: Frontend Design (Route map — `/e/:eventRef`); Request/data flows
 * (Audience join).
 */
export function EventView(): JSX.Element {
  const { eventRef } = useParams();

  const [status, setStatus] = useState<EventViewStatus>('loading');
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [activeView, setActiveView] = useState<InteractionKey>('qa');

  // Establish the participant identifier on entry (Req 2.3/2.4/2.7) so it is
  // available for later submit/vote RPCs. It is opaque and NEVER rendered
  // (Req 8.6, 24.8): we deliberately do NOT store it in state or the DOM.
  useEffect(() => {
    try {
      // Side-effect only: seed/reuse the identifier in storage. The return
      // value is intentionally discarded so it can never reach the UI.
      getParticipantIdentifier();
    } catch {
      // Never block the view on identity establishment; later write actions
      // re-derive it and surface any failure at that point.
    }
  }, []);

  useEffect(() => {
    // Guard against a state update after unmount / a superseded ref change.
    let active = true;
    setStatus('loading');
    setEvent(null);
    setActiveView('qa');

    void (async () => {
      const resolved = await findEventByRef(eventRef);
      if (!active) return;
      if (resolved) {
        setEvent(resolved);
        setStatus('found');
      } else {
        setStatus('not-found');
      }
    })();

    return () => {
      active = false;
    };
  }, [eventRef]);

  // Loading state (Req 24.7).
  if (status === 'loading') {
    return (
      <div className="app-container flex flex-col gap-6 py-8">
        <h1 className="text-2xl font-semibold text-ink">Event</h1>
        <p role="status" aria-live="polite" className="text-ink-muted">
          Loading the event…
        </p>
      </div>
    );
  }

  // Not-found / unavailable state (Req 24.7, 1.9, 2.8). Anonymous readers can
  // only see live events (RLS), so an unknown OR non-live event lands here.
  // Participation controls are withheld entirely.
  if (status === 'not-found' || event === null) {
    return (
      <div className="app-container flex flex-col gap-6 py-8">
        <h1 className="text-2xl font-semibold text-ink">Event unavailable</h1>
        <section
          role="alert"
          className="rounded-lg border border-ink-muted/40 p-4"
        >
          <p className="text-ink">
            This event isn&rsquo;t available to join right now. It may not have
            started yet, may have ended, or the code may be incorrect.
          </p>
          <p className="mt-2 text-ink-muted">
            Participation is closed until the event is live.
          </p>
        </section>
      </div>
    );
  }

  const statusLabel = EVENT_STATUS_LABEL[event.status];
  const eligible = isParticipationEligible(event.status);
  const activeLabel =
    INTERACTION_VIEWS.find((view) => view.key === activeView)?.label ?? 'Q&A';

  return (
    <div className="app-container flex flex-col gap-6 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-ink">{event.name}</h1>
        {/* Status as TEXT (non-colour-only), announced to AT (Req 24.4, 2.6). */}
        <p className="text-ink-muted">
          Status:{' '}
          <span data-testid="event-status" className="font-medium text-ink">
            {statusLabel}
          </span>
        </p>
        {/* Current active interaction (Req 2.6). */}
        <p className="text-ink-muted">
          Now showing:{' '}
          <span
            data-testid="active-interaction"
            className="font-medium text-ink"
          >
            {activeLabel}
          </span>
        </p>
      </header>

      {/* Navigation to the Q&A / poll / word-cloud views (Req 2.6). Rendered as
          an accessible, keyboard-navigable tablist so a participant can switch
          the active interaction. */}
      <nav aria-label="Event views">
        <ul className="flex flex-wrap gap-2" role="tablist">
          {INTERACTION_VIEWS.map((view) => {
            const selected = view.key === activeView;
            return (
              <li key={view.key} role="presentation">
                <button
                  type="button"
                  role="tab"
                  id={`tab-${view.key}`}
                  aria-selected={selected}
                  aria-controls={`panel-${view.key}`}
                  onClick={() => setActiveView(view.key)}
                  className={cx(
                    'touch-target rounded px-4 py-2 font-medium',
                    selected
                      ? 'bg-focus text-surface'
                      : 'border border-ink-muted text-ink',
                    FOCUS_RING,
                  )}
                >
                  {view.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Participation area. When the event is not live, ALL participation
          controls are withheld and only the status/closed notice is shown
          (Req 2.8, 1.9). */}
      {eligible ? (
        <section
          id={`panel-${activeView}`}
          role="tabpanel"
          aria-labelledby={`tab-${activeView}`}
          data-testid="participation-area"
          className="flex flex-col gap-4"
        >
          {activeView === 'qa' ? (
            /* Q&A section container (Req 2.6). This is the clearly-marked mount
               point that tasks 15.x (`QuestionSubmissionForm` +
               `QuestionListAndVoting` + realtime) slot their real widgets into.
               Only rendered for a live/eligible event, preserving participation
               gating. */
            <LiveQaSection eventId={event.id} />
          ) : activeView === 'poll' ? (
            /* Poll section (Req 5.12, 23.2). `PollCard` owns its own
               read/response/results/realtime (tasks 23.1/23.2) and event/poll
               gating; it is only mounted here for a live/eligible event so
               participation gating is preserved. The `poll-section` testid is
               kept so existing EventView tab-switch tests still find it. */
            <div
              data-testid="poll-section"
              className="rounded-lg border border-ink-muted/40 p-4"
            >
              <h2 className="text-lg font-semibold text-ink">{activeLabel}</h2>
              <PollCard eventId={event.id} eventStatus={event.status} />
            </div>
          ) : (
            /* Word-cloud section (Req 6.15, 23.2). `WordCloudCard` owns its own
               read/response/visualisation/realtime (tasks 23.3/23.4) and
               gating; only mounted here for a live/eligible event so
               participation gating is preserved. */
            <div
              data-testid="cloud-section"
              className="rounded-lg border border-ink-muted/40 p-4"
            >
              <h2 className="text-lg font-semibold text-ink">{activeLabel}</h2>
              <WordCloudCard eventId={event.id} eventStatus={event.status} />
            </div>
          )}
        </section>
      ) : (
        /* Gated state (Req 2.8, 1.9): status shown, participation withheld. */
        <section
          role="status"
          aria-live="polite"
          data-testid="participation-closed"
          className="rounded-lg border border-ink-muted/40 p-4"
        >
          <h2 className="text-lg font-semibold text-ink">
            Participation is closed
          </h2>
          <p className="mt-1 text-ink-muted">
            This event is {statusLabel.toLowerCase()}. Question submission,
            voting, polls, and the word cloud aren&rsquo;t available right now.
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * Default landing after a successful sign-in when no attempted location is
 * preserved in navigation state.
 */
const DEFAULT_ADMIN_PATH = '/admin';

/** Resolution state of the login form (Req 24.7 four UX states). */
type LoginStatus = 'idle' | 'submitting' | 'success' | 'error';

/** Shape of the navigation state that `RequireAuth` sets on redirect. */
interface LocationStateWithFrom {
  from?: { pathname?: string };
}

/**
 * Maps an authentication failure to a short, user-facing message that never
 * leaks internals (Req 24.7). We deliberately do NOT surface raw provider
 * error text, status codes, or stack traces; instead we branch on the stable
 * `AdminAuthError.code`/`status` to a small set of safe messages.
 */
function toDisplayMessage(error: unknown): string {
  if (error instanceof AdminAuthError) {
    // Invalid credentials are the common, expected case — keep it generic so
    // we neither confirm which field was wrong nor leak account existence.
    if (
      error.code === 'invalid_credentials' ||
      error.code === 'invalid_login_credentials' ||
      error.status === 400 ||
      error.status === 401
    ) {
      return 'Incorrect email or password. Please try again.';
    }
    if (error.status === 429 || error.code === 'over_request_rate_limit') {
      return 'Too many attempts. Please wait a moment and try again.';
    }
  }
  // Fallback: a neutral message for any other/unknown failure. No internals.
  return 'Sign-in failed. Please check your connection and try again.';
}

/**
 * `/admin/login` — accessible administrator sign-in form (task 6.2).
 *
 * Behaviour (Design → Frontend Design → Route map `/admin/login`; four UX
 * states; Mobile-first & accessibility approach):
 *  - Email + password fields, each with a programmatically associated
 *    `<label>` (via `htmlFor`/`id`) exposing a non-empty accessible name
 *    (Req 24.5), correct input `type`/`autoComplete`, and a logical tab order.
 *  - Four UX states (Req 24.7): idle, submitting (submit disabled + progress
 *    indicator), success (confirmation), and error (a sanitised message from
 *    {@link toDisplayMessage} that never leaks internals).
 *  - On submit: {@link signInWithPassword}; on success, best-effort
 *    {@link ensureAdminProfile} (a `provision_deferred` result still proceeds),
 *    then navigate to the originally-attempted location
 *    (`location.state.from`) or {@link DEFAULT_ADMIN_PATH}.
 *  - Mobile-first `.app-container` layout; the submit button and inputs meet
 *    the ≥44×44px touch-target size (`.touch-target`); keyboard-navigable with
 *    the global `:focus-visible` ring providing visible focus.
 *
 * Security note: UI is defence-in-depth only; the authoritative checks are
 * server-side (JWT verification + RLS). Requirements: 24.5, 24.7, 25.4, 25.8.
 */
export function AdminLogin(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  // Req 24.6: no JS-driven animation in this form; the global CSS
  // `@media (prefers-reduced-motion: reduce)` rule in index.css covers all
  // CSS transitions. No JS animation guard needed here.

  // Stable, unique ids so labels associate with their inputs even if multiple
  // instances mount (Req 24.5).
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isSubmitting = status === 'submitting';

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    // Guard against double submits while a request is in flight.
    if (isSubmitting) return;

    setStatus('submitting');
    setErrorMessage(null);

    try {
      await signInWithPassword(email, password);

      // Best-effort profile provisioning. A `provision_deferred` result (e.g.
      // the provisioning Edge Function is not yet deployed) must NOT block
      // sign-in — we proceed regardless. Any thrown error is likewise
      // swallowed so a profile hiccup never prevents a valid admin logging in.
      try {
        await ensureAdminProfile();
      } catch {
        // Non-fatal: proceed to the admin area regardless (Req 24.7 success).
      }

      setStatus('success');

      // Redirect to the originally-attempted location if `RequireAuth`
      // preserved one; otherwise the admin dashboard (Req 25.8).
      const state = location.state as LocationStateWithFrom | null;
      const target = state?.from?.pathname ?? DEFAULT_ADMIN_PATH;
      navigate(target, { replace: true });
    } catch (error) {
      setErrorMessage(toDisplayMessage(error));
      setStatus('error');
    }
  }

  return (
    <main className="app-container py-8">
      <h1 className="text-2xl font-semibold text-ink">Administrator sign in</h1>
      <p className="mt-2 text-ink-muted">
        Sign in to manage events, moderate content, and configure MSS LivePulse.
      </p>

      <form
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={emailId} className="font-medium text-ink">
            Email address
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isSubmitting}
            aria-invalid={status === 'error' ? true : undefined}
            aria-describedby={status === 'error' ? errorId : undefined}
            className={cx(
              'touch-target rounded border border-ink-muted px-3 py-2 text-ink',
              FOCUS_RING,
            )}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="font-medium text-ink">
            Password
          </label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={isSubmitting}
            aria-invalid={status === 'error' ? true : undefined}
            aria-describedby={status === 'error' ? errorId : undefined}
            className={cx(
              'touch-target rounded border border-ink-muted px-3 py-2 text-ink',
              FOCUS_RING,
            )}
          />
        </div>

        {/* Error state (Req 24.7): a sanitised message announced to AT. */}
        {status === 'error' && errorMessage ? (
          <p id={errorId} role="alert" className="text-ink">
            {errorMessage}
          </p>
        ) : null}

        {/* Success state (Req 24.7): confirmation announced to AT while the
            redirect completes. */}
        {status === 'success' ? (
          <p role="status" aria-live="polite" className="text-ink">
            Signed in. Redirecting…
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
          className={cx(
            'touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60',
            FOCUS_RING,
          )}
        >
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>

        {/* Submitting/loading state (Req 24.7): an accessible progress
            indicator distinct from the button label. */}
        {isSubmitting ? (
          <span role="status" aria-live="polite" className="text-ink-muted">
            Signing you in…
          </span>
        ) : null}
      </form>
    </main>
  );
}

export function AdminDashboard(): JSX.Element {
  return <h1 className="text-2xl font-semibold text-ink">Admin Dashboard</h1>;
}

/**
 * Builds the absolute audience URL a participant scans/opens to join the event
 * (Req 7.10). The presenter join screen encodes this URL in the QR code and
 * shows the Event_Code (slug) alongside it; both resolve to `/e/:eventRef`
 * (task 14.4). We prefer the slug (the human-enterable Event_Code) and fall
 * back to the event id when no slug is set.
 *
 * `window.location.origin` is used so the URL is correct in whichever
 * environment the presenter is opened; when unavailable (non-browser test
 * contexts) we fall back to a relative path, which the QR still encodes fine.
 */
function buildAudienceUrl(event: PublicEvent): string {
  const ref = event.slug ?? event.id;
  const path = `/e/${encodeURIComponent(ref)}`;
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : '';
  return `${origin}${path}`;
}

/** Resolution state of the presenter event lookup (Req 24.7). */
type PresenterStatus = 'loading' | 'ready' | 'unavailable';

/**
 * Converts the PRE-AGGREGATED `{ term, frequency }` pairs carried by a
 * `word_cloud` Broadcast (task 24.2) into the render-ready {@link WordCloudTerm}
 * list the presenter's `word_cloud` mode shows. Unlike {@link aggregateWordCloud}
 * — which groups RAW response rows — the broadcast payload is already grouped by
 * the server, so we only need to assign each term its monotonic size via
 * {@link sizeForFrequency} (Req 6.11) using the default size bounds, then sort by
 * frequency desc (ties by term asc) for a stable, deterministic order matching
 * {@link aggregateWordCloud}. This is a PURE function: no I/O, no mutation.
 *
 * `participant_identifier` never appears in the broadcast payload (Req 8.6), so
 * nothing sensitive can flow through here.
 */
function termsFromWordCloudBroadcast(
  terms: readonly { readonly term: string; readonly frequency: number }[],
): WordCloudTerm[] {
  // Only positive-frequency terms contribute to the rendered cloud.
  const present = terms.filter((t) => t.frequency > 0);
  if (present.length === 0) return [];

  const frequencies = present.map((t) => t.frequency);
  const minFreq = Math.min(...frequencies);
  const maxFreq = Math.max(...frequencies);

  return present
    .map(({ term, frequency }) => ({
      term,
      frequency,
      size: sizeForFrequency(
        frequency,
        minFreq,
        maxFreq,
        DEFAULT_MIN_SIZE,
        DEFAULT_MAX_SIZE,
      ),
    }))
    .sort((a, b) => b.frequency - a.frequency || a.term.localeCompare(b.term));
}

/**
 * `/present/:eventRef` — display-only, projector-optimised presenter view
 * (task 17.1). The {@link Presenter} layout already provides the 16:9,
 * high-contrast, ≥24px shell (Req 7.1); this component fills it with the
 * content permitted by the event's currently-selected presenter mode.
 *
 * Access (Req 7.2, 7.3): a presenter token MAY be supplied as `?t=<token>`; for
 * Milestone 2 the presenter reads only content an anonymous visitor can already
 * see for a LIVE event (RLS-gated), so the token is accepted as a route param
 * but full token verification is intentionally minimal here — the read path is
 * itself the authoritative guard (nothing non-public is reachable). A
 * non-live/unknown event resolves to `null` (RLS) and lands on the
 * unavailable/waiting state.
 *
 * Modes implemented for M2 (Req 7.4 subset):
 *  - `join`: the join screen — QR code (of the audience URL) + the Event_Code
 *    (slug) + the event name (Req 7.10).
 *  - `featured_question`: the highest-priority `featured` question (most votes).
 *  - `top_questions`: the top presentable questions ordered by votes desc.
 *  - `poll_results` (M3, task 24.1): the active poll's visibility-aware results.
 *    Respects `results_visibility` — for `hide_until_closed` the tallies are
 *    withheld until the poll is `closed` (a placeholder is shown while open);
 *    for `show_always` the per-option tallies render while open. Rendered as a
 *    projector-friendly accessible list of option text + `response_count` (no
 *    charts — Recharts is the audience surface). `participant_identifier` is
 *    never read nor rendered (Req 5.11, 7.8, 8.6).
 *  - `word_cloud` (M3, task 24.1): the aggregated live word cloud for the
 *    active prompt, EXCLUDING hidden entries, sized via {@link aggregateWordCloud}
 *    (`../lib/wordcloud`) — rendered as a sized term list (font-size ∝ size).
 *    `participant_identifier` is never read nor rendered (Req 6.13, 7.9, 8.6).
 *  - `ai_themes` (M4, task 34.3): the AI theme-insights output — top themes,
 *    emerging concerns, frequent topics, and notable high-vote questions —
 *    fetched via `runThemeInsights` (`../lib/aiClient`) when the mode becomes
 *    active. Projector-optimised + ARIA-labelled; ALL AI-produced strings are
 *    rendered as PLAIN TEXT (Req 14.8). The has_data:false / degraded (AI
 *    disabled/not-configured, Req 19.1) / empty cases render a friendly notice;
 *    the AI failure never blocks the core flow. The mode switch reflects within
 *    2 s via the same realtime subscription (Req 7.5).
 *  - `waiting` / any remaining mode: a waiting-screen fallback.
 *
 * Visibility (Req 7.9): `pending`/`hidden` questions are excluded from EVERY
 * mode — the read helpers filter to presentable statuses and RLS excludes the
 * rest, so they are never queried nor rendered.
 *
 * Realtime (Req 7.6, 7.7): a Supabase Realtime channel subscribes to `events`
 * (for `active_presenter_mode` changes) and `questions` (for new/updated
 * questions and vote-count changes) scoped to this `event_id`, so the view
 * updates without a manual refresh. On connection loss the LAST successfully
 * displayed content is retained and an interruption indicator is shown
 * (Req 7.7); it clears when the connection recovers.
 *
 * Realtime — M3 modes (task 24.2, Req 5.12, 6.15, 23.2): the same
 * subscription ALSO wires the event-scoped poll-results and word-cloud
 * Broadcast topics. In `poll_results` mode a `poll_results` broadcast updates
 * the active poll's per-option `response_count` in place (within 2 s), and in
 * `word_cloud` mode a `word_cloud` broadcast refreshes the sized terms — both
 * WITHOUT a re-read. Consistent with the M2 modes, an interruption RETAINS the
 * last-displayed poll/terms beneath the banner (state persists; nothing clears
 * it on interruption), so Req 7.7's retain-last-content holds for these modes
 * too.
 *
 * Requirements traceability: 7.9, 7.6, 7.7, 7.5, 7.10, 7.4, 7.8, 5.11, 5.12,
 * 6.13, 6.15, 23.2.
 * Design: Request/data flows (Presenter mode switching); Frontend Design
 * (Route map — `/present/:eventRef`); Data Models (`presenter_mode` enum
 * values `poll_results`, `word_cloud`).
 */
export function PresenterView(): JSX.Element {
  const { eventRef } = useParams();

  const [status, setStatus] = useState<PresenterStatus>('loading');
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [mode, setMode] = useState<PresenterMode>('waiting');
  const [questions, setQuestions] = useState<PresenterQuestion[]>([]);
  const [featured, setFeatured] = useState<PresenterQuestion | null>(null);
  // Milestone 3 modes (task 24.1): the active poll for `poll_results` and the
  // aggregated visible terms for `word_cloud`. Both start empty and are loaded
  // on mode/event change below.
  const [poll, setPoll] = useState<PresenterActivePoll | null>(null);
  const [wordCloudTerms, setWordCloudTerms] = useState<WordCloudTerm[]>([]);
  // Milestone 4 mode (task 34.3): the AI theme-insights result for `ai_themes`.
  // `null` means "not yet loaded / no result to show"; `unavailable` means the
  // AI feature is disabled/not-configured (a normal degraded state, Req 19.1).
  const [themeInsights, setThemeInsights] =
    useState<AiThemeInsightsResult | null>(null);
  const [themesUnavailable, setThemesUnavailable] = useState(false);
  // Live-connection interruption indicator (Req 7.7). When true the last-good
  // content above is retained and an interruption banner is shown.
  const [interrupted, setInterrupted] = useState(false);

  // Resolve the event and its active presenter mode. Anonymous readers only
  // see LIVE events (RLS), so an unknown/non-live ref surfaces as unavailable.
  useEffect(() => {
    let active = true;
    setStatus('loading');
    setEvent(null);

    void (async () => {
      const resolved = await findEventByRef(eventRef);
      if (!active) return;
      if (resolved) {
        setEvent(resolved);
        setMode(
          isPresenterMode(resolved.active_presenter_mode)
            ? resolved.active_presenter_mode
            : 'waiting',
        );
        setStatus('ready');
      } else {
        setStatus('unavailable');
      }
    })();

    return () => {
      active = false;
    };
  }, [eventRef]);

  const eventId = event?.id ?? null;

  // Task 34.3: load the AI theme-insights for the `ai_themes` mode via the AI
  // Gateway. A stable callback so both the initial load and the realtime
  // refresh reuse it. The mode switch itself is realtime (subscribeToPresenter,
  // Req 7.5) so this reflects within 2 s of the moderator selecting the mode.
  //
  // Degraded state (Req 19.1): when AI is disabled/not-configured the Gateway
  // returns `available: false`; we flag `themesUnavailable` and show a friendly
  // notice — the AI failure NEVER blocks the presenter (core flow unaffected).
  //
  // Errors / retain-last-content (Req 7.7): a thrown AiClientError (transport,
  // provider, or malformed) is swallowed; when `retain` is true we keep the
  // previously-displayed insights, otherwise (a fresh mode selection) we clear
  // to `null` so a stale panel is never shown for a new event/mode.
  const loadThemeInsights = useCallback(
    async (id: string, opts: { retain: boolean }): Promise<void> => {
      try {
        const response = await runThemeInsights(id);
        if (response.available) {
          setThemesUnavailable(false);
          setThemeInsights(response.insights);
        } else {
          // AI unavailable — a normal degraded state (Req 19.1).
          setThemesUnavailable(true);
          if (!opts.retain) setThemeInsights(null);
        }
      } catch {
        // Recoverable failure (Req 19.1): never surface internals; retain the
        // last insights on a refresh, or clear on a fresh selection.
        setThemesUnavailable(false);
        if (!opts.retain) setThemeInsights(null);
      }
    },
    [],
  );

  // Load (and reload) the questions this mode needs. Kept as a stable callback
  // so both the initial load and the realtime handler can reuse it. On a read
  // failure the helpers return empty; we RETAIN the previous content (Req 7.7)
  // by only replacing state when the read succeeds with data OR the mode does
  // not need questions.
  const refreshContent = useCallback(
    async (currentMode: PresenterMode, id: string): Promise<void> => {
      if (currentMode === 'featured_question') {
        const top = await readFeaturedQuestion(id);
        setFeatured((prev) => top ?? prev);
      } else if (currentMode === 'top_questions') {
        const list = await readPresenterQuestions(id);
        setQuestions((prev) => (list.length > 0 ? list : prev));
      } else if (currentMode === 'poll_results') {
        // TASK 24.2 HOOK: retain-last-content on a null read is added here.
        const active = await readPresenterActivePoll(id);
        setPoll((prev) => active ?? prev);
      } else if (currentMode === 'word_cloud') {
        // TASK 24.2 HOOK: retain-last-content on an empty read is added here.
        const { responses } = await readPresenterWordCloud(id);
        const terms = aggregateWordCloud(responses);
        setWordCloudTerms((prev) => (terms.length > 0 ? terms : prev));
      } else if (currentMode === 'ai_themes') {
        // Task 34.3: re-run the theme-insights job. On any failure we RETAIN
        // the last-displayed insights (Req 7.7) rather than blanking the panel.
        await loadThemeInsights(id, { retain: true });
      }
    },
    [loadThemeInsights],
  );

  // Initial content load whenever the resolved event or mode changes.
  useEffect(() => {
    if (status !== 'ready' || !eventId) return;
    let active = true;
    void (async () => {
      // A fresh mode selection clears stale content of the OTHER mode so we do
      // not show, e.g., an old featured question under top_questions.
      if (mode === 'featured_question') {
        const top = await readFeaturedQuestion(eventId);
        if (active) setFeatured(top);
      } else if (mode === 'top_questions') {
        const list = await readPresenterQuestions(eventId);
        if (active) setQuestions(list);
      } else if (mode === 'poll_results') {
        // Initial load for the poll_results mode (task 24.1). Retain-last-
        // content + realtime refresh is task 24.2; here we simply reflect the
        // current active poll (or null when there is none).
        const activePoll = await readPresenterActivePoll(eventId);
        if (active) setPoll(activePoll);
      } else if (mode === 'word_cloud') {
        // Initial load for the word_cloud mode (task 24.1). Aggregate the
        // visible responses via the shared, pure aggregator.
        const { responses } = await readPresenterWordCloud(eventId);
        if (active) setWordCloudTerms(aggregateWordCloud(responses));
      } else if (mode === 'ai_themes') {
        // Initial load for the ai_themes mode (task 34.3). A FRESH selection
        // clears the last insights (retain: false) so no stale panel shows for
        // a new event/mode; the mode switch is realtime so this reflects within
        // 2 s (Req 7.5). Guarded by `active` to avoid a post-unmount update.
        if (active) {
          setThemeInsights(null);
          setThemesUnavailable(false);
        }
        await loadThemeInsights(eventId, { retain: false });
      }
    })();
    return () => {
      active = false;
    };
  }, [status, eventId, mode, loadThemeInsights]);

  // Realtime subscription (Req 7.6, 7.7): reflect mode changes + question/vote
  // updates within ~2 s without a manual refresh, scoped to THIS event only.
  // The channel wiring lives in `subscribeToPresenter` (in `../lib/presenter`)
  // so this view has no direct Supabase dependency.
  useEffect(() => {
    if (status !== 'ready' || !eventId) return;

    const unsubscribe = subscribeToPresenter(eventId, {
      // The moderator changing the active presenter mode (Req 7.5, 7.6).
      onModeChange: (next) => setMode(next),
      // New/updated questions and vote-count changes (Req 7.6): re-read the
      // current mode's content.
      onQuestionsChange: () => {
        void refreshContent(mode, eventId);
      },
      // Retain last content + flag/clear the interruption indicator (Req 7.7).
      onConnectionChange: (isInterrupted) => setInterrupted(isInterrupted),
      // Task 24.2 — poll-results broadcast (Req 5.12, 23.2): while in
      // `poll_results` mode, update the ACTIVE poll's per-option
      // `response_count` in place (within 2 s) when the broadcast targets the
      // poll we are displaying. The functional updater reads the current poll,
      // so we never depend on a stale closure. Retain-last-content: if the
      // broadcast is for a different poll (or we have no poll yet), keep the
      // previously-displayed poll untouched (Req 7.7).
      onPollResults: (payload: PresenterPollResultsPayload) => {
        if (mode !== 'poll_results') return;
        setPoll((prev) => {
          if (!prev || prev.id !== payload.poll_id) return prev;
          // Map each broadcast option's response_count onto the matching option
          // (retaining option text/order); options not in the payload keep
          // their last-known count.
          const counts = new Map(
            payload.options.map((o) => [o.option_id, o.response_count]),
          );
          return {
            ...prev,
            options: prev.options.map((option) =>
              counts.has(option.id)
                ? { ...option, response_count: counts.get(option.id) as number }
                : option,
            ),
          };
        });
      },
      // Task 24.2 — word-cloud broadcast (Req 6.15, 23.2): while in
      // `word_cloud` mode, refresh the sized terms from the pre-aggregated
      // broadcast payload (within 2 s). Retain-last-content: an empty payload
      // keeps the previously-displayed terms rather than blanking the screen
      // (Req 7.7), mirroring the featured/top modes' `next ?? prev` pattern.
      onWordCloud: (payload: PresenterWordCloudPayload) => {
        if (mode !== 'word_cloud') return;
        const next = termsFromWordCloudBroadcast(payload.terms);
        setWordCloudTerms((prev) => (next.length > 0 ? next : prev));
      },
    });

    return unsubscribe;
  }, [status, eventId, mode, refreshContent]);

  // Loading state (Req 24.7).
  if (status === 'loading') {
    return (
      <div
        className="flex w-full flex-col items-center gap-6 text-center"
        data-testid="presenter-loading"
      >
        <p role="status" aria-live="polite" className="text-3xl">
          Loading the presenter view…
        </p>
      </div>
    );
  }

  // Unavailable/waiting fallback for an unresolved or not-live event (Req 7.7
  // waiting screen; anonymous/token read only sees live events).
  if (status === 'unavailable' || event === null) {
    return (
      <div
        className="flex w-full flex-col items-center gap-6 text-center"
        data-testid="presenter-waiting"
      >
        <h1 className="text-5xl font-bold">Please wait</h1>
        <p className="text-3xl text-white/80">
          The presentation will begin shortly.
        </p>
      </div>
    );
  }

  const audienceUrl = buildAudienceUrl(event);

  // The interruption banner is rendered above every ready-state mode so the
  // last-good content is always retained beneath it (Req 7.7).
  const interruptionBanner = interrupted ? (
    <p
      role="status"
      aria-live="polite"
      data-testid="presenter-interruption"
      className="rounded bg-yellow-400 px-4 py-2 text-2xl font-semibold text-black"
    >
      Live connection interrupted — showing the last update.
    </p>
  ) : null;

  return (
    <div className="flex w-full flex-col items-center gap-8 text-center">
      {interruptionBanner}

      {mode === 'join' ? (
        <section
          data-testid="presenter-join"
          className="flex flex-col items-center gap-6"
        >
          <h1 className="text-5xl font-bold">{event.name}</h1>
          <QrDisplay
            value={audienceUrl}
            title={`QR code to join ${event.name}`}
            size={360}
            errorCorrectionLevel="M"
            className="bg-white p-4"
          />
          <p className="text-3xl">
            Join at your device with code{' '}
            <span
              data-testid="presenter-event-code"
              className="font-mono font-bold"
            >
              {event.slug ?? event.id}
            </span>
          </p>
        </section>
      ) : mode === 'featured_question' ? (
        <section
          data-testid="presenter-featured"
          className="flex w-full flex-col items-center gap-6"
        >
          <h2 className="text-3xl font-semibold text-white/80">
            Featured question
          </h2>
          {featured ? (
            <blockquote
              data-testid="presenter-featured-question"
              className="max-w-5xl text-5xl font-bold leading-tight"
            >
              {featured.text}
            </blockquote>
          ) : (
            <p className="text-3xl text-white/80">No featured question yet.</p>
          )}
        </section>
      ) : mode === 'top_questions' ? (
        <section
          data-testid="presenter-top"
          className="flex w-full flex-col items-center gap-6"
        >
          <h2 className="text-3xl font-semibold text-white/80">
            Top questions
          </h2>
          {questions.length > 0 ? (
            <ol className="flex w-full max-w-5xl flex-col gap-4 text-left">
              {questions.map((q) => (
                <li
                  key={q.id}
                  data-testid="presenter-top-question"
                  className="flex items-start justify-between gap-6 rounded border border-white/20 px-6 py-4"
                >
                  <span className="text-4xl font-semibold leading-tight">
                    {q.text}
                  </span>
                  <span
                    aria-label={`${q.vote_count} votes`}
                    className="shrink-0 text-4xl font-bold tabular-nums"
                  >
                    ▲ {q.vote_count}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-3xl text-white/80">No questions yet.</p>
          )}
        </section>
      ) : mode === 'poll_results' ? (
        /* Poll results (task 24.1). Visibility-aware: `hide_until_closed`
           withholds the tallies until the poll is `closed`; `show_always`
           renders them while open. Projector-friendly accessible list — NO
           charts (Recharts is the audience surface). Never renders any
           participant data (Req 5.11, 7.8, 8.6). */
        <section
          data-testid="presenter-poll-results"
          className="flex w-full flex-col items-center gap-6"
        >
          {poll ? (
            (() => {
              // Tallies are withheld while an OPEN poll is set to
              // hide_until_closed; shown once closed, or when show_always.
              const revealTallies =
                poll.status === 'closed' ||
                poll.results_visibility === 'show_always';
              return (
                <>
                  <h2 className="max-w-5xl text-4xl font-bold leading-tight">
                    {poll.question_text}
                  </h2>
                  {revealTallies ? (
                    <ul className="flex w-full max-w-5xl flex-col gap-4 text-left">
                      {poll.options.map((option) => (
                        <li
                          key={option.id}
                          data-testid="presenter-poll-option"
                          className="flex items-center justify-between gap-6 rounded border border-white/20 px-6 py-4"
                        >
                          <span className="text-4xl font-semibold leading-tight">
                            {option.text}
                          </span>
                          <span
                            aria-label={`${option.response_count} responses`}
                            className="shrink-0 text-4xl font-bold tabular-nums"
                          >
                            {option.response_count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p
                      data-testid="presenter-poll-hidden"
                      className="text-3xl text-white/80"
                    >
                      Results are hidden until the poll closes.
                    </p>
                  )}
                </>
              );
            })()
          ) : (
            <p className="text-3xl text-white/80">No active poll yet.</p>
          )}
        </section>
      ) : mode === 'word_cloud' ? (
        /* Word cloud (task 24.1). Renders the aggregated visible terms sized by
           frequency (font-size ∝ size). Hidden entries are excluded upstream by
           the read + RLS, and by `aggregateWordCloud`. Never renders any
           participant data (Req 6.13, 7.9, 8.6). */
        <section
          data-testid="presenter-word-cloud"
          className="flex w-full flex-col items-center gap-6"
        >
          <h2 className="text-3xl font-semibold text-white/80">Word cloud</h2>
          {wordCloudTerms.length > 0 ? (
            <ul className="flex max-w-5xl flex-wrap items-center justify-center gap-x-6 gap-y-3">
              {wordCloudTerms.map((term) => (
                <li
                  key={term.term}
                  data-testid="presenter-word-cloud-term"
                  aria-label={`${term.term}, ${term.frequency} mentions`}
                  className="font-bold leading-none"
                  style={{ fontSize: `${term.size}px` }}
                >
                  {term.term}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-3xl text-white/80">No responses yet.</p>
          )}
        </section>
      ) : mode === 'ai_themes' ? (
        /* AI theme insights (task 34.3). Renders the theme-insights output —
           top themes, emerging concerns, frequent topics, and notable
           high-vote questions — projector-optimised (large, high-contrast) and
           ARIA-labelled (a labelled region + labelled sub-sections). ALL AI-
           produced strings are rendered as PLAIN TEXT via JSX text content
           (Req 14.8) — never via dangerouslySetInnerHTML/innerHTML. Handles the
           has_data:false / degraded / empty cases gracefully; the AI failure
           never blocks the core flow (Req 19.1). */
        <section
          data-testid="presenter-ai-themes"
          aria-label="AI theme insights"
          className="flex w-full flex-col items-center gap-8"
        >
          <h2 className="text-3xl font-semibold text-white/80">
            AI theme insights
          </h2>
          {themesUnavailable ? (
            <p
              data-testid="presenter-ai-themes-unavailable"
              className="text-3xl text-white/80"
            >
              AI insights are not available right now.
            </p>
          ) : themeInsights && themeInsights.has_data ? (
            <div className="flex w-full max-w-6xl flex-col gap-10 text-left">
              {themeInsights.top_themes.length > 0 ? (
                <section
                  aria-label="Top themes"
                  className="flex flex-col gap-4"
                >
                  <h3 className="text-3xl font-bold text-white/90">
                    Top themes
                  </h3>
                  <ul className="flex flex-col gap-3">
                    {themeInsights.top_themes.map((theme, index) => (
                      <li
                        key={`theme-${index}`}
                        data-testid="presenter-ai-top-theme"
                        className="rounded border border-white/20 px-6 py-4 text-4xl font-semibold leading-tight"
                      >
                        {theme}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {themeInsights.emerging_concerns.length > 0 ? (
                <section
                  aria-label="Emerging concerns"
                  className="flex flex-col gap-4"
                >
                  <h3 className="text-3xl font-bold text-white/90">
                    Emerging concerns
                  </h3>
                  <ul className="flex flex-col gap-3">
                    {themeInsights.emerging_concerns.map((concern, index) => (
                      <li
                        key={`concern-${index}`}
                        data-testid="presenter-ai-emerging-concern"
                        className="rounded border border-white/20 px-6 py-4 text-4xl font-semibold leading-tight"
                      >
                        {concern}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {themeInsights.frequent_topics.length > 0 ? (
                <section
                  aria-label="Frequent topics"
                  className="flex flex-col gap-4"
                >
                  <h3 className="text-3xl font-bold text-white/90">
                    Frequent topics
                  </h3>
                  <ul className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    {themeInsights.frequent_topics.map((topic, index) => (
                      <li
                        key={`topic-${index}`}
                        data-testid="presenter-ai-frequent-topic"
                        className="rounded-full border border-white/20 px-5 py-2 text-3xl font-semibold leading-none"
                      >
                        {topic}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {themeInsights.notable_high_vote_questions.length > 0 ? (
                <section
                  aria-label="Notable high-vote questions"
                  className="flex flex-col gap-4"
                >
                  <h3 className="text-3xl font-bold text-white/90">
                    Notable high-vote questions
                  </h3>
                  <ol className="flex flex-col gap-4">
                    {themeInsights.notable_high_vote_questions.map(
                      (question) => (
                        <li
                          key={question.question_id}
                          data-testid="presenter-ai-notable-question"
                          className="flex items-start justify-between gap-6 rounded border border-white/20 px-6 py-4"
                        >
                          <span className="text-4xl font-semibold leading-tight">
                            {question.text}
                          </span>
                          <span
                            aria-label={`${question.vote_count} votes`}
                            className="shrink-0 text-4xl font-bold tabular-nums"
                          >
                            ▲ {question.vote_count}
                          </span>
                        </li>
                      ),
                    )}
                  </ol>
                </section>
              ) : null}
            </div>
          ) : (
            <p
              data-testid="presenter-ai-themes-empty"
              className="text-3xl text-white/80"
            >
              No theme insights yet.
            </p>
          )}
        </section>
      ) : (
        /* waiting / any remaining mode fallback. */
        <section
          data-testid="presenter-waiting-mode"
          className="flex flex-col items-center gap-6"
        >
          <h1 className="text-5xl font-bold">{event.name}</h1>
          <p className="text-3xl text-white/80">
            The presentation will continue shortly.
          </p>
        </section>
      )}
    </div>
  );
}

export function NotFound(): JSX.Element {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 text-ink-muted">
        The page you are looking for does not exist.
      </p>
    </div>
  );
}
