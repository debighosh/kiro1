/**
 * Task 41.1 — E2E harness smoke placeholder.
 *
 * This is a MINIMAL placeholder that proves the Playwright harness is wired up
 * (config + fixtures + env-gating) end-to-end. It is fully env-gated: when the
 * E2E environment is not configured (no deployed target — as in the sandbox and
 * fresh CI), it SKIPS cleanly via the shared `skipIfE2EDisabled` guard, so
 * `npm run e2e` never fails hard here.
 *
 * The eight real required flows (Req 26.4) are authored in tasks 41.2–41.4 as
 * separate `*.e2e.ts` files under this directory; this file is not one of them
 * and should stay a trivial reachability check.
 *
 * Design ref: Testing Strategy (End-to-end tests). Requirements: 26.4.
 */
import { test, expect, skipIfE2EDisabled } from './fixtures';

// Skip the whole file unless E2E_BASE_URL + Supabase env are configured.
skipIfE2EDisabled(test);

test('smoke: the target base URL loads', async ({ page }) => {
  // Only reached when e2eEnabled is true (guard above skips otherwise).
  await page.goto('/');
  // A loaded document has a non-null <html>; the real flows assert app UI.
  await expect(page.locator('html')).toBeVisible();
});
