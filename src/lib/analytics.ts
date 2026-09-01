/**
 * Event analytics aggregation: the SHARED, framework-agnostic contract for
 * turning already-loaded, NON-identifier query inputs into the numbers the
 * admin analytics dashboard renders.
 *
 * =============================================================================
 * SHARED CONTRACT — SINGLE SOURCE OF TRUTH
 * =============================================================================
 * This pure module is the canonical definition of HOW the admin analytics
 * dashboard's metrics are computed from raw query inputs. It has NO dependencies
 * (no React, no zod, no Supabase/DB/network, no Deno globals, no `Date.now()` /
 * ambient clock — the "current time" is passed in as {@link EventAnalyticsInput.asOf}
 * for determinism) so it can be imported by BOTH the SPA read path (task 38.2)
 * and exercised directly by Vitest (task 38.5).
 *
 * The read-path/client helper (task 38.2) is responsible for LOADING the query
 * inputs (running the aggregation queries / selecting the timestamped
 * interaction rows) and then delegating the actual arithmetic to
 * {@link computeEventAnalytics} here. This module performs the arithmetic ONLY;
 * it never touches the database, the network, or the clock.
 *
 * ── PRIVACY — no Participant_Identifier ever leaves this module (Req 8.6) ────
 * The unique-participant metric is the count of DISTINCT Participant_Identifiers.
 * This module accepts the identifiers as an array of opaque string tokens and
 * returns ONLY their distinct COUNT (`new Set(...).size`). The raw identifier
 * values are read solely to size the set; they are NEVER stored on the result,
 * echoed back, logged, or exposed in any form. The result interface
 * ({@link EventAnalytics}) deliberately exposes no field carrying an identifier
 * value — only the non-negative integer `uniqueParticipants`. Callers that have
 * already computed the distinct count server-side (e.g. `COUNT(DISTINCT …)`) may
 * instead pass a pre-computed non-negative integer via
 * {@link EventAnalyticsInput.uniqueParticipantCount}, in which case no identifier
 * list crosses the boundary at all. (Req 8.1, 8.6.)
 *
 * ── What it computes (Req 8.1–8.4, 8.8) ─────────────────────────────────────
 *   * uniqueParticipants  — distinct Participant_Identifiers            (Req 8.1)
 *   * question status counts (approved/featured/answered/hidden) plus a
 *     totalSubmitted total                                              (Req 8.2)
 *   * totalVotes          — total question votes                        (Req 8.3)
 *   * pollResponses       — total poll responses                        (Req 8.3)
 *   * wordCloudResponses  — total word-cloud responses                  (Req 8.3)
 *   * engagementOverTime  — interaction counts bucketed into fixed
 *                           5-minute intervals spanning event start → now (Req 8.4)
 *
 * ── Zero-interaction event (Req 8.8) ────────────────────────────────────────
 * When an event has zero recorded interactions (empty inputs), every scalar
 * metric is `0` and the engagement series is either empty (when `asOf` is at or
 * before the event start) or a contiguous run of all-zero buckets (when time has
 * elapsed since the event start). Either way, no bucket carries a positive count.
 *
 * ── Purity guarantees ───────────────────────────────────────────────────────
 * {@link computeEventAnalytics} is a PURE function: it performs no I/O, does not
 * mutate its inputs, is deterministic given its inputs (including the injected
 * `asOf`), and every returned scalar is a non-negative integer. It is therefore
 * safe to import in both client and (conceptually) server code and is exercised
 * directly by unit + property tests (task 38.5).
 *
 * Requirements traceability: 8.1, 8.2, 8.3, 8.4, 8.6, 8.8.
 * Design references: Components and Interfaces (Analytics_Service — aggregation);
 * Data Models (`questions.status` / `question_status` enum, `question_votes`,
 * `poll_responses`, `word_cloud_responses`, opaque `participant_identifier`).
 */

// ----------------------------------------------------------------------------
// Constants.
// ----------------------------------------------------------------------------

/**
 * The fixed engagement-over-time bucket width, in minutes (Req 8.4). The series
 * aggregates interaction counts into contiguous intervals of exactly this many
 * minutes, aligned to the event start time.
 */
export const BUCKET_MINUTES = 5 as const;

/** {@link BUCKET_MINUTES} expressed in milliseconds. */
export const BUCKET_MS = BUCKET_MINUTES * 60 * 1000;

// ----------------------------------------------------------------------------
// Question status counts.
// ----------------------------------------------------------------------------

/**
 * The moderation lifecycle statuses of a question, mirroring the DB
 * `question_status` enum (see `supabase/migrations/20260101000009_questions.sql`):
 * `pending` (awaiting pre-moderation), `approved` (visible to audience),
 * `featured` (highlighted), `answered`, and `hidden` (Req 3.5).
 */
export type QuestionStatus =
  'pending' | 'approved' | 'featured' | 'answered' | 'hidden';

/**
 * Per-status question counts for the analytics dashboard (Req 8.2).
 *
 * Req 8.2 asks specifically for separate non-negative integer counts of
 * questions in each of `approved`, `featured`, `answered`, and `hidden`, plus a
 * `totalSubmitted` total. `pending` is intentionally NOT surfaced as its own
 * field because Req 8.2 does not enumerate it; it is still folded into
 * `totalSubmitted` (see the DECISION note on {@link QuestionStatusCounts.totalSubmitted}).
 */
export interface QuestionStatusCounts {
  /** Count of questions with status `approved` (Req 8.2). */
  readonly approved: number;
  /** Count of questions with status `featured` (Req 8.2). */
  readonly featured: number;
  /** Count of questions with status `answered` (Req 8.2). */
  readonly answered: number;
  /** Count of questions with status `hidden` (Req 8.2). */
  readonly hidden: number;
  /**
   * The total number of submitted questions for the event (Req 8.2).
   *
   * ── DECISION — what "total submitted" counts ────────────────────────────
   * `totalSubmitted` is EVERY question row for the event regardless of status,
   * i.e. it counts `pending + approved + featured + answered + hidden`. A
   * question is "submitted" the moment its row exists; moderation only changes
   * its `status` afterwards, so hidden and still-pending questions were both
   * genuinely submitted and are therefore included in the submitted total. This
   * makes `totalSubmitted` an accurate submission-volume figure and means it is
   * always `>=` the sum of the four broken-out status counts (the difference,
   * if any, is the number of `pending` questions).
   */
  readonly totalSubmitted: number;
}

// ----------------------------------------------------------------------------
// Interaction events (for the engagement-over-time series).
// ----------------------------------------------------------------------------

/**
 * A single timestamped INTERACTION used to build the engagement-over-time
 * series (Req 8.4).
 *
 * ── DECISION — what counts as an "interaction" ──────────────────────────────
 * An interaction is any single participant action that produced a recorded row
 * during the event, namely:
 *   * a submitted question,
 *   * a question vote,
 *   * a poll response, and
 *   * a word-cloud response.
 * Each such row contributes exactly ONE interaction to the bucket covering its
 * timestamp. The caller (task 38.2) is responsible for collecting these
 * timestamps from the four sources and passing them in via
 * {@link EventAnalyticsInput.interactions}; this module treats them uniformly and
 * only reads each event's `at` timestamp. Crucially, an interaction carries NO
 * participant identity — only an instant — so the series exposes no identifier
 * (Req 8.6).
 */
export interface InteractionEvent {
  /**
   * The instant the interaction occurred, as an ISO-8601 timestamp string (e.g.
   * `'2026-01-01T12:34:56.000Z'`). Parsed with {@link Date} for bucketing. An
   * interaction whose timestamp is unparseable, before the event start, or at/after
   * `asOf` falls outside the series window and is excluded from all buckets.
   */
  readonly at: string;
}

/** A single point in the engagement-over-time series (Req 8.4). */
export interface EngagementBucket {
  /**
   * The inclusive start instant of this 5-minute bucket, as an ISO-8601 string
   * (UTC, via {@link Date.prototype.toISOString}). Buckets are contiguous and
   * aligned to the event start: bucket `i` covers `[start + i·5min, start + (i+1)·5min)`.
   */
  readonly bucketStart: string;
  /**
   * The number of interactions whose timestamp falls in this bucket's
   * half-open interval. Always a non-negative integer; `0` for buckets with no
   * interactions (Req 8.8).
   */
  readonly count: number;
}

// ----------------------------------------------------------------------------
// Aggregation input / result.
// ----------------------------------------------------------------------------

/**
 * The already-loaded, NON-identifier query inputs {@link computeEventAnalytics}
 * aggregates. The read-path helper (task 38.2) populates this from its
 * aggregation queries; this module never fetches anything itself.
 */
export interface EventAnalyticsInput {
  /**
   * The opaque Participant_Identifier tokens seen for the event, used ONLY to
   * compute the distinct count (Req 8.1). The raw values NEVER leave this
   * module — see the privacy note in the module header (Req 8.6). Provide this
   * OR {@link uniqueParticipantCount}; if both are given,
   * `uniqueParticipantCount` takes precedence. Omitted/empty ⇒ `0` distinct.
   */
  readonly participantIdentifiers?: readonly string[];
  /**
   * A pre-computed distinct-participant count (e.g. from a server-side
   * `COUNT(DISTINCT participant_identifier)`), used INSTEAD of
   * {@link participantIdentifiers} when supplied. Must be a non-negative integer;
   * it is coerced defensively via {@link toCount}. Passing this avoids sending
   * any identifier list across the boundary at all (Req 8.6).
   */
  readonly uniqueParticipantCount?: number;
  /**
   * The number of question rows in each status. Missing statuses count as `0`.
   * Only the statuses present are read; `totalSubmitted` is derived as the sum
   * of ALL provided status counts (Req 8.2 — see {@link QuestionStatusCounts.totalSubmitted}).
   */
  readonly questionStatusCounts?: Partial<Record<QuestionStatus, number>>;
  /** Total question votes across the event (Req 8.3). Omitted ⇒ `0`. */
  readonly totalVotes?: number;
  /** Total poll responses across the event (Req 8.3). Omitted ⇒ `0`. */
  readonly pollResponses?: number;
  /** Total word-cloud responses across the event (Req 8.3). Omitted ⇒ `0`. */
  readonly wordCloudResponses?: number;
  /**
   * The event start instant as an ISO-8601 timestamp. The engagement series is
   * aligned to and begins at this instant (Req 8.4). If omitted or unparseable,
   * the engagement series is empty (there is no window to bucket over).
   */
  readonly eventStart?: string;
  /**
   * The "current time" for the engagement series, as an ISO-8601 timestamp,
   * INJECTED for determinism/testability (the module never reads an ambient
   * clock). Buckets span `[eventStart, asOf)` (Req 8.4). If omitted, unparseable,
   * or at/before `eventStart`, the engagement series is empty.
   */
  readonly asOf?: string;
  /**
   * The timestamped interactions to bucket into the engagement series (Req 8.4).
   * See {@link InteractionEvent} for what an interaction is. Omitted/empty ⇒ the
   * series contains all-zero buckets (or is empty if there is no window).
   */
  readonly interactions?: readonly InteractionEvent[];
}

/**
 * The fully-aggregated analytics for one event, as rendered on the admin
 * dashboard (Req 8.1–8.4). Every scalar is a NON-NEGATIVE INTEGER. Note there is
 * deliberately NO field carrying a raw Participant_Identifier value (Req 8.6).
 */
export interface EventAnalytics {
  /** Distinct Participant_Identifiers seen for the event (Req 8.1). */
  readonly uniqueParticipants: number;
  /** Per-status question counts + submitted total (Req 8.2). */
  readonly questionStatusCounts: QuestionStatusCounts;
  /** Total question votes (Req 8.3). */
  readonly totalVotes: number;
  /** Total poll responses (Req 8.3). */
  readonly pollResponses: number;
  /** Total word-cloud responses (Req 8.3). */
  readonly wordCloudResponses: number;
  /**
   * Interaction counts bucketed into contiguous fixed 5-minute intervals
   * spanning the event start to `asOf` (Req 8.4). Empty when there is no window
   * (no/invalid `eventStart` or `asOf`, or `asOf <= eventStart`); otherwise it
   * contains one bucket per 5-minute interval, including zero-count buckets
   * (Req 8.8).
   */
  readonly engagementOverTime: readonly EngagementBucket[];
}

// ----------------------------------------------------------------------------
// Internal helpers.
// ----------------------------------------------------------------------------

/**
 * Coerces an arbitrary numeric input into a NON-NEGATIVE INTEGER count.
 * `undefined`, `NaN`, non-finite, or negative inputs collapse to `0`; fractional
 * inputs are floored. This guarantees every metric this module returns is a
 * clean, non-negative integer regardless of caller sloppiness (Req 8.1–8.3, 8.8).
 */
function toCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Parses an ISO-8601 timestamp string into epoch milliseconds, or returns
 * `undefined` if it is missing or unparseable. Deterministic and side-effect
 * free (uses only {@link Date} parsing, not the ambient clock).
 */
function parseInstant(iso: string | undefined): number | undefined {
  if (iso === undefined) {
    return undefined;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Builds the engagement-over-time series: contiguous, 5-minute buckets aligned
 * to and beginning at the event start, spanning `[startMs, asOfMs)`, each
 * counting the interactions whose timestamp falls in its half-open interval
 * (Req 8.4).
 *
 * Bucketing is deterministic: bucket `i` covers `[startMs + i·BUCKET_MS,
 * startMs + (i+1)·BUCKET_MS)`. The number of buckets is
 * `ceil((asOfMs - startMs) / BUCKET_MS)` so that the final partial interval up
 * to `asOf` is always represented as one whole bucket. Interactions outside
 * `[startMs, asOfMs)` (or with unparseable timestamps) are ignored. When the
 * window is empty or invalid (`asOfMs <= startMs`, or either bound missing) the
 * series is empty. All buckets with no interactions carry `count: 0` (Req 8.8).
 */
function buildEngagementSeries(
  startMs: number | undefined,
  asOfMs: number | undefined,
  interactions: readonly InteractionEvent[],
): EngagementBucket[] {
  // No valid window ⇒ no series (covers missing/invalid bounds and asOf <= start).
  if (startMs === undefined || asOfMs === undefined || asOfMs <= startMs) {
    return [];
  }

  const bucketCount = Math.ceil((asOfMs - startMs) / BUCKET_MS);
  const counts = new Array<number>(bucketCount).fill(0);

  for (const interaction of interactions) {
    const at = parseInstant(interaction.at);
    // Exclude unparseable timestamps and anything outside [startMs, asOfMs).
    if (at === undefined || at < startMs || at >= asOfMs) {
      continue;
    }
    const index = Math.floor((at - startMs) / BUCKET_MS);
    // Defensive: index is guaranteed in-range by the bounds check above, but
    // guard against any floating-point edge just in case.
    if (index >= 0 && index < bucketCount) {
      counts[index] += 1;
    }
  }

  return counts.map((count, i) => ({
    bucketStart: new Date(startMs + i * BUCKET_MS).toISOString(),
    count,
  }));
}

// ----------------------------------------------------------------------------
// Aggregation.
// ----------------------------------------------------------------------------

/**
 * Aggregates already-loaded query inputs into the {@link EventAnalytics} the
 * admin dashboard renders (Req 8.1–8.4, 8.8).
 *
 * Behaviour:
 *   1. `uniqueParticipants` — uses {@link EventAnalyticsInput.uniqueParticipantCount}
 *      when supplied (coerced to a non-negative integer); otherwise counts the
 *      DISTINCT values of {@link EventAnalyticsInput.participantIdentifiers} via
 *      `new Set(...).size`. The raw identifiers are read only to size the set and
 *      are NEVER returned or otherwise exposed (Req 8.1, 8.6).
 *   2. question status counts — reads the per-status counts (missing ⇒ `0`) and
 *      derives `totalSubmitted` as the sum of ALL provided status counts,
 *      including `pending` (Req 8.2; see {@link QuestionStatusCounts.totalSubmitted}).
 *   3. `totalVotes` / `pollResponses` / `wordCloudResponses` — coerced
 *      non-negative integers (Req 8.3).
 *   4. `engagementOverTime` — contiguous 5-minute buckets spanning
 *      `[eventStart, asOf)` (Req 8.4); see {@link buildEngagementSeries}.
 *
 * With empty/omitted inputs (a zero-interaction event) every scalar is `0` and
 * the series is empty or all-zero buckets (Req 8.8).
 *
 * This is a PURE function: no I/O, no input mutation, deterministic given its
 * inputs (including the injected `asOf`).
 *
 * @param input the already-loaded, non-identifier query inputs.
 * @returns the aggregated analytics; no field carries a raw identifier (Req 8.6).
 */
export function computeEventAnalytics(
  input: EventAnalyticsInput,
): EventAnalytics {
  // (1) Distinct participants — pre-computed count wins; else count-distinct the
  // opaque tokens and discard them. Raw values never leave this function (Req 8.6).
  const uniqueParticipants =
    input.uniqueParticipantCount !== undefined
      ? toCount(input.uniqueParticipantCount)
      : new Set(input.participantIdentifiers ?? []).size;

  // (2) Question status counts + submitted total (Req 8.2).
  const statuses = input.questionStatusCounts ?? {};
  const approved = toCount(statuses.approved);
  const featured = toCount(statuses.featured);
  const answered = toCount(statuses.answered);
  const hidden = toCount(statuses.hidden);
  const pending = toCount(statuses.pending);
  // totalSubmitted = every submitted question regardless of status (incl. pending).
  const totalSubmitted = approved + featured + answered + hidden + pending;

  return {
    uniqueParticipants,
    questionStatusCounts: {
      approved,
      featured,
      answered,
      hidden,
      totalSubmitted,
    },
    // (3) Simple sums/counts (Req 8.3).
    totalVotes: toCount(input.totalVotes),
    pollResponses: toCount(input.pollResponses),
    wordCloudResponses: toCount(input.wordCloudResponses),
    // (4) Engagement-over-time series (Req 8.4).
    engagementOverTime: buildEngagementSeries(
      parseInstant(input.eventStart),
      parseInstant(input.asOf),
      input.interactions ?? [],
    ),
  };
}
