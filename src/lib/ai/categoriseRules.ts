/**
 * Question categorisation RULES — the SHARED, framework-agnostic, PURE contract
 * (task 30.1, Req 15).
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI CRITICAL WRITE PATH
 * =============================================================================
 * This module is the canonical, Node-testable definition of the DECISION logic
 * behind question categorisation (Requirement 15). It answers, deterministically
 * and WITHOUT any network / DB I/O:
 *
 *   - which candidate questions are IN a categorisation batch (hidden are
 *     excluded unless explicitly requested — Req 15.10);
 *   - how a batch of ≤100 questions is chunked from a larger set (Req 15.1);
 *   - whether a proposed category value is one of the fixed 8 (exact,
 *     case-sensitive — Req 15.3, 15.4);
 *   - whether an OPTIONAL confidence is a valid `numeric(3,2)`-storable value in
 *     [0.00, 1.00] (Req 15.5, 15.6);
 *   - the EXACT row patch to store an AI result on a question (only the category
 *     fields — NEVER `text`, Req 15.9);
 *   - the EXACT row patch for a MODERATOR OVERRIDE — on a valid override set the
 *     new category AND record the current category into `ai_prior_category`; on
 *     an INVALID override retain the prior assignment and change NOTHING
 *     (Req 15.7, 15.8).
 *
 * THE TEXT-PRESERVATION INVARIANT (Req 15.9)
 * ------------------------------------------
 * The patch types this module produces (`CategoryStorePatch`,
 * `CategoryOverridePatch`) DELIBERATELY have NO `text` field — the TypeScript
 * type makes it IMPOSSIBLE for a categorisation/override write to touch the
 * question `text`. Only `ai_category`, `ai_category_confidence`, and
 * `ai_prior_category` are ever writable through these patches. The Deno write
 * path (`supabase/functions/ai-gateway/jobs/categorisation.ts`) UPDATEs exactly
 * these fields, so the original question text is byte-for-byte preserved by
 * construction. Property 17 (task 30.2) drives this module to assert it.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node unit / property tests
 * (tasks 30.2, 30.3). This pure module is therefore the AUTHORITATIVE,
 * Node-testable copy. Because it lives under `src/` it imports the shared
 * category enum and the categorisation contract from `src/schemas/ai.ts`
 * DIRECTLY, so there is NO duplication of the 8-category list here: the schema
 * is the single source of truth.
 *
 * The Deno Edge Function cannot import a `src/` path at runtime, so the job
 * module (`supabase/functions/ai-gateway/jobs/categorisation.ts`) re-declares an
 * identical copy of this pure logic against its Deno-side mirrored schema —
 * exactly the `src/lib/ai/structuredOutput.ts` ⇄
 * `supabase/functions/ai-gateway/structuredOutput.ts` pattern. If a rule changes
 * here, mirror it there too.
 *
 * Requirements traceability: 15.1, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9,
 * 15.10.
 * Design references: Server-Side AI Gateway Design (AI features —
 * Categorisation); Data Models (`questions.ai_category`,
 * `ai_category_confidence`, `ai_prior_category`).
 */

import {
  AI_CONFIDENCE_MAX,
  AI_CONFIDENCE_MIN,
  AI_QUESTION_CATEGORIES,
  type AiCategory,
} from '../../schemas/ai';

// -----------------------------------------------------------------------------
// Batch bounds (Req 15.1).
// -----------------------------------------------------------------------------

/**
 * Maximum number of questions classified per categorisation batch (Req 15.1).
 * A larger candidate set is split into chunks of at most this size by
 * {@link chunkForCategorisation} so each Gateway request stays within the
 * ≤100-questions / ≤30-second envelope.
 */
export const MAX_CATEGORISATION_BATCH = 100 as const;

// -----------------------------------------------------------------------------
// Category validation (Req 15.3, 15.4) — exact, case-sensitive.
// -----------------------------------------------------------------------------

/**
 * The fixed set of eight categories, re-exported from the shared schema so the
 * rule module and its callers share ONE definition (Req 15.1, 15.3).
 */
export const CATEGORISATION_CATEGORIES = AI_QUESTION_CATEGORIES;

/**
 * Whether `value` is EXACTLY one of the eight allowed categories — an exact,
 * case-sensitive string match (Req 15.3). `'security'`, `' Security'`, or any
 * other-cased/padded variant is NOT a valid category. Narrows the type to
 * {@link AiCategory} on success so callers get compile-time safety.
 *
 * PURE and total: never throws; a non-string returns `false`.
 */
export function isValidCategory(value: unknown): value is AiCategory {
  return (
    typeof value === 'string' &&
    (AI_QUESTION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * A single categorised item as returned (already schema-parsed) by the model:
 * the target question id, its assigned category, and an OPTIONAL confidence.
 */
export interface CategorisationItem {
  readonly question_id: string;
  readonly category: string;
  readonly confidence?: number;
}

/**
 * Validates an ENTIRE batch of categorisation items by exact, case-sensitive
 * category match. If ANY item's category is not one of the eight allowed values
 * the WHOLE batch is rejected (Req 15.4) — no partial acceptance. Returns
 * `true` only when every item's category is valid (an empty list is trivially
 * valid). PURE; never throws.
 *
 * NOTE: this mirrors the shared Zod contract's enum behaviour (a single invalid
 * category fails `aiCategorisationResultSchema.safeParse`). It is provided as a
 * standalone predicate so the storage step and the unit tests (task 30.3) can
 * assert the "reject the whole response" rule directly, independent of Zod.
 */
export function isValidCategorisationBatch(
  items: readonly CategorisationItem[],
): boolean {
  if (!Array.isArray(items)) {
    return false;
  }
  return items.every((item) => isValidCategory(item?.category));
}

// -----------------------------------------------------------------------------
// Confidence normalisation (Req 15.5, 15.6) — numeric(3,2) storable or absent.
// -----------------------------------------------------------------------------

/**
 * Normalises an OPTIONAL confidence to a value SAFE to store in the
 * `numeric(3,2)` `ai_category_confidence` column, or `null` when it is absent /
 * out of range (Req 15.5, 15.6). The column is `numeric(3,2)` (0.00–1.00), so:
 *
 *   - `undefined` / `null` / non-finite → `null` (confidence is absent);
 *   - a finite number in [0.00, 1.00]   → the value (the DB rounds to 2 dp);
 *   - a finite number OUTSIDE [0, 1]     → `null` (fail closed; not storable).
 *
 * PURE and total; never throws.
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

// -----------------------------------------------------------------------------
// Hidden-exclusion predicate (Req 15.10).
// -----------------------------------------------------------------------------

/** The subset of a question row this module needs to decide batch membership. */
export interface CandidateQuestion {
  readonly id: string;
  /** The moderation status; a `'hidden'` question is excluded by default. */
  readonly status: string;
}

/**
 * Whether a candidate question is ELIGIBLE for categorisation. Hidden questions
 * are excluded UNLESS `includeHidden` is explicitly `true` (Req 15.10). Every
 * non-hidden question is eligible regardless of the flag. PURE; never throws.
 */
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

/**
 * Selects the eligible candidate questions from `questions`, applying the
 * hidden-exclusion rule (Req 15.10). Returns a NEW array (does not mutate the
 * input) preserving the input order. PURE; never throws.
 */
export function selectCategorisationCandidates<T extends CandidateQuestion>(
  questions: readonly T[],
  includeHidden: boolean,
): T[] {
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.filter((q) => isEligibleForCategorisation(q, includeHidden));
}

// -----------------------------------------------------------------------------
// Batch chunking (Req 15.1) — split into chunks of ≤100.
// -----------------------------------------------------------------------------

/**
 * Splits a candidate list into ordered chunks of at most
 * {@link MAX_CATEGORISATION_BATCH} (Req 15.1). The final chunk may be smaller;
 * the concatenation of all chunks equals the input in order (no item is dropped
 * or duplicated). An empty input yields an empty list of chunks. PURE; never
 * throws. `size` is clamped to [1, MAX_CATEGORISATION_BATCH] so a caller can
 * never request an out-of-policy batch size.
 */
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

// -----------------------------------------------------------------------------
// The storage patch (Req 15.5, 15.6, 15.9) — category fields ONLY, never text.
//
// This is the EXACT set of columns a categorisation write may touch. There is
// NO `text` field, so the question text CANNOT be changed through this patch —
// the text-preservation invariant (Req 15.9) holds by construction.
// -----------------------------------------------------------------------------

/**
 * The row patch that stores an AI categorisation RESULT on a question. It sets
 * ONLY the category fields (Req 15.5, 15.6) and CANNOT touch `text` (Req 15.9):
 *   - `ai_category`            — the validated category;
 *   - `ai_category_confidence` — normalised confidence (0.00–1.00) or `null`.
 */
export interface CategoryStorePatch {
  readonly ai_category: AiCategory;
  readonly ai_category_confidence: number | null;
}

/**
 * Builds the {@link CategoryStorePatch} for a single VALIDATED item, or `null`
 * when the item's category is invalid (the caller rejects the whole batch in
 * that case, Req 15.4). The confidence is normalised to a storable value or
 * `null` (Req 15.5, 15.6). By its return type this patch can ONLY update the
 * category fields — never `text` (Req 15.9). PURE; never throws.
 */
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

/**
 * Builds a `question_id → CategoryStorePatch` map for a WHOLE batch, or `null`
 * when ANY item's category is invalid (reject the whole response — Req 15.4).
 * When valid, every item yields a category-only patch (Req 15.9). PURE; never
 * throws. The map key order follows the input order; a later duplicate
 * `question_id` overwrites an earlier one (the model should not emit duplicates,
 * but the map stays well-defined if it does).
 */
export function buildBatchStorePatches(
  items: readonly CategorisationItem[],
): Map<string, CategoryStorePatch> | null {
  if (!isValidCategorisationBatch(items)) {
    return null;
  }
  const patches = new Map<string, CategoryStorePatch>();
  for (const item of items) {
    const patch = buildCategoryStorePatch(item);
    // isValidCategorisationBatch guarantees patch is non-null here.
    if (patch != null) {
      patches.set(item.question_id, patch);
    }
  }
  return patches;
}

// -----------------------------------------------------------------------------
// Moderator override (Req 15.7, 15.8) — must be one of the 8; record prior;
// retain prior on invalid.
// -----------------------------------------------------------------------------

/**
 * The row patch for a VALID moderator override. It sets the new category AND
 * records the PRIOR category into `ai_prior_category` (Req 15.7). Like
 * {@link CategoryStorePatch} it has NO `text` field, so an override cannot
 * change the question text (Req 15.9). A manual override does not carry a model
 * confidence, so `ai_category_confidence` is cleared to `null`.
 */
export interface CategoryOverridePatch {
  readonly ai_category: AiCategory;
  /** The category that was assigned BEFORE this override (Req 15.7). */
  readonly ai_prior_category: string | null;
  /** A manual override has no model confidence — cleared to null. */
  readonly ai_category_confidence: null;
}

/**
 * The outcome of applying a moderator override to a question's current state.
 * A discriminated union so the Deno write path branches WITHOUT inspecting a
 * thrown error:
 *   - `{ applied: true, patch }`  — a VALID override; apply `patch` (Req 15.7);
 *   - `{ applied: false, reason: 'invalid_category' }` — the proposed override
 *     is not one of the 8; RETAIN the prior assignment, change NOTHING
 *     (Req 15.8).
 */
export type OverrideOutcome =
  | { readonly applied: true; readonly patch: CategoryOverridePatch }
  | { readonly applied: false; readonly reason: 'invalid_category' };

/**
 * The current stored categorisation state of a question, as read before an
 * override. `ai_category` is the current assignment (may be `null` if the
 * question has not been categorised yet).
 */
export interface CurrentCategorisationState {
  readonly ai_category: string | null;
}

/**
 * Computes the effect of a MODERATOR OVERRIDE (Req 15.7, 15.8):
 *
 *   - if `proposedCategory` is one of the eight allowed values (exact,
 *     case-sensitive), the override APPLIES: the new `ai_category` is set and
 *     the question's CURRENT `ai_category` is recorded into `ai_prior_category`
 *     (Req 15.7). The model confidence is cleared (a manual choice has none).
 *   - if `proposedCategory` is NOT one of the eight, the override is REJECTED
 *     and the prior assignment is RETAINED unchanged (Req 15.8) — the returned
 *     outcome carries no patch, so the write path makes NO change.
 *
 * The produced patch can only ever touch the category fields — never `text`
 * (Req 15.9). PURE and total; never throws.
 */
export function computeOverride(
  current: CurrentCategorisationState,
  proposedCategory: unknown,
): OverrideOutcome {
  if (!isValidCategory(proposedCategory)) {
    // Req 15.8 — retain the prior assignment; change nothing.
    return { applied: false, reason: 'invalid_category' };
  }
  const priorCategory =
    current != null && typeof current.ai_category === 'string'
      ? current.ai_category
      : null;
  return {
    applied: true,
    patch: {
      ai_category: proposedCategory,
      ai_prior_category: priorCategory,
      ai_category_confidence: null,
    },
  };
}
