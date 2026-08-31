/**
 * AI structured-output VALIDATION RULES — the SHARED, framework-agnostic, PURE
 * decision core (task 29.4).
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI
 * =============================================================================
 * This module is the canonical, Node-testable definition of the Server-Side AI
 * Gateway's structured-output validation step from Requirement 14. It answers
 * ONE question, deterministically and WITHOUT any network I/O:
 *
 *   "Given an AI job type and a RAW candidate-JSON string extracted from the
 *    provider's assistant text, is that text a valid instance of the shared Zod
 *    structured-output contract for that job type — and if so, what is the
 *    parsed, typed data?"
 *
 * The rules it enforces (Req 14.2, 14.3, 14.7):
 *
 *   - There must be an extractable candidate: an empty / whitespace-only string
 *     (or a non-string) is a `no_json` failure — treated as a validation failure
 *     so the caller retries / rejects (Req 14.7).
 *   - The candidate must be syntactically valid JSON: a `JSON.parse` throw is an
 *     `invalid_json` failure.
 *   - The parsed value must satisfy the job type's Zod schema EXACTLY: a schema
 *     mismatch is a `schema_violation` failure (Req 14.2).
 *   - On success the parsed, typed data is returned — the SAME schema the SPA
 *     uses for client-side feedback validates here authoritatively (Req 14.2).
 *
 * The result is a discriminated union so a caller never has to inspect a thrown
 * error to branch: `{ valid: true, data } | { valid: false, reason }`. The
 * `reason` values are CATEGORIES only — they carry no provider header, no raw
 * body, no credential, and no snippet of the offending text — so a caller may
 * surface / log them (or map them to `ai_jobs.sanitised_error`) without leaking
 * anything to the browser (Req 13.10, 20.7).
 *
 * PLAIN-TEXT CONTRACT (Req 14.8, 21.12).
 * --------------------------------------
 * The data this module returns is INERT, typed data (strings, numbers, arrays,
 * booleans) — never executable HTML / script / markup. Callers (the Gateway and,
 * ultimately, the SPA render tasks 34.x) MUST treat every AI-produced string as
 * PLAIN TEXT and MUST NEVER inject it into the DOM as HTML or execute it. This
 * module does not — and cannot — sanitise HTML; it simply never blesses raw
 * model text as anything other than plain, schema-validated data. The DOM-level
 * safety (no `dangerouslySetInnerHTML`, no `innerHTML`) is enforced where the
 * text is rendered; this contract is documented here so the boundary is explicit.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node unit / property tests
 * (tasks 29.6). This pure module is therefore the AUTHORITATIVE, Node-testable
 * copy of the VALIDATION step. Because it lives under `src/` it can — and does —
 * import the shared Zod contracts from `src/schemas/ai.ts` DIRECTLY, so there is
 * NO schema duplication here: the schemas are the single source of truth.
 *
 * The Deno Edge Function cannot import a `src/` path at runtime, so it carries a
 * mirror (`supabase/functions/ai-gateway/structuredOutput.ts`) that re-declares
 * the same validation logic against the Deno-side mirrored schemas — exactly the
 * `src/lib/ai/ssrf.ts` ⇄ `supabase/functions/ai-gateway/ssrf.ts` pattern. If a
 * rule changes in one place, mirror it in the other.
 *
 * Requirements traceability: 14.2, 14.3, 14.7, 14.8, 21.12.
 * Design references: Server-Side AI Gateway Design (Structured output
 * validation).
 */

import type { z } from 'zod';

import {
  type AiCategorisationResult,
  type AiClusterResult,
  type AiSummaryResult,
  type AiThemeInsightsResult,
  aiCategorisationResultSchema,
  aiClusterResultSchema,
  aiSummaryResultSchema,
  aiThemeInsightsResultSchema,
} from '../../schemas/ai';

// -----------------------------------------------------------------------------
// Job types that HAVE a structured-output contract.
//
// Mirrors the AI job types that produce validated JSON. `connection_test` is
// deliberately excluded — it has no structured contract (task 29.5 handles it as
// a pass-through). A caller with a `connection_test` job must NOT route through
// {@link validateStructuredOutput}.
// -----------------------------------------------------------------------------

export const STRUCTURED_OUTPUT_JOB_TYPES = [
  'categorisation',
  'clustering',
  'theme_insights',
  'summary',
] as const;

/** A job type that produces a schema-validated structured output. */
export type StructuredOutputJobType =
  (typeof STRUCTURED_OUTPUT_JOB_TYPES)[number];

/**
 * Maps each structured-output job type to the concrete, parsed result type it
 * yields when validation succeeds. Keeps {@link validateStructuredOutput}
 * strongly typed per job type without any caller-side casts.
 */
export interface StructuredOutputResultMap {
  categorisation: AiCategorisationResult;
  clustering: AiClusterResult;
  theme_insights: AiThemeInsightsResult;
  summary: AiSummaryResult;
}

// -----------------------------------------------------------------------------
// job_type → schema (Req 14.2).
//
// The AUTHORITATIVE mapping from an AI job type to the shared Zod contract in
// `src/schemas/ai.ts`. This is the ONE place that knows which schema validates
// which job type; every job type that produces structured output MUST appear
// here, and `connection_test` MUST NOT (it is not a structured-output job).
// -----------------------------------------------------------------------------

const SCHEMA_BY_JOB_TYPE = {
  categorisation: aiCategorisationResultSchema,
  clustering: aiClusterResultSchema,
  theme_insights: aiThemeInsightsResultSchema,
  summary: aiSummaryResultSchema,
} as const satisfies Record<StructuredOutputJobType, z.ZodType>;

/** Returns true when `jobType` produces a schema-validated structured output. */
export function isStructuredOutputJobType(
  jobType: string,
): jobType is StructuredOutputJobType {
  return (STRUCTURED_OUTPUT_JOB_TYPES as readonly string[]).includes(jobType);
}

/**
 * Returns the shared Zod schema that validates `jobType`'s structured output
 * (Req 14.2), or `null` for a job type that has no structured contract (e.g.
 * `connection_test`). Exposed so a caller (or a test) can obtain the exact
 * contract a job type is validated against.
 */
export function schemaForJobType(jobType: string): z.ZodType | null {
  if (!isStructuredOutputJobType(jobType)) {
    return null;
  }
  return SCHEMA_BY_JOB_TYPE[jobType];
}

// -----------------------------------------------------------------------------
// Validation reasons + discriminated result (Req 14.3, 14.7).
// -----------------------------------------------------------------------------

/**
 * Why a structured-output validation failed — a fixed CATEGORY, never a raw
 * diagnostic (Req 13.10, 20.7):
 *   - `no_json`         — no extractable candidate JSON (empty / whitespace /
 *                         non-string). Treated as a validation failure (Req 14.7).
 *   - `invalid_json`    — the candidate is not syntactically valid JSON.
 *   - `schema_violation`— valid JSON, but it does not satisfy the job type's
 *                         Zod contract (Req 14.2).
 *   - `unsupported_job_type` — the job type has no structured-output contract
 *                         (e.g. `connection_test`); callers should not route it
 *                         here.
 */
export type ValidationFailureReason =
  'no_json' | 'invalid_json' | 'schema_violation' | 'unsupported_job_type';

/**
 * The result of validating a raw candidate against a job type's contract. A
 * discriminated union so a caller branches on `valid` without inspecting a
 * thrown error. On success `data` is the parsed, typed structured output; on
 * failure `reason` is a fixed category (no raw diagnostic, no snippet).
 */
export type ValidationResult<T> =
  | { readonly valid: true; readonly data: T }
  | { readonly valid: false; readonly reason: ValidationFailureReason };

// -----------------------------------------------------------------------------
// The validation step (Req 14.2, 14.3, 14.7).
// -----------------------------------------------------------------------------

/**
 * Validates a RAW candidate-JSON string against the shared Zod contract for the
 * given structured-output job type.
 *
 * The candidate is the (best-effort extracted) assistant text — see the adapter's
 * `extractCandidateJson`. This function is PURE and total: it never throws and
 * never performs I/O. It:
 *
 *   1. rejects an empty / whitespace-only / non-string candidate as `no_json`
 *      (Req 14.7);
 *   2. `JSON.parse`s the candidate, rejecting a syntax error as `invalid_json`;
 *   3. validates the parsed value against the job type's schema, rejecting a
 *      mismatch as `schema_violation` (Req 14.2);
 *   4. returns the parsed, typed data on success.
 *
 * Strongly typed per job type via {@link StructuredOutputResultMap}.
 */
export function validateStructuredOutput<K extends StructuredOutputJobType>(
  jobType: K,
  candidateJson: string,
): ValidationResult<StructuredOutputResultMap[K]>;
export function validateStructuredOutput(
  jobType: string,
  candidateJson: string,
): ValidationResult<unknown>;
export function validateStructuredOutput(
  jobType: string,
  candidateJson: string,
): ValidationResult<unknown> {
  const schema = schemaForJobType(jobType);
  if (schema == null) {
    // No structured contract for this job type (e.g. connection_test). Callers
    // should not route such a job here; fail closed rather than silently pass.
    return { valid: false, reason: 'unsupported_job_type' };
  }

  // (1) No extractable candidate JSON → validation failure (Req 14.7).
  if (typeof candidateJson !== 'string') {
    return { valid: false, reason: 'no_json' };
  }
  const trimmed = candidateJson.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'no_json' };
  }

  // (2) Must be syntactically valid JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { valid: false, reason: 'invalid_json' };
  }

  // (3) Must satisfy the shared Zod contract (Req 14.2).
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { valid: false, reason: 'schema_violation' };
  }

  // (4) Valid — hand back the parsed, typed, INERT data (plain text only; the
  // caller never renders it as executable HTML/script, Req 14.8).
  return { valid: true, data: result.data };
}

// -----------------------------------------------------------------------------
// Bounded-retry decision (Req 14.4, 14.6, 19.3).
//
// PURE helpers describing the retry policy so the Deno gateway's retry loop and
// its Node-testable counterpart share ONE definition of "how many attempts" and
// "should we retry". No I/O; no schema knowledge — just the counting rule.
// -----------------------------------------------------------------------------

/**
 * Total attempts allowed per AI operation: 1 initial + up to 2 additional
 * retries on validation failure / no candidate JSON (Req 14.4, 14.6), which is
 * also the max-3 automatic-retry cap (Req 19.3).
 */
export const MAX_STRUCTURED_OUTPUT_ATTEMPTS = 3;

/**
 * Given the attempt just completed (1-based) that produced a validation failure,
 * returns whether another attempt is permitted under the bounded-retry cap
 * (Req 14.6, 19.3). `attemptCount >= MAX_STRUCTURED_OUTPUT_ATTEMPTS` → no more
 * retries; the caller rejects WITHOUT storing and returns a recoverable error
 * while leaving prior data unchanged (Req 14.4).
 */
export function shouldRetryAfterValidationFailure(
  attemptCount: number,
): boolean {
  return (
    Number.isFinite(attemptCount) &&
    attemptCount >= 1 &&
    attemptCount < MAX_STRUCTURED_OUTPUT_ATTEMPTS
  );
}
