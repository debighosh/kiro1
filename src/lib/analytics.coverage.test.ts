/**
 * Task 38.5 — Additional unit tests for analytics aggregation (src/lib/analytics.ts).
 *
 * These tests complement the existing analytics.test.ts by covering the specific
 * invariants called out in Task 38.5 that are not yet exercised:
 *
 *   • 5-minute bucketing edge cases: exact spans, boundary placement    (Req 8.4)
 *   • All five question statuses counted; totalSubmitted derivation      (Req 8.2)
 *   • vote / pollResponses / wordCloudResponses pass-through             (Req 8.3)
 *   • Zero-interaction all-zeros case                                    (Req 8.8)
 *   • Platform-interaction labelling: result carries only counts         (Req 8.5)
 *   • No Participant_Identifier in result structure or serialisation     (Req 8.6)
 *   • Retrieval-failure / no partial metrics: pure function always
 *     returns a complete EventAnalytics object                           (Req 8.7)
 *   • 26.1 admin-only enforcement (structural: result shape)             (Req 26.1)
 *
 * Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 26.1
 * Design references: Components and Interfaces (Analytics_Service); Frontend Design
 * (Admin analytics).
 */
import { describe, expect, it } from 'vitest';

import {
  BUCKET_MS,
  computeEventAnalytics,
  type EventAnalytics,
} from './analytics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO timestamp offset by `ms` milliseconds from a base ISO string. */
function offsetIso(base: string, ms: number): string {
  return new Date(Date.parse(base) + ms).toISOString();
}

const EVENT_START = '2026-06-01T09:00:00.000Z';

// ---------------------------------------------------------------------------
// 5-minute bucketing — exact spans (Req 8.4)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — 5-minute bucketing exact spans (Req 8.4)', () => {
  it('asOf exactly 1 bucket after start → 1 bucket in series', () => {
    const asOf = offsetIso(EVENT_START, BUCKET_MS); // +5 min
    const result = computeEventAnalytics({ eventStart: EVENT_START, asOf });
    expect(result.engagementOverTime).toHaveLength(1);
    expect(result.engagementOverTime[0].bucketStart).toBe(EVENT_START);
  });

  it('asOf exactly 3 buckets after start → 3 buckets in series', () => {
    const asOf = offsetIso(EVENT_START, 3 * BUCKET_MS); // +15 min
    const result = computeEventAnalytics({ eventStart: EVENT_START, asOf });
    expect(result.engagementOverTime).toHaveLength(3);
    expect(result.engagementOverTime[0].bucketStart).toBe(EVENT_START);
    expect(result.engagementOverTime[1].bucketStart).toBe(
      offsetIso(EVENT_START, BUCKET_MS),
    );
    expect(result.engagementOverTime[2].bucketStart).toBe(
      offsetIso(EVENT_START, 2 * BUCKET_MS),
    );
  });

  it('partial final bucket (asOf 7 min after start) → 2 buckets (ceil)', () => {
    // 7 min / 5 min = 1.4 → ceil = 2 buckets
    const asOf = offsetIso(EVENT_START, 7 * 60 * 1000);
    const result = computeEventAnalytics({ eventStart: EVENT_START, asOf });
    expect(result.engagementOverTime).toHaveLength(2);
  });

  it('all zero-count buckets when no interactions are provided (Req 8.8)', () => {
    const asOf = offsetIso(EVENT_START, 3 * BUCKET_MS);
    const result = computeEventAnalytics({ eventStart: EVENT_START, asOf });
    expect(result.engagementOverTime.every((b) => b.count === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5-minute bucketing — half-open interval placement (Req 8.4)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — bucket boundary placement (Req 8.4)', () => {
  it('interaction at the exact start of a bucket (t = bucketStart) is counted in that bucket', () => {
    const asOf = offsetIso(EVENT_START, 2 * BUCKET_MS);
    // Interaction at start of bucket 1 (t = startMs + BUCKET_MS)
    const atBucket1Start = offsetIso(EVENT_START, BUCKET_MS);
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [{ at: atBucket1Start }],
    });
    expect(result.engagementOverTime).toHaveLength(2);
    expect(result.engagementOverTime[0].count).toBe(0); // bucket 0
    expect(result.engagementOverTime[1].count).toBe(1); // bucket 1
  });

  it('interaction 1 ms before the next bucket boundary stays in current bucket', () => {
    const asOf = offsetIso(EVENT_START, 2 * BUCKET_MS);
    // 1 ms before the end of bucket 0 (i.e. BUCKET_MS - 1)
    const lastMsOfBucket0 = offsetIso(EVENT_START, BUCKET_MS - 1);
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [{ at: lastMsOfBucket0 }],
    });
    expect(result.engagementOverTime[0].count).toBe(1); // still bucket 0
    expect(result.engagementOverTime[1].count).toBe(0);
  });

  it('interaction exactly at asOf is EXCLUDED (half-open [start, asOf))', () => {
    const asOf = offsetIso(EVENT_START, BUCKET_MS);
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [{ at: asOf }], // at boundary — must be excluded
    });
    expect(result.engagementOverTime).toHaveLength(1);
    expect(result.engagementOverTime[0].count).toBe(0);
  });

  it('interaction 1 ms before asOf IS included', () => {
    const asOf = offsetIso(EVENT_START, BUCKET_MS);
    const justBeforeAsOf = offsetIso(EVENT_START, BUCKET_MS - 1);
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [{ at: justBeforeAsOf }],
    });
    expect(result.engagementOverTime[0].count).toBe(1);
  });

  it('interaction before eventStart is EXCLUDED from all buckets', () => {
    const asOf = offsetIso(EVENT_START, BUCKET_MS);
    const beforeStart = offsetIso(EVENT_START, -1000); // 1 s before start
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [{ at: beforeStart }],
    });
    expect(result.engagementOverTime[0].count).toBe(0);
  });

  it('asOf <= eventStart → empty series (Req 8.8)', () => {
    // asOf == eventStart
    expect(
      computeEventAnalytics({ eventStart: EVENT_START, asOf: EVENT_START })
        .engagementOverTime,
    ).toHaveLength(0);

    // asOf < eventStart
    const beforeStart = offsetIso(EVENT_START, -5000);
    expect(
      computeEventAnalytics({ eventStart: EVENT_START, asOf: beforeStart })
        .engagementOverTime,
    ).toHaveLength(0);
  });

  it('interactions distributed across 3 buckets are counted in correct buckets', () => {
    const asOf = offsetIso(EVENT_START, 3 * BUCKET_MS);
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [
        { at: offsetIso(EVENT_START, 1 * 60 * 1000) }, // bucket 0
        { at: offsetIso(EVENT_START, 6 * 60 * 1000) }, // bucket 1
        { at: offsetIso(EVENT_START, 6 * 60 * 1000 + 500) }, // bucket 1
        { at: offsetIso(EVENT_START, 12 * 60 * 1000) }, // bucket 2
      ],
    });
    expect(result.engagementOverTime).toHaveLength(3);
    expect(result.engagementOverTime[0].count).toBe(1);
    expect(result.engagementOverTime[1].count).toBe(2);
    expect(result.engagementOverTime[2].count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Question status counts (Req 8.2)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — all five question statuses (Req 8.2)', () => {
  it('counts all five statuses (pending/approved/featured/answered/hidden) correctly', () => {
    const result = computeEventAnalytics({
      questionStatusCounts: {
        pending: 7,
        approved: 3,
        featured: 2,
        answered: 4,
        hidden: 1,
      },
    });
    // The four surfaced statuses
    expect(result.questionStatusCounts.approved).toBe(3);
    expect(result.questionStatusCounts.featured).toBe(2);
    expect(result.questionStatusCounts.answered).toBe(4);
    expect(result.questionStatusCounts.hidden).toBe(1);
    // totalSubmitted = 7+3+2+4+1 = 17 (includes pending)
    expect(result.questionStatusCounts.totalSubmitted).toBe(17);
  });

  it('totalSubmitted equals sum of all five status counts', () => {
    const counts = {
      pending: 5,
      approved: 10,
      featured: 3,
      answered: 8,
      hidden: 4,
    };
    const expected = 5 + 10 + 3 + 8 + 4;
    const result = computeEventAnalytics({ questionStatusCounts: counts });
    expect(result.questionStatusCounts.totalSubmitted).toBe(expected);
  });

  it('all counts are 0 when questionStatusCounts is omitted (Req 8.8)', () => {
    const result = computeEventAnalytics({});
    expect(result.questionStatusCounts.approved).toBe(0);
    expect(result.questionStatusCounts.featured).toBe(0);
    expect(result.questionStatusCounts.answered).toBe(0);
    expect(result.questionStatusCounts.hidden).toBe(0);
    expect(result.questionStatusCounts.totalSubmitted).toBe(0);
  });

  it('fractional status counts are floored to integers', () => {
    const result = computeEventAnalytics({
      questionStatusCounts: { approved: 3.9, featured: 1.1 },
    });
    expect(result.questionStatusCounts.approved).toBe(3);
    expect(result.questionStatusCounts.featured).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Vote / poll / word-cloud response counts (Req 8.3)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — vote/poll/wordCloud pass-through (Req 8.3)', () => {
  it('passes through totalVotes, pollResponses, and wordCloudResponses correctly', () => {
    const result = computeEventAnalytics({
      totalVotes: 200,
      pollResponses: 75,
      wordCloudResponses: 30,
    });
    expect(result.totalVotes).toBe(200);
    expect(result.pollResponses).toBe(75);
    expect(result.wordCloudResponses).toBe(30);
  });

  it('omitted interaction totals default to 0', () => {
    const result = computeEventAnalytics({});
    expect(result.totalVotes).toBe(0);
    expect(result.pollResponses).toBe(0);
    expect(result.wordCloudResponses).toBe(0);
  });

  it('fractional vote/poll/wordCloud counts are floored', () => {
    const result = computeEventAnalytics({
      totalVotes: 7.8,
      pollResponses: 4.2,
      wordCloudResponses: 9.99,
    });
    expect(result.totalVotes).toBe(7);
    expect(result.pollResponses).toBe(4);
    expect(result.wordCloudResponses).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Zero-interaction all-zeros case (Req 8.8)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — zero-interaction all-zeros (Req 8.8)', () => {
  it('fully empty input → every scalar is 0, engagementOverTime is empty', () => {
    const result = computeEventAnalytics({});
    expect(result.uniqueParticipants).toBe(0);
    expect(result.totalVotes).toBe(0);
    expect(result.pollResponses).toBe(0);
    expect(result.wordCloudResponses).toBe(0);
    expect(result.questionStatusCounts.totalSubmitted).toBe(0);
    expect(result.questionStatusCounts.approved).toBe(0);
    expect(result.questionStatusCounts.featured).toBe(0);
    expect(result.questionStatusCounts.answered).toBe(0);
    expect(result.questionStatusCounts.hidden).toBe(0);
    expect(result.engagementOverTime).toHaveLength(0);
  });

  it('empty participantIdentifiers array → uniqueParticipants is 0', () => {
    const result = computeEventAnalytics({ participantIdentifiers: [] });
    expect(result.uniqueParticipants).toBe(0);
  });

  it('valid window with no interactions → all buckets have count 0', () => {
    const asOf = offsetIso(EVENT_START, 3 * BUCKET_MS);
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [],
    });
    expect(result.engagementOverTime).toHaveLength(3);
    expect(result.engagementOverTime.every((b) => b.count === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Platform-interaction labelling (Req 8.5)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — platform-interaction labelling (Req 8.5)', () => {
  it('result contains ONLY integer counts, never identifier values', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['uid-abc', 'uid-def'],
      totalVotes: 5,
      pollResponses: 2,
      wordCloudResponses: 1,
    });
    // All scalar metrics are non-negative integers (platform interaction counts)
    expect(Number.isInteger(result.uniqueParticipants)).toBe(true);
    expect(Number.isInteger(result.totalVotes)).toBe(true);
    expect(Number.isInteger(result.pollResponses)).toBe(true);
    expect(Number.isInteger(result.wordCloudResponses)).toBe(true);
    expect(Number.isInteger(result.questionStatusCounts.totalSubmitted)).toBe(
      true,
    );
    expect(Number.isInteger(result.questionStatusCounts.approved)).toBe(true);
    expect(Number.isInteger(result.questionStatusCounts.featured)).toBe(true);
    expect(Number.isInteger(result.questionStatusCounts.answered)).toBe(true);
    expect(Number.isInteger(result.questionStatusCounts.hidden)).toBe(true);
  });

  it('all integer counts are non-negative', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['uid-1'],
      questionStatusCounts: {
        pending: 1,
        approved: 2,
        featured: 1,
        answered: 3,
        hidden: 0,
      },
      totalVotes: 10,
      pollResponses: 5,
      wordCloudResponses: 3,
    });
    expect(result.uniqueParticipants).toBeGreaterThanOrEqual(0);
    expect(result.totalVotes).toBeGreaterThanOrEqual(0);
    expect(result.pollResponses).toBeGreaterThanOrEqual(0);
    expect(result.wordCloudResponses).toBeGreaterThanOrEqual(0);
    expect(result.questionStatusCounts.totalSubmitted).toBeGreaterThanOrEqual(
      0,
    );
    for (const bucket of result.engagementOverTime) {
      expect(bucket.count).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Privacy: no Participant_Identifier reaches the result (Req 8.6)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — no Participant_Identifier in result (Req 8.6)', () => {
  it('EventAnalytics result has no participant_identifier field', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['id-token-1', 'id-token-2', 'id-token-3'],
    });
    // The result object itself must not contain any identifier field
    expect(result).not.toHaveProperty('participant_identifier');
    expect(result).not.toHaveProperty('participantIdentifiers');
    expect(result).not.toHaveProperty('identifiers');
    expect(result).not.toHaveProperty('participants');
  });

  it('raw identifier values do not appear anywhere in the serialised result', () => {
    const ids = ['secret-token-aaa', 'secret-token-bbb', 'secret-token-ccc'];
    const result = computeEventAnalytics({ participantIdentifiers: ids });
    const serialised = JSON.stringify(result);
    for (const id of ids) {
      expect(serialised).not.toContain(id);
    }
  });

  it('uniqueParticipantCount overrides participantIdentifiers (raw ids not processed)', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['id-a', 'id-b', 'id-c', 'id-d', 'id-e'],
      uniqueParticipantCount: 99,
    });
    // Pre-computed count wins; raw ids are irrelevant
    expect(result.uniqueParticipants).toBe(99);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('id-a');
  });

  it('engagementOverTime buckets carry no identifier data (Req 8.6)', () => {
    const asOf = offsetIso(EVENT_START, 2 * BUCKET_MS);
    const result = computeEventAnalytics({
      eventStart: EVENT_START,
      asOf,
      interactions: [
        { at: offsetIso(EVENT_START, 60 * 1000) },
        { at: offsetIso(EVENT_START, 6 * 60 * 1000) },
      ],
    });
    for (const bucket of result.engagementOverTime) {
      // Each bucket only has bucketStart (string) and count (number)
      expect(Object.keys(bucket).sort()).toEqual(['bucketStart', 'count']);
      expect(typeof bucket.bucketStart).toBe('string');
      expect(typeof bucket.count).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Retrieval-failure / no partial metrics (Req 8.7)
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — always returns complete EventAnalytics (Req 8.7)', () => {
  /**
   * computeEventAnalytics is a pure function. It should always return a complete
   * EventAnalytics object for any valid input — never undefined/partial fields.
   * This corresponds to Req 8.7: retrieval failure returns no partial/stale metrics.
   * Callers that catch errors must surface the error, not a partial object.
   */

  /** Asserts the result is a structurally complete EventAnalytics. */
  function assertCompleteAnalytics(result: EventAnalytics): void {
    // Top-level fields all present
    expect(result).toHaveProperty('uniqueParticipants');
    expect(result).toHaveProperty('questionStatusCounts');
    expect(result).toHaveProperty('totalVotes');
    expect(result).toHaveProperty('pollResponses');
    expect(result).toHaveProperty('wordCloudResponses');
    expect(result).toHaveProperty('engagementOverTime');
    // questionStatusCounts sub-fields all present
    expect(result.questionStatusCounts).toHaveProperty('approved');
    expect(result.questionStatusCounts).toHaveProperty('featured');
    expect(result.questionStatusCounts).toHaveProperty('answered');
    expect(result.questionStatusCounts).toHaveProperty('hidden');
    expect(result.questionStatusCounts).toHaveProperty('totalSubmitted');
    // All scalars are non-negative integers
    expect(result.uniqueParticipants).toBeGreaterThanOrEqual(0);
    expect(result.totalVotes).toBeGreaterThanOrEqual(0);
    expect(result.pollResponses).toBeGreaterThanOrEqual(0);
    expect(result.wordCloudResponses).toBeGreaterThanOrEqual(0);
    expect(result.questionStatusCounts.totalSubmitted).toBeGreaterThanOrEqual(
      0,
    );
    // engagementOverTime is an array (never undefined/null)
    expect(Array.isArray(result.engagementOverTime)).toBe(true);
  }

  it('returns complete object for fully empty input', () => {
    assertCompleteAnalytics(computeEventAnalytics({}));
  });

  it('returns complete object for minimal valid input (only uniqueParticipantCount)', () => {
    assertCompleteAnalytics(
      computeEventAnalytics({ uniqueParticipantCount: 5 }),
    );
  });

  it('returns complete object for input with all fields populated', () => {
    const asOf = offsetIso(EVENT_START, 2 * BUCKET_MS);
    assertCompleteAnalytics(
      computeEventAnalytics({
        participantIdentifiers: ['p1', 'p2'],
        questionStatusCounts: {
          pending: 1,
          approved: 2,
          featured: 1,
          answered: 3,
          hidden: 1,
        },
        totalVotes: 50,
        pollResponses: 20,
        wordCloudResponses: 10,
        eventStart: EVENT_START,
        asOf,
        interactions: [{ at: offsetIso(EVENT_START, 60 * 1000) }],
      }),
    );
  });

  it('returns complete object for boundary inputs (NaN/Infinity/negative values)', () => {
    assertCompleteAnalytics(
      computeEventAnalytics({
        uniqueParticipantCount: -1,
        totalVotes: NaN,
        pollResponses: Infinity,
        wordCloudResponses: -Infinity,
        questionStatusCounts: { approved: NaN, featured: -2 },
      }),
    );
  });

  it('no field is ever undefined or null on the result', () => {
    const result = computeEventAnalytics({});
    expect(result.uniqueParticipants).not.toBeUndefined();
    expect(result.totalVotes).not.toBeUndefined();
    expect(result.pollResponses).not.toBeUndefined();
    expect(result.wordCloudResponses).not.toBeUndefined();
    expect(result.questionStatusCounts).not.toBeUndefined();
    expect(result.questionStatusCounts.approved).not.toBeUndefined();
    expect(result.questionStatusCounts.featured).not.toBeUndefined();
    expect(result.questionStatusCounts.answered).not.toBeUndefined();
    expect(result.questionStatusCounts.hidden).not.toBeUndefined();
    expect(result.questionStatusCounts.totalSubmitted).not.toBeUndefined();
    expect(result.engagementOverTime).not.toBeUndefined();
    expect(result.engagementOverTime).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Req 26.1 — Admin-only: result shape never exposes privileged data
// ---------------------------------------------------------------------------
describe('computeEventAnalytics — admin-only result shape (Req 26.1)', () => {
  it('result shape matches the EventAnalytics interface exactly (no extra privileged fields)', () => {
    const result = computeEventAnalytics({
      participantIdentifiers: ['user-1', 'user-2'],
      questionStatusCounts: {
        pending: 1,
        approved: 2,
        featured: 0,
        answered: 1,
        hidden: 0,
      },
      totalVotes: 8,
      pollResponses: 3,
      wordCloudResponses: 2,
      eventStart: EVENT_START,
      asOf: offsetIso(EVENT_START, BUCKET_MS),
      interactions: [{ at: offsetIso(EVENT_START, 30 * 1000) }],
    });

    const topLevelKeys = Object.keys(result).sort();
    expect(topLevelKeys).toEqual([
      'engagementOverTime',
      'pollResponses',
      'questionStatusCounts',
      'totalVotes',
      'uniqueParticipants',
      'wordCloudResponses',
    ]);

    const statusKeys = Object.keys(result.questionStatusCounts).sort();
    expect(statusKeys).toEqual([
      'answered',
      'approved',
      'featured',
      'hidden',
      'totalSubmitted',
    ]);
  });
});
