/**
 * Task 42.3 — Unit tests for the analytics aggregation module (src/lib/analytics.ts).
 *
 * These tests exercise the pure computeEventAnalytics function and its helpers
 * to cover the Req-26.1 behaviours in the Admin authorisation / analytics area.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.8, 26.1
 */
import { describe, expect, it } from 'vitest';

import { BUCKET_MINUTES, BUCKET_MS, computeEventAnalytics } from './analytics';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
describe('exported constants', () => {
  it('BUCKET_MINUTES is 5', () => expect(BUCKET_MINUTES).toBe(5));
  it('BUCKET_MS is 300000 (5 min in ms)', () =>
    expect(BUCKET_MS).toBe(5 * 60 * 1000));
});

// ─────────────────────────────────────────────────────────────────────────────
// computeEventAnalytics — zero-interaction event (Req 8.8)
// ─────────────────────────────────────────────────────────────────────────────
describe('computeEventAnalytics — positive: zero-interaction event (Req 8.8)', () => {
  it('returns all-zero scalars for empty inputs', () => {
    const result = computeEventAnalytics({});
    expect(result.uniqueParticipants).toBe(0);
    expect(result.totalVotes).toBe(0);
    expect(result.pollResponses).toBe(0);
    expect(result.wordCloudResponses).toBe(0);
    expect(result.questionStatusCounts.totalSubmitted).toBe(0);
    expect(result.engagementOverTime).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// uniqueParticipants (Req 8.1, 8.6)
// ─────────────────────────────────────────────────────────────────────────────
describe('computeEventAnalytics — uniqueParticipants (Req 8.1, 8.6)', () => {
  it('positive: counts distinct participant identifiers', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['p1', 'p2', 'p1', 'p3'],
    });
    expect(result.uniqueParticipants).toBe(3);
  });

  it('positive: uses pre-computed uniqueParticipantCount when supplied', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['p1', 'p2', 'p3'], // ignored
      uniqueParticipantCount: 42,
    });
    expect(result.uniqueParticipants).toBe(42);
  });

  it('negative: raw identifiers are NOT returned on result (Req 8.6)', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['secret-id-1', 'secret-id-2'],
    });
    const jsonStr = JSON.stringify(result);
    expect(jsonStr).not.toContain('secret-id-1');
    expect(jsonStr).not.toContain('secret-id-2');
  });

  it('negative: returns 0 for negative uniqueParticipantCount', () => {
    const result = computeEventAnalytics({ uniqueParticipantCount: -5 });
    expect(result.uniqueParticipants).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// questionStatusCounts (Req 8.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('computeEventAnalytics — questionStatusCounts (Req 8.2)', () => {
  it('positive: correctly tallies all statuses and derived total', () => {
    const result = computeEventAnalytics({
      questionStatusCounts: {
        approved: 3,
        featured: 1,
        answered: 2,
        hidden: 1,
        pending: 4,
      },
    });
    expect(result.questionStatusCounts.approved).toBe(3);
    expect(result.questionStatusCounts.featured).toBe(1);
    expect(result.questionStatusCounts.answered).toBe(2);
    expect(result.questionStatusCounts.hidden).toBe(1);
    // totalSubmitted includes pending
    expect(result.questionStatusCounts.totalSubmitted).toBe(11);
  });

  it('negative: missing statuses default to 0', () => {
    const result = computeEventAnalytics({
      questionStatusCounts: { approved: 5 },
    });
    expect(result.questionStatusCounts.featured).toBe(0);
    expect(result.questionStatusCounts.answered).toBe(0);
    expect(result.questionStatusCounts.hidden).toBe(0);
    expect(result.questionStatusCounts.totalSubmitted).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// totals (Req 8.3)
// ─────────────────────────────────────────────────────────────────────────────
describe('computeEventAnalytics — totals (Req 8.3)', () => {
  it('positive: returns correct totalVotes, pollResponses, wordCloudResponses', () => {
    const result = computeEventAnalytics({
      totalVotes: 100,
      pollResponses: 50,
      wordCloudResponses: 25,
    });
    expect(result.totalVotes).toBe(100);
    expect(result.pollResponses).toBe(50);
    expect(result.wordCloudResponses).toBe(25);
  });

  it('negative: coerces non-finite values to 0', () => {
    const result = computeEventAnalytics({
      totalVotes: NaN,
      pollResponses: Infinity,
      wordCloudResponses: -10,
    });
    expect(result.totalVotes).toBe(0);
    expect(result.pollResponses).toBe(0);
    expect(result.wordCloudResponses).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// engagementOverTime (Req 8.4, 8.8)
// ─────────────────────────────────────────────────────────────────────────────
describe('computeEventAnalytics — engagementOverTime (Req 8.4)', () => {
  const eventStart = '2026-01-01T00:00:00.000Z';
  const startMs = Date.parse(eventStart);

  it('positive: produces correct buckets for one interaction in first bucket', () => {
    const asOf = new Date(startMs + 10 * 60 * 1000).toISOString(); // +10 min → 2 buckets
    const result = computeEventAnalytics({
      eventStart,
      asOf,
      interactions: [
        { at: new Date(startMs + 2 * 60 * 1000).toISOString() }, // +2 min → bucket 0
      ],
    });
    expect(result.engagementOverTime).toHaveLength(2);
    expect(result.engagementOverTime[0].count).toBe(1);
    expect(result.engagementOverTime[1].count).toBe(0);
  });

  it('positive: empty series when asOf <= eventStart (Req 8.8)', () => {
    const result = computeEventAnalytics({
      eventStart,
      asOf: eventStart,
    });
    expect(result.engagementOverTime).toHaveLength(0);
  });

  it('negative: ignores interactions outside the event window', () => {
    const asOf = new Date(startMs + 5 * 60 * 1000).toISOString(); // exactly 1 bucket
    const beforeEvent = new Date(startMs - 1000).toISOString();
    const atAsOf = asOf; // at boundary — excluded
    const result = computeEventAnalytics({
      eventStart,
      asOf,
      interactions: [{ at: beforeEvent }, { at: atAsOf }],
    });
    expect(result.engagementOverTime[0].count).toBe(0);
  });

  it('negative: empty series when no eventStart provided', () => {
    const result = computeEventAnalytics({
      asOf: '2026-01-01T01:00:00.000Z',
      interactions: [{ at: '2026-01-01T00:30:00.000Z' }],
    });
    expect(result.engagementOverTime).toHaveLength(0);
  });

  it('positive: bucketStart is ISO string for the bucket start instant', () => {
    const asOf = new Date(startMs + 5 * 60 * 1000).toISOString();
    const result = computeEventAnalytics({ eventStart, asOf });
    expect(result.engagementOverTime[0].bucketStart).toBe(eventStart);
  });
});
