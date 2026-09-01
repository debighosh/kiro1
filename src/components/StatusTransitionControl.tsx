import { useState } from 'react';
import {
  ALLOWED_TRANSITIONS,
  CAN_REACTIVATE_ARCHIVED,
  type EventStatus,
} from '../lib/eventStatus';
import { EventError, transitionEventStatus } from '../lib/events';
import { cx, FOCUS_RING } from '../lib/a11y';
// Req 24.6: no JS-driven animation in this component; the global CSS
// `@media (prefers-reduced-motion: reduce)` rule in index.css covers all CSS
// transitions. No JS animation guard is needed here.
// Req 24.8: `participant_identifier` is never read nor rendered here; only
// the event id and status flow through this component.

/**
 * `StatusTransitionControl` — the admin control for moving an event through its
 * lifecycle: draft → live → ended → archived (Task 8.2).
 *
 * It renders the event's CURRENT status as a text label (never colour-only, in
 * the spirit of Req 24.4) plus a single action button for each ALLOWED next
 * transition, computed from the shared {@link ALLOWED_TRANSITIONS} table in
 * `../lib/eventStatus` — the same contract the `transition-event-status` Edge
 * Function enforces server-side. Because only allowed transitions are rendered,
 * illegal transitions are never offered (there is no disabled "wrong" button to
 * mis-click); the archived (terminal) state offers no actions at all and shows
 * that archived events cannot be reactivated in V1 (Req 1.11).
 *
 * Lifecycle → offered action(s):
 *   draft   → "Go live"    (open participation, Req 1.5→1.7)
 *   live    → "End event"  (close participation, Req 1.8)
 *   ended   → "Archive"    (retain for reporting, Req 1.10)
 *   archived→ (none)       (terminal — Req 1.11)
 *
 * Four UX states (Design → four UX states; Req 24.7):
 *  - idle:       the current status + the allowed action button(s).
 *  - submitting: the clicked button is disabled with `aria-busy`, and a polite
 *                progress message is shown; a further click is ignored.
 *  - success:    the displayed status updates to the new value (internal state)
 *                and the `onTransition` callback fires with the new status.
 *  - error:      a sanitised message (from the typed {@link EventError}) is
 *                shown via `role="alert"`; the displayed status is unchanged.
 *
 * Accessibility & mobile-first (Req 24.2, 24.4, 24.5):
 *  - the status is announced as text, not by colour alone;
 *  - each action button has a clear, explicit label and meets the ≥44×44 px
 *    touch target (`.touch-target`); buttons are keyboard-operable by default.
 *
 * The SPA never writes `events.status` directly — the click delegates to
 * {@link transitionEventStatus}, which calls the authenticated Edge Function.
 *
 * Requirements traceability: 1.8, 1.9, 1.11, 24.4, 24.7.
 * Design: Components and Interfaces; Error Handling (Conflict/Authorization).
 */

export interface StatusTransitionControlProps {
  /** The event whose status is being controlled. */
  readonly event: {
    readonly id: string;
    readonly status: EventStatus;
  };
  /**
   * Called after a successful transition with the event's new status, so a
   * parent can keep its own copy of the event in sync. Optional — the control
   * also tracks the current status internally for its own display.
   */
  readonly onTransition?: (newStatus: EventStatus) => void;
}

/** Resolution state of an in-flight transition (Req 24.7 four UX states). */
type ControlStatus = 'idle' | 'submitting' | 'success' | 'error';

/** Human-readable label shown for each status (text indicator — Req 24.4). */
const STATUS_LABELS: Record<EventStatus, string> = {
  draft: 'Draft',
  live: 'Live',
  ended: 'Ended',
  archived: 'Archived',
};

/**
 * The action-button label for transitioning INTO each target status. Only
 * targets that appear in {@link ALLOWED_TRANSITIONS} for the current status are
 * ever rendered, so these are the user-facing verbs for the lifecycle steps.
 */
const TRANSITION_ACTION_LABELS: Record<EventStatus, string> = {
  // `draft` is never a transition target (it is the creation status), but the
  // record is exhaustive so the type stays total.
  draft: 'Set to draft',
  live: 'Go live',
  ended: 'End event',
  archived: 'Archive',
};

export function StatusTransitionControl({
  event,
  onTransition,
}: StatusTransitionControlProps): JSX.Element {
  // Track the displayed status internally so the control reflects a successful
  // transition even if the parent does not pass a fresh `event` prop back in.
  const [currentStatus, setCurrentStatus] = useState<EventStatus>(event.status);
  const [status, setStatus] = useState<ControlStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Which target is being submitted, so only that button shows the busy state.
  const [pendingTarget, setPendingTarget] = useState<EventStatus | null>(null);

  const isSubmitting = status === 'submitting';
  const allowedTargets = ALLOWED_TRANSITIONS[currentStatus];
  const isTerminal = allowedTargets.length === 0;

  async function handleTransition(target: EventStatus): Promise<void> {
    if (isSubmitting) return;

    setStatus('submitting');
    setPendingTarget(target);
    setErrorMessage(null);

    try {
      const updated = await transitionEventStatus(event.id, target);
      setCurrentStatus(updated.status);
      setStatus('success');
      setPendingTarget(null);
      onTransition?.(updated.status);
    } catch (error) {
      // Show a sanitised, user-safe message only. EventError messages are
      // already sanitised by the helper; any non-EventError gets a generic one
      // so no internals ever leak (Design → Error Handling).
      const message =
        error instanceof EventError
          ? error.message
          : 'The event status could not be changed. Please try again.';
      setErrorMessage(message);
      setStatus('error');
      setPendingTarget(null);
      // NOTE: currentStatus is intentionally left unchanged on error.
    }
  }

  return (
    <section className="status-transition-control" aria-label="Event status">
      {/* Current status as a TEXT label (not colour-only) — Req 24.4. */}
      <p className="text-ink">
        <span className="text-ink-muted">Status: </span>
        <span data-testid="current-status" className="font-medium text-ink">
          {STATUS_LABELS[currentStatus]}
        </span>
      </p>

      {isTerminal ? (
        // Archived is terminal: no actions, and we state that it cannot be
        // reactivated in V1 (Req 1.11). CAN_REACTIVATE_ARCHIVED is always false.
        <p className="mt-2 text-ink-muted">
          {!CAN_REACTIVATE_ARCHIVED
            ? 'This event is archived. Archived events are kept for reporting and cannot be reactivated.'
            : 'This event is archived.'}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {allowedTargets.map((target) => {
            const busy = isSubmitting && pendingTarget === target;
            return (
              <button
                key={target}
                type="button"
                onClick={() => {
                  void handleTransition(target);
                }}
                disabled={isSubmitting}
                aria-busy={busy}
                className={cx(
                  'touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60',
                  FOCUS_RING,
                )}
              >
                {busy ? 'Working…' : TRANSITION_ACTION_LABELS[target]}
              </button>
            );
          })}
        </div>
      )}

      {/* Submitting indicator, distinct from the button's busy label (Req 24.7). */}
      {isSubmitting ? (
        <p role="status" aria-live="polite" className="mt-2 text-ink-muted">
          Updating event status…
        </p>
      ) : null}

      {/* Error state: sanitised message, status left unchanged (Req 24.7). */}
      {status === 'error' && errorMessage ? (
        <p role="alert" className="mt-2 text-ink">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}

export default StatusTransitionControl;
