/**
 * Task 24.3 — Property-based + unit tests for the PRESENTER portion of the
 * moderation-visibility invariant (Property 10) as it applies to the two
 * Milestone-3 presenter modes: `word_cloud` and `poll_results`.
 *
 * This is the polls/word-cloud REMAINDER of Property 10. The QUESTION portion
 * is covered by src/db/moderationVisibility.properties.test.ts (read that file
 * first — this suite mirrors its structure and pure/in-memory discipline).
 *
 * WHY A MODEL AND NOT THE LIVE SQL / RLS
 * --------------------------------------
 * The authoritative visibility rules live in Postgres RLS + the presenter read
 * layer, which cannot execute in this sandbox (no Postgres / Deno / supabase
 * CLI). This suite is DELIBERATELY pure / in-memory and does NOT import
 * src/lib/presenter.ts (which transitively loads src/lib/supabaseClient.ts and
 * throws unless VITE_SUPABASE_* is set). Instead it exercises the two decision
 * rules the RLS-backed read path encodes:
 *
 *   WORD CLOUD (Req 6.13, 7.9): the presenter reads visible responses via
 *   `readPresenterWordCloud` (its anon SELECT is RLS-filtered to
 *   `is_hidden = false`), then renders `aggregateWordCloud(responses)` from
 *   ../lib/wordcloud (which ALSO excludes `is_hidden === true` and stop words —
 *   defence-in-depth). So the presenter-visible word-cloud aggregate is exactly
 *   `aggregateWordCloud(responses)`. We assert that a hidden entry can NEVER
 *   raise a term's presenter-visible frequency: every term's frequency equals
 *   the count of its NON-hidden contributing responses (a hidden entry
 *   contributes 0), and a term whose only contributors are hidden never
 *   appears.
 *
 *   POLLS (Req 5.11, 7.9): the presenter reveals a poll's tallies iff
 *   `status === 'closed' || results_visibility === 'show_always'` — exactly the
 *   `revealTallies` rule PresenterView applies in src/routes/screens.tsx (the
 *   `poll_results` branch). We model that rule as the pure predicate
 *   `presenterPollResultsVisible` below (documented to mirror screens.tsx —
 *   NO source file is modified) and assert that an OPEN `hide_until_closed`
 *   poll's results are NEVER presenter-visible, while a `show_always` poll's
 *   are always visible.
 *
 * Feature: mss-livepulse, Property 10: Moderation visibility invariant
 * (presenter poll/word-cloud remainder).
 * Validates: Requirements 6.13, 7.9, 5.11.
 * Design: Correctness Properties (Property 10); RLS Design
 *         (`word_cloud_responses`, `polls` per-table policies — anonymous
 *         SELECT excludes hidden responses / draft polls).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  aggregateWordCloud,
  normalise,
  type WordCloudResponseLike,
} from '../lib/wordcloud';

// ---------------------------------------------------------------------------
// WORD CLOUD — presenter-visible aggregate never exposes a hidden entry.
// ---------------------------------------------------------------------------

/**
 * A small pool of terms (some overlapping after normalisation, e.g. "AI"/"ai")
 * so the generated multisets aggregate several responses into one term and mix
 * hidden + visible contributors for the same term.
 */
const TERM_POOL = ['AI', 'ai', 'cloud', 'Cloud', 'data', 'ML', 'edge', ''];

/** A generated stored response: an (arbitrary) term + a random hidden flag. */
const responseArb: fc.Arbitrary<WordCloudResponseLike> = fc.record({
  normalised_text: fc.constantFrom(...TERM_POOL),
  is_hidden: fc.boolean(),
});

/** An arbitrary multiset of responses spanning hidden/visible flags. */
const responsesArb: fc.Arbitrary<WordCloudResponseLike[]> = fc.array(
  responseArb,
  { maxLength: 40 },
);

/**
 * Reference: the count of NON-hidden, non-empty responses per normalised term,
 * written INDEPENDENTLY of `aggregateWordCloud` (so the property is not a
 * tautology). Hidden entries contribute 0.
 */
function visibleFrequencies(
  responses: readonly WordCloudResponseLike[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of responses) {
    if (r.is_hidden === true) continue;
    const term = normalise(r.normalised_text);
    if (term.length === 0) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

describe('Feature: mss-livepulse, Property 10: Moderation visibility invariant (presenter word cloud)', () => {
  it('the presenter word-cloud aggregate frequency of every term equals its NON-hidden contributor count (hidden entries contribute 0)', () => {
    fc.assert(
      fc.property(responsesArb, (responses) => {
        // The presenter-visible aggregate = the RLS-backed read path
        // (is_hidden = false) + aggregateWordCloud (which also drops hidden).
        const terms = aggregateWordCloud(responses);
        const expected = visibleFrequencies(responses);

        // Every rendered term's frequency == its non-hidden contributor count.
        for (const { term, frequency } of terms) {
          expect(frequency).toBe(expected.get(term));
        }

        // And the rendered term SET equals exactly the terms with >=1 visible
        // contributor — no term whose only contributors are hidden appears.
        const renderedTerms = new Set(terms.map((t) => t.term));
        const expectedTerms = new Set(expected.keys());
        expect(renderedTerms).toEqual(expectedTerms);
      }),
    );
  });

  it('NO term whose ONLY contributing responses are hidden ever appears in the presenter word cloud (Req 6.13, 7.9)', () => {
    fc.assert(
      fc.property(responsesArb, (responses) => {
        const terms = new Set(aggregateWordCloud(responses).map((t) => t.term));
        // Terms that have at least one hidden contributor but ZERO visible
        // contributors must be absent from the presenter cloud.
        const hiddenOnlyTerms = new Map<string, { hidden: number; visible: number }>();
        for (const r of responses) {
          const term = normalise(r.normalised_text);
          if (term.length === 0) continue;
          const entry = hiddenOnlyTerms.get(term) ?? { hidden: 0, visible: 0 };
          if (r.is_hidden) entry.hidden += 1;
          else entry.visible += 1;
          hiddenOnlyTerms.set(term, entry);
        }
        for (const [term, { hidden, visible }] of hiddenOnlyTerms) {
          if (hidden > 0 && visible === 0) {
            expect(terms.has(term)).toBe(false);
          }
        }
      }),
    );
  });

  it('adding hidden responses can never raise a term’s presenter-visible frequency (monotone in visible contributors only)', () => {
    fc.assert(
      fc.property(responsesArb, responsesArb, (visibleBatch, hiddenBatch) => {
        // Force `hiddenBatch` to be entirely hidden, then confirm mixing it in
        // does not change any term's presenter-visible frequency.
        const onlyHidden = hiddenBatch.map((r) => ({ ...r, is_hidden: true }));
        const baseline = aggregateWordCloud(visibleBatch);
        const mixed = aggregateWordCloud([...visibleBatch, ...onlyHidden]);

        const baselineFreq = new Map(baseline.map((t) => [t.term, t.frequency]));
        const mixedFreq = new Map(mixed.map((t) => [t.term, t.frequency]));

        // Every baseline term keeps EXACTLY its frequency; no new term appears
        // purely from the hidden batch.
        for (const [term, freq] of baselineFreq) {
          expect(mixedFreq.get(term)).toBe(freq);
        }
        expect(new Set(mixedFreq.keys())).toEqual(new Set(baselineFreq.keys()));
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// POLLS — presenter results-visibility predicate.
//
// This predicate mirrors the `revealTallies` rule PresenterView applies in
// src/routes/screens.tsx (the `poll_results` branch):
//
//     const revealTallies =
//       poll.status === 'closed' ||
//       poll.results_visibility === 'show_always';
//
// It is defined here (in-test) ONLY so the property can exercise the rule
// without importing screens.tsx (which pulls in the Supabase client). No source
// file is modified.
// ---------------------------------------------------------------------------

type PollStatus = 'open' | 'closed';
type ResultsVisibility = 'show_always' | 'hide_until_closed';

/**
 * Whether the presenter reveals a poll's per-option tallies. Mirrors
 * `revealTallies` in src/routes/screens.tsx: results are shown once the poll is
 * `closed`, or whenever `results_visibility` is `show_always` (Req 5.11).
 */
function presenterPollResultsVisible(
  status: PollStatus,
  resultsVisibility: ResultsVisibility,
): boolean {
  return status === 'closed' || resultsVisibility === 'show_always';
}

const ALL_STATUSES: readonly PollStatus[] = ['open', 'closed'];
const ALL_VISIBILITIES: readonly ResultsVisibility[] = [
  'show_always',
  'hide_until_closed',
];

describe('Feature: mss-livepulse, Property 10: Moderation visibility invariant (presenter poll results)', () => {
  it('for ALL (status × results_visibility) combinations: hide_until_closed tallies are visible IFF closed; show_always is always visible (Req 5.11)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_VISIBILITIES),
        (status, visibility) => {
          const visible = presenterPollResultsVisible(status, visibility);
          if (visibility === 'show_always') {
            // show_always: always visible, open or closed.
            expect(visible).toBe(true);
          } else {
            // hide_until_closed: visible IFF the poll is closed.
            expect(visible).toBe(status === 'closed');
          }
        },
      ),
    );
  });

  it('an OPEN hide_until_closed poll’s results are NEVER presenter-visible (withheld until closed)', () => {
    // Exhaustive over the (small) input space, and as a property.
    expect(presenterPollResultsVisible('open', 'hide_until_closed')).toBe(false);
    fc.assert(
      fc.property(fc.constant('open' as const), () => {
        expect(
          presenterPollResultsVisible('open', 'hide_until_closed'),
        ).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — concrete examples / edge cases for both rules, complementing the
// universal properties above. Validates Req 6.13, 7.9, 5.11.
// ---------------------------------------------------------------------------

describe('presenter word-cloud visibility — unit examples (Req 6.13, 7.9)', () => {
  it('excludes a term whose only response is hidden', () => {
    const terms = aggregateWordCloud([
      { normalised_text: 'secret', is_hidden: true },
      { normalised_text: 'open', is_hidden: false },
    ]);
    const rendered = terms.map((t) => t.term);
    expect(rendered).toContain('open');
    expect(rendered).not.toContain('secret');
  });

  it('a term with one hidden + two visible responses has frequency 2 (hidden contributes 0)', () => {
    const terms = aggregateWordCloud([
      { normalised_text: 'AI', is_hidden: false },
      { normalised_text: 'ai', is_hidden: false },
      { normalised_text: 'Ai', is_hidden: true },
    ]);
    const ai = terms.find((t) => t.term === 'ai');
    expect(ai?.frequency).toBe(2);
  });

  it('renders nothing when every response is hidden', () => {
    expect(
      aggregateWordCloud([
        { normalised_text: 'a', is_hidden: true },
        { normalised_text: 'b', is_hidden: true },
      ]),
    ).toHaveLength(0);
  });
});

describe('presenter poll results visibility — unit examples (Req 5.11)', () => {
  it('closed polls always reveal tallies regardless of results_visibility', () => {
    expect(presenterPollResultsVisible('closed', 'hide_until_closed')).toBe(true);
    expect(presenterPollResultsVisible('closed', 'show_always')).toBe(true);
  });

  it('open + show_always reveals tallies; open + hide_until_closed withholds them', () => {
    expect(presenterPollResultsVisible('open', 'show_always')).toBe(true);
    expect(presenterPollResultsVisible('open', 'hide_until_closed')).toBe(false);
  });
});
