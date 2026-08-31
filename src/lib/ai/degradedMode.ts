/**
 * AI FAILURE / DEGRADED-MODE POLICY — the SHARED, framework-agnostic, PURE
 * decision core (task 33.2).
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI FOR EGRESS
 * =============================================================================
 * This module is the canonical, Node-testable definition of the Server-Side AI
 * Gateway's degraded-mode policy from Requirement 19. It answers a small family
 * of questions, deterministically and WITHOUT any network I/O:
 *
 *   - "Given a completed attempt number, may the Gateway AUTOMATICALLY retry,
 *      and if so, how long must it back off first (exponential backoff)?"
 *      (Req 19.3)
 *   - "Once automatic retries are exhausted, what does a MANUAL retry do?"
 *      (exactly ONE attempt, no further auto-retry, Req 19.4)
 *   - "Given an arbitrary AI failure, which fixed failure MODE is it, and what
 *      is the sanitised, provider-internal-free 'AI unavailable' indication the
 *      initiating control renders within 2 s?" (Req 19.2)
 *   - "Does a failure mutate prior data or persist partial output?" — modelled
 *      as pure state invariants the tests can assert: on failure the set of
 *      persisted results is UNCHANGED and no partial output is added
 *      (Req 19.5, 19.6).
 *   - "Which provider does the policy select?" — always the SAME configured
 *      provider; there is NO automatic failover / provider switching (Req 19.7).
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node unit / property tests
 * (tasks 33.3, 33.4). This pure module is therefore the AUTHORITATIVE,
 * Node-testable copy of the degraded-mode POLICY. The Deno Edge Function cannot
 * import a `src/` path at runtime, so it carries a mirror
 * (`supabase/functions/ai-gateway/degradedMode.ts`) that re-declares the same
 * policy constants/helpers — exactly the `src/lib/ai/ssrf.ts` ⇄
 * `supabase/functions/ai-gateway/ssrf.ts` and `structuredOutput.ts` mirror
 * pattern. If a rule changes in one place, mirror it in the other.
 *
 * The retry COUNTING rule is defined ONCE as {@link MAX_AI_AUTOMATIC_ATTEMPTS}
 * and re-uses the same value the structured-output validation loop enforces
 * (`MAX_STRUCTURED_OUTPUT_ATTEMPTS = 3`, Req 14.6); this module ADDS the
 * exponential-backoff timing between those attempts (Req 19.3) and the
 * manual-retry semantics (Req 19.4) on top of that shared cap.
 *
 * Every value this module returns is a fixed CATEGORY / number — it carries no
 * provider header, no raw body, no credential, no hostname, and no snippet of
 * any offending text (Req 13.10, 19.2, 20.7).
 *
 * Requirements traceability: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7.
 * Design references: Server-Side AI Gateway Design (Failure handling / degraded
 * mode).
 */

// -----------------------------------------------------------------------------
// Bounded automatic retries + exponential backoff (Req 19.3).
//
// PURE. The automatic-retry cap is 3 ATTEMPTS per operation (1 initial + up to
// 2 automatic retries), matching the structured-output validation cap
// (`MAX_STRUCTURED_OUTPUT_ATTEMPTS`, Req 14.6). Between attempts the Gateway
// waits an EXPONENTIALLY growing delay: base * 2^(n-1) where `n` is the
// just-completed attempt number, clamped to a documented cap so a
// misconfiguration can never blow past a bounded wait (no aggressive quota
// exhaustion, per the design). After the cap is reached, automatic retries STOP
// until an administrator initiates a manual retry (Req 19.3, 19.4).
// -----------------------------------------------------------------------------

/**
 * Maximum AUTOMATIC attempts per AI operation: 1 initial + up to 2 automatic
 * retries (Req 19.3). Identical to `MAX_STRUCTURED_OUTPUT_ATTEMPTS` (Req 14.6);
 * both express the same "max 3 per operation" bound so the retry loop and this
 * policy never diverge.
 */
export const MAX_AI_AUTOMATIC_ATTEMPTS = 3;

/**
 * Base backoff delay (ms) applied BEFORE the first automatic retry. The delay
 * for retry `n` is `base * 2^(n-1)` (see {@link computeBackoffDelayMs}). Kept
 * modest so the whole operation still comfortably fits the per-feature latency
 * envelopes while the backoff remains genuinely exponential.
 */
export const BACKOFF_BASE_DELAY_MS = 500;

/**
 * Hard cap (ms) on any single backoff delay (Req 19.3 — bounded, no aggressive
 * quota exhaustion). With `MAX_AI_AUTOMATIC_ATTEMPTS = 3` the largest computed
 * delay (`base * 2^1 = 1000 ms`) is already below this cap; the cap defends the
 * invariant if the cap/base are ever retuned upward.
 */
export const BACKOFF_MAX_DELAY_MS = 8_000;

/**
 * The exponential backoff delay (ms) to wait BEFORE the automatic retry that
 * FOLLOWS the just-completed attempt `attemptNumber` (1-based). PURE and total:
 *
 *   - attempt 1 completed → wait `base * 2^0 = base` before attempt 2;
 *   - attempt 2 completed → wait `base * 2^1 = base * 2` before attempt 3;
 *   - and so on, each capped at {@link BACKOFF_MAX_DELAY_MS}.
 *
 * A non-finite or `< 1` attempt number is treated as attempt 1 (no negative or
 * NaN delays can escape). The result is always an integer in
 * `[0, BACKOFF_MAX_DELAY_MS]`.
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
 *
 *   - `attemptNumber >= maxAttempts` → NO more automatic retries; the operation
 *     stops until an administrator manual retry (Req 19.3, 19.4).
 *   - otherwise → an automatic retry is allowed (after
 *     {@link computeBackoffDelayMs} ms).
 *
 * PURE and total; a non-finite / `< 1` attempt number returns `false` (fail
 * closed — never retry on a nonsensical count).
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

// -----------------------------------------------------------------------------
// Manual-retry policy (Req 19.4).
//
// PURE. After the automatic cap is reached, automatic retries STOP. An
// administrator may then initiate a MANUAL retry, which executes EXACTLY ONE
// attempt and reports its outcome (no further automatic retries chain off it,
// Req 19.4). We model this as a tiny descriptor so the Gateway and the tests
// share one definition of "manual retry = single attempt, no auto-retry".
// -----------------------------------------------------------------------------

/**
 * The fixed shape of a manual-retry execution plan. A manual retry ALWAYS runs
 * exactly one attempt and NEVER schedules an automatic retry afterwards
 * (Req 19.4).
 */
export interface ManualRetryPlan {
  /** Always exactly 1 — a manual retry executes a SINGLE attempt (Req 19.4). */
  readonly attempts: 1;
  /** Always false — a manual retry NEVER chains an automatic retry (Req 19.4). */
  readonly allowsAutomaticRetry: false;
}

/**
 * The canonical manual-retry plan: exactly one attempt, no automatic retry
 * (Req 19.4). Frozen so a caller cannot mutate the shared policy object.
 */
export const MANUAL_RETRY_PLAN: ManualRetryPlan = Object.freeze({
  attempts: 1,
  allowsAutomaticRetry: false,
});

/**
 * Returns the manual-retry plan (Req 19.4). A function (not just the constant)
 * so the Gateway can express "on admin manual retry, run THIS plan" as a call
 * site, and so a future variant could parameterise the plan without changing
 * callers.
 */
export function planManualRetry(): ManualRetryPlan {
  return MANUAL_RETRY_PLAN;
}

// -----------------------------------------------------------------------------
// AI failure-mode taxonomy + sanitised "AI unavailable" indication
// (Req 19.1, 19.2).
//
// PURE. Every AI failure the Gateway can encounter collapses to ONE of a fixed
// set of failure MODES. Each mode maps to a sanitised, provider-internal-free
// indication the initiating control renders within 2 s (Req 19.2). The mode is
// an internal category (useful for logging / ai_jobs); the client-facing
// `message` NEVER exposes provider internals, hostnames, credentials, or raw
// diagnostics.
// -----------------------------------------------------------------------------

/**
 * The fixed taxonomy of AI failure modes from Req 19.1:
 *   - `not_configured`  — no AI provider configured (or effectively
 *     unconfigured: enabled but missing a required credential).
 *   - `unreachable`     — the provider could not be reached (connection error /
 *     disallowed destination — the destination is not dialable).
 *   - `auth_failure`    — authentication with the provider failed, or the
 *     credential could not be resolved/decrypted.
 *   - `invalid_response`— the provider responded but the output failed
 *     structured-output validation (or no candidate JSON was extractable).
 *   - `timeout`         — the request exceeded the admin-configured
 *     `request_timeout_seconds` (Req 11 / 19.1).
 */
export const AI_FAILURE_MODES = [
  'not_configured',
  'unreachable',
  'auth_failure',
  'invalid_response',
  'timeout',
] as const;

/** A single AI failure mode (Req 19.1). */
export type AiFailureMode = (typeof AI_FAILURE_MODES)[number];

/** True when `value` is one of the fixed {@link AI_FAILURE_MODES}. */
export function isAiFailureMode(value: string): value is AiFailureMode {
  return (AI_FAILURE_MODES as readonly string[]).includes(value);
}

/**
 * The sanitised "AI unavailable" indication for a failure mode (Req 19.2). The
 * `mode` is an internal category (safe to log); the `message` is what the
 * initiating control shows — it states AI is unavailable and that the rest of
 * the app is unaffected (Req 19.1), and NEVER carries provider internals,
 * hostnames, credentials, or raw diagnostics (Req 19.2, 20.7).
 */
export interface AiUnavailableIndication {
  readonly available: false;
  readonly mode: AiFailureMode;
  readonly message: string;
}

/**
 * Client-facing, provider-internal-free messages per failure mode (Req 19.2).
 * Every message conveys the SAME user-visible fact — AI is unavailable and the
 * core app is unaffected — differing only in the (still generic) hint. None of
 * them names a provider, host, status code, or credential.
 */
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
 * The sanitised failure-CATEGORY strings the Gateway records in
 * `ai_jobs.sanitised_error` / returns as an error code, mapped to a failure
 * MODE. This is the ONE place the low-level sanitised codes are collapsed into
 * the Req 19.1 taxonomy, so `sanitiseError` (in the gateway) and this policy
 * agree on what each category MEANS.
 *
 * Unknown / unmapped codes collapse to `unreachable` — the safest generic
 * "AI unavailable" mode — rather than leaking anything specific.
 */
const MODE_BY_SANITISED_CODE: Readonly<Record<string, AiFailureMode>> = {
  timeout: 'timeout',
  credential_resolution_failed: 'auth_failure',
  disallowed_destination: 'unreachable',
  provider_not_implemented: 'unreachable',
  provider_error: 'unreachable',
  invalid_ai_response: 'invalid_response',
  internal_error: 'unreachable',
  // Degraded (pre-call) reasons also classify here so the SPA control can render
  // a single indication regardless of whether a call was attempted (Req 19.1).
  ai_disabled: 'not_configured',
  not_configured: 'not_configured',
  credential_missing: 'not_configured',
};

/**
 * Classifies a sanitised error/degraded CODE into the Req 19.1 failure-mode
 * taxonomy. PURE and total: an unknown code collapses to `unreachable` (a
 * generic "AI unavailable"), never throwing and never leaking specifics.
 */
export function classifyFailureMode(sanitisedCode: string): AiFailureMode {
  return MODE_BY_SANITISED_CODE[sanitisedCode] ?? 'unreachable';
}

/**
 * Builds the sanitised "AI unavailable" indication for a failure MODE
 * (Req 19.2) — the payload the initiating control renders within 2 s. Contains
 * ONLY the fixed mode category + a generic, provider-internal-free message.
 */
export function describeAiUnavailable(
  mode: AiFailureMode,
): AiUnavailableIndication {
  return {
    available: false,
    mode,
    message: AI_UNAVAILABLE_MESSAGE[mode],
  };
}

/**
 * Convenience: classify a sanitised/degraded CODE and produce the sanitised
 * "AI unavailable" indication in one step (Req 19.1, 19.2). Used by the Gateway
 * to turn any low-level failure code into the single client-facing indication.
 */
export function indicationForCode(
  sanitisedCode: string,
): AiUnavailableIndication {
  return describeAiUnavailable(classifyFailureMode(sanitisedCode));
}

// -----------------------------------------------------------------------------
// Persistence invariants on failure (Req 19.5, 19.6).
//
// PURE. On ANY AI failure the system must (a) preserve all previously approved
// moderation decisions and previously valid AI results with no modification or
// deletion (Req 19.5), and (b) persist NO partial or invalid AI output — the
// pre-operation state is retained (Req 19.6). We model the "persisted results"
// as an opaque set and expose a pure helper the tests assert against:
// "applying a failure to a prior state leaves that state byte-for-byte
// unchanged". The Gateway enforces this operationally by only ever writing
// results AFTER successful validation; this helper is the pure specification of
// that invariant.
// -----------------------------------------------------------------------------

/**
 * The pure "persisted state" the invariant reasons about — an opaque snapshot of
 * whatever prior approved moderation decisions / valid AI results exist. It is
 * generic so a test can use any comparable representation (an array of ids, a
 * record, etc.).
 */
export type PersistedState<T> = T;

/**
 * Applies an AI FAILURE to a prior persisted state and returns the state that
 * MUST be persisted afterwards. Per Req 19.5/19.6 the answer is: the SAME prior
 * state, unchanged — a failure never mutates/deletes prior data and never
 * persists partial output. This is the identity function BY SPECIFICATION; the
 * tests assert `applyFailureToPersistedState(prior) === prior` (referential
 * identity) so any accidental copy/mutation would be caught.
 */
export function applyFailureToPersistedState<T>(
  prior: PersistedState<T>,
): PersistedState<T> {
  // Identity: on failure the persisted set is UNCHANGED (Req 19.5, 19.6). We do
  // NOT clone — returning the SAME reference proves no mutation/replacement.
  return prior;
}

/**
 * Whether a proposed AI output may be persisted. Only a VALIDATED (complete,
 * schema-valid) output is persistable; a failure/partial/invalid output is NOT
 * (Req 19.6). PURE — the caller passes the validation verdict.
 */
export function mayPersistAiOutput(outcome: { readonly ok: boolean }): boolean {
  return outcome.ok === true;
}

// -----------------------------------------------------------------------------
// No automatic provider switching / failover (Req 19.7).
//
// PURE. The policy NEVER selects an alternate provider automatically. Given the
// SINGLE configured provider id, it returns that SAME id — there is no
// failover, no multi-provider round-robin, no silent switch. A provider change
// only ever happens through an explicit administrator configuration change,
// which is outside this policy entirely.
// -----------------------------------------------------------------------------

/**
 * The provider the policy will use for a (re)attempt. ALWAYS the SAME
 * configured provider — there is NO automatic failover / provider switching in
 * V1 (Req 19.7). PURE and total: it echoes the configured id back.
 */
export function selectProviderForAttempt(configuredProviderId: string): string {
  // Never switch providers automatically (Req 19.7). The configured provider is
  // the only provider; an alternate is NEVER chosen here.
  return configuredProviderId;
}

/**
 * Whether automatic multi-provider failover is permitted. ALWAYS false in V1
 * (Req 19.7) — a pure, self-documenting predicate the tests assert.
 */
export function allowsAutomaticFailover(): boolean {
  return false;
}
