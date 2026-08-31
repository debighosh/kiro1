/**
 * Task 22.6 — Property-based tests for the word-cloud invariants
 * (Properties 6, 7, 8, 9), exercised against:
 *   - the pure PROMPT-LIFECYCLE + RESPONSE-UPSERT rule model in
 *     src/db/wordCloudRules.ts (Properties 6, 7), and
 *   - the pure NORMALISATION + AGGREGATION module in src/lib/wordcloud.ts
 *     (Properties 8, 9) — imported, NEVER reimplemented.
 *
 * WHY MODELS/PURE MODULES AND NOT THE LIVE SQL
 * --------------------------------------------
 * The authoritative word-cloud logic lives in PostgreSQL SECURITY DEFINER RPCs
 * (supabase/migrations/20260101000024_word_cloud_prompt_rpc.sql — the prompt
 * lifecycle + one_open_prompt_per_event guard; and
 * 20260101000026_word_cloud_respond_rpc.sql — the response upsert with
 * normalise-on-write). Those functions use plpgsql, custom enum types,
 * `event_is_live`, a partial UNIQUE index and a real UNIQUE constraint — none of
 * which can execute in this sandbox (no Postgres/Deno/psql/supabase CLI; pg-mem
 * cannot represent them). A live execution test runs against a real Postgres in
 * CI via the env-gated integration suites.
 *
 * These property tests lock down the DECISION RULES the SQL encodes — one
 * response per participant per prompt tracking the latest text, at most one open
 * prompt per event, canonical/idempotent normalisation, and aggregation
 * equivalence + monotonic sizing — so a change to the intended behaviour is
 * caught fast. The model and the SQL are a matched pair; the normalisation and
 * aggregation are the single source of truth in src/lib/wordcloud.ts, shared by
 * the client and (re-implemented identically) by the write path.
 *
 * Validates: Requirements 6.4, 6.5, 6.6, 6.9, 6.10, 6.11, 6.13, 6.14
 * Design: Correctness Properties (Properties 6, 7, 8, 9).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  WordCloudModel,
  WordCloudRuleError,
  type WordCloudStatus,
} from './wordCloudRules';
import {
  aggregateWordCloud,
  normalise,
  sizeForFrequency,
  DEFAULT_MIN_SIZE,
  DEFAULT_MAX_SIZE,
  type WordCloudResponseLike,
  type WordCloudTerm,
} from '../lib/wordcloud';

// A small pool of distinct participants so uniqueness collisions are frequent.
const PARTICIPANT_POOL = ['p-a', 'p-b', 'p-c', 'p-d'] as const;

// A small pool of distinct valid response texts (each 1–50 code points after
// trim) so repeated submissions genuinely change the stored value.
const TEXT_POOL = [
  'Innovation',
  'growth mindset',
  '  Teamwork ',
  'CUSTOMER focus',
  'agile',
] as const;

// ===========================================================================
// Feature: mss-livepulse, Property 6: One response per participant per
// word-cloud prompt. For any random sequence of submissions/updates by a set of
// participants against a single OPEN prompt, there is never more than one
// response row per (participant, prompt), and that single row's value tracks the
// LATEST successful update. Validates Req 6.6, 6.9.
// ===========================================================================

interface SubmitOp {
  participant: string;
  text: string;
}

const submitOpArb: fc.Arbitrary<SubmitOp> = fc.record({
  participant: fc.constantFrom(...PARTICIPANT_POOL),
  text: fc.constantFrom(...TEXT_POOL),
});

describe('Property 6: one response per participant per word-cloud prompt (Req 6.6, 6.9)', () => {
  it('collapses repeated submissions to a single row tracking the latest text', () => {
    fc.assert(
      fc.property(
        fc.array(submitOpArb, { minLength: 1, maxLength: 40 }),
        (ops) => {
          const model = new WordCloudModel();
          const eventId = 'evt-1';
          model.addEvent(eventId, { live: true });
          const promptId = model.addPrompt({ eventId, status: 'open' });

          // Track the latest submitted text per participant as the oracle.
          const latest = new Map<string, string>();
          for (const op of ops) {
            model.submitResponse(promptId, op.participant, op.text);
            latest.set(op.participant, op.text);
          }

          // Exactly one row per distinct participant that submitted.
          const rows = model.getResponsesForPrompt(promptId);
          expect(rows.length).toBe(latest.size);

          // Each participant has exactly one row whose value tracks the latest.
          for (const [participant, text] of latest) {
            const row = model.getResponse(participant, promptId);
            expect(row).toBeDefined();
            // The stored raw text is the trimmed latest submission and the
            // normalised text is normalise() of that latest submission.
            expect(row?.rawText).toBe(text.trim());
            expect(row?.normalisedText).toBe(normalise(text));
          }

          // The (participant, prompt) key set is unique — no duplicate rows.
          const keys = rows.map((r) => `${r.participant}::${r.promptId}`);
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
    );
  });

  it('a rejected update (prompt closed) retains the prior response unchanged', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-closed';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    model.submitResponse(promptId, 'p-a', 'first value');
    model.setPromptStatus(promptId, 'closed');

    expect(() => model.submitResponse(promptId, 'p-a', 'second value')).toThrow(
      WordCloudRuleError,
    );
    // Prior response retained unchanged (Req 6.7 intent behind Property 6).
    expect(model.getResponse('p-a', promptId)?.rawText).toBe('first value');
    expect(model.getResponsesForPrompt(promptId).length).toBe(1);
  });
});

// ===========================================================================
// Feature: mss-livepulse, Property 7: At most one open word-cloud prompt per
// event. For any random sequence of prompt open/close operations across several
// prompts of one event, count(status='open') is always <= 1 after every step,
// and an attempt to open a second prompt while one is open is rejected leaving
// both prompts unchanged. Validates Req 6.4, 6.5.
// ===========================================================================

interface LifecycleOp {
  promptIndex: number;
  status: WordCloudStatus;
}

const lifecycleOpArb: fc.Arbitrary<LifecycleOp> = fc.record({
  promptIndex: fc.integer({ min: 0, max: 2 }), // three prompts on the event
  status: fc.constantFrom<WordCloudStatus>('draft', 'open', 'closed'),
});

describe('Property 7: at most one open word-cloud prompt per event (Req 6.4, 6.5)', () => {
  it('keeps open-count <= 1 after every step and rejects a second open', () => {
    fc.assert(
      fc.property(
        fc.array(lifecycleOpArb, { minLength: 1, maxLength: 40 }),
        (ops) => {
          const model = new WordCloudModel();
          const eventId = 'evt-1';
          model.addEvent(eventId, { live: true });
          // Three prompts on the same event, all starting in 'draft'.
          const promptIds = [
            model.addPrompt({ eventId, status: 'draft' }),
            model.addPrompt({ eventId, status: 'draft' }),
            model.addPrompt({ eventId, status: 'draft' }),
          ];

          for (const op of ops) {
            const promptId = promptIds[op.promptIndex];
            const before = promptIds.map((id) => model.getPrompt(id)?.status);

            try {
              model.setPromptStatus(promptId, op.status);
            } catch (err) {
              // Only invalid_transition or prompt_already_open may be thrown.
              expect(err).toBeInstanceOf(WordCloudRuleError);
              const kind = (err as WordCloudRuleError).kind;
              expect(
                kind === 'invalid_transition' || kind === 'prompt_already_open',
              ).toBe(true);
              // On rejection nothing changed: statuses identical to `before`.
              const after = promptIds.map((id) => model.getPrompt(id)?.status);
              expect(after).toEqual(before);
            }

            // INVARIANT: at most one open prompt per event after every step.
            expect(model.getOpenPromptCount(eventId)).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });

  it('rejects a second open with prompt_already_open, leaving both unchanged', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-1';
    model.addEvent(eventId, { live: true });
    const a = model.addPrompt({ eventId, status: 'draft' });
    const b = model.addPrompt({ eventId, status: 'draft' });

    model.setPromptStatus(a, 'open');
    expect(model.getOpenPromptCount(eventId)).toBe(1);

    let thrown: unknown;
    try {
      model.setPromptStatus(b, 'open');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WordCloudRuleError);
    expect((thrown as WordCloudRuleError).kind).toBe('prompt_already_open');
    // Both unchanged: a still open, b still draft.
    expect(model.getPrompt(a)?.status).toBe('open');
    expect(model.getPrompt(b)?.status).toBe('draft');
    expect(model.getOpenPromptCount(eventId)).toBe(1);
  });

  it('allows opening a second prompt after the first is closed', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-1';
    model.addEvent(eventId, { live: true });
    const a = model.addPrompt({ eventId, status: 'draft' });
    const b = model.addPrompt({ eventId, status: 'draft' });

    model.setPromptStatus(a, 'open');
    model.setPromptStatus(a, 'closed');
    model.setPromptStatus(b, 'open'); // now permitted
    expect(model.getOpenPromptCount(eventId)).toBe(1);
    expect(model.getPrompt(b)?.status).toBe('open');
  });

  it('rejects illegal transitions leaving status unchanged', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-1';
    model.addEvent(eventId, { live: true });
    const a = model.addPrompt({ eventId, status: 'draft' });

    // draft → closed is illegal.
    expect(() => model.setPromptStatus(a, 'closed')).toThrow(
      WordCloudRuleError,
    );
    expect(model.getPrompt(a)?.status).toBe('draft');
  });
});

// ===========================================================================
// Feature: mss-livepulse, Property 8: Word-cloud normalisation is idempotent and
// canonical. For any Unicode string with mixed case and whitespace runs,
// normalise(normalise(s)) === normalise(s), and the result has no
// leading/trailing whitespace, no consecutive internal whitespace, and only
// lower-case letters. Validates Req 6.10. Uses the EXISTING normalise() from
// src/lib/wordcloud.ts. NOTHING is reimplemented here.
// ===========================================================================

// A generator that biases toward mixed case + whitespace runs so the canonical
// shape is meaningfully exercised (leading/trailing/internal runs, tabs, NBSP,
// newlines) while still spanning arbitrary Unicode.
// fast-check v4: full-Unicode strings are produced via `fc.string` with a
// grapheme/binary unit (the legacy `fullUnicodeString` helper was removed).
const unicodeStringArb: fc.Arbitrary<string> = fc.string({ unit: 'grapheme' });

const messyStringArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  unicodeStringArb,
  fc
    .array(
      fc.oneof(
        fc.constantFrom(' ', '\t', '\n', '\r', '\u00A0', '\u2003', '  '),
        fc.constantFrom('Hello', 'WORLD', 'FooBar', 'Ábç', 'ÄÖÜ', 'x', '42'),
        fc.string({ unit: 'grapheme', maxLength: 4 }),
      ),
      { maxLength: 12 },
    )
    .map((parts) => parts.join('')),
);

describe('Property 8: normalisation is idempotent and canonical (Req 6.10)', () => {
  it('is idempotent and produces a canonical shape for arbitrary strings', () => {
    fc.assert(
      fc.property(messyStringArb, (s) => {
        const once = normalise(s);
        // Idempotent: re-normalising is a no-op.
        expect(normalise(once)).toBe(once);
        // No leading/trailing whitespace.
        expect(once).toBe(once.trim());
        // No run of two or more consecutive whitespace characters.
        expect(/\s\s/.test(once)).toBe(false);
        // No upper-case letters (letters are lower-cased; equals its own
        // lower-case form).
        expect(once).toBe(once.toLowerCase());
      }),
    );
  });

  it('normalises explicit examples canonically', () => {
    expect(normalise('  Hello   World  ')).toBe('hello world');
    expect(normalise('FooBar')).toBe('foobar');
    expect(normalise('\tTabbed\nNewline\r')).toBe('tabbed newline');
    expect(normalise('   ')).toBe('');
    expect(normalise('word\u00A0\u00A0break')).toBe('word break');
  });
});

// ===========================================================================
// Feature: mss-livepulse, Property 9: Word-cloud aggregation equivalence and
// monotonic sizing. For a random multiset of responses (with random is_hidden
// flags) and a stop-word list: identical normalised terms aggregate into ONE
// term whose frequency equals the count of contributing (non-hidden,
// non-stop-word, non-empty) responses; hidden and stop-word terms contribute
// nothing; and f1 <= f2 ⇒ size(f1) <= size(f2). Validates Req 6.11, 6.13, 6.14.
// Uses the EXISTING aggregateWordCloud() / sizeForFrequency() from
// src/lib/wordcloud.ts. NOTHING is reimplemented here.
// ===========================================================================

// Words drawn from a small pool so collisions (and thus aggregation) are common;
// they include mixed case / whitespace so normalisation is exercised inside
// aggregation. A few empties test the empty-drop path.
const wordArb: fc.Arbitrary<string> = fc.constantFrom(
  'Apple',
  'apple',
  ' apple ',
  'Banana',
  'BANANA',
  'cherry',
  'Cherry ',
  'the',
  'The',
  '',
  '   ',
);

const responseArb: fc.Arbitrary<WordCloudResponseLike> = fc.record({
  normalised_text: wordArb,
  is_hidden: fc.boolean(),
});

const stopWordsArb: fc.Arbitrary<readonly string[]> = fc.subarray(
  ['the', 'The', ' the '],
  { minLength: 0, maxLength: 3 },
);

describe('Property 9: aggregation equivalence + monotonic sizing (Req 6.11, 6.13, 6.14)', () => {
  it('aggregates identical normalised terms and excludes hidden/stop-words', () => {
    fc.assert(
      fc.property(
        fc.array(responseArb, { maxLength: 60 }),
        stopWordsArb,
        (responses, stopWords) => {
          const terms = aggregateWordCloud(responses, { stopWords });

          // Build the independent oracle: normalised excluded set.
          const excluded = new Set<string>();
          for (const raw of stopWords) {
            const t = normalise(raw);
            if (t.length > 0) excluded.add(t);
          }
          const expectedCounts = new Map<string, number>();
          for (const r of responses) {
            if (r.is_hidden === true) continue; // hidden contributes nothing
            const t = normalise(r.normalised_text);
            if (t.length === 0) continue; // empty contributes nothing
            if (excluded.has(t)) continue; // stop-word contributes nothing
            expectedCounts.set(t, (expectedCounts.get(t) ?? 0) + 1);
          }

          // One term per distinct contributing normalised value.
          expect(terms.length).toBe(expectedCounts.size);
          const termNames = terms.map((t) => t.term);
          expect(new Set(termNames).size).toBe(termNames.length); // unique

          for (const term of terms) {
            // Each term is itself canonical.
            expect(term.term).toBe(normalise(term.term));
            // Frequency equals the count of contributing responses.
            expect(term.frequency).toBe(expectedCounts.get(term.term));
            // Hidden/stop-word/empty never appear.
            expect(excluded.has(term.term)).toBe(false);
          }
        },
      ),
    );
  });

  it('size is a non-decreasing function of frequency (f1 <= f2 ⇒ size(f1) <= size(f2))', () => {
    fc.assert(
      fc.property(
        fc.array(responseArb, { minLength: 1, maxLength: 60 }),
        stopWordsArb,
        (responses, stopWords) => {
          const terms = aggregateWordCloud(responses, { stopWords });
          for (const a of terms) {
            for (const b of terms) {
              if (a.frequency <= b.frequency) {
                expect(a.size).toBeLessThanOrEqual(b.size);
              }
            }
          }
        },
      ),
    );
  });

  it('sizeForFrequency is monotonic across arbitrary frequency pairs and bounds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (f1, f2, minFreq, maxFreq) => {
          const minSize = DEFAULT_MIN_SIZE;
          const maxSize = DEFAULT_MAX_SIZE;
          const s1 = sizeForFrequency(f1, minFreq, maxFreq, minSize, maxSize);
          const s2 = sizeForFrequency(f2, minFreq, maxFreq, minSize, maxSize);
          if (f1 <= f2) {
            expect(s1).toBeLessThanOrEqual(s2);
          }
          // Result is always within [minSize, maxSize].
          expect(s1).toBeGreaterThanOrEqual(minSize);
          expect(s1).toBeLessThanOrEqual(maxSize);
        },
      ),
    );
  });

  it('aggregates explicit examples correctly', () => {
    const responses: WordCloudResponseLike[] = [
      { normalised_text: 'Apple', is_hidden: false },
      { normalised_text: ' apple ', is_hidden: false },
      { normalised_text: 'APPLE', is_hidden: true }, // hidden → excluded
      { normalised_text: 'banana', is_hidden: false },
      { normalised_text: 'the', is_hidden: false }, // stop-word → excluded
      { normalised_text: '   ', is_hidden: false }, // empty → dropped
    ];
    const terms: WordCloudTerm[] = aggregateWordCloud(responses, {
      stopWords: ['the'],
    });
    const byTerm = new Map(terms.map((t) => [t.term, t.frequency]));
    expect(byTerm.get('apple')).toBe(2); // Apple + " apple " (hidden excluded)
    expect(byTerm.get('banana')).toBe(1);
    expect(byTerm.has('the')).toBe(false);
    expect(terms.length).toBe(2);
    // Higher frequency ⇒ size >= lower frequency's size.
    const apple = terms.find((t) => t.term === 'apple')!;
    const banana = terms.find((t) => t.term === 'banana')!;
    expect(apple.size).toBeGreaterThanOrEqual(banana.size);
  });
});
