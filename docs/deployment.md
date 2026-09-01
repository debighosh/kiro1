# MSS LivePulse — Deployment and Rollback Guide

This document describes how to deploy MSS LivePulse to a production (or
staging) environment and how to roll back a bad release. It is written for an
operator with a Supabase project and the Supabase CLI; the commands here are
run against real managed infrastructure, not the local sandbox.

The architecture is: a **React SPA** (built by Vite, hosted as static assets)
backed by **Supabase managed services** — PostgreSQL with Row Level Security
(RLS), Realtime, Auth, and **Edge Functions** for privileged mutations, rate
limiting, and the AI Gateway. All client traffic is served over HTTPS/TLS ≥ 1.2
(Req 21.1, 21.2).

- Design reference: `.kiro/specs/mss-livepulse/design.md` → _Deployment and
  Environment_ and _Server-Side AI Gateway Design_.
- Requirements references: Req 21.8 (no secret leakage / sanitised errors) and
  Req 26 (testing and load validation, in particular Req 26.5–26.7).

---

## 1. Overview and prerequisites

You need:

- A **Supabase project** (managed PostgreSQL + Auth + Realtime + Edge
  Functions).
- The **Supabase CLI** installed and authenticated (`supabase login`) and the
  local repo linked to the project (`supabase link --project-ref <ref>`). See
  the [Supabase CLI docs](https://supabase.com/docs/guides/cli).
- **Node.js ≥ 22** (enforced by `engines` in `package.json`) and this
  repository checked out.
- A static host for the built SPA (for example Vercel) capable of serving the
  Vite `dist/` output over HTTPS with an SPA fallback to `index.html`.

Install dependencies once:

```bash
npm ci
```

The Supabase directory layout used below:

```
supabase/
├── config.toml     # local-dev configuration
├── seed.sql        # demo seed data
├── migrations/     # SQL migrations, applied in filename order
└── functions/      # Edge Functions (_shared/ + one dir per function)
```

---

## 2. Environment variables and secrets

MSS LivePulse separates **client build-time** variables (safe for the browser
bundle, `VITE_`-prefixed, non-secret only) from **server-side secrets** that
must never reach client code (Req 21.8). The client env loader
(`src/lib/env.ts`) enforces this at runtime: it reads only `VITE_`-prefixed
values and throws if any code references a forbidden server-only secret name.

A committed **`.env.example`** documents the variable names (no values). Copy it
to `.env` / `.env.local` for local development; real `.env*` files are
git-ignored.

### Client build-time variables (SPA)

These are read via `import.meta.env` at build time and embedded in the browser
bundle. They must contain **non-secret** values only. The exact names come from
`src/lib/env.ts` and `src/lib/supabaseClient.ts`:

| Variable                 | Where set          | Secret? | Purpose                                                                                   |
| ------------------------ | ------------------ | ------- | ----------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`      | Frontend build env | No      | Supabase project URL exposed to the browser client.                                       |
| `VITE_SUPABASE_ANON_KEY` | Frontend build env | No      | Supabase anon key for RLS-gated public client access (not a secret; RLS is the boundary). |

If either required `VITE_*` variable is missing at startup, the app throws an
`EnvConfigError` rather than starting in a misconfigured state.

### Server / Edge Function and CLI variables

These are set in the Supabase Edge Function environment (via
`supabase secrets set`) and/or the deploy shell. **Server-only** secrets must
never be exposed to the browser or referenced from client code.

| Variable                       | Where set                              | Secret?   | Purpose                                                                                                    |
| ------------------------------ | -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                 | Edge Function env / CLI                | No        | Supabase project URL used server-side by the admin and anon clients.                                       |
| `SUPABASE_ANON_KEY`            | Edge Function env                      | No        | Anon key the functions use to verify the caller's session (fail-closed if unset).                          |
| `SUPABASE_SERVICE_ROLE_KEY`    | **Edge Function secret — server only** | **Yes**   | Service-role key for privileged writes. **Bypasses RLS.** Never expose client-side or log it (Req 21.8).   |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | **Edge Function secret — server only** | **Yes**   | Base64 32-byte AES-256-GCM (AEAD) key used to encrypt stored AI provider credentials at rest (Req 12.5).   |
| `AI_ENDPOINT_ALLOWLIST`        | **Edge Function secret — server only** | **Yes**\* | SSRF allow-list (comma/whitespace-separated hosts/IPs) restricting AI egress destinations (Req 13.8).      |
| `PUBLIC_SITE_URL`              | Edge Function env (`create-event`)     | No        | Public SPA base URL used to build audience/presenter/QR URLs; falls back to request origin when unset.     |
| `CORS_ALLOWED_ORIGINS`         | Edge Function env                      | No        | Comma-separated allow-list of SPA origins permitted to call the functions; echoes request origin if unset. |

\* `AI_ENDPOINT_ALLOWLIST` is not sensitive material itself, but it is a
server-side security control and is managed alongside the other function
secrets.

**Secret-handling rules (Req 21.8):**

- `SUPABASE_SERVICE_ROLE_KEY`, `AI_CREDENTIAL_ENCRYPTION_KEY`, and
  `AI_ENDPOINT_ALLOWLIST` are the three names the client env loader forbids;
  they exist only in the Supabase/host server environment.
- Secrets are **never logged**. Only variable **names** (never values) may
  appear in errors or logs.
- Error responses returned to clients are **sanitised** — provider errors,
  stack traces, and secret material are stripped before any response leaves the
  server.

---

## 3. Database: applying migrations

Migrations live in `supabase/migrations/` and build the entire schema from
scratch (enums, tables, indexes, constraints, RLS policies, and RPC functions),
so a fresh environment can be provisioned reproducibly.

**Ordering convention.** Migrations are applied in **byte-lexicographic
filename order**, using the `20260101NNNNNN_<description>.sql` naming
convention. The migrations range from `20260101000001_enums.sql` through the
current latest, **`20260101000035_rate_limit_actions.sql`**. Because the naming
sorts lexicographically, do not renumber existing files — always add new
migrations with a higher number.

Apply migrations to the linked project:

```bash
# Push local migrations that have not yet been applied to the linked project
supabase db push
```

Alternatively, step migrations up explicitly:

```bash
supabase migration up
```

Optionally load the demo seed data (a `draft` demo event with
`moderation_mode = 'pre'`, sample poll/word-cloud prompts, and a presenter
token) for a fresh environment:

```bash
supabase db reset   # re-runs all migrations then applies seed.sql — DESTRUCTIVE
```

> `supabase db reset` drops and recreates the database. Never run it against a
> production project that holds real data.

**Security model.** RLS is **default-deny** on all client-exposed tables (Req
21.3–21.5). Anonymous clients may only read/write data for events that are
active, and all Administrator mutations flow through authenticated policies or
the server-side Edge Functions (Req 21.6). Verify RLS is enabled on every
client-exposed table after migrating.

---

## 4. Edge Functions

The repository defines the following Edge Functions under
`supabase/functions/` (the `_shared/` directory holds shared helpers and is not
a deployable function):

| Function                  | Uses service role | Uses AI encryption key | Uses AI allow-list | Purpose                                                                    |
| ------------------------- | ----------------- | ---------------------- | ------------------ | -------------------------------------------------------------------------- |
| `create-event`            | Yes               | No                     | No                 | Creates an event and derives audience/presenter/QR URLs.                   |
| `moderate-question`       | Yes               | No                     | No                 | Approves / features / hides questions (privileged write).                  |
| `transition-event-status` | Yes               | No                     | No                 | Transitions event status (draft → live → ended → archived).                |
| `ai-gateway`              | Yes               | Yes                    | Yes                | Server-side AI operations; encrypts credentials; enforces SSRF allow-list. |

All four functions build a service-role Supabase client via the shared
`_shared/supabaseAdmin.ts` helper, which requires `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. Only `ai-gateway` additionally uses
`AI_CREDENTIAL_ENCRYPTION_KEY` (credential AEAD) and `AI_ENDPOINT_ALLOWLIST`
(SSRF egress control).

### Set function secrets

Set secrets once (they apply to all functions in the project):

```bash
supabase secrets set \
  SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
  AI_CREDENTIAL_ENCRYPTION_KEY="<base64-32-byte-key>" \
  AI_ENDPOINT_ALLOWLIST="api.openai.com,<other-approved-hosts>" \
  PUBLIC_SITE_URL="https://<your-spa-domain>" \
  CORS_ALLOWED_ORIGINS="https://<your-spa-domain>"
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are provided to functions by the
platform for the linked project; confirm they are present in the function
environment.

### Deploy each function

```bash
supabase functions deploy create-event
supabase functions deploy moderate-question
supabase functions deploy transition-event-status
supabase functions deploy ai-gateway
```

After deploying, smoke-test that the functions respond and that
CORS/`CORS_ALLOWED_ORIGINS` correctly reflects your SPA origin.

---

## 5. Frontend (SPA)

Build the SPA with the required `VITE_*` variables present in the build
environment:

```bash
VITE_SUPABASE_URL="https://<ref>.supabase.co" \
VITE_SUPABASE_ANON_KEY="<anon-key>" \
npm run build
```

`npm run build` runs `tsc -b && vite build` and emits static assets to `dist/`.
Host `dist/` on your static host with:

- HTTPS enabled and HTTP → HTTPS redirect (Req 21.1, 21.2).
- SPA fallback routing (unknown paths served `index.html`) for client-side
  routes.
- The build-time `VITE_*` values baked in — rebuild to change them.

Never place any server-only secret into a `VITE_*` variable; only the
non-secret URL and anon key belong in the client bundle.

---

## 6. Testing in a deployed environment

Before claiming production readiness, validate the deployed environment with the
end-to-end and load suites (Req 26).

### Unit / integration suite

```bash
npm run test            # vitest run — full suite, machine-readable results
npm run test:coverage   # with coverage (Req 26.1 target: ≥ 80% line coverage)
```

### End-to-end (Playwright)

The E2E suite (under `e2e/`, run via Playwright — `npm run e2e`, or
`npm run e2e:headed`) exercises the full flows required by Req 26.4:
create/launch an event, join and submit a question, approve/feature, concurrent
voting with updating counts, poll and word-cloud responses, presenter mode
switching, and ending/exporting an event. See `e2e/README.md` for details.

Browsers are not bundled by default and must be installed once per environment
(an ops step):

```bash
npx playwright install chromium
```

The suite is **env-gated**: it drives a deployed, running SPA against a real
Supabase project and **skips cleanly** when the target env vars are absent
(never fake-passing). Point it at a **disposable test deployment** (never
production) using the Node-side (non-`VITE_`) names from `e2e/README.md`:

```bash
export E2E_BASE_URL="https://<your-preview-deployment>"
export E2E_SUPABASE_URL="https://<ref>.supabase.co"
export E2E_SUPABASE_ANON_KEY="<anon-key>"

npm run e2e          # headless
npm run e2e:headed   # headed (visible browser)
```

A `list` reporter prints to the console and a machine-readable JSON report is
written to `test-results/e2e-results.json` (Req 26.3).

### Load test (k6)

Req 26.5 requires a load-test script that simulates a configurable number of
Participants (default **500 concurrent**) performing joins, concurrent question
submissions, concurrent votes, poll responses, word-cloud responses, and
presenter/moderator realtime subscriptions. Run the k6 script against a
disposable test deployment (never production), parameterising the virtual-user
count and pointing it at the target SPA and Supabase project. A typical
invocation looks like:

```bash
k6 run --vus 500 --duration 5m \
  -e BASE_URL="https://<your-test-deployment>" \
  -e SUPABASE_URL="https://<ref>.supabase.co" \
  -e SUPABASE_ANON_KEY="<anon-key>" \
  <path-to-k6-load-script>
```

**500-user claim gate (Req 26.6–26.7).** Record, per simulated operation, the
P50 and P95 response times (ms), the error rate (%), and the maximum sustained
concurrent-user count. The environment may claim support for 500 concurrent
users **only if** the 500-user run achieves an **error rate ≤ 1%** and a **P95
≤ 2000 ms**. If either threshold is missed, do not claim 500-user support;
document the measured limit and bottlenecks instead.

---

## 7. Rollback procedure

Have a rollback path ready before every release. Roll back in the reverse order
of deploy where the change touched multiple layers.

### 7.1 Schema / migration rollback

Migrations are **forward-only** by naming convention, so plan rollback
deliberately:

- **Prefer a pre-deploy backup.** Take a database backup / snapshot (or note the
  last-applied migration, e.g. `20260101000035_rate_limit_actions.sql`) before
  applying new migrations. To roll back, restore from that known-good backup
  point.
- **Down migrations.** Where a migration ships a corresponding down step, revert
  it with `supabase migration down` (stepping back the most recent migrations).
  Only rely on this when the down logic is known to be complete and tested.
- **Caution with destructive changes.** A migration that drops columns/tables or
  rewrites data cannot be undone by re-running SQL — restoring from the backup
  is the only safe path. Never run `supabase db reset` against production to
  "undo" a migration; it destroys all data.
- After rollback, re-verify that RLS remains enabled on all client-exposed
  tables.

### 7.2 Edge Function rollback

- **Redeploy the previous version.** Check out the previous known-good commit
  (or `git revert` the offending change) and redeploy the affected function:

  ```bash
  git checkout <last-good-commit> -- supabase/functions/<name>
  supabase functions deploy <name>
  ```

- Roll back only the function(s) that changed (`create-event`,
  `moderate-question`, `transition-event-status`, or `ai-gateway`).
- If the rollback involves secrets, re-assert the correct values with
  `supabase secrets set`; never log the values while doing so.

### 7.3 Frontend rollback

- **Redeploy the previous static build.** Re-run `npm run build` from the
  last-good commit (with the correct `VITE_*` values) and publish that `dist/`,
  or use the host's built-in "promote previous deployment" feature to instantly
  revert to the prior SPA version.

---

## 8. Security checklist

Confirm all of the following before and after each deploy:

- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set only server-side (Edge Function
      secrets) and never appears in any `VITE_*` variable or the client bundle —
      it bypasses RLS.
- [ ] `AI_CREDENTIAL_ENCRYPTION_KEY` is a valid base64 32-byte key, stored only
      as a server secret, and is **rotated** on a defined schedule and on any
      suspected exposure.
- [ ] `AI_ENDPOINT_ALLOWLIST` lists only approved AI egress destinations; verify
      it is correct so the AI Gateway's SSRF protection cannot be bypassed.
- [ ] RLS is enabled (default-deny) on 100% of client-exposed tables; anonymous
      access is limited to active events only.
- [ ] Error responses are sanitised: no secrets, provider errors, or stack
      traces leak to clients or logs (Req 21.8).
- [ ] `CORS_ALLOWED_ORIGINS` is pinned to the real SPA origin(s) in production.
- [ ] All client traffic is HTTPS/TLS ≥ 1.2 with HTTP redirected to HTTPS.
