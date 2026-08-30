/**
 * Task 7.4 (Part B) — Unit tests for the event-status transition rules.
 *
 * These tests exercise the shared, framework-agnostic transition contract in
 * `src/lib/eventStatus.ts` — the same rules the `transition-event-status` Edge
 * Function enforces server-side. Positive + negative cases per Req 26.1.
 *
 * Requirements traceability: 1.8, 1.10, 1.11, 26.1.
 * Design references: Data Models (`events`); Error Handling (Conflict errors).
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  CAN_REACTIVATE_ARCHIVED,
  EVENT_STATUSES,
  type EventStatus,
  classifyTransition,
  isAllowedTransition,
} from './eventStatus';

/** The only three valid forward transitions in V1. */
const ALLOWED_PAIRS: ReadonlyArray<[EventStatus, EventStatus]> = [
  ['draft', 'live'],
  ['live', 'ended'],
  ['ended', 'archived'],
];

function isAllowedPair(from: EventStatus, to: EventStatus): boolean {
  return ALLOWED_PAIRS.some(([f, t]) => f === from && t === to);
}

describe('isAllowedTransition — positive cases (Req 1.8, 1.10)', () => {
  it('allows draft → live', () => {
    expect(isAllowedTransition('draft', 'live')).toBe(true);
  });

  it('allows live → ended', () => {
    expect(isAllowedTransition('live', 'ended')).toBe(true);
  });

  it('allows ended → archived', () => {
    expect(isAllowedTransition('ended', 'archived')).toBe(true);
  });
});

describe('isAllowedTransition — negative cases (Req 1.8, 1.10, 1.11)', () => {
  it('rejects skipping states (draft → ended, draft → archived)', () => {
    expect(isAllowedTransition('draft', 'ended')).toBe(false);
    expect(isAllowedTransition('draft', 'archived')).toBe(false);
  });

  it('rejects skipping live → archived', () => {
    expect(isAllowedTransition('live', 'archived')).toBe(false);
  });

  it('rejects going backwards (ended → live, live → draft, ended → draft)', () => {
    expect(isAllowedTransition('ended', 'live')).toBe(false);
    expect(isAllowedTransition('live', 'draft')).toBe(false);
    expect(isAllowedTransition('ended', 'draft')).toBe(false);
  });

  it('rejects reactivating an archived event (archived → anything, Req 1.11)', () => {
    expect(isAllowedTransition('archived', 'draft')).toBe(false);
    expect(isAllowedTransition('archived', 'live')).toBe(false);
    expect(isAllowedTransition('archived', 'ended')).toBe(false);
    expect(isAllowedTransition('archived', 'archived')).toBe(false);
  });

  it('rejects every no-op (same → same) as an allowed transition', () => {
    for (const status of EVENT_STATUSES) {
      expect(isAllowedTransition(status, status)).toBe(false);
    }
  });

  it('allows exactly the three lifecycle pairs across the full status matrix', () => {
    for (const from of EVENT_STATUSES) {
      for (const to of EVENT_STATUSES) {
        expect(isAllowedTransition(from, to)).toBe(isAllowedPair(from, to));
      }
    }
  });
});

describe('classifyTransition — mirrors the Edge Function decision (Req 1.8, 1.10, 1.11)', () => {
  it('classifies the three lifecycle transitions as allowed', () => {
    expect(classifyTransition('draft', 'live')).toBe('allowed');
    expect(classifyTransition('live', 'ended')).toBe('allowed');
    expect(classifyTransition('ended', 'archived')).toBe('allowed');
  });

  it('classifies a no-op (same → same) as no_op for non-archived statuses (Req 1.8/1.10)', () => {
    expect(classifyTransition('draft', 'draft')).toBe('no_op');
    expect(classifyTransition('live', 'live')).toBe('no_op');
    expect(classifyTransition('ended', 'ended')).toBe('no_op');
  });

  it('classifies archived → archived as no_op (no-op check precedes archived check)', () => {
    expect(classifyTransition('archived', 'archived')).toBe('no_op');
  });

  it('classifies archived → other statuses as archived_not_reactivatable (Req 1.11)', () => {
    expect(classifyTransition('archived', 'draft')).toBe('archived_not_reactivatable');
    expect(classifyTransition('archived', 'live')).toBe('archived_not_reactivatable');
    expect(classifyTransition('archived', 'ended')).toBe('archived_not_reactivatable');
  });

  it('classifies skipping / backwards transitions as invalid', () => {
    expect(classifyTransition('draft', 'ended')).toBe('invalid');
    expect(classifyTransition('draft', 'archived')).toBe('invalid');
    expect(classifyTransition('live', 'archived')).toBe('invalid');
    expect(classifyTransition('ended', 'live')).toBe('invalid');
    expect(classifyTransition('live', 'draft')).toBe('invalid');
  });

  it('classifies every status pair consistently with isAllowedTransition', () => {
    for (const from of EVENT_STATUSES) {
      for (const to of EVENT_STATUSES) {
        const classification = classifyTransition(from, to);
        if (from === to) {
          expect(classification).toBe('no_op');
        } else if (classification === 'allowed') {
          expect(isAllowedTransition(from, to)).toBe(true);
        } else {
          expect(isAllowedTransition(from, to)).toBe(false);
        }
      }
    }
  });
});

describe('transition-rule contract shape', () => {
  it('exposes archived as a terminal state (Req 1.11)', () => {
    expect(ALLOWED_TRANSITIONS.archived).toEqual([]);
    expect(CAN_REACTIVATE_ARCHIVED).toBe(false);
  });

  it('mirrors the Edge Function ALLOWED_TRANSITIONS table exactly', () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      draft: ['live'],
      live: ['ended'],
      ended: ['archived'],
      archived: [],
    });
  });
});
