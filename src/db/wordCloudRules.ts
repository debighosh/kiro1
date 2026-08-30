/**
 * Word-cloud PROMPT-LIFECYCLE + RESPONSE-UPSERT RULE MODEL — the shared
 * behavioural specification of the server-side word-cloud RPCs (Task 22.6,
 * Milestone 3 — Polls & Word Cloud).
 *
 * =============================================================================
 * WHAT THIS MODULE IS (AND IS NOT) — A MATCHED PAIR WITH THE SQL
 * =============================================================================
 * This is a pure, framework-agnostic TypeScript **reference model** that mirrors
 * the DECISION LOGIC of the PostgreSQL `SECURITY DEFINER` RPCs that actually run
 * in production:
 *
 *   - supabase/migrations/20260101000024_word_cloud_prompt_rpc.sql
 *       → set_word_cloud_prompt_status(prompt_id, status)
 *         (draft → open → closed lifecycle; one_open_prompt_per_event guard)
 *   - supabase/migrations/20260101000026_word_cloud_respond_rpc.sql
 *       → submit_word_cloud_response(prompt_id, participant_identifier, raw_text)
 *         (prompt-open + event-live gating; 1–50 length; normalise-on-write;
 *          upsert on UNIQUE (participant_identifier, prompt_id))
 *
 * The AUTHORITATIVE implementation is the SQL. Those RPCs are plpgsql functions
 * using custom enum types, `event_is_live`, a partial UNIQUE index
 * (`one_open_prompt_per_event`) and a real UNIQUE constraint
 * (`uq_word_cloud_responses_participant_prompt`) — none of which can execute in
 * this sandbox (there is no Postgres / psql / supabase CLI, and pg-mem cannot
 * represent plpgsql, custom types or partial unique indexes). A live execution
 * test runs against a real Postgres in CI via the env-gated integration suites.
 *
 * To still lock down the DECISION RULES here — so a change to the intended
 * behaviour is caught by a fast test — this module encodes exactly the same
 * rules the SQL enforces, and the property/unit suites exercise them with
 * positive and negative assertions. If a rule changes in the SQL, it must change
 * here too (and vice-versa); the two are a matched pair, exactly like the
 * qaRules.ts / submit+vote-RPC pair (src/db/qaRules.ts).
 *
 * The model deliberately keeps state in-memory (a tiny store) so the
 * single-open-prompt invariant, one-response-per-participant uniqueness and
 * latest-text-tracking can be expressed as ordinary functions. It does NOT emit
 * Realtime broadcasts, does NOT touch a database, and stores no PII beyond the
 * opaque participant identifier the caller supplies.
 *
 * NORMALISATION IS SHARED, NOT REIMPLEMENTED: the response upsert stores
 * `normalisedText` via the single source of truth {@link normalise} from
 * `../lib/wordcloud` — the SAME contract the SQL write path re-implements — so
 * the model can never drift from the client/aggregation definition of "the same
 * term".
 *
 * Requirements traceability: 6.4, 6.5, 6.6, 6.9, 6.10.
 * Design references: Request/data flows (Word cloud — one prompt open at a time;
 *                    one response per participant, updatable while open);
 *                    Data Models (`word_cloud_prompts`, `word_cloud_responses`).
 */

import { normalise } from '../lib/wordcloud';

// ---------------------------------------------------------------------------
// Domain types (mirror the DB enum used by the RPCs).
// ---------------------------------------------------------------------------

/** Mirrors the DB `wordcloud_status` enum: `'draft'` | `'open'` | `'closed'`. */
export type WordCloudStatus = 'draft' | 'open' | 'closed';

/** All three prompt statuses, in lifecycle order (draft → open → closed). */
export const WORD_CLOUD_STATUSES: readonly WordCloudStatus[] = [
  'draft',
  'open',
  'closed',
] as const;

/** Response-text length bounds in Unicode code points, after trim (Req 6.8). */
export const MIN_RESPONSE_LENGTH = 1 as const;
export const MAX_RESPONSE_LENGTH = 50 as const;

// ---------------------------------------------------------------------------
// Error signals — the string signals the SQL RPCs RAISE, so callers/tests can
// switch on a stable value (see each RPC header's "Error signals" section).
// ---------------------------------------------------------------------------

/** Signals raised by the prompt-lifecycle RPC (set_word_cloud_prompt_status). */
export type PromptLifecycleError =
  'prompt_not_found' | 'invalid_transition' | 'prompt_already_open';

/** Signals raised by the response-upsert RPC (submit_word_cloud_response). */
export type ResponseError =
  'prompt_not_found' | 'prompt_not_open' | 'event_not_live' | 'invalid_length';

/** The union of every signal this model may raise. */
export type WordCloudErrorKind = PromptLifecycleError | ResponseError;

/**
 * Raised by the model to mirror an RPC RAISE. `kind` is the SQL MESSAGE string
 * so tests/callers can switch on a stable value.
 */
export class WordCloudRuleError extends Error {
  constructor(public readonly kind: WordCloudErrorKind) {
    super(kind);
    this.name = 'WordCloudRuleError';
  }
}

// ---------------------------------------------------------------------------
// 1. Prompt lifecycle transition rule (Req 6.4).
//    Mirrors set_word_cloud_prompt_status: only draft→open and open→closed are
//    permitted; a same-status set is an idempotent no-op; every other move is
//    'invalid_transition'.
// ---------------------------------------------------------------------------

/**
 * Whether moving a prompt FROM `current` TO `next` is a permitted lifecycle
 * transition (Req 6.4). Permitted moves are `draft→open`, `open→closed`, and any
 * same-status no-op (`X→X`). Every other move (e.g. `closed→open`, `open→draft`,
 * `draft→closed`, `closed→draft`) is NOT permitted.
 *
 * Exposed as a pure predicate so example-based unit tests (task 22.5) can assert
 * the transition table directly.
 */
export function isValidPromptTransition(
  current: WordCloudStatus,
  next: WordCloudStatus,
): boolean {
  if (next === current) {
    return true; // idempotent no-op
  }
  return (
    (current === 'draft' && next === 'open') ||
    (current === 'open' && next === 'closed')
  );
}

// ---------------------------------------------------------------------------
// 2. Response length validation (Req 6.8).
//    Mirrors submit_word_cloud_response step 4: trim, then require 1–50 Unicode
//    CODE POINTS.
// ---------------------------------------------------------------------------

/**
 * Counts Unicode CODE POINTS — `char_length` in Postgres counts code points, so
 * a single astral character (e.g. an emoji) counts as 1, not 2. `[...str].length`
 * iterates by code point, matching that semantics.
 */
export function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Whether `rawText`, after a surrounding trim, is a valid 1–50 code-point
 * word-cloud response (Req 6.8). NULL/undefined and empty/whitespace-only input
 * collapse to length 0 and are invalid; over-length (>50) is invalid.
 */
export function isValidResponseText(
  rawText: string | null | undefined,
): boolean {
  if (rawText === null || rawText === undefined) {
    return false;
  }
  const len = codePointLength(rawText.trim());
  return len >= MIN_RESPONSE_LENGTH && len <= MAX_RESPONSE_LENGTH;
}

// ---------------------------------------------------------------------------
// In-memory reference store + model.
//
// This mirrors the RPCs' effects on `word_cloud_prompts` (status lifecycle +
// the one_open_prompt_per_event partial unique index) and
// `word_cloud_responses` (the UNIQUE (participant_identifier, prompt_id) rows,
// their raw/normalised text, and is_hidden) — enough to exercise the
// single-open invariant, one-response-per-participant uniqueness and
// latest-text-tracking as pure logic.
// ---------------------------------------------------------------------------

/** A stored word-cloud prompt row (the subset the rule model needs). */
export interface WordCloudPromptRow {
  readonly id: string;
  readonly eventId: string;
  status: WordCloudStatus;
}

/** A stored word-cloud response row (the subset the rule model needs). */
export interface WordCloudResponseRow {
  readonly id: string;
  readonly promptId: string;
  readonly eventId: string;
  readonly participant: string;
  rawText: string;
  normalisedText: string;
  isHidden: boolean;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** `${participant}::${promptId}` — mirrors the UNIQUE response constraint. */
function responseKey(participant: string, promptId: string): string {
  return `${participant}::${promptId}`;
}

/**
 * A tiny in-process model of the word-cloud prompt-lifecycle and response-upsert
 * RPC effects. It is PURE (no I/O, no timers, no network) and deterministic.
 *
 * The public API is deliberately shaped to support BOTH property tests
 * (task 22.6) and example-based unit tests (task 22.5): fixture helpers
 * (`addEvent`, `addPrompt`), the two RPC-mirroring mutators (`setPromptStatus`,
 * `submitResponse`), and read helpers (`getPrompt`, `getResponse`,
 * `getOpenPromptCount`, `getResponsesForPrompt`).
 */
export class WordCloudModel {
  /** event_id → live-ness. */
  private readonly eventLive = new Map<string, boolean>();
  /** prompt_id → prompt row. */
  private readonly prompts = new Map<string, WordCloudPromptRow>();
  /** `${participant}::${promptId}` → response row (the UNIQUE key). */
  private readonly responses = new Map<string, WordCloudResponseRow>();

  // ---- Fixture helpers ----------------------------------------------------

  /**
   * Register (or update) an event's live-ness (test fixture helper). Events
   * default to live=true if never registered when a prompt gates on them, but
   * registering explicitly is preferred for clarity.
   */
  addEvent(eventId: string, opts: { live?: boolean } = {}): void {
    this.eventLive.set(eventId, opts.live ?? true);
  }

  /**
   * Seed a prompt row (test fixture helper), returning its id. If `eventId`'s
   * live-ness has not been registered it defaults to live. A prompt seeded
   * directly as `'open'` still respects the single-open invariant: seeding a
   * second open prompt for the same event throws `prompt_already_open` so
   * fixtures cannot construct an illegal state.
   */
  addPrompt(row: {
    eventId: string;
    status?: WordCloudStatus;
    id?: string;
  }): string {
    const status = row.status ?? 'draft';
    if (!this.eventLive.has(row.eventId)) {
      this.eventLive.set(row.eventId, true);
    }
    if (status === 'open' && this.getOpenPromptCount(row.eventId) >= 1) {
      throw new WordCloudRuleError('prompt_already_open');
    }
    const id = row.id ?? nextId('wcp');
    this.prompts.set(id, { id, eventId: row.eventId, status });
    return id;
  }

  // ---- Read helpers -------------------------------------------------------

  /** Read a prompt row (test helper); returns undefined if unknown. */
  getPrompt(promptId: string): Readonly<WordCloudPromptRow> | undefined {
    return this.prompts.get(promptId);
  }

  /** Whether an event is currently live (defaults to false if unknown). */
  isEventLive(eventId: string): boolean {
    return this.eventLive.get(eventId) === true;
  }

  /**
   * How many prompts for `eventId` are currently `'open'`. The core invariant
   * (Req 6.5, Property 7) is that this is ALWAYS `<= 1`; it mirrors the
   * `one_open_prompt_per_event` partial unique index.
   */
  getOpenPromptCount(eventId: string): number {
    let count = 0;
    for (const prompt of this.prompts.values()) {
      if (prompt.eventId === eventId && prompt.status === 'open') {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Read the single response for `(participant, promptId)` (Req 6.6); returns
   * undefined if that participant has not responded to that prompt.
   */
  getResponse(
    participant: string,
    promptId: string,
  ): Readonly<WordCloudResponseRow> | undefined {
    return this.responses.get(responseKey(participant, promptId));
  }

  /** All response rows for a prompt (test/aggregation helper). */
  getResponsesForPrompt(promptId: string): Readonly<WordCloudResponseRow>[] {
    const out: WordCloudResponseRow[] = [];
    for (const response of this.responses.values()) {
      if (response.promptId === promptId) {
        out.push(response);
      }
    }
    return out;
  }

  // ---- RPC-mirroring mutators --------------------------------------------

  /**
   * Mirrors set_word_cloud_prompt_status. Order matches the SQL:
   *   1. prompt must exist — else `prompt_not_found`,
   *   2. transition must be draft→open→closed or a same-status no-op — else
   *      `invalid_transition` (nothing changed) (Req 6.4),
   *   3. when transitioning TO 'open', the single-open-prompt-per-event guard
   *      (mirroring the `one_open_prompt_per_event` partial unique index) rejects
   *      a second open with `prompt_already_open`, leaving BOTH prompts unchanged
   *      (Req 6.5, Property 7),
   *   4. otherwise apply the status and return the updated row.
   *
   * @returns the prompt row after the (possibly no-op) transition.
   */
  setPromptStatus(
    promptId: string,
    status: WordCloudStatus,
  ): Readonly<WordCloudPromptRow> {
    const prompt = this.prompts.get(promptId);
    if (!prompt) {
      throw new WordCloudRuleError('prompt_not_found');
    }

    // 2. Enforce the lifecycle (Req 6.4). Nothing is changed on rejection.
    if (!isValidPromptTransition(prompt.status, status)) {
      throw new WordCloudRuleError('invalid_transition');
    }

    // 3. Single-open guard when actually opening (draft→open) (Req 6.5). A
    //    same-status open→open no-op is NOT re-guarded (this prompt is the open
    //    one). Both prompts stay unchanged when the guard trips.
    if (status === 'open' && prompt.status !== 'open') {
      if (this.getOpenPromptCount(prompt.eventId) >= 1) {
        throw new WordCloudRuleError('prompt_already_open');
      }
    }

    // 4. Apply + return.
    prompt.status = status;
    return prompt;
  }

  /**
   * Mirrors submit_word_cloud_response (rate limiting omitted — it is exercised
   * by the qaRules model; this model focuses on the response-identity
   * invariants). Order matches the SQL:
   *   1. prompt must exist — else `prompt_not_found`,
   *   2. prompt must be 'open' — else `prompt_not_open`, and ANY prior response
   *      is RETAINED unchanged (Req 6.7),
   *   3. event must be live — else `event_not_live` (prior response retained),
   *   4. trim + validate 1–50 code points — else `invalid_length` (prior
   *      response retained) (Req 6.8),
   *   5. normalise the trimmed text via the shared {@link normalise} (Req 6.10),
   *   6. UPSERT on UNIQUE (participant, prompt): a resubmit REPLACES the prior
   *      row's `rawText`/`normalisedText` (tracking the latest text) but keeps
   *      the SAME row id and preserves `isHidden` (Req 6.6, 6.9) — so exactly one
   *      response row per (participant, prompt) ever exists.
   *
   * @returns the created-or-updated response row.
   */
  submitResponse(
    promptId: string,
    participant: string,
    rawText: string | null | undefined,
  ): Readonly<WordCloudResponseRow> {
    // 1. Prompt must exist.
    const prompt = this.prompts.get(promptId);
    if (!prompt) {
      throw new WordCloudRuleError('prompt_not_found');
    }

    // 2. Prompt must be 'open' (Req 6.7); prior response retained on rejection.
    if (prompt.status !== 'open') {
      throw new WordCloudRuleError('prompt_not_open');
    }

    // 3. Event must be live (Req 6.7 gating); prior response retained.
    if (!this.isEventLive(prompt.eventId)) {
      throw new WordCloudRuleError('event_not_live');
    }

    // 4. Length validation (Req 6.8); prior response retained on rejection.
    if (!isValidResponseText(rawText)) {
      throw new WordCloudRuleError('invalid_length');
    }
    const trimmed = (rawText as string).trim();

    // 5. Normalise on write via the SHARED contract (Req 6.10).
    const normalisedText = normalise(trimmed);

    // 6. Upsert on UNIQUE (participant, prompt) (Req 6.6, 6.9).
    const key = responseKey(participant, promptId);
    const existing = this.responses.get(key);
    if (existing) {
      // Resubmit: replace text, keep the same row id, preserve is_hidden so a
      // moderated (hidden) entry stays hidden across resubmission.
      existing.rawText = trimmed;
      existing.normalisedText = normalisedText;
      return existing;
    }
    const row: WordCloudResponseRow = {
      id: nextId('wcr'),
      promptId,
      eventId: prompt.eventId,
      participant,
      rawText: trimmed,
      normalisedText,
      isHidden: false,
    };
    this.responses.set(key, row);
    return row;
  }

  /**
   * Moderator hide/unhide of an existing response (test helper mirroring the
   * hide/unhide RPC's effect on `is_hidden`). Returns the updated row, or throws
   * `prompt_not_found` if no such response exists. Kept minimal — the
   * aggregation exclusion of hidden entries is covered by Property 9 against the
   * shared `aggregateWordCloud`.
   */
  setResponseHidden(
    participant: string,
    promptId: string,
    isHidden: boolean,
  ): Readonly<WordCloudResponseRow> {
    const row = this.responses.get(responseKey(participant, promptId));
    if (!row) {
      throw new WordCloudRuleError('prompt_not_found');
    }
    row.isHidden = isHidden;
    return row;
  }
}
