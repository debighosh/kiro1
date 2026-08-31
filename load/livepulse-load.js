/*
 * =============================================================================
 * MSS LivePulse — k6 load-test script  (Task 42.1; Req 26.5, 26.6, 26.7, 23.9)
 * =============================================================================
 *
 * WHAT THIS SIMULATES
 * -------------------
 * A configurable number of concurrent audience Participants (default 500)
 * hammering the LIVE participant surface of an MSS LivePulse event, plus a
 * small pool of Presenter/Moderator clients holding open Realtime WebSocket
 * subscriptions. Concretely, over a sustained window each virtual Participant:
 *
 *   1. JOINS the event  — resolves the event by its Event_Code (slug) exactly
 *      as the audience join flow does (src/lib/eventLookup.ts): a PostgREST
 *      read of the `events` table filtered to the code. Done once per VU and
 *      cached, mirroring how a real browser resolves the event on landing.
 *   2. SUBMITS QUESTIONS (occasionally) via the `submit_question` RPC
 *      (supabase/migrations/20260101000014_submit_question_rpc.sql).
 *   3. CASTS VOTES (frequently) via the `cast_question_vote` RPC
 *      (…000015_vote_rpc.sql) against a configured question id.
 *   4. RESPONDS TO A POLL (if POLL_ID + OPTION_ID given) via the
 *      `submit_poll_response` RPC (…000027_poll_respond_rpc.sql).
 *   5. RESPONDS TO A WORD CLOUD (if WORD_CLOUD_PROMPT_ID given) via the
 *      `submit_word_cloud_response` RPC (…000026_word_cloud_respond_rpc.sql).
 *
 * A separate, smaller `presenters` scenario opens a Supabase Realtime WebSocket
 * (k6/ws), sends the Phoenix `phx_join` for the event's per-event topic, and
 * holds the socket open receiving broadcasts — modelling the presenter and
 * moderator live views (Req 26.5 "presenter and moderator realtime
 * subscriptions").
 *
 * All write paths hit the REAL Supabase RPC surface: the SPA never writes the
 * tables directly — every mutation is a `supabase.rpc('<fn>', {...})` call,
 * which maps on the wire to:
 *
 *     POST {SUPABASE_URL}/rest/v1/rpc/<fn>
 *     apikey: <anon>
 *     Authorization: Bearer <anon>
 *     Content-Type: application/json
 *     body: { "p_...": ... }   (the p_* argument names come from the migrations)
 *
 * so this script constructs those exact requests (see rpcPost()).
 *
 * -----------------------------------------------------------------------------
 * k6 IS A SEPARATE BINARY — NOT AN npm PACKAGE
 * -----------------------------------------------------------------------------
 * This file is a k6 script, not Node/Vite/Vitest code. It is executed by the
 * standalone `k6` binary (https://k6.io), which provides its own module
 * registry: the `k6`, `k6/http`, `k6/ws`, `k6/metrics`, `k6/data`, and
 * `k6/crypto` specifiers below are resolved by the k6 runtime, NOT by Node.
 * They are therefore intentionally UNRESOLVABLE by Node/tsc/eslint/prettier,
 * and this file is deliberately EXCLUDED from the JS toolchain:
 *   - ESLint: `load` is added to `ignores` in eslint.config.js (mirroring how
 *     `supabase/functions` — Deno/Edge code — is ignored).
 *   - Prettier: `load/` is added to .prettierignore (k6 runtime globals like
 *     `__ENV`, `__VU`, `__ITER` and the k6 module imports are not Node code).
 *   - Vitest only globs `src/**`, so `load/**` is never collected as a test.
 * Do NOT add k6 to package.json — it is not an npm dependency. Do NOT try to
 * run this under Node; run it with the k6 binary (see USAGE).
 *
 * -----------------------------------------------------------------------------
 * ENVIRONMENT PARAMETERS  (all via k6 `__ENV`, i.e. `-e KEY=value` or env vars)
 * -----------------------------------------------------------------------------
 *   SUPABASE_URL   | BASE_URL   (required)  Project URL, e.g.
 *                                           https://abcd1234.supabase.co
 *   SUPABASE_ANON_KEY          (required)   The public anon key (RLS-gated).
 *   EVENT_CODE                 (required)   The Event_Code (slug) to join, OR a
 *                                           raw event id. Used to resolve the
 *                                           live event exactly like the SPA.
 *   VUS                        (default 500) Concurrent Participant VUs — the
 *                                           500-user engineering target.
 *   DURATION                   (default 5m)  Sustained load window.
 *   RAMP                       (default 30s) Ramp-up/ramp-down each side.
 *   QUESTION_ID                (optional)   Approved/featured question id to
 *                                           vote on. Without it, votes are
 *                                           skipped (join+submit still run).
 *   POLL_ID + OPTION_ID        (optional)   Open poll + one of its option ids;
 *                                           enables the poll-respond path.
 *   WORD_CLOUD_PROMPT_ID       (optional)   Open word-cloud prompt id; enables
 *                                           the word-cloud respond path.
 *   PRESENTER_VUS              (default 10)  Realtime WS subscribers (presenter
 *                                           /moderator live views).
 *   PRESENTER_HOLD            (default 30s)  How long each WS is held open.
 *
 * -----------------------------------------------------------------------------
 * THE 500-USER CLAIM GATE  (Req 23.9, 26.7 — referenced by task 42.2's README)
 * -----------------------------------------------------------------------------
 * The platform does NOT claim 500-concurrent-user support until a HOSTED
 * configuration passes THIS load test at 500 VUs with BOTH:
 *     • overall error rate  ≤ 1%   (http_req_failed < 0.01 AND op_error_rate < 0.01)
 *     • per-operation P95    ≤ 2000 ms  (each op_*_duration Trend: p(95)<2000)
 * These are encoded as k6 `thresholds` below, so a failing run makes `k6 run`
 * exit non-zero — the gate is machine-checkable, not a manual judgement. Until
 * a hosted run passes this gate, "500 concurrent" is an engineering target only
 * (Req 22 preamble; design "Load test — 500-user caveat"). Task 42.2's README
 * documents how to run this and how to read the P50/P95/error-rate/max-VU
 * results captured here (Req 26.6).
 *
 * IMPORTANT — RATE LIMITING IS EXPECTED UNDER LOAD, NOT A HARD FAILURE.
 * The submit/vote/poll/word-cloud RPCs enforce per-participant rate limits
 * (submit 10/60s, vote/poll/word-cloud 30/60s). Under heavy synthetic load a
 * fraction of requests will legitimately come back rate-limited. PostgREST maps
 * a raised RPC exception to HTTP 400 with the signal string (`rate_limited`,
 * etc.) in the body, so a rate-limited response is a WELL-FORMED, EXPECTED
 * outcome — it is counted in a dedicated `op_rate_limited` Counter and is NOT
 * scored as an error against the gate. Only transport failures, 5xx, and
 * unexpected non-rate-limit rejections count against the error Rate / gate.
 *
 * -----------------------------------------------------------------------------
 * RESULTS  (Req 26.6 — P50/P95 ms, error rate %, max sustained concurrency)
 * -----------------------------------------------------------------------------
 * k6's end-of-run summary already reports p(50)/p(95)/avg/max for every custom
 * Trend and the rate for every Rate metric. In ADDITION this script exports a
 * machine-readable `load/summary.json` via `handleSummary()` so task 42.2's
 * results template / README can ingest the numbers directly. You may also pass
 * `--summary-export=load/summary.json` to `k6 run`; either works.
 *
 * -----------------------------------------------------------------------------
 * USAGE  (run with the k6 binary — NOT npm)
 * -----------------------------------------------------------------------------
 *   k6 run \
 *     -e SUPABASE_URL=https://<ref>.supabase.co \
 *     -e SUPABASE_ANON_KEY=<anon> \
 *     -e EVENT_CODE=demo-day-2026 \
 *     -e QUESTION_ID=<uuid> \
 *     -e POLL_ID=<uuid> -e OPTION_ID=<uuid> \
 *     -e WORD_CLOUD_PROMPT_ID=<uuid> \
 *     -e VUS=500 -e DURATION=5m \
 *     load/livepulse-load.js
 *
 * NOTE: there is no live target or k6 binary in the spec sandbox, so this
 * script is authored/committed but NOT executed here.
 *
 * Requirements: 26.5, 26.6, 26.7, 23.9.
 * Design: Testing Strategy → "Load test — k6"; Technology Stack (Load testing);
 *         Non-functional (Realtime performance targets, Req 23.1/23.4).
 * =============================================================================
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, fail } from 'k6';
import { Trend, Rate, Counter, Gauge } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import crypto from 'k6/crypto';

// -----------------------------------------------------------------------------
// Environment parameterisation. Reads are done ONCE at module scope so the
// values are shared across VUs. We DO NOT throw at import time (that would break
// even a `k6 inspect`/static parse); required-env validation happens in setup()
// which fails the run fast with a clear message if the target is missing.
// -----------------------------------------------------------------------------
const ENV = __ENV;

/** Trim + fall back to a default; returns '' for a missing/blank value. */
function envStr(name, fallback = '') {
  const v = ENV[name];
  if (v === undefined || v === null) return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

/** Parse a positive integer env with a default; ignores garbage. */
function envInt(name, fallback) {
  const raw = envStr(name);
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// SUPABASE_URL is the canonical name; BASE_URL is accepted as an alias so the
// script matches both the design's env table and the generic k6 convention.
const SUPABASE_URL = (envStr('SUPABASE_URL') || envStr('BASE_URL')).replace(
  /\/+$/,
  '',
);
const SUPABASE_ANON_KEY = envStr('SUPABASE_ANON_KEY');
const EVENT_CODE = envStr('EVENT_CODE');

const VUS = envInt('VUS', 500); // 500-user engineering target (Req 26.5)
const DURATION = envStr('DURATION', '5m');
const RAMP = envStr('RAMP', '30s');

// Optional interaction targets. When absent, the relevant path is skipped so
// the script still exercises join + question submit + (if present) votes.
const QUESTION_ID = envStr('QUESTION_ID');
const POLL_ID = envStr('POLL_ID');
const OPTION_ID = envStr('OPTION_ID');
const WORD_CLOUD_PROMPT_ID = envStr('WORD_CLOUD_PROMPT_ID');

// Presenter/moderator Realtime WS subscribers — a small pool relative to VUS.
const PRESENTER_VUS = envInt('PRESENTER_VUS', 10);
const PRESENTER_HOLD = envStr('PRESENTER_HOLD', '30s');

// -----------------------------------------------------------------------------
// Custom metrics (Req 26.6). k6 automatically reports p(50)/p(95)/avg/min/max
// for every Trend in the end-of-run summary, so recording each operation's
// response time into a per-operation Trend gives us the required P50/P95 per
// simulated operation. The Rate gives the error rate; Counters give volumes;
// the Gauge tracks the max sustained concurrency actually achieved.
// -----------------------------------------------------------------------------

// Per-operation response-time Trends (ms). Each carries the P95 gate below.
const joinDuration = new Trend('op_join_duration', true);
const submitQuestionDuration = new Trend('op_submit_question_duration', true);
const voteDuration = new Trend('op_vote_duration', true);
const pollRespondDuration = new Trend('op_poll_respond_duration', true);
const wordCloudRespondDuration = new Trend(
  'op_word_cloud_respond_duration',
  true,
);

// Overall error rate across all participant operations (target < 1%). A
// rate-limited response is EXPECTED under load and is NOT counted here (see the
// header note) — only transport failures / 5xx / unexpected rejections are.
const opErrorRate = new Rate('op_error_rate');

// Per-operation volume counters (successful/attempted operations).
const joinCount = new Counter('op_join_count');
const submitQuestionCount = new Counter('op_submit_question_count');
const voteCount = new Counter('op_vote_count');
const pollRespondCount = new Counter('op_poll_respond_count');
const wordCloudRespondCount = new Counter('op_word_cloud_respond_count');

// Rate-limited responses, counted distinctly so they neither inflate the error
// rate nor hide the fact that the backend throttled under load (Req 21.13/21.14
// behaviour surfaced in the load report).
const rateLimitedCount = new Counter('op_rate_limited');

// Realtime WS subscription success (presenter/moderator live views).
const wsConnectSuccess = new Rate('realtime_ws_connect_success');
const wsConnectCount = new Counter('realtime_ws_connections');

// Max sustained concurrency actually achieved (Req 26.6). k6 also exposes a
// built-in `vus` metric, but we additionally push the current active-VU count
// into a Gauge on each iteration so the maximum is captured explicitly in the
// summary regardless of sampling.
const activeParticipants = new Gauge('max_sustained_participants');

// -----------------------------------------------------------------------------
// k6 options: scenarios + thresholds. Two scenarios run concurrently:
//   • participants — the VUS (default 500) concurrent audience Participants,
//     ramped up over RAMP, held for DURATION, ramped down over RAMP.
//   • presenters   — the small PRESENTER_VUS pool holding Realtime WS open.
// -----------------------------------------------------------------------------
export const options = {
  // Discard response bodies by default to keep memory flat at 500 VUs; the RPC
  // calls that must inspect the body (to detect rate_limited) opt back in.
  discardResponseBodies: true,

  scenarios: {
    // Concurrent Participants performing the audience interaction mix.
    participants: {
      executor: 'ramping-vus',
      exec: 'participant',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS }, // ramp up to the target concurrency
        { duration: DURATION, target: VUS }, // hold at target (sustained load)
        { duration: RAMP, target: 0 }, // ramp down
      ],
      gracefulRampDown: '10s',
      tags: { role: 'participant' },
    },

    // Presenter/moderator Realtime WebSocket subscribers (Req 26.5). Kept small
    // relative to the audience — a handful of live projector/moderator views.
    presenters: {
      executor: 'constant-vus',
      exec: 'presenter',
      vus: PRESENTER_VUS,
      duration: DURATION,
      startTime: RAMP, // start once participants are ramping, not before
      tags: { role: 'presenter' },
    },
  },

  // The 500-user claim gate (Req 26.7, 23.9), machine-checkable. A breach makes
  // `k6 run` exit non-zero.
  thresholds: {
    // Overall transport failure rate < 1% (k6 built-in). rate_limited responses
    // are 4xx-but-expected; see op_error_rate for the semantic error rate.
    http_req_failed: ['rate<0.01'],

    // Semantic error rate across participant operations < 1% (rate-limited
    // responses excluded — they are expected throttling, not errors).
    op_error_rate: ['rate<0.01'],

    // Per-operation P95 response time ≤ 2000 ms (Req 23.1/23.4, 26.7). These
    // only assert when the op ran (abortOnFail:false), so an unconfigured path
    // (e.g. no POLL_ID) does not spuriously fail the gate.
    op_join_duration: ['p(95)<2000'],
    op_submit_question_duration: ['p(95)<2000'],
    op_vote_duration: ['p(95)<2000'],
    op_poll_respond_duration: ['p(95)<2000'],
    op_word_cloud_respond_duration: ['p(95)<2000'],

    // Presenter/moderator Realtime subscriptions should overwhelmingly connect.
    realtime_ws_connect_success: ['rate>0.95'],
  },
};

// -----------------------------------------------------------------------------
// Shared, read-only word list for word-cloud responses (SharedArray keeps a
// single copy across all VUs rather than duplicating per-VU memory at 500 VUs).
// -----------------------------------------------------------------------------
const WORD_POOL = new SharedArray('words', function () {
  return [
    'innovation',
    'automation',
    'reliability',
    'scalability',
    'security',
    'latency',
    'realtime',
    'insight',
    'momentum',
    'clarity',
    'velocity',
    'resilience',
    'collaboration',
    'observability',
    'delight',
  ];
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Standard PostgREST/Supabase headers for an anon RPC or table read. */
function anonHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Generate a stable, ≥128-bit random participant identifier for THIS VU,
 * matching the shape produced by src/lib/participant.ts (16 random bytes as
 * lowercase hex). Cached per-VU in `state` so a VU reuses one identity across
 * its iterations (Req 2.4 — never regenerate once assigned).
 */
function newParticipantIdentifier() {
  // k6/crypto's randomBytes returns an ArrayBuffer of cryptographically strong
  // random bytes; 16 bytes = 128 bits of entropy (matches src/lib/participant.ts).
  return bytesToHex(crypto.randomBytes(16));
}

/** Convert an ArrayBuffer of random bytes to a lowercase hex string. */
function bytesToHex(buf) {
  const view = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** A per-attempt idempotency key (Req 23.8), like generateSubmissionKey(). */
function newSubmissionKey() {
  return bytesToHex(crypto.randomBytes(16));
}

/**
 * True if an RPC error body/response signals a rate-limit throttle. PostgREST
 * maps a raised P0001 exception to a 4xx whose JSON body carries the signal
 * string (e.g. {"message":"rate_limited", ...}). We treat that as EXPECTED.
 */
function isRateLimited(res) {
  if (!res) return false;
  const body = typeof res.body === 'string' ? res.body : '';
  return body.indexOf('rate_limited') !== -1;
}

/**
 * POST a Supabase RPC and record its duration into `trend`, its volume into
 * `counter`, and its ok/failure into the error Rate. A rate-limited response is
 * counted distinctly and treated as NON-error (expected throttling under load).
 *
 * A "success" here means: HTTP 2xx (the RPC returned a row/value). Anything
 * else that is NOT a rate-limit is a semantic error against the gate.
 */
function rpcPost(fnName, payload, trend, counter, opLabel) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const res = http.post(url, JSON.stringify(payload), {
    headers: anonHeaders(),
    // We must read the body to distinguish rate_limited from a real error.
    responseType: 'text',
    tags: { op: opLabel },
  });

  trend.add(res.timings.duration);
  counter.add(1);

  const ok = res.status >= 200 && res.status < 300;
  const limited = !ok && isRateLimited(res);

  if (limited) {
    rateLimitedCount.add(1, { op: opLabel });
  }

  // Error rate EXCLUDES expected rate-limiting: only count a genuine failure.
  opErrorRate.add(!ok && !limited, { op: opLabel });

  check(res, {
    [`${opLabel}: ok or rate-limited`]: (r) =>
      (r.status >= 200 && r.status < 300) || isRateLimited(r),
  });

  return { res, ok, limited };
}

// -----------------------------------------------------------------------------
// setup(): runs ONCE before any VU. Fails the run fast if the required target
// env is missing, and resolves the event by its Event_Code exactly like the SPA
// (src/lib/eventLookup.ts) so every VU shares the resolved event id.
// -----------------------------------------------------------------------------
export function setup() {
  const missing = [];
  if (SUPABASE_URL === '') missing.push('SUPABASE_URL (or BASE_URL)');
  if (SUPABASE_ANON_KEY === '') missing.push('SUPABASE_ANON_KEY');
  if (EVENT_CODE === '') missing.push('EVENT_CODE');
  if (missing.length > 0) {
    fail(
      `Missing required env: ${missing.join(', ')}. ` +
        'Provide them with -e KEY=value. See the file header (USAGE).',
    );
  }

  // Resolve the event by slug first (the common case), then by id if the code
  // looks like a UUID — mirroring findEventByRef() in src/lib/eventLookup.ts.
  // The anon client can only read a LIVE event (RLS), so a non-live/unknown
  // code returns no row.
  const eventId = resolveEventId(EVENT_CODE);
  if (!eventId) {
    fail(
      `Could not resolve a LIVE event for EVENT_CODE="${EVENT_CODE}". ` +
        'Ensure the event exists, is live, and the code/id is correct.',
    );
  }

  return {
    eventId,
    startedAt: Date.now(),
  };
}

/**
 * Resolve an event id from a slug (Event_Code) or a raw id via PostgREST,
 * mirroring src/lib/eventLookup.ts. Returns the id string or '' if not visible.
 */
function resolveEventId(ref) {
  const headers = anonHeaders();
  const select = 'id,name,slug,status,active_presenter_mode';

  // 1) by slug
  const bySlug = http.get(
    `${SUPABASE_URL}/rest/v1/events?slug=eq.${encodeURIComponent(
      ref,
    )}&select=${encodeURIComponent(select)}`,
    { headers, responseType: 'text' },
  );
  const slugId = firstRowId(bySlug);
  if (slugId) return slugId;

  // 2) by id (only if it looks like a UUID)
  const uuidLike =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  if (uuidLike) {
    const byId = http.get(
      `${SUPABASE_URL}/rest/v1/events?id=eq.${encodeURIComponent(
        ref,
      )}&select=${encodeURIComponent(select)}`,
      { headers, responseType: 'text' },
    );
    const idId = firstRowId(byId);
    if (idId) return idId;
  }
  return '';
}

/** Extract the `id` of the first row from a PostgREST array response. */
function firstRowId(res) {
  if (!res || res.status < 200 || res.status >= 300) return '';
  try {
    const rows = JSON.parse(res.body);
    if (Array.isArray(rows) && rows.length > 0 && typeof rows[0].id === 'string')
      return rows[0].id;
  } catch (_e) {
    // fall through to '' — treated as "not resolvable"
  }
  return '';
}

// Per-VU state, initialised lazily on the first iteration of each VU so the
// participant identity is stable for that VU across the whole run (Req 2.4).
const state = {};

// -----------------------------------------------------------------------------
// participant(): the default participant iteration. Runs a realistic mix:
//   - resolves/joins the event ONCE per VU (cached), like a browser landing;
//   - casts a vote (frequent) if a QUESTION_ID was provided;
//   - responds to the poll (if POLL_ID + OPTION_ID given);
//   - responds to the word cloud (if WORD_CLOUD_PROMPT_ID given);
//   - occasionally submits a new question;
// with think-time sleeps between actions to model human pacing.
// -----------------------------------------------------------------------------
export function participant(data) {
  const eventId = data.eventId;

  // Report current active-VU concurrency so the summary captures the max
  // sustained participant count actually achieved (Req 26.6).
  activeParticipants.add(__VU);

  // Lazy, per-VU identity + one-time join.
  if (!state[__VU]) {
    state[__VU] = {
      participantId: newParticipantIdentifier(),
      joined: false,
    };
  }
  const me = state[__VU];

  // 1) JOIN — resolve the event view once per VU (cached). Models the audience
  //    landing read of the live event row.
  if (!me.joined) {
    const headers = anonHeaders();
    const select = 'id,name,slug,status,active_presenter_mode';
    const res = http.get(
      `${SUPABASE_URL}/rest/v1/events?id=eq.${encodeURIComponent(
        eventId,
      )}&select=${encodeURIComponent(select)}`,
      { headers, responseType: 'text', tags: { op: 'join' } },
    );
    joinDuration.add(res.timings.duration);
    joinCount.add(1);
    const joinOk = res.status >= 200 && res.status < 300;
    opErrorRate.add(!joinOk, { op: 'join' });
    check(res, { 'join: event visible': (r) => r.status === 200 });
    me.joined = joinOk;
    sleep(rand(0.5, 1.5));
  }

  // 2) VOTE (frequent) — cast an upvote on the configured question. Duplicate
  //    casts return `already_voted`, which is a well-formed non-error signal;
  //    only transport/5xx/unexpected rejections score against the gate.
  if (QUESTION_ID) {
    rpcPost(
      'cast_question_vote',
      {
        p_question_id: QUESTION_ID,
        p_participant_identifier: me.participantId,
      },
      voteDuration,
      voteCount,
      'vote',
    );
    sleep(rand(0.3, 1.0));
  }

  // 3) POLL RESPOND — submit/replace a single-choice poll answer.
  if (POLL_ID && OPTION_ID) {
    rpcPost(
      'submit_poll_response',
      {
        p_poll_id: POLL_ID,
        p_participant_identifier: me.participantId,
        p_option_id: OPTION_ID,
      },
      pollRespondDuration,
      pollRespondCount,
      'poll_respond',
    );
    sleep(rand(0.3, 1.0));
  }

  // 4) WORD CLOUD RESPOND — submit/replace a short word.
  if (WORD_CLOUD_PROMPT_ID) {
    const word = WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)];
    rpcPost(
      'submit_word_cloud_response',
      {
        p_prompt_id: WORD_CLOUD_PROMPT_ID,
        p_participant_identifier: me.participantId,
        p_raw_text: word,
      },
      wordCloudRespondDuration,
      wordCloudRespondCount,
      'word_cloud_respond',
    );
    sleep(rand(0.3, 1.0));
  }

  // 5) SUBMIT A QUESTION (occasionally — ~10% of iterations) so submissions are
  //    concurrent but not dominant (matching real audience behaviour and
  //    staying under the stricter 10/60s submit limit).
  if (Math.random() < 0.1) {
    rpcPost(
      'submit_question',
      {
        p_event_id: eventId,
        p_participant_identifier: me.participantId,
        p_text: `Load-test question from VU ${__VU} iter ${__ITER}`,
        p_submission_key: newSubmissionKey(),
      },
      submitQuestionDuration,
      submitQuestionCount,
      'submit_question',
    );
  }

  // Think-time between iterations.
  sleep(rand(1.0, 3.0));
}

// -----------------------------------------------------------------------------
// presenter(): opens a Supabase Realtime WebSocket, sends the Phoenix phx_join
// for the event's per-event topic, and holds the socket open receiving
// broadcasts — modelling a presenter/moderator live view (Req 26.5).
//
// Supabase Realtime speaks the Phoenix Channels protocol over:
//   wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<anon>&vsn=1.0.0
// A client joins a topic by sending a phx_join message; here we join the same
// per-event topic the audience hook uses (`event:{event_id}:questions`, see
// src/hooks/useRealtimeChannel.ts / src/lib/questions.ts). We record whether the
// socket opened successfully and simply hold it for PRESENTER_HOLD.
// -----------------------------------------------------------------------------
export function presenter(data) {
  const eventId = data.eventId;

  // Build the Realtime WS URL from the HTTP(S) SUPABASE_URL.
  const wsBase = SUPABASE_URL.replace(/^http:/, 'ws:').replace(
    /^https:/,
    'wss:',
  );
  const url = `${wsBase}/realtime/v1/websocket?apikey=${encodeURIComponent(
    SUPABASE_ANON_KEY,
  )}&vsn=1.0.0`;

  const topic = `realtime:event:${eventId}:questions`;
  const holdMs = durationToMs(PRESENTER_HOLD);

  const res = ws.connect(url, { tags: { op: 'realtime' } }, function (socket) {
    let joined = false;

    socket.on('open', function () {
      // Phoenix phx_join for the per-event topic. `ref`/`join_ref` are simple
      // monotonic ids; the config payload mirrors a Realtime subscribe (we ask
      // for broadcast + presence so the server treats us as a live subscriber).
      const joinMsg = JSON.stringify({
        topic: topic,
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { self: false },
            presence: { key: '' },
            postgres_changes: [
              { event: '*', schema: 'public', table: 'questions' },
            ],
          },
        },
        ref: '1',
        join_ref: '1',
      });
      socket.send(joinMsg);

      // Phoenix heartbeat so the connection is kept alive while held open.
      socket.setInterval(function () {
        socket.send(
          JSON.stringify({
            topic: 'phoenix',
            event: 'heartbeat',
            payload: {},
            ref: 'hb',
          }),
        );
      }, 25000);

      // Hold the socket open for the configured window, then close cleanly.
      socket.setTimeout(function () {
        socket.close();
      }, holdMs);
    });

    socket.on('message', function (msg) {
      // A phx_reply with status "ok" to our join confirms the subscription.
      if (!joined && typeof msg === 'string' && msg.indexOf('phx_reply') !== -1) {
        joined = msg.indexOf('"status":"ok"') !== -1;
      }
    });

    socket.on('close', function () {
      wsConnectSuccess.add(joined);
    });

    socket.on('error', function () {
      wsConnectSuccess.add(false);
    });
  });

  wsConnectCount.add(1);
  // res.status 101 == switching protocols == the WS handshake succeeded.
  check(res, { 'realtime: ws handshake 101': (r) => r && r.status === 101 });
}

// -----------------------------------------------------------------------------
// handleSummary(): write a machine-readable JSON summary to load/summary.json
// (Req 26.6) so task 42.2's README / results template can ingest the P50/P95,
// error rate, and max-concurrency numbers. Also keeps the default stdout
// summary. (Alternatively pass `--summary-export=load/summary.json`.)
// -----------------------------------------------------------------------------
export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    'load/summary.json': JSON.stringify(data, null, 2),
  };
}

/**
 * Minimal text summary highlighting the gate-relevant numbers. We avoid the
 * `k6-summary` jslib import (network fetch) and format the key metrics inline so
 * the script is fully self-contained.
 */
function textSummary(data) {
  const m = data.metrics || {};
  const lines = [];
  lines.push('=== MSS LivePulse load-test summary ===');
  pushTrend(lines, m, 'op_join_duration', 'join');
  pushTrend(lines, m, 'op_submit_question_duration', 'submit_question');
  pushTrend(lines, m, 'op_vote_duration', 'vote');
  pushTrend(lines, m, 'op_poll_respond_duration', 'poll_respond');
  pushTrend(lines, m, 'op_word_cloud_respond_duration', 'word_cloud_respond');
  pushRate(lines, m, 'op_error_rate', 'semantic error rate');
  pushRate(lines, m, 'http_req_failed', 'http failure rate');
  pushRate(lines, m, 'realtime_ws_connect_success', 'realtime connect rate');
  pushGauge(lines, m, 'max_sustained_participants', 'max sustained VUs');
  pushCounter(lines, m, 'op_rate_limited', 'rate-limited (expected)');
  return lines.join('\n') + '\n';
}

function pushTrend(lines, metrics, key, label) {
  const v = metrics[key] && metrics[key].values;
  if (!v) return;
  lines.push(
    `${label}: p50=${fmt(v['p(50)'])}ms p95=${fmt(v['p(95)'])}ms ` +
      `avg=${fmt(v.avg)}ms max=${fmt(v.max)}ms`,
  );
}

function pushRate(lines, metrics, key, label) {
  const v = metrics[key] && metrics[key].values;
  if (!v) return;
  lines.push(`${label}: ${fmt((v.rate || 0) * 100)}%`);
}

function pushGauge(lines, metrics, key, label) {
  const v = metrics[key] && metrics[key].values;
  if (!v) return;
  lines.push(`${label}: ${fmt(v.max)}`);
}

function pushCounter(lines, metrics, key, label) {
  const v = metrics[key] && metrics[key].values;
  if (!v) return;
  lines.push(`${label}: ${fmt(v.count)}`);
}

function fmt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

/** Uniform random float in [min, max]. */
function rand(min, max) {
  return min + Math.random() * (max - min);
}

/** Convert a k6 duration string like '30s' / '5m' / '1500ms' to milliseconds. */
function durationToMs(d) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(String(d).trim());
  if (!match) return 30000;
  const value = Number.parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms':
      return value;
    case 'm':
      return value * 60000;
    case 'h':
      return value * 3600000;
    case 's':
    default:
      return value * 1000;
  }
}
