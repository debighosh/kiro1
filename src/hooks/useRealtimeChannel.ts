/**
 * `useRealtimeChannel` — audience Q&A realtime subscription + reconnect UX
 * (Task 15.3).
 *
 * This hook owns the audience event view's live connection to a SINGLE event's
 * question/vote updates and the reconnect user-experience the reliability
 * requirements mandate. It delegates the actual channel wiring to
 * {@link subscribeToEventQuestions} in `../lib/questions`, so the hook (and any
 * component using it) has NO direct Supabase import and stays unit-testable by
 * mocking `../lib/questions` alone.
 *
 * Behaviour (Design → Frontend Design → Realtime subscription strategy &
 * reconnect UX):
 *
 *  - Subscribes ONLY to this event's `questions` changes + vote-count Broadcast,
 *    scoped by `event_id` — NEVER the full dataset (Req 23.2). The scope is
 *    enforced in {@link subscribeToEventQuestions}; this hook passes the
 *    concrete `eventId` through.
 *
 *  - Delivers question/vote updates to the caller via `onQuestionsChange` /
 *    `onVoteCount` so the view can re-read within the 2-second target
 *    (Req 23.1, 4.7).
 *
 *  - Reconnecting indicator after a >3 s interruption (Req 23.5): a transient
 *    blip does NOT immediately surface a reconnecting state — only when the
 *    connection has been interrupted for longer than
 *    {@link INTERRUPTION_GRACE_MS} does `status` become `'reconnecting'`, at
 *    which point the consumer shows a reconnecting indicator and an ENABLED
 *    manual-refresh control.
 *
 *  - Exponential-backoff resubscribe (Req 23.6, 23.7): once the grace elapses
 *    the hook tears down and re-opens the channel on a backoff schedule
 *    starting at {@link BACKOFF_BASE_MS} (1 s) and doubling — 1 s → 2 s → 4 s →
 *    8 s → 16 s — capped at {@link BACKOFF_CAP_MS} (30 s), for at most
 *    {@link MAX_ATTEMPTS} (5) attempts. If all attempts are exhausted without
 *    recovering, the hook stops retrying and enters a terminal `'error'` state
 *    (Req 23.7).
 *
 *  - Manual refresh (`refresh()`): always safe to call and always enabled while
 *    reconnecting/errored (Req 23.5). It re-reads the caller's data immediately
 *    (via `onQuestionsChange`) and forces a clean resubscribe, resetting the
 *    backoff from scratch.
 *
 * Fake-timer friendliness (for the task 15.4 tests): ALL timing uses
 * `setTimeout`/`clearTimeout` with fixed millisecond delays and never reads the
 * wall clock, so a test using fake timers can advance through the >3 s grace and
 * the full 1 s→…→30 s backoff sequence deterministically.
 *
 * Requirements traceability: 23.1, 23.2, 23.5, 23.6, 23.7, 4.7.
 * Design: Frontend Design (Realtime subscription strategy & reconnect UX);
 * Components (`ConnectionStatusIndicator`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  subscribeToEventQuestions,
  type EventQuestionsUnsubscribe,
  type VoteCountBroadcast,
} from '../lib/questions';

/**
 * The connection status the hook exposes, driving the
 * {@link ConnectionStatusIndicator}:
 *  - `connected`: the live channel is subscribed (indicator hidden).
 *  - `reconnecting`: interrupted for >3 s and still retrying within the backoff
 *    budget (indicator + enabled manual refresh shown).
 *  - `error`: the retry budget is exhausted; no further automatic attempts are
 *    made (terminal indicator + enabled manual refresh shown).
 */
export type RealtimeStatus = 'connected' | 'reconnecting' | 'error';

/**
 * How long the connection must stay interrupted before the hook surfaces the
 * `'reconnecting'` state (Req 23.5 — ">3 s interruption"). A brief blip that
 * recovers within this grace never flips the visible status.
 */
export const INTERRUPTION_GRACE_MS = 3_000;

/** Initial backoff delay before the first resubscribe attempt (Req 23.6). */
export const BACKOFF_BASE_MS = 1_000;

/** Maximum backoff delay — the doubling is capped here (Req 23.6). */
export const BACKOFF_CAP_MS = 30_000;

/**
 * Maximum number of automatic resubscribe attempts before entering the terminal
 * `'error'` state (Req 23.7). After this many attempts fail the hook stops
 * retrying automatically (a manual `refresh()` can still restart it).
 */
export const MAX_ATTEMPTS = 5;

/**
 * Computes the backoff delay (ms) for a given 1-based attempt number: base
 * doubled per attempt, capped at {@link BACKOFF_CAP_MS}. attempt 1 → 1 s,
 * 2 → 2 s, 3 → 4 s, 4 → 8 s, 5 → 16 s (all ≤ 30 s cap).
 */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = BACKOFF_BASE_MS * 2 ** exponent;
  return Math.min(raw, BACKOFF_CAP_MS);
}

/** Inputs to {@link useRealtimeChannel}. */
export interface UseRealtimeChannelInput {
  /**
   * The id of the (live) event to subscribe to. The subscription is scoped to
   * THIS event only — never the full dataset (Req 23.2). A falsy id disables the
   * subscription (the hook stays `connected` and opens nothing).
   */
  readonly eventId: string;
  /** Called when a `questions` row for this event changes (Req 23.1). */
  readonly onQuestionsChange?: () => void;
  /** Called with the aggregate vote-count Broadcast for this event (Req 4.7). */
  readonly onVoteCount?: (payload: VoteCountBroadcast) => void;
}

/** The public API {@link useRealtimeChannel} returns. */
export interface UseRealtimeChannelResult {
  /** The current connection status (drives {@link ConnectionStatusIndicator}). */
  readonly status: RealtimeStatus;
  /** The number of resubscribe attempts made so far (0 while connected). */
  readonly attempt: number;
  /**
   * Manually force an immediate resubscribe + data re-read. Always safe to call
   * and always enabled while reconnecting/errored (Req 23.5). Resets the backoff.
   */
  readonly refresh: () => void;
}

/**
 * Subscribes to a single event's question/vote realtime updates and manages the
 * reconnect UX (grace timer, exponential backoff, terminal error, manual
 * refresh). See the module doc for the full behaviour + requirements mapping.
 */
export function useRealtimeChannel({
  eventId,
  onQuestionsChange,
  onVoteCount,
}: UseRealtimeChannelInput): UseRealtimeChannelResult {
  const [status, setStatus] = useState<RealtimeStatus>('connected');
  const [attempt, setAttempt] = useState(0);
  // Bumped by `refresh()` to force the subscription effect to re-run and open a
  // clean channel from scratch (resetting the backoff).
  const [refreshTick, setRefreshTick] = useState(0);

  // Keep the latest caller callbacks in refs so re-subscribing does not require
  // the caller to memoise them (and so the effect below is not re-run on every
  // render just because an inline handler identity changed).
  const onQuestionsChangeRef = useRef(onQuestionsChange);
  const onVoteCountRef = useRef(onVoteCount);
  onQuestionsChangeRef.current = onQuestionsChange;
  onVoteCountRef.current = onVoteCount;

  useEffect(() => {
    // Guards a state update after unmount / a superseded event change (the
    // timers may already be queued).
    let active = true;
    let unsubscribe: EventQuestionsUnsubscribe | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    // Local attempt counter (mirrors the `attempt` state, which is display-only).
    let attempts = 0;
    // True once a grace/backoff reconnect cycle is underway, so repeated
    // interruption reports do not stack multiple cycles.
    let reconnecting = false;
    // True once the retry budget is exhausted (terminal error): stop reacting.
    let terminal = false;

    // Fresh subscription: reset visible state.
    setStatus('connected');
    setAttempt(0);

    const clearGraceTimer = (): void => {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };
    const clearBackoffTimer = (): void => {
      if (backoffTimer !== null) {
        clearTimeout(backoffTimer);
        backoffTimer = null;
      }
    };
    const teardownChannel = (): void => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    // Nothing to subscribe to (no event yet): stay connected, open nothing
    // (SCOPE INVARIANT: never open an unscoped/full-dataset channel).
    if (!eventId) {
      return () => {
        active = false;
        clearGraceTimer();
        clearBackoffTimer();
        teardownChannel();
      };
    }

    // (Re)open the event-scoped channel, wiring the handlers to refs so the
    // latest caller callbacks are always used.
    const openChannel = (): void => {
      teardownChannel();
      unsubscribe = subscribeToEventQuestions(eventId, {
        onQuestionsChange: () => onQuestionsChangeRef.current?.(),
        onVoteCount: (payload) => onVoteCountRef.current?.(payload),
        onConnectionChange: handleInterrupt,
      });
    };

    // Schedule the next backoff resubscribe attempt (Req 23.6, 23.7). When the
    // attempt budget is exhausted, stop and enter the terminal error state.
    const scheduleReconnect = (): void => {
      clearBackoffTimer();
      const nextAttempt = attempts + 1;
      if (nextAttempt > MAX_ATTEMPTS) {
        // Retry budget exhausted → terminal error; stop retrying (Req 23.7).
        terminal = true;
        reconnecting = false;
        if (active) setStatus('error');
        return;
      }
      const delay = backoffDelayMs(nextAttempt);
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        attempts = nextAttempt;
        if (active) setAttempt(nextAttempt);
        // Re-open the channel; a successful (re)subscribe resets everything via
        // handleInterrupt(false); a further failure schedules the next attempt.
        openChannel();
        // If the fresh channel is still down, the channel reports interrupted
        // again which — because `reconnecting` is true — funnels straight into
        // scheduleReconnect() for the next backoff step.
      }, delay);
    };

    // React to a connection-state change reported by the channel.
    function handleInterrupt(interrupted: boolean): void {
      if (!active || terminal) return;

      if (!interrupted) {
        // (Re)subscribed successfully → healthy. Clear all timers + counters.
        clearGraceTimer();
        clearBackoffTimer();
        attempts = 0;
        reconnecting = false;
        setAttempt(0);
        setStatus('connected');
        return;
      }

      // Interrupted.
      if (reconnecting) {
        // Already in a backoff cycle: the previous attempt's channel failed, so
        // step to the next backoff delay (Req 23.6).
        scheduleReconnect();
        return;
      }

      // First interruption: do NOT surface 'reconnecting' immediately (Req 23.5).
      // Only after a >3 s grace does the visible status flip and backoff begin.
      if (graceTimer !== null) return;
      clearGraceTimer();
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!active || terminal) return;
        reconnecting = true;
        setStatus('reconnecting');
        teardownChannel();
        scheduleReconnect();
      }, INTERRUPTION_GRACE_MS);
    }

    openChannel();

    return () => {
      active = false;
      clearGraceTimer();
      clearBackoffTimer();
      teardownChannel();
    };
    // Re-subscribe when the event changes OR a manual refresh is requested. The
    // handlers read the latest callbacks via refs, and `status`/`attempt` are
    // driven from inside the closure, so they are intentionally NOT deps (a
    // status transition must not tear down and re-open the channel).
  }, [eventId, refreshTick]);

  const refresh = useCallback((): void => {
    // Always re-read the caller's current data immediately (Req 23.5).
    onQuestionsChangeRef.current?.();
    // Force a clean resubscribe from scratch (resets the backoff + status via
    // the subscription effect re-running).
    setRefreshTick((tick) => tick + 1);
  }, []);

  return { status, attempt, refresh };
}
