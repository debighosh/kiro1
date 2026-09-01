/**
 * Task 42.3 — Unit tests for question-submit and voting client helpers
 * (src/lib/questions.ts), covering Req-26.1/26.2 behaviours:
 *
 *  - question validation: positive (valid) + negative (invalid) lengths (Req 3.1, 3.2)
 *  - duplicate-vote prevention: `already_voted` error mapping (Req 4.4)
 *  - QuestionError kind mapping for every RPC signal (Req 3.3, 4.1, 4.5, 4.6)
 *
 * Supabase client and participant-id helper are mocked so tests run without env.
 *
 * Requirements: 3.1, 3.2, 3.3, 4.1, 4.4, 4.5, 26.1, 26.2
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (hoisted so vi.mock factories can reference them) ──────────────────
const { rpcMock, channelMock, removeChannelMock, getParticipantIdMock } =
  vi.hoisted(() => ({
    rpcMock: vi.fn(),
    channelMock: vi.fn(),
    removeChannelMock: vi.fn(),
    getParticipantIdMock: vi.fn(() => 'participant-abc'),
  }));

vi.mock('./supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: vi.fn(),
    channel: (...args: unknown[]) => channelMock(...args),
    removeChannel: (...args: unknown[]) => removeChannelMock(...args),
  },
}));

vi.mock('./participant', () => ({
  getParticipantIdentifier: () => getParticipantIdMock(),
}));

// ── Subject under test ────────────────────────────────────────────────────────
import {
  CAST_QUESTION_VOTE_RPC,
  DEFAULT_QUESTION_SORT,
  QUESTION_TEXT_MAX,
  QUESTION_TEXT_MIN,
  QuestionError,
  REMOVE_QUESTION_VOTE_RPC,
  SUBMIT_QUESTION_RPC,
  VOTABLE_QUESTION_STATUSES,
  castQuestionVote,
  countQuestionCodePoints,
  generateSubmissionKey,
  isValidQuestionLength,
  removeQuestionVote,
  submitQuestion,
} from './questions';

// ─────────────────────────────────────────────────────────────────────────────
// Constants / exports
// ─────────────────────────────────────────────────────────────────────────────
describe('exported constants', () => {
  it('QUESTION_TEXT_MIN is 1', () => expect(QUESTION_TEXT_MIN).toBe(1));
  it('QUESTION_TEXT_MAX is 300', () => expect(QUESTION_TEXT_MAX).toBe(300));
  it('SUBMIT_QUESTION_RPC is "submit_question"', () =>
    expect(SUBMIT_QUESTION_RPC).toBe('submit_question'));
  it('CAST_QUESTION_VOTE_RPC is "cast_question_vote"', () =>
    expect(CAST_QUESTION_VOTE_RPC).toBe('cast_question_vote'));
  it('REMOVE_QUESTION_VOTE_RPC is "remove_question_vote"', () =>
    expect(REMOVE_QUESTION_VOTE_RPC).toBe('remove_question_vote'));
  it('DEFAULT_QUESTION_SORT is "most_votes"', () =>
    expect(DEFAULT_QUESTION_SORT).toBe('most_votes'));
  it('VOTABLE_QUESTION_STATUSES contains approved and featured', () => {
    expect(VOTABLE_QUESTION_STATUSES).toContain('approved');
    expect(VOTABLE_QUESTION_STATUSES).toContain('featured');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countQuestionCodePoints
// ─────────────────────────────────────────────────────────────────────────────
describe('countQuestionCodePoints', () => {
  it('returns 0 for empty string', () => {
    expect(countQuestionCodePoints('')).toBe(0);
  });
  it('counts ASCII characters correctly', () => {
    expect(countQuestionCodePoints('hello')).toBe(5);
  });
  it('counts emoji as single code points', () => {
    // 😀 is U+1F600 — a single code point but two UTF-16 code units
    expect(countQuestionCodePoints('😀😀')).toBe(2);
  });
  it('counts a 300-character string as 300', () => {
    expect(countQuestionCodePoints('a'.repeat(300))).toBe(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidQuestionLength — question validation (Req 3.1, 3.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('isValidQuestionLength — positive cases (Req 3.1)', () => {
  it('accepts a single non-whitespace character', () => {
    expect(isValidQuestionLength('a')).toBe(true);
  });
  it('accepts exactly 300 characters', () => {
    expect(isValidQuestionLength('a'.repeat(300))).toBe(true);
  });
  it('accepts a realistic question', () => {
    expect(isValidQuestionLength('How does the pricing model work?')).toBe(
      true,
    );
  });
});

describe('isValidQuestionLength — negative cases (Req 3.2)', () => {
  it('rejects an empty string', () => {
    expect(isValidQuestionLength('')).toBe(false);
  });
  it('rejects a whitespace-only string', () => {
    expect(isValidQuestionLength('   ')).toBe(false);
  });
  it('rejects a string exceeding 300 characters', () => {
    expect(isValidQuestionLength('a'.repeat(301))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateSubmissionKey
// ─────────────────────────────────────────────────────────────────────────────
describe('generateSubmissionKey', () => {
  it('returns a non-empty string', () => {
    const key = generateSubmissionKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });
  it('generates different keys on consecutive calls', () => {
    const k1 = generateSubmissionKey();
    const k2 = generateSubmissionKey();
    expect(k1).not.toBe(k2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QuestionError
// ─────────────────────────────────────────────────────────────────────────────
describe('QuestionError', () => {
  it('constructs with correct kind and message', () => {
    const err = new QuestionError('Too fast', { kind: 'rate_limited' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('QuestionError');
    expect(err.message).toBe('Too fast');
    expect(err.kind).toBe('rate_limited');
  });
  it('preserves cause when supplied', () => {
    const cause = new Error('original');
    const err = new QuestionError('msg', { kind: 'unknown', cause });
    expect(err.cause).toBe(cause);
  });
  it('kind is "invalid_length" for validation errors', () => {
    const err = new QuestionError('too long', { kind: 'invalid_length' });
    expect(err.kind).toBe('invalid_length');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitQuestion — client-side validation (Req 3.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('submitQuestion — client-side validation (Req 3.2)', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('positive: calls RPC and returns { id, status } for a valid submission', async () => {
    rpcMock.mockResolvedValue({
      data: { id: 'q-1', status: 'pending' },
      error: null,
    });
    const result = await submitQuestion({
      eventId: 'event-1',
      text: 'A valid question?',
    });
    expect(result).toEqual({ id: 'q-1', status: 'pending' });
    expect(rpcMock).toHaveBeenCalledWith(SUBMIT_QUESTION_RPC, {
      p_event_id: 'event-1',
      p_participant_identifier: 'participant-abc',
      p_text: 'A valid question?',
      p_submission_key: expect.any(String),
    });
  });

  it('negative: throws invalid_length without calling RPC for empty text', async () => {
    await expect(
      submitQuestion({ eventId: 'event-1', text: '' }),
    ).rejects.toMatchObject({ kind: 'invalid_length' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('negative: throws invalid_length for whitespace-only text', async () => {
    await expect(
      submitQuestion({ eventId: 'event-1', text: '   ' }),
    ).rejects.toMatchObject({ kind: 'invalid_length' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('negative: throws invalid_length for text > 300 chars', async () => {
    await expect(
      submitQuestion({ eventId: 'event-1', text: 'x'.repeat(301) }),
    ).rejects.toMatchObject({ kind: 'invalid_length' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('negative: maps RPC rate_limited signal to rate_limited error', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'rate_limited' },
    });
    await expect(
      submitQuestion({ eventId: 'event-1', text: 'Valid question?' }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('negative: maps RPC event_not_live signal to event_not_live error', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'event_not_live' },
    });
    await expect(
      submitQuestion({ eventId: 'event-1', text: 'Valid question?' }),
    ).rejects.toMatchObject({ kind: 'event_not_live' });
  });

  it('negative: maps RPC invalid_length signal to invalid_length error', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'invalid_length' },
    });
    await expect(
      submitQuestion({ eventId: 'event-1', text: 'Valid question?' }),
    ).rejects.toMatchObject({ kind: 'invalid_length' });
  });

  it('negative: maps an unknown RPC error to unknown error', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'something unexpected' },
    });
    await expect(
      submitQuestion({ eventId: 'event-1', text: 'Valid question?' }),
    ).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('negative: throws unknown for malformed RPC success payload', async () => {
    rpcMock.mockResolvedValue({ data: { wrong: true }, error: null });
    await expect(
      submitQuestion({ eventId: 'event-1', text: 'Valid question?' }),
    ).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('positive: accepts submitted question from array payload', async () => {
    rpcMock.mockResolvedValue({
      data: [{ id: 'q-2', status: 'approved' }],
      error: null,
    });
    const result = await submitQuestion({
      eventId: 'event-1',
      text: 'Another valid question?',
    });
    expect(result).toEqual({ id: 'q-2', status: 'approved' });
  });

  it('positive: reuses caller-supplied submissionKey', async () => {
    rpcMock.mockResolvedValue({
      data: { id: 'q-3', status: 'pending' },
      error: null,
    });
    const key = 'my-idempotency-key';
    await submitQuestion({
      eventId: 'e-1',
      text: 'Valid?',
      submissionKey: key,
    });
    expect(rpcMock).toHaveBeenCalledWith(
      SUBMIT_QUESTION_RPC,
      expect.objectContaining({ p_submission_key: key }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// castQuestionVote — duplicate-vote prevention (Req 4.4, 26.1)
// ─────────────────────────────────────────────────────────────────────────────
describe('castQuestionVote', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('positive: returns new vote_count on success', async () => {
    rpcMock.mockResolvedValue({ data: 5, error: null });
    const count = await castQuestionVote('q-1');
    expect(count).toBe(5);
    expect(rpcMock).toHaveBeenCalledWith(CAST_QUESTION_VOTE_RPC, {
      p_question_id: 'q-1',
      p_participant_identifier: 'participant-abc',
    });
  });

  it('positive: handles array-wrapped vote_count response', async () => {
    rpcMock.mockResolvedValue({ data: [7], error: null });
    expect(await castQuestionVote('q-1')).toBe(7);
  });

  it('negative: throws already_voted when participant already voted (Req 4.4)', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'already_voted' },
    });
    await expect(castQuestionVote('q-1')).rejects.toMatchObject({
      kind: 'already_voted',
    });
  });

  it('negative: throws not_eligible for ineligible question', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'not_eligible' },
    });
    await expect(castQuestionVote('q-1')).rejects.toMatchObject({
      kind: 'not_eligible',
    });
  });

  it('negative: throws question_not_found for missing question', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'question_not_found' },
    });
    await expect(castQuestionVote('q-missing')).rejects.toMatchObject({
      kind: 'question_not_found',
    });
  });

  it('negative: throws rate_limited when rate limit exceeded', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'rate_limited' },
    });
    await expect(castQuestionVote('q-1')).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });

  it('negative: throws unknown for unrecognised vote error', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'unexpected_error' },
    });
    await expect(castQuestionVote('q-1')).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  it('negative: throws unknown when RPC returns non-numeric data', async () => {
    rpcMock.mockResolvedValue({ data: 'not-a-number', error: null });
    await expect(castQuestionVote('q-1')).rejects.toMatchObject({
      kind: 'unknown',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// removeQuestionVote (Req 4.5, 4.6)
// ─────────────────────────────────────────────────────────────────────────────
describe('removeQuestionVote', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('positive: returns new vote_count after removal (Req 4.5)', async () => {
    rpcMock.mockResolvedValue({ data: 3, error: null });
    const count = await removeQuestionVote('q-1');
    expect(count).toBe(3);
    expect(rpcMock).toHaveBeenCalledWith(REMOVE_QUESTION_VOTE_RPC, {
      p_question_id: 'q-1',
      p_participant_identifier: 'participant-abc',
    });
  });

  it('negative: throws no_vote_to_remove when no active vote exists (Req 4.6)', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'no_vote_to_remove' },
    });
    await expect(removeQuestionVote('q-1')).rejects.toMatchObject({
      kind: 'no_vote_to_remove',
    });
  });

  it('negative: throws rate_limited for rate limit', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'rate_limited' },
    });
    await expect(removeQuestionVote('q-1')).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribeToEventQuestions — realtime subscription helpers (Req 23.1, 23.2)
// ─────────────────────────────────────────────────────────────────────────────
import { subscribeToEventQuestions } from './questions';

describe('subscribeToEventQuestions', () => {
  it('positive: returns a no-op unsubscribe for empty eventId (Req 23.2)', () => {
    const unsub = subscribeToEventQuestions('', {});
    expect(typeof unsub).toBe('function');
    // Should not throw when called
    expect(() => unsub()).not.toThrow();
    expect(channelMock).not.toHaveBeenCalled();
  });

  it('positive: opens a scoped channel and returns an unsubscribe', () => {
    const channelInstance = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    };
    channelMock.mockReturnValue(channelInstance);
    removeChannelMock.mockResolvedValue(undefined);

    const handlers = {
      onQuestionsChange: vi.fn(),
      onConnectionChange: vi.fn(),
    };
    const unsub = subscribeToEventQuestions('event-1', handlers);
    expect(channelMock).toHaveBeenCalledWith('event:event-1:questions');
    expect(typeof unsub).toBe('function');
    unsub();
    expect(removeChannelMock).toHaveBeenCalled();
  });

  it('negative: onConnectionChange is called with true for CHANNEL_ERROR state', () => {
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

    subscribeCallback!('CHANNEL_ERROR');
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('positive: onConnectionChange is called with false for SUBSCRIBED state', () => {
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

    subscribeCallback!('SUBSCRIBED');
    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });
});
