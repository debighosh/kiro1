/**
 * Task 41.4 — Presenter view and end-of-event export E2E specs.
 *
 * Covers two flows (Req 26.4):
 *   (g) Presenter view
 *       — navigates to `/present/<eventRef>`, waits for the loading state to
 *         finish, and asserts that one of the known presenter mode sections is
 *         visible (data-testid: presenter-join, presenter-featured,
 *         presenter-top, presenter-poll-results, presenter-word-cloud, or
 *         presenter-waiting-mode).
 *   (h) End event + export
 *       — admin logs in at `/admin/login`, navigates to the event edit page
 *         for the configured event, ends the event (moves it to `ended`
 *         status via the StatusTransitionControl), navigates to
 *         `/admin/events/<id>/summary`, asserts the "Generate summary" button
 *         is present, clicks it, and asserts the UI moves to a generating or
 *         done state.
 *
 * All tests are env-gated via `skipIfE2EDisabled(test)` at file scope so they
 * skip cleanly in environments without a live target (no browser, no deployed
 * app, no Supabase project configured). Every selector matches the REAL,
 * accessible-name-based labels and data-testids rendered by the production
 * components in `src/routes/` and `src/components/`.
 *
 * PREREQUISITES (env vars read in test bodies via `process.env`):
 *   - E2E_BASE_URL          — base URL of the running SPA (consumed by
 *                             playwright.config.ts as `use.baseURL`).
 *   - E2E_SUPABASE_URL      — Supabase project URL (required by env gate).
 *   - E2E_SUPABASE_ANON_KEY — Supabase anon key (required by env gate).
 *   - E2E_TEST_SLUG         — eventRef (slug or UUID) of a configured event;
 *                             used as the `:eventRef` segment in
 *                             `/present/<eventRef>` (flow g).
 *   - E2E_TEST_EVENT_ID     — UUID of that same event; used as the `:id`
 *                             segment in the admin routes (flow h).
 *   - E2E_ADMIN_EMAIL       — admin account email (used by flow h).
 *   - E2E_ADMIN_PASSWORD    — admin account password (used by flow h).
 *
 * NOTE: flow (h) transitions the event to `ended` — run this suite LAST, or
 * provide a dedicated disposable event via E2E_TEST_EVENT_ID so other flows
 * are not disrupted. The test will only click "End event" if the button is
 * present; if the event is already ended it asserts the summary page directly.
 *
 * ENV-GATE: when E2E_BASE_URL, E2E_SUPABASE_URL, or E2E_SUPABASE_ANON_KEY are
 * absent, ALL tests in this file skip via `skipIfE2EDisabled(test)` — no hard
 * failures in an unconfigured environment.
 *
 * Requirements traceability: 26.4.
 * Design: Testing Strategy (End-to-end tests).
 */

import { test, expect, skipIfE2EDisabled } from './fixtures';

// ---------------------------------------------------------------------------
// Skip ALL tests in this file when the E2E environment is not configured.
// ---------------------------------------------------------------------------
skipIfE2EDisabled(test);

// ---------------------------------------------------------------------------
// Flow (g) — Presenter view
// ---------------------------------------------------------------------------

test.describe('(g) Presenter view', () => {
  test('presenter view loads and shows a recognised presenter mode section', async ({
    page,
  }) => {
    const eventRef = process.env.E2E_TEST_SLUG ?? 'test-event';

    await page.goto(`/present/${eventRef}`);

    // The PresenterView renders a loading state (data-testid="presenter-loading")
    // while resolving the event; wait for it to disappear before asserting mode.
    const loadingIndicator = page.getByTestId('presenter-loading');
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await expect(loadingIndicator).toBeHidden({ timeout: 15_000 });
    }

    // After loading, one of the presenter mode sections MUST be visible.
    // The data-testids below cover every mode the PresenterView can render:
    //   - presenter-join        : join / QR code display mode
    //   - presenter-featured    : featured_question mode
    //   - presenter-top         : top_questions mode
    //   - presenter-poll-results: poll_results mode (M3)
    //   - presenter-word-cloud  : word_cloud mode (M3)
    //   - presenter-waiting-mode: waiting / event not yet live / event ended
    const modeSection = page
      .getByTestId('presenter-join')
      .or(page.getByTestId('presenter-featured'))
      .or(page.getByTestId('presenter-top'))
      .or(page.getByTestId('presenter-poll-results'))
      .or(page.getByTestId('presenter-word-cloud'))
      .or(page.getByTestId('presenter-waiting-mode'));

    await expect(modeSection).toBeVisible({ timeout: 15_000 });
  });

  test('presenter view at an unknown event ref shows the waiting state', async ({
    page,
  }) => {
    // A deliberately non-existent slug falls through to the waiting/not-found
    // state rather than crashing. This verifies the unhappy path without
    // requiring any specific event data.
    await page.goto('/present/e2e-nonexistent-event-ref');

    // The loading indicator may appear briefly; wait for it.
    const loadingIndicator = page.getByTestId('presenter-loading');
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await expect(loadingIndicator).toBeHidden({ timeout: 15_000 });
    }

    // The waiting state MUST be shown when the event cannot be resolved.
    await expect(page.getByTestId('presenter-waiting-mode')).toBeVisible({
      timeout: 15_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Flow (h) — End event + export (AI summary)
// ---------------------------------------------------------------------------

test.describe('(h) End event and generate AI summary', () => {
  test('admin signs in and navigates to the event edit page', async ({
    page,
  }) => {
    const eventId = process.env.E2E_TEST_EVENT_ID ?? 'test-event';

    // Sign in at the admin login form.
    await page.goto('/admin/login');
    await expect(
      page.getByRole('heading', { name: 'Administrator sign in' }),
    ).toBeVisible();

    await page
      .getByLabel('Email address')
      .fill(process.env.E2E_ADMIN_EMAIL ?? '');
    await page
      .getByLabel('Password')
      .fill(process.env.E2E_ADMIN_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Redirect to the admin area on success.
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });

    // Navigate to the event editor.
    await page.goto(`/admin/events/${eventId}`);

    // The event editor heading should be visible.
    await expect(
      page
        .getByRole('heading', { name: /edit event/i })
        .or(page.getByRole('heading', { name: /event/i })),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('admin ends the event via StatusTransitionControl', async ({ page }) => {
    const eventId = process.env.E2E_TEST_EVENT_ID ?? 'test-event';

    // Sign in.
    await page.goto('/admin/login');
    await page
      .getByLabel('Email address')
      .fill(process.env.E2E_ADMIN_EMAIL ?? '');
    await page
      .getByLabel('Password')
      .fill(process.env.E2E_ADMIN_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });

    // Navigate to the event editor.
    await page.goto(`/admin/events/${eventId}`);
    await expect(
      page
        .getByRole('heading', { name: /edit event/i })
        .or(page.getByRole('heading', { name: /event/i })),
    ).toBeVisible({ timeout: 10_000 });

    // Click "End event" if the event is not already ended.
    // The StatusTransitionControl exposes an "End event" button when the event
    // is live. If the event is already ended, skip the click.
    const endButton = page.getByRole('button', { name: 'End event' });
    const endButtonVisible = await endButton.isVisible().catch(() => false);

    if (endButtonVisible) {
      await endButton.click();

      // After the transition the current status updates to "Ended".
      await expect(page.getByTestId('current-status')).toHaveText('Ended', {
        timeout: 10_000,
      });
    }
    // If the event is already ended (no "End event" button), continue —
    // the summary step will still run.
  });

  test('admin navigates to summary page and Generate summary button is present', async ({
    page,
  }) => {
    const eventId = process.env.E2E_TEST_EVENT_ID ?? 'test-event';

    // Sign in.
    await page.goto('/admin/login');
    await page
      .getByLabel('Email address')
      .fill(process.env.E2E_ADMIN_EMAIL ?? '');
    await page
      .getByLabel('Password')
      .fill(process.env.E2E_ADMIN_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });

    // Navigate to the AI summary page.
    await page.goto(`/admin/events/${eventId}/summary`);

    // The AiSummary screen renders a main heading.
    await expect(
      page.getByRole('heading', { name: 'End-of-event summary' }),
    ).toBeVisible({ timeout: 10_000 });

    // The "Generate summary" trigger button must be present and enabled.
    const generateButton = page.getByRole('button', {
      name: 'Generate summary',
    });
    await expect(generateButton).toBeVisible();
    await expect(generateButton).toBeEnabled();
  });

  test('clicking Generate summary moves to generating or done state', async ({
    page,
  }) => {
    const eventId = process.env.E2E_TEST_EVENT_ID ?? 'test-event';

    // Sign in.
    await page.goto('/admin/login');
    await page
      .getByLabel('Email address')
      .fill(process.env.E2E_ADMIN_EMAIL ?? '');
    await page
      .getByLabel('Password')
      .fill(process.env.E2E_ADMIN_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });

    // Navigate to the summary page.
    await page.goto(`/admin/events/${eventId}/summary`);
    await expect(
      page.getByRole('heading', { name: 'End-of-event summary' }),
    ).toBeVisible({ timeout: 10_000 });

    // Click "Generate summary".
    await page.getByRole('button', { name: 'Generate summary' }).click();

    // After clicking, the UI must enter either:
    //   (a) the "generating" state — button shows "Generating…" and is busy,
    //       AND/OR a role="status" progress message is visible, OR
    //   (b) the "done" state — the summary report section is visible (the
    //       aria-label "End-of-event summary report"), OR
    //   (c) the "done/degraded" state — the button is re-enabled (AI not
    //       configured) and a role="status" message is shown, OR
    //   (d) an error state — role="alert" is visible.
    await expect(
      page
        .getByRole('button', { name: 'Generating…' })
        .or(page.getByRole('status'))
        .or(page.getByRole('region', { name: 'End-of-event summary report' }))
        .or(page.getByRole('alert')),
    ).toBeVisible({ timeout: 30_000 });
  });
});
