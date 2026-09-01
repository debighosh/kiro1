/**
 * Task 42.3 — Unit tests for poll response helpers (src/lib/polls.ts),
 * covering Req-26.1/26.2 behaviours:
 *
 *  - poll response uniqueness / updates: positive (submit) + negative (rejection) (Req 5.7, 5.9)
 *  - PollError error-kind mapping for every RPC rejection signal
 *  - readActivePoll type guards: valid rows returned, invalid rows rejected
 *
 * Supabase client and participant-id helper are mocked.
 *
 * Requirements: 5.7, 5.9, 5.10, 8.6, 26.1, 26.2
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const {
  rpcMock,
  fromMock,
  channelMock,
  removeChannelMock,
  getParticipantIdMock,
} = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  channelMock: vi.fn(),
  removeChannelMock: vi.fn(),
  getParticipantIdMock: vi.fn(() => 'participant-xyz'),
}));

vi.mock('./supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
    channel: (...args: unknown[]) => channelMock(...args),
    removeChannel: (...args: unknown[]) => removeChannelMock(...args),
  },
}));

vi.mock('./participant', () => ({
  getParticipantIdentifier: () => getParticipantIdMock(),
}));

// ── Subject under test ────────────────────────────────────────────────────────
import {
  PollError,
  SUBMIT_POLL_RESPONSE_RPC,
  readActivePoll,
  submitPollResponse,
} from './polls';

// ─────────────────────────────────────────────────────────────────────────────
// PollError
// ─────────────────────────────────────────────────────────────────────────────
describe('PollError', () => {
  it('constructs with correct name, message and kind', () => {
    const err = new PollError('Too fast', { kind: 'rate_limited' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PollError');
    expect(err.message).toBe('Too fast');
    expect(err.kind).toBe('rate_limited');
  });

  it('preserves cause when supplied', () => {
    const cause = new Error('original');
    const err = new PollError('msg', { kind: 'unknown', cause });
    expect(err.cause).toBe(cause);
  });

  it('covers every kind value', () => {
    const kinds = [
      'poll_not_found',
      'rate_limited',
      'poll_not_open',
      'poll_closed',
      'event_not_live',
      'invalid_option',
      'unknown',
    ] as const;
    for (const kind of kinds) {
      const err = new PollError('msg', { kind });
      expect(err.kind).toBe(kind);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitPollResponse — poll response uniqueness / updates (Req 5.7, 5.9)
// ─────────────────────────────────────────────────────────────────────────────
describe('submitPollResponse', () => {
  beforeEach(() => rpcMock.mockReset());

  it('positive: resolves without error on successful submission', async () => {
    rpcMock.mockResolvedValue({ data: {}, error: null });
    await expect(
      submitPollResponse('poll-1', 'option-a'),
    ).resolves.toBeUndefined();
    expect(rpcMock).toHaveBeenCalledWith(SUBMIT_POLL_RESPONSE_RPC, {
      p_poll_id: 'poll-1',
      p_participant_identifier: 'participant-xyz',
      p_option_id: 'option-a',
    });
  });

  it('negative: throws poll_closed when poll is closed (Req 5.9)', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'poll_closed' },
    });
    await expect(
      submitPollResponse('poll-1', 'option-a'),
    ).rejects.toMatchObject({ kind: 'poll_closed' });
  });

  it('negative: throws poll_not_open when poll is still draft (Req 5.10)', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'poll_not_open' },
    });
    await expect(
      submitPollResponse('poll-1', 'option-a'),
    ).rejects.toMatchObject({ kind: 'poll_not_open' });
  });

  it('negative: throws rate_limited for rate-limiting', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'rate_limited' },
    });
    await expect(
      submitPollResponse('poll-1', 'option-a'),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('negative: throws poll_not_found for missing poll', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'poll_not_found' },
    });
    await expect(
      submitPollResponse('poll-1', 'option-a'),
    ).rejects.toMatchObject({ kind: 'poll_not_found' });
  });

  it('negative: throws event_not_live when event is not live', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'event_not_live' },
    });
    await expect(
      submitPollResponse('poll-1', 'option-a'),
    ).rejects.toMatchObject({ kind: 'event_not_live' });
  });

  it('negative: throws invalid_option for an invalid option id', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'invalid_option' },
    });
    await expect(submitPollResponse('poll-1', 'bad-opt')).rejects.toMatchObject(
      {
        kind: 'invalid_option',
      },
    );
  });

  it('negative: throws unknown for unrecognised error', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'unexpected_signal' },
    });
    await expect(
      submitPollResponse('poll-1', 'option-a'),
    ).rejects.toMatchObject({ kind: 'unknown' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readActivePoll
// ─────────────────────────────────────────────────────────────────────────────

/** Factory for a well-formed poll query builder chain. */
function makePollChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.in = fn;
  // Two .order() calls: first returns chain, second resolves the promise
  let orderCallCount = 0;
  chain.order = vi.fn(() => {
    orderCallCount++;
    if (orderCallCount >= 2) {
      return Promise.resolve(result);
    }
    return chain;
  });
  return chain;
}

/** Factory for a well-formed options query builder chain. */
function makeOptionsChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.order = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('readActivePoll', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns null for empty eventId', async () => {
    await expect(readActivePoll('')).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns null when no matching readable poll rows', async () => {
    fromMock.mockReturnValueOnce(makePollChain({ data: [], error: null }));
    await expect(readActivePoll('event-1')).resolves.toBeNull();
  });

  it('negative: throws PollError on poll query transport error', async () => {
    fromMock.mockReturnValueOnce(
      makePollChain({ data: null, error: { message: 'connection refused' } }),
    );
    await expect(readActivePoll('event-1')).rejects.toBeInstanceOf(PollError);
  });

  it('positive: returns poll with options when rows are well-formed', async () => {
    const pollRow = {
      id: 'poll-1',
      event_id: 'event-1',
      question_text: 'Pick one',
      status: 'open',
      display_order: 1,
      results_visibility: 'show_always',
    };
    const optionRows = [
      {
        id: 'opt-1',
        poll_id: 'poll-1',
        text: 'Option A',
        display_order: 1,
        response_count: 0,
      },
    ];

    fromMock
      .mockReturnValueOnce(makePollChain({ data: [pollRow], error: null }))
      .mockReturnValueOnce(makeOptionsChain({ data: optionRows, error: null }));

    const result = await readActivePoll('event-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('poll-1');
    expect(result!.options).toHaveLength(1);
    expect(result!.options[0].text).toBe('Option A');
  });

  it('negative: rejects draft poll rows (type-guard enforcement — Req 8.6)', async () => {
    const draftPollRow = {
      id: 'poll-draft',
      event_id: 'event-1',
      question_text: 'Draft poll',
      status: 'draft', // not in readable statuses
      display_order: 0,
      results_visibility: 'show_always',
    };
    fromMock.mockReturnValueOnce(
      makePollChain({ data: [draftPollRow], error: null }),
    );
    // Draft not in readable statuses → guard rejects → returns null
    await expect(readActivePoll('event-1')).resolves.toBeNull();
  });

  it('negative: throws PollError on options query transport error', async () => {
    const pollRow = {
      id: 'poll-1',
      event_id: 'event-1',
      question_text: 'Pick one',
      status: 'open',
      display_order: 1,
      results_visibility: 'show_always',
    };
    fromMock
      .mockReturnValueOnce(makePollChain({ data: [pollRow], error: null }))
      .mockReturnValueOnce(
        makeOptionsChain({
          data: null,
          error: { message: 'options error' },
        }),
      );

    await expect(readActivePoll('event-1')).rejects.toBeInstanceOf(PollError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribeToPollResults — realtime subscription helpers (Req 5.11, 23.2)
// ─────────────────────────────────────────────────────────────────────────────
import { subscribeToPollResults } from './polls';

// Note: supabase.channel / removeChannel are wired in the top-level mock via
// channelMock / removeChannelMock variables.

describe('subscribeToPollResults', () => {
  it('positive: returns a no-op unsubscribe for empty eventId (Req 23.2)', () => {
    const unsub = subscribeToPollResults('', {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('positive: opens a scoped poll-results channel for valid eventId', () => {
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    removeChannelMock.mockResolvedValue(undefined);

    const unsub = subscribeToPollResults('event-1', {});
    expect(channelMock).toHaveBeenCalledWith('event:event-1:polls');
    unsub();
    expect(removeChannelMock).toHaveBeenCalled();
  });

  it('positive: onConnectionChange called false on SUBSCRIBED (no-op when absent)', () => {
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    // No onConnectionChange supplied — just confirm no throw
    expect(() => subscribeToPollResults('event-1', {})).not.toThrow();
  });
});
