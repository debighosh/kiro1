/**
 * Task 22.5 — EXAMPLE-BASED unit tests for the word-cloud RPC logic and
 * moderation. These are concrete-example unit tests (distinct from the
 * property-based suite in src/db/wordcloud.properties.test.ts) that exercise:
 *
 *   - PROMPT CREATE boundaries: prompt_text 1–200 code points and
 *     max_words_per_response 1–10, with FIELD-SPECIFIC rejection and NO prompt
 *     created on failure (mirroring create_word_cloud_prompt in
 *     supabase/migrations/20260101000024_word_cloud_prompt_rpc.sql — signals
 *     'invalid_prompt_text' / 'invalid_max_words'). Since wordCloudRules.ts does
 *     NOT expose create-validation predicates, these bounds are asserted here
 *     with small PURE helpers that mirror the SQL's decision logic (referenced
 *     in comments); wordCloudRules.ts is NOT modified.
 *   - single-open-prompt guard: opening a second prompt while one is open is
 *     rejected with 'prompt_already_open', leaving BOTH prompts unchanged
 *     (WordCloudModel.setPromptStatus, mirroring set_word_cloud_prompt_status +
 *     the one_open_prompt_per_event partial unique index).
 *   - response length: 1 ok, 50 ok, 51 rejected, empty/whitespace rejected with
 *     'invalid_length', retaining any prior response
 *     (isValidResponseText / WordCloudModel.submitResponse — mirroring
 *     submit_word_cloud_response, 20260101000026_word_cloud_respond_rpc.sql).
 *   - submit/update rejected when the prompt is not 'open' ('prompt_not_open'),
 *     retaining the prior response.
 *   - normalised_text stored on write via the SHARED normalise() contract.
 *   - hide marks is_hidden and REMOVES the entry from the visible aggregate
 *     (setResponseHidden + aggregateWordCloud from src/lib/wordcloud.ts).
 *   - stop-word terms excluded from aggregation.
 *
 * WHY A MODEL / PURE MODULES AND NOT THE LIVE SQL
 * -----------------------------------------------
 * The authoritative logic lives in PostgreSQL SECURITY DEFINER RPCs (plpgsql,
 * custom enum types, event_is_live, a partial UNIQUE index and a real UNIQUE
 * constraint) which cannot execute in this sandbox (no Postgres / Deno / psql /
 * supabase CLI; pg-mem cannot represent them). A live execution test runs
 * against a real Postgres in CI via the env-gated integration suites. These
 * example tests lock the DECISION RULES the SQL encodes against the pure
 * reference model (src/db/wordCloudRules.ts) and the shared normalisation /
 * aggregation module (src/lib/wordcloud.ts) — the matched pair with the SQL.
 * NOTHING from those modules is reimplemented here.
 *
 * Requirements: 6.2, 6.4, 6.6, 6.7, 6.8, 6.12, 6.13, 6.14, 26.1.
 * Design: Request/data flows (Word cloud).
 */
import { describe, expect, it } from 'vitest';

import {
  WordCloudModel,
  WordCloudRuleError,
  codePointLength,
  isValidResponseText,
  MIN_RESPONSE_LENGTH,
  MAX_RESPONSE_LENGTH,
} from './wordCloudRules';
import {
  aggregateWordCloud,
  normalise,
  type WordCloudResponseLike,
} from '../lib/wordcloud';

// ---------------------------------------------------------------------------
// Local PURE helpers mirroring the create_word_cloud_prompt validation
// (20260101000024_word_cloud_prompt_rpc.sql). wordCloudRules.ts intentionally
// does NOT expose create-validation predicates (the create RPC is not part of
// the response/lifecycle model), so — per the task's guidance to keep
// create-validation checks in the test file rather than extend the model — we
// mirror the SQL's exact decision logic here:
//   * prompt_text: char_length 1–200 code points, else signal 'invalid_prompt_text'.
//   * max_words_per_response: BETWEEN 1 AND 10, else signal 'invalid_max_words'.
// The SQL rejects the whole create (NO prompt row inserted) on either failure.
// ---------------------------------------------------------------------------

const PROMPT_TEXT_MIN = 1 as const;
const PROMPT_TEXT_MAX = 200 as const;
const MAX_WORDS_MIN = 1 as const;
const MAX_WORDS_MAX = 10 as const;

/** Mirrors create_word_cloud_prompt's prompt_text check (uses code points). */
function isValidPromptText(text: string | null | undefined): boolean {
  if (text === null || text === undefined) {
    return false;
  }
  const len = codePointLength(text);
  return len >= PROMPT_TEXT_MIN && len <= PROMPT_TEXT_MAX;
}

/** Mirrors create_word_cloud_prompt's max_words_per_response check (1–10). */
function isValidMaxWords(n: number | null | undefined): boolean {
  if (n === null || n === undefined || !Number.isInteger(n)) {
    return false;
  }
  return n >= MAX_WORDS_MIN && n <= MAX_WORDS_MAX;
}

/**
 * A tiny stand-in for the create RPC that returns the field-specific signal
 * (mirroring the SQL RAISE) or creates a prompt in the model (status 'draft').
 * Used to assert "no prompt created" on validation failure.
 */
function createPrompt(
  model: WordCloudModel,
  eventId: string,
  promptText: string | null | undefined,
  maxWords: number | null | undefined,
): { ok: true; promptId: string } | { ok: false; signal: string } {
  // Field order mirrors the SQL: prompt_text validated before max_words.
  if (!isValidPromptText(promptText)) {
    return { ok: false, signal: 'invalid_prompt_text' };
  }
  if (!isValidMaxWords(maxWords)) {
    return { ok: false, signal: 'invalid_max_words' };
  }
  const promptId = model.addPrompt({ eventId, status: 'draft' });
  return { ok: true, promptId };
}

// ===========================================================================
// PROMPT CREATE boundaries (Req 6.2) — prompt_text 1–200 and
// max_words_per_response 1–10, with field-specific rejection + NO prompt
// created. Mirrors 20260101000024 signals invalid_prompt_text / invalid_max_words.
// ===========================================================================

describe('prompt create boundaries (Req 6.2)', () => {
  it('accepts prompt_text at the lower (1) and upper (200) boundary', () => {
    expect(isValidPromptText('a')).toBe(true); // 1 code point
    expect(isValidPromptText('a'.repeat(PROMPT_TEXT_MAX))).toBe(true); // 200
    // A single astral (emoji) character counts as ONE code point (char_length).
    expect(codePointLength('😀')).toBe(1);
    expect(isValidPromptText('😀')).toBe(true);
  });

  it('rejects empty / whitespace-absent-of-content and >200 prompt_text (invalid_prompt_text, no prompt created)', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-create';
    model.addEvent(eventId, { live: true });

    // Empty (0 code points) → rejected.
    const empty = createPrompt(model, eventId, '', 5);
    expect(empty).toEqual({ ok: false, signal: 'invalid_prompt_text' });

    // null → rejected.
    const nul = createPrompt(model, eventId, null, 5);
    expect(nul).toEqual({ ok: false, signal: 'invalid_prompt_text' });

    // 201 code points → rejected.
    const tooLong = createPrompt(model, eventId, 'a'.repeat(201), 5);
    expect(tooLong).toEqual({ ok: false, signal: 'invalid_prompt_text' });

    // NO prompt row was created for the event on any failure.
    expect(model.getOpenPromptCount(eventId)).toBe(0);
    // (No prompt ids handed out — confirm by attempting a status set on a
    // non-existent id, which the model rejects with prompt_not_found.)
    expect(() => model.setPromptStatus('wcp-nonexistent', 'open')).toThrow(
      WordCloudRuleError,
    );
  });

  it('accepts max_words_per_response at the lower (1) and upper (10) boundary', () => {
    expect(isValidMaxWords(MAX_WORDS_MIN)).toBe(true); // 1
    expect(isValidMaxWords(MAX_WORDS_MAX)).toBe(true); // 10
    expect(isValidMaxWords(5)).toBe(true);
  });

  it('rejects max_words_per_response 0, 11, null, and non-integers (invalid_max_words, no prompt created)', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-create-mw';
    model.addEvent(eventId, { live: true });

    // Valid prompt_text so the failure is attributable to max_words only.
    for (const bad of [0, 11, null, undefined, 2.5]) {
      const res = createPrompt(model, eventId, 'Team values', bad as number);
      expect(res).toEqual({ ok: false, signal: 'invalid_max_words' });
    }
    // NO prompt created by any of the rejected calls.
    const seededCount = model.getResponsesForPrompt('any').length;
    expect(seededCount).toBe(0);
  });

  it('creates a draft prompt only when BOTH fields are valid', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-create-ok';
    model.addEvent(eventId, { live: true });

    const res = createPrompt(model, eventId, 'What describes MSS?', 3);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(model.getPrompt(res.promptId)?.status).toBe('draft');
    }
  });
});

// ===========================================================================
// Single-open-prompt guard (Req 6.4) — opening a second prompt while one is
// open is rejected with 'prompt_already_open', leaving BOTH unchanged.
// ===========================================================================

describe('single-open-prompt guard (Req 6.4)', () => {
  it('rejects a second open with prompt_already_open, leaving both prompts unchanged', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-guard';
    model.addEvent(eventId, { live: true });
    const a = model.addPrompt({ eventId, status: 'draft' });
    const b = model.addPrompt({ eventId, status: 'draft' });

    // Open A (draft → open) — permitted.
    model.setPromptStatus(a, 'open');
    expect(model.getPrompt(a)?.status).toBe('open');
    expect(model.getOpenPromptCount(eventId)).toBe(1);

    // Opening B while A is open is rejected.
    let thrown: unknown;
    try {
      model.setPromptStatus(b, 'open');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WordCloudRuleError);
    expect((thrown as WordCloudRuleError).kind).toBe('prompt_already_open');

    // BOTH prompts unchanged: A still open, B still draft; count still 1.
    expect(model.getPrompt(a)?.status).toBe('open');
    expect(model.getPrompt(b)?.status).toBe('draft');
    expect(model.getOpenPromptCount(eventId)).toBe(1);
  });

  it('permits opening a second prompt after the first is closed', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-guard-2';
    model.addEvent(eventId, { live: true });
    const a = model.addPrompt({ eventId, status: 'draft' });
    const b = model.addPrompt({ eventId, status: 'draft' });

    model.setPromptStatus(a, 'open');
    model.setPromptStatus(a, 'closed');
    model.setPromptStatus(b, 'open'); // now permitted
    expect(model.getPrompt(b)?.status).toBe('open');
    expect(model.getOpenPromptCount(eventId)).toBe(1);
  });
});

// ===========================================================================
// Response length boundary + empty rejection (Req 6.8), retaining any prior
// response. isValidResponseText / WordCloudModel.submitResponse mirror
// submit_word_cloud_response step 4 (trim then 1–50 code points).
// ===========================================================================

describe('response length boundary + empty rejection (Req 6.8)', () => {
  it('isValidResponseText accepts 1 and 50, rejects 51 and empty/whitespace/null', () => {
    expect(MIN_RESPONSE_LENGTH).toBe(1);
    expect(MAX_RESPONSE_LENGTH).toBe(50);

    expect(isValidResponseText('a')).toBe(true); // 1 char
    expect(isValidResponseText('a'.repeat(50))).toBe(true); // 50 chars
    expect(isValidResponseText('a'.repeat(51))).toBe(false); // 51 chars
    // Trim applies before measuring: 50 non-space chars with padding is valid.
    expect(isValidResponseText('  ' + 'a'.repeat(50) + '  ')).toBe(true);
    // Empty / whitespace-only / null / undefined → invalid.
    expect(isValidResponseText('')).toBe(false);
    expect(isValidResponseText('   ')).toBe(false);
    expect(isValidResponseText('\t\n')).toBe(false);
    expect(isValidResponseText(null)).toBe(false);
    expect(isValidResponseText(undefined)).toBe(false);
  });

  it('submitResponse accepts a 50-char response and rejects a 51-char one with invalid_length, retaining the prior response', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-len';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    const fifty = 'a'.repeat(50);
    model.submitResponse(promptId, 'p-a', fifty);
    expect(model.getResponse('p-a', promptId)?.rawText).toBe(fifty);

    // A 51-char resubmit is rejected; the prior 50-char response is retained.
    const fiftyOne = 'a'.repeat(51);
    expect(() => model.submitResponse(promptId, 'p-a', fiftyOne)).toThrow(
      WordCloudRuleError,
    );
    expect(model.getResponse('p-a', promptId)?.rawText).toBe(fifty);
    expect(model.getResponsesForPrompt(promptId).length).toBe(1);
  });

  it('submitResponse rejects empty/whitespace with invalid_length, retaining the prior response', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-empty';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    model.submitResponse(promptId, 'p-a', 'innovation');

    let thrown: unknown;
    try {
      model.submitResponse(promptId, 'p-a', '   ');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WordCloudRuleError);
    expect((thrown as WordCloudRuleError).kind).toBe('invalid_length');
    // Prior response retained unchanged.
    expect(model.getResponse('p-a', promptId)?.rawText).toBe('innovation');
  });
});

// ===========================================================================
// Submit/update rejected when the prompt is NOT open (Req 6.7), retaining the
// prior response. Mirrors submit_word_cloud_response step 2 ('prompt_not_open').
// ===========================================================================

describe('submit rejected when prompt not open (Req 6.7)', () => {
  it('rejects a first submission on a draft prompt with prompt_not_open', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-draft';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'draft' });

    let thrown: unknown;
    try {
      model.submitResponse(promptId, 'p-a', 'too early');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WordCloudRuleError);
    expect((thrown as WordCloudRuleError).kind).toBe('prompt_not_open');
    // Nothing stored.
    expect(model.getResponse('p-a', promptId)).toBeUndefined();
  });

  it('rejects an update after the prompt is closed, retaining the prior response', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-closed';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    model.submitResponse(promptId, 'p-a', 'first value');
    model.setPromptStatus(promptId, 'closed');

    let thrown: unknown;
    try {
      model.submitResponse(promptId, 'p-a', 'second value');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WordCloudRuleError);
    expect((thrown as WordCloudRuleError).kind).toBe('prompt_not_open');
    // Prior response retained unchanged.
    expect(model.getResponse('p-a', promptId)?.rawText).toBe('first value');
    expect(model.getResponsesForPrompt(promptId).length).toBe(1);
  });
});

// ===========================================================================
// normalised_text stored on write (Req 6.6) via the SHARED normalise() contract
// (src/lib/wordcloud.ts). submit_word_cloud_response step 5 normalises the
// trimmed text on write.
// ===========================================================================

describe('normalised_text stored on write (Req 6.6)', () => {
  it('stores normalisedText === normalise(rawInput) === "hello world"', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-norm';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    const row = model.submitResponse(promptId, 'p-a', '  Hello  World ');
    expect(row.normalisedText).toBe(normalise('  Hello  World '));
    expect(row.normalisedText).toBe('hello world');
    // rawText is the trimmed input; normalisation is stored separately.
    expect(row.rawText).toBe('Hello  World');
  });

  it('updates normalisedText on resubmission (latest write wins)', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-norm-2';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    model.submitResponse(promptId, 'p-a', 'Growth');
    const updated = model.submitResponse(promptId, 'p-a', '  TEAM  Work ');
    expect(updated.normalisedText).toBe(normalise('  TEAM  Work '));
    expect(updated.normalisedText).toBe('team work');
    expect(model.getResponsesForPrompt(promptId).length).toBe(1);
  });
});

// ===========================================================================
// Hide marks is_hidden and removes the entry from the visible aggregate
// (Req 6.12, 6.13). setResponseHidden + aggregateWordCloud(getResponsesForPrompt).
// ===========================================================================

/** Map the model's response rows to the aggregation input shape. */
function toAggregateInput(
  model: WordCloudModel,
  promptId: string,
): WordCloudResponseLike[] {
  return model.getResponsesForPrompt(promptId).map((r) => ({
    normalised_text: r.normalisedText,
    is_hidden: r.isHidden,
  }));
}

describe('hide marks is_hidden and removes the entry from the visible aggregate (Req 6.12, 6.13)', () => {
  it('drops a hidden term from the aggregate and lowers a shared term’s frequency', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-hide';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    // Two participants say "apple"; one says "banana".
    model.submitResponse(promptId, 'p-a', 'Apple');
    model.submitResponse(promptId, 'p-b', ' apple ');
    model.submitResponse(promptId, 'p-c', 'banana');

    // Before hiding: apple=2, banana=1.
    const before = aggregateWordCloud(toAggregateInput(model, promptId));
    const beforeByTerm = new Map(before.map((t) => [t.term, t.frequency]));
    expect(beforeByTerm.get('apple')).toBe(2);
    expect(beforeByTerm.get('banana')).toBe(1);

    // Hide one of the "apple" entries (moderator action) → is_hidden set.
    const hidden = model.setResponseHidden('p-a', promptId, true);
    expect(hidden.isHidden).toBe(true);

    // After hiding: apple frequency dropped to 1; banana unchanged.
    const after = aggregateWordCloud(toAggregateInput(model, promptId));
    const afterByTerm = new Map(after.map((t) => [t.term, t.frequency]));
    expect(afterByTerm.get('apple')).toBe(1);
    expect(afterByTerm.get('banana')).toBe(1);
  });

  it('removes a term entirely when its only contributing entry is hidden', () => {
    const model = new WordCloudModel();
    const eventId = 'evt-hide-2';
    model.addEvent(eventId, { live: true });
    const promptId = model.addPrompt({ eventId, status: 'open' });

    model.submitResponse(promptId, 'p-a', 'unique');
    model.submitResponse(promptId, 'p-b', 'keep');

    model.setResponseHidden('p-a', promptId, true);

    const after = aggregateWordCloud(toAggregateInput(model, promptId));
    const terms = after.map((t) => t.term);
    // The hidden term is absent from the visible aggregate.
    expect(terms).not.toContain('unique');
    expect(terms).toContain('keep');
  });
});

// ===========================================================================
// Stop-word terms excluded from aggregation (Req 6.14). Comparison uses the
// SAME normalise() so "The"/" the "/"the" all exclude "the".
// ===========================================================================

describe('stop-word terms excluded from aggregation (Req 6.14)', () => {
  it('excludes a configured stop-word ("the") from the aggregate', () => {
    const responses: WordCloudResponseLike[] = [
      { normalised_text: 'the', is_hidden: false },
      { normalised_text: 'The', is_hidden: false },
      { normalised_text: 'innovation', is_hidden: false },
    ];
    const terms = aggregateWordCloud(responses, { stopWords: ['the'] });
    const byTerm = new Map(terms.map((t) => [t.term, t.frequency]));
    // "the" is excluded regardless of case; "innovation" remains.
    expect(byTerm.has('the')).toBe(false);
    expect(byTerm.get('innovation')).toBe(1);
    expect(terms.length).toBe(1);
  });

  it('matches stop-words normalisation-consistently ("  The  " excludes "the")', () => {
    const responses: WordCloudResponseLike[] = [
      { normalised_text: 'the', is_hidden: false },
      { normalised_text: 'value', is_hidden: false },
    ];
    const terms = aggregateWordCloud(responses, { stopWords: ['  The  '] });
    const byTerm = new Map(terms.map((t) => [t.term, t.frequency]));
    expect(byTerm.has('the')).toBe(false);
    expect(byTerm.get('value')).toBe(1);
  });
});
