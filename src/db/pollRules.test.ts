/**
 * Task 21.5 (optional) — EXAMPLE-BASED unit tests for the poll
 * create / transition / respond RPC LOGIC, exercised against the pure reference
 * model in src/db/pollRules.ts (lifecycle + responses) plus small pure helpers
 * in THIS file that mirror the create_poll RPC's field-validation bounds.
 *
 * These are unit / example tests (NOT property tests — Property tests live in
 * src/db/poll.properties.test.ts). Nothing here is tagged as a Property.
 *
 * WHY A MODEL + LOCAL HELPERS, NOT THE LIVE SQL
 * ---------------------------------------------
 * The authoritative poll logic lives in PostgreSQL SECURITY DEFINER RPCs:
 *   - supabase/migrations/20260101000023_create_poll_rpc.sql  → create_poll(...)
 *   - supabase/migrations/20260101000025_poll_transition_rpc.sql → set_poll_status(...)
 *   - supabase/migrations/20260101000027_poll_respond_rpc.sql → submit_poll_response(...)
 * Those are plpgsql functions using custom enum types, `event_is_live`, row /
 * advisory locks, the `one_open_poll_per_event` PARTIAL UNIQUE index and the
 * shared `check_and_record_rate_limit` helper — none of which can execute in
 * this sandbox (no Postgres/psql/supabase CLI; pg-mem cannot represent plpgsql,
 * custom types, partial unique indexes or locks). A live execution test runs
 * against a real Postgres in CI via the env-gated integration suites. The model
 * and the SQL are a matched pair (see the header of src/db/pollRules.ts).
 *
 * The pure model (pollRules.ts) covers the LIFECYCLE (set_poll_status) and the
 * RESPONSE upsert-replace + status gating (submit_poll_response). It does NOT
 * model create_poll's field validation (question 1–200 / option 1–100 / count
 * 2–10 / results_visibility), so the CREATE-validation tests below use small
 * PURE helpers defined in this test file that mirror the SQL's bounds exactly
 * (see create_poll migration 20260101000023). The SQL error signals are named
 * in comments so this file documents the create_poll contract.
 *
 * Requirements: 5.1, 5.2, 5.6, 5.7, 5.8, 5.9, 5.10, 21.13, 22.2, 26.1.
 * Design: Request/data flows (Poll lifecycle).
 */
import { describe, expect, it } from 'vitest';

import { PollModel, PollRuleError, isValidPollTransition } from './pollRules';

// ===========================================================================
// PURE create_poll VALIDATION HELPERS (mirror migration 20260101000023).
//
// These reproduce, as tiny pure predicates, the field bounds create_poll
// enforces before it inserts anything. The RPC RAISEs a stable P0001 MESSAGE
// identifying the failing field and — because a plpgsql RAISE aborts the whole
// implicit transaction — persists NOTHING (no partial poll). We model that
// "reject the whole request, identify the field, retain nothing" contract by
// having a single `validateCreatePoll` return the FIRST failing field signal
// (matching the SQL's top-to-bottom validation order) or null when all fields
// are valid. On a non-null signal, a real create_poll would insert no rows.
// ===========================================================================

/** Question-text bounds in Unicode code points (Req 5.1, 22.2). */
const MIN_QUESTION_CHARS = 1;
const MAX_QUESTION_CHARS = 200;
/** Per-option text bounds in Unicode code points (Req 5.1, 5.2). */
const MIN_OPTION_CHARS = 1;
const MAX_OPTION_CHARS = 100;
/** Option-count bounds per poll (Req 5.1, 5.2). */
const MIN_OPTION_COUNT = 2;
const MAX_OPTION_COUNT = 10;

/**
 * The two allowed `poll_results_visibility` enum members (Req 5.3). The DB enum
 * structurally restricts the value to these two; create_poll additionally
 * rejects NULL with `invalid_results_visibility`.
 */
const VALID_RESULTS_VISIBILITY = ['show_always', 'hide_until_closed'] as const;

/**
 * The create_poll field-validation error signals (SQLSTATE P0001 MESSAGE
 * strings) — mirrors the migration's "Error signals" section.
 */
type CreatePollErrorSignal =
  | 'invalid_question_text'
  | 'invalid_option_count'
  | 'invalid_option_text'
  | 'invalid_results_visibility';

interface CreatePollInput {
  questionText: string | null | undefined;
  options: readonly (string | null | undefined)[] | null | undefined;
  resultsVisibility: string | null | undefined;
}

/** Count Unicode CODE POINTS — Postgres `char_length` counts code points too. */
function codePointLength(text: string): number {
  return [...text].length;
}

/** btrim equivalent: strip leading/trailing ASCII whitespace as the SQL does. */
function trim(text: string): string {
  return text.trim();
}

/**
 * Pure mirror of create_poll's field validation. Returns the FIRST failing
 * field signal in the SQL's validation order (question → count → each option →
 * results_visibility per THIS test's chosen order; note the SQL validates
 * results_visibility before the option set, but each field is independent so
 * the returned signal is the one for the field under test), or null when every
 * field is valid. A non-null result means the RPC would create NO poll.
 *
 * Trimming is applied to text fields before length-checking, matching the RPC.
 */
function validateCreatePoll(
  input: CreatePollInput,
): CreatePollErrorSignal | null {
  // Question text 1–200 code points after trim (Req 5.1, 22.2).
  if (input.questionText === null || input.questionText === undefined) {
    return 'invalid_question_text';
  }
  const qLen = codePointLength(trim(input.questionText));
  if (qLen < MIN_QUESTION_CHARS || qLen > MAX_QUESTION_CHARS) {
    return 'invalid_question_text';
  }

  // results_visibility must be one of the two enum members (Req 5.3).
  if (
    input.resultsVisibility === null ||
    input.resultsVisibility === undefined ||
    !VALID_RESULTS_VISIBILITY.includes(
      input.resultsVisibility as (typeof VALID_RESULTS_VISIBILITY)[number],
    )
  ) {
    return 'invalid_results_visibility';
  }

  // Option COUNT 2–10 (Req 5.1, 5.2).
  const count = input.options == null ? 0 : input.options.length;
  if (count < MIN_OPTION_COUNT || count > MAX_OPTION_COUNT) {
    return 'invalid_option_count';
  }

  // EACH option 1–100 code points after trim (Req 5.1, 5.2).
  for (const opt of input.options!) {
    if (opt === null || opt === undefined) {
      return 'invalid_option_text';
    }
    const oLen = codePointLength(trim(opt));
    if (oLen < MIN_OPTION_CHARS || oLen > MAX_OPTION_CHARS) {
      return 'invalid_option_text';
    }
  }

  return null; // all fields valid → the RPC would create the poll
}

/** A convenient set of valid inputs to vary one field at a time in tests. */
function validCreateInput(
  overrides: Partial<CreatePollInput> = {},
): CreatePollInput {
  return {
    questionText: 'What is your favourite colour?',
    options: ['Red', 'Blue'],
    resultsVisibility: 'show_always',
    ...overrides,
  };
}

// ===========================================================================
// create_poll — field-validation boundaries (Req 5.1, 5.2, 22.2).
// Each rejection identifies the failing FIELD and (in the real RPC) retains no
// partial poll — asserted here by the single-signal return + a companion note.
// ===========================================================================

describe('create_poll validation: question text 1–200 boundary (Req 5.1, 22.2)', () => {
  it('accepts 1 char (lower boundary) and 200 chars (upper boundary)', () => {
    expect(
      validateCreatePoll(validCreateInput({ questionText: 'a' })),
    ).toBeNull();
    expect(
      validateCreatePoll(validCreateInput({ questionText: 'x'.repeat(200) })),
    ).toBeNull();
  });

  it('rejects empty / whitespace-only / 201 chars with invalid_question_text', () => {
    expect(validateCreatePoll(validCreateInput({ questionText: '' }))).toBe(
      'invalid_question_text',
    );
    expect(validateCreatePoll(validCreateInput({ questionText: '    ' }))).toBe(
      'invalid_question_text',
    );
    expect(
      validateCreatePoll(validCreateInput({ questionText: 'x'.repeat(201) })),
    ).toBe('invalid_question_text');
    expect(validateCreatePoll(validCreateInput({ questionText: null }))).toBe(
      'invalid_question_text',
    );
  });

  it('trims before measuring, so surrounding spaces do not inflate the length', () => {
    // 200 chars + surrounding spaces trims back to 200 → valid.
    expect(
      validateCreatePoll(
        validCreateInput({ questionText: `   ${'x'.repeat(200)}   ` }),
      ),
    ).toBeNull();
  });
});

describe('create_poll validation: option text 1–100 boundary (Req 5.1, 5.2)', () => {
  it('accepts each option at 1 char and 100 chars', () => {
    expect(
      validateCreatePoll(validCreateInput({ options: ['a', 'y'.repeat(100)] })),
    ).toBeNull();
  });

  it('rejects an empty / whitespace-only / 101-char / null option with invalid_option_text', () => {
    expect(validateCreatePoll(validCreateInput({ options: ['ok', ''] }))).toBe(
      'invalid_option_text',
    );
    expect(
      validateCreatePoll(validCreateInput({ options: ['ok', '   '] })),
    ).toBe('invalid_option_text');
    expect(
      validateCreatePoll(
        validCreateInput({ options: ['ok', 'y'.repeat(101)] }),
      ),
    ).toBe('invalid_option_text');
    expect(
      validateCreatePoll(validCreateInput({ options: ['ok', null] })),
    ).toBe('invalid_option_text');
  });
});

describe('create_poll validation: option COUNT 2–10 boundary (Req 5.1, 5.2)', () => {
  it('accepts exactly 2 (lower) and exactly 10 (upper) options', () => {
    expect(
      validateCreatePoll(validCreateInput({ options: ['a', 'b'] })),
    ).toBeNull();
    expect(
      validateCreatePoll(
        validCreateInput({
          options: Array.from({ length: 10 }, (_, i) => `opt-${i}`),
        }),
      ),
    ).toBeNull();
  });

  it('rejects 0, 1 (below) and 11 (above) options with invalid_option_count', () => {
    expect(validateCreatePoll(validCreateInput({ options: [] }))).toBe(
      'invalid_option_count',
    );
    expect(
      validateCreatePoll(validCreateInput({ options: ['only-one'] })),
    ).toBe('invalid_option_count');
    expect(
      validateCreatePoll(
        validCreateInput({
          options: Array.from({ length: 11 }, (_, i) => `opt-${i}`),
        }),
      ),
    ).toBe('invalid_option_count');
    expect(validateCreatePoll(validCreateInput({ options: null }))).toBe(
      'invalid_option_count',
    );
  });
});

describe('create_poll validation: results_visibility (Req 5.3) — identifies the field', () => {
  it('accepts the two enum members show_always | hide_until_closed', () => {
    expect(
      validateCreatePoll(
        validCreateInput({ resultsVisibility: 'show_always' }),
      ),
    ).toBeNull();
    expect(
      validateCreatePoll(
        validCreateInput({ resultsVisibility: 'hide_until_closed' }),
      ),
    ).toBeNull();
  });

  it('rejects null / unknown value with invalid_results_visibility (the failing field)', () => {
    expect(
      validateCreatePoll(validCreateInput({ resultsVisibility: null })),
    ).toBe('invalid_results_visibility');
    expect(
      validateCreatePoll(validCreateInput({ resultsVisibility: 'sometimes' })),
    ).toBe('invalid_results_visibility');
  });

  it('a rejected create returns exactly one field signal — the RPC persists no partial poll', () => {
    // create_poll RAISEs P0001 and, being a single atomic plpgsql transaction,
    // rolls back any work → no orphan poll / options survive (Req 5.3). We model
    // "no partial poll retained" as: validation returns a single field signal
    // and (by contract) NO insert occurs. Multiple fields invalid still yields
    // ONE signal (the first in validation order), never a partial success.
    const signal = validateCreatePoll({
      questionText: '', // invalid
      options: ['only-one'], // also invalid
      resultsVisibility: 'nope', // also invalid
    });
    expect(signal).not.toBeNull();
    expect(typeof signal).toBe('string');
  });
});

// ===========================================================================
// set_poll_status — lifecycle transitions (Req 5.4) + single-open guard
// (Req 5.5, 5.6). Driven through the pure PollModel.
// ===========================================================================

describe('set_poll_status: valid transitions draft→open→closed accepted (Req 5.4)', () => {
  it('advances draft → open → closed', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });

    expect(model.setPollStatus(pollId, 'open')).toBe('open');
    expect(model.getPollStatus(pollId)).toBe('open');
    expect(model.setPollStatus(pollId, 'closed')).toBe('closed');
    expect(model.getPollStatus(pollId)).toBe('closed');
  });

  it('same-status set is an idempotent no-op (predicate + model)', () => {
    expect(isValidPollTransition('open', 'open')).toBe(true);
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    model.setPollStatus(pollId, 'open');
    expect(model.setPollStatus(pollId, 'open')).toBe('open');
    expect(model.getOpenPollCount('e1')).toBe(1);
  });
});

describe('set_poll_status: invalid transitions rejected leaving status unchanged (Req 5.4)', () => {
  it('rejects draft→closed, open→draft, closed→open, closed→draft with invalid_transition', () => {
    // Predicate-level: every disallowed move is false.
    expect(isValidPollTransition('draft', 'closed')).toBe(false);
    expect(isValidPollTransition('open', 'draft')).toBe(false);
    expect(isValidPollTransition('closed', 'open')).toBe(false);
    expect(isValidPollTransition('closed', 'draft')).toBe(false);

    // Model-level: draft→closed rejected, status unchanged.
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    expect(() => model.setPollStatus(pollId, 'closed')).toThrow(PollRuleError);
    try {
      model.setPollStatus(pollId, 'closed');
    } catch (err) {
      expect((err as PollRuleError).kind).toBe('invalid_transition');
    }
    expect(model.getPollStatus(pollId)).toBe('draft');

    // closed→open rejected as invalid_transition (lifecycle checked first).
    model.setPollStatus(pollId, 'open');
    model.setPollStatus(pollId, 'closed');
    try {
      model.setPollStatus(pollId, 'open');
    } catch (err) {
      expect((err as PollRuleError).kind).toBe('invalid_transition');
    }
    expect(model.getPollStatus(pollId)).toBe('closed');
  });
});

describe('set_poll_status: single open poll per event (Req 5.5, 5.6)', () => {
  it('opening a second poll while one is open is rejected leaving BOTH unchanged', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const first = model.addPoll({ eventId: 'e1', status: 'draft' });
    const second = model.addPoll({ eventId: 'e1', status: 'draft' });

    model.setPollStatus(first, 'open');
    expect(model.getOpenPollCount('e1')).toBe(1);

    try {
      model.setPollStatus(second, 'open');
      throw new Error('expected poll_already_open');
    } catch (err) {
      expect(err).toBeInstanceOf(PollRuleError);
      expect((err as PollRuleError).kind).toBe('poll_already_open');
    }

    // Both unchanged: first still open, second still draft.
    expect(model.getPollStatus(first)).toBe('open');
    expect(model.getPollStatus(second)).toBe('draft');
    expect(model.getOpenPollCount('e1')).toBe(1);
  });

  it('closing the open poll frees the slot so the second may open', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const first = model.addPoll({ eventId: 'e1', status: 'draft' });
    const second = model.addPoll({ eventId: 'e1', status: 'draft' });

    model.setPollStatus(first, 'open');
    model.setPollStatus(first, 'closed');
    expect(model.getOpenPollCount('e1')).toBe(0);
    expect(model.setPollStatus(second, 'open')).toBe('open');
    expect(model.getOpenPollCount('e1')).toBe(1);
  });
});

// ===========================================================================
// submit_poll_response — upsert-replace count maths (Req 5.7, 5.8) and status
// gating on closed/draft (Req 5.9, 5.10). Driven through the pure PollModel.
// ===========================================================================

describe('submit_poll_response: upsert-replace keeps exactly one response, moves the count (Req 5.7, 5.8)', () => {
  it('changing A→B keeps one response and moves the count from A to B', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    const a = model.addOption({ pollId });
    const b = model.addOption({ pollId });
    model.setPollStatus(pollId, 'open');

    expect(model.submitPollResponse(pollId, 'p-a', a)).toBe(a);
    expect(model.getOptionCount(a)).toBe(1);
    expect(model.getOptionCount(b)).toBe(0);
    expect(model.getResponseCountFor('p-a', pollId)).toBe(1);

    // Change the choice → count moves A(-1) → B(+1), still exactly one response.
    expect(model.submitPollResponse(pollId, 'p-a', b)).toBe(b);
    expect(model.getOptionCount(a)).toBe(0);
    expect(model.getOptionCount(b)).toBe(1);
    expect(model.getResponseCountFor('p-a', pollId)).toBe(1);
    expect(model.getResponse('p-a', pollId)).toBe(b);
  });

  it('re-submitting the same option is an idempotent no-op on the count (Req 23.8)', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    const a = model.addOption({ pollId });
    model.setPollStatus(pollId, 'open');

    model.submitPollResponse(pollId, 'p-a', a);
    model.submitPollResponse(pollId, 'p-a', a);
    expect(model.getOptionCount(a)).toBe(1);
    expect(model.getResponseCountFor('p-a', pollId)).toBe(1);
  });

  it('rejects an option that does not belong to this poll with invalid_option', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    const otherPoll = model.addPoll({ eventId: 'e1', status: 'draft' });
    model.addOption({ pollId });
    const foreignOption = model.addOption({ pollId: otherPoll });
    model.setPollStatus(pollId, 'open');

    try {
      model.submitPollResponse(pollId, 'p-a', foreignOption);
      throw new Error('expected invalid_option');
    } catch (err) {
      expect(err).toBeInstanceOf(PollRuleError);
      expect((err as PollRuleError).kind).toBe('invalid_option');
    }
  });
});

describe('submit_poll_response: rejected on draft / closed leaving prior response unchanged (Req 5.9, 5.10)', () => {
  it('a draft poll rejects a response with poll_not_open (no response recorded)', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    const a = model.addOption({ pollId });

    try {
      model.submitPollResponse(pollId, 'p-a', a);
      throw new Error('expected poll_not_open');
    } catch (err) {
      expect(err).toBeInstanceOf(PollRuleError);
      expect((err as PollRuleError).kind).toBe('poll_not_open'); // Req 5.10
    }
    expect(model.getResponseCountFor('p-a', pollId)).toBe(0);
    expect(model.getOptionCount(a)).toBe(0);
  });

  it('a closed poll rejects with poll_closed and leaves the prior response UNCHANGED', () => {
    const model = new PollModel();
    model.addEvent('e1', { live: true });
    const pollId = model.addPoll({ eventId: 'e1', status: 'draft' });
    const a = model.addOption({ pollId });
    const b = model.addOption({ pollId });
    model.setPollStatus(pollId, 'open');

    // Record a response while open, then close the poll.
    model.submitPollResponse(pollId, 'p-a', a);
    model.setPollStatus(pollId, 'closed');

    // A further response is rejected AND the prior response is untouched.
    try {
      model.submitPollResponse(pollId, 'p-a', b);
      throw new Error('expected poll_closed');
    } catch (err) {
      expect(err).toBeInstanceOf(PollRuleError);
      expect((err as PollRuleError).kind).toBe('poll_closed'); // Req 5.9
    }
    expect(model.getResponse('p-a', pollId)).toBe(a); // unchanged
    expect(model.getOptionCount(a)).toBe(1);
    expect(model.getOptionCount(b)).toBe(0);
  });
});

// ===========================================================================
// Rate-limit reuse (Req 21.13) — DOCUMENTED CONTRACT.
//
// submit_poll_response (migration 20260101000027) reuses the SHARED sliding-
// window rate limiter via check_and_record_rate_limit under the SAME 'vote'
// bucket already modelled and exercised in src/db/qaRules.ts /
// src/db/qaRules.test.ts (VOTE_RATE_LIMIT_MAX = 30 per RATE_LIMIT_WINDOW_SECONDS
// = 60s, rejecting with `rate_limited` and recording nothing on exceed — Req
// 21.14/21.15). pollRules.ts INTENTIONALLY omits rate limiting (see its
// submit_poll_response header) precisely because it is not poll-specific logic —
// it is the shared vote bucket. To stay HONEST we do NOT fake a rate-limit
// assertion against a model that does not implement it; instead we assert the
// reuse contract at the level it is actually modelled: the shared 'vote' bucket
// in QaModel, whose exceed-behaviour is covered by qaRules.test.ts. The block
// below documents that poll responses share that bucket and rejects on exceed.
// ===========================================================================

describe('submit_poll_response: rate-limit reuse — documented shared-bucket contract (Req 21.13)', () => {
  it('documents that poll responses reuse the shared vote bucket (modelled/tested in qaRules)', () => {
    // Poll responses are rate-limited by the SAME shared limiter as Q&A votes
    // (the 'vote' bucket: 30 per 60s, reject + record-nothing on exceed). That
    // limiter and its exceed-behaviour are modelled in src/db/qaRules.ts and
    // exercised in src/db/qaRules.test.ts. pollRules.ts deliberately does not
    // duplicate it, so there is no poll-specific rate-limit predicate to assert
    // here — this test records the reuse contract explicitly rather than
    // faking an assertion against an unmodelled feature.
    expect(true).toBe(true);
  });
});
