/**
 * RFC-4180 CSV serialisation: the SHARED, framework-agnostic contract for
 * turning tabular records into a valid CSV document.
 *
 * =============================================================================
 * SHARED CONTRACT — SINGLE SOURCE OF TRUTH
 * =============================================================================
 * This pure module is the canonical definition of how the Export_Service turns
 * rows into CSV text. It has NO dependencies (no React, no zod, no Supabase/DB/
 * network, no Deno globals) and performs NO I/O, so it can be imported by BOTH:
 *
 *   - the SPA (client-side export preview / download construction), and
 *   - conceptually the server export generators (the questions / polls /
 *     word-cloud CSV generators — Req 9.1, 9.2, 9.3). Because Deno/SQL cannot
 *     import this `src/` path directly, a server generator that needs the same
 *     serialisation MUST re-implement the IDENTICAL RFC-4180 rules encoded here;
 *     if you change a quoting/escaping rule here, change it there too (and vice
 *     versa).
 *
 * {@link toCsv} is the single source of truth for the wire format: a header row
 * derived from the column labels, followed by one row per record, with fields
 * quoted / escaped per RFC-4180. The caller decides WHICH columns exist and how
 * each value is projected out of a record; this module never inspects a record
 * beyond the accessors it is handed.
 *
 * ── Participant-identifier exclusion (Req 9.5) ──────────────────────────────
 * This module has NO concept of a participant identifier or any other personal
 * information — it serialises exactly the columns it is given, nothing more.
 * The Req 9.5 guarantee ("exclude Participant_Identifiers and other personal
 * information from all exports") is therefore upheld UPSTREAM: the callers /
 * column builders that assemble the {@link CsvColumn} list MUST NOT include any
 * participant-identifier or personal-data column. There is deliberately no API
 * here through which such a field could leak — the exclusion is structural.
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 * {@link toCsv} is a PURE function: it performs no I/O, does not mutate its
 * inputs (rows/columns are read-only), and is deterministic (identical inputs
 * always yield the identical string). It never produces a Blob, touches the
 * filesystem, or otherwise reaches outside itself — download / file handling is
 * entirely a caller concern.
 *
 * Requirements traceability: 9.1, 9.2, 9.3, 9.5.
 * Design references: Components and Interfaces (Export_Service — CSV
 * serialisation); Error Handling (Export failures — Req 9.6/9.7: an empty
 * dataset still yields a header-only document).
 */

// ----------------------------------------------------------------------------
// Line endings & field separator.
// ----------------------------------------------------------------------------

/**
 * The RFC-4180 record separator: a carriage return followed by a line feed
 * (`\r\n`). Records — including the header — are TERMINATED by this sequence
 * (see the trailing-CRLF policy on {@link toCsv}).
 */
const CRLF = '\r\n' as const;

/** The RFC-4180 field separator within a record. */
const FIELD_SEPARATOR = ',' as const;

/**
 * Characters whose presence in a field REQUIRES that the field be wrapped in
 * double-quotes per RFC-4180: a comma (field separator), a double-quote (the
 * quoting character itself), a carriage return, or a line feed. A field is
 * quoted iff it contains at least one of these; any other field is emitted raw.
 */
const MUST_QUOTE = /[",\r\n]/;

// ----------------------------------------------------------------------------
// Column model.
// ----------------------------------------------------------------------------

/**
 * Describes a single output column for {@link toCsv}: the human-readable header
 * {@link CsvColumn.header | label} and how to project the cell value out of a
 * record of type `T`.
 *
 * The value is obtained via {@link CsvColumn.value}, a pure accessor returning
 * whatever the record holds for this column; the returned value is then coerced
 * to a string deterministically (see {@link toCsv}). `null` / `undefined`
 * accessor results become the EMPTY field.
 *
 * Deliberately NO participant-identifier / personal-data affordance exists here
 * (Req 9.5); callers assemble only the columns an export is permitted to expose.
 */
export interface CsvColumn<T> {
  /**
   * The header-row label for this column. It is serialised through the SAME
   * quoting/escaping rules as data fields, so labels may safely contain commas,
   * quotes, or newlines.
   */
  readonly header: string;
  /**
   * Pure accessor projecting this column's raw cell value out of a record. It
   * MUST NOT mutate the record or perform I/O. A returned `null`/`undefined`
   * yields an empty field.
   */
  readonly value: (row: T) => string | number | boolean | null | undefined;
}

// ----------------------------------------------------------------------------
// Field coercion & quoting.
// ----------------------------------------------------------------------------

/**
 * Coerces a raw accessor result to its canonical string form BEFORE quoting:
 *
 *   - `null` / `undefined` → `''` (the empty field);
 *   - `boolean`           → `'true'` / `'false'`;
 *   - `number`            → `String(n)` (e.g. `0`, `42`, `-1`, `1.5`); note
 *                            `NaN` → `'NaN'` and `±Infinity` → `'Infinity'` /
 *                            `'-Infinity'` — callers should pass finite integer
 *                            counts (Req 9.1–9.3);
 *   - `string`            → the string unchanged.
 *
 * This is deterministic and never throws.
 */
function coerceField(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  // boolean | number — String() gives a stable, deterministic rendering.
  return String(value);
}

/**
 * Encodes one already-coerced field per RFC-4180:
 *
 *   - if the field contains a comma, a double-quote, a CR, or an LF, it is
 *     wrapped in double-quotes and every embedded `"` is escaped by DOUBLING it
 *     (`"` → `""`);
 *   - otherwise the field is emitted verbatim.
 *
 * @param field the coerced field text.
 * @returns the RFC-4180-encoded field, ready to join with commas.
 */
function encodeField(field: string): string {
  if (!MUST_QUOTE.test(field)) {
    return field;
  }
  // Escape embedded double-quotes by doubling, then wrap the whole field.
  return `"${field.replace(/"/g, '""')}"`;
}

// ----------------------------------------------------------------------------
// Serialisation.
// ----------------------------------------------------------------------------

/**
 * Serialises `rows` into an RFC-4180 CSV document using `columns` to define the
 * header labels and per-record projections.
 *
 * The output is:
 *   1. a HEADER row built from each column's {@link CsvColumn.header | header};
 *      then
 *   2. one DATA row per record, in input order, each cell obtained via that
 *      column's {@link CsvColumn.value} accessor, coerced to a string
 *      ({@link coerceField}) and RFC-4180-encoded ({@link encodeField}).
 *
 * Within a row, fields are joined with a comma. Records — INCLUDING the header
 * and the LAST data row — are each TERMINATED by `\r\n`.
 *
 * ── Trailing-CRLF policy (documented choice) ────────────────────────────────
 * RFC-4180 permits an optional trailing CRLF after the final record. This
 * module chooses the "EVERY record, including the last, is terminated by CRLF"
 * convention. Consequently the document always ENDS with `\r\n`, and the empty
 * document (no columns AND no rows) is the single sequence `'\r\n'` — an empty
 * header row. This choice is deterministic and consistent for all inputs.
 *
 * ── Empty datasets (Req 9.6, referenced by design Error Handling) ───────────
 * When `rows` is empty, the result is exactly the header row followed by its
 * terminating CRLF — a header-only document with no data rows. Serialisation
 * of an empty dataset never fails and never produces a partial file (Req 9.7);
 * "no data available" surfacing is a caller concern.
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 * Pure and deterministic: no I/O, no mutation of `rows` or `columns`, identical
 * inputs always yield the identical string.
 *
 * @typeParam T the record type each row projects from.
 * @param rows the records to serialise, in the order they should appear.
 * @param columns the ordered output columns (labels + accessors). Contains no
 *   participant-identifier or personal-data column by construction (Req 9.5).
 * @returns the RFC-4180 CSV document as a single string, terminated by CRLF.
 */
export function toCsv<T>(
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
): string {
  const headerRow = columns
    .map((column) => encodeField(column.header))
    .join(FIELD_SEPARATOR);

  const dataRows = rows.map((row) =>
    columns
      .map((column) => encodeField(coerceField(column.value(row))))
      .join(FIELD_SEPARATOR),
  );

  // Each record — header and every data row, including the last — is terminated
  // by CRLF (documented trailing-CRLF policy above).
  return [headerRow, ...dataRows].map((record) => record + CRLF).join('');
}
