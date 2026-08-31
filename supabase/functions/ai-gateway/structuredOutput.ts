// =============================================================================
// AI GATEWAY — STRUCTURED-OUTPUT VALIDATION (Supabase Edge Functions / Deno)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module runs ONLY inside the ai-gateway Supabase Edge Function (the Deno
//  runtime). It is the Deno-side structured-output VALIDATION step of the
//  Server-Side AI Gateway (Requirement 14): given an AI job type and a RAW
//  candidate-JSON string extracted from the provider's assistant text, decide
//  whether that text is a valid instance of the shared Zod contract for the job
//  type and, if so, hand back the parsed, typed data (Req 14.2, 14.3, 14.7).
//
//  -----------------------------------------------------------------------------
//  SHARED-LOGIC NOTE — keep in sync with `src/lib/ai/structuredOutput.ts`
//  AND with the schema contracts in `src/schemas/ai.ts`
//  -----------------------------------------------------------------------------
//  The AUTHORITATIVE, Node-testable copy of the PURE validation step lives at
//  `src/lib/ai/structuredOutput.ts` (the unit / property tests in task 29.6
//  import it), and the AUTHORITATIVE structured-output SCHEMAS live at
//  `src/schemas/ai.ts`. Deno cannot import a `src/` path at runtime, so this
//  module RE-DECLARES an identical copy of BOTH the four structured-output
//  schemas (against `npm:zod@4`, matching the SPA's `zod@^4`) and the validation
//  decision — mirroring the existing `src/lib/ai/ssrf.ts` ⇄
//  `supabase/functions/ai-gateway/ssrf.ts` and `src/schemas/event.ts` ⇄
//  `create-event/index.ts` patterns. If a rule/schema changes in one place,
//  mirror it in the other.
//
//  PLAIN-TEXT CONTRACT (Req 14.8, 21.12): the data returned here is INERT, typed
//  data — never executable HTML/script. The Gateway NEVER emits it as HTML; the
//  SPA render tasks (34.x) render every AI-produced string as PLAIN TEXT (no
//  `dangerouslySetInnerHTML` / `innerHTML`). This module never blesses raw model
//  text as anything other than plain, schema-validated data.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` and the
//  `npm:zod@4` import are resolved by the Supabase Edge Functions / Deno
//  toolchain at deploy time.
//
//  Requirements traceability: 14.2, 14.3, 14.6, 14.7, 14.8, 19.3, 21.12.
//  Design references: Server-Side AI Gateway Design (Structured output
//  validation).
// =============================================================================

import { z } from 'npm:zod@4';

// -----------------------------------------------------------------------------
// STRUCTURED-OUTPUT SCHEMAS — mirror of `src/schemas/ai.ts` (keep in sync).
//
// These re-declare the four AI structured-output contracts EXACTLY as defined
// in `src/schemas/ai.ts` § (b). Only the shape/rules matter for validation; the
// per-message strings are simplified where they do not affect accept/reject.
// -----------------------------------------------------------------------------

/** The fixed set of eight question categories (Req 15.1, 15.3). */
export const AI_QUESTION_CATEGORIES = [
  'Technology',
  'Governance',
  'Security',
  'Operations',
  'Workforce',
  'Compliance',
  'Strategy',
  'Other',
] as const;

const aiCategorySchema = z.enum(AI_QUESTION_CATEGORIES);

// Confidence bounds (Req 15.5).
const AI_CONFIDENCE_MIN = 0.0;
const AI_CONFIDENCE_MAX = 1.0;

// Cluster bounds (Req 16.1, 16.7).
const AI_CLUSTER_LABEL_MIN = 1;
const AI_CLUSTER_LABEL_MAX = 100;
const AI_CLUSTER_MEMBERS_MIN = 2;
const AI_CLUSTER_MEMBERS_MAX = 500;

// Theme-insights caps (Req 17.1).
const AI_MAX_TOP_THEMES = 5;
const AI_MAX_EMERGING_CONCERNS = 5;
const AI_MAX_FREQUENT_TOPICS = 10;
const AI_MAX_NOTABLE_QUESTIONS = 5;

// -- Categorisation result (Req 15) -------------------------------------------

const aiCategorisationItemSchema = z.object({
  question_id: z.uuid({ message: 'question_id must be a UUID.' }),
  category: aiCategorySchema,
  confidence: z
    .number()
    .min(AI_CONFIDENCE_MIN)
    .max(AI_CONFIDENCE_MAX)
    .optional(),
});

export const aiCategorisationResultSchema = z.object({
  items: z.array(aiCategorisationItemSchema),
});

// -- Cluster result (Req 16) --------------------------------------------------

const aiClusterSchema = z.object({
  label: z.string().trim().min(AI_CLUSTER_LABEL_MIN).max(AI_CLUSTER_LABEL_MAX),
  question_ids: z
    .array(z.uuid({ message: 'question_ids must contain UUIDs.' }))
    .min(AI_CLUSTER_MEMBERS_MIN)
    .max(AI_CLUSTER_MEMBERS_MAX),
});

export const aiClusterResultSchema = z.object({
  clusters: z.array(aiClusterSchema),
  insufficient_data: z.boolean(),
});

// -- Theme insights (Req 17) --------------------------------------------------

const aiThemeLabelSchema = z.string().trim().min(1).max(200);

const aiNotableQuestionSchema = z.object({
  question_id: z.uuid({ message: 'question_id must be a UUID.' }),
  vote_count: z.number().int().min(0),
  text: z.string(),
});

export const aiThemeInsightsResultSchema = z.object({
  top_themes: z.array(aiThemeLabelSchema).max(AI_MAX_TOP_THEMES),
  emerging_concerns: z.array(aiThemeLabelSchema).max(AI_MAX_EMERGING_CONCERNS),
  frequent_topics: z.array(aiThemeLabelSchema).max(AI_MAX_FREQUENT_TOPICS),
  notable_high_vote_questions: z
    .array(aiNotableQuestionSchema)
    .max(AI_MAX_NOTABLE_QUESTIONS),
  has_data: z.boolean(),
});

// -- End-of-event summary (Req 18) --------------------------------------------

export const aiSummaryResultSchema = z.object({
  executive_summary: z.string(),
  suggested_follow_up_actions: z.array(z.string()),
});

// -----------------------------------------------------------------------------
// job_type → schema (Req 14.2) — mirror of `src/lib/ai/structuredOutput.ts`.
//
// `connection_test` is deliberately ABSENT — it has no structured contract
// (task 29.5 handles it as a pass-through); routing it here fails closed.
// -----------------------------------------------------------------------------

export const STRUCTURED_OUTPUT_JOB_TYPES = [
  'categorisation',
  'clustering',
  'theme_insights',
  'summary',
] as const;

export type StructuredOutputJobType =
  (typeof STRUCTURED_OUTPUT_JOB_TYPES)[number];

const SCHEMA_BY_JOB_TYPE: Record<StructuredOutputJobType, z.ZodType> = {
  categorisation: aiCategorisationResultSchema,
  clustering: aiClusterResultSchema,
  theme_insights: aiThemeInsightsResultSchema,
  summary: aiSummaryResultSchema,
};

/** Returns true when `jobType` produces a schema-validated structured output. */
export function isStructuredOutputJobType(
  jobType: string,
): jobType is StructuredOutputJobType {
  return (STRUCTURED_OUTPUT_JOB_TYPES as readonly string[]).includes(jobType);
}

/**
 * Returns the Zod schema that validates `jobType`'s structured output
 * (Req 14.2), or `null` for a job type with no structured contract.
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

export type ValidationFailureReason =
  'no_json' | 'invalid_json' | 'schema_violation' | 'unsupported_job_type';

export type ValidationResult =
  | { readonly valid: true; readonly data: unknown }
  | { readonly valid: false; readonly reason: ValidationFailureReason };

// -----------------------------------------------------------------------------
// The validation step (Req 14.2, 14.3, 14.7) — mirror of the pure module.
// -----------------------------------------------------------------------------

/**
 * Validates a RAW candidate-JSON string against the schema for `jobType`. PURE
 * and total: never throws, never performs I/O. Empty/whitespace/non-string →
 * `no_json` (Req 14.7); JSON syntax error → `invalid_json`; schema mismatch →
 * `schema_violation` (Req 14.2); otherwise the parsed, typed data.
 */
export function validateStructuredOutput(
  jobType: string,
  candidateJson: string,
): ValidationResult {
  const schema = schemaForJobType(jobType);
  if (schema == null) {
    return { valid: false, reason: 'unsupported_job_type' };
  }

  if (typeof candidateJson !== 'string') {
    return { valid: false, reason: 'no_json' };
  }
  const trimmed = candidateJson.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'no_json' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { valid: false, reason: 'invalid_json' };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { valid: false, reason: 'schema_violation' };
  }

  return { valid: true, data: result.data };
}

// -----------------------------------------------------------------------------
// Bounded-retry policy (Req 14.4, 14.6, 19.3) — mirror of the pure module.
// -----------------------------------------------------------------------------

/**
 * Total attempts allowed per AI operation: 1 initial + up to 2 additional
 * retries (Req 14.4, 14.6) = the max-3 automatic-retry cap (Req 19.3).
 */
export const MAX_STRUCTURED_OUTPUT_ATTEMPTS = 3;

/**
 * Whether another attempt is permitted after the just-completed (1-based)
 * `attemptCount` produced a validation failure / no candidate JSON. At the cap
 * the caller rejects WITHOUT storing and returns a recoverable error, leaving
 * prior data unchanged (Req 14.4, 14.6, 19.3).
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
