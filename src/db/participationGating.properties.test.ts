/**
 * Task 17.3 — Property-based test for the participation-WRITE portion of
 * Property 11 (Milestone 2 — Core Live Q&A).
 *
 * Feature: mss-livepulse
 * Property 11: Event-status gating of participation (WRITE portion).
 *
 * =============================================================================
 * WHAT THIS FILE VERIFIES
 * =============================================================================
 * Property 11 states that, across events in EVERY lifecycle status, a
 * participation WRITE (question submit, vote) is ACCEPTED **iff** the event
 * status is `live`, and REJECTED for every other status.
 *
 * Task 7.5 (`src/lib/participationGate.test.ts`) already covered the Milestone-1
 * READ/visibility groundwork via the pure `isParticipationEligible` predicate.
 * THIS file covers the Milestone-2 WRITE portion: it drives the actual
 * participation-write actions — `submitQuestion` and `castVote` — through the
 * shared submit/vote RULE MODEL in `src/db/qaRules.ts` (the pure, in-memory
 * mirror of the SECURITY DEFINER submit/vote RPCs), and asserts the write is
 * accepted exactly when the event is `live`.
 *
 * =============================================================================
 * WHY THE RULE MODEL AND NOT THE LIVE SQL
 * =============================================================================
 * The authoritative submit/vote logic lives in PostgreSQL SECURITY DEFINER
 * functions that gate on the `event_is_live(event_id)` helper (true iff
 * `events.status = 'live'`). Those cannot execute in this sandbox (no
 * Postgres/Deno/supabase CLI). `QaModel` encodes the identical decision rules —
 * its `eventIsLive` gate mirrors `event_is_live` — so the WRITE-gating property
 * can be exercised as fast, pure logic with no live DB. The live-DB enforcement
 * is exercised by the env-gated integration suites in CI.
 *
 * The event_status enum values used below are the CANONICAL codebase values,
 * confirmed from `supabase/migrations/20260101000001_enums.sql`
 * (`CREATE TYPE event_status AS ENUM ('draft', 'live', 'ended', 'archived')`)
 * and `src/lib/eventStatus.ts` (`EVENT_STATUSES`). There is no `paused`,
 * `scheduled`, `completed` or `waiting` status in this schema; the four values
 * below are the complete set.
 *
 * Validates: Requirements 1.6, 1.7, 1.9, 2.8, 3.3, 4.8
 * Design: Correctness Properties (Property 11); RLS Design (`events`,
 *         `questions`, `question_votes`); Request/data flows (submit + vote).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { QaModel, QaRuleError, type ModerationMode, type QuestionStatus } from './qaRules';

/**
 * The complete `event_status` enum — canonical codebase values (see file
 * header). Exactly one of these (`live`) is participation-eligible.
 */
const ALL_EVENT_STATUSES = ['draft', 'live', 'ended', 'archived'] as const;
type EventStatus = (typeof ALL_EVENT_STATUSES)[number];

/**
 * The event-status gating predicate under test, mirroring `event_is_live`: an
 * event is live-gated iff its status is exactly `'live'`.
 */
function statusIsLive(status: EventStatus): boolean {
  return status === 'live';
}

describe('Feature: mss-livepulse, Property 11: Event-status gating of participation (WRITE portion)', () => {
  // -------------------------------------------------------------------------
  // Question submit (Req 3.3): a submit is accepted iff the event is live.
  // -------------------------------------------------------------------------
  it('question submit is accepted iff event status is live (Req 1.6, 1.7, 1.9, 3.3)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<EventStatus>(...ALL_EVENT_STATUSES),
        fc.constantFrom<ModerationMode>('pre', 'post'),
        // A guaranteed-valid 1–300 code-point question text so the ONLY thing
        // that can reject the write is the event-status gate.
        fc.string({ minLength: 1, maxLength: 300 }).map((s) => `q ${s.replace(/\s+/g, ' ')} ?`),
        fc.string({ minLength: 1, maxLength: 40 }),
        (status, mode, text, participant) => {
          const eventId = `event-${status}`;
          const model = new QaModel();
          // The model's live-ness gate is the mirror of event_is_live.
          model.setEvent(eventId, { mode, live: statusIsLive(status) });

          let accepted: boolean;
          try {
            model.submitQuestion({ eventId, participant, text });
            accepted = true;
          } catch (err) {
            // The ONLY rejection reason permitted here is the live gate.
            expect(err).toBeInstanceOf(QaRuleError);
            expect((err as QaRuleError).signal).toBe('event_not_live');
            accepted = false;
          }

          // Property: accepted iff the event is live.
          expect(accepted).toBe(statusIsLive(status));
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Vote (Req 4.8): a vote on an otherwise-eligible (approved/featured)
  // question is accepted iff the event is live.
  // -------------------------------------------------------------------------
  it('vote is accepted iff event status is live (Req 1.6, 1.7, 1.9, 4.8)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<EventStatus>(...ALL_EVENT_STATUSES),
        // Only vote-eligible question statuses, so the ONLY variable gating the
        // write is the event's live-ness (not the question status).
        fc.constantFrom<QuestionStatus>('approved', 'featured'),
        fc.string({ minLength: 1, maxLength: 40 }),
        (status, questionStatus, participant) => {
          const eventId = `event-${status}`;
          const model = new QaModel();
          model.setEvent(eventId, { mode: 'post', live: statusIsLive(status) });
          const questionId = model.seedQuestion({
            eventId,
            status: questionStatus,
            voteCount: 0,
          });

          let accepted: boolean;
          try {
            model.castVote({ questionId, participant });
            accepted = true;
          } catch (err) {
            // With an eligible question status, the ONLY rejection reason is the
            // event live gate (surfaced as `not_eligible` when not live).
            expect(err).toBeInstanceOf(QaRuleError);
            expect((err as QaRuleError).signal).toBe('not_eligible');
            accepted = false;
          }

          // Property: accepted iff the event is live.
          expect(accepted).toBe(statusIsLive(status));
          // And the count only moved when the write was accepted.
          expect(model.getQuestion(questionId)!.voteCount).toBe(accepted ? 1 : 0);
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Combined coverage: for BOTH write kinds, exactly one status (`live`) is
  // write-eligible across the full enum (Req 1.9, 2.8).
  // -------------------------------------------------------------------------
  it('across every event_status, exactly one status (live) permits participation writes', () => {
    const submitAcceptedFor: EventStatus[] = [];
    const voteAcceptedFor: EventStatus[] = [];

    for (const status of ALL_EVENT_STATUSES) {
      const eventId = `event-${status}`;
      const model = new QaModel();
      model.setEvent(eventId, { mode: 'post', live: statusIsLive(status) });

      // Submit attempt.
      try {
        model.submitQuestion({ eventId, participant: 'p-submit', text: 'A valid question?' });
        submitAcceptedFor.push(status);
      } catch (err) {
        expect((err as QaRuleError).signal).toBe('event_not_live');
      }

      // Vote attempt on an eligible (approved) question.
      const qid = model.seedQuestion({ eventId, status: 'approved', voteCount: 0 });
      try {
        model.castVote({ questionId: qid, participant: 'p-vote' });
        voteAcceptedFor.push(status);
      } catch (err) {
        expect((err as QaRuleError).signal).toBe('not_eligible');
      }
    }

    expect(submitAcceptedFor).toEqual(['live']);
    expect(voteAcceptedFor).toEqual(['live']);
  });
});
