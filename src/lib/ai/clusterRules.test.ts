/**
 * Task 31.3 (optional) — unit tests for the pure, Node-testable question
 * clustering RULE module (src/lib/ai/clusterRules.ts).
 *
 * These tests lock down the clustering validation + dissolution contract
 * (Requirement 16) WITHOUT any DB / Deno / network I/O:
 *   - INSUFFICIENT DATA (Req 16.2): fewer than 2 approved questions →
 *     insufficient; the shared INSUFFICIENT_DATA_RESULT is zero clusters +
 *     `insufficient_data: true`; non-finite counts fail closed.
 *   - MEMBERSHIP VALIDATION (Req 16.10): every member id in the event set →
 *     valid; a SINGLE foreign id rejects the WHOLE response
 *     (`foreign_question_id`); a shape violation → `invalid_shape`.
 *   - SHAPE BOUNDS (Req 16.1, 16.7): label 1–100 (trimmed; empty & 101
 *     rejected); member-count 2–500 (1 & 501 rejected).
 *   - ADDITIVE CREATION (Req 16.4): only members' `clusterId` is set; other
 *     questions untouched; the SAME record set is retained (nothing
 *     deleted/merged); original fields intact; `preservesQuestionRecordSet`.
 *   - DISSOLUTION (Req 16.9): the cluster's members' `clusterId` is NULLed;
 *     other questions untouched; the SAME record set is retained.
 *
 * These are PURE Node tests — no DB, no Deno. They must actually RUN.
 *
 * Requirements: 16.2, 16.4, 16.7, 16.9, 16.10, 26.1.
 * Design: Server-Side AI Gateway Design → Clustering (prompt-based only;
 * insufficient-data short-circuit; membership validation rejects the whole
 * response; additive creation; dissolution NULLs members' cluster_id).
 */
import { describe, expect, it } from 'vitest';

import {
  AI_CLUSTER_LABEL_MAX,
  AI_CLUSTER_LABEL_MIN,
  AI_CLUSTER_MEMBERS_MAX,
  AI_CLUSTER_MEMBERS_MIN,
  type AiCluster,
} from '../../schemas/ai';
import {
  INSUFFICIENT_DATA_RESULT,
  MIN_APPROVED_FOR_CLUSTERING,
  applyClusterCreation,
  applyClusterDissolution,
  isInsufficientForClustering,
  isValidClusterLabel,
  isValidClusterMemberCount,
  isValidClusterShape,
  preservesQuestionRecordSet,
  validateClusterMembership,
  validateClusterResult,
} from './clusterRules';

// A small pool of deterministic UUIDs for membership tests (validateClusterResult
// runs the shared Zod schema which requires each question_id to be a UUID).
const UUID = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
  foreign: '99999999-9999-4999-8999-999999999999',
} as const;

// ===========================================================================
// Insufficient-data threshold (Req 16.2)
// ===========================================================================
describe('isInsufficientForClustering — <2 approved questions (Req 16.2)', () => {
  it('reports fewer than 2 approved questions as insufficient (Req 16.2)', () => {
    expect(isInsufficientForClustering(0)).toBe(true);
    expect(isInsufficientForClustering(1)).toBe(true);
  });

  it('reports 2 or more approved questions as sufficient (Req 16.2)', () => {
    expect(isInsufficientForClustering(2)).toBe(false);
    expect(isInsufficientForClustering(3)).toBe(false);
    expect(isInsufficientForClustering(500)).toBe(false);
  });

  it('treats a non-finite / negative count as insufficient — fails closed (Req 16.2)', () => {
    expect(isInsufficientForClustering(Number.NaN)).toBe(true);
    expect(isInsufficientForClustering(Number.POSITIVE_INFINITY)).toBe(true);
    expect(isInsufficientForClustering(-1)).toBe(true);
  });

  it('the threshold equals the schema minimum member count of 2 (Req 16.2)', () => {
    expect(MIN_APPROVED_FOR_CLUSTERING).toBe(AI_CLUSTER_MEMBERS_MIN);
    expect(MIN_APPROVED_FOR_CLUSTERING).toBe(2);
  });
});

describe('INSUFFICIENT_DATA_RESULT — zero clusters + indication (Req 16.2)', () => {
  it('is zero clusters plus insufficient_data: true (Req 16.2)', () => {
    expect(INSUFFICIENT_DATA_RESULT.clusters).toEqual([]);
    expect(INSUFFICIENT_DATA_RESULT.insufficient_data).toBe(true);
  });

  it('is frozen so callers cannot mutate the shared value', () => {
    expect(Object.isFrozen(INSUFFICIENT_DATA_RESULT)).toBe(true);
  });
});

// ===========================================================================
// Cluster label bounds (Req 16.1, 16.7)
// ===========================================================================
describe('isValidClusterLabel — 1–100 trimmed chars (Req 16.7)', () => {
  it('accepts the 1-char and 100-char boundaries (Req 16.7)', () => {
    expect(isValidClusterLabel('x'.repeat(AI_CLUSTER_LABEL_MIN))).toBe(true);
    expect(isValidClusterLabel('x'.repeat(AI_CLUSTER_LABEL_MAX))).toBe(true);
  });

  it('rejects an empty / whitespace-only label and 101 chars (Req 16.7)', () => {
    expect(isValidClusterLabel('')).toBe(false);
    expect(isValidClusterLabel('   ')).toBe(false);
    expect(isValidClusterLabel('x'.repeat(AI_CLUSTER_LABEL_MAX + 1))).toBe(
      false,
    );
  });

  it('checks the TRIMMED length, matching the schema (Req 16.7)', () => {
    // 100 non-space chars surrounded by spaces trims back to 100 → valid.
    expect(isValidClusterLabel(`  ${'x'.repeat(AI_CLUSTER_LABEL_MAX)}  `)).toBe(
      true,
    );
  });

  it('rejects a non-string label', () => {
    expect(isValidClusterLabel(undefined)).toBe(false);
    expect(isValidClusterLabel(123)).toBe(false);
  });
});

// ===========================================================================
// Cluster member-count bounds (Req 16.1)
// ===========================================================================
describe('isValidClusterMemberCount — 2–500 members (Req 16.1)', () => {
  it('accepts the 2-member and 500-member boundaries (Req 16.1)', () => {
    expect(
      isValidClusterMemberCount(new Array(AI_CLUSTER_MEMBERS_MIN).fill('id')),
    ).toBe(true);
    expect(
      isValidClusterMemberCount(new Array(AI_CLUSTER_MEMBERS_MAX).fill('id')),
    ).toBe(true);
  });

  it('rejects 1 member (below min) and 501 members (above max) (Req 16.1)', () => {
    expect(
      isValidClusterMemberCount(
        new Array(AI_CLUSTER_MEMBERS_MIN - 1).fill('id'),
      ),
    ).toBe(false);
    expect(
      isValidClusterMemberCount(
        new Array(AI_CLUSTER_MEMBERS_MAX + 1).fill('id'),
      ),
    ).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(isValidClusterMemberCount(undefined)).toBe(false);
    expect(isValidClusterMemberCount('not-an-array')).toBe(false);
  });
});

describe('isValidClusterShape — both bounds together (Req 16.1, 16.7)', () => {
  it('is valid only when label AND member count are both in bounds', () => {
    expect(
      isValidClusterShape({ label: 'Ops', question_ids: [UUID.a, UUID.b] }),
    ).toBe(true);
  });

  it('is invalid when the label is out of bounds', () => {
    expect(
      isValidClusterShape({ label: '', question_ids: [UUID.a, UUID.b] }),
    ).toBe(false);
  });

  it('is invalid when the member count is out of bounds', () => {
    expect(isValidClusterShape({ label: 'Ops', question_ids: [UUID.a] })).toBe(
      false,
    );
  });

  it('is invalid for a null cluster', () => {
    expect(isValidClusterShape(null as unknown as { label: unknown })).toBe(
      false,
    );
  });
});

// ===========================================================================
// Membership validation against the current event (Req 16.10)
// ===========================================================================
describe('validateClusterMembership — every member must belong to the event (Req 16.10)', () => {
  const eventIds = [UUID.a, UUID.b, UUID.c];

  it('is valid when every member id belongs to the event set (Req 16.10)', () => {
    const clusters: AiCluster[] = [
      { label: 'Group A', question_ids: [UUID.a, UUID.b] },
    ];
    expect(validateClusterMembership(clusters, eventIds)).toEqual({
      valid: true,
      clusters,
    });
  });

  it('rejects the WHOLE response when a single member id is foreign (Req 16.10)', () => {
    const clusters: AiCluster[] = [
      { label: 'Valid group', question_ids: [UUID.a, UUID.b] },
      { label: 'Has a foreign id', question_ids: [UUID.c, UUID.foreign] },
    ];
    // A single foreign id anywhere rejects everything — no partial acceptance.
    expect(validateClusterMembership(clusters, eventIds)).toEqual({
      valid: false,
      reason: 'foreign_question_id',
    });
  });

  it('reports invalid_shape when a cluster violates the shape bounds (Req 16.1)', () => {
    const clusters = [
      { label: 'Too few', question_ids: [UUID.a] },
    ] as unknown as AiCluster[];
    expect(validateClusterMembership(clusters, eventIds)).toEqual({
      valid: false,
      reason: 'invalid_shape',
    });
  });

  it('accepts an event id set supplied as a Set', () => {
    const clusters: AiCluster[] = [
      { label: 'Group', question_ids: [UUID.a, UUID.c] },
    ];
    expect(validateClusterMembership(clusters, new Set(eventIds))).toEqual({
      valid: true,
      clusters,
    });
  });

  it('is trivially valid for an empty cluster list', () => {
    expect(validateClusterMembership([], eventIds)).toEqual({
      valid: true,
      clusters: [],
    });
  });
});

describe('validateClusterResult — schema + membership in one step (Req 16.1, 16.10)', () => {
  const eventIds = [UUID.a, UUID.b, UUID.c];

  it('accepts a well-formed result whose members all belong to the event (Req 16.10)', () => {
    const result = {
      clusters: [{ label: 'Group A', question_ids: [UUID.a, UUID.b] }],
      insufficient_data: false,
    };
    expect(validateClusterResult(result, eventIds)).toEqual({
      valid: true,
      clusters: result.clusters,
    });
  });

  it('rejects the WHOLE result for a single foreign member id (Req 16.10)', () => {
    const result = {
      clusters: [{ label: 'Group', question_ids: [UUID.a, UUID.foreign] }],
      insufficient_data: false,
    };
    expect(validateClusterResult(result, eventIds)).toEqual({
      valid: false,
      reason: 'foreign_question_id',
    });
  });

  it('reports invalid_shape when the raw result fails the schema (Req 16.1)', () => {
    const result = {
      clusters: [{ label: 'Only one', question_ids: [UUID.a] }],
      insufficient_data: false,
    };
    expect(validateClusterResult(result, eventIds)).toEqual({
      valid: false,
      reason: 'invalid_shape',
    });
  });

  it('validates the insufficient-data result trivially (Req 16.2)', () => {
    expect(
      validateClusterResult(
        { clusters: [], insufficient_data: true },
        eventIds,
      ),
    ).toEqual({ valid: true, clusters: [] });
  });
});

// ===========================================================================
// Additive creation (Req 16.4)
// ===========================================================================
describe('applyClusterCreation — additive; originals preserved (Req 16.4)', () => {
  const questions = [
    { id: UUID.a, clusterId: null, text: 'Q A', voteCount: 3 },
    { id: UUID.b, clusterId: null, text: 'Q B', voteCount: 5 },
    { id: UUID.c, clusterId: null, text: 'Q C', voteCount: 1 },
  ];

  it('sets clusterId ONLY on the members and leaves other questions unchanged (Req 16.4)', () => {
    const after = applyClusterCreation(questions, 'cluster-1', [
      UUID.a,
      UUID.b,
    ]);
    const byId = new Map(after.map((q) => [q.id, q]));
    expect(byId.get(UUID.a)?.clusterId).toBe('cluster-1');
    expect(byId.get(UUID.b)?.clusterId).toBe('cluster-1');
    // Non-member untouched.
    expect(byId.get(UUID.c)?.clusterId).toBeNull();
  });

  it('keeps the SAME record set — nothing deleted/merged (Req 16.4)', () => {
    const after = applyClusterCreation(questions, 'cluster-1', [
      UUID.a,
      UUID.b,
    ]);
    expect(after).toHaveLength(questions.length);
    expect(preservesQuestionRecordSet(questions, after)).toBe(true);
  });

  it('preserves every original non-cluster field intact (Req 16.4)', () => {
    const after = applyClusterCreation(questions, 'cluster-1', [UUID.a]);
    const memberA = after.find((q) => q.id === UUID.a);
    expect(memberA).toMatchObject({ id: UUID.a, text: 'Q A', voteCount: 3 });
  });

  it('does NOT mutate the input array (returns a new array) (Req 16.4)', () => {
    const after = applyClusterCreation(questions, 'cluster-1', [UUID.a]);
    expect(after).not.toBe(questions);
    // Original untouched.
    expect(questions.find((q) => q.id === UUID.a)?.clusterId).toBeNull();
  });

  it('accepts member ids supplied as a Set', () => {
    const after = applyClusterCreation(
      questions,
      'cluster-1',
      new Set([UUID.a, UUID.c]),
    );
    const byId = new Map(after.map((q) => [q.id, q]));
    expect(byId.get(UUID.a)?.clusterId).toBe('cluster-1');
    expect(byId.get(UUID.c)?.clusterId).toBe('cluster-1');
    expect(byId.get(UUID.b)?.clusterId).toBeNull();
  });
});

// ===========================================================================
// Dissolution (Req 16.9)
// ===========================================================================
describe('applyClusterDissolution — NULLs members; records retained (Req 16.9)', () => {
  const questions = [
    { id: UUID.a, clusterId: 'cluster-1', text: 'Q A' },
    { id: UUID.b, clusterId: 'cluster-1', text: 'Q B' },
    { id: UUID.c, clusterId: 'cluster-2', text: 'Q C' },
  ];

  it("NULLs clusterId for the dissolved cluster's members only (Req 16.9)", () => {
    const after = applyClusterDissolution(questions, 'cluster-1');
    const byId = new Map(after.map((q) => [q.id, q]));
    expect(byId.get(UUID.a)?.clusterId).toBeNull();
    expect(byId.get(UUID.b)?.clusterId).toBeNull();
    // A member of a DIFFERENT cluster is untouched.
    expect(byId.get(UUID.c)?.clusterId).toBe('cluster-2');
  });

  it('retains the SAME record set — no question is deleted (Req 16.9)', () => {
    const after = applyClusterDissolution(questions, 'cluster-1');
    expect(after).toHaveLength(questions.length);
    expect(preservesQuestionRecordSet(questions, after)).toBe(true);
  });

  it('preserves every other field on the members (Req 16.9)', () => {
    const after = applyClusterDissolution(questions, 'cluster-1');
    const memberA = after.find((q) => q.id === UUID.a);
    expect(memberA).toMatchObject({ id: UUID.a, text: 'Q A', clusterId: null });
  });

  it('does NOT mutate the input array (returns a new array) (Req 16.9)', () => {
    const after = applyClusterDissolution(questions, 'cluster-1');
    expect(after).not.toBe(questions);
    expect(questions.find((q) => q.id === UUID.a)?.clusterId).toBe('cluster-1');
  });

  it('is a no-op for a cluster id with no members', () => {
    const after = applyClusterDissolution(questions, 'cluster-none');
    expect(after.map((q) => q.clusterId)).toEqual([
      'cluster-1',
      'cluster-1',
      'cluster-2',
    ]);
    expect(preservesQuestionRecordSet(questions, after)).toBe(true);
  });
});

// ===========================================================================
// preservesQuestionRecordSet — the "never delete/merge originals" helper
// (Req 16.4, 16.9)
// ===========================================================================
describe('preservesQuestionRecordSet — same id set before/after (Req 16.4, 16.9)', () => {
  const before = [
    { id: UUID.a, clusterId: null },
    { id: UUID.b, clusterId: null },
  ];

  it('is true when the same ids are present after a transition', () => {
    const after = [
      { id: UUID.a, clusterId: 'c1' },
      { id: UUID.b, clusterId: 'c1' },
    ];
    expect(preservesQuestionRecordSet(before, after)).toBe(true);
  });

  it('is false when a record was deleted (fewer records)', () => {
    expect(
      preservesQuestionRecordSet(before, [{ id: UUID.a, clusterId: 'c1' }]),
    ).toBe(false);
  });

  it('is false when a foreign record was introduced (different id set)', () => {
    const after = [
      { id: UUID.a, clusterId: 'c1' },
      { id: UUID.foreign, clusterId: 'c1' },
    ];
    expect(preservesQuestionRecordSet(before, after)).toBe(false);
  });
});
