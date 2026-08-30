import { useEffect, useId, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AdminAuthError,
  ensureAdminProfile,
  signInWithPassword,
} from '../lib/auth';
import { findEventByRef, type PublicEvent } from '../lib/eventLookup';
import { isParticipationEligible } from '../lib/participationGate';
import { getParticipantIdentifier } from '../lib/participant';
import { EventJoinCard } from '../components/EventJoinCard';

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
 * The three audience interaction views the event exposes (Req 2.6). For
 * Milestone 2 only the Q&A section hosts a real UI (tasks 15.x); the poll and
 * word-cloud sections are announced as "coming up" placeholders here. Each is a
 * clearly-marked mount point later tasks slot their widgets into.
 */
const INTERACTION_VIEWS = [
  { key: 'qa', label: 'Q&A', suffix: 'qa' },
  { key: 'poll', label: 'Poll', suffix: 'poll' },
  { key: 'cloud', label: 'Word cloud', suffix: 'cloud' },
] as const;

type InteractionKey = (typeof INTERACTION_VIEWS)[number]['key'];

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
          <span data-testid="active-interaction" className="font-medium text-ink">
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
                  className={`touch-target rounded px-4 py-2 font-medium ${
                    selected
                      ? 'bg-focus text-surface'
                      : 'border border-ink-muted/40 text-ink'
                  }`}
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
            /* Q&A section container (Req 2.6). For M2 this is the clearly-marked
               mount point that tasks 15.x (`QuestionSubmissionForm` +
               `QuestionListAndVoting`) slot their real widgets into. */
            <div
              data-testid="qa-section"
              className="rounded-lg border border-ink-muted/40 p-4"
            >
              <h2 className="text-lg font-semibold text-ink">Questions</h2>
              <p className="mt-1 text-ink-muted">
                Ask a question or vote on questions from others.
              </p>
              {/* MOUNT POINT (tasks 15.x): QuestionSubmissionForm +
                  QuestionListAndVoting are wired in here. Left intentionally
                  minimal to avoid over-building the Q&A internals in 14.4. */}
              <div data-testid="qa-mount-point" />
            </div>
          ) : (
            /* Poll / word-cloud sections are "coming up" placeholders for M2. */
            <div
              data-testid={`${activeView}-section`}
              className="rounded-lg border border-ink-muted/40 p-4"
            >
              <h2 className="text-lg font-semibold text-ink">{activeLabel}</h2>
              <p className="mt-1 text-ink-muted">
                This interaction is coming up. Stay tuned.
              </p>
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
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
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
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
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
          className="touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60"
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

export function PresenterView(): JSX.Element {
  const { eventRef } = useParams();
  return (
    <h1 className="font-semibold">
      Presenter{eventRef ? `: ${eventRef}` : ''}
    </h1>
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
