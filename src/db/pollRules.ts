/**
 * Poll lifecycle / poll-response RULE MODEL — the shared behavioural
 * specification of the server-side poll RPCs (Milestone 3 — Polls & Word Cloud).
 *
 * =============================================================================
 * WHAT THIS MODULE IS (AND IS NOT)
 * =============================================================================
 * This is a pure, framework-agnostic TypeScript **reference model** that mirrors
 * the DECISION LOGIC of the PostgreSQL `SECURITY DEFINER` RPCs that actually run
 * in production:
 *
 *   - supabase/migrations/20260101000025_poll_transition_rpc.sql
 *       → set_poll_status(poll_id, status)
 *   - supabase/migrations/20260101000027_poll_respond_rpc.sql
 *       → submit_poll_response(poll_id, participant_identifier, option_id)
 *
 * The AUTHORITATIVE implementation is the SQL. Those RPCs are plpgsql functions
 * using custom enum types (`poll_status`), the `event_is_live` helper, advisory
 * / row locks (`SELECT ... FOR UPDATE`), the shared `check_and_record_rate_limit`
 * helper and — crucially for Property 5 — the `one_open_poll_per_event` PARTIAL
 * UNIQUE index (…000017) that enforces "at most one open poll per event" at the
 * storage layer. None of those can execute in this sandbox (there is no
 * Postgres / psql / supabase CLI, and pg-mem cannot represent plpgsql, custom
 * types, partial unique indexes or advisory locks). A live execution test is
 * therefore run against a real Postgres in CI via the env-gated integration
 * suites (mirroring src/db/rls.events.test.ts and the M2 rls.questions tests,
 * which skip cleanly without TEST_SUPABASE_*).
 *
 * To still lock down the DECISION RULES here — so a change to the intended
 * behaviour is caught by a fast unit / property test — this module encodes
 * exactly the same rules the SQL enforces. src/db/poll.properties.test.ts
 * exercises the poll INVARIANTS across generated operation sequences (Properties
 * 4 and 5), and the example-based unit tests (Task 21.5) reuse the same public
 * API. If a rule changes in the SQL it must change here too (and vice-versa);
 * the two are a MATCHED PAIR, exactly like the src/db/qaRules.ts ↔ vote/submit
 * RPC pairing this module is modelled on.
 *
 * The model deliberately keeps state in-memory (a tiny store) so the lifecycle
 * transitions, the single-open-poll guard and the upsert-replace count maths
 * can be expressed as ordinary functions. It does NOT emit Realtime broadcasts,
 * does NOT touch a database, and stores no PII.
 *
 * Requirements traceability: 5.5, 5.6, 5.7, 5.8, 5.9, 5.10.
 * Design references: Request/data flows (Poll lifecycle — single-open guard;
 *                    upsert replace); Data Models (`one_open_poll_per_event`);
 *                    Correctness Properties (Properties 4, 5).
 */

// ---------------------------------------------------------------------------
// Domain types (mirror the DB enum used by the RPCs).
// ---------------------------------------------------------------------------

/** Mirrors the DB `poll_status` enum: `'draft'` | `'open'` | `'closed'`. */
export type PollStatus = 'draft' | 'open' | 'closed';

/** All three poll statuses, in lifecycle order (matches the `poll_status` enum). */
export const ALL_POLL_STATUSES: readonly PollStatus[] = [
  'draft',
  'open',
  'closed',
] as const;

// ---------------------------------------------------------------------------
// 1. Poll lifecycle transition rule (Req 5.4).
//    Mirrors set_poll_status (20260101000025): only draft→open and open→closed
//    are permitted; a same-status set is an idempotent no-op. ANY other move
//    (closed→open, open→draft, closed→draft, draft→closed) is rejected.
// ---------------------------------------------------------------------------

/**
 * Whether a poll may move from `from` to `to` along the lifecycle
 * draft → open → closed (Req 5.4). Returns true for the two permitted forward
 * moves AND for the idempotent same-status no-op; false for every other move.
 * This is the exact predicate the SQL encodes before applying the UPDATE.
 */
export function isValidPollTransition(
  from: PollStatus,
  to: PollStatus,
): boolean {
  if (from === to) {
    return true; // idempotent same-status set is allowed (no-op)
  }
  return (
    (from === 'draft' && to === 'open') || (from === 'open' && to === 'closed')
  );
}

// ---------------------------------------------------------------------------
// 2. Poll-response eligibility by status (Req 5.9, 5.10).
//    Mirrors submit_poll_response step 3: a response is accepted ONLY while the
//    poll is 'open'; a 'draft' poll rejects with `poll_not_open` (Req 5.10) and
//    a 'closed' poll rejects with `poll_closed` (Req 5.9), leaving any existing
//    response unchanged.
// ---------------------------------------------------------------------------

/**
 * Whether a poll in `status` currently accepts (new or changed) responses
 * (Req 5.9, 5.10) — true iff the poll is `open`. `draft` and `closed` polls
 * reject responses; a `closed` poll additionally leaves any existing response
 * untouched (the RPC neither modifies nor deletes it).
 */
export function acceptsPollResponse(status: PollStatus): boolean {
  return status === 'open';
}

// ---------------------------------------------------------------------------
// Error signals — the string signals the SQL RPCs RAISE, so callers/tests can
// switch on a stable value (see the RPC headers' "Error signals" sections).
// ---------------------------------------------------------------------------

/** set_poll_status error signals (20260101000025). */
export type PollTransitionError =
  'poll_not_found' | 'invalid_transition' | 'poll_already_open';

/** submit_poll_response error signals (20260101000027). */
export type PollResponseError =
  | 'poll_not_found'
  | 'poll_not_open'
  | 'poll_closed'
  | 'event_not_live'
  | 'invalid_option';

/** The union of all poll-rule error signals raised by the model. */
export type PollErrorKind = PollTransitionError | PollResponseError;

/**
 * Raised by the model to mirror a poll RPC RAISE. `kind` is the SQL MESSAGE
 * string (stable signal), mirroring how QaRuleError exposes its `signal`.
 */
export class PollRuleError extends Error {
  constructor(public readonly kind: PollErrorKind) {
    super(kind);
    this.name = 'PollRuleError';
  }
}

// ---------------------------------------------------------------------------
// In-memory reference store + model.
//
// This mirrors the RPCs' effects on `polls` (status), `poll_options`
// (response_count) and `poll_responses` (the UNIQUE (participant_identifier,
// poll_id) rows) — enough to exercise the lifecycle guard, the single-open
// invariant and the upsert-replace count maths as pure logic.
// ---------------------------------------------------------------------------

interface PollRow {
  id: string;
  eventId: string;
  status: PollStatus;
}

interface OptionRow {
  id: string;
  pollId: string;
  responseCount: number;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * A tiny in-process model of the poll lifecycle + response RPC effects. All
 * state is in-memory and every mutation goes through {@link setPollStatus} or
 * {@link submitPollResponse}, so the single-open-poll invariant and the
 * exactly-one-response-per-(participant, poll) invariant can be asserted after
 * every step.
 *
 * The public API is deliberately shaped for BOTH property tests (drive random
 * operation sequences) and example-based unit tests (Task 21.5 reuses it):
 * fixture helpers seed events/polls/options, action methods mirror the RPCs,
 * and read helpers expose exactly the quantities the invariants are stated over.
 */
export class PollModel {
  private readonly polls = new Map<string, PollRow>();
  private readonly options = new Map<string, OptionRow>();
  /** event_id → live-ness (poll responses are gated on a live event, Req 5.9/5.10). */
  private readonly eventLive = new Map<string, boolean>();
  /** `${participant}::${pollId}` → option_id, the UNIQUE (participant, poll) response row. */
  private readonly responses = new Map<string, string>();

  // -------------------------------------------------------------------------
  // Fixture helpers (test setup). These do NOT enforce lifecycle rules — they
  // seed the store the way a migration + admin poll-create RPC would.
  // -------------------------------------------------------------------------

  /** Register an event's live-ness (defaults matter for response gating). */
  addEvent(eventId: string, opts: { live: boolean } = { live: true }): void {
    this.eventLive.set(eventId, opts.live);
  }

  /**
   * Seed a poll row for an event, returning its id. `status` defaults to
   * `'draft'` (the state a freshly-created poll starts in). This bypasses the
   * single-open guard on purpose so tests can construct arbitrary start states;
   * the guard is exercised through {@link setPollStatus}.
   */
  addPoll(args: { eventId: string; status?: PollStatus }): string {
    const id = nextId('poll');
    this.polls.set(id, {
      id,
      eventId: args.eventId,
      status: args.status ?? 'draft',
    });
    return id;
  }

  /** Seed an option for a poll (with an optional starting count), returning its id. */
  addOption(args: { pollId: string; responseCount?: number }): string {
    const id = nextId('opt');
    this.options.set(id, {
      id,
      pollId: args.pollId,
      responseCount: args.responseCount ?? 0,
    });
    return id;
  }

  // -------------------------------------------------------------------------
  // Read helpers (the quantities the invariants are stated over).
  // -------------------------------------------------------------------------

  /** Read a poll row; undefined if unknown. */
  getPoll(pollId: string): Readonly<PollRow> | undefined {
    return this.polls.get(pollId);
  }

  /** The current status of a poll; undefined if unknown. */
  getPollStatus(pollId: string): PollStatus | undefined {
    return this.polls.get(pollId)?.status;
  }

  /** Count of polls currently `open` for an event — the Property 5 quantity. */
  getOpenPollCount(eventId: string): number {
    let n = 0;
    for (const p of this.polls.values()) {
      if (p.eventId === eventId && p.status === 'open') {
        n += 1;
      }
    }
    return n;
  }

  /**
   * The option_id of a participant's current response to a poll, or undefined if
   * they have none — the Property 4 quantity (there is at most one such row).
   */
  getResponse(participant: string, pollId: string): string | undefined {
    return this.responses.get(this.responseKey(participant, pollId));
  }

  /** The number of response rows recorded for a (participant, poll) — 0 or 1. */
  getResponseCountFor(participant: string, pollId: string): number {
    return this.responses.has(this.responseKey(participant, pollId)) ? 1 : 0;
  }

  /** The cached `response_count` tally for an option; undefined if unknown. */
  getOptionCount(optionId: string): number | undefined {
    return this.options.get(optionId)?.responseCount;
  }

  private responseKey(participant: string, pollId: string): string {
    return `${participant}::${pollId}`;
  }

  private eventIsLive(eventId: string): boolean {
    return this.eventLive.get(eventId) === true;
  }

  // -------------------------------------------------------------------------
  // Action methods (mirror the RPCs).
  // -------------------------------------------------------------------------

  /**
   * Mirrors set_poll_status (20260101000025). Order matches the SQL exactly:
   *   1. the poll must exist — else `poll_not_found`,
   *   2. the transition must be draft→open→closed or a same-status no-op — else
   *      `invalid_transition` and NOTHING changes (Req 5.4),
   *   3. when transitioning TO 'open' (and not already open), the single-open
   *      -poll-per-event guarantee (the `one_open_poll_per_event` partial unique
   *      index) is enforced: if another poll for the same event is already open,
   *      the write is rejected with `poll_already_open`, leaving BOTH polls'
   *      statuses unchanged (Req 5.5, 5.6). Otherwise the status is applied.
   * Returns the poll's (possibly unchanged) status.
   */
  setPollStatus(pollId: string, status: PollStatus): PollStatus {
    const poll = this.polls.get(pollId);
    if (!poll) {
      throw new PollRuleError('poll_not_found');
    }

    // 2. Lifecycle validation (Req 5.4) — reject before touching anything.
    if (!isValidPollTransition(poll.status, status)) {
      throw new PollRuleError('invalid_transition');
    }

    // 3. Single-open-poll guard (Req 5.5, 5.6). Mirrors the partial unique
    //    index trip → caught unique_violation → re-raised `poll_already_open`,
    //    with BOTH statuses left unchanged (the failed UPDATE is rolled back).
    if (status === 'open' && poll.status !== 'open') {
      if (this.getOpenPollCount(poll.eventId) >= 1) {
        throw new PollRuleError('poll_already_open');
      }
    }

    // Apply (covers draft→open, open→closed and idempotent same-status no-ops).
    poll.status = status;
    return poll.status;
  }

  /**
   * Mirrors submit_poll_response (20260101000027). Order matches the SQL
   * (rate-limiting is intentionally omitted from THIS model — it reuses the M2
   * shared 'vote' bucket already modelled/tested in qaRules; here we focus on
   * the lifecycle + upsert-replace count invariants):
   *   1. the poll must exist — else `poll_not_found`,
   *   2. the poll must be 'open' — a 'draft' poll → `poll_not_open` (Req 5.10),
   *      a 'closed' poll → `poll_closed` (Req 5.9), leaving any existing
   *      response UNCHANGED,
   *   3. the event must be live — else `event_not_live`,
   *   4. the chosen option must belong to THIS poll — else `invalid_option`,
   *   5. UPSERT-REPLACE with atomic per-option count maintenance (Req 5.7, 5.8):
   *        * no existing response → INSERT + (+1 the chosen option),
   *        * existing response, SAME option → idempotent no-op (counts
   *          unchanged, Req 23.8 — no double count),
   *        * existing response, DIFFERENT option → move the response to the new
   *          option, -1 the OLD option's count (floored at 0) and +1 the NEW
   *          option's count — so EXACTLY ONE response remains for
   *          (participant, poll) and it equals the last submitted choice.
   * Returns the option_id now recorded for (participant, poll).
   */
  submitPollResponse(
    pollId: string,
    participant: string,
    optionId: string,
  ): string {
    const poll = this.polls.get(pollId);
    if (!poll) {
      throw new PollRuleError('poll_not_found');
    }

    // 2. Poll must be open (Req 5.9, 5.10) — distinct signals, existing response
    //    left unchanged on rejection.
    if (poll.status === 'draft') {
      throw new PollRuleError('poll_not_open'); // Req 5.10
    }
    if (poll.status === 'closed') {
      throw new PollRuleError('poll_closed'); // Req 5.9
    }

    // 3. Event must be live (Req 5.9/5.10 gating).
    if (!this.eventIsLive(poll.eventId)) {
      throw new PollRuleError('event_not_live');
    }

    // 4. The option must belong to THIS poll.
    const option = this.options.get(optionId);
    if (!option || option.pollId !== pollId) {
      throw new PollRuleError('invalid_option');
    }

    // 5. Upsert-replace with atomic count maintenance (Req 5.7, 5.8).
    const key = this.responseKey(participant, pollId);
    const existingOpt = this.responses.get(key);

    if (existingOpt === undefined) {
      // 5a. First response → insert + increment the chosen option.
      this.responses.set(key, optionId);
      option.responseCount += 1;
    } else if (existingOpt === optionId) {
      // 5b. Same option → idempotent no-op (counts unchanged, Req 23.8).
      return optionId;
    } else {
      // 5c. Changed option → move the response; -1 old (floored), +1 new.
      const oldOption = this.options.get(existingOpt);
      if (oldOption) {
        oldOption.responseCount = Math.max(oldOption.responseCount - 1, 0);
      }
      this.responses.set(key, optionId);
      option.responseCount += 1;
    }

    return optionId;
  }
}
