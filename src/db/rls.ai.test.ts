/**
 * Task 27.3 — AI-table Row Level Security (RLS) behaviour tests.
 *
 * WHAT THESE TESTS DO
 * -------------------
 * These are INTEGRATION tests that exercise the LIVE RLS behaviour of the
 * Milestone-4 (AI Features) tables against a REAL Supabase project:
 *   - `ai_provider_settings` (supabase/migrations/20260101000033_ai_provider_settings_rls.sql)
 *   - `ai_jobs`              (supabase/migrations/20260101000034_ai_jobs_clusters_rls.sql)
 *   - `question_clusters`    (supabase/migrations/20260101000034_ai_jobs_clusters_rls.sql)
 *
 * They mirror the structure and env-gating of src/db/rls.questions.test.ts
 * (Task 12.3) and src/db/rls.polls.test.ts (Task 20.4) and cover the following
 * guarantees from the design (Design → RLS Design → `ai_provider_settings` /
 * `ai_jobs` / `question_clusters` per-table policies):
 *
 *   1. ANONYMOUS access is denied ENTIRELY on all three tables (Req 21.4,
 *      21.8, 20.6, 16.10): `ai_provider_settings` has NO anon policy/grant of
 *      any kind, and `ai_jobs` / `question_clusters` each have RLS enabled with
 *      NO anon SELECT policy. An `anon` `SELECT` therefore returns no rows
 *      (and/or is rejected) for every one of the three tables, and — for
 *      provider settings — the anon whitelist read path (the SECURITY DEFINER
 *      fn / public view) is not granted to `anon` either.
 *
 *   2. SECRET-EXCLUSION invariant for `ai_provider_settings` (Req 12.10, 21.8):
 *      the base table is default-deny with NO client SELECT policy, so a direct
 *      base-table `SELECT` returns nothing for ANY client (anon OR
 *      authenticated). The ONLY client-reachable read path is the whitelisted,
 *      NON-SECRET projection exposed by the SECURITY DEFINER function
 *      `read_ai_provider_settings()` and the companion
 *      `ai_provider_settings_public` view — and NEITHER exposes
 *      `secret_reference` or `encrypted_credential`. This suite asserts:
 *        (a) a direct base-table select of the secret columns is rejected/empty
 *            for anon AND for an authenticated admin, and
 *        (b) the whitelisted read path returns the non-secret columns of the
 *            active config to an authenticated admin, and
 *        (c) the whitelisted read path does NOT contain the secret columns
 *            (they are absent from the function return type and the view).
 *
 *   3. AUTHENTICATED-ADMIN read for own scope on `ai_jobs` /
 *      `question_clusters` (Req 20.6, 16.10): the authenticated SELECT policy
 *      is `USING (true)` (V1: all admins equivalent), so a signed-in admin can
 *      read the audit rows / clusters. This is asserted against a real
 *      authenticated JWT-scoped client.
 *
 *   4. CLIENT WRITES are rejected on all three tables (Req 21.6, 12.10, 20.6,
 *      16.10): every one of these tables has RLS enabled with NO client
 *      INSERT/UPDATE policy, so a direct `INSERT`/`UPDATE` by anon OR by an
 *      authenticated admin is rejected (error) and affects no rows. All writes
 *      are performed by the service role (AI Config / AI Gateway Edge Functions
 *      and the service-role cluster create/dissolve path), which bypasses RLS.
 *
 * WHY THESE ARE ENV-GATED INTEGRATION TESTS (AND SKIP HERE)
 * --------------------------------------------------------
 * A faithful RLS test requires a REAL Supabase instance: PostgreSQL with RLS
 * enabled AND the `anon` / `authenticated` / service roles wired to JWT-scoped
 * clients, plus the SECURITY DEFINER `read_ai_provider_settings()` function and
 * the `ai_provider_settings_public` view. That behaviour cannot be emulated
 * locally in this sandbox — there is no local Postgres and no containerised
 * Supabase stack (RLS + role JWTs) that can be reliably started from the test
 * runner. This mirrors the precedent established by src/db/rls.questions.test.ts
 * (Task 12.3), src/db/rls.polls.test.ts (Task 20.4) and src/db/rls.events.test.ts:
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
 * constraints and RLS SQL (including the AI-table RLS enablement, the no-secret
 * read fn/view and the absence of anon/write policies). THIS file verifies live
 * RLS BEHAVIOUR against a real instance in CI. The two are complementary.
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
 * To ALSO exercise the AUTHENTICATED-ADMIN read/write-denial paths (Req 20.6,
 * 16.10, 12.10 authenticated base-table deny), additionally set a disposable
 * admin credential for the TEST project:
 *   - TEST_SUPABASE_ADMIN_EMAIL      — email of a confirmed admin test user
 *   - TEST_SUPABASE_ADMIN_PASSWORD   — that user's password
 * When these are absent, the authenticated-admin describe block skips cleanly
 * while the anon-denial and service-role assertions still run. (No existing
 * suite signs in, so this is the first authenticated-client path; it is kept
 * optional so the core anon guarantees run with only the three base keys.)
 *
 * Design ref: RLS Design → `ai_provider_settings` (no anonymous access,
 * non-secret columns only via column-restricted view / SECURITY DEFINER read
 * fn; secret writes service-role only); `ai_jobs` / `question_clusters`
 * (authenticated read for own scope, no anonymous access, writes service-role
 * only); General policy strategy (default deny; server-mediated writes).
 * Requirements: 12.10, 21.8, 20.6, 16.10, 26.1.
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

/**
 * Optional admin credentials for the authenticated-admin read / write-denial
 * paths. When absent, the authenticated-admin describe block skips cleanly
 * while the anon and service-role assertions still run.
 */
const TEST_SUPABASE_ADMIN_EMAIL = readTestEnv('TEST_SUPABASE_ADMIN_EMAIL');
const TEST_SUPABASE_ADMIN_PASSWORD = readTestEnv(
  'TEST_SUPABASE_ADMIN_PASSWORD',
);
const hasAdminCredentials =
  hasLiveSupabase &&
  TEST_SUPABASE_ADMIN_EMAIL !== undefined &&
  TEST_SUPABASE_ADMIN_PASSWORD !== undefined;

if (!hasLiveSupabase) {
  // Visible, explicit reason so a skipped run is never mistaken for a pass over
  // real RLS. (Vitest also reports the suite as skipped via describe.skipIf.)
  console.info(
    '[rls.ai.test] SKIPPING live AI-table RLS integration tests (Task 27.3): ' +
      'set TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_ROLE_KEY ' +
      'to a real TEST Supabase project to run them (and optionally ' +
      'TEST_SUPABASE_ADMIN_EMAIL / TEST_SUPABASE_ADMIN_PASSWORD for the authenticated-admin ' +
      'paths). This sandbox has no Postgres/RLS, so they skip here (same precedent as ' +
      'src/db/rls.questions.test.ts / src/db/rls.polls.test.ts); the static schema guard ' +
      '(src/db/migrations.test.ts) covers structure and these cover live RLS behaviour in CI.',
  );
} else if (!hasAdminCredentials) {
  console.info(
    '[rls.ai.test] Running AI-table RLS tests WITHOUT the authenticated-admin paths: ' +
      'set TEST_SUPABASE_ADMIN_EMAIL and TEST_SUPABASE_ADMIN_PASSWORD (a disposable ' +
      'confirmed admin test user) to also exercise the authenticated-admin read and ' +
      'write-denial assertions. The anon-denial and service-role assertions run regardless.',
  );
}

/**
 * The whitelisted NON-SECRET columns the AI-provider read path
 * (`read_ai_provider_settings()` / `ai_provider_settings_public`) exposes. The
 * SECRET columns below must NEVER appear in any client-reachable projection.
 */
const NON_SECRET_PROVIDER_COLUMNS: readonly string[] = [
  'id',
  'is_active',
  'ai_enabled',
  'display_name',
  'provider_type',
  'base_url',
  'chat_completions_path',
  'auth_type',
  'api_key_header_name',
  'model_id',
  'temperature',
  'max_output_tokens',
  'request_timeout_seconds',
  'tls_verify_required',
  'credential_state',
  'created_at',
  'updated_at',
];

/** The SECRET columns that must never be selectable by any client. */
const SECRET_PROVIDER_COLUMNS: readonly string[] = [
  'secret_reference',
  'encrypted_credential',
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
const RUN_TAG = `rls-ai-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
  'ai_provider_settings + ai_jobs + question_clusters RLS behaviour (live Supabase integration)',
  () => {
    // Non-null asserted: this block only runs when hasLiveSupabase is true.
    const url = TEST_SUPABASE_URL!;
    const anonKey = TEST_SUPABASE_ANON_KEY!;
    const serviceKey = TEST_SUPABASE_SERVICE_ROLE_KEY!;

    /** Service-role client — BYPASSES RLS. Used for seeding, cleanup and re-reads. */
    let admin: SupabaseClient;
    /** Anonymous client — subject under test; RLS applies. */
    let anon: SupabaseClient;

    /** The seeded event id that owns the AI-job / cluster fixtures. */
    let eventId: string;
    /** The seeded ACTIVE ai_provider_settings row id. */
    let providerSettingsId: string;
    /** Whether this run seeded the provider config (skip if one already active). */
    let seededProviderConfig = false;
    /** The seeded ai_jobs audit row id. */
    let aiJobId: string;
    /** The seeded question_clusters row id. */
    let clusterId: string;

    beforeAll(async () => {
      admin = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      anon = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // --- Seed an event to own the AI-job / cluster fixtures --------------
      const { data: event, error: eventError } = await admin
        .from('events')
        .insert(buildEvent('live', 'ai-live-event'))
        .select('id')
        .single();
      if (eventError || !event) {
        throw new Error(
          `Failed to seed the event fixture: ${eventError?.message ?? 'no row'}`,
        );
      }
      eventId = event.id as string;

      // --- Seed (or reuse) the single ACTIVE ai_provider_settings row ------
      // The `one_active_ai_provider` partial UNIQUE index allows AT MOST ONE
      // active config, so if the test project already has one we reuse it
      // rather than violating the invariant. We seed a credential
      // (secret_reference) so the secret-exclusion assertions have a non-null
      // secret to prove is never client-readable.
      const { data: existingActive } = await admin
        .from('ai_provider_settings')
        .select('id')
        .eq('is_active', true)
        .limit(1);
      if ((existingActive ?? []).length > 0) {
        providerSettingsId = existingActive![0].id as string;
        // Ensure a secret is present for the exclusion assertions.
        await admin
          .from('ai_provider_settings')
          .update({ secret_reference: `${RUN_TAG}-secret-ref` })
          .eq('id', providerSettingsId);
      } else {
        const { data: settings, error: settingsError } = await admin
          .from('ai_provider_settings')
          .insert({
            is_active: true,
            ai_enabled: true,
            display_name: `${RUN_TAG} provider`,
            provider_type: 'openai_compatible',
            base_url: 'https://example.test',
            chat_completions_path: '/v1/chat/completions',
            auth_type: 'bearer',
            model_id: 'test-model',
            temperature: 0.7,
            max_output_tokens: 1024,
            request_timeout_seconds: 30,
            tls_verify_required: true,
            secret_reference: `${RUN_TAG}-secret-ref`,
          })
          .select('id')
          .single();
        if (settingsError || !settings) {
          throw new Error(
            `Failed to seed ai_provider_settings: ${settingsError?.message ?? 'no row'}`,
          );
        }
        providerSettingsId = settings.id as string;
        seededProviderConfig = true;
      }

      // --- Seed an ai_jobs audit row (service role bypasses RLS) -----------
      const { data: job, error: jobError } = await admin
        .from('ai_jobs')
        .insert({
          event_id: eventId,
          job_type: 'summary',
          status: 'succeeded',
          model_id: 'test-model',
        })
        .select('id')
        .single();
      if (jobError || !job) {
        throw new Error(
          `Failed to seed ai_jobs row: ${jobError?.message ?? 'no row'}`,
        );
      }
      aiJobId = job.id as string;

      // --- Seed a question_clusters row ------------------------------------
      const { data: cluster, error: clusterError } = await admin
        .from('question_clusters')
        .insert({
          event_id: eventId,
          label: `${RUN_TAG} cluster`,
        })
        .select('id')
        .single();
      if (clusterError || !cluster) {
        throw new Error(
          `Failed to seed question_clusters row: ${clusterError?.message ?? 'no row'}`,
        );
      }
      clusterId = cluster.id as string;
    });

    afterAll(async () => {
      // Remove only the rows this run created (service role bypasses RLS).
      if (admin) {
        if (clusterId) {
          await admin.from('question_clusters').delete().eq('id', clusterId);
        }
        if (aiJobId) {
          await admin.from('ai_jobs').delete().eq('id', aiJobId);
        }
        // Deleting the event also cascades to any remaining ai_jobs /
        // question_clusters scoped to it (ON DELETE CASCADE).
        if (eventId) {
          await admin.from('events').delete().eq('id', eventId);
        }
        // Only delete the provider config if THIS run created it — never a
        // pre-existing active config on the test project.
        if (seededProviderConfig && providerSettingsId) {
          await admin
            .from('ai_provider_settings')
            .delete()
            .eq('id', providerSettingsId);
        } else if (providerSettingsId) {
          // Reused config: clear the secret_reference we set for the test.
          await admin
            .from('ai_provider_settings')
            .update({ secret_reference: null })
            .eq('id', providerSettingsId);
        }
      }
    });

    // -------------------------------------------------------------------------
    // Anonymous access is denied ENTIRELY on all three tables (Req 21.4, 21.8,
    // 20.6, 16.10)
    // -------------------------------------------------------------------------
    describe('anonymous access is denied on all AI tables', () => {
      it('cannot read ai_provider_settings via the base table (Req 21.8, 12.10)', async () => {
        const { data, error } = await anon
          .from('ai_provider_settings')
          .select('id')
          .eq('id', providerSettingsId);

        // Base table is default-deny with NO client SELECT policy — anon reads
        // are rejected/return nothing.
        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(data ?? []).toEqual([]);
        }
      });

      it('cannot read ai_provider_settings via the whitelist read path (not granted to anon) (Req 21.8)', async () => {
        // The SECURITY DEFINER fn and the public view are granted to
        // `authenticated` ONLY — anon gets nothing from either path.
        const rpcResult = await anon.rpc('read_ai_provider_settings');
        expect((rpcResult.data as unknown[] | null) ?? []).toEqual([]);

        const viewResult = await anon
          .from('ai_provider_settings_public')
          .select('id');
        expect(viewResult.data ?? []).toEqual([]);
      });

      it('cannot read ai_jobs (no anon policy, Req 20.6)', async () => {
        const { data, error } = await anon
          .from('ai_jobs')
          .select('id')
          .eq('id', aiJobId);

        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(data ?? []).toEqual([]);
        }
      });

      it('cannot read question_clusters (no anon policy, Req 16.10)', async () => {
        const { data, error } = await anon
          .from('question_clusters')
          .select('id')
          .eq('id', clusterId);

        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(data ?? []).toEqual([]);
        }
      });
    });

    // -------------------------------------------------------------------------
    // Secret columns are never selectable by ANY client — anon base-table read
    // of the secret columns is rejected/empty (Req 12.10, 21.8)
    // -------------------------------------------------------------------------
    describe('ai_provider_settings secret columns are never client-readable', () => {
      it.each(SECRET_PROVIDER_COLUMNS)(
        'anon cannot select the secret column %s from the base table (Req 12.10, 21.8)',
        async (column) => {
          const { data, error } = await anon
            .from('ai_provider_settings')
            .select(column)
            .eq('id', providerSettingsId);

          // Whether rejected by RLS or returning zero rows, no secret value is
          // ever exposed.
          if (error === null) {
            expect(data ?? []).toEqual([]);
          } else {
            expect(data ?? []).toEqual([]);
          }
        },
      );

      it('service-role sees the secret is actually populated (guards the exclusion test) (Req 12.10)', async () => {
        // A meta-assertion: confirm via the service role (which BYPASSES RLS)
        // that the secret_reference really is set, so the anon/authenticated
        // exclusion assertions are meaningful (they exclude a REAL secret).
        const { data, error } = await admin
          .from('ai_provider_settings')
          .select('id, secret_reference, credential_state')
          .eq('id', providerSettingsId)
          .single();

        expect(error).toBeNull();
        expect(data?.secret_reference).not.toBeNull();
        expect(data?.credential_state).toBe('configured');
      });
    });

    // -------------------------------------------------------------------------
    // Anonymous writes are rejected on all three tables (Req 21.6, 12.10, 20.6,
    // 16.10)
    // -------------------------------------------------------------------------
    describe('anonymous writes are rejected (service-role only)', () => {
      /**
       * Assert an anon write neither succeeds nor mutates state: it must return
       * an error and/or affect no rows (a filtered write under RLS default-deny
       * matches nothing).
       */
      function expectWriteRejected(result: {
        data: unknown;
        error: unknown;
      }): void {
        const { data, error } = result;
        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(error).not.toBeNull();
        }
      }

      it('rejects an anon INSERT into ai_provider_settings (Req 21.6, 12.10)', async () => {
        const result = await anon
          .from('ai_provider_settings')
          .insert({
            is_active: false,
            ai_enabled: true,
            display_name: `${RUN_TAG} anon provider`,
            provider_type: 'openai_compatible',
            base_url: 'https://anon.test',
            chat_completions_path: '/v1/chat/completions',
            auth_type: 'none',
            model_id: 'anon-model',
            temperature: 0.5,
            max_output_tokens: 256,
            request_timeout_seconds: 10,
            tls_verify_required: true,
          })
          .select('id');
        expectWriteRejected(result);
      });

      it('rejects an anon UPDATE of ai_provider_settings (Req 21.6, 12.10)', async () => {
        const result = await anon
          .from('ai_provider_settings')
          .update({ display_name: `${RUN_TAG} anon-edited` })
          .eq('id', providerSettingsId)
          .select('id');
        expectWriteRejected(result);

        // Authoritative re-read via the service role: unchanged.
        const { data: rows } = await admin
          .from('ai_provider_settings')
          .select('display_name')
          .eq('id', providerSettingsId);
        expect((rows ?? [])[0]?.display_name).not.toContain('anon-edited');
      });

      it('rejects an anon INSERT into ai_jobs (Req 21.6, 20.6)', async () => {
        const result = await anon
          .from('ai_jobs')
          .insert({
            event_id: eventId,
            job_type: 'summary',
            status: 'pending',
            model_id: 'anon-model',
          })
          .select('id');
        expectWriteRejected(result);
      });

      it('rejects an anon UPDATE of ai_jobs (Req 21.6, 20.6)', async () => {
        const result = await anon
          .from('ai_jobs')
          .update({ status: 'failed' })
          .eq('id', aiJobId)
          .select('id');
        expectWriteRejected(result);

        const { data: rows } = await admin
          .from('ai_jobs')
          .select('status')
          .eq('id', aiJobId);
        expect((rows ?? [])[0]?.status).toBe('succeeded');
      });

      it('rejects an anon INSERT into question_clusters (Req 21.6, 16.10)', async () => {
        const result = await anon
          .from('question_clusters')
          .insert({
            event_id: eventId,
            label: `${RUN_TAG} anon cluster`,
          })
          .select('id');
        expectWriteRejected(result);
      });

      it('rejects an anon UPDATE of question_clusters (Req 21.6, 16.10)', async () => {
        const result = await anon
          .from('question_clusters')
          .update({ label: `${RUN_TAG} anon-edited cluster` })
          .eq('id', clusterId)
          .select('id');
        expectWriteRejected(result);

        const { data: rows } = await admin
          .from('question_clusters')
          .select('label')
          .eq('id', clusterId);
        expect((rows ?? [])[0]?.label).not.toContain('anon-edited');
      });
    });

    // -------------------------------------------------------------------------
    // Authenticated-admin paths (Req 20.6, 16.10, 12.10). These require a
    // signed-in admin JWT and skip cleanly when the optional admin credentials
    // are absent.
    // -------------------------------------------------------------------------
    describe.skipIf(!hasAdminCredentials)('authenticated admin access', () => {
      /** Authenticated (signed-in) client — RLS applies with the `authenticated` role. */
      let authed: SupabaseClient;

      beforeAll(async () => {
        authed = createClient(url, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error } = await authed.auth.signInWithPassword({
          email: TEST_SUPABASE_ADMIN_EMAIL!,
          password: TEST_SUPABASE_ADMIN_PASSWORD!,
        });
        if (error) {
          throw new Error(
            `Failed to sign in the admin test user: ${error.message}`,
          );
        }
      });

      afterAll(async () => {
        if (authed) {
          await authed.auth.signOut();
        }
      });

      // --- ai_provider_settings: whitelist read path exposes non-secret ---
      it('reads the active config non-secret columns via the whitelist read path (Req 12.10)', async () => {
        const { data, error } = await authed.rpc('read_ai_provider_settings');

        expect(error).toBeNull();
        const rows = (data as Record<string, unknown>[] | null) ?? [];
        // There is a single active config, so the read path returns exactly it.
        expect(rows.length).toBe(1);
        const row = rows[0];
        // Every whitelisted non-secret column is present on the projection.
        for (const column of NON_SECRET_PROVIDER_COLUMNS) {
          expect(Object.prototype.hasOwnProperty.call(row, column)).toBe(true);
        }
      });

      it('the whitelist read path NEVER exposes the secret columns (Req 12.10, 21.8)', async () => {
        const { data, error } = await authed.rpc('read_ai_provider_settings');

        expect(error).toBeNull();
        const rows = (data as Record<string, unknown>[] | null) ?? [];
        expect(rows.length).toBe(1);
        const row = rows[0];
        // The secret columns are absent from the function return type and view.
        for (const secret of SECRET_PROVIDER_COLUMNS) {
          expect(Object.prototype.hasOwnProperty.call(row, secret)).toBe(false);
        }
      });

      it.each(SECRET_PROVIDER_COLUMNS)(
        'authenticated admin cannot select the secret column %s from the base table (Req 12.10, 21.8)',
        async (column) => {
          const { data, error } = await authed
            .from('ai_provider_settings')
            .select(column)
            .eq('id', providerSettingsId);

          // Base table is default-deny for authenticated too — no secret value
          // is ever exposed via a direct base-table select.
          if (error === null) {
            expect(data ?? []).toEqual([]);
          } else {
            expect(data ?? []).toEqual([]);
          }
        },
      );

      // --- ai_jobs / question_clusters: authenticated read for own scope --
      it('authenticated admin can read the seeded ai_jobs row (Req 20.6)', async () => {
        const { data, error } = await authed
          .from('ai_jobs')
          .select('id, status')
          .eq('id', aiJobId);

        expect(error).toBeNull();
        expect((data ?? []).length).toBe(1);
        expect((data ?? [])[0]?.id).toBe(aiJobId);
      });

      it('authenticated admin can read the seeded question_clusters row (Req 16.10)', async () => {
        const { data, error } = await authed
          .from('question_clusters')
          .select('id, label')
          .eq('id', clusterId);

        expect(error).toBeNull();
        expect((data ?? []).length).toBe(1);
        expect((data ?? [])[0]?.id).toBe(clusterId);
      });

      // --- Authenticated-admin writes are still rejected (service-role only) -
      it('rejects an authenticated-admin INSERT into ai_jobs (Req 21.6, 20.6)', async () => {
        const { data, error } = await authed
          .from('ai_jobs')
          .insert({
            event_id: eventId,
            job_type: 'summary',
            status: 'pending',
            model_id: 'authed-model',
          })
          .select('id');

        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(error).not.toBeNull();
        }
      });

      it('rejects an authenticated-admin UPDATE of question_clusters (Req 21.6, 16.10)', async () => {
        const { data, error } = await authed
          .from('question_clusters')
          .update({ label: `${RUN_TAG} authed-edited cluster` })
          .eq('id', clusterId)
          .select('id');

        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(error).not.toBeNull();
        }

        // Authoritative re-read via the service role: unchanged.
        const { data: rows } = await admin
          .from('question_clusters')
          .select('label')
          .eq('id', clusterId);
        expect((rows ?? [])[0]?.label).not.toContain('authed-edited');
      });

      it('rejects an authenticated-admin UPDATE of ai_provider_settings (Req 21.6, 12.10)', async () => {
        const { data, error } = await authed
          .from('ai_provider_settings')
          .update({ display_name: `${RUN_TAG} authed-edited` })
          .eq('id', providerSettingsId)
          .select('id');

        if (error === null) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(error).not.toBeNull();
        }

        const { data: rows } = await admin
          .from('ai_provider_settings')
          .select('display_name')
          .eq('id', providerSettingsId);
        expect((rows ?? [])[0]?.display_name).not.toContain('authed-edited');
      });
    });
  },
);
