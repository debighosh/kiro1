/**
 * Task 42.3 — Coverage-gap tests for src/lib/questions.ts (Req 26.1, 26.2, 26.3).
 *
 * Targets the branches NOT hit by questions.test.ts:
 *   - readAudienceQuestions: positive (returns questions) + negative (throws/empty) — Req 3.9, 4.1
 *   - subscribeToEventQuestions broadcast onVoteCount handler — Req 4.7
 *   - TIMED_OUT / CLOSED connection-change states — Req 23.5
 *
 * Requirements: 3.9, 4.1, 4.7, 23.5, 26.1, 26.2
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const { rpcMock, fromMock, channelMock, removeChannelMock } = vi.hoisted(
  () => ({
    rpcMock: vi.fn(),
    fromMock: vi.fn(),
    channelMock: vi.fn(),
    removeChannelMock: vi.fn(),
  }),
);

vi.mock('./supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
    channel: (...args: unknown[]) => channelMock(...args),
    removeChannel: (...args: unknown[]) => removeChannelMock(...args),
  },
}));

vi.mock('./participant', () => ({
  getParticipantIdentifier: () => 'participant-xyz',
}));

import {
  readAudienceQuestions,
  subscribeToEventQuestions,
  QuestionError,
} from './questions';

// ─────────────────────────────────────────────────────────────────────────────
// Query chain builder for readAudienceQuestions (ends in a promise via await)
// ─────────────────────────────────────────────────────────────────────────────
function makeAudienceChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.in = fn;
  // Most-votes sort calls order twice then resolves; most-recent calls order once.
  let orderCount = 0;
  chain.order = vi.fn(() => {
    orderCount++;
    // We resolve on 2nd order() call (most_votes sort) or return a promise
    // wrapper for the single-order most_recent case.
    return orderCount >= 2 ? Promise.resolve(result) : chain;
  });
  // Expose a direct resolution for callers that resolve after the first order().
  chain._resolveNow = () => Promise.resolve(result);
  return chain;
}

function makeAudienceSingleOrderChain(result: {
  data: unknown;
  error: unknown;
}) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.in = fn;
  chain.order = vi.fn(() => Promise.resolve(result));
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// readAudienceQuestions — positive + negative (Req 3.9, 4.1, 26.1, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('readAudienceQuestions — positive cases (Req 3.9, 4.1)', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns [] for empty eventId (Req 23.2)', async () => {
    const result = await readAudienceQuestions('');
    expect(result).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns approved/featured questions sorted by most_votes (default)', async () => {
    const rows = [
      {
        id: 'q-1',
        text: 'Top question?',
        status: 'approved',
        vote_count: 10,
        created_at: '2024-01-01',
      },
      {
        id: 'q-2',
        text: 'Second?',
        status: 'featured',
        vote_count: 5,
        created_at: '2024-01-02',
      },
    ];
    fromMock.mockReturnValue(makeAudienceChain({ data: rows, error: null }));
    const result = await readAudienceQuestions('event-1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('q-1');
    expect(result[1].id).toBe('q-2');
  });

  it('positive: returns questions sorted by most_recent when specified', async () => {
    const rows = [
      {
        id: 'q-new',
        text: 'Newest?',
        status: 'approved',
        vote_count: 1,
        created_at: '2024-02-01',
      },
    ];
    fromMock.mockReturnValue(
      makeAudienceSingleOrderChain({ data: rows, error: null }),
    );
    const result = await readAudienceQuestions('event-1', 'most_recent');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('q-new');
  });

  it('positive: returns [] when data is null (not an array)', async () => {
    fromMock.mockReturnValue(makeAudienceChain({ data: null, error: null }));
    const result = await readAudienceQuestions('event-1');
    expect(result).toEqual([]);
  });

  it('negative: excludes rows with pending status (type-guard, Req 3.9)', async () => {
    const rows = [
      {
        id: 'q-1',
        text: 'Valid',
        status: 'approved',
        vote_count: 3,
        created_at: '2024-01-01',
      },
      {
        id: 'q-2',
        text: 'Hidden',
        status: 'pending',
        vote_count: 0,
        created_at: '2024-01-01',
      },
    ];
    fromMock.mockReturnValue(makeAudienceChain({ data: rows, error: null }));
    const result = await readAudienceQuestions('event-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('q-1');
  });
});

describe('readAudienceQuestions — negative cases (Req 3.9, 4.1)', () => {
  beforeEach(() => fromMock.mockReset());

  it('negative: throws QuestionError on transport error (Req 4.1)', async () => {
    fromMock.mockReturnValue(
      makeAudienceChain({ data: null, error: { message: 'network error' } }),
    );
    await expect(readAudienceQuestions('event-1')).rejects.toBeInstanceOf(
      QuestionError,
    );
  });

  it('negative: error has kind "unknown" for unrecognised transport failure', async () => {
    fromMock.mockReturnValue(
      makeAudienceChain({ data: null, error: { message: 'network error' } }),
    );
    await expect(readAudienceQuestions('event-1')).rejects.toMatchObject({
      kind: 'unknown',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribeToEventQuestions — broadcast onVoteCount + TIMED_OUT/CLOSED states
// ─────────────────────────────────────────────────────────────────────────────
describe('subscribeToEventQuestions — broadcast + connection-state coverage (Req 4.7, 23.5)', () => {
  beforeEach(() => {
    channelMock.mockReset();
    removeChannelMock.mockReset();
  });

  it('positive: onVoteCount is called with a valid broadcast payload (Req 4.7)', () => {
    let broadcastHandler: ((msg: { payload?: unknown }) => void) | null = null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            broadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);

    const onVoteCount = vi.fn();
    subscribeToEventQuestions('event-1', { onVoteCount });

    // Simulate a well-formed broadcast
    broadcastHandler!({
      payload: { event_id: 'event-1', question_id: 'q-1', vote_count: 42 },
    });
    expect(onVoteCount).toHaveBeenCalledWith({
      event_id: 'event-1',
      question_id: 'q-1',
      vote_count: 42,
    });
  });

  it('negative: onVoteCount NOT called for a payload from a different event_id (Req 4.7)', () => {
    let broadcastHandler: ((msg: { payload?: unknown }) => void) | null = null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            broadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);

    const onVoteCount = vi.fn();
    subscribeToEventQuestions('event-1', { onVoteCount });

    // Payload from a DIFFERENT event — must be ignored (scope invariant, Req 23.2)
    broadcastHandler!({
      payload: {
        event_id: 'event-DIFFERENT',
        question_id: 'q-1',
        vote_count: 7,
      },
    });
    expect(onVoteCount).not.toHaveBeenCalled();
  });

  it('negative: onVoteCount NOT called for a malformed broadcast payload', () => {
    let broadcastHandler: ((msg: { payload?: unknown }) => void) | null = null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            broadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);

    const onVoteCount = vi.fn();
    subscribeToEventQuestions('event-1', { onVoteCount });

    // Malformed: missing question_id
    broadcastHandler!({
      payload: { event_id: 'event-1', vote_count: 'not-a-number' },
    });
    expect(onVoteCount).not.toHaveBeenCalled();
  });

  it('negative: onConnectionChange called true on TIMED_OUT state (Req 23.5)', () => {
    let subscribeCallback: ((state: string) => void) | null = null;
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: (state: string) => void) => {
        subscribeCallback = cb;
        return channelInstance;
      }),
    };
    channelMock.mockReturnValue(channelInstance);

    const onConnectionChange = vi.fn();
    subscribeToEventQuestions('event-1', { onConnectionChange });

    subscribeCallback!('TIMED_OUT');
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('negative: onConnectionChange called true on CLOSED state (Req 23.5)', () => {
    let subscribeCallback: ((state: string) => void) | null = null;
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: (state: string) => void) => {
        subscribeCallback = cb;
        return channelInstance;
      }),
    };
    channelMock.mockReturnValue(channelInstance);

    const onConnectionChange = vi.fn();
    subscribeToEventQuestions('event-1', { onConnectionChange });

    subscribeCallback!('CLOSED');
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });
});
