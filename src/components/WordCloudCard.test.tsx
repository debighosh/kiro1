/**
 * Unit tests for the `WordCloudCard` audience word-cloud surface (Task 23.6).
 *
 * These mock `../lib/wordCloudClient` (so no real Supabase client / network is
 * touched — importing the real module transitively loads `../lib/supabaseClient`,
 * which throws unless VITE_SUPABASE_* env vars are set) while keeping a REAL
 * `WordCloudClientError` class inside the mock factory so the component's
 * `instanceof WordCloudClientError` sanitised-message branch is exercised
 * faithfully.
 *
 * Crucially the pure `../lib/wordcloud` module (owning `normalise()` /
 * `aggregateWordCloud()`) is NOT mocked — the real implementation is used so the
 * client normalised-preview and the monotonic term-sizing assertions are
 * meaningful and deterministic.
 *
 * We verify the behaviours the design + requirements mandate:
 *   (a) length validation (Req 6.8): submitting empty/whitespace OR a 51-char
 *       value shows the 1–50 constraint message AND RETAINS the entered text;
 *   (b) client normalise preview (Req 6.10): typing "  Hello  World " shows the
 *       preview computed by the SAME real `normalise()` ("hello world");
 *   (c) monotonic sizing (Req 6.11): a higher-frequency term renders at a
 *       font-size >= a lower-frequency term's — read from the `data-size` /
 *       `style.fontSize` the visualisation sets (aggregation is real, so this is
 *       deterministic);
 *   (d) the participant identifier NEVER reaches the DOM (Req 8.6).
 *
 * Requirements: 6.8, 6.10, 6.11, 8.6, 26.1.
 * Design: Components (`WordCloudCard`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The REAL shared normalise, imported so the preview assertion compares against
// the single source of truth (NOT a hand-written expectation).
import { normalise } from '../lib/wordcloud';

// Copy of the exact 1–50 length message so tests assert the wording without
// pulling it from the (mocked) client module. Kept in sync with
// `../lib/wordCloudClient`'s `WORD_CLOUD_LENGTH_MESSAGE`.
const WORD_CLOUD_LENGTH_MESSAGE =
  'Your response must be between 1 and 50 characters.';

// Mock ONLY the network/RPC client module. The factory is hoisted, so the spies
// are exposed via `vi.hoisted` and must not reference outer variables. A REAL
// `WordCloudClientError` lives inside the factory so the component's error
// branch (`instanceof WordCloudClientError`) still matches.
const {
  readActivePrompt,
  readVisibleResponses,
  submitWordCloudResponse,
  subscribeToWordCloud,
} = vi.hoisted(() => ({
  readActivePrompt: vi.fn(),
  readVisibleResponses: vi.fn(),
  submitWordCloudResponse: vi.fn(),
  subscribeToWordCloud: vi.fn(),
}));

vi.mock('../lib/wordCloudClient', () => {
  class WordCloudClientError extends Error {
    kind: string;
    cause?: unknown;
    constructor(message: string, options: { kind: string; cause?: unknown }) {
      super(message);
      this.name = 'WordCloudClientError';
      this.kind = options.kind;
      this.cause = options.cause;
    }
  }
  return {
    WordCloudClientError,
    WORD_CLOUD_TEXT_MAX: 50,
    WORD_CLOUD_LENGTH_MESSAGE:
      'Your response must be between 1 and 50 characters.',
    countWordCloudCodePoints: (v: string) => [...v].length,
    readActivePrompt: (eventId: string) => readActivePrompt(eventId),
    readVisibleResponses: (promptId: string) => readVisibleResponses(promptId),
    submitWordCloudResponse: (promptId: string, rawText: string) =>
      submitWordCloudResponse(promptId, rawText),
    subscribeToWordCloud: (eventId: string, handlers: unknown) =>
      subscribeToWordCloud(eventId, handlers),
  };
});

import { WordCloudCard } from './WordCloudCard';

const EVENT_ID = 'event-wc-123';

/** A sentinel participant identifier that must NEVER appear in the DOM (Req 8.6). */
const PARTICIPANT_SENTINEL = 'PARTICIPANT-SENTINEL-DO-NOT-RENDER-wc-xyz';

/** Builds an active word-cloud prompt. Extra props simulate a leaky read. */
function buildPrompt(overrides: Record<string, unknown> = {}): Record<
  string,
  unknown
> {
  return {
    id: 'prompt-1',
    event_id: EVENT_ID,
    prompt_text: 'Describe today in one word',
    max_words_per_response: 1,
    status: 'open',
    results_visible_while_collecting: false,
    // A leaked identity field — must never render (Req 8.6).
    participant_identifier: PARTICIPANT_SENTINEL,
    ...overrides,
  };
}

beforeEach(() => {
  readActivePrompt.mockReset();
  readVisibleResponses.mockReset();
  submitWordCloudResponse.mockReset();
  subscribeToWordCloud.mockReset();
  // Defaults: no visible responses, a no-op unsubscribe.
  readVisibleResponses.mockResolvedValue([]);
  subscribeToWordCloud.mockReturnValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('WordCloudCard — length validation retains text (Req 6.8)', () => {
  it('submitting whitespace-only input shows the 1–50 message and retains the entered text', async () => {
    const user = userEvent.setup();
    readActivePrompt.mockResolvedValue(buildPrompt());

    render(<WordCloudCard eventId={EVENT_ID} eventStatus="live" />);

    const input = await screen.findByRole('textbox');
    // Whitespace-only entry. The submit button is disabled for empty/whitespace,
    // so submit the form directly to exercise the length guard.
    await user.type(input, '   ');
    const form = screen.getByTestId('word-cloud-form') as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    // The 1–50 constraint message is announced...
    expect(await screen.findByRole('alert')).toHaveTextContent(
      WORD_CLOUD_LENGTH_MESSAGE,
    );
    // ...and the entered text is RETAINED (unchanged) so it can be fixed.
    expect(screen.getByRole('textbox')).toHaveValue('   ');
    // The client RPC was never called (client-side guard).
    expect(submitWordCloudResponse).not.toHaveBeenCalled();
  });

  it('submitting a 51-char value shows the 1–50 message and retains the entered text', async () => {
    const user = userEvent.setup();
    readActivePrompt.mockResolvedValue(buildPrompt());

    render(<WordCloudCard eventId={EVENT_ID} eventStatus="live" />);

    const input = await screen.findByRole('textbox');
    const tooLong = 'a'.repeat(51);
    await user.click(input);
    await user.paste(tooLong);

    // Submit the form directly (the button is disabled while over-limit).
    await act(async () => {
      (
        screen.getByTestId('word-cloud-form') as HTMLFormElement
      ).requestSubmit();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      WORD_CLOUD_LENGTH_MESSAGE,
    );
    // Text retained unchanged on the error path.
    expect(screen.getByRole('textbox')).toHaveValue(tooLong);
    expect(submitWordCloudResponse).not.toHaveBeenCalled();
  });
});

describe('WordCloudCard — client normalise preview matches the shared module (Req 6.10)', () => {
  it('shows the preview computed by the real normalise() for "  Hello  World "', async () => {
    const user = userEvent.setup();
    readActivePrompt.mockResolvedValue(buildPrompt());

    render(<WordCloudCard eventId={EVENT_ID} eventStatus="live" />);

    const input = await screen.findByRole('textbox');
    const raw = '  Hello  World ';
    await user.click(input);
    await user.paste(raw);

    // The preview must equal the SHARED normalise() output — not a hand-written
    // string — proving the client preview and the write-path share one contract.
    const expected = normalise(raw); // "hello world"
    expect(expected).toBe('hello world'); // sanity: guards against a rule drift
    const preview = await screen.findByTestId('word-cloud-normalised-preview');
    expect(preview).toHaveTextContent(expected);
  });
});

describe('WordCloudCard — monotonic term sizing (Req 6.11)', () => {
  it('renders the higher-frequency term at a font-size >= the lower-frequency term (real aggregation)', async () => {
    // Results visible while collecting so the aggregated cloud renders.
    readActivePrompt.mockResolvedValue(
      buildPrompt({ results_visible_while_collecting: true }),
    );
    // apple×3, banana×1 — aggregation + sizing are the REAL pure functions, so
    // the sizing is deterministic and monotonic in frequency.
    readVisibleResponses.mockResolvedValue([
      { normalised_text: 'apple', is_hidden: false },
      { normalised_text: 'apple', is_hidden: false },
      { normalised_text: 'apple', is_hidden: false },
      { normalised_text: 'banana', is_hidden: false },
    ]);

    render(<WordCloudCard eventId={EVENT_ID} eventStatus="live" />);

    // The visual cloud renders the sized terms with data-size / fontSize.
    const terms = await screen.findAllByTestId('word-cloud-term');
    expect(terms.length).toBe(2);

    const byTerm = new Map(
      terms.map((el) => [el.getAttribute('data-term'), el]),
    );
    const apple = byTerm.get('apple');
    const banana = byTerm.get('banana');
    expect(apple).toBeDefined();
    expect(banana).toBeDefined();

    const appleSize = Number(apple!.getAttribute('data-size'));
    const bananaSize = Number(banana!.getAttribute('data-size'));

    // Larger frequency ⇒ size NOT smaller (Req 6.11).
    expect(appleSize).toBeGreaterThanOrEqual(bananaSize);
    // For this data the higher frequency is strictly larger.
    expect(appleSize).toBeGreaterThan(bananaSize);

    // The inline font-size mirrors data-size (the visual encoding).
    expect(apple!.style.fontSize).toBe(`${appleSize}px`);
    expect(banana!.style.fontSize).toBe(`${bananaSize}px`);
  });
});

describe('WordCloudCard — no participant identifier reaches the DOM (Req 8.6)', () => {
  it('never renders a participant_identifier even when the prompt carries one', async () => {
    // Results visible + some responses so the widest surface is rendered.
    readActivePrompt.mockResolvedValue(
      buildPrompt({ results_visible_while_collecting: true }),
    );
    readVisibleResponses.mockResolvedValue([
      { normalised_text: 'apple', is_hidden: false },
      { normalised_text: 'banana', is_hidden: false },
    ]);

    const { container } = render(
      <WordCloudCard eventId={EVENT_ID} eventStatus="live" />,
    );

    // The prompt text + terms render...
    expect(await screen.findByText('Describe today in one word')).toBeInTheDocument();
    const visual = await screen.findByTestId('word-cloud-terms');
    expect(within(visual).getByText('apple')).toBeInTheDocument();

    // ...but the sentinel participant identifier is NOWHERE in the DOM.
    expect(container.innerHTML).not.toContain(PARTICIPANT_SENTINEL);
    expect(screen.queryByText(PARTICIPANT_SENTINEL)).toBeNull();
  });
});
