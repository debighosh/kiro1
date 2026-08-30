/**
 * Tests for the `EventJoinCard` component (task 14.3).
 *
 * These mock BOTH `react-router-dom`'s `useNavigate` (so navigation is a
 * spy, not a real route transition) and `../lib/eventLookup`'s
 * `findEventByRef` (so resolution is deterministic and no real Supabase anon
 * client / network is involved — importing the real lookup transitively loads
 * `../lib/supabaseClient`, which throws unless VITE_SUPABASE_* is set).
 *
 * They verify the behaviours Req 2.1 / 2.2 / 24.5 / 24.7 mandate:
 *   (a) the code input has a programmatically associated label with a
 *       non-empty accessible name (Req 24.5);
 *   (b) submitting a KNOWN code resolves it and navigates to the join route
 *       for that event (Req 2.1);
 *   (c) submitting an UNKNOWN code shows the accessible invalid-code error via
 *       `role="alert"` and does NOT navigate — the participant stays on the
 *       landing page (Req 2.2);
 *   (d) join-card mode renders the event name + status and an "Enter event"
 *       CTA, and renders a friendly not-found state when no event is given.
 *
 * Design: Components (`EventJoinCard`); Request/data flows (Audience join).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the router so `useNavigate` returns our spy. We keep everything else
// from the real module intact via `importActual`.
const navigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

// Mock the anon lookup so resolution is deterministic (no Supabase client).
const findEventByRef = vi.fn();
vi.mock('../lib/eventLookup', () => ({
  findEventByRef: (ref: string) => findEventByRef(ref),
}));

import { EventJoinCard } from './EventJoinCard';

const LIVE_EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'MSS AI Demo Day 2026',
  slug: 'demo-day',
  status: 'live' as const,
};

beforeEach(() => {
  navigate.mockReset();
  findEventByRef.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('EventJoinCard — code-entry mode', () => {
  it('renders a code input with an associated, non-empty label (Req 24.5)', () => {
    render(<EventJoinCard mode="code-entry" />);

    // `getByLabelText` only matches when the label is programmatically
    // associated with the control and exposes a non-empty accessible name.
    const input = screen.getByLabelText('Event code');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input).toHaveAccessibleName('Event code');
  });

  it('navigates to the join route when a known code is submitted (Req 2.1)', async () => {
    const user = userEvent.setup();
    findEventByRef.mockResolvedValue(LIVE_EVENT);

    render(<EventJoinCard mode="code-entry" />);

    await user.type(screen.getByLabelText('Event code'), 'demo-day');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    // Resolves the entered code...
    await waitFor(() => {
      expect(findEventByRef).toHaveBeenCalledWith('demo-day');
    });
    // ...and navigates to the join route for the resolved event (slug wins).
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/join/demo-day');
    });
    // No invalid-code error is shown on the happy path.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the invalid-code error and does NOT navigate for an unknown code (Req 2.2)', async () => {
    const user = userEvent.setup();
    findEventByRef.mockResolvedValue(null);

    render(<EventJoinCard mode="code-entry" />);

    await user.type(screen.getByLabelText('Event code'), 'nope-nope');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    // The accessible invalid-code error is surfaced via role="alert"...
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/event code is invalid/i);
    // ...the lookup was attempted...
    expect(findEventByRef).toHaveBeenCalledWith('nope-nope');
    // ...and the participant is kept on the landing page (no navigation).
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate or look up an empty submission — shows invalid (Req 2.2)', async () => {
    const user = userEvent.setup();

    render(<EventJoinCard mode="code-entry" />);

    await user.click(screen.getByRole('button', { name: 'Join' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/event code is invalid/i);
    expect(findEventByRef).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('EventJoinCard — join-card mode', () => {
  it('shows the event name + status and enters the event view on CTA click', async () => {
    const user = userEvent.setup();

    render(
      <EventJoinCard mode="join-card" event={LIVE_EVENT} eventRef="demo-day" />,
    );

    expect(
      screen.getByRole('heading', { name: 'MSS AI Demo Day 2026' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('event-status')).toHaveTextContent('Live now');

    await user.click(screen.getByRole('button', { name: 'Enter event' }));
    expect(navigate).toHaveBeenCalledWith('/e/demo-day');
  });

  it('renders a friendly not-found state when no event is resolved (Req 2.2, 1.9)', () => {
    render(<EventJoinCard mode="join-card" event={null} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/event unavailable/i);
    // No "Enter event" CTA when there is no event to enter.
    expect(screen.queryByRole('button', { name: 'Enter event' })).toBeNull();
  });
});
