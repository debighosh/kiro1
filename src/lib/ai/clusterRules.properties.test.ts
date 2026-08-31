/**
 * Task 31.2 — Property-based test for the cluster vote-total invariant
 * (Property 18), exercised against the pure, Node-testable clustering rules in
 * src/lib/ai/clusterRules.ts (task 31.1) — imported, NEVER reimplemented.
 *
 * WHY A PURE MODEL AND NOT THE LIVE EDGE FUNCTION
 * ------------------------------------------------
 * A cluster's vote total is the ARITHMETIC SUM of its members' current
 * `vote_count` (Req 16.5) and is ALWAYS COMPUTED, NEVER stored (Req 16.6). In
 * production the Deno write path derives it by summing member `vote_count` at
 * read time; that Deno code cannot run under Node / Vitest in this sandbox.
 * src/lib/ai/clusterRules.ts is the AUTHORITATIVE, runtime-agnostic copy of the
 * decision: `computeClusterVoteTotal(memberVoteCounts)` sums a list, and the
 * in-memory `ClusterVoteModel` recomputes `voteTotal` from its live membership
 * on every access (there is no stored-total field / setter). The two are a
 * matched pair.
 *
 * This property locks down the contract: for ANY sequence of add/remove
 * operations the reported total equals the arithmetic sum of the members
 * currently present, and — because the total is recomputed on every read —
 * mutating membership is reflected IMMEDIATELY (the total can never drift from
 * the membership, i.e. it is not stored).
 *
 * Validates: Requirements 16.5, 16.6
 * Design: Correctness Properties (Property 18); Data Models (`question_clusters`;
 * computed cluster vote total).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  ClusterVoteModel,
  computeClusterVoteTotal,
  type ClusterMember,
} from './clusterRules';

// ---------------------------------------------------------------------------
// Generators.
//
// A member is an id drawn from a small pool (so add/remove operations collide
// and re-adding an existing id exercises the single-membership replace rule)
// plus a NON-NEGATIVE integer vote count. The pool is intentionally tiny so a
// random operation sequence repeatedly touches the same ids.
// ---------------------------------------------------------------------------

/** A small pool of distinct question ids to force membership collisions. */
const ID_POOL = ['q-a', 'q-b', 'q-c', 'q-d', 'q-e'] as const;

/** A non-negative vote count (a vote_count is a non-negative integer). */
const voteCountArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000 });

const memberArb: fc.Arbitrary<ClusterMember> = fc.record({
  questionId: fc.constantFrom(...ID_POOL),
  voteCount: voteCountArb,
});

type ClusterOp =
  | {
      readonly kind: 'add';
      readonly questionId: string;
      readonly voteCount: number;
    }
  | { readonly kind: 'remove'; readonly questionId: string };

const clusterOpArb: fc.Arbitrary<ClusterOp> = fc.oneof(
  fc.record({
    kind: fc.constant<'add'>('add'),
    questionId: fc.constantFrom(...ID_POOL),
    voteCount: voteCountArb,
  }),
  fc.record({
    kind: fc.constant<'remove'>('remove'),
    questionId: fc.constantFrom(...ID_POOL),
  }),
);

/** The arithmetic sum of an oracle's currently-present member vote counts. */
function arithmeticSum(oracle: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of oracle.values()) {
    total += count;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 18: Cluster vote total equals sum of member
// votes. For clusters built from random members with random non-negative
// vote_counts, the computed vote total equals the arithmetic sum of the
// members' vote counts; and as membership is mutated by an arbitrary sequence
// of add/remove operations the total ALWAYS equals the new arithmetic sum of
// the currently-present members. The total is COMPUTED on every read, never
// stored, so a mutation is reflected immediately. Validates Req 16.5, 16.6.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 18: Cluster vote total equals sum of member votes', () => {
  it('computeClusterVoteTotal equals the arithmetic sum of the member vote counts', () => {
    fc.assert(
      fc.property(fc.array(voteCountArb, { maxLength: 500 }), (voteCounts) => {
        const expected = voteCounts.reduce((acc, n) => acc + n, 0);
        expect(computeClusterVoteTotal(voteCounts)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('the constructed model total equals the sum of its distinct members (re-add replaces)', () => {
    fc.assert(
      fc.property(fc.array(memberArb, { maxLength: 20 }), (members) => {
        const model = new ClusterVoteModel(members);

        // Oracle: single membership per id — a later member with the same id
        // REPLACES the earlier vote count (mirrors ClusterVoteModel.addMember).
        const oracle = new Map<string, number>();
        for (const m of members) {
          oracle.set(m.questionId, m.voteCount);
        }

        expect(model.size).toBe(oracle.size);
        expect(model.voteTotal).toBe(arithmeticSum(oracle));
      }),
      { numRuns: 300 },
    );
  });

  it('after EVERY add/remove op the total equals the new arithmetic sum; total is computed not stored', () => {
    fc.assert(
      fc.property(
        fc.array(memberArb, { maxLength: 5 }),
        fc.array(clusterOpArb, { maxLength: 40 }),
        (initialMembers, ops) => {
          const model = new ClusterVoteModel(initialMembers);

          // Oracle mirrors the model's membership with single membership per id.
          const oracle = new Map<string, number>();
          for (const m of initialMembers) {
            oracle.set(m.questionId, m.voteCount);
          }

          // Baseline invariant before any op.
          expect(model.voteTotal).toBe(arithmeticSum(oracle));

          for (const op of ops) {
            if (op.kind === 'add') {
              model.addMember(op.questionId, op.voteCount);
              // Re-adding an existing id REPLACES its vote count (single
              // membership) — reflect that in the oracle by overwriting.
              oracle.set(op.questionId, op.voteCount);
            } else {
              const wasPresent = oracle.has(op.questionId);
              expect(model.hasMember(op.questionId)).toBe(wasPresent);
              model.removeMember(op.questionId);
              oracle.delete(op.questionId);
            }

            // The total is recomputed on this read and MUST equal the new sum of
            // the currently-present members — the mutation is reflected
            // IMMEDIATELY, proving the total is computed, not a stale stored
            // value (Req 16.5, 16.6).
            const expectedTotal = arithmeticSum(oracle);
            expect(model.voteTotal).toBe(expectedTotal);
            expect(model.size).toBe(oracle.size);
            expect(model.voteTotal).toBeGreaterThanOrEqual(0);

            // Reading twice with no mutation in between yields the same value
            // (the recomputation is a pure function of the live membership).
            expect(model.voteTotal).toBe(expectedTotal);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('there is no stored total: mutating a member vote count changes voteTotal on the next read', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ID_POOL),
        voteCountArb,
        voteCountArb,
        (id, first, second) => {
          const model = new ClusterVoteModel([
            { questionId: id, voteCount: first },
          ]);
          expect(model.voteTotal).toBe(first);

          // Re-add the SAME id with a different count: single membership means
          // the count is replaced, and the recomputed total reflects it at once.
          model.addMember(id, second);
          expect(model.size).toBe(1);
          expect(model.voteTotal).toBe(second);

          // Removing the sole member drops the total straight back to 0.
          model.removeMember(id);
          expect(model.hasMember(id)).toBe(false);
          expect(model.voteTotal).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('example: total tracks membership through a concrete add/remove sequence', () => {
    const model = new ClusterVoteModel([
      { questionId: 'q-a', voteCount: 3 },
      { questionId: 'q-b', voteCount: 5 },
    ]);
    expect(model.voteTotal).toBe(8);

    model.addMember('q-c', 2);
    expect(model.voteTotal).toBe(10);

    // Re-add q-a with a new count → replaces (3 → 7): total 10 - 3 + 7 = 14.
    model.addMember('q-a', 7);
    expect(model.size).toBe(3);
    expect(model.voteTotal).toBe(14);

    model.removeMember('q-b');
    expect(model.voteTotal).toBe(9);

    // Removing an absent id is a no-op on the total.
    model.removeMember('q-zzz');
    expect(model.voteTotal).toBe(9);
  });
});
