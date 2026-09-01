/**
 * Task 41.1 — Playwright end-to-end (E2E) test configuration.
 *
 * WHAT THIS CONFIG DRIVES
 * -----------------------
 * Playwright runs the eight required end-to-end flows (Req 26.4; Design →
 * Testing Strategy → "End-to-end tests — Playwright") against a *deployed,
 * running* MSS LivePulse instance backed by a real Supabase project. Those
 * eight flows are authored in later tasks (41.2–41.4); this task only lands the
 * config, npm scripts, and the shared env-gated fixture so the E2E harness
 * exists and is wired up.
 *
 * WHY E2E IS A SEPARATE RUNNER FROM VITEST
 * ----------------------------------------
 * Vitest (configured in vite.config.ts) is the in-process unit/property runner
 * and globs `src/**\/*.{test,spec}.{ts,tsx}`. Playwright is a completely
 * separate runner that drives a real browser against a real HTTP target. The
 * two must never pick up each other's files:
 *   - Playwright specs live ONLY under `./e2e` and are named `*.e2e.ts`. That
 *     suffix is deliberately OUTSIDE Vitest's `{test,spec}` glob, so
 *     `npm test` never imports Playwright's `@playwright/test` module (which
 *     would throw outside a `playwright test` run).
 *   - As belt-and-suspenders, vite.config.ts also adds `e2e/**` to Vitest's
 *     `exclude`, and the E2E files are excluded from the app/test tsconfigs so
 *     `tsc -b` / `npm run typecheck:test` never compile them either.
 *
 * ENV-GATING & SANDBOX REALITY (mirrors src/db/rls.*.test.ts)
 * ----------------------------------------------------------
 * Just like the live-RLS integration tests in `src/db/rls.*.test.ts` skip
 * cleanly when their `TEST_SUPABASE_*` env vars are absent, the E2E suite is
 * gated on a deployed target being configured. A faithful E2E run needs:
 *   - `E2E_BASE_URL` — the base URL of a running SPA to drive (e.g. a Vercel
 *     preview/prod deployment or a locally served `vite preview`).
 *   - `E2E_SUPABASE_URL` + `E2E_SUPABASE_ANON_KEY` — the Supabase project the
 *     target is talking to, so specs can seed/inspect state where needed.
 * When these are ABSENT (as in this CI sandbox — which additionally has no
 * bundled browsers and no live target), the shared fixture in
 * `e2e/fixtures.ts` reports `e2eEnabled === false` and every spec calls
 * `test.skip(!e2eEnabled, ...)`, so `npm run e2e` reports the suite as SKIPPED
 * rather than failing hard. The suite never fake-passes: with no target it
 * skips; with a real target it runs the real flows.
 *
 * Running the browsers themselves (`npx playwright install`) is an ops step,
 * documented in `e2e/README.md`; it is intentionally NOT performed here.
 *
 * Design ref: Testing Strategy (End-to-end tests); Deployment and Environment.
 * Requirements: 26.4.
 */
import { defineConfig, devices } from '@playwright/test';

/**
 * Read an E2E env var from the Node process, treating empty/whitespace as
 * unset. Kept intentionally parallel to `readTestEnv()` in the RLS tests: these
 * are Node-side (non-`VITE_`) names so nothing leaks into a browser bundle.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

const baseURL = readEnv('E2E_BASE_URL');

// CI gets more retries and forbids `.only`; local dev stays fast and lenient.
const isCI = readEnv('CI') !== undefined;

export default defineConfig({
  // All E2E specs live here and are named `*.e2e.ts` (see testMatch).
  testDir: './e2e',
  // Only match the `*.e2e.ts` suffix. This is the single source of truth for
  // "what is a Playwright spec" and keeps the harness helpers (fixtures.ts)
  // from being treated as test files.
  testMatch: /.*\.e2e\.ts$/,

  // Fail the build on a stray `test.only` left in a committed spec (CI only).
  forbidOnly: isCI,
  // A few retries in CI to absorb realtime/network flakiness; none locally.
  retries: isCI ? 2 : 0,
  // Leave worker count to Playwright's default (parallel across files).
  fullyParallel: true,

  // Per-test and per-assertion timeouts sized for realtime propagation.
  timeout: 30_000,
  expect: { timeout: 10_000 },

  // `baseURL` may be undefined in the sandbox; specs skip before navigating, so
  // Playwright never actually dereferences it here.
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Keep the project matrix minimal (single Chromium) per the task scope.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // List reporter for readable local output; the JSON reporter emits a
  // machine-readable report (Req 26.3) into test-results/.
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/e2e-results.json' }],
  ],
});
