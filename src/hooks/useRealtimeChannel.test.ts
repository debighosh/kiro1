/**
 * Unit tests for the `useRealtimeChannel` hook (Task 15.4).
 *
 * These exercise the reconnect UX the reliability requirements mandate WITHOUT
 * any real Supabase / network dependency: `../lib/questions` is mocked so we can
 * capture the handlers passed to `subscribeToEventQuestions`
 * (`onConnectionChange`, `onQuestionsChange`, `onVoteCount`) and drive them
 * deterministically under fake timers. We verify:
 *   (a) `backoffDelayMs` yields 1s→2s→4s→8s→16s, capped at 30s (Req 23.6);
 *   (b) a >3 s interruption flips `status` to `'reconnecting'`, while a blip
 *       that recovers within the grace does NOT (Req 23.5);
 *   (c) repeated failures across the backoff schedule exhaust MAX_ATTEMPTS and
 *       land in the terminal `'error'` state (Req 23.6, 23.7);
 *   (d) `refresh()` remains callable in the error state (Req 23.5).
 *
 * Requirements: 23.5, 23.6, 23.7, 26.1.
 * Design: Frontend Design (Realtime subscription strategy & reconnect UX).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Mock `../lib/questions` entirely. Importing the real module transitively
// loads `../lib/supabaseClient`, which throws unless VITE_SUPABASE_* env vars
// are set. We only need `subscribeToEventQuestions` here; the hook has no other
// dependency on the module.
const subscribeToEventQuestions = vi.fn();

vi.mock('../lib/questions', () => ({
  subscribeToEventQuestions: (
    eventId: string,
    handlers: unknown,
  ): (() => void) => subscribeToEventQuestions(eventId, handlers),
}));

import {
  useRealtimeChannel,
  backoffDelayMs,
  BACKOFF_CAP_MS,
  INTERRUPTION_GRACE_MS,
  MAX_ATTEMPTS,
} from './useRealtimeChannel';
// `EventQuestionsSubscriptionHandlers` lives in `../lib/questions`, not in the
// hook module. A type-only import is erased at compile time, so it does NOT
// trigger the `vi.mock('../lib/questions')` above at runtime.
import type { EventQuestionsSubscriptionHandlers } from '../lib/questions';

const EVENT_ID = 'event-123';

/**
 * Grabs the handlers passed to the most recent `subscribeToEventQuestions`
 * call, so a test can drive `onConnectionChange` etc. Each `openChannel()`
 * registers a fresh set of handlers.
 */
function latestHandlers(): EventQuestionsSubscriptionHandlers {
  const calls = subscribeToEventQuestions.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as EventQuestionsSubscriptionHandlers;
}

beforeEach(() => {
  subscribeToEventQuestions.mockReset();
  // Every subscribe returns a fresh unsubscribe spy.
  subscribeToEventQuestions.mockImplementation(() => vi.fn());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('backoffDelayMs (Req 23.6)', () => {
  it('doubles from 1s: 1,2,4,8,16 across the 5 attempts', () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
    expect(backoffDelayMs(4)).toBe(8_000);
    expect(backoffDelayMs(5)).toBe(16_000);
  });

  it('caps at 30s for higher attempts (never exceeds BACKOFF_CAP_MS)', () => {
    // 2^5 * 1000 = 32000 > 30000 → capped.
    expect(backoffDelayMs(6)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(7)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(100)).toBe(BACKOFF_CAP_MS);
    expect(BACKOFF_CAP_MS).toBe(30_000);
  });
});

describe('useRealtimeChannel', () => {
  it('opens an event-scoped subscription and starts connected', () => {
    const { result } = renderHook(() => useRealtimeChannel({ eventId: EVENT_ID }));

    expect(subscribeToEventQuestions).toHaveBeenCalledTimes(1);
    expect(subscribeToEventQuestions.mock.calls[0][0]).toBe(EVENT_ID);
    expect(result.current.status).toBe('connected');
    expect(result.current.attempt).toBe(0);
  });

  it('does NOT flip to reconnecting for a blip that recovers within the 3s grace (Req 23.5)', async () => {
    const { result } = renderHook(() => useRealtimeChannel({ eventId: EVENT_ID }));

    // Report interrupted, then recover before the grace elapses.
    act(() => {
      latestHandlers().onConnectionChange?.(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERRUPTION_GRACE_MS - 100);
    });
    // Still connected — the grace has not elapsed.
    expect(result.current.status).toBe('connected');

    // Recovery within the grace clears the pending grace timer.
    act(() => {
      latestHandlers().onConnectionChange?.(false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.status).toBe('connected');
  });

  it('flips to reconnecting only after a >3s interruption (Req 23.5)', async () => {
    const { result } = renderHook(() => useRealtimeChannel({ eventId: EVENT_ID }));

    act(() => {
      latestHandlers().onConnectionChange?.(true);
    });
    // Just before the grace elapses: still connected.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERRUPTION_GRACE_MS - 1);
    });
    expect(result.current.status).toBe('connected');

    // Crossing the grace threshold surfaces the reconnecting state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.status).toBe('reconnecting');
  });

  it('retries on the backoff schedule and enters terminal error after MAX_ATTEMPTS (Req 23.6, 23.7)', async () => {
    const { result } = renderHook(() => useRealtimeChannel({ eventId: EVENT_ID }));

    const openCountAfterInitial = subscribeToEventQuestions.mock.calls.length;
    expect(openCountAfterInitial).toBe(1);

    // 1) First interruption + grace → reconnecting, schedules attempt 1.
    act(() => {
      latestHandlers().onConnectionChange?.(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERRUPTION_GRACE_MS);
    });
    expect(result.current.status).toBe('reconnecting');

    // Drive the backoff schedule. On each scheduled attempt the channel is
    // re-opened, then we report it still interrupted so the next backoff step
    // is scheduled. Delays: 1s, 2s, 4s, 8s, 16s (attempts 1..5).
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const before = subscribeToEventQuestions.mock.calls.length;
      // Advance the backoff timer for this attempt → re-opens the channel.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delays[i]);
      });
      // A fresh openChannel() should have run (new subscribe call).
      expect(subscribeToEventQuestions.mock.calls.length).toBe(before + 1);
      expect(result.current.attempt).toBe(i + 1);

      // The freshly opened channel is still down → report interrupted, which
      // (because we are already reconnecting) schedules the NEXT backoff step
      // or, on the last attempt, exhausts the budget.
      act(() => {
        latestHandlers().onConnectionChange?.(true);
      });
    }

    // Budget exhausted → terminal error; no further automatic retries.
    expect(result.current.status).toBe('error');

    // Confirm no additional resubscribe happens even after a long wait.
    const finalOpenCount = subscribeToEventQuestions.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS * 3);
    });
    expect(subscribeToEventQuestions.mock.calls.length).toBe(finalOpenCount);
  });

  it('keeps refresh() callable in the error state and re-reads + resubscribes (Req 23.5)', async () => {
    const onQuestionsChange = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeChannel({ eventId: EVENT_ID, onQuestionsChange }),
    );

    // Drive straight to the terminal error state.
    act(() => {
      latestHandlers().onConnectionChange?.(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERRUPTION_GRACE_MS);
    });
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delays[i]);
      });
      act(() => {
        latestHandlers().onConnectionChange?.(true);
      });
    }
    expect(result.current.status).toBe('error');

    const openCountBeforeRefresh = subscribeToEventQuestions.mock.calls.length;
    onQuestionsChange.mockClear();

    // refresh() must still be callable while errored.
    expect(typeof result.current.refresh).toBe('function');
    act(() => {
      result.current.refresh();
    });

    // It re-reads the caller's data immediately...
    expect(onQuestionsChange).toHaveBeenCalledTimes(1);
    // ...and forces a clean resubscribe (subscription effect re-runs), which
    // resets the status back to connected.
    expect(subscribeToEventQuestions.mock.calls.length).toBe(
      openCountBeforeRefresh + 1,
    );
    expect(result.current.status).toBe('connected');
    expect(result.current.attempt).toBe(0);
  });

  it('clears the reconnecting state when the channel recovers (onConnectionChange(false))', async () => {
    const { result } = renderHook(() => useRealtimeChannel({ eventId: EVENT_ID }));

    act(() => {
      latestHandlers().onConnectionChange?.(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERRUPTION_GRACE_MS);
    });
    expect(result.current.status).toBe('reconnecting');

    // A successful (re)subscribe clears the reconnecting state.
    act(() => {
      latestHandlers().onConnectionChange?.(false);
    });
    expect(result.current.status).toBe('connected');
    expect(result.current.attempt).toBe(0);
  });

  it('does not open a channel for a falsy eventId (scope invariant)', () => {
    renderHook(() => useRealtimeChannel({ eventId: '' }));
    expect(subscribeToEventQuestions).not.toHaveBeenCalled();
  });
});
