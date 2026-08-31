// =============================================================================
// AI GATEWAY — CORE MODULE (Supabase Edge Functions / Deno runtime)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module holds the provider-agnostic *core* of the AI Gateway — the
//  SINGLE server-side egress to any AI provider (Req 11, 20). It is deliberately
//  factored out of `index.ts` (the HTTP handler) so that the invariant-bearing
//  logic — the AI enablement precondition, credential resolution/discard, the
//  minimal-payload construction, the hard-timeout wrapper, and the `ai_jobs`
//  lifecycle logging — is expressed as small, well-seamed units that the later
//  Wave tasks slot into:
//
//    - 29.2  SSRF module (resolve + allowlist the destination IP) — DONE      → `preflightDestination` seam (see ./ssrf.ts)
//    - 29.3  provider adapter (openai_compatible + custom_adapter) — DONE   → `callProvider` seam (see ./adapter.ts)
//    - 29.4  structured-output validation + bounded retries               → wraps `callProvider`
//    - 29.5  connection test                                              → `job_type = 'connection_test'`
//    - 30.1/31.1/32.1/33.1  categorisation / clustering / theme / summary → `job_type` + inputs
//
//  What is REAL and complete NOW (task 29.1): the request contract, the
//  enablement precondition, the credential resolve-then-discard, the minimal
//  payload builder (question text ≤10,000 chars + aggregate metadata only, NO
//  participant identifiers), the hard AbortController timeout capped at 30 s,
//  and the pending→running→succeeded/failed `ai_jobs` logging (with
//  attempt_count, model_id, sanitised_error and NEVER credentials/full prompt).
//
//  Completed in 29.3: the `callProvider` seam now dispatches to the provider
//  adapter layer (`./adapter.ts`) — a first-class `openai_compatible` adapter
//  plus a documented `custom_adapter` extension point — and performs the outbound
//  chat-completions call through the SSRF-pinned fetch. Structured-output
//  validation (the JSON-schema contract) is layered on next by task 29.4.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*`, the `jsr:`
//  supabase import and the `npm:zod@4` import are resolved by the Supabase Edge
//  Functions / Deno toolchain at deploy time.
//
//  Requirements traceability: 11.1, 11.9, 12.3, 12.5, 12.6, 12.7, 13.1, 13.4,
//  13.6, 13.7, 13.8, 13.9, 13.10, 13.12, 14.5, 19.1, 20.1, 20.3, 20.6, 20.7.
//  Design references: Server-Side AI Gateway Design (Responsibilities; AI
//  enablement precondition; AI job sequence; Failure handling / degraded mode;
//  AI data handling / privacy).
// =============================================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  CredentialResolutionError,
  resolveEncryptedCredential,
} from '../_shared/aiCredential.ts';
import {
  DisallowedDestinationError,
  createPinnedFetch,
  type PreflightResult,
  preflightDestination,
} from './ssrf.ts';
import { ProviderCallError, callChatCompletion } from './adapter.ts';
import {
  RestrictedDataError,
  assertNoParticipantIdentifiers,
} from './payloadGuard.ts';
import {
  MAX_STRUCTURED_OUTPUT_ATTEMPTS,
  type ValidationFailureReason,
  isStructuredOutputJobType,
  shouldRetryAfterValidationFailure,
  validateStructuredOutput,
} from './structuredOutput.ts';
import {
  backoffDelay,
  planManualRetry,
  shouldAutoRetry,
} from './degradedMode.ts';

// -----------------------------------------------------------------------------
// Request contract (job_type + event_id + inputs).
//
// Every AI operation enters the Gateway through the same request shape so the
// per-job-type tasks (30.1/31.1/32.1/33.1) add themselves by handling a new
// `job_type` and its `inputs`, not by adding a new egress path. `index.ts` owns
// the zod validation of the wire body; these are the internal types the core
// operates on.
// -----------------------------------------------------------------------------

/** The AI job types — mirrors the DB `ai_job_type` enum (Req 20.6). */
export const AI_JOB_TYPES = [
  'categorisation',
  'clustering',
  'theme_insights',
  'summary',
  'connection_test',
] as const;
export type AiJobType = (typeof AI_JOB_TYPES)[number];

/** The AI job lifecycle statuses — mirrors the DB `ai_job_status` enum. */
export type AiJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** Outbound auth scheme — mirrors the DB `ai_auth_type` enum (Req 11.5). */
export type AiAuthType = 'bearer' | 'api_key_header' | 'none';

/**
 * A validated Gateway request. `event_id` is optional because some operations
 * (e.g. a `connection_test`) are not scoped to a single event, matching the
 * nullable `ai_jobs.event_id` FK. `questionTexts` is the raw candidate input
 * the minimal-payload builder truncates and strips before transmission;
 * `aggregateMetadata` carries ONLY non-identifying counts/labels.
 */
export interface GatewayRequest {
  readonly jobType: AiJobType;
  readonly eventId: string | null;
  readonly questionTexts: readonly string[];
  readonly aggregateMetadata: Readonly<Record<string, number | string>>;
}

// -----------------------------------------------------------------------------
// Non-secret AI provider configuration (read from the single active row).
//
// This is the whitelisted, NON-SECRET projection the Gateway reads from
// `ai_provider_settings WHERE is_active`. The credential fields (`secretReference`
// / `encryptedCredential`) are presence-only inputs to the enablement
// precondition; the plaintext is resolved separately, immediately before use.
// -----------------------------------------------------------------------------

export interface ActiveProviderConfig {
  readonly aiEnabled: boolean;
  readonly providerType: 'openai_compatible' | 'custom_adapter';
  readonly baseUrl: string;
  readonly chatCompletionsPath: string;
  readonly authType: AiAuthType;
  readonly apiKeyHeaderName: string | null;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly requestTimeoutSeconds: number;
  readonly tlsVerifyRequired: boolean;
  /** Presence-only: the actual pointer is used only at resolve time. */
  readonly secretReference: string | null;
  /** Presence-only ciphertext: decrypted only at resolve time (Req 12.7). */
  readonly encryptedCredential: Uint8Array | null;
}

// -----------------------------------------------------------------------------
// Payload / timeout bounds (Req 20.3, 14.5, 19.1).
// -----------------------------------------------------------------------------

/** Question text is truncated to at most 10,000 chars before transmission (Req 20.3). */
export const MAX_QUESTION_TEXT_CHARS = 10_000;

/** Hard cap on the per-request timeout regardless of admin config (Req 14.5). */
export const MAX_REQUEST_TIMEOUT_SECONDS = 30;

/** Fallback timeout when the admin value is missing/out of range (Req 19.1). */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;

// -----------------------------------------------------------------------------
// Degraded / not-configured outcome (Req 19.1, 19.2).
//
// The enablement precondition and any AI failure resolve to a *degraded* state
// rather than an error that leaks provider internals. `index.ts` maps this to
// the sanitised "AI unavailable" response the SPA renders within 2 s (Req 19.2)
// while the core flow stays fully functional (Req 19.1).
// -----------------------------------------------------------------------------

export type DegradedReason =
  'ai_disabled' | 'not_configured' | 'credential_missing';

export interface DegradedOutcome {
  readonly available: false;
  readonly reason: DegradedReason;
}

// -----------------------------------------------------------------------------
// AI enablement precondition (Req 11.1, 11.9, 12.3, 12.5, 12.6, 19.1).
//
// PURE function — no I/O, no secrets — so it is trivially reviewable and (later)
// property-testable. The rule:
//
//   - `ai_enabled = false`               → degraded('ai_disabled'); NO call.
//   - `ai_enabled = true` AND
//     `auth_type != 'none'` AND
//     NEITHER secret_reference NOR
//     encrypted_credential present       → degraded('credential_missing'); NO
//                                          unauthenticated call is EVER made.
//   - otherwise                          → { available: true }; the caller may
//                                          proceed to resolve the credential and
//                                          call the provider.
//
// When `auth_type = 'none'` a missing credential is expected and permitted — the
// config is usable without one (the "none" warning is surfaced elsewhere in the
// config UI, Req 11.6). This mirrors the DB `credential_state` GENERATED column
// but is enforced HERE, before any provider call, so a missing credential never
// results in an unauthenticated outbound request.
// -----------------------------------------------------------------------------

export type EnablementResult = DegradedOutcome | { readonly available: true };

/** True when a stored credential of either kind is present (Req 12.3, 12.5, 12.6). */
export function hasStoredCredential(config: {
  readonly secretReference: string | null;
  readonly encryptedCredential: Uint8Array | null;
}): boolean {
  const hasRef =
    typeof config.secretReference === 'string' &&
    config.secretReference.length > 0;
  const hasEnc =
    config.encryptedCredential != null && config.encryptedCredential.length > 0;
  return hasRef || hasEnc;
}

/**
 * Evaluates the AI enablement precondition against the active config. Returns a
 * {@link DegradedOutcome} that the Gateway must honour WITHOUT any outbound call,
 * or `{ available: true }` when the config is usable.
 */
export function evaluateEnablement(
  config: Pick<
    ActiveProviderConfig,
    'aiEnabled' | 'authType' | 'secretReference' | 'encryptedCredential'
  > | null,
): EnablementResult {
  // No active config row at all → effectively unconfigured (Req 19.1).
  if (config == null) {
    return { available: false, reason: 'not_configured' };
  }
  // AI turned off → degraded, never call the provider (Req 11.9, 19.1).
  if (!config.aiEnabled) {
    return { available: false, reason: 'ai_disabled' };
  }
  // Enabled + a credential is REQUIRED (auth_type != 'none') but NONE is stored
  // → treat as effectively unconfigured; make NO unauthenticated call
  // (Req 11.1, 11.9, 12.3, 12.5, 12.6, 19.1).
  if (config.authType !== 'none' && !hasStoredCredential(config)) {
    return { available: false, reason: 'credential_missing' };
  }
  return { available: true };
}

// -----------------------------------------------------------------------------
// Minimal payload builder (Req 20.1, 20.3).
//
// PURE function. Produces the ONLY data ever sent to a provider:
//   - each question text truncated to ≤10,000 chars (Req 20.3), and
//   - aggregate metadata (counts/labels) ONLY.
// NO participant identifiers (name, email, phone, user id, IP) are ever included
// (Req 20.1). This builder does not accept identifier fields at all, so an
// identifier cannot leak through it by construction; task 29.4/34's
// pre-transmission guard adds a defence-in-depth scan (Req 20.2) on top.
// -----------------------------------------------------------------------------

export interface MinimalPayload {
  /** Question texts, each truncated to ≤10,000 chars (Req 20.3). */
  readonly questionTexts: readonly string[];
  /** Aggregate, non-identifying metadata only (Req 20.3). */
  readonly aggregateMetadata: Readonly<Record<string, number | string>>;
}

/** Truncates a single text to at most {@link MAX_QUESTION_TEXT_CHARS} (Req 20.3). */
export function truncateQuestionText(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }
  return text.length > MAX_QUESTION_TEXT_CHARS
    ? text.slice(0, MAX_QUESTION_TEXT_CHARS)
    : text;
}

/**
 * Builds the minimal payload from a validated request: truncates every question
 * text and passes through ONLY the aggregate metadata. No identifiers are
 * accepted or emitted (Req 20.1, 20.3).
 */
export function buildMinimalPayload(request: GatewayRequest): MinimalPayload {
  return {
    questionTexts: request.questionTexts.map(truncateQuestionText),
    aggregateMetadata: { ...request.aggregateMetadata },
  };
}

// -----------------------------------------------------------------------------
// Hard timeout wrapper (Req 14.5, 19.1).
//
// Runs an async operation under an AbortController whose deadline is the
// admin-configured `request_timeout_seconds`, CLAMPED to (0, 30] s. On timeout
// the controller aborts (so an in-flight adapter `fetch` is cancelled) and a
// {@link GatewayTimeoutError} is thrown. The clamp guarantees no request can run
// longer than the 30 s hard cap regardless of misconfiguration (Req 14.5).
// -----------------------------------------------------------------------------

/** Raised when an operation exceeds the (clamped) configured timeout (Req 14.5). */
export class GatewayTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super('AI request timed out.');
    this.name = 'GatewayTimeoutError';
  }
}

/**
 * Clamps the admin-configured timeout to a safe millisecond deadline in
 * `(0, MAX_REQUEST_TIMEOUT_SECONDS]`, defaulting when the value is
 * missing/NaN/≤0 (Req 14.5, 19.1).
 */
export function resolveTimeoutMs(requestTimeoutSeconds: unknown): number {
  const raw =
    typeof requestTimeoutSeconds === 'number' &&
    Number.isFinite(requestTimeoutSeconds)
      ? requestTimeoutSeconds
      : DEFAULT_REQUEST_TIMEOUT_SECONDS;
  const clamped = Math.min(Math.max(raw, 1), MAX_REQUEST_TIMEOUT_SECONDS);
  return Math.floor(clamped * 1000);
}

/**
 * Executes `op(signal)` under a hard deadline. The provided `AbortSignal` MUST
 * be forwarded to any outbound `fetch` so a timeout cancels the in-flight
 * request. Throws {@link GatewayTimeoutError} if the deadline elapses first.
 */
export async function withHardTimeout<T>(
  timeoutMs: number,
  op: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GatewayTimeoutError(timeoutMs));
    }, timeoutMs) as unknown as number;
  });
  try {
    return await Promise.race([op(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// -----------------------------------------------------------------------------
// Sanitised-error mapping (Req 12.8, 12.9, 20.7).
//
// Every error the Gateway logs to `ai_jobs.sanitised_error` or returns to the
// client is collapsed to a fixed, credential-free CATEGORY. Raw provider
// diagnostics, credential material, and full prompt text NEVER pass through
// here (Req 20.7, 13.10).
// -----------------------------------------------------------------------------

export type SanitisedErrorCode =
  | 'timeout'
  | 'credential_resolution_failed'
  | 'disallowed_destination'
  | 'restricted_data'
  | 'provider_not_implemented'
  | 'provider_error'
  | 'invalid_ai_response'
  | 'internal_error';

/** Stable, human-readable summaries — no secrets, no prompt, no raw diagnostics. */
const SANITISED_ERROR_MESSAGE: Readonly<Record<SanitisedErrorCode, string>> = {
  timeout: 'AI request timed out.',
  credential_resolution_failed: 'AI credential could not be resolved.',
  // SSRF denial (Req 13.9): a fixed category only — never the hostname, the
  // resolved IP, or a raw diagnostic (Req 13.1, 13.10).
  disallowed_destination: 'The AI destination is not allowed.',
  // Pre-transmission identifier guard denial (Req 20.2): the built payload was
  // found to contain a participant-identifier shape, so transmission was blocked
  // and no request was dispatched. A fixed category only — never the offending
  // value or which identifier it was beyond the category (Req 20.7).
  restricted_data: 'The AI request contained restricted participant data.',
  provider_not_implemented: 'AI provider call is not yet implemented.',
  provider_error: 'The AI provider returned an error.',
  // Structured-output validation failure after bounded retries (Req 14.4, 14.6,
  // 14.7): the provider responded but the output could not be validated against
  // the shared schema (or no candidate JSON was extractable). A fixed,
  // recoverable category — never the offending text, a schema path, or a raw
  // diagnostic (Req 13.10, 20.7).
  invalid_ai_response:
    'The AI response could not be validated. Please try again.',
  internal_error: 'The AI operation could not be completed.',
};

/** Marker error thrown by the not-yet-implemented provider seam (task 29.3). */
export class ProviderNotImplementedError extends Error {
  constructor() {
    super('AI provider call is not yet implemented.');
    this.name = 'ProviderNotImplementedError';
  }
}

/**
 * Maps an arbitrary thrown value to a sanitised `{ code, message }` pair safe to
 * persist in `ai_jobs` and return to the client. NEVER echoes the original
 * error's message when it might carry secrets/diagnostics (Req 12.9, 20.7).
 */
export function sanitiseError(err: unknown): {
  code: SanitisedErrorCode;
  message: string;
} {
  let code: SanitisedErrorCode;
  if (err instanceof GatewayTimeoutError) {
    code = 'timeout';
  } else if (err instanceof CredentialResolutionError) {
    code = 'credential_resolution_failed';
  } else if (err instanceof DisallowedDestinationError) {
    // Req 13.9, 13.10 — collapse to the fixed disallowed-destination category.
    code = 'disallowed_destination';
  } else if (err instanceof RestrictedDataError) {
    // Req 20.2 — the pre-transmission guard detected a participant identifier;
    // collapse to the fixed restricted-data category (never the offending value).
    code = 'restricted_data';
  } else if (err instanceof ProviderNotImplementedError) {
    code = 'provider_not_implemented';
  } else if (err instanceof ProviderCallError) {
    // Any adapter transport/shape failure (incl. custom-adapter-not-configured)
    // collapses to the fixed provider-error category — never a raw diagnostic,
    // provider header, body, or credential (Req 13.10, 20.7).
    code = 'provider_error';
  } else {
    code = 'internal_error';
  }
  return { code, message: SANITISED_ERROR_MESSAGE[code] };
}

// -----------------------------------------------------------------------------
// ai_jobs lifecycle logging (Req 20.6, 20.7).
//
// A tiny recorder around the `ai_jobs` audit table. It writes ONLY sanitised
// operational metadata: job_type, status, started_at/ended_at, model_id,
// attempt_count and a sanitised_error CATEGORY message — NEVER credentials or
// full prompt text (Req 12.9, 20.7). It follows the moderate-question
// convention: a failed audit write is logged server-side but does NOT itself
// fail the operation.
//
// Lifecycle: insert `pending` (attempt 0) → mark `running` (attempt 1) → finish
// `succeeded` / `failed` with the terminal attempt_count and ended_at.
// -----------------------------------------------------------------------------

export interface AiJobRecorder {
  /** The audit row id, or null if the initial insert failed. */
  readonly jobId: string | null;
  /** Transition the job to `running` and record the attempt number. */
  markRunning(attemptCount: number): Promise<void>;
  /** Terminal success — records ended_at, model_id and final attempt count. */
  markSucceeded(attemptCount: number, modelId: string | null): Promise<void>;
  /** Terminal failure — records ended_at, sanitised_error and attempt count. */
  markFailed(
    attemptCount: number,
    sanitisedError: string,
    modelId: string | null,
  ): Promise<void>;
}

/**
 * Creates a job recorder and inserts the initial `pending` row (attempt 0). On
 * insert failure the recorder still functions (its `jobId` is null and later
 * updates become no-ops) so a broken audit path never blocks the AI operation.
 */
export async function startAiJob(
  admin: SupabaseClient,
  params: {
    readonly jobType: AiJobType;
    readonly eventId: string | null;
    readonly modelId: string | null;
  },
): Promise<AiJobRecorder> {
  let jobId: string | null = null;
  const { data, error } = await admin
    .from('ai_jobs')
    .insert({
      job_type: params.jobType,
      status: 'pending' satisfies AiJobStatus,
      event_id: params.eventId,
      model_id: params.modelId,
      attempt_count: 0,
      // started_at defaults to now() (UTC) in the DB.
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(
      `[ai-gateway] ai_jobs insert failed for job_type=${params.jobType}` +
        (params.eventId ? ` event=${params.eventId}` : '') +
        `: ${error?.message ?? 'no row returned'}`,
    );
  } else {
    jobId = data.id as string;
  }

  const update = async (patch: Record<string, unknown>): Promise<void> => {
    if (!jobId) {
      return;
    }
    const { error: updateError } = await admin
      .from('ai_jobs')
      .update(patch)
      .eq('id', jobId);
    if (updateError) {
      console.error(
        `[ai-gateway] ai_jobs update failed for job ${jobId} ` +
          `(job_type=${params.jobType}): ${updateError.message}`,
      );
    }
  };

  return {
    jobId,
    async markRunning(attemptCount: number): Promise<void> {
      await update({
        status: 'running' satisfies AiJobStatus,
        attempt_count: attemptCount,
      });
    },
    async markSucceeded(
      attemptCount: number,
      modelId: string | null,
    ): Promise<void> {
      await update({
        status: 'succeeded' satisfies AiJobStatus,
        attempt_count: attemptCount,
        model_id: modelId,
        ended_at: new Date().toISOString(),
      });
    },
    async markFailed(
      attemptCount: number,
      sanitisedError: string,
      modelId: string | null,
    ): Promise<void> {
      await update({
        status: 'failed' satisfies AiJobStatus,
        attempt_count: attemptCount,
        model_id: modelId,
        // sanitised_error is a fixed CATEGORY message — never a raw diagnostic,
        // credential, or prompt text (Req 12.9, 20.7).
        sanitised_error: sanitisedError,
        ended_at: new Date().toISOString(),
      });
    },
  };
}

// -----------------------------------------------------------------------------
// Credential resolution (Req 12.7).
//
// Resolves the stored credential to plaintext IN-PROCESS, immediately before the
// provider call, and hands it to a callback that MUST use it synchronously
// within its lifetime. The plaintext reference is dropped as soon as the
// callback returns (the local variable goes out of scope); callers never hold
// onto it. The `secret_reference` → managed-secret-store resolution is a seam:
// this task handles the AEAD `encrypted_credential` path (via
// `resolveEncryptedCredential`) and leaves the managed-store lookup as a clearly
// marked TODO for the deployment that wires a secret store (Req 12.3).
// -----------------------------------------------------------------------------

/**
 * Resolves the outbound credential (if any) for `config`, invokes `use` with it,
 * and discards the plaintext afterwards (Req 12.7). When `auth_type = 'none'`
 * (or no credential is stored) `use` receives `undefined`.
 *
 * @throws {CredentialResolutionError} if a required credential cannot be resolved.
 */
export async function withResolvedCredential<T>(
  config: ActiveProviderConfig,
  use: (credential: string | undefined) => Promise<T>,
): Promise<T> {
  // No credential needed / configured.
  if (config.authType === 'none' || !hasStoredCredential(config)) {
    return use(undefined);
  }

  let plaintext: string | undefined;
  try {
    if (config.encryptedCredential != null) {
      // AEAD fallback path (Req 12.5): decrypt in-process only.
      plaintext = await resolveEncryptedCredential(config.encryptedCredential);
    } else if (config.secretReference != null) {
      // SEAM (Req 12.3): resolve the managed `secret_reference` against the
      // deployment's secret store. No managed store is wired in this sandbox, so
      // fail closed with the generic resolution error rather than sending an
      // unauthenticated request. A deployment that provisions a secret store
      // fills this branch in.
      throw new CredentialResolutionError();
    }
    return await use(plaintext);
  } finally {
    // Discard the plaintext reference (Req 12.7). GC reclaims the string; we
    // drop our only reference here so it cannot outlive the request.
    plaintext = undefined;
  }
}

// -----------------------------------------------------------------------------
// Provider call SEAM (task 29.3).
//
// This is the ONLY place an outbound provider request originates. Task 29.3
// fills it: it dispatches to the provider adapter layer (`./adapter.ts`) that
// POSTs the minimal payload to `baseUrl + chatCompletionsPath` with the resolved
// credential, forwarding `signal` so the hard timeout can cancel it. The
// destination has ALREADY passed the SSRF preflight (task 29.2, see
// `runSingleAttempt`); the outbound request is dialed through an SSRF-PINNED
// `fetchImpl` (built via `createPinnedFetch` from ./ssrf.ts) so the connection is
// pinned to the SSRF-validated IP while preserving the SNI hostname (Req 13.7,
// 13.8, 13.12). The pinned fetch is threaded IN as a parameter — the preflight
// that produced the validated IP happens in `runSingleAttempt`, so the seam
// stays a pure "given a pinned fetch, perform the call" unit.
//
// The adapter returns ONLY the raw assistant text + a coarse status category +
// round-trip ms; the structured-output/JSON-schema validation is task 29.4,
// which wraps this call. Errors are collapsed to sanitised categories by
// `sanitiseError` (a `ProviderCallError` → `provider_error`).
// -----------------------------------------------------------------------------

export interface ProviderCallResult {
  /** Raw assistant text; validated by the Gateway (task 29.4), not here. */
  readonly text: string;
  readonly statusCategory: '2xx' | '3xx' | '4xx' | '5xx';
  readonly roundTripMs: number;
}

/**
 * Performs the outbound provider chat-completions call via the adapter layer.
 *
 * `fetchImpl` MUST be the SSRF-pinned fetch (see {@link createPinnedFetch}) built
 * from the preflight-validated IP in {@link runSingleAttempt} — passing it in
 * (rather than building it here) keeps the SSRF validation and the pinning that
 * enforces it adjacent, and keeps this seam a thin dispatch to the adapter. The
 * `signal` is the hard-timeout signal so an in-flight request is cancelled on
 * timeout (Req 14.5). Kept legacy `ProviderNotImplementedError` export for any
 * caller still asserting the pre-29.3 behaviour is gone — the seam is now real.
 */
export function callProvider(
  config: ActiveProviderConfig,
  payload: MinimalPayload,
  credential: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ProviderCallResult> {
  // Provider-agnostic dispatch: `./adapter.ts` resolves openai_compatible vs
  // custom_adapter from `config.providerType` and constructs the call from the
  // resolved config. No provider header/body/credential ever escapes it.
  return callChatCompletion(config, payload, credential, fetchImpl, signal);
}

// -----------------------------------------------------------------------------
// Orchestration — ties the pieces together (Req 12.7, 14.5, 19.1, 20.6).
//
// Given an already-authorised request, an active config that has PASSED the
// enablement precondition, and an `ai_jobs` recorder, this runs one attempt:
//   1. mark running (attempt 1),
//   2. build the minimal payload (Req 20.1, 20.3),
//   3. resolve the credential, call the provider under the hard timeout, then
//      discard the plaintext (Req 12.7, 14.5),
//   4. mark succeeded / failed with a sanitised error (Req 20.6, 20.7).
//
// Bounded retries (max 3, Req 19.3) and structured-output validation (Req 14.6)
// are added by task 29.4 by wrapping this single-attempt runner; the
// attempt_count plumbing is already in place.
// -----------------------------------------------------------------------------

export type GatewayRunOutcome =
  | { readonly ok: true; readonly result: ProviderCallResult }
  | {
      readonly ok: false;
      readonly error: { code: SanitisedErrorCode; message: string };
    };

/**
 * Performs a SINGLE outbound provider call for an ALREADY-BUILT minimal payload
 * through the full SSRF-preflight → pinned-fetch → resolved-credential →
 * hard-timeout path — the exact same egress machinery {@link runSingleAttempt}
 * uses, factored out so other operations (e.g. the connection test, task 29.5)
 * can reuse it WITHOUT duplicating any SSRF / timeout / credential logic.
 *
 * It does NO `ai_jobs` recording and NO structured-output validation — it is a
 * thin, pure-egress primitive. Callers own their own lifecycle logging and
 * result interpretation. Any failure propagates as its ORIGINAL error class
 * (GatewayTimeoutError / DisallowedDestinationError / CredentialResolutionError
 * / ProviderCallError) so the caller can map it to whatever sanitised taxonomy
 * it needs via {@link sanitiseError} or its own mapping.
 */
export function runPreflightedProviderCall(
  config: ActiveProviderConfig,
  payload: MinimalPayload,
): Promise<ProviderCallResult> {
  const timeoutMs = resolveTimeoutMs(config.requestTimeoutSeconds);
  return (async () => {
    // Defence-in-depth pre-transmission guard (Req 20.2): block the outbound
    // call if the built payload carries any participant identifier. Throws
    // `RestrictedDataError` before the preflight — no request is dispatched.
    assertNoParticipantIdentifiers(payload);
    const preflight: PreflightResult = await preflightDestination(
      config.baseUrl + config.chatCompletionsPath,
    );
    const pinnedFetch = createPinnedFetch(
      preflight.resolvedIps[0],
      config.tlsVerifyRequired,
    );
    return withResolvedCredential(config, (credential) =>
      withHardTimeout(timeoutMs, (signal) =>
        callProvider(config, payload, credential, signal, pinnedFetch),
      ),
    );
  })();
}

export async function runSingleAttempt(
  config: ActiveProviderConfig,
  request: GatewayRequest,
  recorder: AiJobRecorder,
  attemptCount = 1,
): Promise<GatewayRunOutcome> {
  await recorder.markRunning(attemptCount);
  const payload = buildMinimalPayload(request);
  const timeoutMs = resolveTimeoutMs(config.requestTimeoutSeconds);

  try {
    // -------------------------------------------------------------------------
    // PRE-TRANSMISSION IDENTIFIER GUARD (task 34/35, Req 20.2).
    //
    // DEFENCE-IN-DEPTH on top of the by-construction minimisation of
    // `buildMinimalPayload` (Req 20.1, 20.3): scan the ALREADY-BUILT payload for
    // participant-identifier shapes (email / phone / IP / user id) that might
    // have been embedded inside a question text or metadata value. If any is
    // detected this throws `RestrictedDataError` HERE — BEFORE the SSRF preflight
    // or ANY outbound connection — so transmission is blocked and no request is
    // sent; `sanitiseError` collapses it to the `restricted_data` category that
    // `recorder.markFailed` records (Req 20.2, 20.7).
    // -------------------------------------------------------------------------
    assertNoParticipantIdentifiers(payload);
    // -------------------------------------------------------------------------
    // SSRF PREFLIGHT SEAM (task 29.2, Req 13.4, 13.6-13.9, 13.12).
    //
    // BEFORE resolving the credential or opening ANY outbound connection, we
    // parse + scheme-check the destination, resolve it to the FULL set of A/AAAA
    // records, and run the pure allow/deny decision. A denial throws
    // `DisallowedDestinationError` here — no request is sent (Req 13.9) and the
    // credential is never even resolved. On allow, the preflight returns the
    // validated resolved IPs; we pick one and build an SSRF-PINNED fetch (via
    // `createPinnedFetch`) that DIALS that validated IP while preserving the SNI
    // hostname, so HTTPS cert-hostname verification still succeeds and the
    // address dialed IS the address checked — closing the DNS-rebinding gap
    // (Req 13.7, 13.8, 13.12). That pinned fetch is threaded into `callProvider`
    // (the adapter dispatch, task 29.3).
    // -------------------------------------------------------------------------
    const preflight: PreflightResult = await preflightDestination(
      config.baseUrl + config.chatCompletionsPath,
    );
    // Pin to the FIRST validated IP. `evaluateSsrfDestination` (inside the
    // preflight) already fail-closed the ENTIRE resolved set, so every IP here is
    // allow-listed/safe; the first is a fine deterministic choice.
    const pinnedFetch = createPinnedFetch(
      preflight.resolvedIps[0],
      config.tlsVerifyRequired,
    );

    const result = await withResolvedCredential(config, (credential) =>
      withHardTimeout(timeoutMs, (signal) =>
        callProvider(config, payload, credential, signal, pinnedFetch),
      ),
    );
    await recorder.markSucceeded(attemptCount, config.modelId);
    return { ok: true, result };
  } catch (err) {
    const error = sanitiseError(err);
    await recorder.markFailed(attemptCount, error.message, config.modelId);
    return { ok: false, error };
  }
}

// -----------------------------------------------------------------------------
// Structured-output validation + bounded retries (task 29.4, Req 14.2, 14.3,
// 14.4, 14.6, 14.7, 14.8, 19.3).
//
// This wraps a SINGLE provider attempt with the server-side structured-output
// validation step and the bounded-retry loop. The invariants it enforces:
//
//   - Validate EVERY provider response server-side against the shared Zod
//     contract for the job type BEFORE anything is stored/displayed (Req 14.2).
//     The candidate JSON was already best-effort extracted by the adapter
//     (Req 14.3); here we JSON.parse + schema-validate it.
//   - No extractable candidate JSON, invalid JSON, or a schema violation is a
//     VALIDATION FAILURE (Req 14.7). On failure we DO NOT store and we retry —
//     up to a total of {@link MAX_STRUCTURED_OUTPUT_ATTEMPTS} attempts (1 initial
//     + up to 2 additional, Req 14.4, 14.6, 19.3), incrementing `attempt_count`
//     each time.
//   - If every attempt fails validation, we reject WITHOUT storing, leave prior
//     data unchanged, and return a RECOVERABLE `invalid_ai_response` error with
//     the FINAL attempt_count recorded in `ai_jobs` (Req 14.4, 14.6).
//   - A transport/timeout/SSRF failure from the single attempt is surfaced as
//     its own sanitised category (already recorded by `runSingleAttempt`); it is
//     NOT retried here (the max-3 bound is for validation retries, and the
//     single-attempt runner already logged the terminal failure).
//   - Req 14.8: the validated data is INERT plain data. The Gateway returns it
//     as data ONLY; it is NEVER emitted as executable HTML/script. The SPA
//     render tasks (34.x) render every AI-produced string as plain text.
//
// `connection_test` has no structured contract (task 29.5); this runner is only
// for the structured-output job types. A caller MUST NOT route a
// `connection_test` here — it would fail closed as an unsupported job type.
// -----------------------------------------------------------------------------

/** A successful, schema-validated structured output plus the attempt count. */
export interface ValidatedRunResult {
  /** The parsed, typed, INERT structured output (plain data only, Req 14.8). */
  readonly data: unknown;
  /** The attempt on which validation succeeded (1-based). */
  readonly attemptCount: number;
}

export type ValidatedRunOutcome =
  | { readonly ok: true; readonly result: ValidatedRunResult }
  | {
      readonly ok: false;
      readonly error: { code: SanitisedErrorCode; message: string };
      /** The final attempt count reached (recorded in ai_jobs). */
      readonly attemptCount: number;
    };

/**
 * Runs the provider call for a STRUCTURED-OUTPUT job type with server-side
 * schema validation and bounded retries (Req 14.2, 14.4, 14.6, 14.7, 19.3).
 *
 * Each attempt: {@link runSingleAttempt} performs the SSRF-preflighted,
 * credential-resolved, hard-timeout provider call and records the attempt in
 * `ai_jobs`. On a NON-validation failure (timeout / provider / SSRF) the terminal
 * failure is already recorded and returned as-is. On a successful call the raw
 * candidate text is validated against the job type's schema; a validation
 * failure retries (up to the cap) and a final validation failure returns a
 * recoverable `invalid_ai_response` with the final attempt_count recorded.
 *
 * The `recorder`'s `markSucceeded`/`markFailed` are re-issued with the FINAL
 * attempt count so `ai_jobs.attempt_count` reflects the true number of attempts,
 * and a validation-only failure overwrites the (transient) per-attempt
 * `succeeded` marking with the terminal `failed`.
 */
export async function runValidatedOperation(
  config: ActiveProviderConfig,
  request: GatewayRequest,
  recorder: AiJobRecorder,
): Promise<ValidatedRunOutcome> {
  // Guard: this runner is for structured-output job types only (Req 14.2).
  if (!isStructuredOutputJobType(request.jobType)) {
    const error = sanitiseError(new Error('unsupported job type'));
    await recorder.markFailed(1, error.message, config.modelId);
    return { ok: false, error, attemptCount: 1 };
  }

  let lastValidationReason: ValidationFailureReason | null = null;

  for (
    let attemptCount = 1;
    attemptCount <= MAX_STRUCTURED_OUTPUT_ATTEMPTS;
    attemptCount++
  ) {
    const outcome = await runSingleAttempt(
      config,
      request,
      recorder,
      attemptCount,
    );

    // A transport/timeout/SSRF failure is terminal here — it is NOT a validation
    // failure and was already recorded as failed by runSingleAttempt with a
    // sanitised category. Surface it unchanged (Req 14.5, 19.1).
    if (!outcome.ok) {
      return { ok: false, error: outcome.error, attemptCount };
    }

    // The provider responded; validate the candidate JSON server-side BEFORE any
    // storing/displaying (Req 14.2, 14.3). runSingleAttempt optimistically marked
    // the job `succeeded`; if validation fails we correct it below.
    const validation = validateStructuredOutput(
      request.jobType,
      outcome.result.text,
    );

    if (validation.valid) {
      // Re-affirm succeeded with the final attempt count (Req 14.6). The data is
      // INERT plain data; the caller never emits it as HTML/script (Req 14.8).
      await recorder.markSucceeded(attemptCount, config.modelId);
      return {
        ok: true,
        result: { data: validation.data, attemptCount },
      };
    }

    // Validation failure (no_json / invalid_json / schema_violation) → do NOT
    // store; retry if the bounded cap allows (Req 14.4, 14.6, 14.7, 19.3).
    lastValidationReason = validation.reason;
    // The validation-retry cap and the degraded-mode automatic-retry cap are the
    // SAME "max 3 per operation" bound (MAX_STRUCTURED_OUTPUT_ATTEMPTS ===
    // MAX_AI_AUTOMATIC_ATTEMPTS); we require BOTH predicates to agree before
    // retrying so the two policies can never diverge (Req 14.6, 19.3).
    if (
      !shouldRetryAfterValidationFailure(attemptCount) ||
      !shouldAutoRetry(attemptCount)
    ) {
      // All attempts exhausted → reject WITHOUT storing, leave prior data
      // unchanged, record the FINAL attempt_count and a recoverable, sanitised
      // validation error (Req 14.4, 14.6). The specific `reason` is intentionally
      // NOT surfaced to the client beyond the fixed category.
      const error = {
        code: 'invalid_ai_response' as SanitisedErrorCode,
        message: SANITISED_ERROR_MESSAGE.invalid_ai_response,
      };
      await recorder.markFailed(attemptCount, error.message, config.modelId);
      return { ok: false, error, attemptCount };
    }
    // EXPONENTIAL BACKOFF between the bounded automatic retries (Req 19.3):
    // wait computeBackoffDelayMs(attemptCount) before the next attempt so we do
    // not hammer the provider (no aggressive quota exhaustion). The delay is
    // bounded (capped) and, at attempt 1/2 with the current tuning, stays well
    // within the per-feature latency envelopes. Then loop and retry with an
    // incremented attempt_count.
    await backoffDelay(attemptCount);
  }

  // Unreachable in practice (the loop returns on the final attempt), but keeps
  // the function total and the compiler satisfied. Treat as a validation failure.
  void lastValidationReason;
  const error = {
    code: 'invalid_ai_response' as SanitisedErrorCode,
    message: SANITISED_ERROR_MESSAGE.invalid_ai_response,
  };
  await recorder.markFailed(
    MAX_STRUCTURED_OUTPUT_ATTEMPTS,
    error.message,
    config.modelId,
  );
  return {
    ok: false,
    error,
    attemptCount: MAX_STRUCTURED_OUTPUT_ATTEMPTS,
  };
}

// -----------------------------------------------------------------------------
// Manual retry entry point (task 33.2, Req 19.4).
//
// After the bounded automatic retries in `runValidatedOperation` are exhausted,
// automatic retries STOP (Req 19.3). An administrator may then initiate a MANUAL
// retry of the operation, which — per Req 19.4 — executes EXACTLY ONE attempt and
// reports its outcome (no further automatic retries chain off it). This is the
// SAME egress + server-side structured-output validation as a single automatic
// attempt, just without the auto-retry loop: the manual-retry POLICY
// (`planManualRetry()` → { attempts: 1, allowsAutomaticRetry: false }) is the
// pure specification this honours.
//
// It reuses `runSingleAttempt` (one SSRF-preflighted, credential-resolved,
// hard-timeout provider call, recorded in `ai_jobs`) and then validates the
// candidate JSON exactly once. On validation failure it does NOT retry — it
// records the terminal failure and returns the recoverable `invalid_ai_response`.
// The initiating control renders the outcome within 2 s (Req 19.4); a failure
// carries only the sanitised, provider-internal-free indication (Req 19.2) and
// leaves all prior approved moderation decisions / valid AI results unchanged,
// persisting no partial output (Req 19.5, 19.6).
// -----------------------------------------------------------------------------

/**
 * Executes a MANUAL retry of a structured-output AI operation: EXACTLY ONE
 * attempt, NO automatic retry (Req 19.4). Same validation contract as an
 * automatic attempt; on failure returns the recoverable sanitised error with
 * `attemptCount = 1` (the single manual attempt) and never mutates prior data.
 */
export async function runManualRetry(
  config: ActiveProviderConfig,
  request: GatewayRequest,
  recorder: AiJobRecorder,
): Promise<ValidatedRunOutcome> {
  // The manual-retry policy: a single attempt, no auto-retry (Req 19.4). We
  // assert the plan here so the intent is explicit and the value is exercised.
  const plan = planManualRetry();

  // Guard: this runner is for structured-output job types only (Req 14.2) —
  // mirrors `runValidatedOperation`.
  if (!isStructuredOutputJobType(request.jobType)) {
    const error = sanitiseError(new Error('unsupported job type'));
    await recorder.markFailed(plan.attempts, error.message, config.modelId);
    return { ok: false, error, attemptCount: plan.attempts };
  }

  // EXACTLY ONE attempt (plan.attempts === 1, Req 19.4).
  const outcome = await runSingleAttempt(
    config,
    request,
    recorder,
    plan.attempts,
  );

  // A transport/timeout/SSRF failure is terminal and already recorded — surface
  // it unchanged; no automatic retry follows a manual retry (Req 19.4, 19.1).
  if (!outcome.ok) {
    return { ok: false, error: outcome.error, attemptCount: plan.attempts };
  }

  // Validate the single response server-side BEFORE any storing (Req 14.2).
  const validation = validateStructuredOutput(
    request.jobType,
    outcome.result.text,
  );
  if (validation.valid) {
    await recorder.markSucceeded(plan.attempts, config.modelId);
    return {
      ok: true,
      result: { data: validation.data, attemptCount: plan.attempts },
    };
  }

  // Validation failed on the single manual attempt → do NOT retry (Req 19.4),
  // do NOT store (Req 19.6), leave prior data unchanged (Req 19.5); record the
  // terminal recoverable failure with the sanitised, provider-internal-free
  // category (Req 19.2).
  const error = {
    code: 'invalid_ai_response' as SanitisedErrorCode,
    message: SANITISED_ERROR_MESSAGE.invalid_ai_response,
  };
  await recorder.markFailed(plan.attempts, error.message, config.modelId);
  return { ok: false, error, attemptCount: plan.attempts };
}
