/**
 * Task 37.4 — Unit tests for the RFC-4180 CSV serialiser {@link toCsv}.
 *
 * These tests exercise the pure, deterministic contract of the serialiser in
 * isolation: header construction, field quoting/escaping rules, trailing-CRLF
 * policy, type coercion, and multi-column / multi-row correctness. They do NOT
 * test the export builders (see exports.test.ts).
 *
 * Trailing-CRLF policy (from csv.ts): every record, INCLUDING the last data row
 * (and the header-only document), is TERMINATED by \r\n.  The final character of
 * any non-empty toCsv result is therefore always '\n' (i.e. the document ends
 * with \r\n).
 *
 * Validates: Requirements 9.5 (structural exclusion — only columns passed
 * appear), 9.6 (header-only on empty dataset), 9.7 (no partial file — pure
 * synchronous function).
 * Design: Components and Interfaces (Export_Service — CSV serialisation);
 * Testing Strategy (csv.ts unit tests).
 */
import { describe, expect, it } from 'vitest';

import { toCsv, type CsvColumn } from './csv';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** A single-column column definition for convenience. */
function col<T>(
  header: string,
  value: (row: T) => string | number | boolean | null | undefined,
): CsvColumn<T> {
  return { header, value };
}

// ---------------------------------------------------------------------------
// Empty-dataset / header-only behaviour (Req 9.6).
// ---------------------------------------------------------------------------

describe('toCsv — empty dataset (Req 9.6)', () => {
  it('empty rows with a single column → header row + CRLF only', () => {
    const result = toCsv([], [col('Name', (r: { name: string }) => r.name)]);
    expect(result).toBe('Name\r\n');
  });

  it('empty rows with multiple columns → header row with commas + CRLF only', () => {
    type R = { a: string; b: string; c: string };
    const result = toCsv(
      [],
      [
        col('A', (r: R) => r.a),
        col('B', (r: R) => r.b),
        col('C', (r: R) => r.c),
      ],
    );
    expect(result).toBe('A,B,C\r\n');
  });

  it('empty rows — NO extra CRLF beyond the header row', () => {
    const result = toCsv([], [col('X', () => 'v' as string)]);
    // Must end with exactly one \r\n.
    expect(result.endsWith('\r\n')).toBe(true);
    // Must have exactly one record separator — only the header row.
    const crlfCount = (result.match(/\r\n/g) ?? []).length;
    expect(crlfCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Trailing-CRLF policy: every row (including the last) is terminated.
// ---------------------------------------------------------------------------

describe('toCsv — trailing-CRLF policy', () => {
  it('a single data row → the document ends with \\r\\n', () => {
    const result = toCsv([{ v: 'hello' }], [col('V', (r) => r.v)]);
    expect(result.endsWith('\r\n')).toBe(true);
    expect(result).toBe('V\r\nhello\r\n');
  });

  it('multiple rows — each row terminated by \\r\\n (no bare newlines)', () => {
    const rows = [{ v: 'a' }, { v: 'b' }, { v: 'c' }];
    const result = toCsv(rows, [col('V', (r) => r.v)]);
    expect(result).toBe('V\r\na\r\nb\r\nc\r\n');
  });

  it('the final character of the document is always \\n', () => {
    const result = toCsv([{ v: 'x' }], [col('H', (r) => r.v)]);
    expect(result[result.length - 1]).toBe('\n');
    expect(result[result.length - 2]).toBe('\r');
  });

  it('three rows → exactly four CRLF sequences (1 header + 3 data)', () => {
    const rows = [{ v: '1' }, { v: '2' }, { v: '3' }];
    const result = toCsv(rows, [col('V', (r) => r.v)]);
    const crlfCount = (result.match(/\r\n/g) ?? []).length;
    expect(crlfCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Field quoting rules (RFC-4180).
// ---------------------------------------------------------------------------

describe('toCsv — field quoting', () => {
  type R = { val: string };
  const c = col<R>('H', (r) => r.val);

  it('field with a comma → quoted', () => {
    const result = toCsv([{ val: 'a,b' }], [c]);
    expect(result).toBe('H\r\n"a,b"\r\n');
  });

  it('field with a double-quote → quoted with the embedded quote doubled', () => {
    const result = toCsv([{ val: 'a"b' }], [c]);
    expect(result).toBe('H\r\n"a""b"\r\n');
  });

  it('field with a carriage return → quoted', () => {
    const result = toCsv([{ val: 'a\rb' }], [c]);
    expect(result).toBe('H\r\n"a\rb"\r\n');
  });

  it('field with a line feed → quoted', () => {
    const result = toCsv([{ val: 'a\nb' }], [c]);
    expect(result).toBe('H\r\n"a\nb"\r\n');
  });

  it('field with no special chars → NOT quoted', () => {
    const result = toCsv([{ val: 'hello world' }], [c]);
    expect(result).toBe('H\r\nhello world\r\n');
  });

  it('a"b → "a""b" (embedded double-quote → doubled inside quotes)', () => {
    const result = toCsv([{ val: 'a"b' }], [c]);
    // Extract the data-row field (between \r\n boundaries).
    const dataRow = result.split('\r\n')[1];
    expect(dataRow).toBe('"a""b"');
  });

  it('field with multiple embedded quotes → all doubled', () => {
    // Input field: "say ""hello"""  (1 leading quote, 2 internal quotes, 3 trailing quotes)
    // Each " → "": outer wrapper adds 2 more → """say """"hello"""""""
    const result = toCsv([{ val: '"say ""hello"""' }], [c]);
    const dataRow = result.split('\r\n')[1];
    expect(dataRow).toBe('"""say """"hello"""""""');
  });

  it('header label containing a comma → quoted header', () => {
    const result = toCsv([], [col('A,B', () => '' as string)]);
    expect(result).toBe('"A,B"\r\n');
  });

  it('header label containing a double-quote → quoted header with doubled quotes', () => {
    const result = toCsv([], [col('He said "hi"', () => '' as string)]);
    expect(result).toBe('"He said ""hi"""\r\n');
  });
});

// ---------------------------------------------------------------------------
// Type coercion (coerceField contract).
// ---------------------------------------------------------------------------

describe('toCsv — type coercion', () => {
  type R = { val: string | number | boolean | null | undefined };
  const c = col<R>('V', (r) => r.val);

  it('null → empty field', () => {
    const result = toCsv([{ val: null }], [c]);
    expect(result).toBe('V\r\n\r\n');
  });

  it('undefined → empty field', () => {
    const result = toCsv([{ val: undefined }], [c]);
    expect(result).toBe('V\r\n\r\n');
  });

  it('true → "true"', () => {
    const result = toCsv([{ val: true }], [c]);
    expect(result).toBe('V\r\ntrue\r\n');
  });

  it('false → "false"', () => {
    const result = toCsv([{ val: false }], [c]);
    expect(result).toBe('V\r\nfalse\r\n');
  });

  it('0 → "0"', () => {
    const result = toCsv([{ val: 0 }], [c]);
    expect(result).toBe('V\r\n0\r\n');
  });

  it('negative number → correct numeric string', () => {
    const result = toCsv([{ val: -42 }], [c]);
    expect(result).toBe('V\r\n-42\r\n');
  });

  it('positive integer → numeric string', () => {
    const result = toCsv([{ val: 123 }], [c]);
    expect(result).toBe('V\r\n123\r\n');
  });

  it('decimal number → numeric string', () => {
    const result = toCsv([{ val: 3.14 }], [c]);
    expect(result).toBe('V\r\n3.14\r\n');
  });
});

// ---------------------------------------------------------------------------
// Multiple-column correctness.
// ---------------------------------------------------------------------------

describe('toCsv — multiple columns', () => {
  type R = { a: string; b: number; c: boolean };
  const cols: CsvColumn<R>[] = [
    col('A', (r) => r.a),
    col('B', (r) => r.b),
    col('C', (r) => r.c),
  ];

  it('header row has columns comma-separated', () => {
    const result = toCsv([], cols);
    expect(result).toBe('A,B,C\r\n');
  });

  it('data row has fields comma-separated in column order', () => {
    const result = toCsv([{ a: 'hello', b: 42, c: true }], cols);
    expect(result).toBe('A,B,C\r\nhello,42,true\r\n');
  });

  it('field requiring quoting in a multi-column row is quoted without affecting neighbours', () => {
    const result = toCsv([{ a: 'has,comma', b: 1, c: false }], cols);
    expect(result).toBe('A,B,C\r\n"has,comma",1,false\r\n');
  });

  it('multiple rows — each row correct and terminated', () => {
    const rows: R[] = [
      { a: 'x', b: 1, c: true },
      { a: 'y', b: 2, c: false },
    ];
    const result = toCsv(rows, cols);
    expect(result).toBe('A,B,C\r\nx,1,true\r\ny,2,false\r\n');
  });
});

// ---------------------------------------------------------------------------
// Structural exclusion (Req 9.5): toCsv serialises ONLY the columns it
// is given — any field not declared in a CsvColumn never appears.
// ---------------------------------------------------------------------------

describe('toCsv — structural exclusion (Req 9.5)', () => {
  it('a field not declared in any column never appears in the output', () => {
    // Simulate an object with an extra identifier field.
    const rows = [
      { text: 'hello', vote_count: 5, participant_identifier: 'secret-id-xyz' },
    ];
    const columns: CsvColumn<(typeof rows)[0]>[] = [
      col('Question', (r) => r.text),
      col('Votes', (r) => r.vote_count),
    ];
    const result = toCsv(rows, columns);
    expect(result).not.toContain('secret-id-xyz');
    expect(result).toContain('hello');
    expect(result).toContain('5');
  });
});
