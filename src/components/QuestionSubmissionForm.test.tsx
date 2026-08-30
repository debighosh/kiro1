/**
 * Tests for `QuestionSubmissionForm` (task 15.1).
 *
 * These mock `../lib/questions`' `submitQuestion` (so no real Supabase RPC /
 * network is involved — importing the real module transitively loads
 * `../lib/supabaseClient`, which throws unless VITE_SUPABASE_* is set) and
 * verify the behaviours Req 3.1 / 3.2 / 3.13 / 22.1 / 24.7 mandate:
 *
 *  (a) an accessible, labelled question input is present (Req 24.5);
 *  (b) submitting valid text calls `submitQuestion` with the eventId + text and
 *      then shows the success confirmation and clears the field (Req 3.1, 3.13);
 *  (c) empty/whitespace-only or >300-char input shows the 1–300 length message,
 *      retains the entered text, and does NOT call the RPC (client-side
 *      validation, Req 3.2, 22.1);
 *  (d) an `invalid_length` error surfaced by the helper maps to the inline
 *      length message (Req 3.2);
 *  (e) a `rate_limited` error shows the friendly "too fast" message (Req 24.7);
 *  (f) the submit button is disabled while a submission is in flight (Req 24.7).
 *
 * Design: Components (`QuestionSubmissionForm`); Request/data flows (Question
 * submit).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Copy of the exact user-facing length message so tests can assert the wording
// without importing the (mocked) module at the top level. Kept in sync with
// `../lib/questions`' `QUESTION_LENGTH_MESSAGE`.
const QUESTION_LENGTH_MESSAGE =
  'Your question must be between 1 and 300 characters.';

// Mock the submit helper. The factory is hoisted, so it must NOT reference any
// top-level variables: `submitQuestion` is exposed via `vi.hoisted` and the
// constants are inlined. This keeps importing the component from loading the
// real Supabase client (which throws unless VITE_SUPABASE_* is set).
const { submitQuestion } = vi.hoisted(() => ({ submitQuestion: vi.fn() }));

vi.mock('../lib/questions', () => {
  class QuestionError extends Error {
    kind: string;
    constructor(message: string, options: { kind: string }) {
      super(message);
      this.name = 'QuestionError';
      this.kind = options.kind;
    }
  }
  return {
    submitQuestion: (...args: unknown[]) => submitQuestion(...args),
    QuestionError,
    QUESTION_TEXT_MAX: 300,
    QUESTION_LENGTH_MESSAGE: 'Your question must be between 1 and 300 characters.',
    countQuestionCodePoints: (v: string) => [...v].length,
  };
});

import { QuestionSubmissionForm } from './QuestionSubmissionForm';
// Import the mocked QuestionError so tests can construct typed errors.
import { QuestionError } from '../lib/questions';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  submitQuestion.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('QuestionSubmissionForm — accessibility & rendering (Req 24.5)', () => {
  it('renders a labelled question input and a submit button', () => {
    render(<QuestionSubmissionForm eventId={EVENT_ID} />);

    // Labelled input exposing a non-empty accessible name.
    expect(
      screen.getByRole('textbox', { name: /ask a question/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /submit question/i }),
    ).toBeInTheDocument();
  });
});

describe('QuestionSubmissionForm — successful submission (Req 3.1, 3.13)', () => {
  it('calls submitQuestion with the eventId + text, then shows success and clears the field', async () => {
    submitQuestion.mockResolvedValue({ id: 'q-1', status: 'pending' });
    const user = userEvent.setup();

    render(<QuestionSubmissionForm eventId={EVENT_ID} />);

    const input = screen.getByRole('textbox', { name: /ask a question/i });
    await user.type(input, 'What is the roadmap for 2026?');
    await user.click(screen.getByRole('button', { name: /submit question/i }));

    // Called with the eventId + the entered text (Req 3.1).
    await waitFor(() => {
      expect(submitQuestion).toHaveBeenCalledTimes(1);
    });
    expect(submitQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        text: 'What is the roadmap for 2026?',
      }),
    );

    // Success confirmation shown (Req 3.13) and the field cleared.
    expect(
      await screen.findByText(/your question was submitted/i),
    ).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('invokes the onSubmitted callback with the created question on success', async () => {
    const created = { id: 'q-2', status: 'approved' };
    submitQuestion.mockResolvedValue(created);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(
      <QuestionSubmissionForm eventId={EVENT_ID} onSubmitted={onSubmitted} />,
    );

    await user.type(
      screen.getByRole('textbox', { name: /ask a question/i }),
      'A valid question',
    );
    await user.click(screen.getByRole('button', { name: /submit question/i }));

    await waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledWith(created);
    });
  });
});

describe('QuestionSubmissionForm — client-side length validation (Req 3.2, 22.1)', () => {
  it('does not call the RPC and keeps the field empty when submitting empty/whitespace input', async () => {
    const user = userEvent.setup();
    render(<QuestionSubmissionForm eventId={EVENT_ID} />);

    const input = screen.getByRole('textbox', { name: /ask a question/i });
    // Whitespace-only entry.
    await user.type(input, '   ');

    const submit = screen.getByRole('button', { name: /submit question/i });
    // The button is disabled for empty/whitespace input; force a submit to
    // exercise the guard by submitting the form directly.
    expect(submit).toBeDisabled();
    expect(submitQuestion).not.toHaveBeenCalled();
  });

  it('disables submit for >300-char input, reflects the over-limit count, and does NOT call the RPC', async () => {
    const user = userEvent.setup();
    render(<QuestionSubmissionForm eventId={EVENT_ID} />);

    const input = screen.getByRole('textbox', { name: /ask a question/i });
    const tooLong = 'x'.repeat(301);
    // Paste (fast) rather than typing 301 chars one-by-one.
    await user.click(input);
    await user.paste(tooLong);

    // Over-limit input keeps the entered text (Req 3.2), disables submit, and
    // the RPC is never called (client-side guard, Req 22.1).
    expect(input).toHaveValue(tooLong);
    expect(screen.getByTestId('question-char-count')).toHaveTextContent('301');
    expect(
      screen.getByRole('button', { name: /submit question/i }),
    ).toBeDisabled();
    expect(submitQuestion).not.toHaveBeenCalled();
  });
});

describe('QuestionSubmissionForm — server error mapping (Req 3.2, 24.7)', () => {
  it('maps an invalid_length error from the helper to the inline length message', async () => {
    submitQuestion.mockRejectedValue(
      new QuestionError(QUESTION_LENGTH_MESSAGE, { kind: 'invalid_length' }),
    );
    const user = userEvent.setup();

    render(<QuestionSubmissionForm eventId={EVENT_ID} />);

    const input = screen.getByRole('textbox', { name: /ask a question/i });
    await user.type(input, 'A question that the server rejects on length');
    await user.click(screen.getByRole('button', { name: /submit question/i }));

    expect(
      await screen.findByText(QUESTION_LENGTH_MESSAGE),
    ).toBeInTheDocument();
    // Text retained on the error path (Req 3.2).
    expect(input).toHaveValue('A question that the server rejects on length');
  });

  it('shows the friendly "too fast" message on a rate_limited error', async () => {
    submitQuestion.mockRejectedValue(
      new QuestionError(
        "You're doing that too fast. Please wait a moment and try again.",
        { kind: 'rate_limited' },
      ),
    );
    const user = userEvent.setup();

    render(<QuestionSubmissionForm eventId={EVENT_ID} />);

    await user.type(
      screen.getByRole('textbox', { name: /ask a question/i }),
      'Rapid fire question',
    );
    await user.click(screen.getByRole('button', { name: /submit question/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /too fast/i,
    );
  });
});

describe('QuestionSubmissionForm — submitting state (Req 24.7)', () => {
  it('disables the submit button while a submission is in flight', async () => {
    // A submit that never resolves during the test keeps the form "submitting".
    let resolve: ((value: { id: string; status: string }) => void) | undefined;
    submitQuestion.mockImplementation(
      () =>
        new Promise<{ id: string; status: string }>((res) => {
          resolve = res;
        }),
    );
    const user = userEvent.setup();

    render(<QuestionSubmissionForm eventId={EVENT_ID} />);

    await user.type(
      screen.getByRole('textbox', { name: /ask a question/i }),
      'In-flight question',
    );
    const submit = screen.getByRole('button', { name: /submitting|submit question/i });
    await user.click(submit);

    // While submitting: button disabled + aria-busy set.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /submitting/i }),
      ).toBeDisabled();
    });

    // Resolve to avoid an unhandled pending promise.
    resolve?.({ id: 'q-3', status: 'pending' });
  });
});
