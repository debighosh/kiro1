/**
 * Task 13.5 (optional) — unit tests for the submit + vote RPC LOGIC and rate
 * limiting, exercised against the pure reference model in src/db/qaRules.ts.
 *
 * WHY A MODEL AND NOT THE LIVE SQL
 * --------------------------------
 * The authoritative submit/vote logic lives in PostgreSQL SECURITY DEFINER
 * functions (supabase/migrations/20260101000014_submit_question_rpc.sql and
 * 20260101000015_vote_rpc.sql, using the 20260101000013 rate-limiting helper).
 * They use plpgsql, custom enum types, `event_is_live`, regex sanitisation,
 * advisory locks and a real UNIQUE constraint — none of which can execute in
 * this sandbox (no Postgres/psql/supabase CLI; pg-mem cannot represent them).
 * A live execution test therefore runs against a real Postgres in CI via the
 * env-gated integration suites (see src/db/rls.events.test.ts and Task 12.3),
 * which skip cleanly without TEST_SUPABASE_*.
 *
 * These unit tests lock down the DECISION RULES the SQL encodes — moderation
 * mode → status, 1–300 code-point length + sanitisation, live gating, submission
 * key idempotency, vote cast/remove count maths, duplicate rejection,
 * eligibility, and the 10/60s submit and 30/60s vote sliding-window thresholds —
 * so a change to the intended behaviour is caught fast. The model and the SQL
 * are a matched pair (like eventStatus.ts / the transition Edge Function).
 *
 * Requirements: 3.3, 3.6, 3.7, 4.4, 4.6, 4.8, 21.13, 21.14, 21.15, 22.1, 26.1.
 * Design: Request/data flows; RLS Design (rate limiting).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_QUESTION_LENGTH,
  QaModel,
  QaRuleError,
  RATE_LIMIT_WINDOW_SECONDS,
  SUBMIT_RATE_LIMIT_MAX,
  VOTE_RATE_LIMIT_MAX,
  codePointLength,
  isValidQuestionText,
  isVoteEligible,
  sanitiseQuestionText,
  submitStatusForModerationMode,
  type QuestionStatus,
} from './qaRules';

const EVENT = 'event-1';
const PARTICIPANT = 'participant-abc';

/** A model with a manually-advanceable clock for deterministic rate-limit tests. */
function makeModelWithClock(): { model: QaModel; advance: (ms: number) => void } {
  let now = 1_000_000;
  const model = new QaModel(() => now);
  return { model, advance: (ms: number) => (now += ms) };
}

// ---------------------------------------------------------------------------
// Moderation-mode status defaulting (Req 3.6, 3.7).
// ---------------------------------------------------------------------------
describe('submitStatusForModerationMode (Req 3.6, 3.7)', () => {
  it("maps 'pre' → 'pending'", () => {
    expect(submitStatusForModerationMode('pre')).toBe('pending');
  });

  it("maps 'post' → 'approved'", () => {
    expect(submitStatusForModerationMode('post')).toBe('approved');
  });

  it('a pre-moderation submit inserts a pending question', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'pre', live: true });
    const q = model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'Hi?' });
    expect(q.status).toBe('pending');
  });

  it('a post-moderation submit inserts an approved question', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    const q = model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'Hi?' });
    expect(q.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Length 1–300 code points + sanitisation rejection (Req 3.1, 3.2, 22.1).
// ---------------------------------------------------------------------------
describe('question text length + sanitisation (Req 3.1, 3.2, 22.1)', () => {
  it('accepts a single-character question (lower boundary = 1)', () => {
    expect(isValidQuestionText('a')).toBe(true);
  });

  it('accepts exactly 300 code points (upper boundary)', () => {
    expect(isValidQuestionText('x'.repeat(MAX_QUESTION_LENGTH))).toBe(true);
  });

  it('rejects 301 code points (over-length)', () => {
    expect(isValidQuestionText('x'.repeat(MAX_QUESTION_LENGTH + 1))).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidQuestionText('')).toBe(false);
  });

  it('rejects whitespace-only input (collapses to length 0)', () => {
    expect(isValidQuestionText('   \t\n  ')).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(isValidQuestionText(null)).toBe(false);
    expect(isValidQuestionText(undefined)).toBe(false);
  });

  it('rejects control-character-only input (sanitises to empty)', () => {
    expect(isValidQuestionText('\u0000\u0001\u0007\u007F')).toBe(false);
  });

  it('counts Unicode CODE POINTS, not UTF-16 units (astral chars count as 1)', () => {
    // "😀" is a single code point but 2 UTF-16 units. 300 of them must be valid.
    const emoji300 = '😀'.repeat(MAX_QUESTION_LENGTH);
    expect(codePointLength(emoji300)).toBe(MAX_QUESTION_LENGTH);
    expect(isValidQuestionText(emoji300)).toBe(true);
    expect(isValidQuestionText('😀'.repeat(MAX_QUESTION_LENGTH + 1))).toBe(false);
  });

  it('strips control characters but keeps printable text', () => {
    expect(sanitiseQuestionText('a\u0000b\u0007c')).toBe('abc');
  });

  it('collapses tab/newline/CR runs to a single space and trims', () => {
    expect(sanitiseQuestionText('  hello\t\tworld\n\nfoo  ')).toBe('hello world foo');
  });

  it('submit rejects invalid length with invalid_length signal', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    expect(() =>
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: '   ' }),
    ).toThrow(new QaRuleError('invalid_length'));
    expect(() =>
      model.submitQuestion({
        eventId: EVENT,
        participant: PARTICIPANT,
        text: 'x'.repeat(301),
      }),
    ).toThrow(new QaRuleError('invalid_length'));
  });

  it('submit stores the sanitised (not raw) text', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    const q = model.submitQuestion({
      eventId: EVENT,
      participant: PARTICIPANT,
      text: '  a\u0000b\tc  ',
    });
    expect(q.text).toBe('ab c');
  });
});

// ---------------------------------------------------------------------------
// Submit rejected when event is not live (Req 3.3).
// ---------------------------------------------------------------------------
describe('submit live gating (Req 3.3)', () => {
  it('rejects submission when the event is not live', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: false });
    expect(() =>
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'Hi?' }),
    ).toThrow(new QaRuleError('event_not_live'));
  });

  it('rejects submission to an unknown event (defaults to not live)', () => {
    const model = new QaModel();
    expect(() =>
      model.submitQuestion({ eventId: 'no-such-event', participant: PARTICIPANT, text: 'Hi?' }),
    ).toThrow(new QaRuleError('event_not_live'));
  });

  it('accepts submission when the event is live', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'pre', live: true });
    const q = model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'Hi?' });
    expect(q.status).toBe('pending');
    expect(q.text).toBe('Hi?');
  });
});

// ---------------------------------------------------------------------------
// submission_key idempotency (Req 23.8): retry returns the same row, no dup.
// ---------------------------------------------------------------------------
describe('submission_key idempotency (Req 23.8)', () => {
  it('a retried submit with the same key returns the SAME row (no duplicate)', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    const first = model.submitQuestion({
      eventId: EVENT,
      participant: PARTICIPANT,
      text: 'Idempotent?',
      submissionKey: 'key-1',
    });
    const second = model.submitQuestion({
      eventId: EVENT,
      participant: PARTICIPANT,
      text: 'Idempotent?',
      submissionKey: 'key-1',
    });
    expect(second.id).toBe(first.id);
  });

  it('different submission keys create distinct rows', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    const a = model.submitQuestion({
      eventId: EVENT,
      participant: PARTICIPANT,
      text: 'A?',
      submissionKey: 'key-a',
    });
    const b = model.submitQuestion({
      eventId: EVENT,
      participant: PARTICIPANT,
      text: 'B?',
      submissionKey: 'key-b',
    });
    expect(b.id).not.toBe(a.id);
  });

  it('the same key on a DIFFERENT event is not treated as a duplicate', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    model.setEvent('event-2', { mode: 'post', live: true });
    const a = model.submitQuestion({
      eventId: EVENT,
      participant: PARTICIPANT,
      text: 'A?',
      submissionKey: 'shared',
    });
    const b = model.submitQuestion({
      eventId: 'event-2',
      participant: PARTICIPANT,
      text: 'A?',
      submissionKey: 'shared',
    });
    expect(b.id).not.toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// Vote cast/remove increments/decrements; duplicate; remove-with-no-vote no-op.
// (Req 4.4, 4.5, 4.6)
// ---------------------------------------------------------------------------
describe('vote cast / remove count maths (Req 4.4, 4.5, 4.6)', () => {
  function liveApprovedModel(): { model: QaModel; questionId: string } {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    const questionId = model.seedQuestion({ eventId: EVENT, status: 'approved', voteCount: 0 });
    return { model, questionId };
  }

  it('casting a vote increments vote_count and returns the new count', () => {
    const { model, questionId } = liveApprovedModel();
    expect(model.castVote({ questionId, participant: 'p1' })).toBe(1);
    expect(model.getQuestion(questionId)!.voteCount).toBe(1);
  });

  it('distinct participants each increment the count', () => {
    const { model, questionId } = liveApprovedModel();
    expect(model.castVote({ questionId, participant: 'p1' })).toBe(1);
    expect(model.castVote({ questionId, participant: 'p2' })).toBe(2);
  });

  it('a duplicate vote is rejected and leaves the count UNCHANGED (Req 4.4)', () => {
    const { model, questionId } = liveApprovedModel();
    expect(model.castVote({ questionId, participant: 'p1' })).toBe(1);
    expect(() => model.castVote({ questionId, participant: 'p1' })).toThrow(
      new QaRuleError('already_voted'),
    );
    expect(model.getQuestion(questionId)!.voteCount).toBe(1);
  });

  it('removing an existing vote decrements the count (Req 4.5)', () => {
    const { model, questionId } = liveApprovedModel();
    model.castVote({ questionId, participant: 'p1' });
    model.castVote({ questionId, participant: 'p2' });
    expect(model.removeVote({ questionId, participant: 'p1' })).toBe(1);
    expect(model.getQuestion(questionId)!.voteCount).toBe(1);
  });

  it('add-then-remove restores the original count (round trip)', () => {
    const { model, questionId } = liveApprovedModel();
    model.castVote({ questionId, participant: 'p1' });
    model.removeVote({ questionId, participant: 'p1' });
    expect(model.getQuestion(questionId)!.voteCount).toBe(0);
  });

  it('remove-with-no-vote is a no-op on the count and raises no_vote_to_remove (Req 4.6)', () => {
    const { model, questionId } = liveApprovedModel();
    expect(() => model.removeVote({ questionId, participant: 'never-voted' })).toThrow(
      new QaRuleError('no_vote_to_remove'),
    );
    expect(model.getQuestion(questionId)!.voteCount).toBe(0);
  });

  it('the count never goes below 0 (floored)', () => {
    const { model, questionId } = liveApprovedModel();
    model.castVote({ questionId, participant: 'p1' });
    expect(model.removeVote({ questionId, participant: 'p1' })).toBe(0);
    expect(() => model.removeVote({ questionId, participant: 'p1' })).toThrow(
      new QaRuleError('no_vote_to_remove'),
    );
    expect(model.getQuestion(questionId)!.voteCount).toBe(0);
  });

  it('casting on an unknown question raises question_not_found', () => {
    const { model } = liveApprovedModel();
    expect(() => model.castVote({ questionId: 'nope', participant: 'p1' })).toThrow(
      new QaRuleError('question_not_found'),
    );
  });
});

// ---------------------------------------------------------------------------
// Vote eligibility by status + live-ness (Req 4.8).
// ---------------------------------------------------------------------------
describe('vote eligibility (Req 4.8)', () => {
  it('isVoteEligible is true only for approved/featured on a live event', () => {
    expect(isVoteEligible('approved', true)).toBe(true);
    expect(isVoteEligible('featured', true)).toBe(true);
    expect(isVoteEligible('pending', true)).toBe(false);
    expect(isVoteEligible('hidden', true)).toBe(false);
    expect(isVoteEligible('answered', true)).toBe(false);
    // Eligible status but event not live → ineligible.
    expect(isVoteEligible('approved', false)).toBe(false);
    expect(isVoteEligible('featured', false)).toBe(false);
  });

  it.each(['pending', 'hidden', 'answered'] as QuestionStatus[])(
    'rejects a vote on a %s question leaving the count unchanged (Req 4.8)',
    (status) => {
      const model = new QaModel();
      model.setEvent(EVENT, { mode: 'pre', live: true });
      const questionId = model.seedQuestion({ eventId: EVENT, status, voteCount: 3 });
      expect(() => model.castVote({ questionId, participant: 'p1' })).toThrow(
        new QaRuleError('not_eligible'),
      );
      expect(model.getQuestion(questionId)!.voteCount).toBe(3);
    },
  );

  it('rejects a vote on an approved question when the event is NOT live', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: false });
    const questionId = model.seedQuestion({ eventId: EVENT, status: 'approved', voteCount: 5 });
    expect(() => model.castVote({ questionId, participant: 'p1' })).toThrow(
      new QaRuleError('not_eligible'),
    );
    expect(model.getQuestion(questionId)!.voteCount).toBe(5);
  });

  it('allows a vote on a featured question on a live event', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    const questionId = model.seedQuestion({ eventId: EVENT, status: 'featured', voteCount: 0 });
    expect(model.castVote({ questionId, participant: 'p1' })).toBe(1);
  });

  it('removal is NOT eligibility-gated: a vote can be withdrawn after status changes', () => {
    const model = new QaModel();
    model.setEvent(EVENT, { mode: 'post', live: true });
    const questionId = model.seedQuestion({ eventId: EVENT, status: 'approved', voteCount: 0 });
    model.castVote({ questionId, participant: 'p1' });
    // Status is now (hypothetically) no longer eligible, but removal still works.
    expect(model.removeVote({ questionId, participant: 'p1' })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limits: 10/60s submissions, 30/60s votes; reject on exceed (Req 21.13–21.15).
// ---------------------------------------------------------------------------
describe('rate limiting (Req 21.13, 21.14, 21.15)', () => {
  it('allows 10 submissions in the window then rejects the 11th (Req 21.13)', () => {
    const { model } = makeModelWithClock();
    model.setEvent(EVENT, { mode: 'post', live: true });
    for (let i = 0; i < SUBMIT_RATE_LIMIT_MAX; i += 1) {
      expect(() =>
        model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: `q${i}` }),
      ).not.toThrow();
    }
    expect(() =>
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'one too many' }),
    ).toThrow(new QaRuleError('rate_limited'));
  });

  it('the submit window slides: after 60s the count resets (Req 21.13)', () => {
    const { model, advance } = makeModelWithClock();
    model.setEvent(EVENT, { mode: 'post', live: true });
    for (let i = 0; i < SUBMIT_RATE_LIMIT_MAX; i += 1) {
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: `q${i}` });
    }
    // Just past the 60s window → the earlier events fall out.
    advance(RATE_LIMIT_WINDOW_SECONDS * 1000 + 1);
    expect(() =>
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'fresh window' }),
    ).not.toThrow();
  });

  it('rate limits are per participant (a different participant is unaffected)', () => {
    const { model } = makeModelWithClock();
    model.setEvent(EVENT, { mode: 'post', live: true });
    for (let i = 0; i < SUBMIT_RATE_LIMIT_MAX; i += 1) {
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: `q${i}` });
    }
    expect(() =>
      model.submitQuestion({ eventId: EVENT, participant: 'other', text: 'still ok' }),
    ).not.toThrow();
  });

  it('allows 30 votes in the window then rejects the 31st (Req 21.14)', () => {
    const { model } = makeModelWithClock();
    model.setEvent(EVENT, { mode: 'post', live: true });
    // Distinct questions so uniqueness never trips before the rate limit.
    const questionIds = Array.from({ length: VOTE_RATE_LIMIT_MAX + 1 }, () =>
      model.seedQuestion({ eventId: EVENT, status: 'approved' }),
    );
    for (let i = 0; i < VOTE_RATE_LIMIT_MAX; i += 1) {
      expect(() => model.castVote({ questionId: questionIds[i], participant: PARTICIPANT })).not.toThrow();
    }
    expect(() =>
      model.castVote({ questionId: questionIds[VOTE_RATE_LIMIT_MAX], participant: PARTICIPANT }),
    ).toThrow(new QaRuleError('rate_limited'));
  });

  it('a rejected (rate-limited) submit records nothing — the window is not consumed further (Req 21.15)', () => {
    const { model, advance } = makeModelWithClock();
    model.setEvent(EVENT, { mode: 'post', live: true });
    for (let i = 0; i < SUBMIT_RATE_LIMIT_MAX; i += 1) {
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: `q${i}` });
    }
    // Several rejected attempts must not extend/refresh the window.
    for (let i = 0; i < 3; i += 1) {
      expect(() =>
        model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'blocked' }),
      ).toThrow(new QaRuleError('rate_limited'));
    }
    // Once the original 10 age out, a submit is allowed again.
    advance(RATE_LIMIT_WINDOW_SECONDS * 1000 + 1);
    expect(() =>
      model.submitQuestion({ eventId: EVENT, participant: PARTICIPANT, text: 'ok now' }),
    ).not.toThrow();
  });

  it('an ineligible vote does NOT consume a rate-limit slot (eligibility checked first)', () => {
    const { model } = makeModelWithClock();
    model.setEvent(EVENT, { mode: 'pre', live: true });
    const pending = model.seedQuestion({ eventId: EVENT, status: 'pending' });
    const approved = model.seedQuestion({ eventId: EVENT, status: 'approved' });
    // 30 failed attempts on an ineligible question...
    for (let i = 0; i < VOTE_RATE_LIMIT_MAX; i += 1) {
      expect(() => model.castVote({ questionId: pending, participant: PARTICIPANT })).toThrow(
        new QaRuleError('not_eligible'),
      );
    }
    // ...still leave the full vote budget available for an eligible question.
    expect(() => model.castVote({ questionId: approved, participant: PARTICIPANT })).not.toThrow();
  });
});
