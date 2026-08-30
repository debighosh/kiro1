/**
 * Q&A submit / vote RULE MODEL — the shared behavioural specification of the
 * server-side submit and vote RPCs (Task 13.5, Milestone 2 — Core Live Q&A).
 *
 * =============================================================================
 * WHAT THIS MODULE IS (AND IS NOT)
 * =============================================================================
 * This is a pure, framework-agnostic TypeScript **reference model** that mirrors
 * the DECISION LOGIC of the PostgreSQL `SECURITY DEFINER` RPCs that actually run
 * in production:
 *
 *   - supabase/migrations/20260101000014_submit_question_rpc.sql
 *       → submit_question(event_id, participant_identifier, text, submission_key)
 *   - supabase/migrations/20260101000015_vote_rpc.sql
 *       → cast_question_vote(question_id, participant_identifier)
 *       → remove_question_vote(question_id, participant_identifier)
 *   - supabase/migrations/20260101000013_rate_limiting.sql
 *       → check_and_record_rate_limit(...) + the 10/60s submit and 30/60s vote
 *         default wrappers.
 *
 * The AUTHORITATIVE implementation is the SQL. Those RPCs are plpgsql functions
 * using custom enum types, `event_is_live`, regex sanitisation, advisory locks
 * and a real UNIQUE constraint — none of which can be executed in this sandbox
 * (there is no Postgres / psql / supabase CLI, and pg-mem cannot represent
 * plpgsql, custom types or `realtime.send`). A live execution test is therefore
 * run against a real Postgres in CI via the env-gated integration suites
 * (mirroring src/db/rls.events.test.ts and Task 12.3's rls.questions tests,
 * which skip cleanly without TEST_SUPABASE_*).
 *
 * To still lock down the DECISION RULES here — so a change to the intended
 * behaviour is caught by a fast unit test — this module encodes exactly the same
 * rules the SQL enforces, and src/db/qaRules.test.ts exercises them with positive
 * and negative assertions. If a rule changes in the SQL, it must change here too
 * (and vice-versa); the two are a matched pair, like the eventStatus.ts /
 * transition-event-status Edge Function pair.
 *
 * The model deliberately keeps state in-memory (a tiny store) so idempotency,
 * one-vote-per-participant uniqueness, count maths and sliding-window rate
 * limiting can be expressed as ordinary functions. It does NOT emit Realtime
 * broadcasts, does NOT touch a database, and stores no PII.
 *
 * Requirements traceability: 3.3, 3.6, 3.7, 4.4, 4.6, 4.8, 21.13, 21.14, 21.15,
 *                            22.1, 26.1.
 * Design references: Request/data flows (Question submit + moderation; Voting
 *                    with realtime propagation); RLS Design (Server-side rate
 *                    limiting).
 */

// ---------------------------------------------------------------------------
// Domain types (mirror the DB enums used by the RPCs).
// ---------------------------------------------------------------------------

/** Mirrors the DB `moderation_mode` enum: `'pre'` | `'post'`. */
export type ModerationMode = 'pre' | 'post';

/** Mirrors the DB `question_status` enum. */
export type QuestionStatus =
  'pending' | 'approved' | 'featured' | 'answered' | 'hidden';

/** Question-text length bounds in Unicode code points (Req 22.1, 3.1, 3.2). */
export const MIN_QUESTION_LENGTH = 1 as const;
export const MAX_QUESTION_LENGTH = 300 as const;

/** Default rate-limit thresholds baked into the SQL wrappers (Req 21.13/21.14). */
export const SUBMIT_RATE_LIMIT_MAX = 10 as const; // submissions per window (Req 21.13)
export const VOTE_RATE_LIMIT_MAX = 30 as const; // votes per window (Req 21.14)
export const RATE_LIMIT_WINDOW_SECONDS = 60 as const; // sliding window (Req 21.13/21.14)

/** Statuses on which a vote may be cast (Req 4.8) — must ALSO be on a live event. */
export const VOTE_ELIGIBLE_STATUSES: readonly QuestionStatus[] = [
  'approved',
  'featured',
] as const;

// ---------------------------------------------------------------------------
// 1. Moderation-mode → initial submit status (Req 3.6, 3.7).
//    Mirrors submit_question step 5:
//      'pre'  → 'pending'  (awaits moderator approval)
//      'post' → 'approved' (visible immediately)
// ---------------------------------------------------------------------------

/**
 * The initial `questions.status` a freshly-submitted question receives, decided
 * by the parent event's `moderation_mode` (Req 3.6, 3.7). Pre-moderation queues
 * the question as `pending`; post-moderation publishes it as `approved`.
 */
export function submitStatusForModerationMode(
  mode: ModerationMode,
): QuestionStatus {
  return mode === 'pre' ? 'pending' : 'approved';
}

// ---------------------------------------------------------------------------
// 2. Text sanitisation + length validation (Req 3.1, 3.2, 22.1, 21.9–21.11).
//    Mirrors submit_question step 3:
//      - collapse tab/newline/CR runs to a single space,
//      - strip remaining C0 (U+0000–U+001F) and DEL/C1 (U+007F–U+009F) controls,
//      - trim surrounding whitespace,
//      - require 1–300 Unicode CODE POINTS (not UTF-16 units).
// ---------------------------------------------------------------------------

/**
 * Sanitises question text exactly as the submit RPC does: whitespace-run
 * collapse (tab/newline/CR → single space), control-character stripping, then a
 * surrounding trim. Returns the cleaned text (which may be empty).
 */
export function sanitiseQuestionText(text: string): string {
  // Collapse tab / newline / carriage-return runs to a single space.
  let out = text.replace(/[\t\n\r]+/g, ' ');
  // Strip remaining C0 controls (U+0000–U+001F) and DEL/C1 controls (U+007F–U+009F).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  // Trim surrounding whitespace.
  return out.trim();
}

/**
 * Counts Unicode CODE POINTS (Req 22.1) — `char_length` in Postgres counts code
 * points, so a single astral character (e.g. an emoji) counts as 1, not 2.
 * `[...str].length` iterates by code point, matching that semantics.
 */
export function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Whether the given text, after sanitisation, is a valid 1–300 code-point
 * question (Req 3.1, 3.2, 22.1). Empty / whitespace-only / control-only input
 * collapses to length 0 and is invalid; over-length (>300) is invalid.
 */
export function isValidQuestionText(text: string | null | undefined): boolean {
  if (text === null || text === undefined) {
    return false;
  }
  const len = codePointLength(sanitiseQuestionText(text));
  return len >= MIN_QUESTION_LENGTH && len <= MAX_QUESTION_LENGTH;
}

// ---------------------------------------------------------------------------
// 3. Live gating for submission (Req 3.3).
//    Mirrors submit_question step 2: submission is rejected unless the event is
//    live (event_is_live also returns false for a non-existent event).
// ---------------------------------------------------------------------------

/** Whether a question may be submitted right now: only while the event is live (Req 3.3). */
export function canSubmit(eventLive: boolean): boolean {
  return eventLive === true;
}

// ---------------------------------------------------------------------------
// 4. Vote eligibility (Req 4.8).
//    Mirrors cast_question_vote step 2: a vote is eligible iff the question's
//    status is approved/featured AND the parent event is live.
// ---------------------------------------------------------------------------

/**
 * Whether a vote may be cast on a question in `status` when the parent event's
 * live-ness is `eventLive` (Req 4.8). Removal is intentionally NOT gated (a
 * participant may always withdraw a vote) — see {@link QaModel.removeVote}.
 */
export function isVoteEligible(
  status: QuestionStatus,
  eventLive: boolean,
): boolean {
  return eventLive === true && VOTE_ELIGIBLE_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Error signals — the string signals the SQL RPCs RAISE, so callers/tests can
// switch on a stable value (see the RPC headers' "Error signals" sections).
// ---------------------------------------------------------------------------

export type SubmitError = 'rate_limited' | 'event_not_live' | 'invalid_length';
export type VoteError =
  | 'question_not_found'
  | 'not_eligible'
  | 'rate_limited'
  | 'already_voted'
  | 'no_vote_to_remove';

/** Raised by the model to mirror an RPC RAISE. `signal` is the SQL MESSAGE string. */
export class QaRuleError extends Error {
  constructor(public readonly signal: SubmitError | VoteError) {
    super(signal);
    this.name = 'QaRuleError';
  }
}

// ---------------------------------------------------------------------------
// In-memory reference store + model.
//
// This mirrors the RPCs' effects on `questions` (status + vote_count),
// `question_votes` (the UNIQUE (participant_identifier, question_id) rows) and
// the `rate_events` sliding window — enough to exercise idempotency, count
// maths, duplicate rejection, eligibility and rate limiting as pure logic.
// ---------------------------------------------------------------------------

interface QuestionRow {
  id: string;
  eventId: string;
  text: string;
  status: QuestionStatus;
  voteCount: number;
  submissionKey: string | null;
}

interface RateEvent {
  participant: string;
  action: 'submit_question' | 'vote';
  eventId: string | null;
  occurredAtMs: number;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * A tiny in-process model of the submit/vote RPC effects. Times are injectable
 * (via the `nowMs` callback) so the sliding-window rate limit can be tested
 * deterministically without real timers.
 */
export class QaModel {
  private readonly questions = new Map<string, QuestionRow>();
  /** event_id → moderation_mode. */
  private readonly eventModes = new Map<string, ModerationMode>();
  /** event_id → live-ness. */
  private readonly eventLive = new Map<string, boolean>();
  private readonly rateEvents: RateEvent[] = [];
  /** Set of `${participant}::${questionId}` for the UNIQUE vote constraint. */
  private readonly votes = new Set<string>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  /** Register an event's moderation mode + live-ness (test fixture helper). */
  setEvent(
    eventId: string,
    opts: { mode: ModerationMode; live: boolean },
  ): void {
    this.eventModes.set(eventId, opts.mode);
    this.eventLive.set(eventId, opts.live);
  }

  /** Directly seed a question row (test fixture helper), returning its id. */
  seedQuestion(row: {
    eventId: string;
    status: QuestionStatus;
    voteCount?: number;
    text?: string;
  }): string {
    const id = nextId('q');
    this.questions.set(id, {
      id,
      eventId: row.eventId,
      text: row.text ?? 'seeded question',
      status: row.status,
      voteCount: row.voteCount ?? 0,
      submissionKey: null,
    });
    return id;
  }

  /** Read a question row (test helper); returns undefined if unknown. */
  getQuestion(id: string): Readonly<QuestionRow> | undefined {
    return this.questions.get(id);
  }

  private eventIsLive(eventId: string): boolean {
    return this.eventLive.get(eventId) === true;
  }

  /**
   * Sliding-window rate-limit check-and-record, mirroring
   * check_and_record_rate_limit: counts this participant's actions of `action`
   * within the last `windowSeconds`; if `>= max` it rejects and records NOTHING
   * (Req 21.15); otherwise it records the action and allows it.
   */
  private checkAndRecordRateLimit(
    participant: string,
    action: 'submit_question' | 'vote',
    eventId: string | null,
    max: number,
    windowSeconds: number,
  ): boolean {
    const now = this.nowMs();
    const windowStart = now - windowSeconds * 1000;
    const count = this.rateEvents.filter(
      (e) =>
        e.participant === participant &&
        e.action === action &&
        e.occurredAtMs >= windowStart &&
        (eventId === null || e.eventId === null || e.eventId === eventId),
    ).length;

    if (count >= max) {
      return false; // exceeded → reject, record nothing (Req 21.15)
    }
    this.rateEvents.push({ participant, action, eventId, occurredAtMs: now });
    return true;
  }

  /**
   * Mirrors submit_question. Order of operations is significant and matches the
   * SQL exactly:
   *   1. rate limit (Req 21.13) — reject first with `rate_limited`,
   *   2. event must be live (Req 3.3) — else `event_not_live`,
   *   3. sanitise + validate 1–300 code points (Req 3.1/3.2/22.1) — else
   *      `invalid_length`,
   *   4. submission_key idempotency (Req 23.8) — return the existing row,
   *   5. status from moderation_mode (Req 3.6/3.7),
   *   6. insert + return the row.
   */
  submitQuestion(args: {
    eventId: string;
    participant: string;
    text: string | null | undefined;
    submissionKey?: string | null;
  }): Readonly<QuestionRow> {
    const { eventId, participant, text } = args;
    const submissionKey = args.submissionKey ?? null;

    // 1. Rate limit FIRST (Req 21.13).
    if (
      !this.checkAndRecordRateLimit(
        participant,
        'submit_question',
        eventId,
        SUBMIT_RATE_LIMIT_MAX,
        RATE_LIMIT_WINDOW_SECONDS,
      )
    ) {
      throw new QaRuleError('rate_limited');
    }

    // 2. Event must be live (Req 3.3).
    if (!canSubmit(this.eventIsLive(eventId))) {
      throw new QaRuleError('event_not_live');
    }

    // 3. Sanitise + validate length (Req 3.1, 3.2, 22.1, 21.9–21.11).
    if (text === null || text === undefined) {
      throw new QaRuleError('invalid_length');
    }
    const sanitised = sanitiseQuestionText(text);
    if (!isValidQuestionText(text)) {
      throw new QaRuleError('invalid_length');
    }

    // 4. submission_key idempotency (Req 23.8): return the existing row.
    if (submissionKey !== null) {
      for (const q of this.questions.values()) {
        if (q.eventId === eventId && q.submissionKey === submissionKey) {
          return q;
        }
      }
    }

    // 5. Status from moderation mode (Req 3.6, 3.7).
    const mode = this.eventModes.get(eventId) ?? 'pre';
    const status = submitStatusForModerationMode(mode);

    // 6. Insert + return.
    const id = nextId('q');
    const row: QuestionRow = {
      id,
      eventId,
      text: sanitised,
      status,
      voteCount: 0,
      submissionKey,
    };
    this.questions.set(id, row);
    return row;
  }

  /**
   * Mirrors cast_question_vote. Order matches the SQL:
   *   1. question must exist — else `question_not_found`,
   *   2. eligibility: status ∈ {approved,featured} AND event live — else
   *      `not_eligible` (count unchanged, Req 4.8),
   *   3. rate limit (Req 21.14) — else `rate_limited`,
   *   4. UNIQUE (participant, question) → duplicate raises `already_voted` with
   *      the count UNCHANGED (Req 4.4); otherwise increment and return the new
   *      count.
   */
  castVote(args: { questionId: string; participant: string }): number {
    const { questionId, participant } = args;
    const q = this.questions.get(questionId);
    if (!q) {
      throw new QaRuleError('question_not_found');
    }

    // 2. Eligibility (Req 4.8) — checked BEFORE the rate limit and BEFORE the
    //    duplicate check, exactly as the SQL orders it, so an ineligible vote
    //    never consumes a rate-limit slot and never changes the count.
    if (!isVoteEligible(q.status, this.eventIsLive(q.eventId))) {
      throw new QaRuleError('not_eligible');
    }

    // 3. Rate limit (Req 21.14).
    if (
      !this.checkAndRecordRateLimit(
        participant,
        'vote',
        q.eventId,
        VOTE_RATE_LIMIT_MAX,
        RATE_LIMIT_WINDOW_SECONDS,
      )
    ) {
      throw new QaRuleError('rate_limited');
    }

    // 4. UNIQUE (participant, question): duplicate → already_voted, count
    //    unchanged (Req 4.4).
    const voteKey = `${participant}::${questionId}`;
    if (this.votes.has(voteKey)) {
      throw new QaRuleError('already_voted');
    }
    this.votes.add(voteKey);
    q.voteCount += 1;
    return q.voteCount;
  }

  /**
   * Mirrors remove_question_vote. Removal is intentionally NOT eligibility- or
   * rate-limit-gated (a participant may always withdraw a vote). Order:
   *   1. question must exist — else `question_not_found`,
   *   2. delete the participant's vote row; if none existed → no-op on the count
   *      and raise `no_vote_to_remove` (Req 4.6); otherwise decrement the count
   *      (floored at 0, Req 4.5) and return the new count.
   */
  removeVote(args: { questionId: string; participant: string }): number {
    const { questionId, participant } = args;
    const q = this.questions.get(questionId);
    if (!q) {
      throw new QaRuleError('question_not_found');
    }

    const voteKey = `${participant}::${questionId}`;
    if (!this.votes.has(voteKey)) {
      // No active vote: count is a no-op (unchanged) and we signal (Req 4.6).
      throw new QaRuleError('no_vote_to_remove');
    }
    this.votes.delete(voteKey);
    q.voteCount = Math.max(q.voteCount - 1, 0); // floor at 0 (Req 4.5)
    return q.voteCount;
  }
}

// ---------------------------------------------------------------------------
// 5. Moderation-visibility rule (Req 3.9, 3.10, 7.9) — Property 10.
//    Mirrors the anonymous SELECT RLS policy on `questions`
//    (supabase/migrations/20260101000011_questions_rls.sql):
//
//      USING ( event_is_live(event_id)
//              AND status IN ('approved', 'featured', 'answered') )
//
//    The audience and the presenter BOTH read questions through this same
//    anon-equivalent path, so the set of statuses a client may ever see is the
//    audience-visible set below. The security-critical invariant is that
//    `pending` and `hidden` are EXCLUDED and can NEVER be returned to a client
//    (audience or presenter) — see the migration's DECISION note.
//
//    `answered` is admitted so a moderator-answered question remains visible as
//    historical context; presenter modes (see src/lib/presenter.ts's
//    PRESENTABLE_QUESTION_STATUSES) filter to the same allow-list. Either way,
//    the exclusion of pending/hidden holds for both surfaces.
// ---------------------------------------------------------------------------

/**
 * The question statuses a client (audience OR presenter, both reading via the
 * anonymous path) may ever see for a LIVE event (Req 3.9, 3.10, 7.9). This is
 * exactly the status list in the `questions_anon_select_visible` RLS policy.
 * `pending` and `hidden` are DELIBERATELY absent — they are the moderation
 * queue / removed states and must never leak to a client.
 */
export const AUDIENCE_VISIBLE_STATUSES: readonly QuestionStatus[] = [
  'approved',
  'featured',
  'answered',
] as const;

/**
 * The statuses that are NEVER visible to a client on any surface — the core
 * moderation-privacy guarantee (Req 3.9 pending, Req 3.10 hidden, Req 7.9 both
 * excluded from the presenter). Kept as an explicit list so tests can assert
 * the invariant directly and a future status enum addition is a compile-time
 * prompt to classify it.
 */
export const NEVER_VISIBLE_STATUSES: readonly QuestionStatus[] = [
  'pending',
  'hidden',
] as const;

/**
 * Whether a question in `status` is visible to a client (audience or presenter,
 * both via the anon read path) given the parent event's live-ness. Mirrors the
 * `questions_anon_select_visible` RLS predicate exactly: the event must be live
 * AND the status must be one of {@link AUDIENCE_VISIBLE_STATUSES}
 * (`approved`/`featured`/`answered`). A `pending` or `hidden` question is NEVER
 * visible, regardless of live-ness (Req 3.9, 3.10, 7.9).
 *
 * This is the single moderation-visibility rule the RLS policy enforces; the
 * audience and presenter surfaces are computed from it (the presenter may
 * additionally narrow the set further in its read layer, but never widens it).
 */
export function isModerationVisible(
  status: QuestionStatus,
  eventLive: boolean,
): boolean {
  return eventLive === true && AUDIENCE_VISIBLE_STATUSES.includes(status);
}

/**
 * Computes the set of questions visible to a CLIENT surface from a collection
 * of `(id, status)` rows, applying {@link isModerationVisible} with the given
 * event live-ness. Both the audience and presenter visible sets are derived
 * through this same rule (the presenter may pass a narrower `allowedStatuses`
 * subset of {@link AUDIENCE_VISIBLE_STATUSES}, but can never widen it).
 *
 * @param rows           The candidate question rows.
 * @param eventLive      Whether the parent event is currently live.
 * @param allowedStatuses Optional narrower allow-list (defaults to the full
 *   audience-visible set). Any status outside {@link AUDIENCE_VISIBLE_STATUSES}
 *   in this list is ignored — the rule can only ever restrict, never widen.
 * @returns The subset of `rows` a client may see.
 */
export function visibleQuestions<T extends { readonly status: QuestionStatus }>(
  rows: readonly T[],
  eventLive: boolean,
  allowedStatuses: readonly QuestionStatus[] = AUDIENCE_VISIBLE_STATUSES,
): T[] {
  return rows.filter(
    (row) =>
      isModerationVisible(row.status, eventLive) &&
      allowedStatuses.includes(row.status),
  );
}
