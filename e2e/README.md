# End-to-end (E2E) tests — Playwright

This directory holds the Playwright end-to-end suite that drives a **deployed,
running** MSS LivePulse instance through the eight required flows (Req 26.4;
see Design → Testing Strategy → _End-to-end tests — Playwright_).

E2E is a **separate runner from Vitest**. Vitest owns the in-process
unit/property suite (`src/**/*.{test,spec}.{ts,tsx}`); Playwright drives a real
browser against a real HTTP target. The two never overlap:

- Playwright specs live only here and are named `*.e2e.ts` — a suffix outside
  Vitest's `{test,spec}` glob, so `npm test` never imports `@playwright/test`.
- `vite.config.ts` also excludes `e2e/**` from the Vitest run, and the E2E
  files are excluded from the app/test `tsconfig`s so `tsc -b` /
  `npm run typecheck:test` never compile them.

## Layout

| File           | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `fixtures.ts`  | Shared env-gating: `e2eEnabled`, `e2eEnv`, `skipIfE2EDisabled` |
| `smoke.e2e.ts` | Minimal placeholder proving the harness is wired up            |
| _(41.2–41.4)_  | The eight real flows, added in a later wave                    |

## Environment variables (env-gating)

The suite is gated exactly like the live-RLS integration tests
(`src/db/rls.*.test.ts`): it runs only when a real target is configured, and
otherwise **skips cleanly** (never fake-passes). All names are Node-side (no
`VITE_` prefix), so nothing leaks into a browser bundle.

| Variable                | Required | Purpose                                                                                                                     |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`          | yes      | Base URL of the running SPA to drive (Vercel preview / prod / local `vite preview`). Also used as Playwright `use.baseURL`. |
| `E2E_SUPABASE_URL`      | yes      | Supabase project URL the target is backed by (seeding / state).                                                             |
| `E2E_SUPABASE_ANON_KEY` | yes      | Anon key for that project (RLS-gated; not a secret).                                                                        |
| `CI`                    | no       | When set, enables retries and `forbidOnly`.                                                                                 |

When any required variable is absent, `e2eEnabled` is `false` and every spec
skips with a clear reason. This is the expected state in the sandbox and in a
fresh CI job without secrets.

## Running

Browsers are **not** bundled in the sandbox and must be installed once per
environment (an ops step — do NOT run this in the sandbox):

```sh
npx playwright install chromium
```

Then, with the environment configured against a **disposable test deployment**
(never production):

```sh
export E2E_BASE_URL="https://<your-preview-deployment>"
export E2E_SUPABASE_URL="https://<ref>.supabase.co"
export E2E_SUPABASE_ANON_KEY="<anon-key>"

npm run e2e          # headless
npm run e2e:headed   # headed (visible browser)
```

Reports: a `list` reporter prints to the console and a JSON report is written to
`test-results/e2e-results.json` (Req 26.3).

Without those env vars, `npm run e2e` still exits successfully — the suite
simply reports as skipped.
