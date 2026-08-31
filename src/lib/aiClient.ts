/**
 * AI Gateway / AI provider-settings client helper (Task 34.1).
 *
 * This module is the browser-side gateway the admin AI settings screen
 * ({@link import('../routes/AiSettings').AiSettings}, task 34.1) uses to:
 *
 *  (a) invoke the AI Gateway `connection_test` job and return ONLY the
 *      sanitised connection-test result (Req 13.1, 25.7);
 *  (b) save / replace the AI provider settings (and, write-only, the
 *      credential) (Req 11, 12.11);
 *  (c) remove the stored credential (Req 11.13, 12.11);
 *  (d) read the NON-SECRET AI provider settings — including `credential_state`
 *      — via the whitelisted read path (Req 11.9, 12.8, 12.10).
 *
 * It mirrors the conventions of `./moderation.ts` ({@link import('./moderation').moderateQuestion}):
 * a typed error class ({@link AiClientError}), a require-a-session-first guard,
 * `supabase.functions.invoke` for Edge-Function calls (which attaches
 * `Authorization: Bearer <access_token>` automatically), and strictly sanitised
 * user-safe messages that never leak provider internals or any credential.
 *
 * ── Read path (authenticated, NON-SECRET only) ───────────────────────────────
 * The `ai_provider_settings` base table has RLS enabled with NO client SELECT
 * policy (migration `20260101000033_ai_provider_settings_rls.sql`). The ONLY
 * client-reachable read is the SECURITY DEFINER RPC `read_ai_provider_settings()`
 * (companion view `ai_provider_settings_public`), which returns ONLY whitelisted
 * NON-SECRET columns of the single active config — `secret_reference` and
 * `encrypted_credential` are deliberately excluded and are NEVER selectable by
 * any client. `credential_state` ('configured' | 'not_configured') is surfaced
 * so the UI can show WHETHER a credential is configured without ever exposing
 * its value (Req 11.9, 12.1, 12.10). We call the RPC via `supabase.rpc(...)`.
 *
 * ── Connection test (WIRED — task 29.5) ──────────────────────────────────────
 * `connection_test` runs through the deployed `ai-gateway` Edge Function with a
 * POST body `{ job_type: 'connection_test' }`. The function returns a sanitised
 * `connection_test` object (outcome, status category, model id, round-trip ms,
 * ISO 8601 timestamp, and — on failure — a fixed failure category) with NO
 * provider internals (Req 13.1, 13.3, 13.10, 25.7). It may instead return an
 * `ai.available === false` degraded payload (AI disabled / not configured /
 * credential missing) — a normal, non-error state (Req 19.1).
 *
 * ── Config WRITE path (documented SEAM) ──────────────────────────────────────
 * Creating / replacing a provider config and writing the (write-only) credential
 * columns is performed EXCLUSIVELY by a SERVICE-ROLE Edge Function — the client
 * has no write policy on `ai_provider_settings` (RLS default-deny). For V1 the
 * dedicated AI-config write endpoint (design task 28.2) is NOT yet deployed
 * (only `ai-gateway`, `create-event`, `moderate-question`, and
 * `transition-event-status` exist). We therefore target the config-write
 * endpoint by NAME ({@link AI_CONFIG_FUNCTION}) so the seam is explicit and the
 * screen degrades gracefully (a `not_implemented` AiClientError) until the
 * function is wired — exactly the pattern `./auth.ts` uses for
 * `provision-admin-profile`. The credential is submitted ONLY over this
 * authenticated HTTPS write path and is NEVER read back (Req 12.1, 12.10).
 *
 * Requirements traceability: 11.9, 11.12, 11.13, 12.1, 12.8, 12.10, 12.11,
 * 13.1, 20.5, 25.7.
 * Design references: Server-Side AI Gateway Design (Connection test; Credential
 * handling — Replace/Remove); RLS Design (`ai_provider_settings` — non-secret
 * read path via `read_ai_provider_settings()`); Frontend Design.
 */

import { getCurrentUser, getSession } from './auth';
import { supabase } from './supabaseClient';
import { isValidCategory } from './ai/categoriseRules';
import { aiThemeInsightsResultSchema } from '../schemas/ai';
import type {
  AiAuthType,
  AiCategory,
  AiProviderSettingsInput,
  AiProviderType,
  AiThemeInsightsResult,
} from '../schemas/ai';

// ----------------------------------------------------------------------------
// Function / RPC names.
// ----------------------------------------------------------------------------

/** The deployed AI Gateway Edge Function — the single AI egress (task 29.x). */
export const AI_GATEWAY_FUNCTION = 'ai-gateway' as const;

/**
 * The SERVICE-ROLE AI-config write Edge Function (design task 28.2).
 *
 * NOTE — SEAM: this endpoint is not yet deployed for V1. It is referenced by
 * name so config/credential WRITES are structured to flow through the server
 * (never a client write, which RLS forbids). Until it exists, {@link saveAiProviderSettings}
 * and {@link removeAiCredential} surface a typed `not_implemented`
 * {@link AiClientError}. This mirrors `provision-admin-profile` in `./auth.ts`.
 */
export const AI_CONFIG_FUNCTION = 'ai-config' as const;

/**
 * The SERVICE-ROLE categorisation moderator-override write Edge Function
 * (design task 30.1 — `applyModeratorOverride`).
 *
 * NOTE — SEAM: the categorisation JOB is wired into the `ai-gateway` function
 * (`{ job_type: 'categorisation' }`, see {@link runCategorisation}), but the
 * moderator OVERRIDE write path (`applyModeratorOverride` in the gateway's
 * `jobs/categorisation.ts`) is NOT yet exposed through a wired HTTP endpoint in
 * `ai-gateway/index.ts`. Because the client has no UPDATE policy on `questions`
 * (RLS default-deny — every category write must be server-mediated), we target
 * the override endpoint by NAME so the seam is explicit and the queue degrades
 * gracefully (a typed `not_implemented` {@link AiClientError}) until the
 * endpoint is wired — mirroring the {@link AI_CONFIG_FUNCTION} seam above and
 * `provision-admin-profile` in `./auth.ts`.
 *
 * The "retain prior on invalid selection" guarantee (Req 15.8) and the
 * "record the prior category into `ai_prior_category`" guarantee (Req 15.7) are
 * enforced AUTHORITATIVELY server-side by `applyModeratorOverride`
 * (`computeOverride`). The client ADDITIONALLY constrains the selection to the
 * eight allowed categories via {@link isValidOverrideCategory} so an invalid
 * category cannot even be submitted.
 */
export const AI_CATEGORISE_OVERRIDE_FUNCTION =
  'categorise-override' as const;

/** The whitelisted NON-SECRET read RPC (migration …000033). */
export const READ_AI_PROVIDER_SETTINGS_RPC =
  'read_ai_provider_settings' as const;

/**
 * Re-verification window (Req 11.12, 12.11): a credential Replace/Remove
 * requires an authenticated session that was established or re-verified within
 * the last 300 seconds. Beyond this the UI gates the action behind a re-verify
 * prompt.
 */
export const CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS = 300 as const;

// ----------------------------------------------------------------------------
// Domain types.
// ----------------------------------------------------------------------------

/**
 * Whether a credential is configured for the active provider (Req 11.9). This
 * is the ONLY credential-related value the client ever sees — never the value
 * itself (Req 12.1, 12.10). `'required'` is a UI-derived state layered on top
 * of the DB's `credential_state` when the selected auth type needs a credential
 * but none is configured.
 */
export type CredentialState = 'configured' | 'not_configured';

/**
 * The NON-SECRET active AI provider settings returned by the read path
 * (`read_ai_provider_settings()`), mirroring its whitelisted column list. It
 * DELIBERATELY has no credential value — only `credential_state`.
 */
export interface AiProviderSettingsPublic {
  readonly id: string;
  readonly is_active: boolean;
  readonly ai_enabled: boolean;
  readonly display_name: string;
  readonly provider_type: AiProviderType;
  readonly base_url: string;
  readonly chat_completions_path: string;
  readonly auth_type: AiAuthType;
  readonly api_key_header_name: string | null;
  readonly model_id: string;
  readonly temperature: number;
  readonly max_output_tokens: number;
  readonly request_timeout_seconds: number;
  readonly tls_verify_required: boolean;
  /** Only whether a credential is configured — never its value (Req 11.9). */
  readonly credential_state: CredentialState;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The three connection-test outcomes surfaced to the admin (Req 13.11). */
export type ConnectionTestOutcome =
  | 'established'
  | 'reachable_but_incompatible'
  | 'failed';

/** Fixed, credential-free connection-test failure categories (Req 13.3). */
export type ConnectionTestFailureCategory =
  | 'invalid_url_scheme'
  | 'timeout'
  | 'disallowed_destination'
  | 'connection_error'
  | 'invalid_response';

/**
 * The sanitised connection-test result (Req 13.1, 13.3, 25.7). Contains NO
 * provider headers, credential, raw body, hostname, or resolved IP — only the
 * whitelisted, admin-safe fields.
 */
export interface ConnectionTestResult {
  readonly outcome: ConnectionTestOutcome;
  readonly status_category: '2xx' | '3xx' | '4xx' | '5xx' | null;
  readonly model_id: string;
  readonly round_trip_ms: number | null;
  /** ISO 8601 UTC timestamp of when the test completed. */
  readonly timestamp: string;
  /** Present ONLY when `outcome === 'failed'`. */
  readonly failure_category?: ConnectionTestFailureCategory;
}

/**
 * The degraded / "AI unavailable" payload the Gateway returns (HTTP 200) when
 * the enablement precondition fails — AI disabled, not configured, or a
 * credential is required. This is a normal, non-error state (Req 19.1, 19.2):
 * the connection test could not run because AI is not usable yet.
 */
export interface AiUnavailable {
  readonly available: false;
  readonly reason: 'ai_disabled' | 'not_configured' | 'credential_missing';
  readonly mode: string;
  readonly message: string;
}

/**
 * Result of {@link runConnectionTest}: EITHER the sanitised connection-test
 * result (`available: true`) OR the sanitised degraded state (`available:
 * false`). Both are 200-level outcomes — a failed CONNECTION is conveyed by
 * `result.outcome === 'failed'`, not by throwing.
 */
export type ConnectionTestResponse =
  | { readonly available: true; readonly result: ConnectionTestResult }
  | { readonly available: false; readonly unavailable: AiUnavailable };

// ----------------------------------------------------------------------------
// Typed error.
// ----------------------------------------------------------------------------

/** Stable, machine-readable classification of an AI-client failure. */
export type AiClientErrorKind =
  /** No authenticated admin session / rejected token (401). */
  | 'unauthorized'
  /** Client- or server-side input validation failed (400). */
  | 'validation'
  /** The requested write endpoint is not yet deployed (documented seam). */
  | 'not_implemented'
  /** A read/query failure loading the settings. */
  | 'load_failed'
  /** Any other/unexpected failure (network, 5xx, malformed response). */
  | 'unknown';

/** A single field-level validation error (mirrors `EventFieldError`). */
export interface AiFieldError {
  readonly field: string;
  readonly message: string;
}

/**
 * Typed error thrown by the AI client helpers. Carries a `kind` for branching,
 * an optional per-field list (for form-level surfacing), and a sanitised,
 * user-safe `message` — never a raw provider/internal detail or any credential.
 */
export class AiClientError extends Error {
  readonly kind: AiClientErrorKind;
  readonly status?: number;
  readonly fields: readonly AiFieldError[];
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      kind: AiClientErrorKind;
      status?: number;
      fields?: readonly AiFieldError[];
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'AiClientError';
    this.kind = options.kind;
    this.status = options.status;
    this.fields = options.fields ?? [];
    this.cause = options.cause;
  }
}

// ----------------------------------------------------------------------------
// Edge-Function response narrowing (shared with ./moderation conventions).
// ----------------------------------------------------------------------------

interface EdgeErrorBody {
  error: {
    code?: string;
    message?: string;
    fields?: unknown;
  };
}

function isEdgeErrorBody(value: unknown): value is EdgeErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null;
}

/** Extracts a per-field error list from an Edge error body, when present. */
function toFieldErrors(body: EdgeErrorBody): AiFieldError[] {
  const raw = body.error.fields;
  if (!Array.isArray(raw)) return [];
  const out: AiFieldError[] = [];
  for (const item of raw) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { field?: unknown }).field === 'string' &&
      typeof (item as { message?: unknown }).message === 'string'
    ) {
      out.push({
        field: (item as { field: string }).field,
        message: (item as { message: string }).message,
      });
    }
  }
  return out;
}

/** Narrows an unknown value to the Gateway's degraded ("AI unavailable") shape. */
function isAiUnavailable(value: unknown): value is { ai: AiUnavailable } {
  if (typeof value !== 'object' || value === null) return false;
  const ai = (value as { ai?: unknown }).ai;
  if (typeof ai !== 'object' || ai === null) return false;
  const a = ai as Record<string, unknown>;
  return a.available === false && typeof a.reason === 'string';
}

/** Narrows an unknown value to a successful `connection_test` gateway payload. */
function isConnectionTestPayload(
  value: unknown,
): value is { connection_test: ConnectionTestResult } {
  if (typeof value !== 'object' || value === null) return false;
  const ct = (value as { connection_test?: unknown }).connection_test;
  if (typeof ct !== 'object' || ct === null) return false;
  const c = ct as Record<string, unknown>;
  return (
    typeof c.outcome === 'string' &&
    typeof c.model_id === 'string' &&
    typeof c.timestamp === 'string'
  );
}

/** Maps an Edge error body + HTTP status to a typed {@link AiClientError}. */
function toAiClientError(status: number, body: EdgeErrorBody): AiClientError {
  const code = body.error.code;
  const message = body.error.message;
  const fields = toFieldErrors(body);

  if (status === 401 || code === 'unauthorized') {
    return new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized', status },
    );
  }
  if (
    status === 400 ||
    code === 'validation_failed' ||
    code === 'invalid_json'
  ) {
    return new AiClientError(
      message ?? 'One or more fields are invalid.',
      { kind: 'validation', status, fields },
    );
  }
  if (status === 404 || code === 'not_found' || code === 'not_implemented') {
    return new AiClientError(
      'Saving AI settings is not available yet.',
      { kind: 'not_implemented', status },
    );
  }
  return new AiClientError(
    message ?? 'The AI operation could not be completed. Please try again.',
    { kind: 'unknown', status },
  );
}

/**
 * Reads the structured error body off a supabase-js `FunctionsHttpError`
 * (whose `.context` is a `Response`) and throws the mapped {@link AiClientError}.
 * Falls back to a generic sanitised error when no structured body is present.
 */
async function throwFromInvokeError(
  error: unknown,
  fallbackMessage: string,
): Promise<never> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    let parsedBody: unknown = null;
    try {
      parsedBody = await context.clone().json();
    } catch {
      parsedBody = null;
    }
    if (isEdgeErrorBody(parsedBody)) {
      throw toAiClientError(context.status, parsedBody);
    }
    if (context.status === 401) {
      throw new AiClientError(
        'Your session has expired. Please sign in again.',
        { kind: 'unauthorized', status: context.status, cause: error },
      );
    }
    if (context.status === 404) {
      throw new AiClientError('Saving AI settings is not available yet.', {
        kind: 'not_implemented',
        status: context.status,
        cause: error,
      });
    }
    throw new AiClientError(fallbackMessage, {
      kind: 'unknown',
      status: context.status,
      cause: error,
    });
  }
  // No response context (e.g. network failure) — generic unknown error.
  throw new AiClientError(fallbackMessage, { kind: 'unknown', cause: error });
}

// ----------------------------------------------------------------------------
// Session recency (300 s re-verify gate — Req 11.12, 12.11).
// ----------------------------------------------------------------------------

/**
 * Returns the age, in seconds, of the current authenticated session — measured
 * from the authenticated user's `last_sign_in_at` (the moment the session was
 * established or re-verified). Returns `null` when there is no user or the
 * timestamp is unavailable/unparseable (treated by callers as "must re-verify").
 *
 * The credential Replace/Remove controls use this to enforce the 300 s window
 * (Req 11.12, 12.11): if the session is older than
 * {@link CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS}, the action is gated behind
 * a re-verify prompt.
 */
export async function getSessionAgeSeconds(): Promise<number | null> {
  const user = await getCurrentUser();
  const lastSignInAt = user?.last_sign_in_at;
  if (!lastSignInAt) return null;
  const signedInAtMs = Date.parse(lastSignInAt);
  if (Number.isNaN(signedInAtMs)) return null;
  const ageMs = Date.now() - signedInAtMs;
  // Guard against clock skew producing a small negative age → treat as fresh.
  return ageMs < 0 ? 0 : Math.floor(ageMs / 1000);
}

/**
 * True when the current session was established / re-verified within the last
 * {@link CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS} seconds — i.e. a credential
 * Replace/Remove may proceed WITHOUT a fresh re-verify (Req 11.12, 12.11). A
 * missing/unknown session age is treated as NOT recent (fail closed): the UI
 * will require re-verification.
 */
export async function isSessionRecentlyVerified(): Promise<boolean> {
  const age = await getSessionAgeSeconds();
  if (age === null) return false;
  return age <= CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS;
}

// ----------------------------------------------------------------------------
// (d) Read path — NON-SECRET active provider settings + credential_state.
// ----------------------------------------------------------------------------

/** Narrows an untyped RPC row to {@link AiProviderSettingsPublic}. */
function isProviderSettingsRow(value: unknown): value is AiProviderSettingsPublic {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.ai_enabled === 'boolean' &&
    typeof v.display_name === 'string' &&
    typeof v.provider_type === 'string' &&
    typeof v.base_url === 'string' &&
    typeof v.chat_completions_path === 'string' &&
    typeof v.auth_type === 'string' &&
    (v.api_key_header_name === null ||
      typeof v.api_key_header_name === 'string') &&
    typeof v.model_id === 'string' &&
    typeof v.credential_state === 'string'
  );
}

/**
 * Reads the single ACTIVE AI provider config via the whitelisted NON-SECRET
 * read path (`read_ai_provider_settings()`), or `null` when none is configured.
 *
 * Returns ONLY non-secret columns plus `credential_state`; the credential value
 * is NEVER part of the projection and can never be returned to the client
 * (Req 12.1, 12.8, 12.10). Requires an authenticated admin session (the RPC's
 * EXECUTE grant is `authenticated`-only).
 *
 * @throws {AiClientError} on a missing session (`unauthorized`) or a
 *   transport/query failure (`load_failed`).
 */
export async function readAiProviderSettings(): Promise<AiProviderSettingsPublic | null> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }

  const { data, error } = await supabase.rpc(READ_AI_PROVIDER_SETTINGS_RPC);

  if (error) {
    throw new AiClientError(
      'The AI settings could not be loaded. Please check your connection and try again.',
      { kind: 'load_failed', cause: error },
    );
  }

  // `RETURNS TABLE (...)` yields an array (0 or 1 row for the active config).
  const row = Array.isArray(data) ? data[0] : data;
  if (row == null) return null;
  if (!isProviderSettingsRow(row)) {
    throw new AiClientError(
      'The AI settings response was malformed.',
      { kind: 'unknown', cause: data },
    );
  }
  return row;
}

// ----------------------------------------------------------------------------
// (a) Connection test — WIRED via the `ai-gateway` Edge Function (task 29.5).
// ----------------------------------------------------------------------------

/**
 * Invokes the AI Gateway `connection_test` job and returns ONLY the sanitised
 * result (Req 13.1, 25.7), or the sanitised degraded state when AI is not
 * usable yet (disabled / not configured / credential required — Req 19.1).
 *
 * The Gateway makes NO persisted config change (Req 13.5) and never leaks
 * provider internals or the credential (Req 13.10). A FAILED connection is a
 * 200-level outcome conveyed by `result.outcome === 'failed'` with a fixed
 * `failure_category` — it does NOT throw. This method only throws for
 * transport/auth failures.
 *
 * @throws {AiClientError} on a missing session or a transport/auth failure.
 */
export async function runConnectionTest(): Promise<ConnectionTestResponse> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }

  const { data, error } = await supabase.functions.invoke(AI_GATEWAY_FUNCTION, {
    body: { job_type: 'connection_test' },
  });

  if (error) {
    await throwFromInvokeError(
      error,
      'The connection test could not be completed. Please try again.',
    );
  }

  // A structured error surfaced in the success channel (some supabase-js paths).
  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status = code === 'unauthorized' ? 401 : 500;
    throw toAiClientError(status, data);
  }

  // Degraded / "AI unavailable" — a normal, non-error state (Req 19.1).
  if (isAiUnavailable(data)) {
    return { available: false, unavailable: data.ai };
  }

  if (isConnectionTestPayload(data)) {
    return { available: true, result: data.connection_test };
  }

  throw new AiClientError(
    'The connection test returned an unexpected response. Please try again.',
    { kind: 'unknown', cause: data },
  );
}

// ----------------------------------------------------------------------------
// (b) Save / replace provider settings + write-only credential (SEAM).
// ----------------------------------------------------------------------------

/**
 * Input to {@link saveAiProviderSettings}: the validated provider settings. The
 * optional `credential` is WRITE-ONLY — when present it replaces the stored
 * credential (Req 11.12, 12.11); when omitted the existing stored credential is
 * left untouched. The credential is submitted ONLY over this authenticated
 * HTTPS write path and is NEVER read back (Req 12.1, 12.10).
 */
export type SaveAiProviderSettingsInput = AiProviderSettingsInput;

/**
 * Saves / replaces the AI provider settings via the SERVICE-ROLE AI-config
 * Edge Function ({@link AI_CONFIG_FUNCTION}).
 *
 * SEAM (Req 21.6): the client has no write policy on `ai_provider_settings`;
 * all writes are server-mediated. For V1 the write endpoint is not yet deployed,
 * so a `FunctionsHttpError` 404 (or transport failure) surfaces as a typed
 * `not_implemented` {@link AiClientError} — the screen presents this clearly
 * rather than silently failing. The plaintext credential is transmitted only in
 * this authenticated request body and is never persisted as plaintext server-side
 * (Req 12.4).
 *
 * @throws {AiClientError} — `unauthorized` (no session), `validation` (server
 *   rejected fields), `not_implemented` (endpoint not deployed), or `unknown`.
 */
export async function saveAiProviderSettings(
  input: SaveAiProviderSettingsInput,
): Promise<AiProviderSettingsPublic> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }

  const { data, error } = await supabase.functions.invoke(AI_CONFIG_FUNCTION, {
    body: { action: 'save', settings: input },
  });

  if (error) {
    await throwFromInvokeError(
      error,
      'The AI settings could not be saved. Please try again.',
    );
  }

  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status =
      code === 'unauthorized'
        ? 401
        : code === 'validation_failed' || code === 'invalid_json'
          ? 400
          : code === 'not_found' || code === 'not_implemented'
            ? 404
            : 500;
    throw toAiClientError(status, data);
  }

  // The write endpoint echoes back the NON-SECRET saved config (never the
  // credential). Re-read defensively if the shape is not the expected row.
  const settings = (data as { settings?: unknown } | null)?.settings ?? data;
  if (isProviderSettingsRow(settings)) {
    return settings;
  }
  const reread = await readAiProviderSettings();
  if (reread) return reread;
  throw new AiClientError(
    'The AI settings may have been saved but the server response was malformed.',
    { kind: 'unknown', cause: data },
  );
}

// ----------------------------------------------------------------------------
// (c) Remove the stored credential (SEAM).
// ----------------------------------------------------------------------------

/**
 * Removes the stored credential via the SERVICE-ROLE AI-config Edge Function
 * ({@link AI_CONFIG_FUNCTION}) (Req 11.13, 12.11).
 *
 * SEAM: same server-mediated posture as {@link saveAiProviderSettings}. The
 * screen enforces the 300 s re-verify gate ({@link isSessionRecentlyVerified})
 * and an explicit confirmation step (Req 11.13) BEFORE calling this. No
 * credential value is ever sent or returned; this only clears the stored
 * reference/ciphertext server-side.
 *
 * @throws {AiClientError} — `unauthorized`, `not_implemented`, or `unknown`.
 */
export async function removeAiCredential(): Promise<AiProviderSettingsPublic | null> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }

  const { data, error } = await supabase.functions.invoke(AI_CONFIG_FUNCTION, {
    body: { action: 'remove_credential' },
  });

  if (error) {
    await throwFromInvokeError(
      error,
      'The credential could not be removed. Please try again.',
    );
  }

  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status =
      code === 'unauthorized'
        ? 401
        : code === 'not_found' || code === 'not_implemented'
          ? 404
          : 500;
    throw toAiClientError(status, data);
  }

  const settings = (data as { settings?: unknown } | null)?.settings ?? data;
  if (isProviderSettingsRow(settings)) {
    return settings;
  }
  // The removal succeeded but no row was echoed — re-read the current state.
  return readAiProviderSettings();
}


// ----------------------------------------------------------------------------
// (e) Categorisation job — WIRED via the `ai-gateway` Edge Function (task 30.1).
// ----------------------------------------------------------------------------

/**
 * The sanitised, client-safe summary of a categorisation run returned by the
 * Gateway (mirrors `CategorisationJobResult` in
 * `supabase/functions/ai-gateway/jobs/categorisation.ts`). It carries ONLY
 * aggregate counts — NEVER raw model text, prompts, provider internals, or the
 * credential (Req 20.7).
 */
export interface CategorisationSummary {
  /** Candidate questions selected (post hidden-exclusion, Req 15.10). */
  readonly candidate_count: number;
  /** Number of ≤100 batches submitted (Req 15.1). */
  readonly batch_count: number;
  /** Questions whose category was stored (Req 15.5, 15.9). */
  readonly categorised_count: number;
  /** Batches rejected by server-side validation (Req 15.4). */
  readonly rejected_batches: number;
}

/**
 * Result of {@link runCategorisation}: EITHER the sanitised run summary
 * (`available: true`) OR the sanitised degraded state (`available: false`) when
 * AI is disabled / not configured / a credential is required (Req 19.1). Both
 * are 200-level outcomes; a recoverable provider/validation failure surfaces as
 * a thrown {@link AiClientError} (kind `unknown`).
 */
export type CategorisationResponse =
  | { readonly available: true; readonly summary: CategorisationSummary }
  | { readonly available: false; readonly unavailable: AiUnavailable };

/** Options for {@link runCategorisation}. */
export interface RunCategorisationOptions {
  /**
   * When `true`, hidden questions are ALSO categorised; otherwise they are
   * excluded (the default, Req 15.10). Maps to the Gateway's `include_hidden`.
   */
  readonly includeHidden?: boolean;
}

/** Narrows an unknown value to a successful `categorisation` gateway payload. */
function isCategorisationPayload(
  value: unknown,
): value is { categorisation: CategorisationSummary } {
  if (typeof value !== 'object' || value === null) return false;
  const c = (value as { categorisation?: unknown }).categorisation;
  if (typeof c !== 'object' || c === null) return false;
  const s = c as Record<string, unknown>;
  return (
    typeof s.candidate_count === 'number' &&
    typeof s.batch_count === 'number' &&
    typeof s.categorised_count === 'number' &&
    typeof s.rejected_batches === 'number'
  );
}

/**
 * Triggers the AI categorisation JOB for an event via the `ai-gateway` Edge
 * Function (task 30.1) and returns ONLY the sanitised run summary (Req 15.1,
 * 15.3–15.6, 15.9, 15.10), or the sanitised degraded state when AI is not
 * usable yet (Req 19.1).
 *
 * The Gateway selects the candidate questions (hidden EXCLUDED unless
 * `includeHidden` is set), chunks them into ≤100 batches, validates each
 * provider response server-side against the shared contract (a single invalid
 * category rejects the WHOLE batch — Req 15.4), and stores each valid item's
 * category, touching ONLY the category fields so the original text is preserved
 * (Req 15.9). It never returns raw model text (Req 20.7).
 *
 * A recoverable provider/validation failure (HTTP 502 with an `error` body) is
 * surfaced as a thrown `unknown` {@link AiClientError} so the queue can show a
 * retry affordance; the CORE flow is unaffected (Req 19.1).
 *
 * @throws {AiClientError} on a missing session, a transport/auth failure, or a
 *   recoverable provider/validation failure.
 */
export async function runCategorisation(
  eventId: string,
  options: RunCategorisationOptions = {},
): Promise<CategorisationResponse> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }
  if (!eventId) {
    throw new AiClientError('No event was specified.', {
      kind: 'validation',
    });
  }

  const { data, error } = await supabase.functions.invoke(AI_GATEWAY_FUNCTION, {
    body: {
      job_type: 'categorisation',
      event_id: eventId,
      include_hidden: options.includeHidden === true,
    },
  });

  if (error) {
    await throwFromInvokeError(
      error,
      'Categorising the questions could not be completed. Please try again.',
    );
  }

  // A structured error surfaced in the success channel (e.g. the 502 recoverable
  // provider/validation failure the Gateway returns with an `error` body).
  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status = code === 'unauthorized' ? 401 : 500;
    throw toAiClientError(status, data);
  }

  // Degraded / "AI unavailable" — a normal, non-error state (Req 19.1).
  if (isAiUnavailable(data)) {
    return { available: false, unavailable: data.ai };
  }

  if (isCategorisationPayload(data)) {
    return { available: true, summary: data.categorisation };
  }

  throw new AiClientError(
    'Categorising the questions returned an unexpected response. Please try again.',
    { kind: 'unknown', cause: data },
  );
}

// ----------------------------------------------------------------------------
// (f) Moderator category override (SEAM — task 30.1 `applyModeratorOverride`).
// ----------------------------------------------------------------------------

/**
 * Whether `value` is one of the eight allowed question categories (exact,
 * case-sensitive — Req 15.3). Re-exported from the shared pure rule so the
 * moderation UI CONSTRAINS the override selection to the eight without
 * duplicating the list. Narrows to {@link AiCategory} on success.
 *
 * The UI restricts the override `<select>` to these values so an invalid
 * category can never be chosen client-side; the server ADDITIONALLY enforces
 * "retain the prior assignment on an invalid selection" (Req 15.8) as the
 * authoritative guarantee.
 */
export function isValidOverrideCategory(value: unknown): value is AiCategory {
  return isValidCategory(value);
}

/** Input to {@link overrideQuestionCategory}. */
export interface OverrideQuestionCategoryInput {
  /** The id of the question whose AI category to override. */
  readonly questionId: string;
  /**
   * The proposed category — MUST be one of the eight allowed values. The client
   * validates this before calling (Req 15.3); the server re-validates and
   * retains the prior assignment on an invalid value (Req 15.8).
   */
  readonly category: AiCategory;
  /** Optional event scope, forwarded to the override endpoint when present. */
  readonly eventId?: string;
}

/**
 * The sanitised result of a successful moderator override (mirrors the
 * `applied: true` branch of `ModeratorOverrideResult` in the gateway module):
 * the newly-applied category and the prior category the server recorded into
 * `ai_prior_category` (Req 15.7).
 */
export interface OverrideQuestionCategoryResult {
  readonly applied: true;
  /** The category now assigned to the question (Req 15.7). */
  readonly ai_category: AiCategory;
  /** The category recorded as the prior assignment (Req 15.7). */
  readonly ai_prior_category: string | null;
}

/** Narrows an unknown value to a successful override payload. */
function isOverrideSuccess(value: unknown): value is {
  applied: true;
  ai_category: string;
  ai_prior_category: string | null;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.applied === true &&
    typeof v.ai_category === 'string' &&
    (v.ai_prior_category === null || typeof v.ai_prior_category === 'string')
  );
}

/**
 * Applies a MODERATOR OVERRIDE of a question's AI category via the SERVICE-ROLE
 * categorisation-override Edge Function ({@link AI_CATEGORISE_OVERRIDE_FUNCTION};
 * task 30.1 `applyModeratorOverride`).
 *
 * SEAM (Req 21.6): the client has no UPDATE policy on `questions`; the category
 * write is server-mediated. The override endpoint is not yet wired into
 * `ai-gateway/index.ts`, so a `FunctionsHttpError` 404 (or transport failure)
 * surfaces as a typed `not_implemented` {@link AiClientError} — the queue
 * presents this clearly rather than silently failing.
 *
 * The client REJECTS a non-allowed category up front (Req 15.3) so an invalid
 * override is never submitted. Server-side, `applyModeratorOverride`
 * AUTHORITATIVELY records the prior category into `ai_prior_category` on a valid
 * override (Req 15.7) and RETAINS the prior assignment, changing nothing, on an
 * invalid one (Req 15.8); the write touches ONLY the category fields, so the
 * question text is preserved (Req 15.9).
 *
 * @throws {AiClientError} — `unauthorized` (no session), `validation` (invalid
 *   category or missing id), `not_found` (question missing), `not_implemented`
 *   (endpoint not wired), or `unknown`.
 */
export async function overrideQuestionCategory(
  input: OverrideQuestionCategoryInput,
): Promise<OverrideQuestionCategoryResult> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }
  if (!input.questionId) {
    throw new AiClientError('No question was specified.', {
      kind: 'validation',
    });
  }
  // Constrain the override to the eight allowed categories BEFORE any network
  // call so an invalid category is never submitted (Req 15.3). The server also
  // retains the prior assignment on an invalid value (Req 15.8).
  if (!isValidOverrideCategory(input.category)) {
    throw new AiClientError(
      'Please choose one of the available categories.',
      { kind: 'validation' },
    );
  }

  const { data, error } = await supabase.functions.invoke(
    AI_CATEGORISE_OVERRIDE_FUNCTION,
    {
      body: {
        question_id: input.questionId,
        category: input.category,
        ...(input.eventId ? { event_id: input.eventId } : {}),
      },
    },
  );

  if (error) {
    await throwFromInvokeError(
      error,
      'The category could not be updated. Please try again.',
    );
  }

  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status =
      code === 'unauthorized'
        ? 401
        : code === 'validation_failed' || code === 'invalid_json'
          ? 400
          : code === 'not_found' || code === 'not_implemented'
            ? 404
            : 500;
    throw toAiClientError(status, data);
  }

  if (isOverrideSuccess(data)) {
    return {
      applied: true,
      ai_category: data.ai_category as AiCategory,
      ai_prior_category: data.ai_prior_category,
    };
  }

  throw new AiClientError(
    'The category may have been updated but the server response was malformed.',
    { kind: 'unknown', cause: data },
  );
}


// ----------------------------------------------------------------------------
// (g) Theme-insights job — WIRED via the `ai-gateway` Edge Function (task 32.1).
// ----------------------------------------------------------------------------

/**
 * Result of {@link runThemeInsights}: EITHER the sanitised theme-insights result
 * (`available: true`) OR the sanitised degraded state (`available: false`) when
 * AI is disabled / not configured / a credential is required (Req 19.1). Both
 * are 200-level outcomes; a recoverable provider/validation failure surfaces as
 * a thrown {@link AiClientError} (kind `unknown`).
 *
 * The `has_data: false` empty-event case (Req 17.5) is conveyed WITHIN the
 * `available: true` branch (all four arrays empty + `has_data === false`), not
 * as an error — the presenter renders a graceful "no insights yet" state.
 */
export type ThemeInsightsResponse =
  | { readonly available: true; readonly insights: AiThemeInsightsResult }
  | { readonly available: false; readonly unavailable: AiUnavailable };

/**
 * Narrows an unknown value to a successful `theme_insights` gateway payload and
 * VALIDATES it against the shared {@link aiThemeInsightsResultSchema} (Req 14.2).
 * The gateway already validates server-side; re-validating here guarantees the
 * presenter only ever renders a well-formed, capped, grounded shape and never a
 * malformed payload. Returns the parsed insights on success, or `null` when the
 * payload is absent/malformed (the caller then throws a sanitised `unknown`).
 */
function parseThemeInsightsPayload(
  value: unknown,
): AiThemeInsightsResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const ti = (value as { theme_insights?: unknown }).theme_insights;
  if (typeof ti !== 'object' || ti === null) return null;
  const parsed = aiThemeInsightsResultSchema.safeParse(ti);
  return parsed.success ? parsed.data : null;
}

/**
 * Triggers the AI theme-insights JOB for an event via the `ai-gateway` Edge
 * Function (task 32.1) and returns ONLY the sanitised, schema-validated
 * theme-insights result (Req 17.1) — the ≤5 top themes, ≤5 emerging concerns,
 * ≤10 frequent topics, and ≤5 notable high-vote questions — or the sanitised
 * degraded state when AI is not usable yet (Req 19.1).
 *
 * The result is grounded: the notable high-vote questions carry their real
 * `vote_count` + text (never invented — Req 17.2, 17.4), and the empty-event
 * case is `has_data: false` with all four arrays empty (Req 17.5). No provider
 * internals, prompts, or the credential are ever returned (Req 20.7). All the
 * strings are surfaced to the presenter as PLAIN TEXT (Req 14.8) — the caller
 * renders them as text content, never as markup.
 *
 * A recoverable provider/validation failure (HTTP 502 with an `error` body) is
 * surfaced as a thrown `unknown` {@link AiClientError} so the presenter can
 * fall back gracefully; the CORE flow is unaffected (Req 19.1).
 *
 * @throws {AiClientError} on a missing session, a transport/auth failure, a
 *   recoverable provider/validation failure, or a malformed success payload.
 */
export async function runThemeInsights(
  eventId: string,
): Promise<ThemeInsightsResponse> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }
  if (!eventId) {
    throw new AiClientError('No event was specified.', {
      kind: 'validation',
    });
  }

  const { data, error } = await supabase.functions.invoke(AI_GATEWAY_FUNCTION, {
    body: { job_type: 'theme_insights', event_id: eventId },
  });

  if (error) {
    await throwFromInvokeError(
      error,
      'The theme insights could not be generated. Please try again.',
    );
  }

  // A structured error surfaced in the success channel (e.g. the 502 recoverable
  // provider/validation failure the Gateway returns with an `error` body).
  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status = code === 'unauthorized' ? 401 : 500;
    throw toAiClientError(status, data);
  }

  // Degraded / "AI unavailable" — a normal, non-error state (Req 19.1).
  if (isAiUnavailable(data)) {
    return { available: false, unavailable: data.ai };
  }

  const insights = parseThemeInsightsPayload(data);
  if (insights) {
    return { available: true, insights };
  }

  throw new AiClientError(
    'The theme insights returned an unexpected response. Please try again.',
    { kind: 'unknown', cause: data },
  );
}


// ----------------------------------------------------------------------------
// (h) End-of-event summary job — WIRED via the `ai-gateway` Edge Function
//     (task 33.1). Client helper for the admin summary screen (task 34.4).
// ----------------------------------------------------------------------------

/**
 * The sanitised, client-safe result of a successful end-of-event summary run
 * (mirrors the `ok: true` branch of `SummaryJobResult` in
 * `supabase/functions/ai-gateway/jobs/summary.ts`, surfaced by the gateway as
 * `{ summary_markdown, ai_interpretation_available, question_count }`).
 *
 * The calculated report is ALWAYS produced server-side (Req 18.7): `markdown`
 * carries the "## Calculated Data" section (computed directly from the DB,
 * independently of the model — Req 18.1, 18.4) followed by the separate
 * "## AI Interpretation" section — which contains the AI-Generated content when
 * `aiInterpretationAvailable` is `true`, or a visible "AI content could not be
 * produced" notice when it is `false` (Req 18.5, 18.6, 18.7). The screen ALSO
 * surfaces a prominent UI banner in the latter case.
 *
 * `markdown` is INERT plain text (Req 14.8): every AI-produced string is already
 * plain-text/Markdown escaped server-side and the SPA renders it as literal text
 * content — never parsed or executed as HTML/script.
 */
export interface EventSummary {
  /** The full Markdown report (calculated sections + AI-interpretation/notice). */
  readonly markdown: string;
  /**
   * `true` when the "## AI Interpretation" section carries AI-Generated content;
   * `false` when the AI was unavailable/failed and the section carries the
   * visible unavailable notice instead (Req 18.7).
   */
  readonly aiInterpretationAvailable: boolean;
  /** Number of questions considered for the event's summary. */
  readonly questionCount: number;
}

/**
 * Result of {@link runSummary}: EITHER the sanitised summary
 * (`available: true`) OR the sanitised degraded state (`available: false`) when
 * the enablement precondition fails BEFORE any report — AI disabled / not
 * configured / a credential is required (Req 19.1). Both are 200-level outcomes.
 *
 * NOTE — the degraded (`available: false`) branch is the ENABLEMENT-precondition
 * path only. When AI is enabled but the interpretation itself fails (provider
 * unreachable, timeout, invalid response), the gateway STILL returns
 * `available: true` with a full calculated report and
 * `aiInterpretationAvailable: false` (the in-report AI-unavailable notice —
 * Req 18.7). A recoverable failure that prevents even the calculated report
 * (e.g. the event cannot be resolved) surfaces as a thrown
 * {@link AiClientError} (kind `unknown`); the CORE flow is unaffected (Req 19.1).
 */
export type SummaryResponse =
  | { readonly available: true; readonly summary: EventSummary }
  | { readonly available: false; readonly unavailable: AiUnavailable };

/** Narrows an unknown value to a successful `summary` gateway payload. */
function isSummaryPayload(value: unknown): value is {
  summary_markdown: string;
  ai_interpretation_available: boolean;
  question_count?: unknown;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary_markdown === 'string' &&
    typeof v.ai_interpretation_available === 'boolean'
  );
}

/**
 * Triggers the end-of-event summary JOB for an event via the `ai-gateway` Edge
 * Function (task 33.1) and returns ONLY the sanitised summary (Req 18.1, 18.4,
 * 18.7), or the sanitised degraded state when AI is not usable yet (Req 19.1).
 *
 * The gateway ALWAYS produces the calculated report from the DB (Req 18.4):
 * `summary.markdown` contains the "## Calculated Data" section and a separate
 * "## AI Interpretation" section — the latter carrying AI-Generated content
 * (`aiInterpretationAvailable === true`) or the visible AI-unavailable notice
 * (`aiInterpretationAvailable === false`, Req 18.7). The report is INERT plain
 * text; the screen renders it literally, never as HTML/script (Req 14.8). No
 * provider internals, prompts, or the credential are ever returned (Req 20.7).
 *
 * A recoverable failure that prevents even the calculated report (HTTP 502 with
 * an `error` body — e.g. the event cannot be resolved) is surfaced as a thrown
 * `unknown` {@link AiClientError} so the screen can offer a retry; the CORE flow
 * is unaffected (Req 19.1).
 *
 * @throws {AiClientError} on a missing session, a transport/auth failure, a
 *   recoverable failure that prevents the report, or a malformed success payload.
 */
export async function runSummary(eventId: string): Promise<SummaryResponse> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new AiClientError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized' },
    );
  }
  if (!eventId) {
    throw new AiClientError('No event was specified.', {
      kind: 'validation',
    });
  }

  const { data, error } = await supabase.functions.invoke(AI_GATEWAY_FUNCTION, {
    body: { job_type: 'summary', event_id: eventId },
  });

  if (error) {
    await throwFromInvokeError(
      error,
      'The summary could not be generated. Please try again.',
    );
  }

  // A structured error surfaced in the success channel (e.g. the 502 the gateway
  // returns with an `error` body when the event cannot be resolved).
  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status = code === 'unauthorized' ? 401 : 500;
    throw toAiClientError(status, data);
  }

  // Degraded / "AI unavailable" — a normal, non-error state (Req 19.1). This is
  // the enablement-precondition path (before any calculated report).
  if (isAiUnavailable(data)) {
    return { available: false, unavailable: data.ai };
  }

  if (isSummaryPayload(data)) {
    const questionCount =
      typeof data.question_count === 'number' &&
      Number.isFinite(data.question_count)
        ? data.question_count
        : 0;
    return {
      available: true,
      summary: {
        markdown: data.summary_markdown,
        aiInterpretationAvailable: data.ai_interpretation_available,
        questionCount,
      },
    };
  }

  throw new AiClientError(
    'The summary returned an unexpected response. Please try again.',
    { kind: 'unknown', cause: data },
  );
}
