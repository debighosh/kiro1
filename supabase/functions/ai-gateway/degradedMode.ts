// =============================================================================
// AI FAILURE / DEGRADED-MODE POLICY — DENO MIRROR (task 33.2)
// =============================================================================
//
//  ⚠️  DENO / EDGE-FUNCTION MIRROR of `src/lib/ai/degradedMode.ts`. ⚠️
//
//  The Deno Edge Function runtime cannot import a `src/` path, so this file
//  re-declares — VERBATIM in behaviour — the degraded-mode POLICY defined in the
//  Node-testable canonical module `src/lib/ai/degradedMode.ts`. This is the same
//  mirror pattern used by `ssrf.ts` ⇄ `../../functions/ai-gateway/ssrf.ts` and
//  `structuredOutput.ts`. If a rule changes here, mirror it there (and vice
//  versa) — the SPA-side copy is the one the Node unit / property tests
//  (tasks 33.3, 33.4) exercise.
//
//  This module holds ONLY pure policy — no I/O, no secrets, no provider
//  internals. It defines: the max-3 automatic-retry bound with EXPONENTIAL
//  BACKOFF (Req 19.3), the MANUAL-RETRY = single-attempt semantics (Req 19.4),
//  the AI failure-mode taxonomy + sanitised "AI unavailable" indication
//  (Req 19.1, 19.2), the failure persistence invariants (Req 19.5, 19.6), and
//  the no-automatic-failover rule (Req 19.7).
//
//  Requirements traceability: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7.
//  Design references: Server-Side AI Gateway Design (Failure handling /
//  degraded mode).
// =============================================================================

// -----------------------------------------------------------------------------
// Bounded automatic retries + exponential backoff (Req 19.3).
// -----------------------------------------------------------------------------

/**
 * Maximum AUTOMATIC attempts per AI operation: 1 initial + up to 2 automatic
 * retries (Req 19.3). Matches `MAX_STRUCTURED_OUTPUT_ATTEMPTS` (Req 14.6).
 */
export const MAX_AI_AUTOMATIC_ATTEMPTS = 3;

/** Base backoff delay (ms) before the first automatic retry (Req 19.3). */
export const BACKOFF_BASE_DELAY_MS = 500;

/** Hard cap (ms) on any single backoff delay — bounded wait (Req 19.3). */
export const BACKOFF_MAX_DELAY_MS = 8_000;

/**
 * The exponential backoff delay (ms) to wait BEFORE the automatic retry that
 * FOLLOWS the just-completed attempt `attemptNumber` (1-based): base * 2^(n-1),
 * clamped to {@link BACKOFF_MAX_DELAY_MS}. PURE and total.
 */
export function computeBackoffDelayMs(attemptNumber: number): number {
  const n =
    Number.isFinite(attemptNumber) && attemptNumber >= 1
      ? Math.floor(attemptNumber)
      : 1;
  const raw = BACKOFF_BASE_DELAY_MS * 2 ** (n - 1);
  return Math.min(Math.max(0, Math.floor(raw)), BACKOFF_MAX_DELAY_MS);
}

/**
 * Whether another AUTOMATIC retry is permitted after the just-completed
 * (1-based) `attemptNumber`, under the max-`maxAttempts` bound (Req 19.3).
 * Fail closed on a non-finite / `< 1` count.
 */
export function shouldAutoRetry(
  attemptNumber: number,
  maxAttempts: number = MAX_AI_AUTOMATIC_ATTEMPTS,
): boolean {
  return (
    Number.isFinite(attemptNumber) &&
    attemptNumber >= 1 &&
    attemptNumber < maxAttempts
  );
}

/**
 * Sleeps for {@link computeBackoffDelayMs}(attemptNumber) milliseconds — the
 * exponential-backoff wait applied BETWEEN bounded automatic retries (Req 19.3).
 * Kept here (Deno-only) so the pure timing rule and the actual wait are
 * adjacent; the canonical `src/` module intentionally omits the timer so it
 * stays purely synchronous and Node-testable.
 */
export function backoffDelay(attemptNumber: number): Promise<void> {
  const ms = computeBackoffDelayMs(attemptNumber);
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Manual-retry policy (Req 19.4).
// -----------------------------------------------------------------------------

/** A manual retry runs exactly one attempt and never chains an auto-retry. */
export interface ManualRetryPlan {
  readonly attempts: 1;
  readonly allowsAutomaticRetry: false;
}

/** The canonical manual-retry plan (Req 19.4). Frozen. */
export const MANUAL_RETRY_PLAN: ManualRetryPlan = Object.freeze({
  attempts: 1,
  allowsAutomaticRetry: false,
});

/** Returns the manual-retry plan: exactly one attempt, no auto-retry (Req 19.4). */
export function planManualRetry(): ManualRetryPlan {
  return MANUAL_RETRY_PLAN;
}

// -----------------------------------------------------------------------------
// AI failure-mode taxonomy + sanitised "AI unavailable" indication
// (Req 19.1, 19.2).
// -----------------------------------------------------------------------------

/** The fixed taxonomy of AI failure modes from Req 19.1. */
export const AI_FAILURE_MODES = [
  'not_configured',
  'unreachable',
  'auth_failure',
  'invalid_response',
  'timeout',
] as const;

export type AiFailureMode = (typeof AI_FAILURE_MODES)[number];

export function isAiFailureMode(value: string): value is AiFailureMode {
  return (AI_FAILURE_MODES as readonly string[]).includes(value);
}

export interface AiUnavailableIndication {
  readonly available: false;
  readonly mode: AiFailureMode;
  readonly message: string;
}

const AI_UNAVAILABLE_MESSAGE: Readonly<Record<AiFailureMode, string>> = {
  not_configured: 'AI is not configured. The rest of the app is unaffected.',
  unreachable:
    'AI is currently unavailable. The rest of the app is unaffected.',
  auth_failure:
    'AI is currently unavailable. The rest of the app is unaffected.',
  invalid_response:
    'AI is currently unavailable. Please try again. The rest of the app is unaffected.',
  timeout:
    'AI is currently unavailable. Please try again. The rest of the app is unaffected.',
};

/**
 * Maps the Gateway's sanitised error/degraded CODES (see `sanitiseError` and
 * `DegradedReason` in gateway.ts) into the Req 19.1 failure-mode taxonomy.
 * Unknown codes collapse to `unreachable`.
 */
const MODE_BY_SANITISED_CODE: Readonly<Record<string, AiFailureMode>> = {
  timeout: 'timeout',
  credential_resolution_failed: 'auth_failure',
  disallowed_destination: 'unreachable',
  provider_not_implemented: 'unreachable',
  provider_error: 'unreachable',
  invalid_ai_response: 'invalid_response',
  internal_error: 'unreachable',
  ai_disabled: 'not_configured',
  not_configured: 'not_configured',
  credential_missing: 'not_configured',
};

export function classifyFailureMode(sanitisedCode: string): AiFailureMode {
  return MODE_BY_SANITISED_CODE[sanitisedCode] ?? 'unreachable';
}

export function describeAiUnavailable(
  mode: AiFailureMode,
): AiUnavailableIndication {
  return {
    available: false,
    mode,
    message: AI_UNAVAILABLE_MESSAGE[mode],
  };
}

export function indicationForCode(
  sanitisedCode: string,
): AiUnavailableIndication {
  return describeAiUnavailable(classifyFailureMode(sanitisedCode));
}

// -----------------------------------------------------------------------------
// Persistence invariants on failure (Req 19.5, 19.6).
// -----------------------------------------------------------------------------

export type PersistedState<T> = T;

/** On failure the persisted set is UNCHANGED (Req 19.5, 19.6): identity. */
export function applyFailureToPersistedState<T>(
  prior: PersistedState<T>,
): PersistedState<T> {
  return prior;
}

/** Only a validated (ok) output may be persisted (Req 19.6). */
export function mayPersistAiOutput(outcome: { readonly ok: boolean }): boolean {
  return outcome.ok === true;
}

// -----------------------------------------------------------------------------
// No automatic provider switching / failover (Req 19.7).
// -----------------------------------------------------------------------------

/** Always the SAME configured provider — never an automatic failover (Req 19.7). */
export function selectProviderForAttempt(configuredProviderId: string): string {
  return configuredProviderId;
}

/** Automatic multi-provider failover is out of scope in V1 (Req 19.7). */
export function allowsAutomaticFailover(): boolean {
  return false;
}
