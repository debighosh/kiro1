/**
 * Tests for the `StatusTransitionControl` component (task 8.2).
 *
 * These mock `../lib/events`' `transitionEventStatus` (so no real Edge Function
 * / Supabase session is needed) while keeping the REAL `EventError` class, so
 * the component's error branch is exercised exactly as in production. They
 * verify the behaviours the design and requirements mandate:
 *   (a) a `draft` event offers ONLY the "Go live" action; clicking it calls
 *       `transitionEventStatus(id, 'live')` and reflects the new status on
 *       success (Req 1.5→1.7, 24.7);
 *   (b) an `archived` event offers NO transition actions and shows a
 *       terminal / cannot-reactivate note (Req 1.11);
 *   (c) an error from the helper shows a sanitised message via `role="alert"`
 *       and leaves the displayed status unchanged (Req 24.7);
 *   (d) the action button is disabled + `aria-busy` while a transition is
 *       in flight (Req 24.7).
 *
 * Design: Components and Interfaces; Error Handling (Conflict). Req 1.8, 1.9,
 * 1.11, 24.4, 24.7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock `../lib/events` entirely. Importing the real module transitively loads
// `../lib/supabaseClient`, which throws unless VITE_SUPABASE_* env vars are set
// — so, like the RequireAuth test mocks `../lib/auth`, we replace this module.
// We provide our own `EventError` inside the factory and export it; because the
// component AND this test both import `EventError` from the SAME (mocked)
// module, the component's `instanceof EventError` branch still matches, so the
// sanitised-message error path is exercised faithfully.
const transitionEventStatus = vi.fn();

vi.mock('../lib/events', () => {
  class EventError extends Error {
    kind: string;
    fields: unknown[];
    status?: number;
    constructor(
      message: string,
      options: { kind: string; fields?: unknown[]; status?: number },
    ) {
      super(message);
      this.name = 'EventError';
      this.kind = options.kind;
      this.fields = options.fields ?? [];
      this.status = options.status;
    }
  }
  return {
    EventError,
    transitionEventStatus: (id: string, target: string) =>
      transitionEventStatus(id, target),
  };
});

import { StatusTransitionControl } from './StatusTransitionControl';
import { EventError } from '../lib/events';

const EVENT_ID = 'event-123';

beforeEach(() => {
  transitionEventStatus.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('StatusTransitionControl', () => {
  it('offers only "Go live" for a draft event and reflects success (Req 1.5→1.7, 24.7)', async () => {
    const user = userEvent.setup();
    transitionEventStatus.mockResolvedValue({ id: EVENT_ID, status: 'live' });
    const onTransition = vi.fn();

    render(
      <StatusTransitionControl
        event={{ id: EVENT_ID, status: 'draft' }}
        onTransition={onTransition}
      />,
    );

    // Current status shown as text (Req 24.4).
    expect(screen.getByTestId('current-status')).toHaveTextContent('Draft');

    // Exactly one action button, and it is the forward transition only —
    // there is no "End event"/"Archive"/"Set to draft" offered.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const goLive = screen.getByRole('button', { name: 'Go live' });
    expect(goLive).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End event' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();

    await user.click(goLive);

    // Delegates to the helper with the correct id + target.
    expect(transitionEventStatus).toHaveBeenCalledWith(EVENT_ID, 'live');

    // Reflects success: status updates and the callback fires.
    await waitFor(() => {
      expect(screen.getByTestId('current-status')).toHaveTextContent('Live');
    });
    expect(onTransition).toHaveBeenCalledWith('live');
    // Now in the 'live' state, the offered action becomes "End event".
    expect(screen.getByRole('button', { name: 'End event' })).toBeInTheDocument();
  });

  it('offers no actions for an archived event and shows the cannot-reactivate note (Req 1.11)', () => {
    render(<StatusTransitionControl event={{ id: EVENT_ID, status: 'archived' }} />);

    expect(screen.getByTestId('current-status')).toHaveTextContent('Archived');
    // Terminal: no transition action buttons at all.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // And a clear note that archived events cannot be reactivated.
    expect(screen.getByText(/cannot be reactivated/i)).toBeInTheDocument();
    expect(transitionEventStatus).not.toHaveBeenCalled();
  });

  it('shows a sanitised message and keeps the status unchanged on error (Req 24.7)', async () => {
    const user = userEvent.setup();
    transitionEventStatus.mockRejectedValue(
      new EventError('That status change is not allowed for this event.', {
        kind: 'invalid_transition',
        status: 409,
      }),
    );

    render(<StatusTransitionControl event={{ id: EVENT_ID, status: 'live' }} />);

    expect(screen.getByTestId('current-status')).toHaveTextContent('Live');
    await user.click(screen.getByRole('button', { name: 'End event' }));

    // The typed error's sanitised message is surfaced via role="alert"...
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not allowed/i);
    // ...and the displayed status is NOT changed by the failed attempt.
    expect(screen.getByTestId('current-status')).toHaveTextContent('Live');
    // The action remains available to retry.
    expect(screen.getByRole('button', { name: 'End event' })).toBeInTheDocument();
  });

  it('disables the action button and marks it aria-busy while submitting (Req 24.7)', async () => {
    const user = userEvent.setup();
    // A controllable, never-auto-resolving promise keeps the control submitting.
    let resolve: (v: { id: string; status: 'ended' }) => void = () => {};
    transitionEventStatus.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    render(<StatusTransitionControl event={{ id: EVENT_ID, status: 'live' }} />);

    const endBtn = screen.getByRole('button', { name: 'End event' });
    await user.click(endBtn);

    // While in flight: the button is disabled and aria-busy, and a polite
    // progress indicator is shown.
    await waitFor(() => {
      const busyBtn = screen.getByRole('button');
      expect(busyBtn).toBeDisabled();
      expect(busyBtn).toHaveAttribute('aria-busy', 'true');
    });
    expect(screen.getByRole('status')).toHaveTextContent(/updating/i);

    // Resolving completes the transition and clears the busy state.
    resolve({ id: EVENT_ID, status: 'ended' });
    await waitFor(() => {
      expect(screen.getByTestId('current-status')).toHaveTextContent('Ended');
    });
  });
});
