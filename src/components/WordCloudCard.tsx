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
 * SCOPE: this card owns BOTH the RESPONSE + client-side normalised PREVIEW
 * surface (task 23.3) AND the aggregated word-cloud VISUALISATION with
 * monotonic sizing + live updates (task 23.4).
 *
 * VISUALISATION (Task 23.4, Req 6.11, 6.13, 6.14, 6.15, 24.5): when the prompt's
 * results are visible to the audience — `results_visible_while_collecting` while
 * `open`, OR a `closed` prompt — the card renders the aggregated live word
 * cloud. Terms come from the PURE `aggregateWordCloud()` (imported from
 * `../lib/wordcloud`), which excludes hidden entries (Req 6.13), excludes
 * configured stop words (Req 6.14), and assigns each term a `size` that is a
 * NON-DECREASING function of frequency (Req 6.11). The visual layout is a
 * lightweight CSS/flexbox sized-term rendering (font-size ∝ each term's `size`);
 * see {@link WordCloudVisualisation} for why d3-cloud is intentionally NOT used.
 * Live updates (Req 6.15) arrive via {@link subscribeToWordCloud} on the
 * event-scoped Broadcast topic and re-render within the 2-second target. An
 * accessible term/frequency text list is always rendered alongside the visual
 * cloud so screen-reader users get the data (Req 24.5).
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
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  aggregateWordCloud,
  normalise,
  type WordCloudTerm,
} from '../lib/wordcloud';
import { isParticipationEligible, type EventStatus } from '../lib/participationGate';
import {
  readActivePrompt,
  readVisibleResponses,
  submitWordCloudResponse,
  subscribeToWordCloud,
  WordCloudClientError,
  WORD_CLOUD_TEXT_MAX,
  WORD_CLOUD_LENGTH_MESSAGE,
  countWordCloudCodePoints,
  type WordCloudPrompt,
  type VisibleWordCloudResponse,
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
  /**
   * Optional stop-word / exclusion-list terms removed from the aggregated
   * visualisation before rendering (Req 6.14). Compared using the SAME
   * `normalise()` as responses (see `aggregateWordCloud`). For M3 this is
   * typically omitted/empty (the `event.stop_words` wiring is a later concern);
   * the prop exists so it is ready to be threaded through.
   */
  readonly stopWords?: readonly string[];
}

/**
 * Renders the aggregated word cloud (Task 23.4).
 *
 * ── Why a CSS sized-term layout instead of d3-cloud ─────────────────────────
 * The design's Technology Stack lists "d3-cloud + a lightweight React wrapper",
 * but d3-cloud performs its layout via CANVAS text measurement, which is not
 * reliably available in a headless/jsdom test environment and adds a native-ish
 * dependency for no behavioural gain here. The property we actually OWN and
 * must guarantee — MONOTONIC SIZING (Req 6.11) — lives entirely in the pure
 * `aggregateWordCloud()` / `sizeForFrequency()` in `src/lib/wordcloud.ts`. So we
 * realise the cloud as a deterministic, canvas-free CSS/flexbox layout where
 * each term's `font-size` is exactly its computed `size`. This satisfies the
 * monotonic-sizing guarantee visibly (larger frequency ⇒ never-smaller text),
 * is testable without canvas, and avoids installing d3-cloud.
 *
 * ── Accessibility (Req 24.5) ────────────────────────────────────────────────
 * The visual cloud is `aria-hidden` (it conveys via size, which AT cannot
 * perceive), and a companion `<ul>` lists every term with its frequency so
 * screen-reader users get the same data. Emphasis is via SIZE + TEXT, never
 * colour alone (Req 24.9).
 */
function WordCloudVisualisation({
  terms,
  emptyMessage,
}: {
  readonly terms: readonly WordCloudTerm[];
  readonly emptyMessage: string;
}): JSX.Element {
  if (terms.length === 0) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-ink-muted"
        data-testid="word-cloud-visual-empty"
      >
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="word-cloud-visual">
      {/*
        Visual cloud: font-size = the term's monotonic `size` (Req 6.11).
        aria-hidden because it conveys meaning via size, which AT cannot read;
        the accessible list below carries the data (Req 24.5).
      */}
      <div
        aria-hidden={true}
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
        data-testid="word-cloud-terms"
      >
        {terms.map((term) => (
          <span
            key={term.term}
            className="font-medium leading-none text-ink"
            style={{ fontSize: `${term.size}px` }}
            data-testid="word-cloud-term"
            data-term={term.term}
            data-frequency={term.frequency}
            data-size={term.size}
          >
            {term.term}
          </span>
        ))}
      </div>

      {/* Accessible term/frequency list (Req 24.5): the AT-perceivable data. */}
      <ul className="sr-only" data-testid="word-cloud-term-list">
        {terms.map((term) => (
          <li key={term.term}>
            {term.term}: {term.frequency}
          </li>
        ))}
      </ul>
    </div>
  );
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
  stopWords,
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

  // The raw VISIBLE responses backing the aggregated cloud (task 23.4). Seeded
  // by the initial read and replaced on each realtime broadcast; fed through the
  // pure `aggregateWordCloud()` so hidden-entry + stop-word exclusion and
  // monotonic sizing live in one place (Req 6.11, 6.13, 6.14).
  const [responses, setResponses] = useState<VisibleWordCloudResponse[]>([]);

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

  // Results visibility (Req 6.15): the aggregated cloud is shown to the audience
  // when the prompt is `closed` (final results) OR while `open` AND the host has
  // enabled `results_visible_while_collecting`. Otherwise a placeholder is shown.
  const resultsVisible =
    prompt !== null &&
    (prompt.status === 'closed' ||
      (prompt.status === 'open' && prompt.results_visible_while_collecting));

  // Initial read of the visible responses whenever the visible prompt changes,
  // so the cloud renders immediately (before any broadcast arrives). Guarded by
  // `resultsVisible` so we never read when results are withheld. A read failure
  // is non-fatal to the response surface: the cloud simply stays empty.
  useEffect(() => {
    if (!resultsVisible || !prompt) {
      setResponses([]);
      return;
    }
    let cancelled = false;
    const promptId = prompt.id;
    void (async () => {
      try {
        const rows = await readVisibleResponses(promptId);
        if (!cancelled) setResponses(rows);
      } catch {
        // Non-fatal: leave the cloud empty; a subsequent broadcast/read may fill it.
        if (!cancelled) setResponses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resultsVisible, prompt]);

  // Live updates (Req 6.15, 23.1, 23.2): subscribe to the event-scoped word-cloud
  // Broadcast topic while results are visible. The broadcast carries the RAW
  // visible { term, frequency } pairs; we map them back into response-like rows
  // (one per occurrence) and let `aggregateWordCloud()` re-apply the SAME
  // normalise()/stop-word exclusion + monotonic sizing client-side — so the
  // broadcast path and the read path share one aggregation contract. This avoids
  // an extra read round-trip on every moderation change.
  useEffect(() => {
    if (!resultsVisible || !prompt) return;
    const promptId = prompt.id;
    const unsubscribe = subscribeToWordCloud(eventId, {
      onWordCloud: (payload) => {
        if (payload.prompt_id !== promptId) return;
        const expanded: VisibleWordCloudResponse[] = [];
        for (const { term, frequency } of payload.terms) {
          const count = Math.max(0, Math.floor(frequency));
          for (let i = 0; i < count; i += 1) {
            expanded.push({ normalised_text: term, is_hidden: false });
          }
        }
        setResponses(expanded);
      },
    });
    return unsubscribe;
  }, [resultsVisible, prompt, eventId]);

  // Aggregate the current responses into monotonically-sized terms (Req 6.11,
  // 6.13, 6.14). Memoised so re-renders don't re-aggregate needlessly.
  const terms = useMemo(
    () => aggregateWordCloud(responses, { stopWords }),
    [responses, stopWords],
  );

  // The shared visualisation node, rendered at whichever mount point applies.
  const visualisation = resultsVisible ? (
    <WordCloudVisualisation
      terms={terms}
      emptyMessage="No responses yet. Be the first to add a word!"
    />
  ) : (
    <p
      role="status"
      aria-live="polite"
      className="text-ink-muted"
      data-testid="word-cloud-results-placeholder"
    >
      Results will appear when the host shares them.
    </p>
  );

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
          MOUNT POINT (task 23.4): the aggregated word-cloud visualisation.
          Shown for a `closed` prompt (final results) here since the input is
          withheld; otherwise the results placeholder. Only rendered when a
          prompt exists.
        */}
        {prompt ? visualisation : null}
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
        MOUNT POINT (task 23.4): the aggregated word-cloud visualisation,
        rendered here below the response form when the prompt is `open` and
        `results_visible_while_collecting` is true; otherwise the results
        placeholder ("Results will appear when the host shares them.").
      */}
      {visualisation}
    </section>
  );
}
