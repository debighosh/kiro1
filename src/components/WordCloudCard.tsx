/**
 * `WordCloudCard` — audience word-cloud RESPONSE surface with live preview
 * (Task 23.3).
 *
 * A mobile-first, accessible card that lets a Participant submit (or update)
 * their single word-cloud response (1–50 Unicode code points) to an OPEN
 * word-cloud prompt on a LIVE event. It delegates the authoritative write to the
 * rate-limited `submit_word_cloud_response` RPC via the
 * {@link submitWordCloudResponse} client helper (task 22.3 /
 * `../lib/wordCloudClient`); the UI validation here is fast-feedback /
 * defence-in-depth only.
 *
 * SCOPE (Task 23.3 ONLY): this is the RESPONSE + client-side normalised PREVIEW
 * surface. It deliberately does NOT render the aggregated word-cloud
 * visualisation — that is task 23.4. A clearly-marked mount point is left below
 * for 23.4 to attach the visualisation.
 *
 * Live normalised preview (Req 6.10): as the participant types, the card shows
 * "will be counted as: <normalised>" using the SAME pure `normalise()` imported
 * from `../lib/wordcloud` that the write path applies on the server, so the
 * participant sees exactly how their entry will be aggregated.
 *
 * Four UX states (Req 24.7):
 *  - **loading**: while the active prompt is being read.
 *  - **empty**: when the event is live but there is no open prompt (or none at
 *    all) — controls are withheld and an informative message is shown.
 *  - **open-input**: the event is live AND the prompt is `open` — the response
 *    input, live normalised preview, and submit/update button are rendered.
 *  - **error**: an inline, sanitised message announced via `role="alert"`. For a
 *    length-validation error the 1–50 constraint message is shown and the
 *    entered text is RETAINED so the participant can fix it (Req 6.8).
 *
 * Gating (Req 2.8, 6.7): participation controls are WITHHELD unless the event is
 * live (via {@link isParticipationEligible}) AND the prompt status is `open`.
 * When the event is not live or the prompt is not open, the input is not
 * rendered.
 *
 * Accessibility (Req 24.5): the text input has a programmatically-associated
 * `<label>` (via `htmlFor`/`id`) exposing a non-empty accessible name, plus an
 * `aria-describedby` linking the count hint, the normalised preview, and (when
 * present) the error message; `aria-invalid` is set on the error state. The
 * submit button meets the ≥44×44px touch target (`.touch-target`).
 *
 * Security note: UI gating is defence-in-depth only; the server (the
 * `SECURITY DEFINER` RPC with RLS + rate limiting) is authoritative. The
 * participant identifier is opaque and is NEVER rendered (Req 8.6, 24.8) — the
 * card never receives or displays it.
 *
 * Requirements traceability: 6.6, 6.7, 6.8, 6.10, 24.7, 2.8.
 * Design references: Components (`WordCloudCard`); Request/data flows (Word
 * cloud).
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { normalise } from '../lib/wordcloud';
import { isParticipationEligible, type EventStatus } from '../lib/participationGate';
import {
  readActivePrompt,
  submitWordCloudResponse,
  WordCloudClientError,
  WORD_CLOUD_TEXT_MAX,
  WORD_CLOUD_LENGTH_MESSAGE,
  countWordCloudCodePoints,
  type WordCloudPrompt,
} from '../lib/wordCloudClient';

/** The lifecycle of loading the active prompt + submitting a response (Req 24.7). */
type CardState = 'loading' | 'ready' | 'error';

export interface WordCloudCardProps {
  /** The id of the event whose active word-cloud prompt to read/respond to. */
  readonly eventId: string;
  /**
   * The event's current lifecycle status, used to gate participation (Req 2.8).
   * When omitted the card assumes the event is live only if a readable prompt is
   * present; passing the status lets the parent withhold controls precisely
   * (e.g. an `ended` event still exposes a `closed` prompt for viewing, but no
   * input). Defaults to `'live'` so a standalone mount on a live audience screen
   * behaves correctly.
   */
  readonly eventStatus?: EventStatus;
  /**
   * Optional callback invoked after a successful submit/update, so a parent
   * (e.g. the visualisation in task 23.4) can react (e.g. refresh aggregates).
   * Never receives any participant identity.
   */
  readonly onResponded?: () => void;
}

/**
 * Maps a caught error to a sanitised, user-facing message. Known
 * {@link WordCloudClientError}s already carry a safe message; anything else
 * falls back to a neutral message that never leaks internals (Req 24.7).
 */
function toDisplayMessage(error: unknown): string {
  if (error instanceof WordCloudClientError) {
    return error.message;
  }
  return 'Your response could not be submitted. Please try again.';
}

export function WordCloudCard({
  eventId,
  eventStatus = 'live',
  onResponded,
}: WordCloudCardProps): JSX.Element {
  // Stable, unique ids so labels/descriptions associate even with multiple
  // instances (Req 24.5).
  const inputId = useId();
  const countId = useId();
  const previewId = useId();
  const errorId = useId();
  const successId = useId();

  const [prompt, setPrompt] = useState<WordCloudPrompt | null>(null);
  const [cardState, setCardState] = useState<CardState>('loading');
  const [text, setText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Load the active prompt for the event. A transport failure surfaces the
  // error state; "no active prompt" is the empty state (prompt === null).
  const loadPrompt = useCallback(async () => {
    setCardState('loading');
    setErrorMessage(null);
    try {
      const active = await readActivePrompt(eventId);
      setPrompt(active);
      setCardState('ready');
    } catch (error) {
      setErrorMessage(toDisplayMessage(error));
      setCardState('error');
    }
  }, [eventId]);

  useEffect(() => {
    void loadPrompt();
  }, [loadPrompt]);

  // Event-status gating (Req 2.8) AND prompt-open gating (Req 6.7): controls are
  // only shown when the event is live and the prompt is open.
  const eventLive = isParticipationEligible(eventStatus);
  const promptOpen = prompt?.status === 'open';
  const inputEnabled = eventLive && promptOpen;

  const codePointCount = countWordCloudCodePoints(text);
  const overLimit = codePointCount > WORD_CLOUD_TEXT_MAX;
  const trimmedEmpty = text.trim().length === 0;
  // Live normalised preview (Req 6.10): compute only when there is content so an
  // empty field does not show an empty "counted as" line.
  const normalisedPreview = trimmedEmpty ? '' : normalise(text);
  const submitDisabled = submitting || trimmedEmpty || overLimit;

  const isError = cardState === 'error';

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (submitting || !prompt) return;

    // Client-side length guard (fast feedback, Req 6.8). RETAIN the text.
    if (trimmedEmpty || overLimit) {
      setErrorMessage(WORD_CLOUD_LENGTH_MESSAGE);
      setCardState('error');
      setSubmitted(false);
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await submitWordCloudResponse(prompt.id, text);
      // Success: keep the entered text so the participant sees their current
      // response and can update it while the prompt is open (Req 6.6).
      setCardState('ready');
      setSubmitted(true);
      onResponded?.();
    } catch (error) {
      // Error (Req 24.7): show a sanitised inline message. For any error the
      // entered text is RETAINED (Req 6.8) — we never clear `text` on error.
      setErrorMessage(toDisplayMessage(error));
      setCardState('error');
      setSubmitted(false);
    } finally {
      setSubmitting(false);
    }
  }

  // ── State: loading ────────────────────────────────────────────────────────
  if (cardState === 'loading') {
    return (
      <section
        className="flex flex-col gap-3"
        data-testid="word-cloud-card"
        aria-busy={true}
      >
        <p role="status" aria-live="polite" className="text-ink-muted">
          Loading the word cloud…
        </p>
      </section>
    );
  }

  // ── State: empty ──────────────────────────────────────────────────────────
  // No prompt at all, or the event is not live / prompt not open → withhold the
  // input controls (Req 2.8, 6.7) and show an informative message.
  if (!prompt || !inputEnabled) {
    const message = !prompt
      ? 'There is no word cloud open right now. Check back soon.'
      : 'This word cloud is not currently accepting responses.';
    return (
      <section className="flex flex-col gap-3" data-testid="word-cloud-card">
        {prompt ? (
          <p className="font-medium text-ink" data-testid="word-cloud-prompt">
            {prompt.prompt_text}
          </p>
        ) : null}
        <p role="status" aria-live="polite" className="text-ink-muted">
          {message}
        </p>

        {/*
          MOUNT POINT (task 23.4): the aggregated word-cloud visualisation is
          rendered here. It may be shown for a `closed` prompt or (when
          `results_visible_while_collecting` is true) while `open`. Task 23.3
          intentionally does NOT render it.
        */}
      </section>
    );
  }

  // ── State: open-input (+ inline error) ──────────────────────────────────────
  // Link the input to the hint, the live preview, and (when present) the error.
  const describedBy = [
    countId,
    normalisedPreview ? previewId : null,
    isError && errorMessage ? errorId : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="flex flex-col gap-3" data-testid="word-cloud-card">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
        aria-busy={submitting}
        data-testid="word-cloud-form"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="font-medium text-ink">
            {prompt.prompt_text}
          </label>
          <input
            id={inputId}
            name="word-cloud-response"
            type="text"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              // Clear a stale error/success as the participant edits so a
              // corrected entry doesn't keep showing an old message.
              if (cardState === 'error') {
                setCardState('ready');
                setErrorMessage(null);
              }
              if (submitted) {
                setSubmitted(false);
              }
            }}
            disabled={submitting}
            aria-invalid={isError ? true : undefined}
            aria-describedby={describedBy || undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
            placeholder="Type a word or short phrase…"
          />
          {/* Character count / limit hint (Req 24.7 informative state). */}
          <p
            id={countId}
            className={`text-sm ${overLimit ? 'text-ink' : 'text-ink-muted'}`}
          >
            <span data-testid="word-cloud-char-count">{codePointCount}</span>
            {' / '}
            {WORD_CLOUD_TEXT_MAX} characters
          </p>
          {/* Live normalised preview (Req 6.10). */}
          {normalisedPreview ? (
            <p id={previewId} className="text-sm text-ink-muted">
              will be counted as:{' '}
              <span className="font-medium text-ink" data-testid="word-cloud-normalised-preview">
                {normalisedPreview}
              </span>
            </p>
          ) : null}
        </div>

        {/* Error state (Req 24.7, 6.8): a sanitised message announced to AT. */}
        {isError && errorMessage ? (
          <p id={errorId} role="alert" className="text-ink">
            {errorMessage}
          </p>
        ) : null}

        {/* Success state (Req 24.7): confirmation announced to AT. */}
        {submitted && !isError ? (
          <p
            id={successId}
            role="status"
            aria-live="polite"
            className="text-ink"
          >
            Your response was recorded. You can update it while the word cloud is
            open.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitDisabled}
          aria-busy={submitting}
          className="touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60"
        >
          {submitting
            ? 'Submitting…'
            : submitted
              ? 'Update response'
              : 'Submit response'}
        </button>

        {/* Submitting/loading indicator (Req 24.7): distinct from the button. */}
        {submitting ? (
          <span role="status" aria-live="polite" className="text-ink-muted">
            Submitting your response…
          </span>
        ) : null}
      </form>

      {/*
        MOUNT POINT (task 23.4): the aggregated word-cloud visualisation is
        rendered here (e.g. when `prompt.results_visible_while_collecting` is
        true while the prompt is open). Task 23.3 is the RESPONSE + preview
        surface only and intentionally does NOT render the visualisation.
      */}
    </section>
  );
}
