/**
 * Task 42.3 — Unit tests for presenter read helpers (src/lib/presenter.ts),
 * covering Req-26.1/26.2 behaviours:
 *
 *  - presenter visibility: positive (allowed statuses) + negative (pending/hidden excluded) (Req 7.9)
 *  - isPresenterMode type guard: positive + negative
 *  - readPresenterQuestions: returns filtered questions, returns [] on error
 *  - readFeaturedQuestion: returns null when no featured question
 *
 * Supabase client is mocked.
 *
 * Requirements: 7.4, 7.9, 26.1, 26.2
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

// ── Subject under test ────────────────────────────────────────────────────────
import {
  DEFAULT_TOP_QUESTIONS_LIMIT,
  PRESENTABLE_QUESTION_STATUSES,
  PRESENTER_MODES,
  isPresenterMode,
  readFeaturedQuestion,
  readPresenterQuestions,
} from './presenter';

// ─────────────────────────────────────────────────────────────────────────────
// Exported constants
// ─────────────────────────────────────────────────────────────────────────────
describe('exported constants', () => {
  it('DEFAULT_TOP_QUESTIONS_LIMIT is 5', () => {
    expect(DEFAULT_TOP_QUESTIONS_LIMIT).toBe(5);
  });
  it('PRESENTER_MODES contains all 7 modes', () => {
    expect(PRESENTER_MODES).toHaveLength(7);
    expect(PRESENTER_MODES).toContain('join');
    expect(PRESENTER_MODES).toContain('featured_question');
    expect(PRESENTER_MODES).toContain('top_questions');
    expect(PRESENTER_MODES).toContain('waiting');
  });
  it('PRESENTABLE_QUESTION_STATUSES contains approved, featured, answered', () => {
    expect(PRESENTABLE_QUESTION_STATUSES).toContain('approved');
    expect(PRESENTABLE_QUESTION_STATUSES).toContain('featured');
    expect(PRESENTABLE_QUESTION_STATUSES).toContain('answered');
  });
  it('PRESENTABLE_QUESTION_STATUSES does NOT contain pending or hidden (Req 7.9)', () => {
    expect(PRESENTABLE_QUESTION_STATUSES).not.toContain('pending');
    expect(PRESENTABLE_QUESTION_STATUSES).not.toContain('hidden');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isPresenterMode — positive + negative (Req 7.4)
// ─────────────────────────────────────────────────────────────────────────────
describe('isPresenterMode — positive cases', () => {
  it.each(PRESENTER_MODES as string[])('accepts %s', (mode) => {
    expect(isPresenterMode(mode)).toBe(true);
  });
});

describe('isPresenterMode — negative cases', () => {
  it('rejects an unknown string', () => {
    expect(isPresenterMode('unknown_mode')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isPresenterMode('')).toBe(false);
  });
  it('rejects null', () => {
    expect(isPresenterMode(null)).toBe(false);
  });
  it('rejects undefined', () => {
    expect(isPresenterMode(undefined)).toBe(false);
  });
  it('rejects a number', () => {
    expect(isPresenterMode(42)).toBe(false);
  });
  it('rejects "pending" (should never be a presenter mode)', () => {
    expect(isPresenterMode('pending')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readPresenterQuestions — presenter visibility (Req 7.9)
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mock query builder for questions. */
function makeQuestionsChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.in = fn;
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('readPresenterQuestions', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns [] for empty eventId (no query made)', async () => {
    const result = await readPresenterQuestions('');
    expect(result).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns filtered presentable questions', async () => {
    const rows = [
      { id: 'q-1', text: 'How?', status: 'approved', vote_count: 3 },
      { id: 'q-2', text: 'Why?', status: 'featured', vote_count: 5 },
    ];
    fromMock.mockReturnValue(makeQuestionsChain({ data: rows, error: null }));
    const result = await readPresenterQuestions('event-1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('q-1');
  });

  it('negative: returns [] when query has a transport error (Req 7.7 — retain last content)', async () => {
    fromMock.mockReturnValue(
      makeQuestionsChain({ data: null, error: { message: 'failed' } }),
    );
    const result = await readPresenterQuestions('event-1');
    expect(result).toEqual([]);
  });

  it('negative: excludes rows with pending status (type-guard defence-in-depth, Req 7.9)', async () => {
    const rows = [
      { id: 'q-1', text: 'Visible', status: 'approved', vote_count: 2 },
      { id: 'q-2', text: 'Hidden', status: 'pending', vote_count: 0 },
    ];
    fromMock.mockReturnValue(makeQuestionsChain({ data: rows, error: null }));
    const result = await readPresenterQuestions('event-1');
    // Only approved/featured/answered pass the type guard
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('q-1');
  });

  it('negative: excludes rows with hidden status (Req 7.9)', async () => {
    const rows = [
      { id: 'q-1', text: 'Visible', status: 'featured', vote_count: 1 },
      { id: 'q-2', text: 'Hidden', status: 'hidden', vote_count: 0 },
    ];
    fromMock.mockReturnValue(makeQuestionsChain({ data: rows, error: null }));
    const result = await readPresenterQuestions('event-1');
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('featured');
  });

  it('positive: returns [] when data is null (not an array)', async () => {
    fromMock.mockReturnValue(makeQuestionsChain({ data: null, error: null }));
    const result = await readPresenterQuestions('event-1');
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readFeaturedQuestion
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mock query builder ending in maybeSingle. */
function makeFeaturedChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('readFeaturedQuestion', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns null for empty eventId', async () => {
    await expect(readFeaturedQuestion('')).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns the featured question row', async () => {
    const row = {
      id: 'q-feat',
      text: 'Featured question?',
      status: 'featured',
      vote_count: 10,
    };
    fromMock.mockReturnValue(makeFeaturedChain({ data: row, error: null }));
    const result = await readFeaturedQuestion('event-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('q-feat');
    expect(result!.status).toBe('featured');
  });

  it('negative: returns null when no featured question exists', async () => {
    fromMock.mockReturnValue(makeFeaturedChain({ data: null, error: null }));
    const result = await readFeaturedQuestion('event-1');
    expect(result).toBeNull();
  });

  it('negative: returns null on query error (graceful degradation — Req 7.7)', async () => {
    fromMock.mockReturnValue(
      makeFeaturedChain({ data: null, error: { message: 'error' } }),
    );
    const result = await readFeaturedQuestion('event-1');
    expect(result).toBeNull();
  });

  it('negative: returns null when row has wrong status (type guard)', async () => {
    const row = {
      id: 'q-1',
      text: 'Some question',
      status: 'pending', // not presentable
      vote_count: 0,
    };
    fromMock.mockReturnValue(makeFeaturedChain({ data: row, error: null }));
    const result = await readFeaturedQuestion('event-1');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribeToPresenter — realtime subscription (Req 7.6, 7.7)
// ─────────────────────────────────────────────────────────────────────────────
import { subscribeToPresenter } from './presenter';

describe('subscribeToPresenter', () => {
  it('positive: opens a scoped presenter channel and returns unsubscribe', () => {
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    removeChannelMock.mockResolvedValue(undefined);

    const handlers = {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
    };
    const unsub = subscribeToPresenter('event-1', handlers);
    expect(channelMock).toHaveBeenCalledWith('presenter:event-1');
    expect(typeof unsub).toBe('function');
    unsub();
    expect(removeChannelMock).toHaveBeenCalled();
  });

  it('positive: onConnectionChange called false on SUBSCRIBED state (Req 7.7)', () => {
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
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange,
    });

    subscribeCallback!('SUBSCRIBED');
    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('negative: onConnectionChange called true on CHANNEL_ERROR (Req 7.7)', () => {
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
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange,
    });

    subscribeCallback!('CHANNEL_ERROR');
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('negative: onConnectionChange called true on TIMED_OUT', () => {
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
    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange,
    });

    subscribeCallback!('TIMED_OUT');
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('positive: opens additional poll-results channel when onPollResults handler supplied', () => {
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    removeChannelMock.mockResolvedValue(undefined);

    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onPollResults: vi.fn(),
    });

    // Should have opened both the presenter channel and the poll results channel
    const channelCalls = channelMock.mock.calls.map((c) => c[0] as string);
    expect(channelCalls).toContain('presenter:event-1');
    expect(channelCalls).toContain('event:event-1:polls');
  });

  it('positive: opens additional word-cloud channel when onWordCloud handler supplied', () => {
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    removeChannelMock.mockResolvedValue(undefined);

    subscribeToPresenter('event-1', {
      onModeChange: vi.fn(),
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
      onWordCloud: vi.fn(),
    });

    const channelCalls = channelMock.mock.calls.map((c) => c[0] as string);
    expect(channelCalls).toContain('presenter:event-1');
    expect(channelCalls).toContain('event:event-1:wordcloud');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Presenter poll/word-cloud reads (Req 7.4, 7.8)
// ─────────────────────────────────────────────────────────────────────────────
import { readPresenterActivePoll, readPresenterWordCloud } from './presenter';

/** Build a mock poll chain that resolves after 2 order() calls. */
function makePollChainP(result: { data: unknown; error: unknown }) {
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

/** Build a mock options chain that resolves after order(). */
function makeOptionsChainP(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.order = vi.fn(() => Promise.resolve(result));
  return chain;
}

/** Build a mock word-cloud response query chain ending in eq(is_hidden, false). */
function makeWcResponseChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  let eqCallCount = 0;
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => {
    eqCallCount++;
    return eqCallCount >= 2 ? Promise.resolve(result) : chain;
  });
  return chain;
}

describe('readPresenterActivePoll', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns null for empty eventId', async () => {
    await expect(readPresenterActivePoll('')).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns null when no readable polls exist', async () => {
    fromMock.mockReturnValue(makePollChainP({ data: [], error: null }));
    await expect(readPresenterActivePoll('event-1')).resolves.toBeNull();
  });

  it('negative: returns null on poll transport error (graceful, Req 7.7)', async () => {
    fromMock.mockReturnValue(
      makePollChainP({ data: null, error: { message: 'fail' } }),
    );
    await expect(readPresenterActivePoll('event-1')).resolves.toBeNull();
  });

  it('positive: returns poll with options when rows are well-formed', async () => {
    const pollRow = {
      id: 'poll-1',
      question_text: 'Pick one',
      status: 'open',
      results_visibility: 'show_always',
    };
    const optionRows = [
      { id: 'opt-1', text: 'A', display_order: 1, response_count: 3 },
    ];
    fromMock
      .mockReturnValueOnce(makePollChainP({ data: [pollRow], error: null }))
      .mockReturnValueOnce(
        makeOptionsChainP({ data: optionRows, error: null }),
      );
    const result = await readPresenterActivePoll('event-1');
    expect(result).not.toBeNull();
    expect(result!.options).toHaveLength(1);
  });
});

describe('readPresenterWordCloud', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns empty for empty eventId', async () => {
    const result = await readPresenterWordCloud('');
    expect(result.prompt).toBeNull();
    expect(result.responses).toHaveLength(0);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('negative: returns empty on prompt transport error (graceful)', async () => {
    fromMock.mockReturnValue(
      makePollChainP({ data: null, error: { message: 'fail' } }),
    );
    const result = await readPresenterWordCloud('event-1');
    expect(result.prompt).toBeNull();
    expect(result.responses).toHaveLength(0);
  });

  it('positive: returns prompt + responses when well-formed', async () => {
    const promptRow = {
      id: 'prompt-1',
      prompt_text: 'One word',
      status: 'open',
      results_visible_while_collecting: true,
    };
    const responseRows = [{ normalised_text: 'innovation', is_hidden: false }];
    fromMock
      .mockReturnValueOnce(makePollChainP({ data: [promptRow], error: null }))
      .mockReturnValueOnce(
        makeWcResponseChain({ data: responseRows, error: null }),
      );
    const result = await readPresenterWordCloud('event-1');
    expect(result.prompt).not.toBeNull();
    expect(result.responses).toHaveLength(1);
  });
});
