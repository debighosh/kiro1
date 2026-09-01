/**
 * End-of-event Markdown summary EXPORT PATH: the reusable, framework-agnostic
 * function that turns the M4 end-of-event summary job into a downloaded `.md`
 * file.
 *
 * =============================================================================
 * WHY A SEPARATE MODULE (not part of the pure `./exports`)
 * =============================================================================
 * The per-type CSV builders in {@link ./exports} are STRICTLY PURE — no React,
 * zod, Supabase, network, or Deno dependency, no I/O. This module is different
 * on BOTH axes and therefore MUST NOT be folded into `./exports`:
 *
 *   1. it depends on the browser AI client {@link runSummary} (a NETWORK call
 *      through the `ai-gateway` Edge Function), and
 *   2. it performs a DOM DOWNLOAD via {@link downloadMarkdown}.
 *
 * Keeping it out of `./exports` preserves that module's purity guarantee (no
 * `aiClient`/network import ever leaks into it). This module is the reusable
 * EXPORT PATH; it does NOT build any UI (the summary-export panel — task 38.4 —
 * calls {@link exportEventSummary} and renders its outcome).
 *
 * =============================================================================
 * THREE DISTINCT OUTCOMES — DESIGNED CONTRACT
 * =============================================================================
 * The end-of-event summary job has three materially different outcomes, and
 * this function surfaces each one distinctly so the caller can render the right
 * message. It is CRITICAL not to conflate the middle two:
 *
 *  (A) Report produced — download it.
 *      `runSummary` returns `available: true`. The gateway ALWAYS computes the
 *      "Calculated Data" sections directly from the database (Req 18.4). The
 *      Markdown ALREADY embeds the visible AI-unavailable notice in place of the
 *      AI Interpretation when the model was unavailable/failed
 *      (`aiInterpretationAvailable === false`, Req 18.7). Either way there is a
 *      complete, valid report, so we DOWNLOAD it as a `.md` file (Req 9.4) and
 *      return `{ downloaded: true, aiInterpretationAvailable }`. The caller uses
 *      the flag to optionally note "AI interpretation was unavailable" — this is
 *      the IN-REPORT AI-unavailable case, and it is STILL a successful export.
 *
 *  (B) Degraded PRECONDITION — nothing to download.
 *      `runSummary` returns `available: false`. This is the ENABLEMENT-precondition
 *      path (AI disabled / not configured / credential required) that fires
 *      BEFORE any report is generated (Req 19.1). There is NO Markdown to
 *      download. This is deliberately DISTINCT from case (A)'s in-report notice:
 *      in (A) the job ran and produced the calculated report; in (B) the job did
 *      not run. We return a NON-download result
 *      `{ downloaded: false, reason: 'ai_unavailable_degraded', unavailable }`
 *      carrying the sanitised reason/message so the caller can explain that the
 *      summary was not generated because AI is not enabled (no file is a correct,
 *      non-error outcome here — the caller shows the message, not a failure).
 *
 *  (C) Export FAILED — no partial file (Req 9.7).
 *      `runSummary` THROWS an {@link AiClientError} (a recoverable failure that
 *      prevented even the calculated report — e.g. the event could not be
 *      resolved, an auth/transport failure, or a malformed payload). We deliver
 *      NO file (nothing was downloaded — Req 9.7) and return a typed failure
 *      `{ downloaded: false, reason: 'export_failed', exportType: 'summary', message }`
 *      that IDENTIFIES the failed export type ('summary') and carries a
 *      sanitised message, so the caller surfaces "the summary export failed"
 *      (Req 9.7). We CATCH-AND-CLASSIFY rather than rethrow so every non-download
 *      outcome is a single, uniformly-shaped result the panel can switch on;
 *      unexpected non-`AiClientError` throwables are still normalised to this
 *      failure shape with a generic sanitised message (never leaking internals).
 *
 * Requirements traceability: 9.4 (Markdown summary file), 18.1 (report content
 * is produced by the job), 18.7 (in-report AI-unavailable notice is downloaded
 * with the calculated data), 9.7 (failed export: no partial file + identify the
 * failed export type).
 * Design references: Server-Side AI Gateway Design (AI features — End-of-event
 * summary); Components and Interfaces (Export_Service — Markdown summary).
 */

import { AiClientError, runSummary, type AiUnavailable } from './aiClient';
import { downloadMarkdown } from './download';

// ----------------------------------------------------------------------------
// Constants.
// ----------------------------------------------------------------------------

/**
 * The default file name for the downloaded summary (a `.md` extension is
 * ensured by {@link downloadMarkdown}). Callers may override via
 * {@link ExportEventSummaryOptions.filename}; when they do not, a stable,
 * human-friendly name is used.
 */
export const DEFAULT_SUMMARY_FILENAME = 'livepulse-summary.md' as const;

/**
 * The export-type identifier surfaced on a failed export (Req 9.7). There is a
 * single Markdown export type — the end-of-event summary — so this is a literal.
 */
export const SUMMARY_EXPORT_TYPE = 'summary' as const;

// ----------------------------------------------------------------------------
// Options.
// ----------------------------------------------------------------------------

/** Options for {@link exportEventSummary}. */
export interface ExportEventSummaryOptions {
  /**
   * Overrides the downloaded file name. When omitted,
   * {@link DEFAULT_SUMMARY_FILENAME} is used. A `.md` extension is always
   * ensured (see {@link downloadMarkdown}), so a name without one is fine.
   */
  readonly filename?: string;
}

// ----------------------------------------------------------------------------
// Result contract.
// ----------------------------------------------------------------------------

/**
 * Outcome (A) — the Markdown report was produced and DOWNLOADED (Req 9.4).
 *
 * `aiInterpretationAvailable` mirrors {@link EventSummary.aiInterpretationAvailable}:
 * `false` means the downloaded report contains the visible in-report
 * AI-unavailable notice in place of the AI Interpretation, while ALL calculated
 * data is present and valid (Req 18.7). Either value is a SUCCESSFUL export.
 */
export interface SummaryExportDownloaded {
  readonly downloaded: true;
  readonly aiInterpretationAvailable: boolean;
}

/**
 * Outcome (B) — degraded ENABLEMENT precondition: AI is disabled / not
 * configured / a credential is required, so the job did not run and there is no
 * report to download (Req 19.1). Distinct from the in-report AI-unavailable
 * notice of outcome (A). Not an error — the caller surfaces `unavailable.message`.
 */
export interface SummaryExportDegraded {
  readonly downloaded: false;
  readonly reason: 'ai_unavailable_degraded';
  /** The sanitised degraded state (reason + user-safe message) (Req 19.1). */
  readonly unavailable: AiUnavailable;
}

/**
 * Outcome (C) — the export FAILED before any file could be produced (Req 9.7).
 * NO file was downloaded (no partial file). Carries the failed
 * {@link SummaryExportFailed.exportType | export type} ('summary') so the caller
 * can identify it, plus a sanitised, user-safe `message`.
 */
export interface SummaryExportFailed {
  readonly downloaded: false;
  readonly reason: 'export_failed';
  /** Identifies the failed export type to the caller (Req 9.7). */
  readonly exportType: typeof SUMMARY_EXPORT_TYPE;
  /** A sanitised, user-safe failure message (never leaks internals). */
  readonly message: string;
}

/**
 * The full result of {@link exportEventSummary}: exactly one of the three
 * designed outcomes. Discriminate first on `downloaded`; when `false`,
 * discriminate on `reason` to distinguish the degraded precondition (B) from a
 * failed export (C).
 */
export type ExportEventSummaryResult =
  SummaryExportDownloaded | SummaryExportDegraded | SummaryExportFailed;

/** A generic sanitised failure message used when no better one is available. */
const GENERIC_SUMMARY_EXPORT_FAILURE =
  'The summary export could not be completed. Please try again.';

// ----------------------------------------------------------------------------
// Export path.
// ----------------------------------------------------------------------------

/**
 * Runs the end-of-event summary job for `eventId` (via {@link runSummary}) and,
 * when a report is produced, DOWNLOADS it as a `.md` file (Req 9.4). Returns one
 * of the three designed {@link ExportEventSummaryResult} outcomes (see the
 * module header for the full rationale):
 *
 *  - (A) `{ downloaded: true, aiInterpretationAvailable }` — the report (which
 *    always contains the calculated data, and the in-report AI-unavailable
 *    notice when `aiInterpretationAvailable === false` — Req 18.7) was
 *    downloaded. STILL a success when the interpretation was unavailable.
 *  - (B) `{ downloaded: false, reason: 'ai_unavailable_degraded', unavailable }`
 *    — AI was not enabled/configured, so no report was generated (Req 19.1).
 *    Nothing downloaded; the caller surfaces `unavailable.message`.
 *  - (C) `{ downloaded: false, reason: 'export_failed', exportType: 'summary',
 *    message }` — the job failed before producing a report; NO partial file was
 *    produced and the failed export type is identified (Req 9.7).
 *
 * This function CATCHES the failure path (does not rethrow) so the caller has a
 * single, uniformly-shaped result to switch on; the DOM download itself is the
 * only remaining throw surface, and it only occurs after `runSummary` has
 * already succeeded — a download failure in a real browser is not expected, and
 * if the DOM APIs are unavailable it too is normalised to outcome (C).
 *
 * @param eventId the event to summarise and export.
 * @param opts optional overrides (see {@link ExportEventSummaryOptions}).
 * @returns the {@link ExportEventSummaryResult}. Never throws.
 */
export async function exportEventSummary(
  eventId: string,
  opts?: ExportEventSummaryOptions,
): Promise<ExportEventSummaryResult> {
  const filename = opts?.filename ?? DEFAULT_SUMMARY_FILENAME;

  let response;
  try {
    response = await runSummary(eventId);
  } catch (err) {
    // Outcome (C): the job failed before any calculated report — no file is
    // produced (no partial file — Req 9.7) and the failed export type is
    // identified so the caller can surface "the summary export failed".
    return {
      downloaded: false,
      reason: 'export_failed',
      exportType: SUMMARY_EXPORT_TYPE,
      message:
        err instanceof AiClientError
          ? err.message
          : GENERIC_SUMMARY_EXPORT_FAILURE,
    };
  }

  // Outcome (B): degraded ENABLEMENT precondition — the job did not run, so
  // there is no Markdown to download (Req 19.1). Distinct from (A)'s in-report
  // notice: here no calculated report exists.
  if (!response.available) {
    return {
      downloaded: false,
      reason: 'ai_unavailable_degraded',
      unavailable: response.unavailable,
    };
  }

  // Outcome (A): a complete report exists. Its Markdown already embeds the
  // calculated data and — when `aiInterpretationAvailable === false` — the
  // visible in-report AI-unavailable notice (Req 18.7). We STILL download the
  // calculated-only report (Req 9.4).
  try {
    downloadMarkdown(filename, response.summary.markdown);
  } catch (err) {
    // The report was produced but the browser download could not be delivered
    // (e.g. DOM APIs unavailable). No file reached the user — treat as a failed
    // export with no partial file (Req 9.7).
    return {
      downloaded: false,
      reason: 'export_failed',
      exportType: SUMMARY_EXPORT_TYPE,
      message:
        err instanceof Error && err.message
          ? err.message
          : GENERIC_SUMMARY_EXPORT_FAILURE,
    };
  }

  return {
    downloaded: true,
    aiInterpretationAvailable: response.summary.aiInterpretationAvailable,
  };
}
