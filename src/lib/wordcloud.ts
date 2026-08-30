/**
 * Word-cloud normalisation and aggregation: the SHARED, framework-agnostic
 * contract for turning raw word-cloud responses into rendered term data.
 *
 * =============================================================================
 * SHARED CONTRACT — SINGLE SOURCE OF TRUTH
 * =============================================================================
 * This pure module is the canonical definition of how word-cloud responses are
 * normalised, aggregated, and sized. It has NO dependencies (no React, no zod,
 * no Supabase/DB/network, no Deno globals) so it can be imported by BOTH:
 *
 *   - the SPA (audience client-side preview + the audience/presenter word-cloud
 *     visualisations, tasks 23.4 / 24.x), and
 *   - conceptually the server write path — the word-cloud response upsert RPC
 *     (task 22.3) normalises `raw_text` into `normalised_text` on write using
 *     the SAME `normalise()` contract. Because Deno/SQL cannot import this
 *     `src/` path directly, that path RE-IMPLEMENTS the identical normalisation
 *     rule; if you change the rule here, change it there too (and vice-versa).
 *
 * `normalise()` is the single source of truth for what "the same term" means:
 * two responses aggregate into one term iff their normalised values are equal
 * (Req 6.10, 6.11). Stop-word / exclusion-list comparison uses the SAME
 * `normalise()` so exclusion is normalisation-consistent (Req 6.14).
 *
 * Requirements traceability: 6.10, 6.11, 6.13, 6.14.
 * Design references: Request/data flows (Word cloud — normalisation,
 * aggregation, monotonic sizing); Technology Stack (d3-cloud — we own
 * aggregation/sizing); Data Models (`word_cloud_responses.normalised_text`
 * computed on write, `is_hidden`).
 */

// ----------------------------------------------------------------------------
// Normalisation.
// ----------------------------------------------------------------------------

/**
 * Matches one or more consecutive Unicode whitespace characters. Used both to
 * TRIM leading/trailing whitespace and to COLLAPSE internal runs to a single
 * ASCII space. `\s` in JS regex is Unicode-whitespace-aware (spaces, tabs,
 * newlines, CR, form feed, vertical tab, NBSP, and other Unicode spaces).
 */
const WHITESPACE_RUN = /\s+/;

/**
 * Canonically normalises a word-cloud response for aggregation and rendering
 * (Req 6.10):
 *
 *   1. lower-cases all letters (Unicode-aware via {@link String.prototype.toLowerCase});
 *   2. trims leading and trailing whitespace; and
 *   3. collapses each run of consecutive INTERNAL whitespace to a single ASCII
 *      space (`' '`).
 *
 * Only LETTERS are lower-cased; digits, punctuation, emoji, and every other
 * character are preserved as-is (aside from whitespace collapsing).
 *
 * ── Canonical & idempotent ──────────────────────────────────────────────────
 * The result is CANONICAL: it has no leading/trailing whitespace, no run of two
 * or more consecutive internal whitespace characters, and no upper-case letters.
 * Consequently the function is IDEMPOTENT — re-normalising a normalised value is
 * a no-op:
 *
 *     normalise(normalise(s)) === normalise(s)   // for every string s
 *
 * This is what lets the write path store `normalised_text` once and lets the
 * client compare / group by it without re-normalising, and it is exercised as a
 * correctness property in task 22.6 (Property 8).
 *
 * @param s the raw response text.
 * @returns the canonical, idempotent normalised term.
 */
export function normalise(s: string): string {
  // toLowerCase first (Unicode-aware), then trim, then collapse internal runs.
  // Splitting on the whitespace run and re-joining with a single space performs
  // BOTH the trim (empty leading/trailing segments are dropped by filtering)
  // and the internal collapse in one pass, guaranteeing the canonical shape.
  return s
    .toLowerCase()
    .split(WHITESPACE_RUN)
    .filter((segment) => segment.length > 0)
    .join(' ');
}

// ----------------------------------------------------------------------------
// Aggregation types.
// ----------------------------------------------------------------------------

/**
 * The minimal shape of a stored word-cloud response this module needs to
 * aggregate. Additional columns (id, prompt_id, participant_identifier,
 * timestamps, …) are ignored here and MUST NOT be relied upon — participant
 * identity in particular must never flow into rendering (Req 8.6).
 */
export interface WordCloudResponseLike {
  /**
   * The already-normalised term, as computed on write by the response RPC
   * (task 22.3) using {@link normalise}. This module re-normalises it defensively
   * so aggregation is correct even if a caller passes not-yet-normalised text.
   */
  readonly normalised_text: string;
  /**
   * Whether a moderator has hidden this individual entry (Req 6.12). Hidden
   * entries are EXCLUDED from aggregation, the audience view, and the presenter
   * view (Req 6.13).
   */
  readonly is_hidden: boolean;
}

/** Options controlling {@link aggregateWordCloud}. */
export interface AggregateWordCloudOptions {
  /**
   * Stop words / admin-maintained exclusion-list terms to remove before
   * rendering (Req 6.14). They are compared using the SAME {@link normalise} as
   * responses, so `"The"`, `" the "`, and `"the"` all exclude the term `"the"`.
   * Omitted/empty → no terms excluded.
   */
  readonly stopWords?: readonly string[];
  /**
   * The smallest rendered size (inclusive), assigned to the least-frequent
   * term(s). Defaults to {@link DEFAULT_MIN_SIZE}. Must be `<= maxSize`.
   */
  readonly minSize?: number;
  /**
   * The largest rendered size (inclusive), assigned to the most-frequent
   * term(s). Defaults to {@link DEFAULT_MAX_SIZE}. Must be `>= minSize`.
   */
  readonly maxSize?: number;
}

/** A single aggregated term ready for rendering. */
export interface WordCloudTerm {
  /** The canonical normalised term (see {@link normalise}). */
  readonly term: string;
  /** How many (visible, non-stop-word) responses aggregated into this term. */
  readonly frequency: number;
  /**
   * The rendered size for this term. Guaranteed to be a NON-DECREASING function
   * of {@link frequency} across the returned set (see {@link sizeForFrequency}).
   */
  readonly size: number;
}

// ----------------------------------------------------------------------------
// Sizing.
// ----------------------------------------------------------------------------

/** Default smallest rendered term size when `minSize` is not supplied. */
export const DEFAULT_MIN_SIZE = 12 as const;
/** Default largest rendered term size when `maxSize` is not supplied. */
export const DEFAULT_MAX_SIZE = 72 as const;

/**
 * Maps a frequency to a rendered size by LINEAR INTERPOLATION between `minSize`
 * (at `minFreq`) and `maxSize` (at `maxFreq`).
 *
 * ── Monotonicity guarantee ──────────────────────────────────────────────────
 * For any two frequencies with `f1 <= f2` (given the same bounds):
 *
 *     sizeForFrequency(f1, ...) <= sizeForFrequency(f2, ...)
 *
 * i.e. size is a NON-DECREASING function of frequency (Req 6.11). This holds
 * because the interpolation slope `(maxSize - minSize) / (maxFreq - minFreq)` is
 * non-negative (we require `maxSize >= minSize`), and the degenerate case where
 * every term shares one frequency (`maxFreq === minFreq`) collapses to the
 * constant `maxSize`, which is trivially non-decreasing. The result is also
 * clamped into `[minSize, maxSize]` to absorb any floating-point drift, which
 * preserves monotonicity.
 *
 * @param freq the term's aggregated frequency.
 * @param minFreq the smallest frequency present in the aggregated set.
 * @param maxFreq the largest frequency present in the aggregated set.
 * @param minSize the size assigned at `minFreq`.
 * @param maxSize the size assigned at `maxFreq`.
 */
export function sizeForFrequency(
  freq: number,
  minFreq: number,
  maxFreq: number,
  minSize: number,
  maxSize: number,
): number {
  // Degenerate span: a single distinct frequency (or an inverted/zero range).
  // Every term renders at the maximum size; constant ⇒ trivially monotonic.
  if (maxFreq <= minFreq) {
    return maxSize;
  }
  const ratio = (freq - minFreq) / (maxFreq - minFreq);
  const size = minSize + ratio * (maxSize - minSize);
  // Clamp to absorb floating-point drift; preserves the [minSize, maxSize] range
  // and the non-decreasing property.
  return Math.min(maxSize, Math.max(minSize, size));
}

// ----------------------------------------------------------------------------
// Aggregation.
// ----------------------------------------------------------------------------

/**
 * Aggregates word-cloud responses into per-term frequency counts with a
 * monotonic size mapping, ready for rendering (Req 6.11, 6.13, 6.14).
 *
 * Pipeline:
 *   1. EXCLUDE hidden entries (`is_hidden === true`) — hidden entries never
 *      contribute to aggregation or appear in any view (Req 6.13).
 *   2. NORMALISE each remaining term via {@link normalise} (defensive; the write
 *      path already stores normalised text) and drop empty results.
 *   3. EXCLUDE configured stop-words / exclusion-list terms, compared using the
 *      SAME {@link normalise} so comparison is normalisation-consistent (Req 6.14).
 *   4. GROUP the survivors by normalised term and COUNT each group's frequency
 *      (Req 6.11 — identical normalised values aggregate into one term).
 *   5. ASSIGN each term a `size` that is a NON-DECREASING function of frequency
 *      via {@link sizeForFrequency} (Req 6.11 — size increases monotonically with
 *      frequency).
 *
 * This is a PURE function: it performs no I/O, does not mutate its inputs, and
 * is deterministic. It is therefore safe to import in both client and server
 * code and is exercised directly by property tests (task 22.6).
 *
 * @param responses the stored responses to aggregate; only `normalised_text`
 *   and `is_hidden` are read.
 * @param opts stop words + size bounds (see {@link AggregateWordCloudOptions}).
 * @returns terms sorted by frequency DESCENDING (ties broken by term ascending
 *   for a stable, deterministic order), each carrying its `frequency` and a
 *   `size` that is non-decreasing in `frequency`.
 */
export function aggregateWordCloud(
  responses: readonly WordCloudResponseLike[],
  opts: AggregateWordCloudOptions = {},
): WordCloudTerm[] {
  const minSize = opts.minSize ?? DEFAULT_MIN_SIZE;
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;

  // Build the set of excluded terms using the SAME normalisation as responses,
  // so stop-word comparison is normalisation-consistent (Req 6.14). Empty
  // normalised stop words are ignored.
  const excluded = new Set<string>();
  for (const raw of opts.stopWords ?? []) {
    const term = normalise(raw);
    if (term.length > 0) {
      excluded.add(term);
    }
  }

  // Group non-hidden, non-stop-word, non-empty terms and count frequencies.
  const counts = new Map<string, number>();
  for (const response of responses) {
    // (1) exclude hidden entries (Req 6.13).
    if (response.is_hidden === true) {
      continue;
    }
    // (2) normalise defensively and drop empties.
    const term = normalise(response.normalised_text);
    if (term.length === 0) {
      continue;
    }
    // (3) exclude configured stop words / exclusion-list terms (Req 6.14).
    if (excluded.has(term)) {
      continue;
    }
    // (4) count.
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return [];
  }

  // Determine the frequency span for the monotonic size mapping.
  const frequencies = Array.from(counts.values());
  const minFreq = Math.min(...frequencies);
  const maxFreq = Math.max(...frequencies);

  // (5) assign a monotonic size to each term, then sort by frequency desc
  // (ties broken by term asc for a deterministic, stable order).
  return Array.from(counts.entries())
    .map(([term, frequency]) => ({
      term,
      frequency,
      size: sizeForFrequency(frequency, minFreq, maxFreq, minSize, maxSize),
    }))
    .sort((a, b) =>
      b.frequency - a.frequency || a.term.localeCompare(b.term),
    );
}
