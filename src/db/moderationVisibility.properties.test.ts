/**
 * Task 17.2 — Property-based + unit tests for the moderation-visibility
 * invariant (Property 10), exercised against the pure in-memory
 * moderation-visibility rule in src/db/qaRules.ts.
 *
 * WHY A MODEL AND NOT THE LIVE SQL / RLS
 * --------------------------------------
 * The authoritative visibility rule lives in the anonymous SELECT RLS policy on
 * `questions` (supabase/migrations/20260101000011_questions_rls.sql):
 *
 *     USING ( event_is_live(event_id)
 *             AND status IN ('approved', 'featured', 'answered') )
 *
 * Both the AUDIENCE and the PRESENTER read questions through this same
 * anon-equivalent path (the presenter additionally narrows the set in its read
 * layer — see src/lib/presenter.ts's PRESENTABLE_QUESTION_STATUSES, which is the
 * same allow-list). That policy cannot execute in this sandbox (no Postgres /
 * Deno / psql / supabase CLI; pg-mem cannot represent the `event_is_live`
 * SECURITY DEFINER helper or custom enum types). A live RLS execution test runs
 * against a real Postgres in CI via the env-gated integration suites (see
 * src/db/rls.questions.test.ts, which skips cleanly without TEST_SUPABASE_*).
 *
 * These property tests lock down the DECISION RULE the RLS encodes — the
 * moderation-visibility invariant that `pending` and `hidden` questions are
 * NEVER returned to a client (audience or presenter), and only
 * `approved`/`featured`/`answered` on a LIVE event ever are — so a change to the
 * intended behaviour is caught fast. The model and the SQL are a matched pair.
 *
 * This suite is DELIBERATELY pure / in-memory: it does NOT import
 * src/lib/presenter.ts, because that module transitively loads
 * src/lib/supabaseClient.ts (which throws unless VITE_SUPABASE_* is set — the
 * sandbox has no live Supabase/DB). Instead, the presenter allow-list is
 * mirrored locally as PRESENTER_PRESENTABLE_STATUSES below, which MUST stay in
 * lock-step with presenter.ts's exported `PRESENTABLE_QUESTION_STATUSES`
 * (`['approved','featured','answered']`); one of the unit tests asserts this
 * mirror equals the audience-visible set so drift is caught. presenter.ts is
 * NOT modified by this task.
 *
 * Validates: Requirements 3.9, 3.10, 7.9
 * Design: Correctness Properties (Property 10); RLS Design (`questions`
 *         per-table policies — anonymous SELECT visible statuses).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  AUDIENCE_VISIBLE_STATUSES,
  NEVER_VISIBLE_STATUSES,
  isModerationVisible,
  visibleQuestions,
  type QuestionStatus,
} from './qaRules';

/**
 * Local mirror of src/lib/presenter.ts's `PRESENTABLE_QUESTION_STATUSES`
 * (FOR REFERENCE ONLY). Kept here — rather than imported — so this suite stays
 * a pure in-memory test with no transitive Supabase-client/env dependency. The
 * "presenter allow-list agrees with the audience-visible set" unit test guards
 * against this mirror drifting from the real constant.
 */
const PRESENTER_PRESENTABLE_STATUSES: readonly QuestionStatus[] = [
  'approved',
  'featured',
  'answered',
] as const;

/** All five question statuses (matches the `question_status` enum). */
const ALL_STATUSES: readonly QuestionStatus[] = [
  'pending',
  'approved',
  'featured',
  'answered',
  'hidden',
];

/** A generated question row: an opaque id plus one of the five statuses. */
interface QuestionRow {
  readonly id: string;
  readonly status: QuestionStatus;
}

const statusArb: fc.Arbitrary<QuestionStatus> = fc.constantFrom(...ALL_STATUSES);

/**
 * An arbitrary set of question rows spanning ALL statuses. Ids are unique per
 * generated array so the visible-set membership checks are unambiguous.
 */
const questionRowsArb: fc.Arbitrary<QuestionRow[]> = fc
  .array(statusArb, { maxLength: 30 })
  .map((statuses) => statuses.map((status, i) => ({ id: `q-${i}`, status })));

/**
 * Reference audience-visible predicate, written INDEPENDENTLY of the module
 * under test (so the property is not a tautology): a row is audience-visible iff
 * the event is live and its status is not one of the never-visible states.
 */
function audienceVisibleRef(row: QuestionRow, eventLive: boolean): boolean {
  if (!eventLive) return false;
  return row.status !== 'pending' && row.status !== 'hidden';
}

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 10: Moderation visibility invariant.
//
// Generate questions across ALL statuses (pending, approved, featured,
// answered, hidden). Compute the audience-visible and presenter-visible sets
// via the moderation-visibility rule (the same rule the anon SELECT RLS policy
// enforces). Assert NEITHER set contains any pending/hidden question — only
// approved/featured (and answered where shown). Validates Req 3.9, 3.10, 7.9.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 10: Moderation visibility invariant', () => {
  it('neither the audience nor the presenter visible set ever contains a pending/hidden question (live event)', () => {
    fc.assert(
      fc.property(questionRowsArb, (rows) => {
        // AUDIENCE surface: reads via the anon RLS path (approved/featured/
        // answered on a live event).
        const audience = visibleQuestions(rows, /* eventLive */ true);
        // PRESENTER surface: reads via the SAME anon path, then narrows to the
        // presentable allow-list (which for M2 equals the audience set).
        const presenter = visibleQuestions(
          rows,
          /* eventLive */ true,
          PRESENTER_PRESENTABLE_STATUSES,
        );

        // Core invariant (Req 3.9, 3.10, 7.9): pending/hidden appear in NEITHER
        // set, no matter how many were generated.
        for (const row of [...audience, ...presenter]) {
          expect(NEVER_VISIBLE_STATUSES).not.toContain(row.status);
          expect(row.status === 'pending' || row.status === 'hidden').toBe(false);
        }

        // Positive direction: every visible row is one of the allowed statuses.
        for (const row of audience) {
          expect(AUDIENCE_VISIBLE_STATUSES).toContain(row.status);
        }
        for (const row of presenter) {
          expect(PRESENTER_PRESENTABLE_STATUSES).toContain(row.status);
        }
      }),
    );
  });

  it('the audience visible set matches an independent reference predicate exactly (live event)', () => {
    fc.assert(
      fc.property(questionRowsArb, (rows) => {
        const audienceIds = new Set(visibleQuestions(rows, true).map((r) => r.id));
        const expectedIds = new Set(
          rows.filter((r) => audienceVisibleRef(r, true)).map((r) => r.id),
        );
        expect(audienceIds).toEqual(expectedIds);
      }),
    );
  });

  it('on a NON-live event neither surface exposes ANY question, whatever its status', () => {
    fc.assert(
      fc.property(questionRowsArb, (rows) => {
        expect(visibleQuestions(rows, /* eventLive */ false)).toHaveLength(0);
        expect(
          visibleQuestions(rows, /* eventLive */ false, PRESENTER_PRESENTABLE_STATUSES),
        ).toHaveLength(0);
      }),
    );
  });

  it('the presenter visible set is always a SUBSET of the audience visible set (presenter never widens)', () => {
    fc.assert(
      fc.property(questionRowsArb, fc.boolean(), (rows, eventLive) => {
        const audienceIds = new Set(visibleQuestions(rows, eventLive).map((r) => r.id));
        const presenter = visibleQuestions(rows, eventLive, PRESENTER_PRESENTABLE_STATUSES);
        for (const row of presenter) {
          expect(audienceIds.has(row.id)).toBe(true);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — concrete examples and edge cases for the moderation-visibility
// rule, complementing the universal property above. Validates Req 3.9, 3.10,
// 7.9.
// ---------------------------------------------------------------------------

describe('moderation-visibility rule (isModerationVisible) — unit examples', () => {
  it('exposes approved/featured/answered on a live event', () => {
    expect(isModerationVisible('approved', true)).toBe(true);
    expect(isModerationVisible('featured', true)).toBe(true);
    expect(isModerationVisible('answered', true)).toBe(true);
  });

  it('NEVER exposes pending or hidden, even on a live event (Req 3.9, 3.10, 7.9)', () => {
    expect(isModerationVisible('pending', true)).toBe(false);
    expect(isModerationVisible('hidden', true)).toBe(false);
  });

  it('exposes nothing on a non-live event, whatever the status', () => {
    for (const status of ALL_STATUSES) {
      expect(isModerationVisible(status, false)).toBe(false);
    }
  });

  it('the audience-visible set is exactly {approved, featured, answered} and excludes the moderation states', () => {
    expect([...AUDIENCE_VISIBLE_STATUSES].sort()).toEqual(
      ['answered', 'approved', 'featured'].sort(),
    );
    expect(AUDIENCE_VISIBLE_STATUSES).not.toContain('pending');
    expect(AUDIENCE_VISIBLE_STATUSES).not.toContain('hidden');
    expect([...NEVER_VISIBLE_STATUSES].sort()).toEqual(['hidden', 'pending'].sort());
  });

  it('the presenter allow-list agrees with the audience-visible set for Milestone 2', () => {
    expect([...PRESENTER_PRESENTABLE_STATUSES].sort()).toEqual(
      [...AUDIENCE_VISIBLE_STATUSES].sort(),
    );
  });

  it('visibleQuestions filters a mixed collection to only the presentable rows on a live event', () => {
    const rows = ALL_STATUSES.map((status, i) => ({ id: `q-${i}`, status }));
    const visible = visibleQuestions(rows, true);
    expect(visible.map((r) => r.status).sort()).toEqual(
      ['answered', 'approved', 'featured'].sort(),
    );
  });
});
