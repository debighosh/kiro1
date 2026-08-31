import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AiClientError,
  runSummary,
  type EventSummary,
  type SummaryResponse,
} from '../lib/aiClient';

/**
 * `/admin/events/:id/summary` — the admin-only end-of-event summary screen
 * (Task 34.4).
 *
 * An administrator triggers the end-of-event summary JOB (task 33.1, wired into
 * the `ai-gateway` Edge Function) for the current event via
 * {@link runSummary}, and this screen renders the returned Markdown report.
 *
 * ── ALWAYS-produced calculated report (Req 18.1, 18.4, 18.7) ─────────────────
 * The gateway ALWAYS computes the "## Calculated Data" section directly from the
 * database, independently of the AI model, and returns it as part of the
 * Markdown even when the AI interpretation is unavailable. The separate
 * "## AI Interpretation" section carries the AI-Generated content, OR — when the
 * AI was unavailable/failed — a visible "AI content could not be produced"
 * notice (Req 18.7). Both section headings are part of the Markdown string, so
 * they appear in the rendered text.
 *
 * ── Rendered as INERT plain text (Req 14.8) ──────────────────────────────────
 * The Markdown report is rendered LITERALLY as plain text inside a
 * whitespace-preserving `<pre>` block — it is NEVER parsed or executed as HTML
 * or script. No Markdown-to-HTML library is used, so there is no HTML/script
 * execution surface: the report is displayed exactly as the (already plain-text
 * escaped, server-side) Markdown string.
 *
 * ── AI-unavailable banner (Req 18.7) ─────────────────────────────────────────
 * When `aiInterpretationAvailable` is `false`, the report already contains the
 * calculated sections + the in-report unavailable notice; this screen
 * ADDITIONALLY surfaces a prominent `role="status"` banner so the reader knows
 * up front that the AI interpretation could not be produced (the calculated data
 * remains fully valid and unaffected).
 *
 * ── Degraded / AI-not-enabled (Req 19.1) ─────────────────────────────────────
 * When AI is disabled / not configured / a credential is required, the gateway
 * returns a degraded state BEFORE any report; this screen shows the sanitised
 * "AI unavailable" message. This is a normal, non-error state — the rest of the
 * app is unaffected.
 *
 * Four UX states + accessibility mirror the sibling admin screens
 * ({@link import('./AiSettings').AiSettings},
 * {@link import('./ModerationQueue').ModerationQueue}; Req 24.7, 25.4):
 * `.app-container` mobile-first layout, `.touch-target` controls, a labelled
 * trigger, `role="status"` for progress/results and `role="alert"` for errors.
 *
 * Requirements traceability: 18.1, 18.4, 18.7, 14.8, 25.4.
 * Design: Server-Side AI Gateway Design (AI features — End-of-event summary);
 * Frontend Design (Protected-route strategy).
 */

/** The four UX states of the summary trigger (Req 24.7). */
type SummaryStatus = 'idle' | 'generating' | 'done' | 'error';

export function AiSummary(): JSX.Element {
  const { id: eventId } = useParams();

  const [status, setStatus] = useState<SummaryStatus>('idle');
  const [response, setResponse] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (status === 'generating') return;
    if (!eventId) {
      setError('No event was specified.');
      setStatus('error');
      return;
    }
    setStatus('generating');
    setError(null);
    setResponse(null);
    try {
      const result = await runSummary(eventId);
      setResponse(result);
      setStatus('done');
    } catch (err) {
      setError(
        err instanceof AiClientError
          ? err.message
          : 'The summary could not be generated. Please try again.',
      );
      setStatus('error');
    }
  }, [eventId, status]);

  const isGenerating = status === 'generating';
  // The successful, AI-available summary (when present) for concise branching.
  const summary: EventSummary | null =
    status === 'done' && response?.available ? response.summary : null;
  const unavailable =
    status === 'done' && response && !response.available
      ? response.unavailable
      : null;

  return (
    <main className="app-container py-8">
      <h1 className="text-2xl font-semibold text-ink">End-of-event summary</h1>
      <p className="mt-2 text-ink-muted">
        Generate the end-of-event summary for this event. The calculated data is
        computed directly from the database; the AI interpretation is a separate,
        clearly-labelled section that is produced only when AI is available.
      </p>

      <button
        type="button"
        onClick={() => void handleGenerate()}
        disabled={isGenerating}
        aria-busy={isGenerating}
        className="touch-target mt-4 rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60"
      >
        {isGenerating ? 'Generating…' : 'Generate summary'}
      </button>

      {/* GENERATING state (Req 24.7). */}
      {isGenerating ? (
        <p role="status" aria-live="polite" className="mt-4 text-ink-muted">
          Generating the end-of-event summary…
        </p>
      ) : null}

      {/* ERROR state (Req 24.7). */}
      {status === 'error' && error ? (
        <p role="alert" className="mt-4 text-ink">
          {error}
        </p>
      ) : null}

      {/* DONE — degraded (AI not enabled/configured; Req 19.1). */}
      {unavailable ? (
        <p role="status" aria-live="polite" className="mt-4 text-ink">
          {unavailable.message}
        </p>
      ) : null}

      {/* DONE — the summary report (always contains the calculated sections). */}
      {summary ? (
        <section aria-label="End-of-event summary report" className="mt-6">
          {/* Prominent AI-unavailable banner (Req 18.7). The report itself
              already carries the in-report notice; this surfaces it up front. */}
          {!summary.aiInterpretationAvailable ? (
            <p
              role="status"
              aria-live="polite"
              className="rounded border border-ink-muted bg-surface p-3 text-ink"
            >
              <strong>AI interpretation unavailable.</strong> The AI-generated
              interpretation could not be produced. All calculated data below is
              computed directly from the database and is unaffected.
            </p>
          ) : null}

          <p className="mt-3 text-ink-muted">
            {summary.questionCount} question(s) were considered for this summary.
          </p>

          {/*
            Req 14.8 — the report is rendered as INERT plain text: the raw
            Markdown string is displayed LITERALLY in a whitespace-preserving
            block, never parsed or executed as HTML/script. The "## Calculated
            Data" and "## AI Interpretation" headings are part of the Markdown
            string, so they appear here as text.
          */}
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded border border-ink-muted bg-surface p-4 text-ink">
            {summary.markdown}
          </pre>
        </section>
      ) : null}
    </main>
  );
}

export default AiSummary;
