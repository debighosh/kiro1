/**
 * `ConnectionStatusIndicator` — reconnect UX surface for the audience live
 * connection (Task 15.3).
 *
 * A small, accessible presentational component that reflects the realtime
 * connection state produced by {@link useRealtimeChannel} and offers a manual
 * refresh affordance while the live connection is degraded (Design → Frontend
 * Design → Realtime subscription strategy & reconnect UX; Components →
 * `ConnectionStatusIndicator`).
 *
 * Behaviour by `status`:
 *  - `connected`: the live connection is healthy. Nothing user-visible is
 *    rendered; a visually-hidden `role="status"` node still announces the
 *    healthy state to assistive tech without cluttering the UI.
 *  - `reconnecting`: the connection has been interrupted for >3 s and the hook
 *    is retrying with exponential backoff (Req 23.5, 23.6). A polite,
 *    non-blocking message is shown alongside an ENABLED manual-refresh button
 *    so the participant can force an immediate re-read/resubscribe.
 *  - `error`: the retry budget is exhausted and automatic retries have stopped
 *    (Req 23.7). A terminal message is announced assertively (`role="alert"`)
 *    and the manual-refresh button remains ENABLED so the participant can
 *    retry on demand.
 *
 * This component is purely presentational — it holds no connection state and
 * performs no I/O. It calls the supplied `onRefresh` when the button is pressed
 * (the hook's `refresh()` re-reads the list and forces a clean resubscribe).
 *
 * Accessibility (Req 24.5): status is conveyed as TEXT (never colour alone);
 * `reconnecting` uses a polite live region and `error` an assertive alert so
 * screen-reader users are informed; the refresh button meets the ≥44×44px
 * touch-target size (`.touch-target`) and exposes a descriptive accessible name.
 * The button is NEVER `disabled` in the degraded states (Req 23.5 — the manual
 * refresh must be available whenever the live path is degraded).
 *
 * Requirements traceability: 23.5, 23.6, 23.7.
 * Design: Frontend Design (Realtime subscription strategy & reconnect UX);
 * Components (`ConnectionStatusIndicator`).
 */
import type { RealtimeStatus } from '../hooks/useRealtimeChannel';

export interface ConnectionStatusIndicatorProps {
  /** The current realtime connection status (from {@link useRealtimeChannel}). */
  readonly status: RealtimeStatus;
  /**
   * Invoked when the participant presses the manual-refresh control. Wired to
   * the hook's `refresh()`, which re-reads the list and forces a clean
   * resubscribe. Enabled whenever the connection is degraded (Req 23.5).
   */
  readonly onRefresh: () => void;
}

/** The polite message shown while the hook is reconnecting (Req 23.5). */
const RECONNECTING_MESSAGE =
  'Reconnecting to live updates… you can keep participating.';

/** The terminal message shown once automatic retries stop (Req 23.7). */
const ERROR_MESSAGE =
  'Live updates are currently unavailable. Refresh to try again.';

export function ConnectionStatusIndicator({
  status,
  onRefresh,
}: ConnectionStatusIndicatorProps): JSX.Element {
  if (status === 'connected') {
    // Healthy: nothing visible, but announce the state politely for AT (an
    // sr-only status region keeps the surface uncluttered — Req 24.5).
    return (
      <p className="sr-only" role="status" aria-live="polite" data-testid="connection-status-connected">
        Connected to live updates.
      </p>
    );
  }

  const isError = status === 'error';

  return (
    <div
      // Terminal errors are announced assertively; a transient reconnect is
      // announced politely so it does not interrupt (Req 24.5).
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-testid={isError ? 'connection-status-error' : 'connection-status-reconnecting'}
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-muted/40 bg-surface px-3 py-2"
    >
      {/* Status conveyed as TEXT, never colour alone (Req 24.5). */}
      <p className="text-sm text-ink">
        {isError ? ERROR_MESSAGE : RECONNECTING_MESSAGE}
      </p>

      {/* Manual refresh — ALWAYS enabled while degraded (Req 23.5). */}
      <button
        type="button"
        onClick={onRefresh}
        aria-label="Refresh live updates now"
        className="touch-target rounded border border-ink-muted px-4 py-2 text-sm font-medium text-ink"
      >
        Refresh
      </button>
    </div>
  );
}
