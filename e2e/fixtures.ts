/**
 * Task 41.1 — Shared Playwright fixtures + env-gating for the E2E suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * The eight required end-to-end flows (Req 26.4; authored in tasks 41.2–41.4)
 * all need the same two things:
 *   1. A single, consistent way to know whether the E2E environment is
 *      configured (a deployed target + its Supabase project).
 *   2. A single, consistent way to SKIP cleanly when it is not — so that
 *      `npm run e2e` in an environment with no live target (this sandbox, a
 *      fresh CI job without secrets, a laptop with no deployment) reports the
 *      suite as SKIPPED instead of failing hard.
 *
 * This mirrors the philosophy of the live-RLS integration tests in
 * `src/db/rls.*.test.ts`: they read `TEST_SUPABASE_*` env vars and use
 * `describe.skipIf(!hasLiveSupabase)` so a DB-less run is green-by-skip and
 * never fake-passes. Here the equivalent gate is `e2eEnabled`, and specs use
 * `skipIfE2EDisabled(test)` (or `test.skip(!e2eEnabled, ...)`).
 *
 * ENVIRONMENT VARIABLES (Node-side; never `VITE_`-prefixed so they are not
 * bundled into any browser code):
 *   - E2E_BASE_URL          — REQUIRED. Base URL of the running SPA to drive,
 *                             e.g. a Vercel preview/prod deployment or a local
 *                             `vite preview` server. Also consumed by
 *                             playwright.config.ts as `use.baseURL`.
 *   - E2E_SUPABASE_URL      — REQUIRED. URL of the Supabase project the target
 *                             is backed by (for seeding / state inspection).
 *   - E2E_SUPABASE_ANON_KEY — REQUIRED. Anon key for that project (RLS-gated;
 *                             not a secret).
 *
 * When ALL of the above are present, `e2eEnabled` is true and specs run. When
 * ANY is missing, `e2eEnabled` is false and specs skip with a clear reason.
 *
 * NOTE: this file is NOT a spec — it is intentionally NOT named `*.e2e.ts`, so
 * Playwright's `testMatch` (`*.e2e.ts`) does not treat it as a test file, and
 * Vitest's `{test,spec}` glob never picks it up either.
 *
 * Design ref: Testing Strategy (End-to-end tests); Deployment and Environment.
 * Requirements: 26.4.
 */
import { test as base, expect } from '@playwright/test';

/**
 * Read an E2E env var, treating empty/whitespace-only values as unset. Kept
 * parallel to `readTestEnv()` in `src/db/rls.events.test.ts`.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The resolved E2E environment, computed once at module load. */
export interface E2EEnv {
  /** Base URL of the running SPA under test (from `E2E_BASE_URL`). */
  readonly baseUrl: string | undefined;
  /** Supabase project URL the target is backed by (from `E2E_SUPABASE_URL`). */
  readonly supabaseUrl: string | undefined;
  /** Supabase anon key (from `E2E_SUPABASE_ANON_KEY`). */
  readonly supabaseAnonKey: string | undefined;
}

export const e2eEnv: E2EEnv = {
  baseUrl: readEnv('E2E_BASE_URL'),
  supabaseUrl: readEnv('E2E_SUPABASE_URL'),
  supabaseAnonKey: readEnv('E2E_SUPABASE_ANON_KEY'),
};

/**
 * True only when the FULL E2E configuration is present: a target base URL AND
 * the Supabase project it talks to. Any missing value disables the suite.
 */
export const e2eEnabled: boolean =
  e2eEnv.baseUrl !== undefined &&
  e2eEnv.supabaseUrl !== undefined &&
  e2eEnv.supabaseAnonKey !== undefined;

/** Human-readable reason surfaced on skipped specs and in the console. */
export const E2E_SKIP_REASON =
  'E2E env not configured — set E2E_BASE_URL, E2E_SUPABASE_URL and ' +
  'E2E_SUPABASE_ANON_KEY to a running deployment + its Supabase project to ' +
  'run the end-to-end flows (Req 26.4). Skipping cleanly (no live target).';

if (!e2eEnabled) {
  // Visible, explicit reason so a skipped run is never mistaken for a real
  // pass over the deployed flows (mirrors the RLS tests' console.info).
  console.info(`[e2e] SKIPPING end-to-end flows: ${E2E_SKIP_REASON}`);
}

/**
 * Fixtures exposed to every spec. `e2eEnabled` lets a spec make the skip
 * decision itself; most specs will just call `skipIfE2EDisabled(test)` at the
 * top of their describe/beforeEach.
 */
export interface E2EFixtures {
  /** Whether the E2E environment is fully configured. */
  e2eEnabled: boolean;
  /** The resolved env values (base URL + Supabase config). */
  e2eEnv: E2EEnv;
}

/**
 * Extended Playwright `test` carrying the env-gating fixtures. Import THIS in
 * every spec instead of the raw `@playwright/test` `test`.
 */
export const test = base.extend<E2EFixtures>({
  // eslint-disable-next-line no-empty-pattern
  e2eEnabled: async ({}, use) => {
    await use(e2eEnabled);
  },
  // eslint-disable-next-line no-empty-pattern
  e2eEnv: async ({}, use) => {
    await use(e2eEnv);
  },
});

/**
 * Convenience guard: registers a `beforeEach` that skips the whole file when
 * the E2E environment is not configured. Call once at the top of a spec:
 *
 *   import { test, skipIfE2EDisabled } from './fixtures';
 *   skipIfE2EDisabled(test);
 *   test('...', async ({ page }) => { ... });
 */
export function skipIfE2EDisabled(t: typeof test): void {
  t.beforeEach(({ e2eEnabled }) => {
    t.skip(!e2eEnabled, E2E_SKIP_REASON);
  });
}

export { expect };
