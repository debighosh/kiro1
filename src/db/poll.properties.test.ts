/**
 * Task 21.6 — Property-based tests for the poll INVARIANTS (Properties 4, 5),
 * exercised against the pure in-memory reference model in src/db/pollRules.ts.
 *
 * WHY A MODEL AND NOT THE LIVE SQL
 * --------------------------------
 * The authoritative poll logic lives in PostgreSQL SECURITY DEFINER RPCs
 * (supabase/migrations/20260101000025_poll_transition_rpc.sql — set_poll_status;
 * 20260101000027_poll_respond_rpc.sql — submit_poll_response). Those functions
 * use plpgsql, the `poll_status` enum, `event_is_live`, row/advisory locks and —
 * for Property 5 — the `one_open_poll_per_event` PARTIAL UNIQUE index, none of
 * which can execute in this sandbox (no Postgres/Deno/psql/supabase CLI; pg-mem
 * cannot represent plpgsql, custom types, partial unique indexes or locks). A
 * live execution test runs against a real Postgres in CI via the env-gated
 * integration suites. The model and the SQL are a matched pair (see the header
 * of src/db/pollRules.ts), mirroring the M2 voting.properties.test.ts approach.
 *
 * These property tests lock down the DECISION RULES the SQL encodes — the
 * exactly-one-response-per-(participant, poll) upsert-replace (Property 4) and
 * the at-most-one-open-poll-per-event lifecycle guard (Property 5) — so a change
 * to the intended behaviour is caught fast.
 *
 * Validates: Requirements 5.5, 5.6, 5.7, 5.8, 26.1
 * Design: Correctness Properties (Properties 4, 5); Request/data flows (Poll
 *         lifecycle — single-open guard; upsert replace).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  ALL_POLL_STATUSES,
  PollModel,
  PollRuleError,
  type PollStatus,
} from './pollRules';

/** A small pool of distinct participant identifiers to force collisions. */
const PARTICIPANT_POOL = ['p-a', 'p-b', 'p-c'] as const;

// ===========================================================================
// Feature: mss-livepulse, Property 4: One response per participant per poll,
// latest replaces earlier. For a participant and any random sequence of option
// selections on an OPEN poll, after every upsert there is EXACTLY ONE response
// row for (participant, poll) and its option_id equals the most recent choice.
// The per-option response_count tallies stay consistent (their sum equals the
// number of participants who have responded). Validates Req 5.7, 5.8.
// ===========================================================================

describe('Feature: mss-livepulse, Property 4: One response per participant per poll, latest replaces earlier', () => {
  it('after every upsert, exactly one response remains equal to the last choice; tallies stay consistent', () => {
    fc.assert(
      fc.property(
        // 3 options, and a sequence of (participant, optionIndex) selections.
        fc.array(
          fc.record({
            participant: fc.constantFrom(...PARTICIPANT_POOL),
            optionIndex: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (selections) => {
          const model = new PollModel();
          model.addEvent('e1', { live: true });
          const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
          const optionIds = [
            model.addOption({ pollId }),
            model.addOption({ pollId }),
            model.addOption({ pollId }),
          ];
          model.setPollStatus(pollId, 'open');

          // Shadow model of the latest choice per participant.
          const latest = new Map<string, string>();

          for (const sel of selections) {
            const optionId = optionIds[sel.optionIndex];
            const returned = model.submitPollResponse(
              pollId,
              sel.participant,
              optionId,
            );
            latest.set(sel.participant, optionId);

            // The RPC returns the now-recorded option for this participant.
            expect(returned).toBe(optionId);

            // Invariant (Property 4): EXACTLY ONE response per (participant,
            // poll), equal to the latest submitted choice.
            for (const p of PARTICIPANT_POOL) {
              const expected = latest.get(p);
              expect(model.getResponseCountFor(p, pollId)).toBe(
                expected === undefined ? 0 : 1,
              );
              expect(model.getResponse(p, pollId)).toBe(expected);
            }

            // Tally consistency: the option counts sum to the number of
            // participants who have responded so far, and each count equals the
            // number of participants whose latest choice is that option.
            const respondedCount = latest.size;
            let sum = 0;
            for (let i = 0; i < optionIds.length; i += 1) {
              const oid = optionIds[i];
              const count = model.getOptionCount(oid)!;
              expect(count).toBeGreaterThanOrEqual(0);
              const expectedForOption = [...latest.values()].filter(
                (v) => v === oid,
              ).length;
              expect(count).toBe(expectedForOption);
              sum += count;
            }
            expect(sum).toBe(respondedCount);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('example: changing choice A→B→A leaves one response = A and moves the tally', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    const a = model.addOption({ pollId });
    const b = model.addOption({ pollId });
    model.setPollStatus(pollId, 'open');

    model.submitPollResponse(pollId, 'p-a', a);
    expect(model.getOptionCount(a)).toBe(1);
    expect(model.getOptionCount(b)).toBe(0);

    model.submitPollResponse(pollId, 'p-a', b);
    expect(model.getOptionCount(a)).toBe(0);
    expect(model.getOptionCount(b)).toBe(1);

    model.submitPollResponse(pollId, 'p-a', a);
    expect(model.getOptionCount(a)).toBe(1);
    expect(model.getOptionCount(b)).toBe(0);

    // Exactly one response, equal to the last choice (A).
    expect(model.getResponseCountFor('p-a', pollId)).toBe(1);
    expect(model.getResponse('p-a', pollId)).toBe(a);
  });

  it('example: re-submitting the same option is an idempotent no-op on the tally', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    const a = model.addOption({ pollId });
    model.setPollStatus(pollId, 'open');

    model.submitPollResponse(pollId, 'p-a', a);
    model.submitPollResponse(pollId, 'p-a', a);
    model.submitPollResponse(pollId, 'p-a', a);

    expect(model.getOptionCount(a)).toBe(1);
    expect(model.getResponseCountFor('p-a', pollId)).toBe(1);
  });
});

// ===========================================================================
// Feature: mss-livepulse, Property 5: At most one open poll per event. For any
// random sequence of open/close operations over multiple polls in ONE event,
// count(status='open') <= 1 holds after EVERY step, and attempting to open a
// second poll while one is already open is rejected (`poll_already_open`)
// leaving BOTH polls' statuses unchanged. Validates Req 5.5, 5.6.
// ===========================================================================

type LifecycleOp = { pollIndex: number; target: PollStatus };

const NUM_POLLS = 4;

const lifecycleOpArb: fc.Arbitrary<LifecycleOp> = fc.record({
  pollIndex: fc.integer({ min: 0, max: NUM_POLLS - 1 }),
  target: fc.constantFrom<PollStatus>(...ALL_POLL_STATUSES),
});

describe('Feature: mss-livepulse, Property 5: At most one open poll per event', () => {
  it('count(open) <= 1 after every step; a second open is rejected leaving both unchanged', () => {
    fc.assert(
      fc.property(fc.array(lifecycleOpArb, { maxLength: 50 }), (ops) => {
        const model = new PollModel();
        model.addEvent('e1', { live: true });
        const pollIds = Array.from({ length: NUM_POLLS }, () =>
          model.addPoll({ eventId: 'e1', status: 'draft' }),
        );

        // Baseline: no poll open yet.
        expect(model.getOpenPollCount('e1')).toBe(0);

        for (const op of ops) {
          const pollId = pollIds[op.pollIndex];
          const before = pollIds.map((id) => model.getPollStatus(id)!);
          const statusBefore = model.getPollStatus(pollId)!;
          const openBefore = model.getOpenPollCount('e1');

          try {
            model.setPollStatus(pollId, op.target);
          } catch (err) {
            // Only ever a PollRuleError; on rejection NOTHING must change.
            expect(err).toBeInstanceOf(PollRuleError);
            const after = pollIds.map((id) => model.getPollStatus(id)!);
            expect(after).toEqual(before);

            // Trying to open a poll whose OWN lifecycle move is legal
            // (a draft poll) while another poll is already open is the
            // single-open-guard case: it MUST raise poll_already_open and leave
            // both statuses unchanged (Req 5.6). The SQL validates the lifecycle
            // FIRST, so an illegal move (e.g. closed→open) is instead rejected
            // as invalid_transition before the guard is ever reached.
            if (
              op.target === 'open' &&
              statusBefore === 'draft' &&
              openBefore >= 1
            ) {
              expect((err as PollRuleError).kind).toBe('poll_already_open');
            }
          }

          // THE invariant (Property 5): at most one open poll per event after
          // every step, whether the op succeeded or was rejected.
          expect(model.getOpenPollCount('e1')).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('example: opening a second poll while one is open is rejected, both unchanged', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const first = model.addPoll({ eventId: 'e1', status: 'draft' });
    const second = model.addPoll({ eventId: 'e1', status: 'draft' });

    model.setPollStatus(first, 'open');
    expect(model.getOpenPollCount('e1')).toBe(1);

    expect(() => model.setPollStatus(second, 'open')).toThrow(
      /poll_already_open/,
    );
    // Both statuses unchanged: first still open, second still draft.
    expect(model.getPollStatus(first)).toBe('open');
    expect(model.getPollStatus(second)).toBe('draft');
    expect(model.getOpenPollCount('e1')).toBe(1);

    // Closing the first frees the slot; the second may then open.
    model.setPollStatus(first, 'closed');
    expect(model.getOpenPollCount('e1')).toBe(0);
    model.setPollStatus(second, 'open');
    expect(model.getOpenPollCount('e1')).toBe(1);
  });

  it('example: invalid lifecycle transitions are rejected and change nothing', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });

    // draft→closed is not permitted.
    expect(() => model.setPollStatus(pollId, 'closed')).toThrow(
      /invalid_transition/,
    );
    expect(model.getPollStatus(pollId)).toBe('draft');

    // Advance to closed, then closed→open is rejected.
    model.setPollStatus(pollId, 'open');
    model.setPollStatus(pollId, 'closed');
    expect(() => model.setPollStatus(pollId, 'open')).toThrow(
      /invalid_transition/,
    );
    expect(model.getPollStatus(pollId)).toBe('closed');
  });
});
