/**
 * Unit tests for the `PollCard` audience poll surface (Task 23.6).
 *
 * These mock `../lib/polls` (so no real Supabase client / network is touched —
 * importing the real module transitively loads `../lib/supabaseClient`, which
 * throws unless VITE_SUPABASE_* env vars are set) while keeping a REAL
 * `PollError` class inside the mock factory so the component's
 * `instanceof PollError` sanitised-message branch is exercised faithfully (the
 * component AND this test import `PollError` from the SAME mocked module). We
 * verify the behaviours the design + requirements mandate:
 *
 *   (a) single-choice selection & change-of-choice: tapping an option calls
 *       `submitPollResponse(pollId, optionId)` once; tapping a DIFFERENT option
 *       calls it again with the new optionId (the upsert-replace change-of-choice
 *       — Req 5.7); `aria-checked` reflects the current selection;
 *   (b) results visibility gating (Req 5.11): a still-open `hide_until_closed`
 *       poll WITHHOLDS its results (the `poll-results-hidden` placeholder is
 *       shown and `poll-results-list` is absent), while a `closed`
 *       `hide_until_closed` poll OR a `show_always` open poll REVEALS the
 *       accessible results list (`poll-results-list`);
 *   (c) the participant identifier NEVER reaches the DOM (Req 8.6) — the
 *       component only ever receives the non-sensitive projection, so even a
 *       sentinel id attached to the poll/option objects is never rendered.
 *
 * Recharts renders an SVG in jsdom; per the design (task 23.2) an accessible
 * ARIA-labelled text list (`poll-results-list`) is always rendered alongside the
 * chart, so these tests assert on that robust accessible list rather than SVG
 * internals.
 *
 * Requirements: 5.7, 5.11, 8.6, 26.1.
 * Design: Components (`PollCard`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock `../lib/polls`. A REAL `PollError` lives inside the factory so the
// component's error branch (`instanceof PollError`) still matches, and the
// read/write/subscribe helpers are stubbed with spies. The factory is hoisted,
// so the spies are exposed via `vi.hoisted` and must not reference outer
// variables.
const { readActivePoll, submitPollResponse, subscribeToPollResults } =
  vi.hoisted(() => ({
    readActivePoll: vi.fn(),
    submitPollResponse: vi.fn(),
    subscribeToPollResults: vi.fn(),
  }));

vi.mock('../lib/polls', () => {
  class PollError extends Error {
    kind: string;
    cause?: unknown;
    constructor(message: string, options: { kind: string; cause?: unknown }) {
      super(message);
      this.name = 'PollError';
      this.kind = options.kind;
      this.cause = options.cause;
    }
  }
  return {
    PollError,
    readActivePoll: (eventId: string) => readActivePoll(eventId),
    submitPollResponse: (pollId: string, optionId: string) =>
      submitPollResponse(pollId, optionId),
    // Return a no-op unsubscribe so the effect cleanup works.
    subscribeToPollResults: (eventId: string, handlers: unknown) =>
      subscribeToPollResults(eventId, handlers),
  };
});

import { PollCard } from './PollCard';

const EVENT_ID = 'event-poll-123';

/**
 * A sentinel participant identifier that must NEVER appear in the rendered DOM
 * (Req 8.6). We attach it to the poll + option objects to prove that even if an
 * over-broad read leaked it, the component still renders only option text /
 * counts.
 */
const PARTICIPANT_SENTINEL = 'PARTICIPANT-SENTINEL-DO-NOT-RENDER-poll-xyz';

/** Builds a poll with two options. Extra props simulate a leaky over-broad read. */
function buildPoll(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'poll-1',
    event_id: EVENT_ID,
    question_text: 'Which feature should we build next?',
    status: 'open',
    display_order: 0,
    results_visibility: 'show_always',
    // A leaked identity field on the poll — must never render (Req 8.6).
    participant_identifier: PARTICIPANT_SENTINEL,
    options: [
      {
        id: 'opt-a',
        poll_id: 'poll-1',
        text: 'Dark mode',
        display_order: 0,
        response_count: 3,
        // A leaked identity field on an option — must never render (Req 8.6).
        participant_identifier: PARTICIPANT_SENTINEL,
      },
      {
        id: 'opt-b',
        poll_id: 'poll-1',
        text: 'Offline support',
        display_order: 1,
        response_count: 1,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  readActivePoll.mockReset();
  submitPollResponse.mockReset();
  subscribeToPollResults.mockReset();
  // Default: a no-op unsubscribe.
  subscribeToPollResults.mockReturnValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('PollCard — single-choice selection & change-of-choice (Req 5.7)', () => {
  it('clicking an option calls submitPollResponse once; clicking a different option calls it again (upsert-replace), and aria-checked reflects the selection', async () => {
    const user = userEvent.setup();
    readActivePoll.mockResolvedValue(buildPoll());
    submitPollResponse.mockResolvedValue(undefined);

    render(<PollCard eventId={EVENT_ID} eventStatus="live" />);

    // The interactive radio-style options render once the read resolves.
    const group = await screen.findByTestId('poll-options');
    const options = within(group).getAllByRole('radio');
    expect(options).toHaveLength(2);
    const [darkMode, offline] = options;

    // Initially nothing is selected.
    expect(darkMode).toHaveAttribute('aria-checked', 'false');
    expect(offline).toHaveAttribute('aria-checked', 'false');

    // Select the first option → submit called once with (pollId, optionId).
    await user.click(darkMode);
    await waitFor(() => expect(submitPollResponse).toHaveBeenCalledTimes(1));
    expect(submitPollResponse).toHaveBeenNthCalledWith(1, 'poll-1', 'opt-a');

    // aria-checked reflects the selection.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('poll-options')).getAllByRole('radio')[0],
      ).toHaveAttribute('aria-checked', 'true'),
    );

    // Change to a DIFFERENT option → submit called again with the new optionId
    // (the server performs the atomic upsert-replace change-of-choice).
    await user.click(
      within(screen.getByTestId('poll-options')).getAllByRole('radio')[1],
    );
    await waitFor(() => expect(submitPollResponse).toHaveBeenCalledTimes(2));
    expect(submitPollResponse).toHaveBeenNthCalledWith(2, 'poll-1', 'opt-b');

    // The selection moved to the second option (single-choice — one active).
    await waitFor(() => {
      const radios = within(screen.getByTestId('poll-options')).getAllByRole(
        'radio',
      );
      expect(radios[0]).toHaveAttribute('aria-checked', 'false');
      expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('re-tapping the already-selected option is a no-op (does not re-submit)', async () => {
    const user = userEvent.setup();
    readActivePoll.mockResolvedValue(buildPoll());
    submitPollResponse.mockResolvedValue(undefined);

    render(<PollCard eventId={EVENT_ID} eventStatus="live" />);

    const group = await screen.findByTestId('poll-options');
    const darkMode = within(group).getAllByRole('radio')[0];

    await user.click(darkMode);
    await waitFor(() => expect(submitPollResponse).toHaveBeenCalledTimes(1));

    // Tap the same option again — no additional submit.
    await user.click(
      within(screen.getByTestId('poll-options')).getAllByRole('radio')[0],
    );
    // Give any (unexpected) async submit a chance to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(submitPollResponse).toHaveBeenCalledTimes(1);
  });
});

describe('PollCard — results visibility gating (Req 5.11)', () => {
  it('hides results for a still-open hide_until_closed poll (placeholder shown, results list absent)', async () => {
    readActivePoll.mockResolvedValue(
      buildPoll({ status: 'open', results_visibility: 'hide_until_closed' }),
    );

    render(<PollCard eventId={EVENT_ID} eventStatus="live" />);

    // The hidden-results placeholder is shown...
    expect(
      await screen.findByTestId('poll-results-hidden'),
    ).toBeInTheDocument();
    // ...and the accessible results list is NOT rendered.
    expect(screen.queryByTestId('poll-results-list')).toBeNull();
  });

  it('reveals the results list for a closed hide_until_closed poll', async () => {
    readActivePoll.mockResolvedValue(
      buildPoll({ status: 'closed', results_visibility: 'hide_until_closed' }),
    );

    render(<PollCard eventId={EVENT_ID} eventStatus="live" />);

    // Results are revealed once the poll is closed: the accessible list shows.
    const list = await screen.findByTestId('poll-results-list');
    expect(list).toBeInTheDocument();
    expect(within(list).getByText('Dark mode')).toBeInTheDocument();
    expect(within(list).getByText('Offline support')).toBeInTheDocument();
    // The hidden placeholder is gone.
    expect(screen.queryByTestId('poll-results-hidden')).toBeNull();
  });

  it('reveals the results list for a show_always open poll', async () => {
    readActivePoll.mockResolvedValue(
      buildPoll({ status: 'open', results_visibility: 'show_always' }),
    );

    render(<PollCard eventId={EVENT_ID} eventStatus="live" />);

    const list = await screen.findByTestId('poll-results-list');
    expect(list).toBeInTheDocument();
    expect(screen.queryByTestId('poll-results-hidden')).toBeNull();
  });
});

describe('PollCard — no participant identifier reaches the DOM (Req 8.6)', () => {
  it('never renders a participant_identifier even when the poll/options carry one', async () => {
    // A revealed (show_always) poll so the results list + chart also render;
    // this maximises the surface area that could leak the sentinel.
    readActivePoll.mockResolvedValue(
      buildPoll({ status: 'open', results_visibility: 'show_always' }),
    );

    const { container } = render(
      <PollCard eventId={EVENT_ID} eventStatus="live" />,
    );

    // The results list renders (revealed for a show_always poll); "Dark mode"
    // appears both as an interactive option and in the results list, so scope
    // the assertion to the accessible results list to stay unambiguous.
    const list = await screen.findByTestId('poll-results-list');
    expect(within(list).getByText('Dark mode')).toBeInTheDocument();
    expect(within(list).getByText('Offline support')).toBeInTheDocument();

    // ...but the sentinel participant identifier is NOWHERE in the DOM.
    expect(container.innerHTML).not.toContain(PARTICIPANT_SENTINEL);
    expect(screen.queryByText(PARTICIPANT_SENTINEL)).toBeNull();
  });
});
