/**
 * `/admin/events/:id/exports` — Admin export panel (Task 38.4).
 *
 * An admin-only screen that lets administrators download four event data exports:
 *
 *   1. Questions CSV  — via {@link buildQuestionsCsv} + {@link downloadCsv}
 *   2. Polls CSV      — via {@link buildPollsCsv}     + {@link downloadCsv}
 *   3. Word-cloud CSV — via {@link buildWordCloudCsv} + {@link downloadCsv}
 *   4. Summary (.md)  — via {@link exportEventSummary} (AI gateway + download)
 *
 * ── Data loading (single pass on mount) ──────────────────────────────────────
 * All event data (questions, polls, word-cloud responses) is fetched in a single
 * `useEffect` on mount via the authenticated Supabase browser client. Only
 * non-sensitive, export-permitted columns are read; no `participant_identifier`
 * value is ever fetched or rendered (Req 8.6, 9.5, 24.8).
 *
 * ── Per-button UX states (Req 24.7, 9.6, 9.7) ───────────────────────────────
 * Each export button independently cycles through:
 *   idle        — button enabled
 *   downloading — button disabled + aria-busy
 *   success     — confirmation message (+ no-data notice when isEmpty, Req 9.6)
 *   error       — sanitised error message; no partial download (Req 9.7)
 *
 * ── No-data indication (Req 9.6) ─────────────────────────────────────────────
 * When a CSV builder returns `isEmpty: true`, the download still completes
 * (a header-only CSV is valid) and a visible "no data" notice is shown
 * alongside the success confirmation.
 *
 * ── Failed-export indication (Req 9.7) ───────────────────────────────────────
 * On error, a `role="alert"` message identifies which export failed; no partial
 * file is ever produced (the builders are whole-or-nothing, and the download
 * helpers either complete or throw).
 *
 * ── Accessibility (Req 24.5, 24.7, 24.8) ────────────────────────────────────
 * All buttons carry clear accessible names and `FOCUS_RING`. Error states use
 * `role="alert"`, status messages use `role="status"`. No `participant_identifier`
 * value is ever rendered.
 *
 * Requirements traceability: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 24.7, 25.6.
 * Design references: Frontend Design (Route map — AI config export panel);
 * Components and Interfaces (Export_Service).
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import {
  buildQuestionsCsv,
  buildPollsCsv,
  buildWordCloudCsv,
  type QuestionExportRow,
  type PollExportRow,
} from '../lib/exports';
import type { WordCloudResponseLike } from '../lib/wordcloud';
import { downloadCsv } from '../lib/download';
import { exportEventSummary } from '../lib/summaryExport';
import { cx, FOCUS_RING } from '../lib/a11y';

// Req 24.8: participant_identifier is never fetched, read, or rendered here.

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** The four UX states for each individual export button (Req 24.7). */
type ExportButtonState = 'idle' | 'downloading' | 'success' | 'error';

/** Per-button state for all four exports. */
interface ExportStates {
  questions: ExportButtonState;
  polls: ExportButtonState;
  wordCloud: ExportButtonState;
  summary: ExportButtonState;
}

/** Per-button auxiliary messages (error text, success notice). */
interface ExportMessages {
  questions: string | null;
  polls: string | null;
  wordCloud: string | null;
  summary: string | null;
}

/** Top-level data loading state. */
type DataLoadState = 'loading' | 'ready' | 'error';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const INITIAL_STATES: ExportStates = {
  questions: 'idle',
  polls: 'idle',
  wordCloud: 'idle',
  summary: 'idle',
};

const INITIAL_MESSAGES: ExportMessages = {
  questions: null,
  polls: null,
  wordCloud: null,
  summary: null,
};

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

/**
 * Admin export panel. Fetches all event data on mount and exposes four
 * download controls with independent loading/success/error states.
 */
export function ExportPanel(): JSX.Element {
  const { id: eventId } = useParams();

  // ── Data loading state ───────────────────────────────────────────────────
  const [dataLoadState, setDataLoadState] = useState<DataLoadState>('loading');
  const [dataLoadError, setDataLoadError] = useState<string | null>(null);

  const [questions, setQuestions] = useState<QuestionExportRow[]>([]);
  const [polls, setPolls] = useState<PollExportRow[]>([]);
  const [wordCloudResponses, setWordCloudResponses] = useState<
    WordCloudResponseLike[]
  >([]);

  // ── Per-export button states ─────────────────────────────────────────────
  const [exportStates, setExportStates] =
    useState<ExportStates>(INITIAL_STATES);
  const [exportMessages, setExportMessages] =
    useState<ExportMessages>(INITIAL_MESSAGES);

  // ── Data load on mount ───────────────────────────────────────────────────
  const loadData = useCallback(async (): Promise<void> => {
    if (!eventId) {
      setDataLoadError('No event was specified.');
      setDataLoadState('error');
      return;
    }
    setDataLoadState('loading');
    setDataLoadError(null);

    try {
      // Fetch questions (only exportable statuses; never participant_identifier
      // — Req 8.6, 9.5).
      const [questionsResult, pollsResult, wordCloudResult] = await Promise.all(
        [
          supabase
            .from('questions')
            .select('text, vote_count')
            .eq('event_id', eventId)
            .in('status', ['approved', 'featured', 'answered']),
          supabase
            .from('polls')
            .select('id, question_text, poll_options(text, response_count)')
            .eq('event_id', eventId),
          supabase
            .from('word_cloud_responses')
            .select('normalised_text, is_hidden')
            .eq('event_id', eventId),
        ],
      );

      if (questionsResult.error) throw questionsResult.error;
      if (pollsResult.error) throw pollsResult.error;
      if (wordCloudResult.error) throw wordCloudResult.error;

      // Map questions to export rows.
      const questionRows: QuestionExportRow[] = (
        questionsResult.data ?? []
      ).map((q) => ({
        text: String(q.text ?? ''),
        vote_count: Number(q.vote_count ?? 0),
      }));

      // Map polls to export rows (each poll has nested poll_options).
      const pollRows: PollExportRow[] = (pollsResult.data ?? []).map((p) => ({
        question_text: String(p.question_text ?? ''),
        options: (Array.isArray(p.poll_options) ? p.poll_options : []).map(
          (o: { text: unknown; response_count: unknown }) => ({
            text: String(o.text ?? ''),
            response_count: Number(o.response_count ?? 0),
          }),
        ),
      }));

      // Map word-cloud responses (normalised_text + is_hidden only — Req 8.6, 9.5).
      const wcRows: WordCloudResponseLike[] = (wordCloudResult.data ?? []).map(
        (r) => ({
          normalised_text: String(r.normalised_text ?? ''),
          is_hidden: Boolean(r.is_hidden),
        }),
      );

      setQuestions(questionRows);
      setPolls(pollRows);
      setWordCloudResponses(wcRows);
      setDataLoadState('ready');
    } catch (err) {
      setDataLoadError(
        err instanceof Error
          ? err.message
          : 'Event data could not be loaded. Please try again.',
      );
      setDataLoadState('error');
    }
  }, [eventId]);

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // ── Per-button state helpers ─────────────────────────────────────────────

  function setButtonState(
    key: keyof ExportStates,
    state: ExportButtonState,
    message: string | null = null,
  ): void {
    setExportStates((prev) => ({ ...prev, [key]: state }));
    setExportMessages((prev) => ({ ...prev, [key]: message }));
  }

  // ── Export handlers ──────────────────────────────────────────────────────

  /** Download the questions CSV (Req 9.1, 9.6, 9.7). */
  const handleDownloadQuestions = useCallback(async (): Promise<void> => {
    if (exportStates.questions === 'downloading') return;
    setButtonState('questions', 'downloading');
    try {
      const result = buildQuestionsCsv(questions);
      downloadCsv('questions.csv', result.csv);
      setButtonState(
        'questions',
        'success',
        result.isEmpty ? 'No questions were available for export.' : null,
      );
    } catch (err) {
      setButtonState(
        'questions',
        'error',
        err instanceof Error
          ? err.message
          : 'The questions export failed. Please try again.',
      );
    }
  }, [exportStates.questions, questions]);

  /** Download the polls CSV (Req 9.2, 9.6, 9.7). */
  const handleDownloadPolls = useCallback(async (): Promise<void> => {
    if (exportStates.polls === 'downloading') return;
    setButtonState('polls', 'downloading');
    try {
      const result = buildPollsCsv(polls);
      downloadCsv('polls.csv', result.csv);
      setButtonState(
        'polls',
        'success',
        result.isEmpty ? 'No poll data was available for export.' : null,
      );
    } catch (err) {
      setButtonState(
        'polls',
        'error',
        err instanceof Error
          ? err.message
          : 'The polls export failed. Please try again.',
      );
    }
  }, [exportStates.polls, polls]);

  /** Download the word-cloud CSV (Req 9.3, 9.6, 9.7). */
  const handleDownloadWordCloud = useCallback(async (): Promise<void> => {
    if (exportStates.wordCloud === 'downloading') return;
    setButtonState('wordCloud', 'downloading');
    try {
      const result = buildWordCloudCsv(wordCloudResponses);
      downloadCsv('word-cloud.csv', result.csv);
      setButtonState(
        'wordCloud',
        'success',
        result.isEmpty ? 'No word-cloud data was available for export.' : null,
      );
    } catch (err) {
      setButtonState(
        'wordCloud',
        'error',
        err instanceof Error
          ? err.message
          : 'The word-cloud export failed. Please try again.',
      );
    }
  }, [exportStates.wordCloud, wordCloudResponses]);

  /** Download the event summary (.md) via the AI gateway (Req 9.4, 9.7). */
  const handleDownloadSummary = useCallback(async (): Promise<void> => {
    if (exportStates.summary === 'downloading') return;
    if (!eventId) {
      setButtonState('summary', 'error', 'No event was specified.');
      return;
    }
    setButtonState('summary', 'downloading');
    try {
      const result = await exportEventSummary(eventId);
      if (result.downloaded) {
        const notice = !result.aiInterpretationAvailable
          ? 'The AI interpretation was unavailable; the report contains only calculated data.'
          : null;
        setButtonState('summary', 'success', notice);
      } else if (result.reason === 'ai_unavailable_degraded') {
        // Not an error — AI is disabled/not configured; show the sanitised message.
        setButtonState('summary', 'error', result.unavailable.message);
      } else {
        // export_failed
        setButtonState('summary', 'error', result.message);
      }
    } catch (err) {
      setButtonState(
        'summary',
        'error',
        err instanceof Error
          ? err.message
          : 'The summary export failed. Please try again.',
      );
    }
  }, [eventId, exportStates.summary]);

  // ── LOADING state (Req 24.7) ─────────────────────────────────────────────
  if (dataLoadState === 'loading') {
    return (
      <main className="app-container py-8">
        <h1 className="text-2xl font-semibold text-ink">Export event data</h1>
        <p role="status" aria-live="polite" className="mt-4 text-ink-muted">
          ⏳ Loading event data…
        </p>
      </main>
    );
  }

  // ── ERROR (load) state (Req 24.7) ────────────────────────────────────────
  if (dataLoadState === 'error') {
    return (
      <main className="app-container py-8">
        <h1 className="text-2xl font-semibold text-ink">Export event data</h1>
        <p role="alert" className="mt-4 text-ink">
          ✕ {dataLoadError}
        </p>
        <button
          type="button"
          onClick={() => void loadData()}
          className={cx(
            'touch-target mt-4 rounded bg-focus px-4 py-2 font-medium text-surface',
            FOCUS_RING,
          )}
        >
          Retry
        </button>
      </main>
    );
  }

  // ── READY state — show all four export buttons ───────────────────────────
  return (
    <main className="app-container py-8">
      <h1 className="text-2xl font-semibold text-ink">Export event data</h1>
      <p className="mt-2 text-ink-muted">
        Download event data as CSV files or as a Markdown summary report. No
        participant identifiers are included in any export.
      </p>

      <div className="mt-6 flex flex-col gap-6">
        {/* ── Questions CSV (Req 9.1) ─────────────────────────────────── */}
        <ExportRow
          label="Questions CSV"
          description="Approved, featured, and answered questions with vote counts."
          buttonLabel="Download Questions CSV"
          state={exportStates.questions}
          message={exportMessages.questions}
          onDownload={() => void handleDownloadQuestions()}
        />

        {/* ── Polls CSV (Req 9.2) ─────────────────────────────────────── */}
        <ExportRow
          label="Polls CSV"
          description="Poll questions with option texts and response counts."
          buttonLabel="Download Polls CSV"
          state={exportStates.polls}
          message={exportMessages.polls}
          onDownload={() => void handleDownloadPolls()}
        />

        {/* ── Word-cloud CSV (Req 9.3) ─────────────────────────────────── */}
        <ExportRow
          label="Word-cloud CSV"
          description="Distinct normalised words with their frequency counts."
          buttonLabel="Download Word Cloud CSV"
          state={exportStates.wordCloud}
          message={exportMessages.wordCloud}
          onDownload={() => void handleDownloadWordCloud()}
        />

        {/* ── Summary (.md) (Req 9.4) ─────────────────────────────────── */}
        <ExportRow
          label="Event summary"
          description="End-of-event Markdown summary including calculated data and AI interpretation (when available)."
          buttonLabel="Download Summary (.md)"
          state={exportStates.summary}
          message={exportMessages.summary}
          onDownload={() => void handleDownloadSummary()}
        />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: ExportRow
// ---------------------------------------------------------------------------

/**
 * A single export row with a label, description, download button, and per-state
 * feedback. Accessible: button has an explicit label, error uses `role="alert"`,
 * status messages use `role="status"`, FOCUS_RING on the button (Req 24.5).
 */
function ExportRow({
  label,
  description,
  buttonLabel,
  state,
  message,
  onDownload,
}: {
  label: string;
  description: string;
  buttonLabel: string;
  state: ExportButtonState;
  message: string | null;
  onDownload: () => void;
}): JSX.Element {
  const isDownloading = state === 'downloading';

  return (
    <div className="rounded border border-ink-muted bg-surface p-4">
      <p className="font-medium text-ink">{label}</p>
      <p className="mt-1 text-sm text-ink-muted">{description}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onDownload}
          disabled={isDownloading}
          aria-busy={isDownloading || undefined}
          className={cx(
            'touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60',
            FOCUS_RING,
          )}
        >
          {isDownloading ? 'Downloading…' : buttonLabel}
        </button>

        {/* Downloading state message (role="status" for polite announcement) */}
        {isDownloading ? (
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-ink-muted"
          >
            Preparing download…
          </p>
        ) : null}

        {/* Success state — confirmation + optional no-data notice (Req 9.6) */}
        {state === 'success' ? (
          <div className="flex flex-col gap-1">
            <p role="status" aria-live="polite" className="text-sm text-ink">
              ✓ Download complete.
            </p>
            {message ? (
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-ink-muted"
              >
                ∅ {message}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Error state — sanitised failure message, no partial download (Req 9.7) */}
        {state === 'error' && message ? (
          <p role="alert" className="text-sm text-ink">
            ✕ {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default ExportPanel;
