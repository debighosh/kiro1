// =============================================================================
// AI GATEWAY — CLUSTERING JOB (Supabase Edge Functions / Deno runtime)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module implements the `clustering` AI job for the Server-Side AI
//  Gateway (Requirement 16). It is a small, COMPOSING module: it reuses the
//  validated egress runner in `gateway.ts` (`runValidatedOperation` → SSRF
//  preflight → pinned fetch → resolved credential → hard timeout → provider call
//  → server-side structured-output validation with bounded retries) and the
//  shared cluster contract from `structuredOutput.ts`
//  (`aiClusterResultSchema` / `validateStructuredOutput('clustering', …)`). It
//  does NOT re-implement any SSRF, timeout, credential, or retry logic.
//
//  =============================================================================
//  PROMPT-BASED SEMANTIC GROUPING ONLY — NO VECTOR EMBEDDINGS / SIMILARITY
//  =============================================================================
//  Clustering is done by submitting the approved-question set to the configured
//  chat-completions endpoint with a GROUPING PROMPT and validating the returned
//  structured JSON clusters against the shared schema (Req 16.1). There is
//  DELIBERATELY NO vector-embedding step, NO pairwise cosine / vector-similarity
//  computation, and NO nearest-neighbour index anywhere in this path — Req 16.1
//  explicitly requires grouping "without relying on vector-embedding or pairwise
//  vector-similarity computation". Do NOT add an embedding / similarity helper
//  here.
//
//  WHAT A CLUSTERING JOB DOES (Req 16.1, 16.2, 16.4, 16.5, 16.6, 16.9, 16.10):
//    1. LOAD the APPROVED questions for the event (status ∈ approved / featured /
//       answered — the moderation-visible set). If FEWER THAN 2 exist, return
//       zero clusters + `insufficient_data: true` WITHOUT calling the provider
//       (Req 16.2).
//    2. Otherwise submit the approved-question set with a GROUPING PROMPT via
//       `runValidatedOperation`, so the response is validated server-side against
//       `aiClusterResultSchema` (each cluster: label 1–100, 2–500 members) with
//       bounded retries (Req 16.1).
//    3. VALIDATE MEMBERSHIP: every returned question id MUST belong to the
//       event's approved-question id set; a SINGLE foreign id rejects the WHOLE
//       response and creates NO clusters (Req 16.10).
//    4. ADDITIVELY create `question_clusters` rows and set each member's
//       `questions.cluster_id` via the service role — NEVER deleting, replacing,
//       or merging the original question records (Req 16.4).
//
//  DISSOLUTION (Req 16.9): `dissolveCluster` deletes the `question_clusters` row.
//  The FK `questions.cluster_id → question_clusters(id) ON DELETE SET NULL`
//  (migration 20260101000032) then clears the members' `cluster_id`
//  automatically, leaving every question record intact. For defence-in-depth we
//  ALSO explicitly NULL the members' `cluster_id` before deleting the row, so the
//  grouping is removed even if the FK behaviour ever changes.
//
//  COMPUTED CLUSTER VOTE TOTAL (Req 16.5, 16.6): a cluster's vote total is the
//  ARITHMETIC SUM of its members' current `vote_count`. It is COMPUTED at read
//  time and returned in responses — it is NEVER stored as a column, so it always
//  reflects the current membership.
//
//  -----------------------------------------------------------------------------
//  SHARED-LOGIC NOTE — keep in sync with `src/lib/ai/clusterRules.ts`
//  -----------------------------------------------------------------------------
//  The AUTHORITATIVE, Node-testable copy of the PURE clustering rules
//  (insufficient-data threshold, per-cluster shape predicate, membership
//  validation, computed vote total + in-memory model, additive-creation /
//  dissolution state transitions) lives at `src/lib/ai/clusterRules.ts` (the
//  unit / property tests in tasks 31.2/31.3 import it). Deno cannot import a
//  `src/` path at runtime, so this module RE-DECLARES an identical copy of that
//  pure logic against the Deno-side mirrored cluster bounds — mirroring the
//  `src/lib/ai/categoriseRules.ts` ⇄ `jobs/categorisation.ts` pattern. If a rule
//  changes in one place, mirror it in the other.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` and the
//  `jsr:` supabase import are resolved by the Supabase Edge Functions / Deno
//  toolchain at deploy time.
//
//  Requirements traceability: 16.1, 16.2, 16.4, 16.5, 16.6, 16.7, 16.9, 16.10.
//  Design references: Server-Side AI Gateway Design (AI features — Clustering,
//  prompt-based only); Data Models (`question_clusters`; single-membership via
//  `questions.cluster_id`; computed cluster vote total).
// =============================================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  type ActiveProviderConfig,
  type AiJobRecorder,
  type GatewayRequest,
  runValidatedOperation,
} from '../gateway.ts';
import { aiClusterResultSchema } from '../structuredOutput.ts';

// -----------------------------------------------------------------------------
// PURE RULES — mirror of `src/lib/ai/clusterRules.ts` (keep in sync).
//
// These re-declare the pure clustering decision logic EXACTLY as defined in the
// authoritative Node-testable module. Only the shape/rules matter; per-message
// strings are omitted where they do not affect behaviour.
// -----------------------------------------------------------------------------

/** Cluster shape bounds (Req 16.1, 16.7) — mirror of the shared schema bounds. */
const AI_CLUSTER_LABEL_MIN = 1;
const AI_CLUSTER_LABEL_MAX = 100;
const AI_CLUSTER_MEMBERS_MIN = 2;
const AI_CLUSTER_MEMBERS_MAX = 500;

/** Minimum approved questions required to attempt clustering (Req 16.2). */
export const MIN_APPROVED_FOR_CLUSTERING = AI_CLUSTER_MEMBERS_MIN;

/** The approved-question statuses clustering considers (moderation-visible set). */
export const APPROVED_CLUSTERING_STATUSES = [
  'approved',
  'featured',
  'answered',
] as const;

/** A single cluster as returned (already schema-parsed) by the model. */
export interface AiCluster {
  readonly label: string;
  readonly question_ids: readonly string[];
}

/** The full clustering response shape (Req 16.1, 16.2). */
export interface AiClusterResult {
  readonly clusters: readonly AiCluster[];
  readonly insufficient_data: boolean;
}

/** Whether the approved count is too few to cluster (Req 16.2). */
export function isInsufficientForClustering(approvedCount: number): boolean {
  if (!Number.isFinite(approvedCount)) {
    return true;
  }
  return approvedCount < MIN_APPROVED_FOR_CLUSTERING;
}

/** Whether a cluster label is 1–100 chars (trimmed) (Req 16.1, 16.7). */
export function isValidClusterLabel(label: unknown): boolean {
  if (typeof label !== 'string') {
    return false;
  }
  const length = label.trim().length;
  return length >= AI_CLUSTER_LABEL_MIN && length <= AI_CLUSTER_LABEL_MAX;
}

/** Whether a cluster's member count is 2–500 (Req 16.1). */
export function isValidClusterMemberCount(questionIds: unknown): boolean {
  if (!Array.isArray(questionIds)) {
    return false;
  }
  return (
    questionIds.length >= AI_CLUSTER_MEMBERS_MIN &&
    questionIds.length <= AI_CLUSTER_MEMBERS_MAX
  );
}

/** Whether a single cluster satisfies both shape bounds (Req 16.1, 16.7). */
export function isValidClusterShape(cluster: {
  readonly label?: unknown;
  readonly question_ids?: unknown;
}): boolean {
  if (cluster == null) {
    return false;
  }
  return (
    isValidClusterLabel(cluster.label) &&
    isValidClusterMemberCount(cluster.question_ids)
  );
}

/** The outcome of validating cluster membership against the event (Req 16.10). */
export type ClusterMembershipOutcome =
  | { readonly valid: true; readonly clusters: readonly AiCluster[] }
  | {
      readonly valid: false;
      readonly reason: 'foreign_question_id' | 'invalid_shape';
    };

/**
 * Validates that EVERY member id in EVERY cluster belongs to the event's
 * approved-question id set; a single foreign id rejects the WHOLE response
 * (Req 16.10). Also re-checks each cluster's shape bounds (defence-in-depth).
 */
export function validateClusterMembership(
  clusters: readonly AiCluster[],
  eventQuestionIds: Iterable<string>,
): ClusterMembershipOutcome {
  if (!Array.isArray(clusters)) {
    return { valid: false, reason: 'invalid_shape' };
  }
  const allowed =
    eventQuestionIds instanceof Set
      ? eventQuestionIds
      : new Set<string>(eventQuestionIds);

  for (const cluster of clusters) {
    if (!isValidClusterShape(cluster)) {
      return { valid: false, reason: 'invalid_shape' };
    }
    for (const questionId of cluster.question_ids) {
      if (!allowed.has(questionId)) {
        return { valid: false, reason: 'foreign_question_id' };
      }
    }
  }

  return { valid: true, clusters };
}

/**
 * Computes a cluster's vote total as the ARITHMETIC SUM of its members' current
 * vote counts (Req 16.5). NEVER stored — always computed (Req 16.6).
 */
export function computeClusterVoteTotal(
  memberVoteCounts: readonly number[],
): number {
  if (!Array.isArray(memberVoteCounts)) {
    return 0;
  }
  let total = 0;
  for (const count of memberVoteCounts) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      total += count;
    }
  }
  return total;
}

// -----------------------------------------------------------------------------
// Clustering prompt (Req 16.1) — PROMPT-BASED grouping only.
//
// The prompt instructs the model to group SEMANTICALLY SIMILAR questions and
// return the structured JSON matching the shared contract. It carries ONLY the
// (already minimal-payload) question texts keyed by their question id — no
// participant identifiers (Req 20.1) — and NO embeddings/vectors are computed or
// transmitted (Req 16.1).
// -----------------------------------------------------------------------------

/**
 * The clustering instruction included with the batch. Kept as aggregate,
 * non-identifying metadata so the adapter transmits it in the user message
 * alongside the truncated question texts (Req 20.1, 20.3). It explicitly asks
 * the MODEL to reason about semantic similarity from the text — there is no
 * vector-embedding / similarity computation on our side (Req 16.1).
 */
export const CLUSTERING_INSTRUCTION =
  'Group the provided questions into clusters of SEMANTICALLY SIMILAR ' +
  'questions. Return a JSON object { "clusters": [ { "label", ' +
  '"question_ids" } ], "insufficient_data": false } where label is 1–100 ' +
  'characters and question_ids contains between 2 and 500 of the PROVIDED ' +
  'question ids. Use ONLY the question ids provided; do not invent ids. Judge ' +
  'similarity from the question text alone — do not compute embeddings or ' +
  'vector similarity.';

/**
 * Builds the aggregate metadata that specialises the batch as a clustering
 * request: the instruction and the question count. NON-identifying only
 * (Req 20.1, 20.3).
 */
export function buildClusteringMetadata(
  questionCount: number,
): Record<string, number | string> {
  return {
    operation: 'clustering',
    instruction: CLUSTERING_INSTRUCTION,
    question_count: questionCount,
  };
}

/**
 * Encodes the approved questions as the `question_texts` for the minimal
 * payload, prefixing each text with its question id so the model keys its
 * `question_ids` back to the rows. The id prefix is a UUID — NOT a participant
 * identifier — and the text is the question body only (Req 20.1).
 */
export function encodeClusteringQuestionTexts(
  questions: readonly ApprovedQuestion[],
): string[] {
  return questions.map((q) => `[${q.id}] ${q.text}`);
}

// -----------------------------------------------------------------------------
// DB row shapes + selection (Req 16.2).
// -----------------------------------------------------------------------------

/** An approved question row: id, text (for the prompt), and current vote count. */
export interface ApprovedQuestion {
  readonly id: string;
  readonly text: string;
  readonly vote_count: number;
}

/**
 * Loads the APPROVED questions for an event via the service role. "Approved" is
 * the moderation-visible set (status ∈ approved / featured / answered);
 * `pending` and `hidden` are excluded — clustering groups approved questions
 * only (Req 16.1). Returns the rows (id, text, vote_count) or an empty list on
 * error / none.
 */
export async function loadApprovedQuestions(
  admin: SupabaseClient,
  eventId: string,
): Promise<ApprovedQuestion[]> {
  const { data, error } = await admin
    .from('questions')
    .select('id, text, vote_count')
    .eq('event_id', eventId)
    .in('status', APPROVED_CLUSTERING_STATUSES as unknown as string[]);

  if (error || !Array.isArray(data)) {
    if (error) {
      console.error(
        `[ai-gateway] clustering approved-question load failed for event ` +
          `${eventId}: ${error.message}`,
      );
    }
    return [];
  }
  return data as ApprovedQuestion[];
}

// -----------------------------------------------------------------------------
// Additive cluster creation (Req 16.4) — service role.
// -----------------------------------------------------------------------------

/** A created cluster in the sanitised job result, with its COMPUTED vote total. */
export interface CreatedCluster {
  /** The new `question_clusters.id`. */
  readonly cluster_id: string;
  /** The validated 1–100 char label (Req 16.1, 16.7). */
  readonly label: string;
  /** The member question ids assigned to this cluster. */
  readonly question_ids: readonly string[];
  /** The COMPUTED vote total (sum of member vote_count) — never stored (Req 16.5, 16.6). */
  readonly vote_total: number;
}

/**
 * ADDITIVELY creates the validated clusters (Req 16.4): for each cluster, INSERT
 * a `question_clusters` row and then UPDATE its members' `questions.cluster_id`
 * to the new row id. This NEVER deletes, replaces, or merges any original
 * question record — it only sets `cluster_id` on the members. The member vote
 * total is COMPUTED here (sum of `vote_count`) and returned; it is NEVER stored
 * as a column (Req 16.5, 16.6). An `event_id` guard on the member UPDATE ensures
 * we only touch rows in the requested event. Returns the created clusters (with
 * computed totals) that succeeded.
 */
export async function createClustersAdditively(
  admin: SupabaseClient,
  eventId: string,
  clusters: readonly AiCluster[],
  voteCountById: ReadonlyMap<string, number>,
): Promise<CreatedCluster[]> {
  const created: CreatedCluster[] = [];

  for (const cluster of clusters) {
    // INSERT the cluster row (additive — no existing row is touched, Req 16.4).
    const { data: inserted, error: insertError } = await admin
      .from('question_clusters')
      .insert({ event_id: eventId, label: cluster.label })
      .select('id, label')
      .single<{ id: string; label: string }>();

    if (insertError || !inserted) {
      console.error(
        `[ai-gateway] clustering insert failed for event ${eventId}: ` +
          `${insertError?.message ?? 'no row returned'}`,
      );
      continue;
    }

    // ASSIGN membership: set members' cluster_id (never deletes originals).
    const memberIds = cluster.question_ids as string[];
    const { error: updateError } = await admin
      .from('questions')
      .update({ cluster_id: inserted.id })
      .in('id', memberIds)
      .eq('event_id', eventId);

    if (updateError) {
      console.error(
        `[ai-gateway] clustering membership update failed for cluster ` +
          `${inserted.id} (event ${eventId}): ${updateError.message}`,
      );
      // Roll back the just-created (empty) cluster row so creation stays
      // consistent; the FK ON DELETE SET NULL clears any members that were set.
      await admin.from('question_clusters').delete().eq('id', inserted.id);
      continue;
    }

    // COMPUTE the vote total from member vote counts — never stored (Req 16.5, 16.6).
    const voteTotal = computeClusterVoteTotal(
      memberIds.map((id) => voteCountById.get(id) ?? 0),
    );

    created.push({
      cluster_id: inserted.id,
      label: inserted.label,
      question_ids: memberIds,
      vote_total: voteTotal,
    });
  }

  return created;
}

// -----------------------------------------------------------------------------
// The clustering job (Req 16.1, 16.2, 16.4, 16.5, 16.6, 16.10).
// -----------------------------------------------------------------------------

/** Sanitised, client-safe result of a clustering run. */
export type ClusteringJobResult =
  | {
      readonly ok: true;
      /** True when there were too few approved questions to cluster (Req 16.2). */
      readonly insufficient_data: boolean;
      /** The additively-created clusters, each with its COMPUTED vote total. */
      readonly clusters: readonly CreatedCluster[];
      /** Number of approved questions considered. */
      readonly approved_count: number;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
      readonly approved_count: number;
    };

/**
 * Runs the clustering job for an event (Req 16.1, 16.2, 16.4, 16.5, 16.6,
 * 16.10):
 *   1. LOAD approved questions. If fewer than 2, return zero clusters +
 *      `insufficient_data: true` WITHOUT calling the provider (Req 16.2).
 *   2. Submit the approved-question set with a GROUPING PROMPT via the VALIDATED
 *      runner (prompt-based only — no embeddings/similarity, Req 16.1).
 *   3. VALIDATE membership: reject the WHOLE response if any returned id is not
 *      in the event's approved set (Req 16.10) — create no clusters.
 *   4. ADDITIVELY create `question_clusters` rows + assign members' cluster_id;
 *      never delete originals (Req 16.4). Compute (never store) each cluster's
 *      vote total (Req 16.5, 16.6).
 */
export async function runClustering(
  admin: SupabaseClient,
  config: ActiveProviderConfig,
  request: GatewayRequest,
  recorder: AiJobRecorder,
): Promise<ClusteringJobResult> {
  const eventId = request.eventId;
  if (eventId == null) {
    // Clustering is scoped to an event; with none there are no approved
    // questions → insufficient data (Req 16.2). No outbound call is made.
    await recorder.markSucceeded(0, config.modelId);
    return {
      ok: true,
      insufficient_data: true,
      clusters: [],
      approved_count: 0,
    };
  }

  const approved = await loadApprovedQuestions(admin, eventId);

  // Req 16.2 — fewer than 2 approved questions → zero clusters + insufficient
  // data, WITHOUT calling the provider.
  if (isInsufficientForClustering(approved.length)) {
    await recorder.markSucceeded(0, config.modelId);
    return {
      ok: true,
      insufficient_data: true,
      clusters: [],
      approved_count: approved.length,
    };
  }

  // Build the validated request: only truncated question texts + non-identifying
  // clustering metadata are transmitted (Req 20.1, 20.3). PROMPT-BASED only.
  const clusterRequest: GatewayRequest = {
    jobType: 'clustering',
    eventId,
    questionTexts: encodeClusteringQuestionTexts(approved),
    aggregateMetadata: buildClusteringMetadata(approved.length),
  };

  const validated = await runValidatedOperation(
    config,
    clusterRequest,
    recorder,
  );
  if (!validated.ok) {
    // Provider / timeout / validation failure — retain all originals unchanged,
    // create no clusters, return the sanitised error (Req 16.3-adjacent; the
    // validated runner already recorded the failure).
    return {
      ok: false,
      error: validated.error,
      approved_count: approved.length,
    };
  }

  // Re-parse to obtain typed clusters (already schema-valid upstream, Req 16.1).
  const parsed = aiClusterResultSchema.safeParse(validated.result.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_ai_response',
        message: 'The clustering response could not be validated.',
      },
      approved_count: approved.length,
    };
  }

  const result = parsed.data as AiClusterResult;

  // If the model itself reports insufficient data, honour it (Req 16.2).
  if (result.insufficient_data && result.clusters.length === 0) {
    return {
      ok: true,
      insufficient_data: true,
      clusters: [],
      approved_count: approved.length,
    };
  }

  // Req 16.10 — validate that EVERY returned question id belongs to the event's
  // approved set; a single foreign id rejects the WHOLE response (no clusters).
  const approvedIds = new Set(approved.map((q) => q.id));
  const membership = validateClusterMembership(result.clusters, approvedIds);
  if (!membership.valid) {
    return {
      ok: false,
      error: {
        code:
          membership.reason === 'foreign_question_id'
            ? 'invalid_question_id_reference'
            : 'invalid_ai_response',
        message:
          membership.reason === 'foreign_question_id'
            ? 'The clustering response referenced a question outside this event.'
            : 'The clustering response failed shape validation.',
      },
      approved_count: approved.length,
    };
  }

  // Req 16.4 — ADDITIVELY create clusters + assign membership; never delete
  // originals. Req 16.5/16.6 — compute (never store) each cluster's vote total.
  const voteCountById = new Map<string, number>(
    approved.map((q) => [q.id, q.vote_count]),
  );
  const created = await createClustersAdditively(
    admin,
    eventId,
    membership.clusters,
    voteCountById,
  );

  return {
    ok: true,
    insufficient_data: false,
    clusters: created,
    approved_count: approved.length,
  };
}

// -----------------------------------------------------------------------------
// Cluster dissolution (Req 16.9).
// -----------------------------------------------------------------------------

/** Sanitised outcome of a cluster dissolution. */
export type DissolveClusterResult =
  | { readonly ok: true; readonly cluster_id: string }
  | { readonly ok: false; readonly reason: 'not_found' | 'delete_failed' };

/**
 * Dissolves a cluster (Req 16.9): removes ONLY the cluster grouping, retaining
 * all member question records unchanged.
 *
 * FK BEHAVIOUR: `questions.cluster_id → question_clusters(id) ON DELETE SET NULL`
 * (migration 20260101000032) means deleting the `question_clusters` row
 * automatically NULLs its members' `cluster_id` — the questions are kept
 * (Req 16.9). For defence-in-depth we ALSO explicitly NULL the members'
 * `cluster_id` FIRST, so the grouping is cleared even if the FK rule ever
 * changes, and THEN delete the cluster row.
 */
export async function dissolveCluster(
  admin: SupabaseClient,
  clusterId: string,
): Promise<DissolveClusterResult> {
  // Explicitly clear members' cluster_id first (defence-in-depth; the FK would
  // also do this on delete). Only `cluster_id` is touched — the question records
  // are otherwise unchanged (Req 16.9).
  const { error: clearError } = await admin
    .from('questions')
    .update({ cluster_id: null })
    .eq('cluster_id', clusterId);

  if (clearError) {
    console.error(
      `[ai-gateway] cluster dissolution: clearing members of ${clusterId} ` +
        `failed: ${clearError.message}`,
    );
    return { ok: false, reason: 'delete_failed' };
  }

  // Delete the cluster row (the FK ON DELETE SET NULL is now a no-op since
  // members were already cleared). Retains all question records (Req 16.9).
  const { data: deleted, error: deleteError } = await admin
    .from('question_clusters')
    .delete()
    .eq('id', clusterId)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (deleteError) {
    console.error(
      `[ai-gateway] cluster dissolution: deleting ${clusterId} failed: ` +
        `${deleteError.message}`,
    );
    return { ok: false, reason: 'delete_failed' };
  }
  if (!deleted) {
    return { ok: false, reason: 'not_found' };
  }

  return { ok: true, cluster_id: clusterId };
}
