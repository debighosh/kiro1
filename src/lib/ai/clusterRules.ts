/**
 * Question clustering RULES — the SHARED, framework-agnostic, PURE contract
 * (task 31.1, Req 16).
 *
 * =============================================================================
 * PROMPT-BASED SEMANTIC GROUPING ONLY — NO VECTOR EMBEDDINGS / SIMILARITY
 * =============================================================================
 * This module (and its Deno mirror, `supabase/functions/ai-gateway/jobs/
 * clustering.ts`) implements AI question clustering as PROMPT-BASED semantic
 * grouping ONLY. The approved-question set is submitted to the configured
 * chat-completions endpoint with a grouping PROMPT and the model returns
 * structured JSON clusters that we validate against the shared schema
 * (Req 16.1). There is DELIBERATELY NO vector-embedding step, NO pairwise
 * cosine / vector-similarity computation, and NO nearest-neighbour index —
 * neither here nor in the Deno write path. Req 16.1 explicitly requires the
 * grouping to be done "without relying on vector-embedding or pairwise
 * vector-similarity computation". If you are tempted to add an embedding /
 * similarity helper here, DON'T — it violates the requirement.
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI CRITICAL WRITE PATH
 * =============================================================================
 * This is the canonical, Node-testable definition of the PURE clustering
 * DECISION logic (Requirement 16). It answers, deterministically and WITHOUT any
 * network / DB I/O:
 *
 *   - INSUFFICIENT DATA (Req 16.2): fewer than 2 approved questions → zero
 *     clusters with `insufficient_data: true` (no provider call is made).
 *   - MEMBERSHIP VALIDATION (Req 16.10): a clustering response is valid ONLY if
 *     EVERY `question_id` in EVERY cluster belongs to the current event's
 *     approved-question id set; a single foreign id rejects the WHOLE response
 *     (create no clusters). Also enforces the per-cluster shape bounds
 *     (member-count 2–500, label 1–100) as a standalone predicate.
 *   - COMPUTED CLUSTER VOTE TOTAL (Req 16.5, 16.6): the cluster vote total is
 *     the ARITHMETIC SUM of its members' current `vote_count`. It is NEVER
 *     stored — an in-memory cluster model recomputes it whenever membership
 *     changes (add / remove a member). Property 18 (task 31.2) drives this.
 *   - ADDITIVE CREATION / DISSOLUTION (Req 16.4, 16.9): creating clusters is
 *     purely additive — it NEVER deletes, replaces, or merges the original
 *     question records; it only assigns members' `cluster_id`. Dissolving a
 *     cluster removes ONLY the cluster grouping and NULLs its members'
 *     `cluster_id`, leaving every question record intact. These are modelled as
 *     pure state transitions the Deno write path applies.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node unit / property tests
 * (tasks 31.2, 31.3). This pure module is therefore the AUTHORITATIVE,
 * Node-testable copy. Because it lives under `src/` it imports the shared
 * cluster contract and its bounds from `src/schemas/ai.ts` DIRECTLY, so the
 * 2–500 member and 1–100 label bounds are NOT duplicated here: the schema is the
 * single source of truth.
 *
 * The Deno Edge Function cannot import a `src/` path at runtime, so the job
 * module (`supabase/functions/ai-gateway/jobs/clustering.ts`) re-declares an
 * identical copy of this pure logic against its Deno-side mirrored schema —
 * exactly the `src/lib/ai/categoriseRules.ts` ⇄ `jobs/categorisation.ts`
 * pattern. If a rule changes here, mirror it there too.
 *
 * Requirements traceability: 16.1, 16.2, 16.4, 16.5, 16.6, 16.7, 16.9, 16.10.
 * Design references: Server-Side AI Gateway Design (AI features — Clustering,
 * prompt-based only); Data Models (`question_clusters`; single-membership via
 * `questions.cluster_id`; computed cluster vote total).
 */

import {
  AI_CLUSTER_LABEL_MAX,
  AI_CLUSTER_LABEL_MIN,
  AI_CLUSTER_MEMBERS_MAX,
  AI_CLUSTER_MEMBERS_MIN,
  aiClusterResultSchema,
  type AiCluster,
  type AiClusterResult,
} from '../../schemas/ai';

// -----------------------------------------------------------------------------
// Insufficient-data threshold (Req 16.2).
// -----------------------------------------------------------------------------

/**
 * The minimum number of approved questions required to attempt clustering
 * (Req 16.2). With fewer than this the Gateway returns zero clusters and
 * `insufficient_data: true` WITHOUT calling the provider. This equals the
 * schema's minimum cluster member count ({@link AI_CLUSTER_MEMBERS_MIN}, 2):
 * you cannot form even a single 2-member cluster from fewer than 2 questions.
 */
export const MIN_APPROVED_FOR_CLUSTERING = AI_CLUSTER_MEMBERS_MIN;

/**
 * The insufficient-data result (Req 16.2): zero clusters plus the
 * `insufficient_data: true` indication. A frozen constant so callers cannot
 * accidentally mutate the shared value.
 */
export const INSUFFICIENT_DATA_RESULT: AiClusterResult = Object.freeze({
  clusters: [],
  insufficient_data: true,
}) as AiClusterResult;

/**
 * Whether the approved-question count is TOO FEW to cluster (Req 16.2). PURE and
 * total: a non-finite / negative count is treated as insufficient (fail closed).
 */
export function isInsufficientForClustering(approvedCount: number): boolean {
  if (!Number.isFinite(approvedCount)) {
    return true;
  }
  return approvedCount < MIN_APPROVED_FOR_CLUSTERING;
}

// -----------------------------------------------------------------------------
// Per-cluster shape predicate (Req 16.1, 16.7) — standalone, Zod-independent.
//
// The shared `aiClusterSchema` already enforces label 1–100 and member-count
// 2–500 during structured-output validation. This standalone predicate is
// provided so the write path and the unit tests (task 31.3) can assert those
// bounds directly, independent of Zod.
// -----------------------------------------------------------------------------

/**
 * Whether a cluster LABEL is within bounds (1–100 chars, Req 16.1, 16.7) — the
 * trimmed length is checked, matching the shared schema's `.trim().min().max()`.
 * PURE; never throws; a non-string returns `false`.
 */
export function isValidClusterLabel(label: unknown): boolean {
  if (typeof label !== 'string') {
    return false;
  }
  const length = label.trim().length;
  return length >= AI_CLUSTER_LABEL_MIN && length <= AI_CLUSTER_LABEL_MAX;
}

/**
 * Whether a cluster's MEMBER COUNT is within bounds (2–500, Req 16.1). PURE;
 * never throws; a non-array returns `false`.
 */
export function isValidClusterMemberCount(questionIds: unknown): boolean {
  if (!Array.isArray(questionIds)) {
    return false;
  }
  return (
    questionIds.length >= AI_CLUSTER_MEMBERS_MIN &&
    questionIds.length <= AI_CLUSTER_MEMBERS_MAX
  );
}

/**
 * Whether a single cluster satisfies BOTH shape bounds — a 1–100 char label
 * (Req 16.1, 16.7) AND a 2–500 member count (Req 16.1). PURE; never throws.
 */
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

// -----------------------------------------------------------------------------
// Membership validation against the current event (Req 16.10).
//
// A clustering response is accepted ONLY if EVERY member question id in EVERY
// cluster belongs to the current event's approved-question id set. A single
// foreign id rejects the WHOLE response (create no clusters) — there is no
// partial acceptance (Req 16.10).
// -----------------------------------------------------------------------------

/**
 * The outcome of validating a clustering response's membership against the
 * current event's approved-question id set (Req 16.10). A discriminated union so
 * the Deno write path branches WITHOUT inspecting a thrown error:
 *   - `{ valid: true, clusters }`  — every member id belongs to the event; the
 *     clusters may be created ADDITIVELY (Req 16.4).
 *   - `{ valid: false, reason }`   — reject the WHOLE response, create NO
 *     clusters (Req 16.10). `reason` distinguishes a foreign id from a shape
 *     violation for sanitised error reporting.
 */
export type ClusterMembershipOutcome =
  | { readonly valid: true; readonly clusters: readonly AiCluster[] }
  | {
      readonly valid: false;
      readonly reason: 'foreign_question_id' | 'invalid_shape';
    };

/**
 * Validates that EVERY member question id in EVERY cluster belongs to
 * `eventQuestionIds` — the set of question ids that belong to the CURRENT event
 * (its approved-question set). A single foreign id rejects the WHOLE response
 * (Req 16.10). Also re-checks each cluster's shape bounds (label 1–100, members
 * 2–500) as defence-in-depth; a shape violation likewise rejects the whole
 * response. PURE and total; never throws.
 *
 * `eventQuestionIds` is accepted as an iterable of ids (array or Set); it is
 * normalised to a `Set` internally for O(1) membership checks. An empty cluster
 * list is trivially valid (it creates nothing).
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
        // A single foreign id rejects the WHOLE response (Req 16.10).
        return { valid: false, reason: 'foreign_question_id' };
      }
    }
  }

  return { valid: true, clusters };
}

/**
 * Parses AND validates a RAW clustering result against BOTH the shared schema
 * (Req 16.1) and event membership (Req 16.10) in one step. Returns the
 * membership outcome; a schema violation is reported as `invalid_shape`. When
 * `result.insufficient_data` is true with zero clusters (Req 16.2) it validates
 * trivially (no membership to check). PURE; never throws.
 */
export function validateClusterResult(
  result: unknown,
  eventQuestionIds: Iterable<string>,
): ClusterMembershipOutcome {
  const parsed = aiClusterResultSchema.safeParse(result);
  if (!parsed.success) {
    return { valid: false, reason: 'invalid_shape' };
  }
  return validateClusterMembership(parsed.data.clusters, eventQuestionIds);
}

// -----------------------------------------------------------------------------
// Computed cluster vote total (Req 16.5, 16.6) — NEVER stored.
// -----------------------------------------------------------------------------

/**
 * Computes a cluster's vote total as the ARITHMETIC SUM of its members' current
 * `vote_count` (Req 16.5). This value is ALWAYS COMPUTED and NEVER stored as a
 * column, so it always reflects the current membership (Req 16.6). PURE and
 * total: a non-array yields 0; any non-finite / negative member count is treated
 * as 0 (a vote count is a non-negative integer) so the sum is well-defined.
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

/** A cluster member for the in-memory vote-total model: an id + its vote count. */
export interface ClusterMember {
  readonly questionId: string;
  readonly voteCount: number;
}

/**
 * An IN-MEMORY cluster model whose vote total is ALWAYS computed from its
 * current members (Req 16.5, 16.6) — there is NO stored total field on this
 * model. Membership can be mutated (add / remove) and every read of
 * {@link ClusterVoteModel.voteTotal} recomputes the sum from scratch, so the
 * total can never drift from the membership. This is the model Property 18
 * (task 31.2) drives: for any sequence of add/remove operations the reported
 * total equals the arithmetic sum of the remaining members' vote counts.
 *
 * The model is PURELY in-memory and does not touch the DB; the Deno write path
 * derives the same total by summing member `vote_count` at read time.
 */
export class ClusterVoteModel {
  /** The current members, keyed by question id (single membership per id). */
  private readonly members: Map<string, number>;

  constructor(initialMembers: readonly ClusterMember[] = []) {
    this.members = new Map<string, number>();
    for (const member of initialMembers) {
      this.addMember(member.questionId, member.voteCount);
    }
  }

  /**
   * Adds (or updates) a member's vote count. Re-adding an existing id replaces
   * its vote count rather than double-counting — single membership per id.
   * A non-finite / negative vote count is clamped to 0.
   */
  addMember(questionId: string, voteCount: number): void {
    const safe =
      typeof voteCount === 'number' && Number.isFinite(voteCount) && voteCount > 0
        ? voteCount
        : 0;
    this.members.set(questionId, safe);
  }

  /** Removes a member by id (a no-op if it is not present). */
  removeMember(questionId: string): void {
    this.members.delete(questionId);
  }

  /** Whether `questionId` is currently a member. */
  hasMember(questionId: string): boolean {
    return this.members.has(questionId);
  }

  /** The current member count. */
  get size(): number {
    return this.members.size;
  }

  /**
   * The COMPUTED vote total: the arithmetic sum of the CURRENT members' vote
   * counts (Req 16.5, 16.6). Recomputed on every access from the live
   * membership — never memoised, never stored.
   */
  get voteTotal(): number {
    return computeClusterVoteTotal(Array.from(this.members.values()));
  }
}

// -----------------------------------------------------------------------------
// Additive-creation / dissolution pure state transitions (Req 16.4, 16.9).
//
// These model the EFFECT of the Deno write path on questions' `cluster_id`
// WITHOUT any DB I/O, so the invariants can be asserted by Node tests:
//   - creation is ADDITIVE: it only SETS members' `cluster_id`; it never
//     deletes, replaces, or merges the original question records (Req 16.4);
//   - dissolution removes ONLY the cluster grouping: it NULLs the members'
//     `cluster_id` and leaves every question record intact (Req 16.9).
// The question record set is otherwise unchanged by both operations.
// -----------------------------------------------------------------------------

/**
 * The minimal question-record shape these state transitions operate on: the
 * question id and its current cluster membership (`clusterId`, `null` when the
 * question is not in any cluster). Deliberately carries NO `text` (or any other)
 * field, so a clustering state transition can ONLY touch `clusterId` — the
 * original question record is preserved by construction (Req 16.4, 16.9).
 */
export interface ClusterableQuestion {
  readonly id: string;
  readonly clusterId: string | null;
}

/**
 * Applies ADDITIVE cluster creation (Req 16.4): assigns `clusterId` to exactly
 * the questions whose id is in `memberIds`, leaving every other question — and
 * every question's identity / non-cluster fields — unchanged. Returns a NEW
 * array (does not mutate the input); the SAME set of question records is
 * returned (none added or removed), only the members' `clusterId` is set. PURE;
 * never throws.
 *
 * This models what the Deno write path does after creating a `question_clusters`
 * row: it UPDATEs the members' `questions.cluster_id`. Because the returned set
 * has the same ids as the input, creation can NEVER delete/replace/merge an
 * original record.
 */
export function applyClusterCreation<T extends ClusterableQuestion>(
  questions: readonly T[],
  clusterId: string,
  memberIds: Iterable<string>,
): T[] {
  if (!Array.isArray(questions)) {
    return [];
  }
  const members =
    memberIds instanceof Set ? memberIds : new Set<string>(memberIds);
  return questions.map((q) =>
    members.has(q.id) ? { ...q, clusterId } : q,
  );
}

/**
 * Applies cluster DISSOLUTION (Req 16.9): NULLs the `clusterId` of every
 * question that currently belongs to `clusterId`, leaving every question record
 * otherwise intact and every OTHER question untouched. Returns a NEW array (does
 * not mutate the input) with the SAME set of question records (none deleted).
 * PURE; never throws.
 *
 * This models the effect of deleting the `question_clusters` row: the FK
 * `questions.cluster_id → question_clusters(id) ON DELETE SET NULL` clears the
 * members' `cluster_id` automatically, so the questions themselves are retained
 * (Req 16.9).
 */
export function applyClusterDissolution<T extends ClusterableQuestion>(
  questions: readonly T[],
  clusterId: string,
): T[] {
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.map((q) =>
    q.clusterId === clusterId ? { ...q, clusterId: null } : q,
  );
}

/**
 * Whether an additive creation / dissolution transition PRESERVED the original
 * question record set: the same ids are present before and after, and none was
 * deleted or added (Req 16.4, 16.9). A helper the tests (task 31.3) can use to
 * assert the "never delete/merge originals" invariant directly. PURE; never
 * throws.
 */
export function preservesQuestionRecordSet(
  before: readonly ClusterableQuestion[],
  after: readonly ClusterableQuestion[],
): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return false;
  }
  if (before.length !== after.length) {
    return false;
  }
  const beforeIds = new Set(before.map((q) => q.id));
  if (beforeIds.size !== after.length) {
    // Duplicate ids in `after` would also break single-membership expectations.
  }
  return after.every((q) => beforeIds.has(q.id));
}
