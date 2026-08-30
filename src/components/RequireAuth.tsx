import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import {
  getCurrentUser,
  onAuthStateChange,
  type Unsubscribe,
} from '../lib/auth';

/**
 * `RequireAuth` — protected-route wrapper for the authenticated admin area
 * (task 6.3).
 *
 * Behaviour (Design → Frontend Design → Protected-route strategy):
 *  - On mount it resolves the current Supabase user (via {@link getCurrentUser},
 *    which validates the token with the auth server) and subscribes to
 *    auth-state changes (via {@link onAuthStateChange}) so the guard stays in
 *    sync with sign-in / sign-out / token-refresh. The subscription is torn
 *    down on unmount.
 *  - While the auth state is still being determined it renders a lightweight,
 *    accessible "Checking session…" indicator and renders NONE of the protected
 *    content — so protected UI is never flashed before auth resolves.
 *  - If the visitor is NOT authenticated it redirects to `/admin/login` with
 *    `<Navigate replace />` and renders nothing of the protected route
 *    (Req 25.8). The attempted location is preserved in navigation state
 *    (`from`) so the login flow can redirect back after a successful sign-in.
 *  - If the visitor IS authenticated it renders the protected content — either
 *    explicit `children` or a nested `<Outlet/>`. While authenticated, all
 *    admin routes are accessible (Req 25.9).
 *
 * ── Security note (defence-in-depth) ─────────────────────────────────────────
 * This UI route guard is DEFENCE-IN-DEPTH ONLY. It is not a security boundary
 * and the client never trusts it for authorisation. The authoritative checks
 * are server-side: admin mutations run through Edge Functions that verify the
 * JWT, and Row Level Security denies unauthorised rows (Req 10.1, 21.6). A
 * determined client can bypass this guard, but cannot read or mutate protected
 * data without a valid session the server accepts.
 *
 * Requirements traceability: 10.1 (authenticated admin access),
 * 25.8 (unauthenticated admin routes redirect to login and render nothing),
 * 25.9 (authenticated → all admin routes accessible).
 * Design: Frontend Design → Protected-route strategy (RequireAuth).
 */

/** Resolution state of the current auth check. */
type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

export interface RequireAuthProps {
  /**
   * Protected content to render when authenticated. When omitted, a nested
   * `<Outlet/>` is rendered instead, so `RequireAuth` can be used as a parent
   * route `element` guarding child routes.
   */
  readonly children?: ReactNode;
  /** Redirect target for unauthenticated visitors. Defaults to `/admin/login`. */
  readonly loginPath?: string;
}

export function RequireAuth({
  children,
  loginPath = '/admin/login',
}: RequireAuthProps): JSX.Element {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const location = useLocation();

  // Guards against setting state after unmount when the initial async check
  // resolves late (e.g. slow network).
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    // (1) Initial, authoritative check — validates the token with the auth
    // server. A null user (anonymous / signed-out) is a normal state.
    void getCurrentUser()
      .then((user) => {
        if (!isMountedRef.current) return;
        setAuthState(user ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => {
        // Treat any unexpected failure as "not authenticated": the guard must
        // fail closed so protected content is never shown on an ambiguous
        // state. The server-side checks remain the true boundary.
        if (!isMountedRef.current) return;
        setAuthState('unauthenticated');
      });

    // (2) Stay in sync with subsequent auth-state changes (sign-in, sign-out,
    // token refresh) without polling. The session argument reflects the new
    // state, so we can derive auth purely from its presence.
    const unsubscribe: Unsubscribe = onAuthStateChange((_event, session) => {
      if (!isMountedRef.current) return;
      setAuthState(session ? 'authenticated' : 'unauthenticated');
    });

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, []);

  // While resolving, show an accessible loading indicator and render no
  // protected content (avoid flashing protected UI).
  if (authState === 'checking') {
    return (
      <div role="status" aria-live="polite" className="app-container py-6">
        Checking session…
      </div>
    );
  }

  // Not authenticated → redirect to login and render nothing of the protected
  // route (Req 25.8). Preserve the attempted location so the login can send the
  // admin back after signing in.
  if (authState === 'unauthenticated') {
    return <Navigate to={loginPath} replace state={{ from: location }} />;
  }

  // Authenticated → render the protected content (Req 25.9).
  return <>{children ?? <Outlet />}</>;
}

export default RequireAuth;
