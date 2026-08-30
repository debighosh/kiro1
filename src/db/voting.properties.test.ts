/**
 * Task 13.6 — Property-based tests for the question-voting invariants,
 * exercised against the pure in-memory reference model in src/db/qaRules.ts.
 *
 * WHY A MODEL AND NOT THE LIVE SQL
 * --------------------------------
 * The authoritative voting logic lives in PostgreSQL SECURITY DEFINER RPCs
 * (supabase/migrations/20260101000015_vote_rpc.sql — cast_question_vote /
 * remove_question_vote — using the 20260101000013 rate-limiting helper). Those
 * functions use plpgsql, custom enum types, `event_is_live`, advisory locks and
 * a real UNIQUE (participant_identifier, question_id) constraint — none of which
 * can execute in this sandbox (no Postgres/Deno/psql/supabase CLI; pg-mem cannot
 * represent plpgsql, custom types or advisory locks). A live execution test runs
 * against a real Postgres in CI via the env-gated integration suites.
 *
 * These property tests lock down the DECISION RULES the SQL encodes — the
 * one-active-vote-per-participant-per-question uniqueness, the add/remove count
 * round trip, and status-based vote eligibility — so a change to the intended
 * behaviour is caught fast. The model and the SQL are a matched pair.
 *
 * A fresh QaModel is constructed per property run (and votes stay well under the
 * 30-votes/60s window) so the sliding-window rate limit never interferes with
 * the invariants under test.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8
 * Design: Correctness Properties (voting invariants); RLS Design (vote RPCs).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  QaModel,
  QaRuleError,
  VOTE_ELIGIBLE_STATUSES,
  type QuestionStatus,
} from './qaRules';

/** All five question statuses (matches the `question_status` enum). */
const ALL_STATUSES: readonly QuestionStatus[] = [
  'pending',
  'approved',
  'featured',
  'answered',
  'hidden',
];

/** A small pool of distinct participant identifiers to force collisions. */
const PARTICIPANT_POOL = ['p-a', 'p-b', 'p-c', 'p-d'] as const;

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 1: One active vote per participant per
// question. For any random sequence of cast/remove operations (including
// duplicates), there is never more than one active vote row per
// (participant, question), and a duplicate cast is rejected with the question's
// vote_count left unchanged. Validates Req 4.2, 4.3, 4.4.
// ---------------------------------------------------------------------------

type VoteOp = { kind: 'cast' | 'remove'; participant: string };

const voteOpArb: fc.Arbitrary<VoteOp> = fc.record({
  kind: fc.constantFrom<'cast' | 'remove'>('cast', 'remove'),
  participant: fc.constantFrom(...PARTICIPANT_POOL),
});

describe('Feature: mss-livepulse, Property 1: One active vote per participant per question', () => {
  it('never allows >1 active vote per (participant, question); duplicate cast rejected, count unchanged', () => {
    fc.assert(
      // Cap each participant to <=30 casts over the window to avoid rate limits:
      // the whole op sequence is <=24 items across 4 participants, i.e. <=24
      // casts per participant total — comfortably under VOTE_RATE_LIMIT_MAX (30).
      fc.property(fc.array(voteOpArb, { maxLength: 24 }), (ops) => {
        const model = new QaModel();
        model.setEvent('e1', { mode: 'post', live: true });
        // Eligible status so casts are allowed and eligibility never masks the
        // uniqueness rule under test.
        const qid = model.seedQuestion({ eventId: 'e1', status: 'approved' });

        // Shadow set of participants believed to currently hold an active vote.
        const activeVotes = new Set<string>();

        for (const op of ops) {
          const before = model.getQuestion(qid)!.voteCount;
          if (op.kind === 'cast') {
            if (activeVotes.has(op.participant)) {
              // Duplicate cast: MUST be rejected and MUST leave count unchanged.
              expect(() =>
                model.castVote({
                  questionId: qid,
                  participant: op.participant,
                }),
              ).toThrow(QaRuleError);
              expect(model.getQuestion(qid)!.voteCount).toBe(before);
            } else {
              const after = model.castVote({
                questionId: qid,
                participant: op.participant,
              });
              expect(after).toBe(before + 1);
              activeVotes.add(op.participant);
            }
          } else {
            // remove
            if (activeVotes.has(op.participant)) {
              const after = model.removeVote({
                questionId: qid,
                participant: op.participant,
              });
              expect(after).toBe(before - 1);
              activeVotes.delete(op.participant);
            } else {
              expect(() =>
                model.removeVote({
                  questionId: qid,
                  participant: op.participant,
                }),
              ).toThrow(QaRuleError);
              expect(model.getQuestion(qid)!.voteCount).toBe(before);
            }
          }

          // Invariant after every op: vote_count equals the number of
          // participants holding an active vote — i.e. at most one vote row per
          // (participant, question), and never negative.
          const count = model.getQuestion(qid)!.voteCount;
          expect(count).toBe(activeVotes.size);
          expect(count).toBeGreaterThanOrEqual(0);
          expect(count).toBeLessThanOrEqual(PARTICIPANT_POOL.length);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('example: two casts by the same participant increment only once', () => {
    const model = new QaModel();
    model.setEvent('e1', { mode: 'post', live: true });
    const qid = model.seedQuestion({ eventId: 'e1', status: 'approved' });

    expect(model.castVote({ questionId: qid, participant: 'p-a' })).toBe(1);
    expect(() =>
      model.castVote({ questionId: qid, participant: 'p-a' }),
    ).toThrow(/already_voted/);
    expect(model.getQuestion(qid)!.voteCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 2: Vote add/remove round trip preserves
// count. Casting a vote and then removing it restores the original vote_count,
// and removing a vote a participant does not hold is a no-op on the count.
// Validates Req 4.1, 4.5, 4.6.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 2: Vote add/remove round trip preserves count', () => {
  it('add-then-remove by the same participant restores the original count', () => {
    fc.assert(
      fc.property(
        // Pre-seed an arbitrary starting count from OTHER participants, then have
        // a distinct participant add and remove. Keep small to stay well under
        // the rate-limit window.
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom(...PARTICIPANT_POOL),
        (seedVotes, actor) => {
          const model = new QaModel();
          model.setEvent('e1', { mode: 'post', live: true });
          const qid = model.seedQuestion({ eventId: 'e1', status: 'approved' });

          // Build a baseline count from participants distinct from `actor`.
          const others = PARTICIPANT_POOL.filter((p) => p !== actor).slice(
            0,
            seedVotes,
          );
          for (const p of others) {
            model.castVote({ questionId: qid, participant: p });
          }
          const original = model.getQuestion(qid)!.voteCount;
          expect(original).toBe(others.length);

          // Round trip: add then remove by `actor`.
          const afterAdd = model.castVote({
            questionId: qid,
            participant: actor,
          });
          expect(afterAdd).toBe(original + 1);
          const afterRemove = model.removeVote({
            questionId: qid,
            participant: actor,
          });
          expect(afterRemove).toBe(original);
          expect(model.getQuestion(qid)!.voteCount).toBe(original);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('removing a vote the participant does not hold is a no-op on the count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom(...PARTICIPANT_POOL),
        (seedVotes, actor) => {
          const model = new QaModel();
          model.setEvent('e1', { mode: 'post', live: true });
          const qid = model.seedQuestion({ eventId: 'e1', status: 'approved' });

          const others = PARTICIPANT_POOL.filter((p) => p !== actor).slice(
            0,
            seedVotes,
          );
          for (const p of others) {
            model.castVote({ questionId: qid, participant: p });
          }
          const before = model.getQuestion(qid)!.voteCount;

          // `actor` holds no vote: remove MUST reject and leave the count intact.
          expect(() =>
            model.removeVote({ questionId: qid, participant: actor }),
          ).toThrow(/no_vote_to_remove/);
          expect(model.getQuestion(qid)!.voteCount).toBe(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 3: Vote eligibility by status. On a live
// event, a cast succeeds iff the question's status is in {approved, featured};
// for any other status the cast is rejected with the vote_count unchanged.
// Validates Req 4.1, 4.8.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 3: Vote eligibility by status', () => {
  it('a cast succeeds iff status is approved/featured; otherwise rejected, count unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.integer({ min: 0, max: 100 }),
        fc.constantFrom(...PARTICIPANT_POOL),
        (status, seedCount, actor) => {
          const model = new QaModel();
          model.setEvent('e1', { mode: 'post', live: true });
          const qid = model.seedQuestion({
            eventId: 'e1',
            status,
            voteCount: seedCount,
          });
          const before = model.getQuestion(qid)!.voteCount;
          const eligible = VOTE_ELIGIBLE_STATUSES.includes(status);

          if (eligible) {
            const after = model.castVote({
              questionId: qid,
              participant: actor,
            });
            expect(after).toBe(before + 1);
          } else {
            expect(() =>
              model.castVote({ questionId: qid, participant: actor }),
            ).toThrow(/not_eligible/);
            expect(model.getQuestion(qid)!.voteCount).toBe(before);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('example: pending and hidden questions reject a vote with count unchanged', () => {
    for (const status of ['pending', 'hidden', 'answered'] as const) {
      const model = new QaModel();
      model.setEvent('e1', { mode: 'post', live: true });
      const qid = model.seedQuestion({ eventId: 'e1', status, voteCount: 5 });
      expect(() =>
        model.castVote({ questionId: qid, participant: 'p-a' }),
      ).toThrow(/not_eligible/);
      expect(model.getQuestion(qid)!.voteCount).toBe(5);
    }
  });
});
