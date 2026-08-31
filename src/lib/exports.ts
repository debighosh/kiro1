/**
 * Per-type CSV export builders: the SHARED, framework-agnostic contract that
 * turns questions / polls / word-cloud query results into downloadable CSV
 * documents.
 *
 * =============================================================================
 * SHARED CONTRACT — SINGLE SOURCE OF TRUTH
 * =============================================================================
 * This pure module is the canonical definition of WHICH columns each export
 * exposes and HOW query rows project into them. It layers on top of the
 * RFC-4180 serialiser in {@link ./csv} (task 37.1) — it NEVER re-implements CSV
 * quoting/escaping; it only assembles the ordered {@link CsvColumn} lists and
 * hands the rows to {@link toCsv}. Like `csv.ts` and `wordcloud.ts` it has NO
 * dependencies (no React, no zod, no Supabase/DB/network, no Deno globals) and
 * performs NO I/O, so it can be imported by BOTH:
 *
 *   - the SPA (client-side export panel — building the CSV string then handing
 *     it to a download, task 37.x / the `/admin/events/:id/export` panel), and
 *   - conceptually the server export generators (Req 9.1, 9.2, 9.3). Because
 *     Deno/SQL cannot import this `src/` path directly, a server generator that
 *     needs the same column shapes MUST re-declare the IDENTICAL columns encoded
 *     here; if you change a column set here, change it there too (and vice
 *     versa).
 *
 * ── Participant-identifier exclusion (Req 9.5) ──────────────────────────────
 * The exclusion is STRUCTURAL, not a runtime filter. Every input row type in
 * this module deliberately declares ONLY the non-sensitive fields an export is
 * permitted to expose (question `text` + `vote_count`; poll question text +
 * option `text` + `response_count`; word-cloud `normalised_text` + `is_hidden`).
 * None of them carries a `participant_identifier` or any other personal field,
 * and no builder ever emits an identifier column — there is deliberately no API
 * through which such a field could leak into an export (Req 8.6, 9.5). The
 * word-cloud builder additionally reuses {@link aggregateWordCloud}, whose input
 * shape ({@link WordCloudResponseLike}) already omits participant identity.
 *
 * ── Empty datasets & the no-data flag (Req 9.6) ─────────────────────────────
 * Every builder returns a {@link CsvExport}: the serialised `csv` (always at
 * least the header row — see the trailing-CRLF policy in {@link toCsv}) plus an
 * `isEmpty` flag that is `true` iff there are ZERO data rows. A caller surfaces
 * "no data was available" from `isEmpty` while still offering the header-only
 * document for download (Req 9.6).
 *
 * ── Whole-or-nothing output (Req 9.7) ───────────────────────────────────────
 * Every builder is SYNCHRONOUS and PURE: it constructs the entire CSV string in
 * a single pass via {@link toCsv} and returns it, or an exception propagates to
 * the caller. There is NO catch-and-return-partial path here — a builder never
 * yields a half-written document, so an export either produces the complete
 * file or none at all (Req 9.7). File/download handling and the failed-export
 * error indication are caller concerns.
 *
 * ── Performance (Req 9.1–9.3, 9.7) ──────────────────────────────────────────
 * Each builder is O(n) in the number of rows (the word-cloud builder is O(n) in
 * responses via a single aggregation pass), with no artificial row cap. This
 * comfortably serialises up to 10,000 rows well within the 10-second budget.
 *
 * Requirements traceability: 9.1, 9.2, 9.3, 9.5, 9.6, 9.7.
 * Design references: Components and Interfaces (Export_Service — per-type
 * builders); Data Models (`questions.vote_count`, `poll_options.response_count`,
 * `word_cloud_responses`).
 */

import { toCsv, type CsvColumn } from './csv';
import {
  aggregateWordCloud,
  type AggregateWordCloudOptions,
  type WordCloudResponseLike,
} from './wordcloud';

// ----------------------------------------------------------------------------
// Result type.
// ----------------------------------------------------------------------------

/**
 * The result of a CSV export builder: the serialised document plus a no-data
 * indication (Req 9.6).
 */
export interface CsvExport {
  /**
   * The RFC-4180 CSV document (see {@link toCsv}). Always contains at least the
   * header row, even when there are no data rows (Req 9.6) — the header-only
   * document is still a valid, downloadable file.
   */
  readonly csv: string;
  /**
   * `true` iff the export contains ZERO data rows (only the header). Callers
   * use this to surface "no data was available" to the Administrator while
   * still offering the header-only file for download (Req 9.6).
   */
  readonly isEmpty: boolean;
}

// ----------------------------------------------------------------------------
// Display shaping.
// ----------------------------------------------------------------------------

/**
 * The maximum number of Unicode code points of question text an export row
 * exposes (Req 9.1 — question text is capped at 1000 characters). Consistent
 * with the rest of the codebase (e.g. question length in `../lib/questions`),
 * "character" means one Unicode CODE POINT, not a UTF-16 code unit, so text
 * containing astral-plane characters (many emoji) is not mis-counted.
 */
export const QUESTION_EXPORT_TEXT_MAX = 1000 as const;

/**
 * Caps `text` to at most `max` Unicode code points, returning it unchanged when
 * already within the limit. Truncation is by code point (via spread iteration)
 * so a surrogate pair is never split into an invalid half.
 *
 * This is a pure display-shaping helper: it never mutates its input and is
 * deterministic. It performs no ellipsis insertion — the export exposes the
 * leading `max` code points verbatim.
 *
 * @param text the raw text to cap.
 * @param max the inclusive maximum number of code points to keep.
 * @returns `text` if it is already `<= max` code points, otherwise its first
 *   `max` code points.
 */
export function capCodePoints(text: string, max: number): string {
  // Fast path: `string.length` (UTF-16 units) is an upper bound on the code
  // point count, so a string within `max` UTF-16 units is trivially within
  // `max` code points and needs no (more expensive) spread.
  if (text.length <= max) {
    return text;
  }
  const codePoints = [...text];
  if (codePoints.length <= max) {
    return text;
  }
  return codePoints.slice(0, max).join('');
}

// ----------------------------------------------------------------------------
// Questions export (Req 9.1).
// ----------------------------------------------------------------------------

/**
 * The minimal, non-sensitive projection of a question the questions export
 * exposes. Deliberately declares ONLY the two exported fields — it carries NO
 * `participant_identifier` or any other personal/moderation-internal field, so
 * an identifier can never reach the CSV (Req 8.6, 9.5).
 */
export interface QuestionExportRow {
  /**
   * The question text. Capped to {@link QUESTION_EXPORT_TEXT_MAX} code points on
   * output (Req 9.1); the stored value may be longer but the export exposes at
   * most the leading 1000 code points.
   */
  readonly text: string;
  /**
   * The denormalised upvote tally (`questions.vote_count`). Expected to be a
   * finite non-negative integer in `[0, 999_999_999]` (Req 9.1); it is emitted
   * verbatim (no clamping) so an out-of-range value surfaces rather than being
   * silently altered.
   */
  readonly vote_count: number;
}

/** The header labels for the questions export, in output-column order. */
export const QUESTIONS_EXPORT_HEADERS = {
  text: 'Question',
  voteCount: 'Votes',
} as const;

/**
 * The ordered questions-export columns: the (capped) question text followed by
 * its vote count. No participant-identifier column exists by construction
 * (Req 9.5).
 */
const QUESTIONS_EXPORT_COLUMNS: readonly CsvColumn<QuestionExportRow>[] = [
  {
    header: QUESTIONS_EXPORT_HEADERS.text,
    value: (row) => capCodePoints(row.text, QUESTION_EXPORT_TEXT_MAX),
  },
  {
    header: QUESTIONS_EXPORT_HEADERS.voteCount,
    value: (row) => row.vote_count,
  },
];

/**
 * Builds the questions CSV export: one data row per question with the question
 * text (capped to {@link QUESTION_EXPORT_TEXT_MAX} code points) and its
 * `vote_count` (Req 9.1). Row order follows the input order — the caller is
 * responsible for sorting (e.g. by votes) before calling.
 *
 * Pure and synchronous: it serialises the full document in one pass and returns
 * it (or throws), never a partial file (Req 9.7). An empty `rows` yields the
 * header-only document with `isEmpty: true` (Req 9.6). Excludes participant
 * identifiers structurally (Req 9.5). O(n) over rows.
 *
 * @param rows the questions to export, in output order.
 * @returns the {@link CsvExport} (header-only when `rows` is empty).
 */
export function buildQuestionsCsv(
  rows: readonly QuestionExportRow[],
): CsvExport {
  return {
    csv: toCsv(rows, QUESTIONS_EXPORT_COLUMNS),
    isEmpty: rows.length === 0,
  };
}

// ----------------------------------------------------------------------------
// Polls export (Req 9.2).
// ----------------------------------------------------------------------------

/**
 * A single poll option in a {@link PollExportRow}. Declares ONLY the exported
 * fields — the option `text` and its denormalised `response_count`
 * (`poll_options.response_count`); it carries NO `participant_identifier` or any
 * other personal field (Req 8.6, 9.5).
 */
export interface PollOptionExportRow {
  /** The poll option's display text. */
  readonly text: string;
  /**
   * The denormalised response tally (`poll_options.response_count`). Expected to
   * be a finite non-negative integer in `[0, 999_999_999]` (Req 9.2); emitted
   * verbatim.
   */
  readonly response_count: number;
}

/**
 * A poll grouped with its ordered options — the {@link buildPollsCsv} input
 * shape. Each option produces ONE CSV data row carrying this poll's question
 * text alongside the option text and response count (Req 9.2). Declares only
 * non-sensitive fields (Req 8.6, 9.5).
 */
export interface PollExportRow {
  /** The poll's question text (`polls.question_text`). */
  readonly question_text: string;
  /**
   * This poll's options, in the order they should appear in the export. A poll
   * with no options contributes no data rows.
   */
  readonly options: readonly PollOptionExportRow[];
}

/**
 * The flattened per-option shape actually serialised: one row = a poll's
 * question text + one option's text + that option's response count. This is an
 * internal projection produced by {@link flattenPolls}; the public input is the
 * grouped {@link PollExportRow}.
 */
interface FlatPollExportRow {
  readonly question_text: string;
  readonly option_text: string;
  readonly response_count: number;
}

/** The header labels for the polls export, in output-column order. */
export const POLLS_EXPORT_HEADERS = {
  question: 'Poll',
  option: 'Option',
  responseCount: 'Responses',
} as const;

/**
 * The ordered polls-export columns: the poll question text, the option text,
 * then that option's response count. No participant-identifier column exists by
 * construction (Req 9.5).
 */
const POLLS_EXPORT_COLUMNS: readonly CsvColumn<FlatPollExportRow>[] = [
  {
    header: POLLS_EXPORT_HEADERS.question,
    value: (row) => row.question_text,
  },
  {
    header: POLLS_EXPORT_HEADERS.option,
    value: (row) => row.option_text,
  },
  {
    header: POLLS_EXPORT_HEADERS.responseCount,
    value: (row) => row.response_count,
  },
];

/**
 * Flattens grouped {@link PollExportRow}s into one {@link FlatPollExportRow} per
 * option, preserving both the poll order and the per-poll option order. Pure:
 * it allocates a new array and never mutates its input.
 */
function flattenPolls(
  polls: readonly PollExportRow[],
): readonly FlatPollExportRow[] {
  const flat: FlatPollExportRow[] = [];
  for (const poll of polls) {
    for (const option of poll.options) {
      flat.push({
        question_text: poll.question_text,
        option_text: option.text,
        response_count: option.response_count,
      });
    }
  }
  return flat;
}

/**
 * Builds the polls CSV export: one data row per poll OPTION, carrying the poll
 * question text, the option text, and the option's `response_count` (Req 9.2).
 * The grouped input is flattened option-by-option, preserving the caller's poll
 * and option ordering. `isEmpty` reflects the total number of OPTION rows, so a
 * poll set that contains only optionless polls (no data rows) is reported as
 * empty (Req 9.6).
 *
 * Pure and synchronous: it serialises the full document in one pass and returns
 * it (or throws), never a partial file (Req 9.7). Excludes participant
 * identifiers structurally (Req 9.5). O(n) over the total option count.
 *
 * @param polls the polls (each with its ordered options) to export.
 * @returns the {@link CsvExport} (header-only when there are no option rows).
 */
export function buildPollsCsv(polls: readonly PollExportRow[]): CsvExport {
  const rows = flattenPolls(polls);
  return {
    csv: toCsv(rows, POLLS_EXPORT_COLUMNS),
    isEmpty: rows.length === 0,
  };
}

// ----------------------------------------------------------------------------
// Word-cloud export (Req 9.3).
// ----------------------------------------------------------------------------

/** The header labels for the word-cloud export, in output-column order. */
export const WORD_CLOUD_EXPORT_HEADERS = {
  word: 'Word',
  frequency: 'Frequency',
} as const;

/**
 * The ordered word-cloud-export columns: the distinct normalised term followed
 * by its frequency. Projects from the {@link aggregateWordCloud} result; the
 * `size` field of an aggregated term is deliberately NOT exported. No
 * participant-identifier column exists by construction (Req 9.5).
 */
const WORD_CLOUD_EXPORT_COLUMNS: readonly CsvColumn<{
  readonly term: string;
  readonly frequency: number;
}>[] = [
  {
    header: WORD_CLOUD_EXPORT_HEADERS.word,
    value: (row) => row.term,
  },
  {
    header: WORD_CLOUD_EXPORT_HEADERS.frequency,
    value: (row) => row.frequency,
  },
];

/**
 * Builds the word-cloud CSV export: one data row per DISTINCT normalised word
 * with its frequency count (Req 9.3). Aggregation is delegated to
 * {@link aggregateWordCloud}, which is the single source of truth for what "the
 * same word" means and which already:
 *   - EXCLUDES hidden entries (`is_hidden === true`, Req 6.13);
 *   - normalises defensively and drops empty terms; and
 *   - EXCLUDES any configured stop words (via `opts.stopWords`, Req 6.14).
 * Only the term + frequency are exported; the aggregated `size` (a rendering
 * concern) is omitted, and no participant identity is ever present in the input
 * shape ({@link WordCloudResponseLike}) or the output (Req 8.6, 9.5). Rows are
 * emitted in {@link aggregateWordCloud}'s deterministic order (frequency
 * descending, ties broken by term ascending).
 *
 * Pure and synchronous: it serialises the full document in one pass and returns
 * it (or throws), never a partial file (Req 9.7). An input that aggregates to
 * zero distinct terms (empty, all hidden, or all stop-worded) yields the
 * header-only document with `isEmpty: true` (Req 9.6). O(n) over responses.
 *
 * @param responses the stored word-cloud responses to aggregate and export;
 *   only `normalised_text` and `is_hidden` are read.
 * @param opts optional aggregation options (stop words / size bounds — the size
 *   bounds do not affect the export). See {@link AggregateWordCloudOptions}.
 * @returns the {@link CsvExport} (header-only when no distinct terms remain).
 */
export function buildWordCloudCsv(
  responses: readonly WordCloudResponseLike[],
  opts?: AggregateWordCloudOptions,
): CsvExport {
  const terms = aggregateWordCloud(responses, opts);
  return {
    csv: toCsv(terms, WORD_CLOUD_EXPORT_COLUMNS),
    isEmpty: terms.length === 0,
  };
}
