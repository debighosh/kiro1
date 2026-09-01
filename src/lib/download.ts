/**
 * Browser file-download helpers: turn an in-memory text document into a
 * user-initiated file download.
 *
 * =============================================================================
 * THIS MODULE PERFORMS I/O — IT IS NOT PURE
 * =============================================================================
 * Unlike the strictly PURE serialisation/assembly modules {@link ./csv} and
 * {@link ./exports} (which only compute strings and never reach outside
 * themselves), this module is deliberately IMPURE: it touches the DOM. It
 * constructs a {@link Blob}, allocates an object URL via
 * `URL.createObjectURL`, creates a transient `<a download>` element, programmatically
 * clicks it to trigger the browser's Save dialog, and then revokes the object
 * URL to release memory. That side-effecting DOM interaction is the WHOLE point
 * of the module and is the reason it lives separately from the pure export
 * builders — the pure builders construct the document; this module hands the
 * finished document to the browser (Req 9.4). It has NO React, zod, Supabase,
 * network, or Deno dependency; its only ambient dependency is the DOM.
 *
 * ── Non-DOM / SSR environments (documented choice) ──────────────────────────
 * A download is meaningless outside a browser document (server-side rendering,
 * a unit-test runner without a DOM, a web worker without `document`). Rather
 * than silently no-op — which would hide a real programming error and leave a
 * caller believing a file was delivered when it was not — {@link downloadTextFile}
 * THROWS a typed {@link DownloadUnavailableError} when the required DOM APIs
 * (`document`, `URL.createObjectURL`, `URL.revokeObjectURL`) are unavailable.
 * Callers that legitimately run in such environments must guard with
 * {@link isDownloadSupported} first. The throw-not-noop choice keeps the
 * "a download either happens or the caller learns it did not" contract explicit
 * and mirrors the whole-or-nothing posture of the export pipeline (Req 9.7).
 *
 * ── Whole-or-nothing (Req 9.7) ──────────────────────────────────────────────
 * The full document string is constructed by the (pure) caller BEFORE this
 * module is invoked, so there is no streaming/partial-write path here: either
 * the complete Blob is handed to the browser, or an error is thrown before any
 * download begins. This module never produces a partial file.
 *
 * Requirements traceability: 9.4 (Markdown summary download), 9.7 (no partial
 * file / whole-or-nothing).
 * Design references: Components and Interfaces (Export_Service — file delivery
 * / download of the serialised CSV and Markdown documents).
 */

// ----------------------------------------------------------------------------
// MIME types.
// ----------------------------------------------------------------------------

/** The MIME type for a CSV document (UTF-8), used by {@link downloadCsv}. */
export const CSV_MIME_TYPE = 'text/csv;charset=utf-8' as const;

/**
 * The MIME type for a Markdown document (UTF-8), used by
 * {@link downloadMarkdown} for the end-of-event summary export (Req 9.4).
 */
export const MARKDOWN_MIME_TYPE = 'text/markdown;charset=utf-8' as const;

// ----------------------------------------------------------------------------
// Typed error.
// ----------------------------------------------------------------------------

/**
 * Thrown by {@link downloadTextFile} (and its wrappers) when invoked in an
 * environment that lacks the DOM APIs a browser download requires (`document`
 * and `URL.createObjectURL` / `URL.revokeObjectURL`) — e.g. SSR, a web worker,
 * or a DOM-less test runner. Callers that may run outside a browser should gate
 * on {@link isDownloadSupported} first.
 */
export class DownloadUnavailableError extends Error {
  constructor(
    message = 'File downloads are not available in this environment.',
  ) {
    super(message);
    this.name = 'DownloadUnavailableError';
  }
}

// ----------------------------------------------------------------------------
// Environment guard.
// ----------------------------------------------------------------------------

/**
 * True when the ambient environment provides the DOM APIs required to perform a
 * browser download: a `document` (to create and click the anchor) and both
 * `URL.createObjectURL` and `URL.revokeObjectURL` (to allocate and release the
 * object URL). Use this to guard {@link downloadTextFile} in code that can run
 * outside a browser (SSR, workers, tests).
 */
export function isDownloadSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof URL.revokeObjectURL === 'function'
  );
}

// ----------------------------------------------------------------------------
// Filename helpers.
// ----------------------------------------------------------------------------

/**
 * Ensures `filename` ends with `extension` (case-insensitive), appending it
 * when absent. `extension` MUST include the leading dot (e.g. `'.md'`). Pure.
 *
 * @param filename the proposed file name.
 * @param extension the required extension, including the leading dot.
 * @returns `filename` unchanged when it already ends with `extension`
 *   (ignoring case), otherwise `filename` + `extension`.
 */
export function ensureExtension(filename: string, extension: string): string {
  return filename.toLowerCase().endsWith(extension.toLowerCase())
    ? filename
    : `${filename}${extension}`;
}

// ----------------------------------------------------------------------------
// Core download.
// ----------------------------------------------------------------------------

/**
 * Triggers a browser download of `content` as a file named `filename` with the
 * given `mimeType`.
 *
 * Mechanism (all DOM I/O — see the module header): a UTF-8 {@link Blob} of
 * `content` is created, an object URL is allocated for it, a hidden
 * `<a download="{filename}" href="{objectURL}">` element is appended to the
 * document, programmatically clicked (which prompts the browser to save the
 * file), then removed; finally the object URL is revoked (in a `finally`) so the
 * Blob's memory is released regardless of how the click resolves.
 *
 * @param filename the download's suggested file name (the caller is responsible
 *   for the correct extension — the convenience wrappers {@link downloadCsv} /
 *   {@link downloadMarkdown} enforce theirs).
 * @param content the full document text to deliver. The caller constructs the
 *   COMPLETE string first, so this is whole-or-nothing (Req 9.7).
 * @param mimeType the Blob MIME type (e.g. {@link CSV_MIME_TYPE},
 *   {@link MARKDOWN_MIME_TYPE}).
 * @throws {DownloadUnavailableError} when the required DOM APIs are unavailable
 *   (see {@link isDownloadSupported}). No download is attempted in that case.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
  if (!isDownloadSupported()) {
    throw new DownloadUnavailableError();
  }

  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    // Keep the transient anchor out of the visual/tab flow.
    anchor.style.display = 'none';
    anchor.setAttribute('aria-hidden', 'true');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Always release the object URL, even if the click throws, so the Blob's
    // backing memory is not leaked.
    URL.revokeObjectURL(objectUrl);
  }
}

// ----------------------------------------------------------------------------
// Convenience wrappers.
// ----------------------------------------------------------------------------

/**
 * Downloads `csv` as a `.csv` file with the {@link CSV_MIME_TYPE} MIME type.
 * The `.csv` extension is appended when `filename` does not already end with it
 * ({@link ensureExtension}).
 *
 * @param filename the suggested file name (a `.csv` extension is ensured).
 * @param csv the RFC-4180 CSV document to deliver.
 * @throws {DownloadUnavailableError} when downloads are unsupported.
 */
export function downloadCsv(filename: string, csv: string): void {
  downloadTextFile(ensureExtension(filename, '.csv'), csv, CSV_MIME_TYPE);
}

/**
 * Downloads `markdown` as a `.md` file with the {@link MARKDOWN_MIME_TYPE} MIME
 * type — the delivery mechanism for the end-of-event summary export (Req 9.4).
 * The `.md` extension is appended when `filename` does not already end with it
 * ({@link ensureExtension}).
 *
 * @param filename the suggested file name (a `.md` extension is ensured).
 * @param markdown the Markdown document to deliver.
 * @throws {DownloadUnavailableError} when downloads are unsupported.
 */
export function downloadMarkdown(filename: string, markdown: string): void {
  downloadTextFile(
    ensureExtension(filename, '.md'),
    markdown,
    MARKDOWN_MIME_TYPE,
  );
}
