/**
 * Task 6.4 — Complementary administrator-authorisation tests for `RequireAuth`.
 *
 * The initial `RequireAuth.test.tsx` (task 6.3) already covers the three core
 * behaviours: unauthenticated → redirect + no protected content (Req 25.8),
 * authenticated → protected content (Req 25.9), the "checking" loading state,
 * and subscribe/unsubscribe on unmount. This file CLOSES THE REMAINING GAPS for
 * Req 10.1/10.2/10.3/25.8/25.9 without duplicating those cases, focusing on the
 * *authorisation* semantics of the guard:
 *
 *   1. Live sign-out (Req 25.8/25.9): after the visitor is initially
 *      authenticated, an `onAuthStateChange` event whose session becomes `null`
 *      (SIGNED_OUT / expiry) makes the guard transition to the login redirect
 *      and stop rendering protected content — proving the guard reacts to live
 *      session loss, not just the initial check.
 *   2. Redirect preserves the attempted location (Req 25.8): when redirecting an
 *      unauthenticated visitor, the guard stores the attempted path in
 *      navigation `state.from`, so the login flow can send the admin back after
 *      signing in. The existing test asserts the redirect but NOT this state.
 *   3. Moderator == Administrator for V1 (Req 10.2/10.3): the guard performs NO
 *      role check. Any authenticated session — an arbitrary user with no "admin"
 *      flag/role in its shape — is treated as an authorised administrator and
 *      renders protected content. This encodes the V1 rule that a Moderator uses
 *      the same authenticated interface and permissions as an Administrator.
 *
 * All tests are deterministic: `../lib/auth` is mocked and `onAuthStateChange`
 * captures the registered callback so the test can drive live auth transitions,
 * and routing uses `MemoryRouter`.
 *
 * Requirements traceability: 10.1, 10.2, 10.3, 25.8, 25.9, 26.1.
 * Design: Frontend Design → Protected-route strategy (RequireAuth).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
  type Location,
} from 'react-router-dom';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';

// Mock the auth module the component depends on. `onAuthStateChange` records the
// callback the guard registers so tests can invoke it to simulate live
// sign-in / sign-out events, and returns an unsubscribe spy.
const getCurrentUser = vi.fn();
const onAuthStateChange = vi.fn();
const unsubscribe = vi.fn();

/** The auth-state callback captured from the guard's subscription. */
let authCallback:
  | ((event: AuthChangeEvent, session: Session | null) => void)
  | undefined;

vi.mock('../lib/auth', () => ({
  getCurrentUser: () => getCurrentUser(),
  onAuthStateChange: (
    cb: (event: AuthChangeEvent, session: Session | null) => void,
  ) => {
    authCallback = cb;
    return onAuthStateChange(cb);
  },
}));

import { RequireAuth } from './RequireAuth';

const PROTECTED_TEXT = 'Protected admin content';
const LOGIN_TEXT = 'Admin login screen';

/**
 * A login-route element that also exposes the navigation `state.from` value it
 * was redirected with, so tests can assert the attempted location is preserved.
 */
function LoginProbe(): JSX.Element {
  const location = useLocation() as Location & {
    state: { from?: Location } | null;
  };
  const from = location.state?.from?.pathname ?? '(none)';
  return (
    <div>
      <span>{LOGIN_TEXT}</span>
      <span data-testid="from">{from}</span>
    </div>
  );
}

/** Renders RequireAuth guarding a protected route, with the login probe. */
function renderGuarded(initialPath = '/admin'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin/login" element={<LoginProbe />} />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <div>{PROTECTED_TEXT}</div>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

// A minimal authenticated user with NO role/admin flag — deliberately arbitrary
// to prove the guard gates on session presence alone, not on any role claim.
const arbitraryUser = { id: 'user-without-role' } as unknown as User;
// A session object; the guard only cares that it is non-null.
const fakeSession = { user: arbitraryUser } as unknown as Session;

beforeEach(() => {
  getCurrentUser.mockReset();
  onAuthStateChange.mockReset();
  unsubscribe.mockReset();
  authCallback = undefined;
  onAuthStateChange.mockReturnValue(unsubscribe);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RequireAuth — administrator authorisation (task 6.4)', () => {
  it('reacts to a live sign-out: after being authenticated, a null-session auth event redirects to login and drops protected content (Req 25.8, 25.9)', async () => {
    // Initially authenticated.
    getCurrentUser.mockResolvedValue(arbitraryUser);

    renderGuarded('/admin');

    // Protected content is shown once the initial check resolves.
    await waitFor(() => {
      expect(screen.getByText(PROTECTED_TEXT)).toBeInTheDocument();
    });
    expect(authCallback).toBeTypeOf('function');

    // Simulate a live sign-out (session becomes null) via the subscription.
    act(() => {
      authCallback?.('SIGNED_OUT', null);
    });

    // The guard must transition to the login redirect and stop rendering the
    // protected content — it does not trust the stale authenticated state.
    await waitFor(() => {
      expect(screen.getByText(LOGIN_TEXT)).toBeInTheDocument();
    });
    expect(screen.queryByText(PROTECTED_TEXT)).not.toBeInTheDocument();
  });

  it('re-authorises a live token refresh without dropping protected content: a non-null-session auth event while authenticated keeps access (Req 25.9)', async () => {
    // Initially authenticated and rendering protected content.
    getCurrentUser.mockResolvedValue(arbitraryUser);

    renderGuarded('/admin');

    await waitFor(() => {
      expect(screen.getByText(PROTECTED_TEXT)).toBeInTheDocument();
    });
    expect(authCallback).toBeTypeOf('function');

    // A live TOKEN_REFRESHED event carrying a (still non-null) session must keep
    // the visitor authorised — access is retained while a session is present.
    act(() => {
      authCallback?.('TOKEN_REFRESHED', fakeSession);
    });

    // Still authorised, protected content still shown, no redirect to login.
    expect(screen.getByText(PROTECTED_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(LOGIN_TEXT)).not.toBeInTheDocument();
  });

  it('preserves the attempted location in navigation state `from` when redirecting an unauthenticated visitor (Req 25.8)', async () => {
    getCurrentUser.mockResolvedValue(null);

    renderGuarded('/admin');

    await waitFor(() => {
      expect(screen.getByText(LOGIN_TEXT)).toBeInTheDocument();
    });
    // The login route can read `location.state.from` — the path the visitor
    // originally attempted — so it can redirect back after a successful sign-in.
    expect(screen.getByTestId('from')).toHaveTextContent('/admin');
  });

  it('treats ANY authenticated session as an administrator — no role gating (Moderator == Administrator for V1; Req 10.2, 10.3)', async () => {
    // An arbitrary authenticated user with no "admin"/role flag in its shape.
    getCurrentUser.mockResolvedValue(arbitraryUser);

    renderGuarded('/admin');

    // The guard authorises purely on session presence: the protected content is
    // rendered and there is no role-based rejection to the login screen. This
    // encodes the V1 rule that a Moderator uses the same authenticated
    // interface and permissions as an Administrator (Req 10.2, 10.3).
    await waitFor(() => {
      expect(screen.getByText(PROTECTED_TEXT)).toBeInTheDocument();
    });
    expect(screen.queryByText(LOGIN_TEXT)).not.toBeInTheDocument();
  });
});
