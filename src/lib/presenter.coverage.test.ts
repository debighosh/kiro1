/**
 * Task 42.3 — Coverage-gap tests for src/lib/presenter.ts (Req 26.1, 26.2, 26.3).
 *
 * Targets the branches NOT hit by presenter.test.ts:
 *   - readPresenterActivePoll: options unreadable → poll with empty options (line 660)
 *   - readPresenterWordCloud: responses unreadable → prompt with empty responses (line 796)
 *
 * Requirements: 7.4, 7.7, 7.8, 26.1, 26.2
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const { fromMock, channelMock, removeChannelMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  channelMock: vi.fn(),
  removeChannelMock: vi.fn(),
}));

vi.mock('./supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    channel: (...args: unknown[]) => channelMock(...args),
    removeChannel: (...args: unknown[]) => removeChannelMock(...args),
  },
}));

import { readPresenterActivePoll, readPresenterWordCloud } from './presenter';

// ─────────────────────────────────────────────────────────────────────────────
// Chain builders
// ─────────────────────────────────────────────────────────────────────────────

/** Poll row chain: resolves after 2nd order() call. */
function makePollChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.in = fn;
  let orderCount = 0;
  chain.order = vi.fn(() => {
    orderCount++;
    return orderCount >= 2 ? Promise.resolve(result) : chain;
  });
  return chain;
}

/** Options chain: resolves after order(). */
function makeOptionsChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.order = vi.fn(() => Promise.resolve(result));
  return chain;
}

/** WC response chain: resolves after 2nd eq() call. */
function makeWcResponseChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  let eqCount = 0;
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => {
    eqCount++;
    return eqCount >= 2 ? Promise.resolve(result) : chain;
  });
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// readPresenterActivePoll — options unreadable fallback (Req 7.7, 5.11)
// ─────────────────────────────────────────────────────────────────────────────
describe('readPresenterActivePoll — options-unreadable branch (Req 7.7)', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns poll with empty options when options query errors (Req 7.7)', async () => {
    // Poll row is valid
    const pollRow = {
      id: 'poll-1',
      question_text: 'Best choice?',
      status: 'open',
      results_visibility: 'show_always',
    };
    // First call: polls → success; second call: poll_options → error
    fromMock
      .mockReturnValueOnce(makePollChain({ data: [pollRow], error: null }))
      .mockReturnValueOnce(
        makeOptionsChain({
          data: null,
          error: { message: 'options unavailable' },
        }),
      );

    const result = await readPresenterActivePoll('event-1');

    // Must return the poll (not null) even though options are unreadable — graceful degradation
    expect(result).not.toBeNull();
    expect(result!.id).toBe('poll-1');
    expect(result!.question_text).toBe('Best choice?');
    expect(result!.options).toEqual([]);
  });

  it('positive: returns poll with empty options when optionRows is not an array', async () => {
    const pollRow = {
      id: 'poll-2',
      question_text: 'Another?',
      status: 'closed',
      results_visibility: 'hide_until_closed',
    };
    fromMock
      .mockReturnValueOnce(makePollChain({ data: [pollRow], error: null }))
      .mockReturnValueOnce(makeOptionsChain({ data: null, error: null }));

    const result = await readPresenterActivePoll('event-1');

    expect(result).not.toBeNull();
    expect(result!.options).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readPresenterWordCloud — responses unreadable fallback (Req 7.7, 6.13)
// ─────────────────────────────────────────────────────────────────────────────
describe('readPresenterWordCloud — responses-unreadable branch (Req 7.7, 6.13)', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns prompt with empty responses when response query errors (Req 7.7)', async () => {
    const promptRow = {
      id: 'prompt-1',
      prompt_text: 'One word?',
      status: 'open',
      results_visible_while_collecting: true,
    };
    // First call: prompts → success; second call: responses → error
    fromMock
      .mockReturnValueOnce(makePollChain({ data: [promptRow], error: null }))
      .mockReturnValueOnce(
        makeWcResponseChain({
          data: null,
          error: { message: 'responses fail' },
        }),
      );

    const result = await readPresenterWordCloud('event-1');

    // Prompt should be returned even when responses are unreadable
    expect(result.prompt).not.toBeNull();
    expect(result.prompt!.id).toBe('prompt-1');
    expect(result.responses).toEqual([]);
  });

  it('positive: returns prompt with empty responses when responseRows is not an array', async () => {
    const promptRow = {
      id: 'prompt-2',
      prompt_text: 'Describe in a word',
      status: 'closed',
      results_visible_while_collecting: false,
    };
    fromMock
      .mockReturnValueOnce(makePollChain({ data: [promptRow], error: null }))
      .mockReturnValueOnce(makeWcResponseChain({ data: null, error: null }));

    const result = await readPresenterWordCloud('event-1');

    expect(result.prompt).not.toBeNull();
    expect(result.responses).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribeToPresenter — broadcast payload handler coverage (Req 5.12, 6.15)
// ─────────────────────────────────────────────────────────────────────────────
import { subscribeToPresenter } from './presenter';

describe('subscribeToPresenter — poll-results broadcast payload handler (Req 5.12)', () => {
  beforeEach(() => {
    channelMock.mockReset();
    removeChannelMock.mockReset();
  });

  it('positive: onPollResults is called with a valid poll-results broadcast payload', () => {
    let pollBroadcastHandler: ((msg: { payload?: unknown }) => void) | null =
      null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            pollBroadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    removeChannelMock.mockResolvedValue(undefined);

    const onPollResults = vi.fn();
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onPollResults,
    });

    // Fire the broadcast handler with a valid payload
    const validPayload = {
      event_id: 'event-1',
      poll_id: 'poll-1',
      options: [{ option_id: 'opt-1', response_count: 7 }],
    };
    pollBroadcastHandler!({ payload: validPayload });
    expect(onPollResults).toHaveBeenCalledWith(validPayload);
  });

  it('negative: onPollResults NOT called for payload from a different event_id (Req 23.2)', () => {
    let pollBroadcastHandler: ((msg: { payload?: unknown }) => void) | null =
      null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            pollBroadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);

    const onPollResults = vi.fn();
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onPollResults,
    });

    // Payload from a different event — must be ignored
    pollBroadcastHandler!({
      payload: { event_id: 'event-OTHER', poll_id: 'poll-2', options: [] },
    });
    expect(onPollResults).not.toHaveBeenCalled();
  });

  it('negative: onPollResults NOT called for malformed payload', () => {
    let pollBroadcastHandler: ((msg: { payload?: unknown }) => void) | null =
      null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            pollBroadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);

    const onPollResults = vi.fn();
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onPollResults,
    });

    // Malformed: missing poll_id
    pollBroadcastHandler!({ payload: { event_id: 'event-1', options: [] } });
    expect(onPollResults).not.toHaveBeenCalled();
  });
});

describe('subscribeToPresenter — word-cloud broadcast payload handler (Req 6.15)', () => {
  beforeEach(() => {
    channelMock.mockReset();
    removeChannelMock.mockReset();
  });

  it('positive: onWordCloud is called with a valid word-cloud broadcast payload', () => {
    let wcBroadcastHandler: ((msg: { payload?: unknown }) => void) | null =
      null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            wcBroadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    removeChannelMock.mockResolvedValue(undefined);

    const onWordCloud = vi.fn();
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onWordCloud,
    });

    // Fire the broadcast handler with a valid word-cloud payload
    const validPayload = {
      event_id: 'event-1',
      prompt_id: 'prompt-1',
      terms: [{ term: 'innovation', frequency: 5 }],
    };
    wcBroadcastHandler!({ payload: validPayload });
    expect(onWordCloud).toHaveBeenCalledWith(validPayload);
  });

  it('negative: onWordCloud NOT called for payload from a different event_id', () => {
    let wcBroadcastHandler: ((msg: { payload?: unknown }) => void) | null =
      null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            wcBroadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);

    const onWordCloud = vi.fn();
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onWordCloud,
    });

    wcBroadcastHandler!({
      payload: { event_id: 'event-OTHER', prompt_id: 'p-1', terms: [] },
    });
    expect(onWordCloud).not.toHaveBeenCalled();
  });

  it('negative: onWordCloud NOT called for malformed payload', () => {
    let wcBroadcastHandler: ((msg: { payload?: unknown }) => void) | null =
      null;

    const channelInstance = {
      on: vi.fn(
        (
          type: string,
          _opts: unknown,
          cb: (msg: { payload?: unknown }) => void,
        ) => {
          if (type === 'broadcast') {
            wcBroadcastHandler = cb;
          }
          return channelInstance;
        },
      ),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);

    const onWordCloud = vi.fn();
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onWordCloud,
    });

    // Malformed: missing prompt_id
    wcBroadcastHandler!({ payload: { event_id: 'event-1', terms: [] } });
    expect(onWordCloud).not.toHaveBeenCalled();
  });
});
