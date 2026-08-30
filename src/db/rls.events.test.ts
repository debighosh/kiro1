/**
 * Tasks 5.3 & 5.4 — `events` Row Level Security (RLS) behaviour tests.
 *
 * WHAT THESE TESTS DO
 * -------------------
 * These are INTEGRATION tests that exercise the LIVE RLS behaviour of the
 * `events` table (defined in supabase/migrations/20260101000007_events_rls.sql)
 * against a REAL Supabase project. They cover two per-principal guarantees from
 * the design (Design → RLS Design → `events` per-table policies):
 *
 *   Task 5.3 — Anonymous event VISIBILITY (Req 1.6, 1.9, 21.4, 21.5, 26.1):
 *     Using the `anon` key client, a `SELECT` over `events` returns ONLY the
 *     `live` event. Rows with status `draft`, `ended` or `archived` are absent
 *     because the anon SELECT policy is `USING (status = 'live')`.
 *
 *   Task 5.4 — Anonymous event MUTATION DENIAL (Req 10.5, 21.4, 21.6, 26.1):
 *     Using the `anon` key client, an `INSERT`, `UPDATE` or `DELETE` on
 *     `events` is rejected (authorization failure) and changes zero rows,
 *     because RLS is enabled with NO client write policy — all mutations go
 *     through service-role Edge Functions. A service-role re-read confirms no
 *     row was created and the target row is unchanged.
 *
 * WHY THESE ARE ENV-GATED INTEGRATION TESTS (AND SKIP HERE)
 * --------------------------------------------------------
 * A faithful RLS test requires a REAL Supabase instance: PostgreSQL with RLS
 * enabled AND the `anon` / `authenticated` / service roles wired to JWT-scoped
 * clients. That behaviour cannot be emulated locally in this sandbox:
 *   - There is no local Postgres — no `psql`, `initdb`, or `supabase` CLI, and
 *     a containerised Supabase stack (RLS + role JWTs) cannot be reliably
 *     started from the test runner (see the findings documented in
 *     src/db/migrations.test.ts for Task 4.7).
 *   - `pg-mem` cannot represent RLS, the `anon`/`authenticated` roles, or the
 *     citext/regex constraints the real schema uses, so it would test a
 *     fabricated schema, not the shipped policies.
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
 * constraints and (implicitly) the RLS SQL. THIS file verifies live RLS
 * BEHAVIOUR against a real instance in CI. The two are complementary.
 *
 * HOW TO RUN THESE TESTS
 * ----------------------
 * Set the following environment variables to a REAL, disposable TEST Supabase
 * project (never production), then run `npm test`:
 *   - TEST_SUPABASE_URL              — project URL (https://<ref>.supabase.co)
 *   - TEST_SUPABASE_ANON_KEY         — the public anon key (RLS-gated)
 *   - TEST_SUPABASE_SERVICE_ROLE_KEY — the service role key (seeding/cleanup +
 *                                      privileged re-reads; BYPASSES RLS)
 * The service role key is a SECRET and is used ONLY here in test/CI context;
 * it is never referenced by application/browser code.
 *
 * Design ref: RLS Design → `events` per-table policies; General policy strategy.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Read a (possibly server-only) test env var. These tests run under Node via
 * Vitest, so `globalThis.process.env` is the source. Non-`VITE_` names are used
 * on purpose so these secrets never leak into the browser bundle.
 */
function readTestEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

const TEST_SUPABASE_URL = readTestEnv('TEST_SUPABASE_URL');
const TEST_SUPABASE_ANON_KEY = readTestEnv('TEST_SUPABASE_ANON_KEY');
const TEST_SUPABASE_SERVICE_ROLE_KEY = readTestEnv('TEST_SUPABASE_SERVICE_ROLE_KEY');

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
    '[rls.events.test] SKIPPING live `events` RLS integration tests (Tasks 5.3/5.4): ' +
      'set TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_ROLE_KEY ' +
      'to a real TEST Supabase project to run them. This sandbox has no Postgres/RLS, ' +
      'so they skip here; the static schema guard (src/db/migrations.test.ts) covers ' +
      'structure and these cover live RLS behaviour in CI.',
  );
}

/** The four lifecycle statuses we seed, one row each. */
type SeededStatus = 'draft' | 'live' | 'ended' | 'archived';
const SEEDED_STATUSES: readonly SeededStatus[] = ['draft', 'live', 'ended', 'archived'];

/**
 * Generate a >=32-char alphanumeric presenter token that satisfies the
 * `events_presenter_token_chk` constraint (Req 7.3). Uniqueness is required by
 * the UNIQUE constraint, so we mix in randomness.
 */
function makePresenterToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  while (token.length < 40) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return token;
}

/** A run-unique tag so fixtures never collide with other data / parallel runs. */
const RUN_TAG = `rls-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface SeededEvent {
  readonly status: SeededStatus;
  readonly name: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly presenter_token: string;
}

/** Build the four fixture rows (draft/live/ended/archived) with valid fields. */
function buildFixtures(): SeededEvent[] {
  const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h ahead
  return SEEDED_STATUSES.map((status) => ({
    status,
    name: `${RUN_TAG} ${status}`,
    starts_at: startsAt,
    ends_at: endsAt,
    presenter_token: makePresenterToken(),
  }));
}

// describe.skipIf keeps the suite in the report as SKIPPED (not failed / not
// silently absent) when the live config is missing.
describe.skipIf(!hasLiveSupabase)('events RLS behaviour (live Supabase integration)', () => {
  // Non-null asserted: this block only runs when hasLiveSupabase is true.
  const url = TEST_SUPABASE_URL!;
  const anonKey = TEST_SUPABASE_ANON_KEY!;
  const serviceKey = TEST_SUPABASE_SERVICE_ROLE_KEY!;

  /** Service-role client — BYPASSES RLS. Used for seeding, cleanup and re-reads. */
  let admin: SupabaseClient;
  /** Anonymous client — subject under test; RLS applies. */
  let anon: SupabaseClient;

  /** Ids of the seeded rows keyed by status, filled during seeding. */
  const seededIds: Partial<Record<SeededStatus, string>> = {};

  beforeAll(async () => {
    admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Seed one event per status with the service role (bypasses RLS).
    const fixtures = buildFixtures();
    const { data, error } = await admin.from('events').insert(fixtures).select('id, status');
    if (error) {
      throw new Error(`Failed to seed events fixtures: ${error.message}`);
    }
    for (const row of data ?? []) {
      seededIds[row.status as SeededStatus] = row.id as string;
    }
    // Sanity: all four statuses seeded.
    for (const status of SEEDED_STATUSES) {
      if (!seededIds[status]) {
        throw new Error(`Seeding did not produce a "${status}" event row`);
      }
    }
  });

  afterAll(async () => {
    // Remove only the rows this run created (service role bypasses RLS).
    if (admin) {
      const ids = Object.values(seededIds).filter((id): id is string => Boolean(id));
      if (ids.length > 0) {
        await admin.from('events').delete().in('id', ids);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Task 5.3 — anonymous visibility (Req 1.6, 1.9, 21.4, 21.5, 26.1)
  // ---------------------------------------------------------------------------
  describe('Task 5.3 — anonymous SELECT visibility', () => {
    it('returns the live event to anonymous clients', async () => {
      const liveId = seededIds.live!;
      const { data, error } = await anon
        .from('events')
        .select('id, status')
        .eq('id', liveId);

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0].id).toBe(liveId);
      expect(data![0].status).toBe('live');
    });

    it.each(['draft', 'ended', 'archived'] as const)(
      'hides the %s event from anonymous clients (zero rows)',
      async (status) => {
        const targetId = seededIds[status]!;
        const { data, error } = await anon
          .from('events')
          .select('id, status')
          .eq('id', targetId);

        // RLS filters non-live rows out entirely — a filtered SELECT is not an
        // error, it simply returns no rows.
        expect(error).toBeNull();
        expect(data).toEqual([]);
      },
    );

    it('returns exactly one of our four seeded rows (only the live one) to anon', async () => {
      const allIds = SEEDED_STATUSES.map((s) => seededIds[s]!);
      const { data, error } = await anon
        .from('events')
        .select('id, status')
        .in('id', allIds);

      expect(error).toBeNull();
      const returned = (data ?? []).map((r) => r.status);
      expect(returned).toEqual(['live']);
    });
  });

  // ---------------------------------------------------------------------------
  // Task 5.4 — anonymous mutation denial (Req 10.5, 21.4, 21.6, 26.1)
  // ---------------------------------------------------------------------------
  describe('Task 5.4 — anonymous INSERT/UPDATE/DELETE denial', () => {
    it('rejects an anonymous INSERT and creates no row', async () => {
      const rogueName = `${RUN_TAG} anon-insert-should-fail`;
      const { data, error } = await anon
        .from('events')
        .insert({
          name: rogueName,
          status: 'live',
          starts_at: new Date(Date.now() - 1000).toISOString(),
          ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          presenter_token: makePresenterToken(),
        })
        .select('id');

      // With RLS enabled and no client INSERT policy, the write is denied. The
      // client surfaces this as an error and returns no inserted row.
      expect(error).not.toBeNull();
      expect(data ?? []).toEqual([]);

      // Authoritative check via the service role: no such row exists.
      const { data: check, error: checkError } = await admin
        .from('events')
        .select('id')
        .eq('name', rogueName);
      expect(checkError).toBeNull();
      expect(check ?? []).toEqual([]);
    });

    it('rejects an anonymous UPDATE and leaves the row unchanged', async () => {
      const liveId = seededIds.live!;

      // Snapshot the row via the service role before the attempt.
      const { data: before } = await admin
        .from('events')
        .select('id, name, status')
        .eq('id', liveId)
        .single();

      const { data, error } = await anon
        .from('events')
        .update({ name: `${RUN_TAG} hijacked` })
        .eq('id', liveId)
        .select('id');

      // Denied by RLS: either an explicit error or, at minimum, zero rows
      // affected. In both cases nothing must actually change.
      if (error === null) {
        expect(data ?? []).toEqual([]);
      }

      // Authoritative re-read: the row is byte-for-byte unchanged.
      const { data: after, error: afterError } = await admin
        .from('events')
        .select('id, name, status')
        .eq('id', liveId)
        .single();
      expect(afterError).toBeNull();
      expect(after).toEqual(before);
    });

    it('rejects an anonymous DELETE and the row still exists', async () => {
      const liveId = seededIds.live!;

      const { data, error } = await anon
        .from('events')
        .delete()
        .eq('id', liveId)
        .select('id');

      // Denied by RLS: explicit error or zero rows affected — never an actual
      // delete.
      if (error === null) {
        expect(data ?? []).toEqual([]);
      }

      // Authoritative re-read: the row is still present.
      const { data: after, error: afterError } = await admin
        .from('events')
        .select('id')
        .eq('id', liveId);
      expect(afterError).toBeNull();
      expect(after).toHaveLength(1);
      expect(after![0].id).toBe(liveId);
    });
  });
});
