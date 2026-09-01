/**
 * Task 37.4 — Property-based + unit tests for the CSV export builders in
 * src/lib/exports.ts.
 *
 * ── Property (export identifier-exclusion, Req 9.5, 8.6) ───────────────────
 * Property 1: For any QuestionExportRow with any extra participant_identifier
 * property on the raw object, the resulting CSV NEVER contains the identifier
 * value unless it is identical to a legitimately-included field value (text or
 * vote_count string).
 *
 * Property 2: Same guarantee for buildWordCloudCsv.
 *
 * ── Unit tests ──────────────────────────────────────────────────────────────
 * buildQuestionsCsv: empty-dataset isEmpty/header, one row, text-cap (1000 cp),
 *   vote_count serialisation.
 * buildPollsCsv: empty-dataset isEmpty, one poll with two options, poll with no
 *   options.
 * buildWordCloudCsv: empty responses, hidden exclusion, frequency-descending
 *   order, stop-word exclusion.
 * No-partial-file (Req 9.7): throwing accessor → exception propagates, no
 *   partial string returned.
 *
 * Validates: Requirements 9.5, 9.6, 9.7, 8.6, 26.1.
 * Design: Components and Interfaces (Export_Service — per-type builders);
 * Testing Strategy (exports.test.ts).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  buildQuestionsCsv,
  buildPollsCsv,
  buildWordCloudCsv,
  QUESTION_EXPORT_TEXT_MAX,
  QUESTIONS_EXPORT_HEADERS,
  POLLS_EXPORT_HEADERS,
  WORD_CLOUD_EXPORT_HEADERS,
  type QuestionExportRow,
  type PollExportRow,
} from './exports';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Generates a string that is clearly not a sub-sequence of normal text or
 * numeric fields.  We choose a printable ASCII string that is long enough
 * (≥ 8 chars) to make accidental substring collisions with the legitimate
 * `text` or `vote_count` fields astronomically unlikely.
 */
const participantIdArb = fc.string({ minLength: 8, maxLength: 64 }).filter(
  // Keep only strings that look like identifiers (no commas/quotes that would
  // be RFC-4180-escaped in a way that changes substrings) — simple approach:
  // require at least one digit and one letter so the value is "identifier-like"
  // and not easily confused with a short numeric vote_count string.
  (s) => /\d/.test(s) && /[a-zA-Z]/.test(s),
);

/** Generates a safe question-text string (non-empty, ≤ 1000 code points). */
const questionTextArb = fc.string({ minLength: 1, maxLength: 200 });

/** Generates a non-negative vote count in the expected range. */
const voteCountArb = fc.integer({ min: 0, max: 999_999_999 });

// ===========================================================================
// Property 1: buildQuestionsCsv — participant-identifier exclusion (Req 9.5, 8.6)
// ===========================================================================
describe('Feature: mss-livepulse, Property (export identifier-exclusion) — buildQuestionsCsv never emits participant_identifier (Req 9.5, 8.6)', () => {
  it('for any row with an extra participant_identifier field, the CSV never contains the identifier value (unless it coincides with text or vote_count)', () => {
    fc.assert(
      fc.property(
        questionTextArb,
        voteCountArb,
        participantIdArb,
        (text, voteCount, participantIdentifier) => {
          // Simulate a raw DB row that carries an identifier field not declared
          // in QuestionExportRow. We cast so the builder's type-safe API does
          // not include it — but we verify structurally.
          const rawRow = {
            text,
            vote_count: voteCount,
            participant_identifier: participantIdentifier,
          } as unknown as QuestionExportRow;

          const { csv } = buildQuestionsCsv([rawRow]);

          // The identifier MUST NOT appear in the output unless it happens to be
          // identical to the text or vote_count value (which is safe — those are
          // legitimate columns).
          const voteStr = String(voteCount);
          if (
            participantIdentifier !== text &&
            participantIdentifier !== voteStr
          ) {
            expect(csv).not.toContain(participantIdentifier);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// Property 2: buildWordCloudCsv — participant-identifier exclusion (Req 9.5, 8.6)
// ===========================================================================
describe('Feature: mss-livepulse, Property (export identifier-exclusion) — buildWordCloudCsv never emits participant_identifier (Req 9.5, 8.6)', () => {
  it('for any response with an extra participant_identifier field, the CSV never contains the identifier value (unless it coincides with a word term or frequency)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        participantIdArb,
        (normalised_text, participantIdentifier) => {
          // Simulate a response with an identifier that the builder must not emit.
          const rawResponse = {
            normalised_text,
            is_hidden: false,
            participant_identifier: participantIdentifier,
          };

          const { csv } = buildWordCloudCsv([rawResponse]);

          // The term is normalised (lower-cased + trimmed) in aggregateWordCloud.
          // We check against the normalised form to avoid false positives.
          const normalisedTerm = normalised_text
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ');
          const frequencyStr = '1'; // one response → frequency 1

          if (
            participantIdentifier !== normalisedTerm &&
            participantIdentifier !== normalised_text &&
            participantIdentifier !== frequencyStr
          ) {
            expect(csv).not.toContain(participantIdentifier);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Unit tests — buildQuestionsCsv
// ===========================================================================
describe('buildQuestionsCsv — unit tests', () => {
  it('empty rows → isEmpty: true', () => {
    const { isEmpty } = buildQuestionsCsv([]);
    expect(isEmpty).toBe(true);
  });

  it('empty rows → csv is header row + CRLF only (Req 9.6)', () => {
    const { csv } = buildQuestionsCsv([]);
    const expectedHeader = `${QUESTIONS_EXPORT_HEADERS.text},${QUESTIONS_EXPORT_HEADERS.voteCount}\r\n`;
    expect(csv).toBe(expectedHeader);
  });

  it('empty rows → csv is "Question,Votes\\r\\n"', () => {
    const { csv } = buildQuestionsCsv([]);
    expect(csv).toBe('Question,Votes\r\n');
  });

  it('one row → isEmpty: false', () => {
    const { isEmpty } = buildQuestionsCsv([{ text: 'How?', vote_count: 3 }]);
    expect(isEmpty).toBe(false);
  });

  it('one row → csv contains the question text and vote count', () => {
    const { csv } = buildQuestionsCsv([{ text: 'How?', vote_count: 3 }]);
    expect(csv).toContain('How?');
    expect(csv).toContain('3');
    expect(csv).toBe('Question,Votes\r\nHow?,3\r\n');
  });

  it('text at exactly 1000 code points → not truncated', () => {
    const text = 'a'.repeat(QUESTION_EXPORT_TEXT_MAX);
    const { csv } = buildQuestionsCsv([{ text, vote_count: 0 }]);
    expect(csv).toContain(text);
  });

  it('text at 1001 code points → capped to 1000 in the CSV (Req 9.1)', () => {
    const text = 'a'.repeat(QUESTION_EXPORT_TEXT_MAX + 1);
    const { csv } = buildQuestionsCsv([{ text, vote_count: 0 }]);
    const expected1000 = 'a'.repeat(QUESTION_EXPORT_TEXT_MAX);
    expect(csv).toContain(expected1000);
    // The full 1001-char string must NOT appear.
    expect(csv).not.toContain(text);
  });

  it('text at 2000 code points → capped to exactly 1000 code points', () => {
    const text = 'b'.repeat(2000);
    const { csv } = buildQuestionsCsv([{ text, vote_count: 0 }]);
    // Split the CSV to get the data row.
    const dataRow = csv.split('\r\n')[1];
    // The data row is just the text (no special chars) followed by ',0'.
    const csvText = dataRow?.split(',')[0] ?? '';
    expect([...csvText].length).toBe(QUESTION_EXPORT_TEXT_MAX);
  });

  it('vote_count 0 → serialised as "0"', () => {
    const { csv } = buildQuestionsCsv([{ text: 'Q', vote_count: 0 }]);
    expect(csv).toBe('Question,Votes\r\nQ,0\r\n');
  });

  it('large vote_count → serialised as numeric string', () => {
    const { csv } = buildQuestionsCsv([{ text: 'Q', vote_count: 999_999_999 }]);
    expect(csv).toContain('999999999');
  });

  it('multiple rows → isEmpty: false and each row present', () => {
    const rows: QuestionExportRow[] = [
      { text: 'First', vote_count: 10 },
      { text: 'Second', vote_count: 5 },
    ];
    const { csv, isEmpty } = buildQuestionsCsv(rows);
    expect(isEmpty).toBe(false);
    expect(csv).toContain('First');
    expect(csv).toContain('Second');
  });
});

// ===========================================================================
// Unit tests — buildPollsCsv
// ===========================================================================
describe('buildPollsCsv — unit tests', () => {
  it('empty polls array → isEmpty: true', () => {
    const { isEmpty } = buildPollsCsv([]);
    expect(isEmpty).toBe(true);
  });

  it('empty polls array → csv is header row + CRLF only (Req 9.6)', () => {
    const { csv } = buildPollsCsv([]);
    const expectedHeader = `${POLLS_EXPORT_HEADERS.question},${POLLS_EXPORT_HEADERS.option},${POLLS_EXPORT_HEADERS.responseCount}\r\n`;
    expect(csv).toBe(expectedHeader);
  });

  it('empty polls array → csv is "Poll,Option,Responses\\r\\n"', () => {
    const { csv } = buildPollsCsv([]);
    expect(csv).toBe('Poll,Option,Responses\r\n');
  });

  it('poll with no options → isEmpty: true (no data rows)', () => {
    const { isEmpty } = buildPollsCsv([
      { question_text: 'Favourite colour?', options: [] },
    ]);
    expect(isEmpty).toBe(true);
  });

  it('poll with no options → csv is header only', () => {
    const { csv } = buildPollsCsv([
      { question_text: 'Favourite colour?', options: [] },
    ]);
    expect(csv).toBe('Poll,Option,Responses\r\n');
  });

  it('one poll with two options → isEmpty: false, two data rows', () => {
    const polls: PollExportRow[] = [
      {
        question_text: 'Best flavour?',
        options: [
          { text: 'Vanilla', response_count: 10 },
          { text: 'Chocolate', response_count: 20 },
        ],
      },
    ];
    const { csv, isEmpty } = buildPollsCsv(polls);
    expect(isEmpty).toBe(false);
    const lines = csv.split('\r\n').filter(Boolean);
    // Header + 2 data rows.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Poll,Option,Responses');
    expect(lines[1]).toBe('Best flavour?,Vanilla,10');
    expect(lines[2]).toBe('Best flavour?,Chocolate,20');
  });

  it('two polls each with one option → four rows (header + 2 data)', () => {
    const polls: PollExportRow[] = [
      {
        question_text: 'Poll A',
        options: [{ text: 'Opt1', response_count: 1 }],
      },
      {
        question_text: 'Poll B',
        options: [{ text: 'Opt2', response_count: 2 }],
      },
    ];
    const { csv } = buildPollsCsv(polls);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('Poll A,Opt1,1');
    expect(lines[2]).toBe('Poll B,Opt2,2');
  });

  it('poll question text containing a comma → RFC-4180 quoted', () => {
    const polls: PollExportRow[] = [
      {
        question_text: 'A, B, or C?',
        options: [{ text: 'A', response_count: 5 }],
      },
    ];
    const { csv } = buildPollsCsv(polls);
    expect(csv).toContain('"A, B, or C?"');
  });
});

// ===========================================================================
// Unit tests — buildWordCloudCsv
// ===========================================================================
describe('buildWordCloudCsv — unit tests', () => {
  it('empty responses → isEmpty: true', () => {
    const { isEmpty } = buildWordCloudCsv([]);
    expect(isEmpty).toBe(true);
  });

  it('empty responses → csv is header row + CRLF only (Req 9.6)', () => {
    const { csv } = buildWordCloudCsv([]);
    const expectedHeader = `${WORD_CLOUD_EXPORT_HEADERS.word},${WORD_CLOUD_EXPORT_HEADERS.frequency}\r\n`;
    expect(csv).toBe(expectedHeader);
  });

  it('empty responses → csv is "Word,Frequency\\r\\n"', () => {
    const { csv } = buildWordCloudCsv([]);
    expect(csv).toBe('Word,Frequency\r\n');
  });

  it('all-hidden responses → isEmpty: true (hidden excluded, Req 6.13)', () => {
    const responses = [
      { normalised_text: 'hello', is_hidden: true },
      { normalised_text: 'world', is_hidden: true },
    ];
    const { isEmpty } = buildWordCloudCsv(responses);
    expect(isEmpty).toBe(true);
  });

  it('hidden entries are excluded from the CSV', () => {
    const responses = [
      { normalised_text: 'visible', is_hidden: false },
      { normalised_text: 'hidden', is_hidden: true },
    ];
    const { csv } = buildWordCloudCsv(responses);
    expect(csv).toContain('visible');
    expect(csv).not.toContain('hidden');
  });

  it('distinct terms sorted by frequency descending in the CSV', () => {
    const responses = [
      { normalised_text: 'rare', is_hidden: false },
      { normalised_text: 'common', is_hidden: false },
      { normalised_text: 'common', is_hidden: false },
      { normalised_text: 'common', is_hidden: false },
    ];
    const { csv } = buildWordCloudCsv(responses);
    const lines = csv.split('\r\n').filter(Boolean);
    // Header + 2 data rows.
    expect(lines).toHaveLength(3);
    // 'common' (freq 3) should come before 'rare' (freq 1).
    expect(lines[1]).toBe('common,3');
    expect(lines[2]).toBe('rare,1');
  });

  it('stop words excluded via opts.stopWords (Req 6.14)', () => {
    const responses = [
      { normalised_text: 'the', is_hidden: false },
      { normalised_text: 'the', is_hidden: false },
      { normalised_text: 'cloud', is_hidden: false },
    ];
    const { csv, isEmpty } = buildWordCloudCsv(responses, {
      stopWords: ['the'],
    });
    expect(isEmpty).toBe(false);
    expect(csv).not.toContain('the');
    expect(csv).toContain('cloud');
  });

  it('all responses are stop words → isEmpty: true', () => {
    const responses = [
      { normalised_text: 'and', is_hidden: false },
      { normalised_text: 'the', is_hidden: false },
    ];
    const { isEmpty } = buildWordCloudCsv(responses, {
      stopWords: ['and', 'the'],
    });
    expect(isEmpty).toBe(true);
  });

  it('non-empty responses → isEmpty: false', () => {
    const responses = [{ normalised_text: 'hello', is_hidden: false }];
    const { isEmpty } = buildWordCloudCsv(responses);
    expect(isEmpty).toBe(false);
  });

  it('frequency is counted correctly across multiple identical terms', () => {
    const responses = Array.from({ length: 5 }, () => ({
      normalised_text: 'buzz',
      is_hidden: false,
    }));
    const { csv } = buildWordCloudCsv(responses);
    expect(csv).toContain('buzz,5');
  });
});

// ===========================================================================
// No-partial-file guarantee (Req 9.7).
// Each builder is pure/synchronous — on failure the error propagates; no
// partial CSV string is produced.
// ===========================================================================
describe('No-partial-file guarantee (Req 9.7)', () => {
  it('buildQuestionsCsv — throwing value accessor propagates the error; no partial CSV is produced', () => {
    // Construct a row that looks valid but whose accessor throws.
    const errorMessage = 'deliberate accessor failure';
    const badRows = [
      {
        // Accessor-like getter that throws when the value is read.
        get text(): string {
          throw new Error(errorMessage);
        },
        vote_count: 42,
      } as QuestionExportRow,
    ];

    let caughtError: unknown;
    let partialCsv: string | undefined;
    try {
      partialCsv = buildQuestionsCsv(badRows).csv;
    } catch (e) {
      caughtError = e;
    }

    // The error must have been thrown.
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe(errorMessage);
    // No partial string was returned — the assignment never completed.
    expect(partialCsv).toBeUndefined();
  });

  it('buildPollsCsv — throwing value accessor propagates the error; no partial CSV is produced', () => {
    const errorMessage = 'poll accessor failure';
    const badPolls = [
      {
        get question_text(): string {
          throw new Error(errorMessage);
        },
        options: [{ text: 'Option A', response_count: 1 }],
      } as PollExportRow,
    ];

    let caughtError: unknown;
    let partialCsv: string | undefined;
    try {
      partialCsv = buildPollsCsv(badPolls).csv;
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe(errorMessage);
    expect(partialCsv).toBeUndefined();
  });

  it('buildWordCloudCsv — throwing value accessor propagates the error; no partial CSV is produced', () => {
    const errorMessage = 'wordcloud accessor failure';
    const badResponses = [
      {
        get normalised_text(): string {
          throw new Error(errorMessage);
        },
        is_hidden: false,
      },
    ];

    let caughtError: unknown;
    let partialCsv: string | undefined;
    try {
      partialCsv = buildWordCloudCsv(badResponses).csv;
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe(errorMessage);
    expect(partialCsv).toBeUndefined();
  });
});
