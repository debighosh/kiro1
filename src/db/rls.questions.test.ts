/**
 * Task 12.3 — `questions` + `question_votes` Row Level Security (RLS) behaviour tests.
 *
 * WHAT THESE TESTS DO
 * -------------------
 * These are INTEGRATION tests that exercise the LIVE RLS behaviour of the
 * `questions` table (supabase/migrations/20260101000011_questions_rls.sql) and
 * the `question_votes` table (supabase/migrations/20260101000012_question_votes_rls.sql)
 * against a REAL Supabase project. They mirror the structure and env-gating of
 * src/db/rls.events.test.ts (Tasks 5.3/5.4) and cover the following guarantees
 * from the design (Design → RLS Design → `questions` / `question_votes`
 * per-table policies):
 *
 *   1. Anonymous QUESTION VISIBILITY on a LIVE event (Req 3.9, 3.10):
 *      Using the `anon` key client, a `SELECT` over `questions` for a live event
 *      returns the audience-visible rows (`approved`, `featured`, and — per the
 *      questions RLS DECISION note — `answered`) but NEVER `pending` or
 *      `hidden`. The anon policy is
 *      `USING (event_is_live(event_id) AND status IN ('approved','featured','answered'))`,
 *      so the security-critical invariant is that the returned status set
 *      EXCLUDES `pending` and `hidden`.
 *
 *   2. Anonymous QUESTION VISIBILITY on a NON-LIVE event (Req 3.9, gating via
 *      `event_is_live`): an `approved` question on a `draft`/`ended` event is
 *      NEVER returned to anon, because the anon policy also requires
 *      `event_is_live(event_id)`.
 *
 *   3. Raw VOTE ROWS are not client-readable (Req 8.6): `question_votes` has RLS
 *      enabled with NO client SELECT policy (default deny), so an `anon`
 *      `SELECT` returns no rows (and/or is rejected). Raw vote rows carry
 *      `participant_identifier` and must never be exposed to clients; counts are
 *      read from `questions.vote_count`.
 *
 *   4. DUPLICATE-VOTE prevention (Req 4.3, 4.4): the DB-level UNIQUE constraint
 *      `uq_question_votes_participant_question` on
 *      `(participant_identifier, question_id)` rejects a second vote by the same
 *      participant on the same question. This is asserted directly against the
 *      constraint using the SERVICE-ROLE client (which bypasses RLS): a first
 *      insert succeeds, a second insert with the SAME
 *      `(participant_identifier, question_id)` FAILS. (The vote RPC path that
 *      relies on this constraint is separately unit/property-tested — Tasks
 *      13.5/13.6.)
 *
 * WHY THESE ARE ENV-GATED INTEGRATION TESTS (AND SKIP HERE)
 * --------------------------------------------------------
 * A faithful RLS test requires a REAL Supabase instance: PostgreSQL with RLS
 * enabled AND the `anon` / `authenticated` / service roles wired to JWT-scoped
 * clients, plus the `event_is_live(uuid)` SECURITY DEFINER predicate and the
 * `uq_question_votes_participant_question` UNIQUE constraint. That behaviour
 * cannot be emulated locally in this sandbox — there is no local Postgres and no
 * containerised Supabase stack (RLS + role JWTs) that can be reliably started
 * from the test runner. This mirrors the precedent established by
 * src/db/rls.events.test.ts (and documented in src/db/migrations.test.ts for
 * Task 4.7): live RLS/constraint behaviour is verified in CI, not locally.
 *
 * Therefore this suite is GATED on environment variables that point at a real
 * TEST Supabase project and SKIPS cleanly (with a clear message) when they are
 * absent — as in this DB-less sandbox. In CI (or locally) against a real test
 * project the same file RUNS fully. It never fake-passes: with no live DB it
 * skips, it does not assert against a stub.
 *
 * DIVISION OF RESPONSIBILITY WITH THE STATIC SCHEMA GUARD
 * -------------------------------------------------------
 * The static schema guard (src/db/migrations.test.ts) verifies STRUCTURE — the
 * migrations build the schema from scratch and declare the expected columns,
 * constraints (incl. the vote UNIQUE constraint) and RLS SQL. THIS file
 * verifies live RLS + constraint BEHAVIOUR against a real instance in CI. The
 * two are complementary.
 *
 * HOW TO RUN THESE TESTS
 * ----------------------
 * Set the following environment variables to a REAL, disposable TEST Supabase
 * project (never production), then run `npm test`:
 *   - TEST_SUPABASE_URL              — project URL (https://<ref>.supabase.co)
 *   - TEST_SUPABASE_ANON_KEY         — the public anon key (RLS-gated)
 *   - TEST_SUPABASE_SERVICE_ROLE_KEY — the service role key (seeding/cleanup +
 *                                      privileged re-reads/constraint test;
 *                                      BYPASSES RLS)
 * The service role key is a SECRET and is used ONLY here in test/CI context;
 * it is never referenced by application/browser code.
 *
 * Design ref: RLS Design → `questions` per-table policies; `question_votes`
 * per-table policies; General policy strategy (`event_is_live` helper);
 * DB-layer uniqueness.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Read a (possibly server-only) test env var. These tests run under Node via
 * Vitest, so `globalThis.process.env` is the source. Non-`VITE_` names are used
 * on purpose so these secrets never leak into the browser bundle.
 */
function readTestEnv(name: string): string | undefined {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  const value = proc?.env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

const TEST_SUPABASE_URL = readTestEnv('TEST_SUPABASE_URL');
const TEST_SUPABASE_ANON_KEY = readTestEnv('TEST_SUPABASE_ANON_KEY');
const TEST_SUPABASE_SERVICE_ROLE_KEY = readTestEnv(
  'TEST_SUPABASE_SERVICE_ROLE_KEY',
);

/**
 * The suite only runs when a full, real TEST Supabase configuration is present.
 * All three keys are required: anon (to exercise the policies), service role
 * (to seed fixtures, assert final DB state and drive the constraint test), and
 * the URL.
 */
const hasLiveSupabase =
  TEST_SUPABASE_URL !== undefined &&
  TEST_SUPABASE_ANON_KEY !== undefined &&
  TEST_SUPABASE_SERVICE_ROLE_KEY !== undefined;

if (!hasLiveSupabase) {
  // Visible, explicit reason so a skipped run is never mistaken for a pass over
  // real RLS. (Vitest also reports the suite as skipped via describe.skipIf.)
  console.info(
    '[rls.questions.test] SKIPPING live `questions`/`question_votes` RLS integration tests ' +
      '(Task 12.3): set TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY and ' +
      'TEST_SUPABASE_SERVICE_ROLE_KEY to a real TEST Supabase project to run them. This ' +
      'sandbox has no Postgres/RLS, so they skip here (same precedent as ' +
      'src/db/rls.events.test.ts); the static schema guard (src/db/migrations.test.ts) ' +
      'covers structure and these cover live RLS/constraint behaviour in CI.',
  );
}

/** The five question statuses we seed on the LIVE event, one row each. */
type QuestionStatus =
  'pending' | 'approved' | 'featured' | 'answered' | 'hidden';
const ALL_STATUSES: readonly QuestionStatus[] = [
  'pending',
  'approved',
  'featured',
  'answered',
  'hidden',
];

/**
 * Statuses the anon policy EXCLUDES on a live event — these must NEVER appear in
 * an anonymous SELECT result (Req 3.9 pending, 3.10 hidden).
 */
const ANON_HIDDEN_STATUSES: readonly QuestionStatus[] = ['pending', 'hidden'];

/**
 * Statuses the anon policy ADMITS on a live event, per the questions RLS
 * DECISION note: approved/featured/answered.
 */
const ANON_VISIBLE_STATUSES: readonly QuestionStatus[] = [
  'approved',
  'featured',
  'answered',
];

/**
 * Generate a >=32-char alphanumeric presenter token that satisfies the
 * `events_presenter_token_chk` constraint (Req 7.3). Uniqueness is required by
 * the UNIQUE constraint, so we mix in randomness.
 */
function makePresenterToken(): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  while (token.length < 40) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return token;
}

/** A run-unique tag so fixtures never collide with other data / parallel runs. */
const RUN_TAG = `rls-q-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface SeededEventRow {
  readonly name: string;
  readonly status: 'draft' | 'live' | 'ended' | 'archived';
  readonly starts_at: string;
  readonly ends_at: string;
  readonly presenter_token: string;
}

/** Build an event fixture row with valid fields for a given lifecycle status. */
function buildEvent(
  status: SeededEventRow['status'],
  label: string,
): SeededEventRow {
  const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h ahead
  return {
    name: `${RUN_TAG} ${label}`,
    status,
    starts_at: startsAt,
    ends_at: endsAt,
    presenter_token: makePresenterToken(),
  };
}

// describe.skipIf keeps the suite in the report as SKIPPED (not failed / not
// silently absent) when the live config is missing.
describe.skipIf(!hasLiveSupabase)(
  'questions + question_votes RLS behaviour (live Supabase integration)',
  () => {
    // Non-null asserted: this block only runs when hasLiveSupabase is true.
    const url = TEST_SUPABASE_URL!;
    const anonKey = TEST_SUPABASE_ANON_KEY!;
    const serviceKey = TEST_SUPABASE_SERVICE_ROLE_KEY!;

    /** Service-role client — BYPASSES RLS. Used for seeding, cleanup and re-reads. */
    let admin: SupabaseClient;
    /** Anonymous client — subject under test; RLS applies. */
    let anon: SupabaseClient;

    /** The seeded LIVE event id (holds one question per status). */
    let liveEventId: string;
    /** A seeded NON-LIVE (draft) event id (holds one approved question). */
    let draftEventId: string;

    /** Question ids on the live event, keyed by status. */
    const liveQuestionIds: Partial<Record<QuestionStatus, string>> = {};
    /** The approved question id on the non-live (draft) event. */
    let draftApprovedQuestionId: string;

    /** A vote row seeded on the live approved question (raw-read + duplicate test). */
    let seededVoteId: string;
    const VOTER_IDENTIFIER = `${RUN_TAG}-participant-A`;

    beforeAll(async () => {
      admin = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      anon = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // --- Seed events (service role bypasses RLS) -------------------------
      const { data: events, error: eventsError } = await admin
        .from('events')
        .insert([
          buildEvent('live', 'live-event'),
          buildEvent('draft', 'draft-event'),
        ])
        .select('id, status');
      if (eventsError) {
        throw new Error(
          `Failed to seed events fixtures: ${eventsError.message}`,
        );
      }
      for (const row of events ?? []) {
        if (row.status === 'live') liveEventId = row.id as string;
        if (row.status === 'draft') draftEventId = row.id as string;
      }
      if (!liveEventId || !draftEventId) {
        throw new Error(
          'Seeding did not produce both the live and draft event rows',
        );
      }

      // --- Seed one question per status on the LIVE event ------------------
      const liveQuestions = ALL_STATUSES.map((status) => ({
        event_id: liveEventId,
        text: `${RUN_TAG} live ${status} question`,
        status,
      }));
      const { data: qRows, error: qError } = await admin
        .from('questions')
        .insert(liveQuestions)
        .select('id, status');
      if (qError) {
        throw new Error(
          `Failed to seed live-event questions: ${qError.message}`,
        );
      }
      for (const row of qRows ?? []) {
        liveQuestionIds[row.status as QuestionStatus] = row.id as string;
      }
      for (const status of ALL_STATUSES) {
        if (!liveQuestionIds[status]) {
          throw new Error(
            `Seeding did not produce a live "${status}" question row`,
          );
        }
      }

      // --- Seed an APPROVED question on the NON-LIVE (draft) event ---------
      const { data: draftQ, error: draftQError } = await admin
        .from('questions')
        .insert({
          event_id: draftEventId,
          text: `${RUN_TAG} draft approved question`,
          status: 'approved',
        })
        .select('id')
        .single();
      if (draftQError || !draftQ) {
        throw new Error(
          `Failed to seed the draft-event approved question: ${draftQError?.message ?? 'no row'}`,
        );
      }
      draftApprovedQuestionId = draftQ.id as string;

      // --- Seed a single vote row on the live approved question -----------
      // Used to (a) prove anon cannot read raw vote rows and (b) provide the
      // existing (participant, question) pair for the duplicate-vote test.
      const { data: voteRow, error: voteError } = await admin
        .from('question_votes')
        .insert({
          question_id: liveQuestionIds.approved!,
          event_id: liveEventId,
          participant_identifier: VOTER_IDENTIFIER,
        })
        .select('id')
        .single();
      if (voteError || !voteRow) {
        throw new Error(
          `Failed to seed the vote row: ${voteError?.message ?? 'no row'}`,
        );
      }
      seededVoteId = voteRow.id as string;
    });

    afterAll(async () => {
      // Remove only the rows this run created (service role bypasses RLS).
      // Deleting the events cascades to their questions and votes (ON DELETE
      // CASCADE), but we delete votes/questions first to be explicit and to
      // tolerate any partial-seed failure.
      if (admin) {
        const eventIds = [liveEventId, draftEventId].filter(
          (id): id is string => Boolean(id),
        );
        if (eventIds.length > 0) {
          await admin.from('question_votes').delete().in('event_id', eventIds);
          await admin.from('questions').delete().in('event_id', eventIds);
          await admin.from('events').delete().in('id', eventIds);
        }
      }
    });

    // -------------------------------------------------------------------------
    // Anonymous question visibility on a LIVE event (Req 3.9, 3.10)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on questions (live event)', () => {
      it('never returns pending or hidden questions to anon (Req 3.9, 3.10)', async () => {
        const allLiveIds = ALL_STATUSES.map((s) => liveQuestionIds[s]!);
        const { data, error } = await anon
          .from('questions')
          .select('id, status')
          .in('id', allLiveIds);

        expect(error).toBeNull();
        const returnedStatuses = new Set(
          (data ?? []).map((r) => r.status as QuestionStatus),
        );
        // Security-critical invariant: pending/hidden are NEVER visible to anon.
        for (const forbidden of ANON_HIDDEN_STATUSES) {
          expect(returnedStatuses.has(forbidden)).toBe(false);
        }
      });

      it('returns approved/featured/answered questions to anon (Req 3.9, 3.10)', async () => {
        const allLiveIds = ALL_STATUSES.map((s) => liveQuestionIds[s]!);
        const { data, error } = await anon
          .from('questions')
          .select('id, status')
          .in('id', allLiveIds);

        expect(error).toBeNull();
        const returnedStatuses = new Set(
          (data ?? []).map((r) => r.status as QuestionStatus),
        );
        // The visible set is exactly approved/featured/answered (per the anon
        // policy USING list) — and nothing else.
        expect([...returnedStatuses].sort()).toEqual(
          [...ANON_VISIBLE_STATUSES].sort(),
        );
      });

      it.each(ANON_HIDDEN_STATUSES)(
        'hides the %s question from anon by direct id lookup (zero rows)',
        async (status) => {
          const targetId = liveQuestionIds[status]!;
          const { data, error } = await anon
            .from('questions')
            .select('id, status')
            .eq('id', targetId);

          // RLS filters the row out entirely — a filtered SELECT is not an
          // error, it simply returns no rows.
          expect(error).toBeNull();
          expect(data).toEqual([]);
        },
      );
    });

    // -------------------------------------------------------------------------
    // Anonymous question visibility on a NON-LIVE event (Req 3.9 via
    // event_is_live gating)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on questions (non-live event)', () => {
      it('returns nothing for an approved question on a draft event (Req 3.9)', async () => {
        const { data, error } = await anon
          .from('questions')
          .select('id, status')
          .eq('id', draftApprovedQuestionId);

        // Even though the question is `approved`, the parent event is not live,
        // so `event_is_live(event_id)` is false and the anon policy excludes it.
        expect(error).toBeNull();
        expect(data).toEqual([]);
      });
    });

    // -------------------------------------------------------------------------
    // Raw vote rows are not client-readable (Req 8.6)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on question_votes', () => {
      it('cannot read the seeded raw vote row (default deny, Req 8.6)', async () => {
        const { data, error } = await anon
          .from('question_votes')
          .select('id, participant_identifier')
          .eq('id', seededVoteId);

        // question_votes has RLS enabled with NO client SELECT policy, so anon
        // reads are rejected/return nothing. Either way, the raw row (and its
        // participant_identifier) is NEVER exposed.
        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(data ?? []).toEqual([]);
        }
      });

      it('cannot enumerate any votes for the live event (Req 8.6)', async () => {
        const { data, error } = await anon
          .from('question_votes')
          .select('id')
          .eq('event_id', liveEventId);

        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(data ?? []).toEqual([]);
        }
      });
    });

    // -------------------------------------------------------------------------
    // Duplicate-vote prevention via the UNIQUE constraint (Req 4.3, 4.4)
    // -------------------------------------------------------------------------
    describe('duplicate-vote prevention (DB UNIQUE constraint)', () => {
      it('rejects a second vote with the same (participant_identifier, question_id) (Req 4.3, 4.4)', async () => {
        // The first vote for (VOTER_IDENTIFIER, approved question) was already
        // inserted in beforeAll. Attempt a SECOND insert with the SAME pair via
        // the SERVICE-ROLE client (which BYPASSES RLS) so this exercises the DB
        // UNIQUE constraint `uq_question_votes_participant_question` directly —
        // not any RLS policy.
        const { data, error } = await admin
          .from('question_votes')
          .insert({
            question_id: liveQuestionIds.approved!,
            event_id: liveEventId,
            participant_identifier: VOTER_IDENTIFIER,
          })
          .select('id');

        // The duplicate insert must FAIL on the unique constraint and create no
        // new row.
        expect(error).not.toBeNull();
        expect(data ?? []).toEqual([]);

        // Authoritative check via the service role: still exactly ONE vote row
        // for this (participant, question) pair.
        const { data: rows, error: readError } = await admin
          .from('question_votes')
          .select('id')
          .eq('question_id', liveQuestionIds.approved!)
          .eq('participant_identifier', VOTER_IDENTIFIER);
        expect(readError).toBeNull();
        expect(rows ?? []).toHaveLength(1);
      });

      it('allows the same participant to vote on a DIFFERENT question (Req 4.3)', async () => {
        // The UNIQUE constraint is scoped to (participant, question), so the
        // same participant voting a different question is permitted. Insert via
        // service role and clean it up immediately to keep the fixture set tidy.
        const { data, error } = await admin
          .from('question_votes')
          .insert({
            question_id: liveQuestionIds.featured!,
            event_id: liveEventId,
            participant_identifier: VOTER_IDENTIFIER,
          })
          .select('id')
          .single();

        expect(error).toBeNull();
        expect(data).not.toBeNull();

        if (data?.id) {
          await admin
            .from('question_votes')
            .delete()
            .eq('id', data.id as string);
        }
      });
    });
  },
);
