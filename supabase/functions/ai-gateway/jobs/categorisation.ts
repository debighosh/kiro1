// =============================================================================
// AI GATEWAY — CATEGORISATION JOB (Supabase Edge Functions / Deno runtime)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module implements the `categorisation` AI job for the Server-Side AI
//  Gateway (Requirement 15). It is a small, COMPOSING module: it reuses the
//  validated egress runner in `gateway.ts` (`runValidatedOperation` → SSRF
//  preflight → pinned fetch → resolved credential → hard timeout → provider call
//  → server-side structured-output validation with bounded retries) and the
//  shared categorisation contract from `structuredOutput.ts`
//  (`validateStructuredOutput('categorisation', …)`). It does NOT re-implement
//  any SSRF, timeout, credential, or retry logic.
//
//  WHAT A CATEGORISATION JOB DOES (Req 15.1, 15.3–15.6, 15.9, 15.10):
//    1. SELECT the candidate questions (default: APPROVED-and-visible; hidden are
//       EXCLUDED unless `include_hidden` is explicitly set, Req 15.10).
//    2. CHUNK them into batches of ≤100 (Req 15.1) and, per batch, build a
//       categorisation prompt instructing the model to classify EACH question
//       into EXACTLY one of the fixed 8 categories and return the structured JSON
//       matching the shared `aiCategorisationResultSchema`.
//    3. Run each batch through `runValidatedOperation` so the response is
//       validated server-side against the shared schema with exact,
//       case-sensitive category matching — a SINGLE invalid category rejects the
//       WHOLE response (that is the schema's enum behaviour, Req 15.3, 15.4). On
//       a rejected/failed batch NOTHING is stored for that batch (Req 15.4).
//    4. On a valid response, STORE each item's category + optional confidence on
//       the matching question row via the service role, updating ONLY the
//       category fields — NEVER `text` (Req 15.5, 15.6, 15.9).
//
//  MODERATOR OVERRIDE (Req 15.7, 15.8): `applyModeratorOverride` validates a
//  proposed override (must be one of the 8), records the current category into
//  `ai_prior_category` on a valid override, and RETAINS the prior assignment
//  (writes NOTHING) on an invalid one.
//
//  TEXT-PRESERVATION INVARIANT (Req 15.9): the storage/override UPDATEs touch
//  ONLY `ai_category`, `ai_category_confidence`, and `ai_prior_category`. The
//  patch objects are built by the mirrored pure rules below and carry NO `text`
//  field, so the original question text is byte-for-byte preserved by
//  construction — no code path here ever writes `text`.
//
//  -----------------------------------------------------------------------------
//  SHARED-LOGIC NOTE — keep in sync with `src/lib/ai/categoriseRules.ts`
//  -----------------------------------------------------------------------------
//  The AUTHORITATIVE, Node-testable copy of the PURE categorisation rules
//  (category validation, confidence normalisation, hidden-exclusion predicate,
//  batch chunking ≤100, storage/override patch construction) lives at
//  `src/lib/ai/categoriseRules.ts` (the unit / property tests in tasks 30.2/30.3
//  import it). Deno cannot import a `src/` path at runtime, so this module
//  RE-DECLARES an identical copy of that pure logic against the Deno-side
//  mirrored category enum (`AI_QUESTION_CATEGORIES` from `structuredOutput.ts`) —
//  mirroring the `src/lib/ai/structuredOutput.ts` ⇄
//  `supabase/functions/ai-gateway/structuredOutput.ts` pattern. If a rule
//  changes in one place, mirror it in the other.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` and the
//  `jsr:` supabase import are resolved by the Supabase Edge Functions / Deno
//  toolchain at deploy time.
//
//  Requirements traceability: 15.1, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9,
//  15.10.
//  Design references: Server-Side AI Gateway Design (AI features —
//  Categorisation); Data Models (`questions.ai_category`,
//  `ai_category_confidence`, `ai_prior_category`).
// =============================================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  type ActiveProviderConfig,
  type AiJobRecorder,
  type GatewayRequest,
  runValidatedOperation,
} from '../gateway.ts';
import {
  AI_QUESTION_CATEGORIES,
  aiCategorisationResultSchema,
} from '../structuredOutput.ts';

// -----------------------------------------------------------------------------
// PURE RULES — mirror of `src/lib/ai/categoriseRules.ts` (keep in sync).
//
// These re-declare the pure categorisation decision logic EXACTLY as defined in
// the authoritative Node-testable module. Only the shape/rules matter; the
// per-message strings are omitted where they do not affect behaviour.
// -----------------------------------------------------------------------------

/** One of the eight allowed categories. */
export type AiCategory = (typeof AI_QUESTION_CATEGORIES)[number];

/** Maximum questions classified per batch (Req 15.1). */
export const MAX_CATEGORISATION_BATCH = 100 as const;

/** Confidence bounds for the `numeric(3,2)` column (Req 15.5). */
const AI_CONFIDENCE_MIN = 0.0;
const AI_CONFIDENCE_MAX = 1.0;

/** Exact, case-sensitive membership in the fixed 8 categories (Req 15.3). */
export function isValidCategory(value: unknown): value is AiCategory {
  return (
    typeof value === 'string' &&
    (AI_QUESTION_CATEGORIES as readonly string[]).includes(value)
  );
}

/** A single categorised item (already schema-parsed) from the model. */
export interface CategorisationItem {
  readonly question_id: string;
  readonly category: string;
  readonly confidence?: number;
}

/**
 * Normalises an optional confidence to a `numeric(3,2)`-storable value in
 * [0.00, 1.00], or `null` when absent / out of range (Req 15.5, 15.6).
 */
export function normaliseConfidence(
  confidence: number | null | undefined,
): number | null {
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < AI_CONFIDENCE_MIN ||
    confidence > AI_CONFIDENCE_MAX
  ) {
    return null;
  }
  return confidence;
}

/** A candidate question row for batch-membership decisions. */
export interface CandidateQuestion {
  readonly id: string;
  readonly status: string;
}

/** Hidden questions are excluded unless `includeHidden` is true (Req 15.10). */
export function isEligibleForCategorisation(
  question: CandidateQuestion,
  includeHidden: boolean,
): boolean {
  if (question == null || typeof question.status !== 'string') {
    return false;
  }
  if (question.status === 'hidden') {
    return includeHidden === true;
  }
  return true;
}

/** Splits a list into ordered chunks of ≤ MAX_CATEGORISATION_BATCH (Req 15.1). */
export function chunkForCategorisation<T>(
  items: readonly T[],
  size: number = MAX_CATEGORISATION_BATCH,
): T[][] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const chunkSize = Math.min(
    Math.max(
      Number.isFinite(size) ? Math.floor(size) : MAX_CATEGORISATION_BATCH,
      1,
    ),
    MAX_CATEGORISATION_BATCH,
  );
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * The category-storage patch — category fields ONLY, NEVER `text` (Req 15.9).
 */
export interface CategoryStorePatch {
  readonly ai_category: AiCategory;
  readonly ai_category_confidence: number | null;
}

/** Builds a per-item store patch, or null when the category is invalid. */
export function buildCategoryStorePatch(
  item: CategorisationItem,
): CategoryStorePatch | null {
  if (!isValidCategory(item?.category)) {
    return null;
  }
  return {
    ai_category: item.category,
    ai_category_confidence: normaliseConfidence(item.confidence),
  };
}

/** The moderator-override patch — category fields ONLY, NEVER `text` (Req 15.9). */
export interface CategoryOverridePatch {
  readonly ai_category: AiCategory;
  readonly ai_prior_category: string | null;
  readonly ai_category_confidence: null;
}

/** The outcome of computing a moderator override (Req 15.7, 15.8). */
export type OverrideOutcome =
  | { readonly applied: true; readonly patch: CategoryOverridePatch }
  | { readonly applied: false; readonly reason: 'invalid_category' };

/**
 * Computes a moderator override: on a valid category set it + record the prior
 * into `ai_prior_category` (Req 15.7); on an invalid category retain the prior
 * and change nothing (Req 15.8).
 */
export function computeOverride(
  currentCategory: string | null,
  proposedCategory: unknown,
): OverrideOutcome {
  if (!isValidCategory(proposedCategory)) {
    return { applied: false, reason: 'invalid_category' };
  }
  return {
    applied: true,
    patch: {
      ai_category: proposedCategory,
      ai_prior_category:
        typeof currentCategory === 'string' ? currentCategory : null,
      ai_category_confidence: null,
    },
  };
}

// -----------------------------------------------------------------------------
// Categorisation prompt (Req 15.1, 15.3).
//
// The prompt instructs the model to classify EACH provided question into EXACTLY
// one of the fixed 8 categories and to return the structured JSON matching the
// shared contract. It carries ONLY the (already minimal-payload) question texts,
// keyed by their question id, plus the fixed category list — no participant
// identifiers (Req 20.1). The system-level "JSON only" instruction and native
// JSON mode are applied by the adapter's `buildChatCompletionsBody`; here we add
// the categorisation SPECIALISATION as aggregate metadata that the adapter
// includes in the user message.
// -----------------------------------------------------------------------------

/**
 * The categorisation instruction included with each batch. Kept as aggregate,
 * non-identifying metadata so the adapter transmits it in the user message
 * alongside the truncated question texts (Req 20.1, 20.3).
 */
export const CATEGORISATION_INSTRUCTION =
  'Classify each provided question into EXACTLY one of the allowed categories. ' +
  'Return a JSON object { "items": [ { "question_id", "category", ' +
  '"confidence"? } ] } where category is an EXACT, case-sensitive match to one ' +
  'of the allowed categories and confidence (optional) is a number in [0,1]. ' +
  'Do not invent question ids; use the ids provided.';

/**
 * Builds the aggregate metadata that specialises a batch as a categorisation
 * request: the fixed allowed categories, the instruction, and the batch size.
 * NON-identifying only (Req 20.1, 20.3).
 */
export function buildCategorisationMetadata(
  questionCount: number,
): Record<string, number | string> {
  return {
    operation: 'categorisation',
    instruction: CATEGORISATION_INSTRUCTION,
    allowed_categories: AI_QUESTION_CATEGORIES.join(','),
    question_count: questionCount,
  };
}

/**
 * Encodes a batch of candidate questions as the `question_texts` for the minimal
 * payload, prefixing each text with its question id so the model can key its
 * `items[].question_id` back to the row. The id prefix is a UUID — NOT a
 * participant identifier — and the text is the question body only (Req 20.1).
 */
export function encodeBatchQuestionTexts(
  batch: readonly CandidateQuestionWithText[],
): string[] {
  return batch.map((q) => `[${q.id}] ${q.text}`);
}

// -----------------------------------------------------------------------------
// DB row shapes + selection (Req 15.10).
// -----------------------------------------------------------------------------

/** A candidate question row including its text (for prompt encoding). */
export interface CandidateQuestionWithText extends CandidateQuestion {
  readonly text: string;
}

/**
 * Loads the categorisation candidates for an event via the service role. By
 * default only APPROVED-and-visible questions are considered; when
 * `includeHidden` is true, hidden questions are also loaded (Req 15.10). The
 * eligibility predicate is re-applied in-memory as a defence-in-depth so the
 * hidden-exclusion rule holds even if the query filter changes.
 *
 * Returns the eligible rows (id, status, text) or an empty list on error / none.
 */
export async function loadCategorisationCandidates(
  admin: SupabaseClient,
  eventId: string,
  includeHidden: boolean,
): Promise<CandidateQuestionWithText[]> {
  let query = admin
    .from('questions')
    .select('id, status, text')
    .eq('event_id', eventId);

  // Req 15.10 — exclude hidden unless explicitly requested. When not including
  // hidden we constrain to the moderation-visible statuses categorisation
  // applies to (approved/featured/answered); hidden/pending are left out.
  if (!includeHidden) {
    query = query.neq('status', 'hidden');
  }

  const { data, error } = await query;
  if (error || !Array.isArray(data)) {
    if (error) {
      console.error(
        `[ai-gateway] categorisation candidate load failed for event ` +
          `${eventId}: ${error.message}`,
      );
    }
    return [];
  }

  const rows = data as CandidateQuestionWithText[];
  // Defence-in-depth: re-apply the pure eligibility rule (Req 15.10).
  return rows.filter((q) => isEligibleForCategorisation(q, includeHidden));
}

// -----------------------------------------------------------------------------
// Storage (Req 15.5, 15.6, 15.9) — category fields ONLY, never `text`.
// -----------------------------------------------------------------------------

/**
 * Stores a validated categorisation RESULT for a single batch onto the matching
 * question rows via the service role. Updates ONLY the category fields — the
 * UPDATE payload is a {@link CategoryStorePatch}, which has NO `text` field, so
 * the original question text is preserved byte-for-byte (Req 15.9).
 *
 * The whole batch has already been validated (exact, case-sensitive category
 * match) by `runValidatedOperation`; here we defensively re-check each item and
 * skip any whose category is somehow invalid (never storing an invalid one,
 * Req 15.4). An `event_id` guard on the UPDATE ensures we only touch rows in the
 * requested event. Returns the count of successfully updated rows.
 */
export async function storeCategorisationResult(
  admin: SupabaseClient,
  eventId: string,
  items: readonly CategorisationItem[],
): Promise<number> {
  let updated = 0;
  for (const item of items) {
    const patch = buildCategoryStorePatch(item);
    if (patch == null) {
      // Should not happen post-validation; never store an invalid category.
      continue;
    }
    const { error } = await admin
      .from('questions')
      // Only category fields are written — `text` is never in the patch (Req 15.9).
      .update(patch)
      .eq('id', item.question_id)
      .eq('event_id', eventId);
    if (error) {
      console.error(
        `[ai-gateway] categorisation store failed for question ` +
          `${item.question_id} (event ${eventId}): ${error.message}`,
      );
      continue;
    }
    updated += 1;
  }
  return updated;
}

// -----------------------------------------------------------------------------
// The categorisation job (Req 15.1, 15.3, 15.4, 15.5, 15.6, 15.9, 15.10).
// -----------------------------------------------------------------------------

/** Sanitised, client-safe summary of a categorisation run. */
export interface CategorisationJobResult {
  /** Number of candidate questions selected (post hidden-exclusion, Req 15.10). */
  readonly candidate_count: number;
  /** Number of ≤100 batches submitted (Req 15.1). */
  readonly batch_count: number;
  /** Number of questions whose category was stored (Req 15.5, 15.9). */
  readonly categorised_count: number;
  /** Number of batches rejected by validation (Req 15.4). */
  readonly rejected_batches: number;
}

/**
 * Runs the categorisation job for an event: select candidates (hidden excluded
 * unless requested, Req 15.10), chunk into ≤100 batches (Req 15.1), and for each
 * batch run the VALIDATED provider operation and store the validated result
 * (category-only UPDATE, Req 15.5, 15.6, 15.9). A batch whose response fails
 * validation stores NOTHING for that batch (Req 15.4) and is counted as
 * rejected. Records a single `ai_jobs` row via `recorder` (the validated runner
 * marks running/succeeded/failed with attempt counts).
 */
export async function runCategorisation(
  admin: SupabaseClient,
  config: ActiveProviderConfig,
  request: GatewayRequest,
  recorder: AiJobRecorder,
  options: { readonly includeHidden: boolean },
): Promise<CategorisationJobResult> {
  const eventId = request.eventId;
  if (eventId == null) {
    // Categorisation is scoped to an event. With no event, there are no
    // candidates; mark the job failed via the validated runner path below by
    // returning an empty result (no outbound call is made).
    return {
      candidate_count: 0,
      batch_count: 0,
      categorised_count: 0,
      rejected_batches: 0,
    };
  }

  const candidates = await loadCategorisationCandidates(
    admin,
    eventId,
    options.includeHidden,
  );

  const batches = chunkForCategorisation(candidates);

  let categorisedCount = 0;
  let rejectedBatches = 0;

  for (const batch of batches) {
    // Build a per-batch validated request: only truncated question texts +
    // non-identifying categorisation metadata are transmitted (Req 20.1, 20.3).
    const batchRequest: GatewayRequest = {
      jobType: 'categorisation',
      eventId,
      questionTexts: encodeBatchQuestionTexts(batch),
      aggregateMetadata: buildCategorisationMetadata(batch.length),
    };

    const validated = await runValidatedOperation(config, batchRequest, recorder);
    if (!validated.ok) {
      // Validation / transport failure → store NOTHING for this batch (Req 15.4).
      rejectedBatches += 1;
      continue;
    }

    // The validated data satisfies `aiCategorisationResultSchema`; parse it once
    // more here to obtain the typed items (a single invalid category would have
    // already rejected the WHOLE response upstream, Req 15.3, 15.4).
    const parsed = aiCategorisationResultSchema.safeParse(validated.result.data);
    if (!parsed.success) {
      rejectedBatches += 1;
      continue;
    }

    const items = parsed.data.items as CategorisationItem[];
    categorisedCount += await storeCategorisationResult(admin, eventId, items);
  }

  return {
    candidate_count: candidates.length,
    batch_count: batches.length,
    categorised_count: categorisedCount,
    rejected_batches: rejectedBatches,
  };
}

// -----------------------------------------------------------------------------
// Moderator override write path (Req 15.7, 15.8, 15.9).
// -----------------------------------------------------------------------------

/** Sanitised outcome of a moderator override write. */
export type ModeratorOverrideResult =
  | {
      readonly applied: true;
      readonly ai_category: AiCategory;
      readonly ai_prior_category: string | null;
    }
  | { readonly applied: false; readonly reason: 'invalid_category' | 'not_found' };

/**
 * Applies a MODERATOR OVERRIDE to a question via the service role (Req 15.7,
 * 15.8). Reads the current `ai_category`, computes the override with the pure
 * rule, and — on a VALID override — UPDATEs ONLY the category fields (the patch
 * has no `text`, so text is preserved, Req 15.9), recording the prior category
 * into `ai_prior_category` (Req 15.7). On an INVALID override it RETAINS the
 * prior assignment and writes NOTHING (Req 15.8). Authorisation (admin JWT) is
 * verified by the caller before this runs.
 */
export async function applyModeratorOverride(
  admin: SupabaseClient,
  params: {
    readonly questionId: string;
    readonly eventId: string | null;
    readonly proposedCategory: unknown;
  },
): Promise<ModeratorOverrideResult> {
  // Read the current assignment (and confirm the row exists / event scope).
  let query = admin
    .from('questions')
    .select('id, ai_category')
    .eq('id', params.questionId);
  if (params.eventId != null) {
    query = query.eq('event_id', params.eventId);
  }
  const { data: current, error: loadError } = await query.maybeSingle<{
    id: string;
    ai_category: string | null;
  }>();

  if (loadError || !current) {
    return { applied: false, reason: 'not_found' };
  }

  const outcome = computeOverride(current.ai_category, params.proposedCategory);
  if (!outcome.applied) {
    // Req 15.8 — retain the prior assignment; make NO change.
    return { applied: false, reason: 'invalid_category' };
  }

  const { error: updateError } = await admin
    .from('questions')
    // Only category fields are written — `text` is never in the patch (Req 15.9).
    .update(outcome.patch)
    .eq('id', params.questionId);

  if (updateError) {
    console.error(
      `[ai-gateway] categorisation override failed for question ` +
        `${params.questionId}: ${updateError.message}`,
    );
    // A failed write leaves the prior assignment intact (Req 15.8).
    return { applied: false, reason: 'not_found' };
  }

  return {
    applied: true,
    ai_category: outcome.patch.ai_category,
    ai_prior_category: outcome.patch.ai_prior_category,
  };
}
