import { useId, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AdminAuthError,
  ensureAdminProfile,
  signInWithPassword,
} from '../lib/auth';

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

export function PublicLanding(): JSX.Element {
  return <h1 className="text-2xl font-semibold text-ink">MSS LivePulse</h1>;
}

export function JoinScreen(): JSX.Element {
  const { eventRef } = useParams();
  return (
    <h1 className="text-2xl font-semibold text-ink">
      Join event{eventRef ? `: ${eventRef}` : ''}
    </h1>
  );
}

export function EventView(): JSX.Element {
  const { eventRef } = useParams();
  return (
    <h1 className="text-2xl font-semibold text-ink">
      Event{eventRef ? `: ${eventRef}` : ''}
    </h1>
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
