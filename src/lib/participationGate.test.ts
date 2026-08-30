/**
 * Task 7.5 — Property-based test for event-status gating groundwork.
 *
 * Feature: mss-livepulse
 * Property 11: Event-status gating of participation.
 *
 * Property 11 states: for all events across every status, participation
 * (join controls, question submit, vote, poll response, word-cloud response) is
 * accepted **iff** the event status is `live`; otherwise it is rejected and the
 * participation controls are withheld.
 *
 * For Milestone 1 the participation-WRITE actions and their tables do not exist
 * yet, so this test exercises the M1 groundwork: the pure event-status GATE
 * predicate `isParticipationEligible`, which the audience UI uses to show or
 * withhold participation controls (Req 2.8).
 *
 * The AUTHORITATIVE enforcement of Property 11 lives in the database — the
 * `events` anonymous RLS policy (`status = 'live'`) and the `event_is_live`
 * SQL helper (task 4.6). Those are exercised against the real DB by the live-RLS
 * integration tests in `src/db/rls.events.test.ts` in CI. This file verifies the
 * shared client-side contract matches that rule across all statuses.
 *
 * NOTE: importing directly by path (`./participationGate`) rather than through
 * the `./index` barrel, because the barrel is edited by a concurrent task; the
 * module can be re-exported from the barrel later.
 *
 * Validates: Requirements 1.6, 1.7, 1.9, 2.8
 * Design: Correctness Properties (Property 11); RLS Design (`events`)
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isParticipationEligible, type EventStatus } from './participationGate';

/** All four event lifecycle statuses (matches the `event_status` enum). */
const ALL_STATUSES: readonly EventStatus[] = [
  'draft',
  'live',
  'ended',
  'archived',
];

describe('Feature: mss-livepulse, Property 11: Event-status gating of participation', () => {
  it('holds for all statuses: isParticipationEligible(status) === (status === "live")', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<EventStatus>('draft', 'live', 'ended', 'archived'),
        (status) => {
          // Property: participation is eligible iff the event is live.
          expect(isParticipationEligible(status)).toBe(status === 'live');
        },
      ),
      { numRuns: 200 },
    );
  });

  // Explicit example assertions for clarity (Property 11; Req 1.6, 1.7, 1.9, 2.8).
  it('returns true for a live event (participation controls shown)', () => {
    expect(isParticipationEligible('live')).toBe(true);
  });

  it('returns false for draft, ended and archived events (participation withheld)', () => {
    expect(isParticipationEligible('draft')).toBe(false);
    expect(isParticipationEligible('ended')).toBe(false);
    expect(isParticipationEligible('archived')).toBe(false);
  });

  it('mirrors the events anon RLS rule for every enum status (exactly one eligible)', () => {
    const eligible = ALL_STATUSES.filter((s) => isParticipationEligible(s));
    expect(eligible).toEqual(['live']);
  });
});
