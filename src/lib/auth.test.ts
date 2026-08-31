/**
 * Task 6.1 — Unit tests for the admin auth client + session helpers.
 *
 * These tests mock the shared browser `supabase` client so they exercise the
 * helper logic (typed errors, null-vs-throw semantics, the ensureAdminProfile
 * SELECT-then-delegate flow, and the unsubscribe wiring) without any network or
 * real env access.
 *
 * Verified behaviours:
 *  - signInWithPassword returns a typed { session, user } and throws
 *    AdminAuthError on failure (Req 10.1).
 *  - signOut throws AdminAuthError on failure.
 *  - getSession returns the session or throws on error.
 *  - getCurrentUser returns the user or null (never throws for "no session").
 *  - onAuthStateChange forwards events and returns a working unsubscribe.
 *  - ensureAdminProfile: returns 'exists' when the owner-scoped SELECT finds a
 *    row; NEVER performs a client insert; delegates to the provisioning Edge
 *    Function when the row is missing; treats a failed/undeployed function as
 *    provision_deferred; and throws when there is no authenticated user
 *    (Req 10.1, 10.2, 10.3; Design → RLS Design → admin_profiles).
 *
 * Requirements: 10.1, 10.2, 10.3
 * Design: Frontend Design (Protected-route strategy); Data Models (admin_profiles)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the shared browser client BEFORE importing the module under test. ---
// `vi.mock` is hoisted above imports, so the mock fns must be created via
// `vi.hoisted` to be available inside the (also-hoisted) factory.
const { authMock, fromMock, invokeMock } = vi.hoisted(() => ({
  authMock: {
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    getSession: vi.fn(),
    getUser: vi.fn(),
    onAuthStateChange: vi.fn(),
  },
  fromMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock('./supabaseClient', () => ({
  supabase: {
    auth: authMock,
    from: (...args: unknown[]) => fromMock(...args),
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

import {
  ADMIN_PROFILE_PROVISION_FUNCTION,
  AdminAuthError,
  ensureAdminProfile,
  getCurrentUser,
  getSession,
  onAuthStateChange,
  signInWithPassword,
  signOut,
} from './auth';

const FAKE_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'admin@example.com',
  user_metadata: {},
} as const;

const FAKE_SESSION = {
  access_token: 'token',
  user: FAKE_USER,
} as const;

const FAKE_PROFILE = {
  id: FAKE_USER.id,
  display_name: 'Admin',
  created_at: '2026-01-01T00:00:00.000Z',
} as const;

/** Builds a chainable query-builder mock ending in maybeSingle. */
function mockSelectChain(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
  };
  fromMock.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('signInWithPassword', () => {
  it('returns the session and user on success', async () => {
    authMock.signInWithPassword.mockResolvedValue({
      data: { session: FAKE_SESSION, user: FAKE_USER },
      error: null,
    });

    const result = await signInWithPassword('admin@example.com', 'pw');

    expect(result).toEqual({ session: FAKE_SESSION, user: FAKE_USER });
    expect(authMock.signInWithPassword).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'pw',
    });
  });

  it('throws a typed AdminAuthError when credentials are rejected', async () => {
    authMock.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: {
        message: 'Invalid login credentials',
        code: 'invalid_credentials',
        status: 400,
      },
    });

    await expect(signInWithPassword('a@b.com', 'bad')).rejects.toBeInstanceOf(
      AdminAuthError,
    );
    await expect(signInWithPassword('a@b.com', 'bad')).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 400,
    });
  });

  it('throws when no session is returned despite no error', async () => {
    authMock.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: null,
    });

    await expect(signInWithPassword('a@b.com', 'pw')).rejects.toBeInstanceOf(
      AdminAuthError,
    );
  });
});

describe('signOut', () => {
  it('resolves on success', async () => {
    authMock.signOut.mockResolvedValue({ error: null });
    await expect(signOut()).resolves.toBeUndefined();
  });

  it('throws AdminAuthError on failure', async () => {
    authMock.signOut.mockResolvedValue({
      error: { message: 'network', code: 'x', status: 500 },
    });
    await expect(signOut()).rejects.toBeInstanceOf(AdminAuthError);
  });
});

describe('getSession', () => {
  it('returns the session', async () => {
    authMock.getSession.mockResolvedValue({
      data: { session: FAKE_SESSION },
      error: null,
    });
    await expect(getSession()).resolves.toBe(FAKE_SESSION);
  });

  it('returns null when signed out', async () => {
    authMock.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    await expect(getSession()).resolves.toBeNull();
  });

  it('throws AdminAuthError on unexpected error', async () => {
    authMock.getSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'boom' },
    });
    await expect(getSession()).rejects.toBeInstanceOf(AdminAuthError);
  });
});

describe('getCurrentUser', () => {
  it('returns the user when authenticated', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: FAKE_USER },
      error: null,
    });
    await expect(getCurrentUser()).resolves.toBe(FAKE_USER);
  });

  it('returns null (does not throw) when there is no session', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Auth session missing!' },
    });
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

describe('onAuthStateChange', () => {
  it('forwards events and returns a working unsubscribe', () => {
    const unsubscribe = vi.fn();
    let registered: ((event: string, session: unknown) => void) | undefined;
    authMock.onAuthStateChange.mockImplementation((cb: typeof registered) => {
      registered = cb;
      return { data: { subscription: { unsubscribe } } };
    });

    const cb = vi.fn();
    const off = onAuthStateChange(cb);

    registered?.('SIGNED_IN', FAKE_SESSION);
    expect(cb).toHaveBeenCalledWith('SIGNED_IN', FAKE_SESSION);

    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('ensureAdminProfile', () => {
  it('throws when there is no authenticated user', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'no session' },
    });
    await expect(ensureAdminProfile()).rejects.toBeInstanceOf(AdminAuthError);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('returns { status: "exists" } when the owner-scoped SELECT finds a row', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: FAKE_USER },
      error: null,
    });
    const chain = mockSelectChain({ data: FAKE_PROFILE, error: null });

    const result = await ensureAdminProfile();

    expect(result).toEqual({ status: 'exists', profile: FAKE_PROFILE });
    expect(fromMock).toHaveBeenCalledWith('admin_profiles');
    expect(chain.eq).toHaveBeenCalledWith('id', FAKE_USER.id);
    // Never attempts a client insert (RLS forbids it).
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('throws AdminAuthError when the SELECT fails unexpectedly', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: FAKE_USER },
      error: null,
    });
    mockSelectChain({ data: null, error: { message: 'db down', code: '500' } });

    await expect(ensureAdminProfile()).rejects.toBeInstanceOf(AdminAuthError);
  });

  it('delegates to the provisioning Edge Function when the row is missing', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: FAKE_USER },
      error: null,
    });
    mockSelectChain({ data: null, error: null });
    invokeMock.mockResolvedValue({
      data: { profile: FAKE_PROFILE },
      error: null,
    });

    const result = await ensureAdminProfile();

    expect(invokeMock).toHaveBeenCalledWith(
      ADMIN_PROFILE_PROVISION_FUNCTION,
      { body: { display_name: 'admin' } }, // email local part fallback
    );
    expect(result).toEqual({ status: 'provisioned', profile: FAKE_PROFILE });
  });

  it('defers provisioning (no throw, no client insert) when the function errors', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: FAKE_USER },
      error: null,
    });
    mockSelectChain({ data: null, error: null });
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: 'not deployed' },
    });

    const result = await ensureAdminProfile();

    expect(result).toEqual({ status: 'provision_deferred', profile: null });
  });

  it('defers provisioning when the function invocation throws (transport failure)', async () => {
    authMock.getUser.mockResolvedValue({
      data: { user: FAKE_USER },
      error: null,
    });
    mockSelectChain({ data: null, error: null });
    invokeMock.mockRejectedValue(new Error('network'));

    const result = await ensureAdminProfile();

    expect(result).toEqual({ status: 'provision_deferred', profile: null });
  });
});
