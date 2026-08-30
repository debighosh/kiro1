/**
 * Task 16.3 — Unit tests for moderation authorisation and filtering.
 *
 * These tests exercise the client-side moderation gateway (`src/lib/moderation.ts`)
 * WITHOUT any real network/DB. Both `../lib/auth` (`getSession`) and
 * `../lib/supabaseClient` (`supabase`) are mocked — the real `supabaseClient`
 * throws without `VITE_SUPABASE_*`, and mocking `getSession` lets us drive the
 * authenticated / unauthenticated branches deterministically.
 *
 * Verified behaviours:
 *  - Authorisation (Req 10.5): an anonymous / unauthenticated moderation attempt
 *    is DENIED with NO state change — `moderateQuestion` throws `unauthorized`
 *    and NEVER calls `supabase.functions.invoke`; `readModerationQuestions`
 *    throws `unauthorized` and NEVER calls `supabase.from`.
 *  - Filtering (Req 3.11, 3.12): `filterModerationQuestions` combines
 *    status + category + case-insensitive search text with AND; a `null`
 *    ai_category never matches a non-empty category filter; empty/undefined
 *    criteria are no-ops; input order is preserved and the input is not mutated.
 *  - Moderation routing (Req 21.19, 26.1): for EVERY action in
 *    `MODERATION_ACTIONS` (approve/feature/answer/hide), `moderateQuestion`
 *    routes to the `moderate-question` Edge Function with body
 *    `{ question_id, action }` and returns the parsed success contract.
 *  - Error mapping: a `FunctionsHttpError`-style error whose `context` is a
 *    `Response` with status 401 / 404 / 400 maps to `ModerationError` of kind
 *    `unauthorized` / `not_found` / `validation` respectively.
 *
 * NOTE on the audit_log write (Req 21.19): the `audit_log`
 * `change_type='moderation'` row is written SERVER-SIDE by the `moderate-question`
 * Edge Function (with the service role, bypassing RLS) — there is no live DB in
 * the sandbox, so it cannot be asserted from this unit test. The AUTHORITATIVE
 * audit assertion belongs to the Edge Function's own (env-gated) integration
 * test; the `audit_log` schema + `change_type` CHECK is separately locked down by
 * `src/db/migrations.test.ts`. Here we assert the moderation request is correctly
 * ROUTED to `moderate-question` for every action (which is what triggers that
 * server-side audit write) and that the parsed result surfaces `auditWritten`.
 *
 * Requirements: 3.11, 3.12, 10.5, 21.19, 26.1
 * Design: Components (`ModerationQueue`); RLS Design (`questions` authenticated
 *   SELECT; privileged mutation Edge Functions).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the shared browser client + auth BEFORE importing the SUT. ---
// `vi.mock` is hoisted above imports, so the mock fns are created via
// `vi.hoisted` to be available inside the (also-hoisted) factories.
const { getSessionMock, fromMock, invokeMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  fromMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock('./auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock('./supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

import {
  MODERATE_QUESTION_FUNCTION,
  MODERATION_ACTIONS,
  ModerationError,
  filterModerationQuestions,
  moderateQuestion,
  readModerationQuestions,
  type ModerationAction,
  type ModerationQuestion,
} from './moderation';

const FAKE_SESSION = {
  access_token: 'admin-token',
  user: { id: '11111111-1111-1111-1111-111111111111' },
} as const;

/** Factory for a moderation-queue row with sensible defaults. */
function makeQuestion(
  overrides: Partial<ModerationQuestion> = {},
): ModerationQuestion {
  return {
    id: 'q-1',
    text: 'How does the pricing work?',
    status: 'pending',
    ai_category: null,
    vote_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    event_id: 'e-1',
    ...overrides,
  };
}

/** Builds a chainable questions() query-builder mock ending in .order(). */
function mockQuestionsChain(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => Promise.resolve(result)),
  };
  fromMock.mockReturnValue(chain);
  return chain;
}

/** The Edge Function 200 success contract for a given target status. */
function successPayload(id: string, status: string, previous = 'pending') {
  return {
    data: {
      question: { id, status },
      status,
      previous_status: previous,
      audit_written: true,
    },
    error: null,
  };
}

/** A FunctionsHttpError-style error whose `context` is a `Response`. */
function httpError(status: number, body: unknown) {
  return {
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify(body), { status }),
    },
    data: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Authorisation — anonymous / unauthenticated attempts are denied, NO state
// change (Req 10.5).
// ---------------------------------------------------------------------------
describe('moderateQuestion — authorisation (Req 10.5)', () => {
  it('throws unauthorized and does NOT invoke the Edge Function when there is no session', async () => {
    getSessionMock.mockResolvedValue(null);

    await expect(
      moderateQuestion({ questionId: 'q-1', action: 'approve' }),
    ).rejects.toBeInstanceOf(ModerationError);
    await expect(
      moderateQuestion({ questionId: 'q-1', action: 'approve' }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });

    // No state change: the mutation Edge Function must never be reached.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('throws unauthorized when the session has no access_token (no invoke)', async () => {
    getSessionMock.mockResolvedValue({ access_token: undefined });

    await expect(
      moderateQuestion({ questionId: 'q-1', action: 'hide' }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('readModerationQuestions — authorisation (Req 10.5)', () => {
  it('throws unauthorized and does NOT query when there is no session', async () => {
    getSessionMock.mockResolvedValue(null);

    await expect(readModerationQuestions('e-1')).rejects.toBeInstanceOf(
      ModerationError,
    );
    await expect(readModerationQuestions('e-1')).rejects.toMatchObject({
      kind: 'unauthorized',
    });

    // No read attempted against the questions table.
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('reads the full queue through the authenticated session when signed in', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    const rows = [
      makeQuestion({ id: 'q-1', status: 'pending' }),
      makeQuestion({ id: 'q-2', status: 'hidden' }),
    ];
    const chain = mockQuestionsChain({ data: rows, error: null });

    const result = await readModerationQuestions('e-1');

    expect(fromMock).toHaveBeenCalledWith('questions');
    expect(chain.eq).toHaveBeenCalledWith('event_id', 'e-1');
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(result).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// Filtering — status + category + case-insensitive search combined with AND
// (Req 3.11, 3.12).
// ---------------------------------------------------------------------------
describe('filterModerationQuestions', () => {
  const sample: ModerationQuestion[] = [
    makeQuestion({ id: 'a', status: 'pending', ai_category: 'Pricing', text: 'How much does Pricing cost?' }),
    makeQuestion({ id: 'b', status: 'approved', ai_category: 'Pricing', text: 'Is the PRICING negotiable?' }),
    makeQuestion({ id: 'c', status: 'pending', ai_category: 'Support', text: 'Where is support?' }),
    makeQuestion({ id: 'd', status: 'hidden', ai_category: null, text: 'Uncategorised pricing note' }),
    makeQuestion({ id: 'e', status: 'approved', ai_category: null, text: 'General remark' }),
  ];

  const ids = (rows: ModerationQuestion[]) => rows.map((r) => r.id);

  it('returns all rows for empty/undefined criteria (no-op)', () => {
    expect(ids(filterModerationQuestions(sample))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(filterModerationQuestions(sample, {}))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(
      ids(filterModerationQuestions(sample, { status: undefined, category: undefined, searchText: undefined })),
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('treats a blank/whitespace category or searchText as a no-op', () => {
    expect(ids(filterModerationQuestions(sample, { category: '   ' }))).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ]);
    expect(ids(filterModerationQuestions(sample, { searchText: '   ' }))).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ]);
  });

  it('filters by status only', () => {
    expect(ids(filterModerationQuestions(sample, { status: 'pending' }))).toEqual(['a', 'c']);
    expect(ids(filterModerationQuestions(sample, { status: 'approved' }))).toEqual(['b', 'e']);
    expect(ids(filterModerationQuestions(sample, { status: 'featured' }))).toEqual([]);
  });

  it('filters by category only; a null ai_category never matches a non-empty category', () => {
    expect(ids(filterModerationQuestions(sample, { category: 'Pricing' }))).toEqual(['a', 'b']);
    expect(ids(filterModerationQuestions(sample, { category: 'Support' }))).toEqual(['c']);
    // 'd' and 'e' have ai_category === null → excluded by any non-empty category filter.
    expect(ids(filterModerationQuestions(sample, { category: 'Nonexistent' }))).toEqual([]);
  });

  it('is category case/value exact (does not match null via case-folding)', () => {
    // Category matching is exact equality on the trimmed value, not substring.
    expect(ids(filterModerationQuestions(sample, { category: 'pric' }))).toEqual([]);
  });

  it('filters by case-insensitive substring search on text', () => {
    // 'pricing' matches a/b (mixed case) and d ('pricing note'), regardless of case.
    expect(ids(filterModerationQuestions(sample, { searchText: 'pricing' }))).toEqual(['a', 'b', 'd']);
    expect(ids(filterModerationQuestions(sample, { searchText: 'PRICING' }))).toEqual(['a', 'b', 'd']);
    expect(ids(filterModerationQuestions(sample, { searchText: 'support' }))).toEqual(['c']);
  });

  it('combines status + category + search with AND (narrows correctly)', () => {
    // status=approved AND category=Pricing AND text~'pricing' → only 'b'.
    expect(
      ids(
        filterModerationQuestions(sample, {
          status: 'approved',
          category: 'Pricing',
          searchText: 'pricing',
        }),
      ),
    ).toEqual(['b']);

    // status=pending AND category=Pricing AND text~'pricing' → only 'a'.
    expect(
      ids(
        filterModerationQuestions(sample, {
          status: 'pending',
          category: 'Pricing',
          searchText: 'pricing',
        }),
      ),
    ).toEqual(['a']);

    // AND with a contradictory combination → empty.
    expect(
      ids(
        filterModerationQuestions(sample, {
          status: 'pending',
          category: 'Support',
          searchText: 'pricing',
        }),
      ),
    ).toEqual([]);
  });

  it('preserves input order in the output', () => {
    const reordered: ModerationQuestion[] = [sample[4], sample[0], sample[1]]; // e, a, b
    // category=Pricing keeps a and b, in their input order (a before b).
    expect(ids(filterModerationQuestions(reordered, { category: 'Pricing' }))).toEqual(['a', 'b']);
  });

  it('does not mutate its input array', () => {
    const input = [...sample];
    const snapshot = JSON.parse(JSON.stringify(input));
    filterModerationQuestions(input, { status: 'pending', category: 'Pricing', searchText: 'pricing' });
    expect(input).toHaveLength(snapshot.length);
    expect(input).toEqual(snapshot);
  });

  it('returns a NEW array (not the same reference)', () => {
    expect(filterModerationQuestions(sample)).not.toBe(sample);
  });
});

// ---------------------------------------------------------------------------
// Moderation routing — every action routes to the Edge Function with the
// correct body, triggering the server-side audit_log write (Req 21.19, 26.1).
// ---------------------------------------------------------------------------
describe('moderateQuestion — routing per action (Req 21.19, 26.1)', () => {
  const targetFor: Record<ModerationAction, string> = {
    approve: 'approved',
    feature: 'featured',
    answer: 'answered',
    hide: 'hidden',
  };

  it.each(MODERATION_ACTIONS)(
    "routes action '%s' to the moderate-question function with { question_id, action }",
    async (action) => {
      getSessionMock.mockResolvedValue(FAKE_SESSION);
      const target = targetFor[action];
      invokeMock.mockResolvedValue(successPayload('q-42', target));

      const result = await moderateQuestion({ questionId: 'q-42', action });

      // Correctly ROUTED to the moderate-question Edge Function. That server-side
      // call is what writes the audit_log change_type='moderation' row (verified
      // in the Edge Function's own env-gated integration test — no live DB here).
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(MODERATE_QUESTION_FUNCTION, {
        body: { question_id: 'q-42', action },
      });

      // Success contract is parsed and returned (auditWritten surfaced).
      expect(result).toEqual({
        question: { id: 'q-42', status: target },
        status: target,
        previousStatus: 'pending',
        auditWritten: true,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Error mapping — HTTP status on the Response context maps to the typed kind.
// ---------------------------------------------------------------------------
describe('moderateQuestion — error mapping', () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
  });

  it('maps a 401 response to kind "unauthorized"', async () => {
    invokeMock.mockResolvedValue(
      httpError(401, { error: { code: 'unauthorized', message: 'no' } }),
    );
    await expect(
      moderateQuestion({ questionId: 'q-1', action: 'approve' }),
    ).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });

  it('maps a 404 response to kind "not_found"', async () => {
    invokeMock.mockResolvedValue(
      httpError(404, { error: { code: 'question_not_found', message: 'gone' } }),
    );
    await expect(
      moderateQuestion({ questionId: 'missing', action: 'hide' }),
    ).rejects.toMatchObject({ kind: 'not_found', status: 404 });
  });

  it('maps a 400 response to kind "validation"', async () => {
    invokeMock.mockResolvedValue(
      httpError(400, { error: { code: 'validation_failed', message: 'bad action' } }),
    );
    await expect(
      moderateQuestion({ questionId: 'q-1', action: 'feature' }),
    ).rejects.toMatchObject({ kind: 'validation', status: 400 });
  });
});
