// =============================================================================
// AI GATEWAY — CONNECTION TEST (Supabase Edge Functions / Deno runtime)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module implements the administrator-initiated CONNECTION TEST for the
//  Server-Side AI Gateway (Requirement 13.1–13.5, 13.11). It is a small,
//  COMPOSING module: it reuses the existing egress machinery in `gateway.ts`
//  (SSRF preflight → pinned fetch → resolved credential → hard timeout →
//  `callProvider`) via {@link runPreflightedProviderCall}, the `openai_compatible`
//  chat-completions body builder from `adapter.ts`, and the structured-output
//  validator from `structuredOutput.ts`. It DOES NOT re-implement any SSRF,
//  timeout, or credential logic (Req 13.4, 13.7–13.9, 13.12).
//
//  WHAT A CONNECTION TEST DOES (Req 13.1–13.5, 13.11):
//    STEP 1 — connection test (Req 13.2, 13.4): send a MINIMAL, ≤256-char,
//      NON-SENSITIVE prompt through the same SSRF-preflighted / pinned-fetch /
//      hard-timeout path a normal call uses, with the resolved credential, and
//      verify a NON-EMPTY usable response. A reachable provider with a usable
//      reply passes step 1.
//    STEP 2 — representative structured-output test (Req 13.11): send a
//      representative request that SHOULD yield a schema-valid structured output
//      (a tiny categorisation-style probe) and validate it with
//      {@link validateStructuredOutput}. Compatibility is reported "established"
//      ONLY when BOTH step 1 AND step 2 succeed. If step 1 succeeds but step 2
//      fails, the outcome is `reachable_but_incompatible` (reachable, but the
//      structured-output contract is not satisfied).
//
//  SANITISED RESULTS ONLY (Req 13.1, 13.3, 13.10): the returned object carries
//  ONLY { outcome, status_category, model_id, round_trip_ms, timestamp } and, on
//  failure, a fixed `failure_category`. It NEVER contains provider headers, the
//  credential, raw response bodies, the hostname, or the resolved IP.
//
//  NO PERSISTED CONFIG CHANGE (Req 13.5): the connection test writes NOTHING to
//  `ai_provider_settings`. It DOES insert one `ai_jobs` audit row
//  (job_type = 'connection_test') per the audit convention — an audit log, not a
//  config change.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` and the
//  `npm:`/`jsr:` imports are resolved by the Supabase Edge Functions / Deno
//  toolchain at deploy time.
//
//  Requirements traceability: 13.1, 13.2, 13.3, 13.4, 13.5, 13.11, 25.7.
//  Design references: Server-Side AI Gateway Design (Connection test).
// =============================================================================

import {
  CredentialResolutionError,
} from '../_shared/aiCredential.ts';
import { DisallowedDestinationError } from './ssrf.ts';
import { ProviderCallError } from './adapter.ts';
import {
  type ActiveProviderConfig,
  type AiJobRecorder,
  GatewayTimeoutError,
  type MinimalPayload,
  runPreflightedProviderCall,
} from './gateway.ts';
import { validateStructuredOutput } from './structuredOutput.ts';

// -----------------------------------------------------------------------------
// Sanitised connection-test outcome + failure taxonomy (Req 13.1, 13.3, 13.10).
// -----------------------------------------------------------------------------

/**
 * The three connection-test outcomes:
 *   - `established`               — BOTH the connection test AND the
 *                                   representative structured-output test
 *                                   succeeded (Req 13.11).
 *   - `reachable_but_incompatible`— the provider is reachable with a usable
 *                                   response, but the representative
 *                                   structured-output test did NOT validate.
 *   - `failed`                    — the connection test itself failed (see
 *                                   `failure_category`).
 */
export type ConnectionTestOutcome =
  | 'established'
  | 'reachable_but_incompatible'
  | 'failed';

/**
 * Fixed, credential-free failure categories (Req 13.3). NEVER a raw diagnostic,
 * provider header, body, hostname, or resolved IP (Req 13.1, 13.10):
 *   - `invalid_url_scheme`     — the destination scheme is not https/http.
 *   - `timeout`                — the request exceeded the hard timeout.
 *   - `disallowed_destination` — SSRF preflight denied the destination.
 *   - `connection_error`       — a transport / provider-shape failure, or the
 *                                credential could not be resolved.
 *   - `invalid_response`       — the connection test got NO usable (non-empty)
 *                                response.
 */
export type ConnectionTestFailureCategory =
  | 'invalid_url_scheme'
  | 'timeout'
  | 'disallowed_destination'
  | 'connection_error'
  | 'invalid_response';

/**
 * The ONLY shape returned to the client (Req 13.1, 13.2, 13.3). Contains no
 * provider internals, credential, raw body, hostname, or resolved IP.
 */
export interface ConnectionTestResult {
  readonly outcome: ConnectionTestOutcome;
  /** Coarse HTTP status category of the step-1 call, or null if none completed. */
  readonly status_category: '2xx' | '3xx' | '4xx' | '5xx' | null;
  readonly model_id: string;
  /** Round-trip of the step-1 connection call in milliseconds, or null. */
  readonly round_trip_ms: number | null;
  /** ISO 8601 UTC timestamp of when the test completed. */
  readonly timestamp: string;
  /** Present ONLY when `outcome === 'failed'`; a fixed sanitised category. */
  readonly failure_category?: ConnectionTestFailureCategory;
}

// -----------------------------------------------------------------------------
// Minimal, non-sensitive probe payloads (Req 13.2, 13.11).
// -----------------------------------------------------------------------------

/**
 * STEP 1 probe (Req 13.2): a MINIMAL, ≤256-char, NON-SENSITIVE prompt. It asks
 * the model for a tiny JSON acknowledgement; we only require a NON-EMPTY usable
 * response, not a specific shape. No event data or identifiers are included.
 */
export const CONNECTION_TEST_PROMPT =
  'Connection test. Reply with the JSON object {"ok":true} and nothing else.';

/**
 * STEP 2 probe (Req 13.11): a representative request that SHOULD yield a
 * schema-valid structured output. We use a tiny categorisation-style probe: a
 * single synthetic question with a fixed UUID; a compatible provider returns a
 * `categorisation` result that validates against the shared schema. Nothing
 * here is participant data — the UUID is a constant probe id and the text is a
 * generic sentence.
 */
export const STRUCTURED_OUTPUT_PROBE_QUESTION_ID =
  '00000000-0000-4000-8000-000000000000';

/** The job type whose schema the step-2 probe is validated against (Req 13.11). */
const STRUCTURED_OUTPUT_PROBE_JOB_TYPE = 'categorisation';

/** Builds the step-1 minimal payload (no identifiers, ≤256-char prompt). */
export function buildConnectionTestPayload(): MinimalPayload {
  return {
    questionTexts: [CONNECTION_TEST_PROMPT],
    aggregateMetadata: { probe: 'connection_test' },
  };
}

/** Builds the step-2 representative structured-output probe payload (Req 13.11). */
export function buildStructuredOutputProbePayload(): MinimalPayload {
  return {
    questionTexts: [
      `[${STRUCTURED_OUTPUT_PROBE_QUESTION_ID}] What is the project roadmap?`,
    ],
    aggregateMetadata: {
      probe: 'structured_output',
      question_count: 1,
    },
  };
}

// Enforce the ≤256-char bound at module load (Req 13.2). A regression that grows
// the prompt past the cap fails fast rather than silently violating the contract.
if (CONNECTION_TEST_PROMPT.length > 256) {
  throw new Error('CONNECTION_TEST_PROMPT exceeds the 256-character limit.');
}

// -----------------------------------------------------------------------------
// Error → sanitised failure-category mapping (Req 13.3, 13.10).
//
// Maps the ORIGINAL error class thrown by the egress path to a fixed category.
// DisallowedDestinationError carries a `reason` distinguishing an invalid scheme
// (`invalid_scheme`) from a blocked/non-allowlisted destination — the former
// maps to `invalid_url_scheme`, everything else to `disallowed_destination`.
// -----------------------------------------------------------------------------

export function categoriseConnectionTestError(
  err: unknown,
): ConnectionTestFailureCategory {
  if (err instanceof GatewayTimeoutError) {
    return 'timeout';
  }
  if (err instanceof DisallowedDestinationError) {
    return err.reason === 'invalid_scheme'
      ? 'invalid_url_scheme'
      : 'disallowed_destination';
  }
  // A required credential could not be resolved → treat as a connection failure
  // (we never made a usable call). No plaintext or partial credential leaks.
  if (err instanceof CredentialResolutionError) {
    return 'connection_error';
  }
  if (err instanceof ProviderCallError) {
    return 'connection_error';
  }
  // Anything unexpected collapses to a generic connection error — never a raw
  // diagnostic (Req 13.10).
  return 'connection_error';
}

// -----------------------------------------------------------------------------
// The connection test (Req 13.1–13.5, 13.11).
// -----------------------------------------------------------------------------

/** Builds the sanitised failure result and records the failed audit row. */
async function failResult(
  recorder: AiJobRecorder,
  modelId: string,
  failureCategory: ConnectionTestFailureCategory,
  statusCategory: ConnectionTestResult['status_category'],
): Promise<ConnectionTestResult> {
  await recorder.markFailed(1, `connection_test:${failureCategory}`, modelId);
  return {
    outcome: 'failed',
    status_category: statusCategory,
    model_id: modelId,
    round_trip_ms: null,
    timestamp: new Date().toISOString(),
    failure_category: failureCategory,
  };
}

/**
 * Runs the connection test against `config` (which has ALREADY passed the
 * enablement precondition) and records a single `ai_jobs` audit row via
 * `recorder`. Returns ONLY the sanitised {@link ConnectionTestResult}
 * (Req 13.1, 13.3). Writes NOTHING to `ai_provider_settings` (Req 13.5).
 *
 * Flow:
 *   1. Mark the audit row running (attempt 1).
 *   2. STEP 1 (Req 13.2, 13.4): send the minimal ≤256-char probe; a thrown
 *      error → sanitised failure; an EMPTY response text → `invalid_response`.
 *   3. STEP 2 (Req 13.11): send the representative structured-output probe and
 *      validate it. Both succeed → `established`; step 1 ok but step 2 not
 *      valid → `reachable_but_incompatible`. A THROWN error in step 2 does not
 *      change the fact that the provider is reachable, so it is treated as
 *      `reachable_but_incompatible` (the connection itself succeeded).
 */
export async function runConnectionTest(
  config: ActiveProviderConfig,
  recorder: AiJobRecorder,
): Promise<ConnectionTestResult> {
  const modelId = config.modelId;
  await recorder.markRunning(1);

  // ---- STEP 1: connection test (Req 13.2, 13.4) ----------------------------
  let step1: { text: string; statusCategory: ConnectionTestResult['status_category']; roundTripMs: number };
  try {
    const result = await runPreflightedProviderCall(
      config,
      buildConnectionTestPayload(),
    );
    step1 = {
      text: result.text,
      statusCategory: result.statusCategory,
      roundTripMs: result.roundTripMs,
    };
  } catch (err) {
    // No usable connection was established. Map to a fixed failure category.
    return failResult(
      recorder,
      modelId,
      categoriseConnectionTestError(err),
      null,
    );
  }

  // A completed call with an EMPTY response is NOT a usable response (Req 13.4).
  if (step1.text.trim().length === 0) {
    return failResult(recorder, modelId, 'invalid_response', step1.statusCategory);
  }

  // ---- STEP 2: representative structured-output test (Req 13.11) ------------
  // The provider is reachable (step 1 passed). Compatibility is "established"
  // ONLY when the representative structured-output probe ALSO validates.
  let structuredOk = false;
  try {
    const probe = await runPreflightedProviderCall(
      config,
      buildStructuredOutputProbePayload(),
    );
    const validation = validateStructuredOutput(
      STRUCTURED_OUTPUT_PROBE_JOB_TYPE,
      probe.text,
    );
    structuredOk = validation.valid;
  } catch {
    // A transport failure in the SECOND call does not retract step 1's success;
    // the endpoint is reachable but the structured-output check did not succeed.
    structuredOk = false;
  }

  const outcome: ConnectionTestOutcome = structuredOk
    ? 'established'
    : 'reachable_but_incompatible';

  // Both outcomes here mean the connection itself succeeded → record success on
  // the audit row (the connection test reached and got a usable response). The
  // structured-output compatibility is conveyed by the `outcome` field.
  await recorder.markSucceeded(1, modelId);

  return {
    outcome,
    status_category: step1.statusCategory,
    model_id: modelId,
    round_trip_ms: step1.roundTripMs,
    timestamp: new Date().toISOString(),
  };
}
