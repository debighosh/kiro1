/**
 * `QuestionSubmissionForm` — audience question submission (Task 15.1).
 *
 * A mobile-first, accessible form that lets a Participant submit a plain-text
 * question (1–300 Unicode code points) to a LIVE event. It delegates the
 * authoritative submission to the rate-limited `submit_question` RPC via the
 * {@link submitQuestion} client helper (task 13.2 / `../lib/questions`); the UI
 * validation here is fast-feedback / defence-in-depth only.
 *
 * Four UX states (Req 24.7):
 *  - **idle**: the empty/ready form with a live character count.
 *  - **submitting**: the submit button is disabled and `aria-busy`; a polite
 *    progress indicator is announced.
 *  - **success**: the field is cleared and an accessible confirmation is shown
 *    (announced via `role="status"`) within ~2 s of submission (Req 3.13).
 *  - **error**: an inline, sanitised message is announced via `role="alert"`.
 *    For an `invalid_length` error the 1–300 constraint message is shown and
 *    the entered text is RETAINED so the participant can fix it (Req 3.2). A
 *    `rate_limited` error shows the friendly "too fast" message; an
 *    `event_not_live` error shows the "submissions are closed" message.
 *
 * Accessibility (Req 24.5):
 *  - The textarea has a programmatically-associated `<label>` (via
 *    `htmlFor`/`id`) exposing a non-empty accessible name, plus an
 *    `aria-describedby` linking the character-count hint and (when present) the
 *    error message. `aria-invalid` is set on the error state.
 *  - The submit button meets the ≥44×44px touch target (`.touch-target`) and is
 *    keyboard-focusable with the global `:focus-visible` ring.
 *
 * Security note: UI gating is defence-in-depth only; the server (the
 * `SECURITY DEFINER` submit RPC with RLS + rate limiting) is the authoritative
 * enforcement point. The participant identifier is opaque and is NEVER rendered
 * (Req 8.6, 24.8) — the form never receives or displays it.
 *
 * Requirements traceability: 3.1, 3.2, 3.13, 22.1, 24.7.
 * Design references: Components (`QuestionSubmissionForm`); Request/data flows
 * (Question submit).
 */
import { useId, useState, type FormEvent } from 'react';
import {
  submitQuestion,
  QuestionError,
  QUESTION_TEXT_MAX,
  QUESTION_LENGTH_MESSAGE,
  countQuestionCodePoints,
  type SubmittedQuestion,
} from '../lib/questions';

/** The four UX states (Req 24.7). */
type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

export interface QuestionSubmissionFormProps {
  /** The id of the (live) event the question is submitted to. */
  readonly eventId: string;
  /**
   * Optional callback invoked with the created question after a successful
   * submission, so a parent (e.g. the question list, task 15.2) can react
   * (e.g. optimistically refresh). Never receives any participant identity.
   */
  readonly onSubmitted?: (question: SubmittedQuestion) => void;
}

/**
 * Maps a caught error to a sanitised, user-facing message. Known
 * {@link QuestionError}s already carry a safe message; anything else falls back
 * to a neutral message that never leaks internals (Req 24.7).
 */
function toDisplayMessage(error: unknown): string {
  if (error instanceof QuestionError) {
    return error.message;
  }
  return 'Your question could not be submitted. Please try again.';
}

export function QuestionSubmissionForm({
  eventId,
  onSubmitted,
}: QuestionSubmissionFormProps): JSX.Element {
  // Stable, unique ids so labels/descriptions associate even with multiple
  // instances (Req 24.5).
  const textareaId = useId();
  const countId = useId();
  const errorId = useId();
  const successId = useId();

  const [text, setText] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isSubmitting = state === 'submitting';
  const isError = state === 'error';

  const codePointCount = countQuestionCodePoints(text);
  // Empty (after trim) is invalid but is NOT surfaced as an over-limit style;
  // the button disabling + on-submit validation handle the empty case.
  const overLimit = codePointCount > QUESTION_TEXT_MAX;
  const trimmedEmpty = text.trim().length === 0;
  // Disable submit for obviously-invalid input (empty/whitespace or >max) and
  // while a request is in flight — the RPC remains the authoritative check.
  const submitDisabled = isSubmitting || trimmedEmpty || overLimit;

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (isSubmitting) return;

    // Client-side length guard (fast feedback, Req 3.2/22.1). Retain the text.
    if (trimmedEmpty || overLimit) {
      setErrorMessage(QUESTION_LENGTH_MESSAGE);
      setState('error');
      return;
    }

    setState('submitting');
    setErrorMessage(null);

    try {
      const question = await submitQuestion({ eventId, text });
      // Success (Req 3.13): clear the field and confirm within ~2 s.
      setText('');
      setState('success');
      onSubmitted?.(question);
    } catch (error) {
      // Error (Req 24.7): show a sanitised inline message. For invalid_length
      // (and any other error) the entered text is RETAINED (Req 3.2) — we never
      // clear `text` on the error path.
      setErrorMessage(toDisplayMessage(error));
      setState('error');
    }
  }

  // Link the textarea to the hint and, when present, the error message.
  const describedBy = [countId, isError && errorMessage ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      noValidate
      aria-busy={isSubmitting}
      data-testid="question-submission-form"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={textareaId} className="font-medium text-ink">
          Ask a question
        </label>
        <textarea
          id={textareaId}
          name="question"
          rows={3}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            // Leaving the error/success state as the participant edits keeps the
            // most recent feedback visible until the next submit; clear only the
            // error so a corrected entry doesn't keep showing a stale message.
            if (state === 'error') {
              setState('idle');
              setErrorMessage(null);
            }
          }}
          disabled={isSubmitting}
          aria-invalid={isError ? true : undefined}
          aria-describedby={describedBy || undefined}
          className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          placeholder="Type your question…"
        />
        {/* Character count / limit hint (Req 24.7 informative state). */}
        <p
          id={countId}
          className={`text-sm ${overLimit ? 'text-ink' : 'text-ink-muted'}`}
        >
          <span data-testid="question-char-count">{codePointCount}</span>
          {' / '}
          {QUESTION_TEXT_MAX} characters
        </p>
      </div>

      {/* Error state (Req 24.7, 3.2): a sanitised message announced to AT. */}
      {isError && errorMessage ? (
        <p id={errorId} role="alert" className="text-ink">
          {errorMessage}
        </p>
      ) : null}

      {/* Success state (Req 24.7, 3.13): confirmation announced to AT. */}
      {state === 'success' ? (
        <p id={successId} role="status" aria-live="polite" className="text-ink">
          Your question was submitted. Thank you!
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitDisabled}
        aria-busy={isSubmitting}
        className="touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60"
      >
        {isSubmitting ? 'Submitting…' : 'Submit question'}
      </button>

      {/* Submitting/loading indicator (Req 24.7): distinct from the button. */}
      {isSubmitting ? (
        <span role="status" aria-live="polite" className="text-ink-muted">
          Submitting your question…
        </span>
      ) : null}
    </form>
  );
}
