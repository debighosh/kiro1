/**
 * Task 20.4 — Poll + Word-Cloud Row Level Security (RLS) behaviour tests.
 *
 * WHAT THESE TESTS DO
 * -------------------
 * These are INTEGRATION tests that exercise the LIVE RLS behaviour of the
 * Milestone-3 poll and word-cloud tables against a REAL Supabase project:
 *   - `polls`                (supabase/migrations/20260101000020_polls_rls.sql)
 *   - `poll_options`         (supabase/migrations/20260101000020_polls_rls.sql)
 *   - `poll_responses`       (supabase/migrations/20260101000021_poll_responses_rls.sql)
 *   - `word_cloud_prompts`   (supabase/migrations/20260101000022_word_cloud_rls.sql)
 *   - `word_cloud_responses` (supabase/migrations/20260101000022_word_cloud_rls.sql)
 *
 * They mirror the structure and env-gating of src/db/rls.questions.test.ts
 * (Task 12.3) and cover the following guarantees from the design (Design → RLS
 * Design → `polls` / `poll_options` / `poll_responses` / `word_cloud_prompts` /
 * `word_cloud_responses` per-table policies):
 *
 *   1. Anonymous POLL VISIBILITY on a LIVE event (Req 5.11): using the `anon`
 *      key client, a `SELECT` over `polls` for a live event returns the
 *      audience-visible rows (`open`, `closed`) but NEVER a `draft` poll. The
 *      anon policy is
 *      `USING (event_is_live(event_id) AND status IN ('open','closed'))`, so
 *      the security-critical invariant is that `draft` is excluded.
 *
 *   2. Anonymous POLL VISIBILITY on a NON-LIVE event (Req 5.11 via
 *      `event_is_live`): an `open` poll on a `draft`/non-live event is NEVER
 *      returned to anon, because the anon policy also requires
 *      `event_is_live(event_id)`.
 *
 *   3. Anonymous POLL_OPTIONS VISIBILITY (Req 5.11): `poll_options` has no
 *      `event_id`, so its anon policy mirrors the parent poll via an EXISTS
 *      subquery — options are returned ONLY for a visible (open/closed,
 *      live-event) poll, never for a draft poll or a poll on a non-live event.
 *
 *   4. Raw POLL_RESPONSES rows are not client-readable (Req 8.6):
 *      `poll_responses` has RLS enabled with NO client SELECT policy (default
 *      deny), so an `anon` `SELECT` returns no rows (and/or is rejected). Raw
 *      response rows carry `participant_identifier` and must never be exposed to
 *      clients; results are read from `poll_options.response_count`.
 *
 *   5. Anonymous PROMPT VISIBILITY (Req 6.13, 7.9): a `SELECT` over
 *      `word_cloud_prompts` for a live event returns `open`/`closed` prompts but
 *      NEVER a `draft` prompt (anon predicate excludes `draft`).
 *
 *   6. Anonymous WORD_CLOUD_RESPONSES VISIBILITY (Req 6.13, 7.9): a `SELECT`
 *      over `word_cloud_responses` on a live event returns non-hidden entries
 *      but NEVER `is_hidden = true` rows. The anon predicate is
 *      `USING (event_is_live(event_id) AND is_hidden = false)`, so hidden
 *      (moderated) entries can never reach the audience/presenter. The read
 *      layer additionally projects away `participant_identifier`.
 *
 *   7. All WRITES are RPC-only (Req 5.11, 6.13, 21.6): every one of these tables
 *      has RLS enabled with NO client INSERT/UPDATE policy, so a direct anon
 *      `INSERT`/`UPDATE` is rejected (error) and affects no rows. Poll/prompt
 *      authoring, response upsert and hide/unhide flow through service-role
 *      RPCs / Edge Functions instead.
 *
 * WHY THESE ARE ENV-GATED INTEGRATION TESTS (AND SKIP HERE)
 * --------------------------------------------------------
 * A faithful RLS test requires a REAL Supabase instance: PostgreSQL with RLS
 * enabled AND the `anon` / `authenticated` / service roles wired to JWT-scoped
 * clients, plus the `event_is_live(uuid)` SECURITY DEFINER predicate. That
 * behaviour cannot be emulated locally in this sandbox — there is no local
 * Postgres and no containerised Supabase stack (RLS + role JWTs) that can be
 * reliably started from the test runner. This mirrors the precedent established
 * by src/db/rls.questions.test.ts (Task 12.3) and src/db/rls.events.test.ts:
 * live RLS behaviour is verified in CI, not locally.
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
 * constraints and RLS SQL. THIS file verifies live RLS BEHAVIOUR against a real
 * instance in CI. The two are complementary.
 *
 * HOW TO RUN THESE TESTS
 * ----------------------
 * Set the following environment variables to a REAL, disposable TEST Supabase
 * project (never production), then run `npm test`:
 *   - TEST_SUPABASE_URL              — project URL (https://<ref>.supabase.co)
 *   - TEST_SUPABASE_ANON_KEY         — the public anon key (RLS-gated)
 *   - TEST_SUPABASE_SERVICE_ROLE_KEY — the service role key (seeding/cleanup;
 *                                      BYPASSES RLS)
 * The service role key is a SECRET and is used ONLY here in test/CI context;
 * it is never referenced by application/browser code.
 *
 * Design ref: RLS Design → `polls`, `poll_options`, `poll_responses`,
 * `word_cloud_prompts`, `word_cloud_responses` per-table policies; General
 * policy strategy (`event_is_live` helper).
 * Requirements: 5.11, 6.13, 7.9, 8.6, 26.1.
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
 * (to seed fixtures and assert final DB state), and the URL.
 */
const hasLiveSupabase =
  TEST_SUPABASE_URL !== undefined &&
  TEST_SUPABASE_ANON_KEY !== undefined &&
  TEST_SUPABASE_SERVICE_ROLE_KEY !== undefined;

if (!hasLiveSupabase) {
  // Visible, explicit reason so a skipped run is never mistaken for a pass over
  // real RLS. (Vitest also reports the suite as skipped via describe.skipIf.)
  console.info(
    '[rls.polls.test] SKIPPING live poll/word-cloud RLS integration tests ' +
      '(Task 20.4): set TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY and ' +
      'TEST_SUPABASE_SERVICE_ROLE_KEY to a real TEST Supabase project to run them. This ' +
      'sandbox has no Postgres/RLS, so they skip here (same precedent as ' +
      'src/db/rls.questions.test.ts); the static schema guard (src/db/migrations.test.ts) ' +
      'covers structure and these cover live RLS behaviour in CI.',
  );
}

/** The three poll statuses we seed on the LIVE event, one poll each. */
type PollStatus = 'draft' | 'open' | 'closed';
const ALL_POLL_STATUSES: readonly PollStatus[] = ['draft', 'open', 'closed'];

/**
 * Poll statuses the anon policy EXCLUDES on a live event — these must NEVER
 * appear in an anonymous SELECT result (Req 5.11: draft polls are never exposed).
 */
const ANON_HIDDEN_POLL_STATUSES: readonly PollStatus[] = ['draft'];

/** Poll statuses the anon policy ADMITS on a live event: open/closed. */
const ANON_VISIBLE_POLL_STATUSES: readonly PollStatus[] = ['open', 'closed'];

/** The three word-cloud prompt statuses we seed on the LIVE event. */
type WordCloudStatus = 'draft' | 'open' | 'closed';
const ALL_WC_STATUSES: readonly WordCloudStatus[] = ['draft', 'open', 'closed'];

/** Prompt statuses excluded from anon reads (Req 6.13, 7.9: draft hidden). */
const ANON_HIDDEN_WC_STATUSES: readonly WordCloudStatus[] = ['draft'];

/** Prompt statuses the anon policy admits on a live event: open/closed. */
const ANON_VISIBLE_WC_STATUSES: readonly WordCloudStatus[] = ['open', 'closed'];

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
const RUN_TAG = `rls-poll-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
  'polls + poll_options + poll_responses + word_cloud RLS behaviour (live Supabase integration)',
  () => {
    // Non-null asserted: this block only runs when hasLiveSupabase is true.
    const url = TEST_SUPABASE_URL!;
    const anonKey = TEST_SUPABASE_ANON_KEY!;
    const serviceKey = TEST_SUPABASE_SERVICE_ROLE_KEY!;

    /** Service-role client — BYPASSES RLS. Used for seeding, cleanup and re-reads. */
    let admin: SupabaseClient;
    /** Anonymous client — subject under test; RLS applies. */
    let anon: SupabaseClient;

    /** The seeded LIVE event id (holds one poll/prompt per status). */
    let liveEventId: string;
    /** A seeded NON-LIVE (draft) event id (holds an open poll + prompt). */
    let draftEventId: string;

    /** Poll ids on the live event, keyed by status. */
    const livePollIds: Partial<Record<PollStatus, string>> = {};
    /** The first option id for each live poll, keyed by poll status. */
    const livePollOptionIds: Partial<Record<PollStatus, string>> = {};
    /** The `open` poll id on the non-live (draft) event. */
    let draftEventOpenPollId: string;
    /** An option id belonging to the `open` poll on the non-live event. */
    let draftEventOpenPollOptionId: string;

    /** A response row seeded on the live open poll (raw-read deny test). */
    let seededPollResponseId: string;

    /** Word-cloud prompt ids on the live event, keyed by status. */
    const liveWcPromptIds: Partial<Record<WordCloudStatus, string>> = {};
    /** The `open` prompt id on the non-live (draft) event. */
    let draftEventOpenPromptId: string;

    /** A visible (non-hidden) and a hidden response on the live open prompt. */
    let liveVisibleWcResponseId: string;
    let liveHiddenWcResponseId: string;

    const PARTICIPANT_A = `${RUN_TAG}-participant-A`;
    const PARTICIPANT_B = `${RUN_TAG}-participant-B`;

    /**
     * Seed a poll with a given status plus TWO options (the 2–10-options
     * constraint trigger requires at least two). Returns the poll id and its
     * first option id.
     */
    async function seedPollWithOptions(
      eventId: string,
      status: PollStatus,
      displayOrder: number,
    ): Promise<{ pollId: string; optionId: string }> {
      const { data: poll, error: pollError } = await admin
        .from('polls')
        .insert({
          event_id: eventId,
          question_text: `${RUN_TAG} ${status} poll question`,
          status,
          display_order: displayOrder,
          results_visibility: 'show_always',
        })
        .select('id')
        .single();
      if (pollError || !poll) {
        throw new Error(
          `Failed to seed ${status} poll: ${pollError?.message ?? 'no row'}`,
        );
      }
      const pollId = poll.id as string;

      const { data: options, error: optionsError } = await admin
        .from('poll_options')
        .insert([
          { poll_id: pollId, text: `${status} option A`, display_order: 1 },
          { poll_id: pollId, text: `${status} option B`, display_order: 2 },
        ])
        .select('id');
      if (optionsError || !options || options.length < 1) {
        throw new Error(
          `Failed to seed options for ${status} poll: ${optionsError?.message ?? 'no rows'}`,
        );
      }
      return { pollId, optionId: options[0].id as string };
    }

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

      // --- Seed one poll (+2 options) per status on the LIVE event ---------
      let order = 1;
      for (const status of ALL_POLL_STATUSES) {
        const { pollId, optionId } = await seedPollWithOptions(
          liveEventId,
          status,
          order++,
        );
        livePollIds[status] = pollId;
        livePollOptionIds[status] = optionId;
      }

      // --- Seed an OPEN poll (+2 options) on the NON-LIVE (draft) event ----
      const draftPoll = await seedPollWithOptions(draftEventId, 'open', 1);
      draftEventOpenPollId = draftPoll.pollId;
      draftEventOpenPollOptionId = draftPoll.optionId;

      // --- Seed a poll response on the LIVE open poll ----------------------
      // Used to prove anon cannot read raw poll_responses rows (default deny).
      const { data: responseRow, error: responseError } = await admin
        .from('poll_responses')
        .insert({
          poll_id: livePollIds.open!,
          event_id: liveEventId,
          option_id: livePollOptionIds.open!,
          participant_identifier: PARTICIPANT_A,
        })
        .select('id')
        .single();
      if (responseError || !responseRow) {
        throw new Error(
          `Failed to seed poll response: ${responseError?.message ?? 'no row'}`,
        );
      }
      seededPollResponseId = responseRow.id as string;

      // --- Seed one word-cloud prompt per status on the LIVE event ---------
      const liveWcPrompts = ALL_WC_STATUSES.map((status) => ({
        event_id: liveEventId,
        prompt_text: `${RUN_TAG} live ${status} prompt`,
        max_words_per_response: 3,
        status,
        results_visible_while_collecting: true,
      }));
      const { data: wcRows, error: wcError } = await admin
        .from('word_cloud_prompts')
        .insert(liveWcPrompts)
        .select('id, status');
      if (wcError) {
        throw new Error(
          `Failed to seed live-event word-cloud prompts: ${wcError.message}`,
        );
      }
      for (const row of wcRows ?? []) {
        liveWcPromptIds[row.status as WordCloudStatus] = row.id as string;
      }
      for (const status of ALL_WC_STATUSES) {
        if (!liveWcPromptIds[status]) {
          throw new Error(
            `Seeding did not produce a live "${status}" word-cloud prompt row`,
          );
        }
      }

      // --- Seed an OPEN prompt on the NON-LIVE (draft) event ---------------
      const { data: draftPrompt, error: draftPromptError } = await admin
        .from('word_cloud_prompts')
        .insert({
          event_id: draftEventId,
          prompt_text: `${RUN_TAG} draft-event open prompt`,
          max_words_per_response: 3,
          status: 'open',
          results_visible_while_collecting: true,
        })
        .select('id')
        .single();
      if (draftPromptError || !draftPrompt) {
        throw new Error(
          `Failed to seed the draft-event open prompt: ${draftPromptError?.message ?? 'no row'}`,
        );
      }
      draftEventOpenPromptId = draftPrompt.id as string;

      // --- Seed a VISIBLE and a HIDDEN word-cloud response on the live -----
      // open prompt. The hidden one must NEVER be returned to anon (Req 6.13).
      const { data: visibleResp, error: visibleErr } = await admin
        .from('word_cloud_responses')
        .insert({
          prompt_id: liveWcPromptIds.open!,
          event_id: liveEventId,
          participant_identifier: PARTICIPANT_A,
          raw_text: 'Innovation',
          normalised_text: 'innovation',
          is_hidden: false,
        })
        .select('id')
        .single();
      if (visibleErr || !visibleResp) {
        throw new Error(
          `Failed to seed the visible word-cloud response: ${visibleErr?.message ?? 'no row'}`,
        );
      }
      liveVisibleWcResponseId = visibleResp.id as string;

      const { data: hiddenResp, error: hiddenErr } = await admin
        .from('word_cloud_responses')
        .insert({
          prompt_id: liveWcPromptIds.open!,
          event_id: liveEventId,
          participant_identifier: PARTICIPANT_B,
          raw_text: 'Moderated',
          normalised_text: 'moderated',
          is_hidden: true,
        })
        .select('id')
        .single();
      if (hiddenErr || !hiddenResp) {
        throw new Error(
          `Failed to seed the hidden word-cloud response: ${hiddenErr?.message ?? 'no row'}`,
        );
      }
      liveHiddenWcResponseId = hiddenResp.id as string;
    });

    afterAll(async () => {
      // Remove only the rows this run created (service role bypasses RLS).
      // Deleting the events cascades to their polls/options/responses and
      // word-cloud prompts/responses (ON DELETE CASCADE), but we delete the
      // child rows first to be explicit and to tolerate any partial-seed
      // failure.
      if (admin) {
        const eventIds = [liveEventId, draftEventId].filter(
          (id): id is string => Boolean(id),
        );
        if (eventIds.length > 0) {
          await admin
            .from('word_cloud_responses')
            .delete()
            .in('event_id', eventIds);
          await admin
            .from('word_cloud_prompts')
            .delete()
            .in('event_id', eventIds);
          await admin.from('poll_responses').delete().in('event_id', eventIds);
          // poll_options have no event_id; they cascade when their polls are
          // deleted. Delete the polls (options cascade), then the events.
          await admin.from('polls').delete().in('event_id', eventIds);
          await admin.from('events').delete().in('id', eventIds);
        }
      }
    });

    // -------------------------------------------------------------------------
    // Anonymous poll visibility on a LIVE event (Req 5.11)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on polls (live event)', () => {
      it('never returns a draft poll to anon (Req 5.11)', async () => {
        const allLiveIds = ALL_POLL_STATUSES.map((s) => livePollIds[s]!);
        const { data, error } = await anon
          .from('polls')
          .select('id, status')
          .in('id', allLiveIds);

        expect(error).toBeNull();
        const returnedStatuses = new Set(
          (data ?? []).map((r) => r.status as PollStatus),
        );
        // Security-critical invariant: draft is NEVER visible to anon.
        for (const forbidden of ANON_HIDDEN_POLL_STATUSES) {
          expect(returnedStatuses.has(forbidden)).toBe(false);
        }
      });

      it('returns exactly the open/closed polls to anon (Req 5.11)', async () => {
        const allLiveIds = ALL_POLL_STATUSES.map((s) => livePollIds[s]!);
        const { data, error } = await anon
          .from('polls')
          .select('id, status')
          .in('id', allLiveIds);

        expect(error).toBeNull();
        const returnedStatuses = new Set(
          (data ?? []).map((r) => r.status as PollStatus),
        );
        expect([...returnedStatuses].sort()).toEqual(
          [...ANON_VISIBLE_POLL_STATUSES].sort(),
        );
      });

      it('hides the draft poll from anon by direct id lookup (zero rows) (Req 5.11)', async () => {
        const { data, error } = await anon
          .from('polls')
          .select('id, status')
          .eq('id', livePollIds.draft!);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });
    });

    // -------------------------------------------------------------------------
    // Anonymous poll visibility on a NON-LIVE event (Req 5.11 via
    // event_is_live gating)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on polls (non-live event)', () => {
      it('returns nothing for an open poll on a draft event (Req 5.11)', async () => {
        const { data, error } = await anon
          .from('polls')
          .select('id, status')
          .eq('id', draftEventOpenPollId);

        // Even though the poll is `open`, the parent event is not live, so
        // `event_is_live(event_id)` is false and the anon policy excludes it.
        expect(error).toBeNull();
        expect(data).toEqual([]);
      });
    });

    // -------------------------------------------------------------------------
    // Anonymous poll_options visibility (Req 5.11)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on poll_options', () => {
      it('returns options for a visible (open) poll on a live event (Req 5.11)', async () => {
        const { data, error } = await anon
          .from('poll_options')
          .select('id, poll_id')
          .eq('poll_id', livePollIds.open!);

        expect(error).toBeNull();
        // The open poll on the live event is audience-visible, so its options
        // are returned (we seeded two).
        expect((data ?? []).length).toBeGreaterThan(0);
      });

      it('never returns options for a draft poll (Req 5.11)', async () => {
        const { data, error } = await anon
          .from('poll_options')
          .select('id, poll_id')
          .eq('poll_id', livePollIds.draft!);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });

      it('never returns options for a poll on a non-live event (Req 5.11)', async () => {
        const { data, error } = await anon
          .from('poll_options')
          .select('id, poll_id')
          .eq('id', draftEventOpenPollOptionId);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });
    });

    // -------------------------------------------------------------------------
    // Raw poll_responses rows are not client-readable (Req 8.6)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on poll_responses', () => {
      it('cannot read the seeded raw response row (default deny, Req 8.6)', async () => {
        const { data, error } = await anon
          .from('poll_responses')
          .select('id, participant_identifier')
          .eq('id', seededPollResponseId);

        // poll_responses has RLS enabled with NO client SELECT policy, so anon
        // reads are rejected/return nothing. Either way, the raw row (and its
        // participant_identifier) is NEVER exposed.
        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(data ?? []).toEqual([]);
        }
      });

      it('cannot enumerate any responses for the live event (Req 8.6)', async () => {
        const { data, error } = await anon
          .from('poll_responses')
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
    // Anonymous word_cloud_prompts visibility on a LIVE event (Req 6.13, 7.9)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on word_cloud_prompts (live event)', () => {
      it('never returns a draft prompt to anon (Req 6.13, 7.9)', async () => {
        const allLiveIds = ALL_WC_STATUSES.map((s) => liveWcPromptIds[s]!);
        const { data, error } = await anon
          .from('word_cloud_prompts')
          .select('id, status')
          .in('id', allLiveIds);

        expect(error).toBeNull();
        const returnedStatuses = new Set(
          (data ?? []).map((r) => r.status as WordCloudStatus),
        );
        for (const forbidden of ANON_HIDDEN_WC_STATUSES) {
          expect(returnedStatuses.has(forbidden)).toBe(false);
        }
      });

      it('returns exactly the open/closed prompts to anon (Req 6.13, 7.9)', async () => {
        const allLiveIds = ALL_WC_STATUSES.map((s) => liveWcPromptIds[s]!);
        const { data, error } = await anon
          .from('word_cloud_prompts')
          .select('id, status')
          .in('id', allLiveIds);

        expect(error).toBeNull();
        const returnedStatuses = new Set(
          (data ?? []).map((r) => r.status as WordCloudStatus),
        );
        expect([...returnedStatuses].sort()).toEqual(
          [...ANON_VISIBLE_WC_STATUSES].sort(),
        );
      });

      it('returns nothing for an open prompt on a draft event (Req 6.13, 7.9)', async () => {
        const { data, error } = await anon
          .from('word_cloud_prompts')
          .select('id, status')
          .eq('id', draftEventOpenPromptId);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });
    });

    // -------------------------------------------------------------------------
    // Anonymous word_cloud_responses visibility (Req 6.13, 7.9)
    // -------------------------------------------------------------------------
    describe('anonymous SELECT on word_cloud_responses', () => {
      it('returns the non-hidden entry for a live event (Req 6.13, 7.9)', async () => {
        const { data, error } = await anon
          .from('word_cloud_responses')
          .select('id, normalised_text, is_hidden')
          .eq('id', liveVisibleWcResponseId);

        expect(error).toBeNull();
        expect((data ?? []).length).toBe(1);
        // The row returned must be the non-hidden one.
        expect((data ?? [])[0]?.is_hidden).toBe(false);
      });

      it('NEVER returns an is_hidden=true entry to anon (Req 6.13, 7.9)', async () => {
        const { data, error } = await anon
          .from('word_cloud_responses')
          .select('id, is_hidden')
          .eq('id', liveHiddenWcResponseId);

        // The hidden response is filtered out at the row level by the anon
        // policy (`is_hidden = false`), so it is never returned.
        expect(error).toBeNull();
        expect(data).toEqual([]);
      });

      it('enumerating the live prompt returns only non-hidden rows (Req 6.13, 7.9)', async () => {
        const { data, error } = await anon
          .from('word_cloud_responses')
          .select('id, is_hidden')
          .eq('prompt_id', liveWcPromptIds.open!);

        expect(error).toBeNull();
        const rows = data ?? [];
        // At least the seeded visible row is present; the hidden one is absent.
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.is_hidden).toBe(false);
        }
        const ids = rows.map((r) => r.id as string);
        expect(ids).not.toContain(liveHiddenWcResponseId);
      });
    });

    // -------------------------------------------------------------------------
    // Writes are RPC-only: anon INSERT/UPDATE is rejected (Req 5.11, 6.13, 21.6)
    // -------------------------------------------------------------------------
    describe('anonymous writes are rejected (RPC-only)', () => {
      /**
       * Assert an anon write neither succeeds nor mutates state: it must return
       * an error and/or affect no rows (a filtered UPDATE that matches nothing
       * yields an empty data set under RLS default-deny).
       */
      function expectWriteRejected(result: {
        data: unknown;
        error: unknown;
      }): void {
        const { data, error } = result;
        if (error === null) {
          // With RLS default-deny and no write policy, a returning write that
          // is not rejected must at least have affected NO rows.
          expect(data ?? []).toEqual([]);
        } else {
          expect(error).not.toBeNull();
        }
      }

      it('rejects an anon INSERT into polls (Req 5.11, 21.6)', async () => {
        const result = await anon
          .from('polls')
          .insert({
            event_id: liveEventId,
            question_text: `${RUN_TAG} anon-inserted poll`,
            status: 'open',
            display_order: 99,
            results_visibility: 'show_always',
          })
          .select('id');
        expectWriteRejected(result);
      });

      it('rejects an anon UPDATE of a poll (Req 5.11, 21.6)', async () => {
        const result = await anon
          .from('polls')
          .update({ question_text: `${RUN_TAG} anon-edited` })
          .eq('id', livePollIds.open!)
          .select('id');
        expectWriteRejected(result);

        // Authoritative re-read via the service role: the poll is unchanged.
        const { data: rows } = await admin
          .from('polls')
          .select('question_text')
          .eq('id', livePollIds.open!);
        expect((rows ?? [])[0]?.question_text).not.toContain('anon-edited');
      });

      it('rejects an anon INSERT into poll_options (Req 5.11, 21.6)', async () => {
        const result = await anon
          .from('poll_options')
          .insert({
            poll_id: livePollIds.open!,
            text: `${RUN_TAG} anon option`,
            display_order: 99,
          })
          .select('id');
        expectWriteRejected(result);
      });

      it('rejects an anon INSERT into poll_responses (Req 8.6, 21.6)', async () => {
        const result = await anon
          .from('poll_responses')
          .insert({
            poll_id: livePollIds.open!,
            event_id: liveEventId,
            option_id: livePollOptionIds.open!,
            participant_identifier: `${RUN_TAG}-anon-writer`,
          })
          .select('id');
        expectWriteRejected(result);
      });

      it('rejects an anon INSERT into word_cloud_prompts (Req 6.13, 21.6)', async () => {
        const result = await anon
          .from('word_cloud_prompts')
          .insert({
            event_id: liveEventId,
            prompt_text: `${RUN_TAG} anon prompt`,
            max_words_per_response: 3,
            status: 'open',
            results_visible_while_collecting: true,
          })
          .select('id');
        expectWriteRejected(result);
      });

      it('rejects an anon UPDATE of a word_cloud_response (unhide attempt) (Req 6.13, 21.6)', async () => {
        // An anon attempt to unhide (is_hidden=false) a moderated entry must be
        // rejected — moderation is service-role only.
        const result = await anon
          .from('word_cloud_responses')
          .update({ is_hidden: false })
          .eq('id', liveHiddenWcResponseId)
          .select('id');
        expectWriteRejected(result);

        // Authoritative re-read via the service role: still hidden.
        const { data: rows } = await admin
          .from('word_cloud_responses')
          .select('is_hidden')
          .eq('id', liveHiddenWcResponseId);
        expect((rows ?? [])[0]?.is_hidden).toBe(true);
      });

      it('rejects an anon INSERT into word_cloud_responses (Req 6.13, 21.6)', async () => {
        const result = await anon
          .from('word_cloud_responses')
          .insert({
            prompt_id: liveWcPromptIds.open!,
            event_id: liveEventId,
            participant_identifier: `${RUN_TAG}-anon-writer`,
            raw_text: 'sneaky',
            normalised_text: 'sneaky',
            is_hidden: false,
          })
          .select('id');
        expectWriteRejected(result);
      });
    });
  },
);
