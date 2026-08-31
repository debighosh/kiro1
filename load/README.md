# MSS LivePulse — Load Testing

This directory contains the [k6](https://k6.io) load-test script for MSS LivePulse
(`load/livepulse-load.js`) and the documentation you need to run it, interpret the
results, and decide whether the platform may legitimately claim support for
**500 concurrent participants**.

> **Requirements:** 26.5 (the script), **26.6** (documented configuration,
> bottlenecks, and measured limits), **26.7** (the 500-user claim gate).

---

## 1. Overview

The load test simulates a realistic MSS LivePulse event under sustained concurrency:

- **Concurrent audience Participants** (default **500**) hammering the live
  participant surface. Each virtual user (VU) resolves/joins the event once, then
  runs a mix of the real write paths — casting votes, responding to a poll,
  responding to a word cloud, and occasionally submitting a question. Every
  mutation hits the **real Supabase RPC surface**
  (`POST {SUPABASE_URL}/rest/v1/rpc/<fn>` with the anon key), exactly as the SPA
  does — the client never writes tables directly.
- **Presenter / moderator Realtime clients** (a smaller pool) that open a Supabase
  Realtime WebSocket, send the Phoenix `phx_join` for the event's per-event topic,
  and hold the socket open receiving broadcasts — modelling the projector and
  moderation live views.

**k6 is a separate binary, not an npm package.** The script is executed by the
standalone `k6` runtime, which provides its own module registry (`k6`, `k6/http`,
`k6/ws`, `k6/metrics`, `k6/data`, `k6/crypto`). Do **not** add k6 to
`package.json` and do **not** try to run the script under Node. The `load/`
directory is intentionally excluded from the JS toolchain (ESLint `ignores`,
`.prettierignore`), and Vitest only globs `src/**`.

For provisioning a Supabase project, environment variables, and deploying a target
to test against, see [`docs/deployment.md`](../docs/deployment.md).

---

## 2. Prerequisites

Before running the load test you need:

1. **The k6 binary installed.** Install it from the official
   [k6 installation docs](https://grafana.com/docs/k6/latest/set-up/install-k6/)
   (packages exist for macOS, Linux, Windows, and Docker). Confirm with
   `k6 version`.
2. **A hosted, disposable target** — a deployed MSS LivePulse instance and its own
   Supabase project provisioned per [`docs/deployment.md`](../docs/deployment.md).
   **Never point the load test at production.** Load testing generates large
   volumes of synthetic questions, votes, and responses and will trip rate limits;
   use a throwaway project you can reset.
3. **A live event with a known `EVENT_CODE`.** The anon key can only read a **live**
   event (enforced by RLS), so the target event must be created and set live before
   the run. To exercise the interaction paths beyond join + submit, also capture:
   - `QUESTION_ID` — an approved/featured question to vote on.
   - `POLL_ID` + `OPTION_ID` — an open poll and one of its option ids.
   - `WORD_CLOUD_PROMPT_ID` — an open word-cloud prompt.

   Any path whose ids are omitted is simply skipped; join + occasional question
   submission always run.

---

## 3. Configuration (`__ENV` variables)

Every parameter is read from k6's `__ENV`, supplied with `-e KEY=value` (or as an
environment variable). This table matches the script exactly.

| Variable               | Required?    | Default | Purpose                                                                                          |
| ---------------------- | ------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `SUPABASE_URL`         | **Yes**\*    | —       | Project URL, e.g. `https://<ref>.supabase.co`. Canonical name.                                   |
| `BASE_URL`             | **Yes**\*    | —       | Alias for `SUPABASE_URL`. Used only if `SUPABASE_URL` is unset.                                  |
| `SUPABASE_ANON_KEY`    | **Yes**      | —       | The public anon key (RLS-gated). Sent as `apikey` and `Authorization: Bearer`.                   |
| `EVENT_CODE`           | **Yes**      | —       | The event code/slug to join (or a raw event id). Resolved to a live event exactly like the SPA.  |
| `VUS`                  | No           | `500`   | Number of concurrent Participant VUs — the 500-user engineering target.                          |
| `DURATION`             | No           | `5m`    | Sustained hold window at the target VU count.                                                    |
| `RAMP`                 | No           | `30s`   | Ramp-up and ramp-down duration on each side of the hold.                                         |
| `QUESTION_ID`          | No           | —       | Question id to vote on. Without it, the vote path is skipped.                                    |
| `POLL_ID`              | No           | —       | Open poll id. Requires `OPTION_ID` to enable the poll-respond path.                              |
| `OPTION_ID`            | No           | —       | Poll option id to submit. Requires `POLL_ID`.                                                     |
| `WORD_CLOUD_PROMPT_ID` | No           | —       | Open word-cloud prompt id. Enables the word-cloud respond path.                                  |
| `PRESENTER_VUS`        | No           | `10`    | Number of Realtime WebSocket subscribers (presenter/moderator live views).                       |
| `PRESENTER_HOLD`       | No           | `30s`   | How long each presenter WebSocket is held open.                                                  |

\* Provide **either** `SUPABASE_URL` **or** `BASE_URL` (`SUPABASE_URL` wins if both
are set). The run fails fast in `setup()` with a clear message if `SUPABASE_URL`/
`BASE_URL`, `SUPABASE_ANON_KEY`, or `EVENT_CODE` is missing, or if `EVENT_CODE`
cannot be resolved to a live event.

---

## 4. Running the load test

### Full 500-VU gate run (defaults)

```bash
k6 run \
  -e SUPABASE_URL=https://<ref>.supabase.co \
  -e SUPABASE_ANON_KEY=<anon-key> \
  -e EVENT_CODE=demo-day-2026 \
  -e QUESTION_ID=<uuid> \
  -e POLL_ID=<uuid> -e OPTION_ID=<uuid> \
  -e WORD_CLOUD_PROMPT_ID=<uuid> \
  -e VUS=500 -e DURATION=5m \
  load/livepulse-load.js
```

This is the configuration that the 500-user claim gate (Section 6) is evaluated
against: 500 concurrent participant VUs ramped up over `RAMP`, held for `DURATION`,
then ramped down, alongside `PRESENTER_VUS` Realtime subscribers.

### Smaller smoke run

Validate wiring and the target before committing to a full run:

```bash
k6 run \
  -e SUPABASE_URL=https://<ref>.supabase.co \
  -e SUPABASE_ANON_KEY=<anon-key> \
  -e EVENT_CODE=demo-day-2026 \
  -e QUESTION_ID=<uuid> \
  -e VUS=50 -e DURATION=1m \
  load/livepulse-load.js
```

### Pointing at the target

The target is defined entirely by `SUPABASE_URL`/`BASE_URL` + `SUPABASE_ANON_KEY` +
`EVENT_CODE`. Point the run at a different hosted target simply by changing those
values — no code edits are required.

### Where results land

- **stdout** — an end-of-run summary printed by the script's `handleSummary()`,
  highlighting the gate-relevant numbers (per-operation P50/P95, error rates,
  Realtime connect rate, max sustained VUs, and rate-limited count).
- **`load/summary.json`** — a machine-readable dump of all k6 metrics, written by
  `handleSummary()` so the results template (Section 7) can be filled in from the
  raw numbers. (Passing `--summary-export=load/summary.json` to `k6 run` produces
  an equivalent file.)

---

## 5. Interpreting results / metrics

The script emits custom metrics in addition to k6's built-ins. k6 automatically
reports `p(50)`/`p(95)`/`avg`/`min`/`max` for every Trend and the `rate` for every
Rate metric.

### Per-operation response-time Trends (ms)

Each operation records its response time into its own Trend, giving the required
**P50** (median) and **P95** per simulated operation:

| Metric                          | Operation                                              |
| ------------------------------- | ------------------------------------------------------ |
| `op_join_duration`              | Join — resolve the live event row (once per VU).       |
| `op_submit_question_duration`   | `submit_question` RPC (occasional, ~10% of iterations).|
| `op_vote_duration`              | `cast_question_vote` RPC (frequent).                   |
| `op_poll_respond_duration`      | `submit_poll_response` RPC.                            |
| `op_word_cloud_respond_duration`| `submit_word_cloud_response` RPC.                      |

Volumes for each are also counted (`op_join_count`, `op_submit_question_count`,
`op_vote_count`, `op_poll_respond_count`, `op_word_cloud_respond_count`).

### Error rate — semantic vs transport

There are **two** error signals, and they mean different things:

- **`op_error_rate`** (Rate) — the **semantic** error rate across participant
  operations. This is the number that matters for the gate. A rate-limited response
  is **excluded** — only genuine failures (transport errors, 5xx, unexpected
  non-rate-limit rejections) count.
- **`http_req_failed`** (k6 built-in Rate) — the raw transport-level failure rate.
  Note that PostgREST maps a rate-limit rejection to a 4xx, which does **not** count
  here either (4xx is not a transport failure).

### Rate-limited responses are expected under load

The submit/vote/poll/word-cloud RPCs enforce per-participant rate limits (submit
10/60s; vote, poll, and word-cloud 30/60s). Under heavy synthetic load a fraction
of requests will legitimately come back rate-limited. PostgREST returns these as a
well-formed 4xx carrying a `rate_limited` signal in the body, so they are an
**expected** outcome — counted distinctly in the **`op_rate_limited`** Counter and
**not** scored as errors against the gate. A high `op_rate_limited` count is normal
at 500 VUs and does not fail the run.

### Realtime and concurrency metrics

- **`realtime_ws_connect_success`** (Rate) — fraction of presenter/moderator WebSocket
  subscriptions that opened and received an `ok` `phx_reply` to their `phx_join`.
  `realtime_ws_connections` counts the total attempted.
- **`max_sustained_participants`** (Gauge) — the maximum active participant VU count
  actually achieved during the run, pushed each iteration so the summary captures it
  explicitly (Req 26.6, "maximum sustained concurrent-user count achieved").

---

## 6. The 500-user claim gate (Req 26.7)

**The platform may claim support for 500 concurrent participants ONLY when a hosted
500-VU run holds BOTH of the following for every measured operation:**

- **Error rate ≤ 1%** — `op_error_rate` < 0.01 **and** `http_req_failed` < 0.01.
- **P95 ≤ 2000 ms** — `p(95)` < 2000 for every `op_*_duration` Trend.

These thresholds are **encoded directly in the script's `thresholds`**, so a run
that breaches them makes `k6 run` **exit non-zero** — the gate is machine-checkable,
not a manual judgement. The script also asserts
`realtime_ws_connect_success` > 0.95 for presenter/moderator subscriptions.

Until a **hosted** run passes this gate at 500 VUs, **"500 concurrent participants"
is an engineering target only** — the platform must not claim 500-user support (Req
22 preamble; Req 26.7). Record the outcome using the template below and keep the
`load/summary.json` from the passing run as evidence.

---

## 7. Results template (Req 26.6)

Copy the block below and fill it in for each recorded run. Pull the numbers from the
stdout summary or `load/summary.json`.

```markdown
### Load-test run — <date>

- **Date:** YYYY-MM-DD
- **Target URL:** https://<ref>.supabase.co
- **Event code:** <EVENT_CODE>
- **VUs (participants):** <e.g. 500>
- **Duration:** <e.g. 5m> (ramp <RAMP> each side)
- **Presenter VUs:** <PRESENTER_VUS>
- **Max sustained concurrent users:** <max_sustained_participants>
- **Realtime connect success:** <realtime_ws_connect_success %>
- **Rate-limited responses (expected):** <op_rate_limited count>

| Operation          | P50 (ms) | P95 (ms) | Error rate (%) | Notes |
| ------------------ | -------- | -------- | -------------- | ----- |
| join               |          |          |                |       |
| submit_question    |          |          |                |       |
| vote               |          |          |                |       |
| poll_respond       |          |          |                |       |
| word_cloud_respond |          |          |                |       |
| realtime           | —        | —        |                | WS connect success %; not a duration Trend |

- **Gate result (500 VUs, error ≤ 1% AND P95 ≤ 2000 ms for every op):** PASS / FAIL
- **Identified bottlenecks:** <e.g. vote RPC P95 climbed past 2000 ms above 400 VUs; DB CPU saturated>
- **Measured limit:** <if the gate FAILED, the maximum VU count that DID pass the gate — e.g. "held at 350 VUs">
```

> Fill the `realtime` row's error-rate column from
> `realtime_ws_connect_success` (report it as connect success, or `100% − success`
> as the failure rate). If a path was not configured for the run (e.g. no
> `POLL_ID`), mark its row **n/a** — the script does not fail the gate for an
> unconfigured path.

---

## 8. Troubleshooting

- **Almost every request comes back `rate_limited`.** Expected in moderation, but if
  it dominates: the synthetic load is concentrating on too few participant identities
  or exceeding the per-participant limits. Spread load across more VUs (each VU uses a
  stable, distinct participant identifier), lengthen the think-time, or raise the RPC
  rate limits on the disposable target for the duration of the test. Remember these
  are counted in `op_rate_limited`, not as errors.
- **`setup()` fails: "Could not resolve a LIVE event".** The `EVENT_CODE` is wrong,
  the event is not set live, or the anon key belongs to a different project. Confirm
  the event exists and is live, and that `SUPABASE_URL` + `SUPABASE_ANON_KEY` point
  at the same project.
- **`setup()` fails: "Missing required env".** Supply `SUPABASE_URL` (or `BASE_URL`),
  `SUPABASE_ANON_KEY`, and `EVENT_CODE` via `-e KEY=value`.
- **WebSocket handshakes fail (`realtime_ws_connect_success` low, no `101`).** Check
  that the anon key is correct and that **Realtime is enabled** for the target
  Supabase project and the relevant tables. A firewall/proxy blocking `wss://` will
  also prevent the handshake.
- **P95 breaches the 2000 ms gate.** Inspect which `op_*_duration` Trend is high,
  reduce `VUS` to find the maximum that passes (record it as the measured limit), and
  investigate the corresponding backend path (DB indexes, connection pool, Supabase
  compute tier — see [`docs/deployment.md`](../docs/deployment.md)).
