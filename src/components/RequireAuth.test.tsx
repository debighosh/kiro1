/**
 * Tests for the `RequireAuth` protected-route wrapper (task 6.3).
 *
 * These verify the three behaviours mandated by the design's protected-route
 * strategy, using a mocked `../lib/auth` module so no real Supabase session is
 * required and auth resolution timing is fully controlled:
 *   (a) unauthenticated → redirects to `/admin/login` and renders NO protected
 *       content (Req 25.8);
 *   (b) authenticated → renders the protected content (Req 25.9, 10.1);
 *   (c) while auth is still resolving → shows the accessible loading state and
 *       renders no protected content (no flash of protected UI).
 *
 * Design: Frontend Design → Protected-route strategy (RequireAuth).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { User } from '@supabase/supabase-js';

// Mock the auth module the component depends on. `onAuthStateChange` returns an
// unsubscribe spy so we can assert cleanup behaviour if needed.
const getCurrentUser = vi.fn();
const onAuthStateChange = vi.fn();
const unsubscribe = vi.fn();

vi.mock('../lib/auth', () => ({
  getCurrentUser: () => getCurrentUser(),
  onAuthStateChange: (cb: unknown) => onAuthStateChange(cb),
}));

import { RequireAuth } from './RequireAuth';

const PROTECTED_TEXT = 'Protected admin content';
const LOGIN_TEXT = 'Admin login screen';

/** Renders RequireAuth guarding a protected route, with a login route target. */
function renderGuarded(initialPath = '/admin'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin/login" element={<div>{LOGIN_TEXT}</div>} />
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

const fakeUser = { id: 'admin-1' } as unknown as User;

beforeEach(() => {
  getCurrentUser.mockReset();
  onAuthStateChange.mockReset();
  unsubscribe.mockReset();
  // Default: subscription is a no-op that returns an unsubscribe fn.
  onAuthStateChange.mockReturnValue(unsubscribe);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RequireAuth', () => {
  it('redirects unauthenticated visitors to /admin/login and renders no protected content (Req 25.8)', async () => {
    getCurrentUser.mockResolvedValue(null);

    renderGuarded('/admin');

    // Once auth resolves to "no user", the login screen is shown...
    await waitFor(() => {
      expect(screen.getByText(LOGIN_TEXT)).toBeInTheDocument();
    });
    // ...and the protected content is never rendered.
    expect(screen.queryByText(PROTECTED_TEXT)).not.toBeInTheDocument();
  });

  it('renders the protected content for an authenticated visitor (Req 25.9)', async () => {
    getCurrentUser.mockResolvedValue(fakeUser);

    renderGuarded('/admin');

    await waitFor(() => {
      expect(screen.getByText(PROTECTED_TEXT)).toBeInTheDocument();
    });
    // The login redirect target should not appear.
    expect(screen.queryByText(LOGIN_TEXT)).not.toBeInTheDocument();
  });

  it('shows the accessible loading state before auth resolves and hides protected content', async () => {
    // A never-resolving promise keeps the guard in the "checking" state.
    let resolveUser: (u: User | null) => void = () => {};
    getCurrentUser.mockReturnValue(
      new Promise<User | null>((resolve) => {
        resolveUser = resolve;
      }),
    );

    renderGuarded('/admin');

    // Loading indicator is present and accessible via its status role...
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/checking session/i);
    // ...and neither protected content nor the login screen is shown yet.
    expect(screen.queryByText(PROTECTED_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(LOGIN_TEXT)).not.toBeInTheDocument();

    // Resolving the check to an authenticated user then reveals the content,
    // proving the loading state precedes (and does not flash) protected UI.
    resolveUser(fakeUser);
    await waitFor(() => {
      expect(screen.getByText(PROTECTED_TEXT)).toBeInTheDocument();
    });
  });

  it('subscribes to auth-state changes and unsubscribes on unmount', async () => {
    getCurrentUser.mockResolvedValue(fakeUser);

    const { unmount } = render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin/login" element={<div>{LOGIN_TEXT}</div>} />
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

    await waitFor(() => {
      expect(screen.getByText(PROTECTED_TEXT)).toBeInTheDocument();
    });
    expect(onAuthStateChange).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
