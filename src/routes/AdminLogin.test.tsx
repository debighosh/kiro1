/**
 * Tests for the `/admin/login` administrator sign-in form (task 6.2).
 *
 * These verify the accessibility and behaviour mandated by the design's
 * Frontend Design (Route map `/admin/login`; four UX states) using a mocked
 * `../lib/auth` module (so no real Supabase session is needed) and a mocked
 * react-router `useNavigate` (so we can assert navigation targets):
 *   (a) email + password fields expose programmatically associated labels
 *       (getByLabelText resolves both) — Req 24.5;
 *   (b) submitting valid credentials calls `signInWithPassword` and navigates
 *       to `/admin` by default, or to the preserved `from` location — Req 24.7,
 *       25.8;
 *   (c) a rejected sign-in (AdminAuthError) shows a sanitised error message and
 *       does NOT navigate — Req 24.7;
 *   (d) the submit control is disabled while submitting — Req 24.7.
 *
 * Design: Frontend Design → Route map (`/admin/login`); four UX states;
 * Mobile-first & accessibility approach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// --- Mock the auth module the form depends on. -----------------------------
// We fully replace `../lib/auth` (rather than using importActual) so importing
// it never pulls in the real supabase client, which requires VITE_ env vars
// unavailable in the test environment. The mock defines a self-contained
// `AdminAuthError` matching the real class's shape, plus stubbed async helpers.
const { signInWithPassword, ensureAdminProfile, AdminAuthError } = vi.hoisted(
  () => {
    class AdminAuthError extends Error {
      code?: string;
      status?: number;
      cause?: unknown;
      constructor(
        message: string,
        options: { code?: string; status?: number; cause?: unknown } = {},
      ) {
        super(message);
        this.name = 'AdminAuthError';
        this.code = options.code;
        this.status = options.status;
        this.cause = options.cause;
      }
    }
    return {
      signInWithPassword: vi.fn(),
      ensureAdminProfile: vi.fn(),
      AdminAuthError,
    };
  },
);

vi.mock('../lib/auth', () => ({
  signInWithPassword: (email: string, password: string) =>
    signInWithPassword(email, password),
  ensureAdminProfile: () => ensureAdminProfile(),
  AdminAuthError,
}));

// `./screens` now also imports `../lib/eventLookup` (for the audience join
// flow, task 14.3), which transitively loads the real supabase client and
// throws without VITE_ env vars. This test only exercises `AdminLogin`, so we
// stub the lookup to keep the module graph free of the supabase client.
vi.mock('../lib/eventLookup', () => ({
  findEventByRef: vi.fn().mockResolvedValue(null),
}));

// --- Mock react-router's useNavigate while keeping everything else real. ----
const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom',
    );
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

import { AdminLogin } from './screens';

/** Renders the login form at `/admin/login`, optionally with a `from` state. */
function renderLogin(fromPath?: string): void {
  render(
    <MemoryRouter
      initialEntries={[
        fromPath
          ? {
              pathname: '/admin/login',
              state: { from: { pathname: fromPath } },
            }
          : '/admin/login',
      ]}
    >
      <AdminLogin />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  signInWithPassword.mockReset();
  ensureAdminProfile.mockReset();
  navigate.mockReset();
  // Default: profile provisioning is deferred (non-fatal) — must not block.
  ensureAdminProfile.mockResolvedValue({
    status: 'provision_deferred',
    profile: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdminLogin', () => {
  it('exposes programmatically associated labels for email and password (Req 24.5)', () => {
    renderLogin();

    // getByLabelText only resolves when a non-empty accessible name is
    // programmatically associated with the control.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    // Sanity: correct input types / autocomplete for password managers.
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText(/password/i)).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('calls signInWithPassword and navigates to /admin on success (Req 24.7, 25.8)', async () => {
    const user = userEvent.setup();
    signInWithPassword.mockResolvedValue({ session: {}, user: {} });

    renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/password/i), 'correct-horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(signInWithPassword).toHaveBeenCalledWith(
        'admin@example.com',
        'correct-horse',
      );
    });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  it('navigates to the preserved `from` location on success (Req 25.8)', async () => {
    const user = userEvent.setup();
    signInWithPassword.mockResolvedValue({ session: {}, user: {} });

    renderLogin('/admin/events/evt-42');

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/password/i), 'correct-horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/admin/events/evt-42', {
        replace: true,
      });
    });
  });

  it('shows a sanitised error and does NOT navigate when sign-in is rejected (Req 24.7)', async () => {
    const user = userEvent.setup();
    signInWithPassword.mockRejectedValue(
      new AdminAuthError('Invalid login credentials', {
        code: 'invalid_credentials',
        status: 400,
      }),
    );

    renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // An accessible alert with a safe, generic message is shown...
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/incorrect email or password/i);
    // ...it must not leak the raw provider error text...
    expect(alert).not.toHaveTextContent(/invalid login credentials/i);
    // ...and navigation must never happen on failure.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('disables the submit control while submitting (Req 24.7)', async () => {
    const user = userEvent.setup();
    // Keep sign-in pending so we can observe the submitting state.
    let resolveSignIn: (v: {
      session: object;
      user: object;
    }) => void = () => {};
    signInWithPassword.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );

    renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/password/i), 'correct-horse');
    const submit = screen.getByRole('button', { name: /sign in/i });
    await user.click(submit);

    // While the request is in flight the submit control is disabled and marked
    // busy (an accessible loading state).
    await waitFor(() => {
      expect(submit).toBeDisabled();
    });
    expect(submit).toHaveAttribute('aria-busy', 'true');

    // Resolve to let the promise settle and avoid an act() warning.
    resolveSignIn({ session: {}, user: {} });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
  });
});
