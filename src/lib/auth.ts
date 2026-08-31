/**
 * Administrator authentication client + session helpers (Task 6.1).
 *
 * Framework-agnostic wrappers around the shared browser {@link supabase}
 * client (anon key only) that expose the small surface the admin UI needs:
 * email/password sign-in, sign-out, current session/user reads, an auth-state
 * subscription (consumed by `RequireAuth`, task 6.3), and an
 * {@link ensureAdminProfile} helper that guarantees an `admin_profiles` row
 * exists for the signed-in admin.
 *
 * These are plain functions (no React) so both the login form (task 6.2) and
 * the `RequireAuth` wrapper (task 6.3) can consume them.
 *
 * ── Security model (Design → RLS Design; Frontend Design → Protected-route
 * strategy) ──────────────────────────────────────────────────────────────────
 * - The browser client uses the anon key only. UI route protection is
 *   defence-in-depth; the authoritative checks are server-side (Edge Functions
 *   verify the JWT and RLS denies unauthorised rows) — Req 10.1, 21.6.
 * - `admin_profiles` has RLS enabled with an owner-scoped SELECT policy
 *   (`id = auth.uid()`) and NO client INSERT/UPDATE/DELETE policy. Profile rows
 *   are provisioned server-side via the service role in an Edge Function.
 *   Therefore {@link ensureAdminProfile} NEVER attempts a client-side insert
 *   (RLS would reject it); it only reads the caller's own row and, when
 *   missing, delegates provisioning to a server endpoint. See
 *   {@link ADMIN_PROFILE_PROVISION_FUNCTION}.
 * - For V1 there is no separate moderator role: any authenticated user with an
 *   `admin_profiles` row has full administrator access (Req 10.2, 10.3).
 *
 * Requirements: 10.1 (authenticated admin access), 10.2 (moderator == admin
 * interface for V1), 10.3 (moderator == admin permissions for V1).
 * Design: Frontend Design (Protected-route strategy); Data Models
 * (`admin_profiles`).
 */

import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';

/**
 * Name of the Supabase Edge Function responsible for provisioning an
 * `admin_profiles` row for a freshly authenticated admin, using the service
 * role (which bypasses RLS). The function itself is implemented in a later
 * task — this module only references it by name so that profile creation flows
 * through the server rather than a (forbidden) client insert.
 *
 * See supabase/migrations/20260101000008_admin_audit_rls.sql: "Profile rows are
 * created on first admin sign-in by an Edge Function using the service role".
 */
export const ADMIN_PROFILE_PROVISION_FUNCTION =
  'provision-admin-profile' as const;

/** Shape of an `admin_profiles` row (Design → Data Models → `admin_profiles`). */
export interface AdminProfile {
  /** PK; equals the Supabase auth user id (auth.users.id). */
  readonly id: string;
  /** Human-readable name shown in the admin interface. */
  readonly display_name: string;
  /** UTC creation timestamp (Req 21.19). */
  readonly created_at: string;
}

/**
 * Typed error thrown by the auth helpers. Wraps the underlying Supabase error
 * so callers (login form, RequireAuth) can branch on a stable type/message
 * without depending on Supabase's error shape.
 */
export class AdminAuthError extends Error {
  /** Machine-readable Supabase error code, when available. */
  readonly code?: string;
  /** HTTP-ish status from the underlying error, when available. */
  readonly status?: number;
  /** The original error, preserved for logging/debugging. */
  readonly cause?: unknown;

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

/** Result of a successful sign-in. */
export interface SignInResult {
  readonly session: Session;
  readonly user: User;
}

/**
 * Signs an administrator in with email + password via Supabase Auth.
 *
 * On success the session is persisted by the browser client (see
 * `supabaseClient.ts`). On failure this throws a typed {@link AdminAuthError}
 * rather than returning an error object, so callers can use try/catch.
 *
 * Note: this intentionally does NOT call {@link ensureAdminProfile}. Callers
 * (the login form, task 6.2) decide when to ensure the profile so that the
 * network call is explicit and testable. Requirements: 10.1, 10.2.
 *
 * @throws {AdminAuthError} when credentials are rejected or the request fails.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInResult> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw new AdminAuthError(error.message, {
      code: error.code,
      status: error.status,
      cause: error,
    });
  }

  // Defensive: a non-error response without a session/user should never happen
  // for password sign-in, but guard so downstream consumers get a typed result.
  if (!data.session || !data.user) {
    throw new AdminAuthError('Sign-in succeeded but no session was returned.');
  }

  return { session: data.session, user: data.user };
}

/**
 * Signs the current administrator out, clearing the persisted session.
 *
 * @throws {AdminAuthError} when the sign-out request fails.
 */
export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new AdminAuthError(error.message, {
      code: error.code,
      status: error.status,
      cause: error,
    });
  }
}

/**
 * Returns the current Supabase session, or `null` when signed out.
 *
 * @throws {AdminAuthError} when the session lookup fails unexpectedly.
 */
export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new AdminAuthError(error.message, {
      code: error.code,
      status: error.status,
      cause: error,
    });
  }
  return data.session;
}

/**
 * Returns the currently authenticated user, or `null` when signed out.
 *
 * Uses `getUser()` which validates the token with the auth server, making it
 * the authoritative "is this session real" check for the client. A missing
 * session yields `null` rather than an error.
 */
export async function getCurrentUser(): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    // No active session is a normal, expected state (e.g. anonymous visitor or
    // logged-out admin) — surface it as `null`, not an exception.
    return null;
  }
  return data.user ?? null;
}

/** Unsubscribe handle returned by {@link onAuthStateChange}. */
export type Unsubscribe = () => void;

/**
 * Subscribes to Supabase auth-state changes (sign-in, sign-out, token refresh).
 *
 * Consumed by `RequireAuth` (task 6.3) to react to session changes without
 * polling. Returns an idempotent unsubscribe function that callers should
 * invoke on cleanup (e.g. from a React effect).
 *
 * @param callback Invoked with the auth event and the (possibly null) session.
 * @returns A function that removes the subscription.
 */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): Unsubscribe {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });

  return () => {
    subscription.unsubscribe();
  };
}

/** Outcome of {@link ensureAdminProfile}. */
export type EnsureAdminProfileResult =
  | {
      /** An `admin_profiles` row already existed and was returned. */
      readonly status: 'exists';
      readonly profile: AdminProfile;
    }
  | {
      /**
       * No profile row exists yet. Provisioning is delegated to the server
       * (the {@link ADMIN_PROFILE_PROVISION_FUNCTION} Edge Function) because
       * clients are forbidden from inserting into `admin_profiles` by RLS.
       */
      readonly status: 'provisioned' | 'provision_deferred';
      readonly profile: AdminProfile | null;
    };

/**
 * Ensures a matching `admin_profiles` row exists for the authenticated user.
 *
 * Flow (Design → RLS Design → `admin_profiles`):
 *  1. SELECT the caller's own profile (owner-scoped SELECT is the only client
 *     access allowed by RLS). If present → `{ status: 'exists' }`.
 *  2. If missing, provisioning MUST happen server-side via the service role
 *     because there is no client INSERT policy on `admin_profiles` (a direct
 *     client insert would be rejected by RLS). We invoke the
 *     {@link ADMIN_PROFILE_PROVISION_FUNCTION} Edge Function to create the row.
 *
 * The Edge Function is implemented in a later task. Until it is deployed the
 * invocation may fail; rather than throw (which would block sign-in) this
 * returns `{ status: 'provision_deferred' }`, allowing the caller to proceed.
 * A server-side trigger on `auth.users` is an alternative provisioning path
 * (see design note) and would make this a no-op read.
 *
 * IMPORTANT: This function never attempts a client-side INSERT into
 * `admin_profiles` — doing so would violate the RLS design (Req 21.6).
 *
 * @throws {AdminAuthError} only when there is no authenticated user or the
 *   owner-scoped SELECT fails for an unexpected reason.
 */
export async function ensureAdminProfile(): Promise<EnsureAdminProfileResult> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AdminAuthError(
      'Cannot ensure an admin profile without an authenticated user.',
    );
  }

  // (a) Owner-scoped SELECT — the only client access RLS permits. `maybeSingle`
  // returns null (not an error) when the row is absent.
  const { data: existing, error: selectError } = await supabase
    .from('admin_profiles')
    .select('id, display_name, created_at')
    .eq('id', user.id)
    .maybeSingle<AdminProfile>();

  if (selectError) {
    throw new AdminAuthError(
      `Failed to read admin profile: ${selectError.message}`,
      { code: selectError.code, cause: selectError },
    );
  }

  if (existing) {
    return { status: 'exists', profile: existing };
  }

  // (b) No row yet — delegate creation to the server. Clients cannot insert
  // into admin_profiles (no RLS INSERT policy), so we call the provisioning
  // Edge Function, which uses the service role and bypasses RLS.
  return provisionAdminProfileViaServer(user);
}

/**
 * Delegates `admin_profiles` provisioning to the server via the
 * {@link ADMIN_PROFILE_PROVISION_FUNCTION} Edge Function (service role).
 *
 * The Edge Function is not implemented in this task. If the invocation fails
 * (e.g. the function is not yet deployed) we treat provisioning as deferred
 * rather than failing sign-in, and return whatever profile the function
 * reports (or `null`). This keeps the client structured so that all writes to
 * `admin_profiles` flow through the server.
 */
async function provisionAdminProfileViaServer(
  user: User,
): Promise<EnsureAdminProfileResult> {
  // Prefer a display name from user metadata, falling back to the email local
  // part, then the user id — the Edge Function may override/ignore this.
  const metadataName =
    typeof user.user_metadata?.display_name === 'string'
      ? user.user_metadata.display_name
      : undefined;
  const emailLocalPart = user.email?.split('@')[0];
  const suggestedDisplayName = metadataName ?? emailLocalPart ?? user.id;

  try {
    const { data, error } = await supabase.functions.invoke<{
      profile?: AdminProfile;
    }>(ADMIN_PROFILE_PROVISION_FUNCTION, {
      body: { display_name: suggestedDisplayName },
    });

    if (error) {
      // TODO(task: implement `provision-admin-profile` Edge Function): until the
      // server function (or an auth.users trigger) exists, provisioning is a
      // no-op on the client and is reported as deferred. Do NOT fall back to a
      // client insert — RLS forbids it (Req 21.6).
      return { status: 'provision_deferred', profile: null };
    }

    return { status: 'provisioned', profile: data?.profile ?? null };
  } catch {
    // Network/transport failure or function not deployed — defer provisioning.
    return { status: 'provision_deferred', profile: null };
  }
}
