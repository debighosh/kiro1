/**
 * Tests for the `/e/:eventRef` audience event view + participation gating
 * (task 14.4).
 *
 * These mock `../lib/eventLookup`'s `findEventByRef` (so event resolution is
 * deterministic and no real Supabase anon client / network is involved —
 * importing the real lookup transitively loads `../lib/supabaseClient`, which
 * throws unless VITE_SUPABASE_* is set) and `../lib/participant`'s
 * `getParticipantIdentifier` (so we can assert the identifier is established on
 * entry AND that its value is NEVER rendered to the DOM). `participationGate`
 * is exercised through the real (pure) predicate.
 *
 * They verify the behaviours Req 2.6 / 2.8 / 1.9 / 8.6 / 24.8 / 24.7 mandate:
 *   (a) a LIVE event shows the event name, a "Live" status text, and the
 *       participation area / Q&A section with navigation to the Q&A / poll /
 *       word-cloud views (Req 2.6);
 *   (b) a NON-LIVE event (surfaced as not-found for anonymous readers) shows
 *       the unavailable/closed state and WITHHOLDS all participation controls —
 *       no Q&A section / mount point is rendered (Req 2.8, 1.9);
 *   (c) the participant identifier is established on entry via
 *       `getParticipantIdentifier` but NEVER appears in the DOM (Req 8.6, 24.8).
 *
 * Design: Frontend Design (Route map — `/e/:eventRef`); Request/data flows
 * (Audience join).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// `EventView` lives in `./screens`, which also imports `../lib/auth` (for the
// AdminLogin screen). The real auth module transitively loads the Supabase anon
// client, which throws unless VITE_SUPABASE_* is set. Fully replace it with a
// self-contained stub so importing `./screens` never touches the network/env.
vi.mock('../lib/auth', () => ({
  signInWithPassword: vi.fn(),
  ensureAdminProfile: vi.fn(),
  AdminAuthError: class AdminAuthError extends Error {},
}));

// Mock the anon lookup so resolution is deterministic (no Supabase client).
const findEventByRef = vi.fn();
vi.mock('../lib/eventLookup', () => ({
  findEventByRef: (ref: string) => findEventByRef(ref),
}));

// Mock the participant identity module so we can (a) assert it is called on
// entry and (b) use a distinctive sentinel value we can search for in the DOM
// to prove it is never rendered (Req 8.6, 24.8).
const PARTICIPANT_SENTINEL = 'PARTICIPANT_SECRET_abcdef0123456789';
const getParticipantIdentifier = vi.fn(() => PARTICIPANT_SENTINEL);
vi.mock('../lib/participant', () => ({
  getParticipantIdentifier: () => getParticipantIdentifier(),
}));

// `EventView` now mounts `QuestionSubmissionForm` into the Q&A section for a
// live event (task 15.1). That component imports `../lib/questions`, which
// transitively loads `../lib/supabaseClient` (throws unless VITE_SUPABASE_* is
// set). Stub the submit helper so importing the screen never touches env/network;
// the form's own behaviour is covered by QuestionSubmissionForm.test.tsx.
vi.mock('../lib/questions', () => ({
  submitQuestion: vi.fn(),
  QuestionError: class QuestionError extends Error {},
  QUESTION_TEXT_MAX: 300,
  QUESTION_LENGTH_MESSAGE:
    'Your question must be between 1 and 300 characters.',
  countQuestionCodePoints: (v: string) => [...v].length,
  // task 15.2: `QuestionListAndVoting` (also mounted in the live Q&A section)
  // reads the list on mount and toggles votes. Stub the read/vote helpers so
  // importing the screen stays env/network-free; the component's own behaviour
  // is covered by its dedicated tests (task 15.4).
  readAudienceQuestions: vi.fn().mockResolvedValue([]),
  castQuestionVote: vi.fn().mockResolvedValue(0),
  removeQuestionVote: vi.fn().mockResolvedValue(0),
  DEFAULT_QUESTION_SORT: 'most_votes',
  // task 15.3: the live Q&A section wires `useRealtimeChannel`, which calls
  // `subscribeToEventQuestions` (→ the real supabase client). Stub it to a
  // no-op unsubscribe so importing the screen stays env/network-free; the
  // hook's own behaviour is covered by its dedicated tests (task 15.4).
  subscribeToEventQuestions: vi.fn(() => () => {}),
}));

// `./screens` also imports `../lib/presenter` (for the `PresenterView` screen,
// task 17.1), which transitively loads `../lib/supabaseClient` (throws unless
// VITE_SUPABASE_* is set). Stub the presenter reads so importing the screen
// never touches env/network; `PresenterView` behaviour is covered by
// PresenterView.test.tsx. `isPresenterMode` is preserved as a real guard.
vi.mock('../lib/presenter', () => ({
  readPresenterQuestions: vi.fn().mockResolvedValue([]),
  readFeaturedQuestion: vi.fn().mockResolvedValue(null),
  // task 24.1: `PresenterView` also reads the active poll + word cloud for the
  // M3 presenter modes. Stub them to the empty defaults so importing the screen
  // stays env/network-free.
  readPresenterActivePoll: vi.fn().mockResolvedValue(null),
  readPresenterWordCloud: vi
    .fn()
    .mockResolvedValue({ prompt: null, responses: [] }),
  subscribeToPresenter: () => () => {},
  isPresenterMode: (v: unknown) =>
    typeof v === 'string' &&
    [
      'join',
      'featured_question',
      'top_questions',
      'poll_results',
      'word_cloud',
      'ai_themes',
      'waiting',
    ].includes(v),
}));

// `./screens` also imports the shared browser Supabase client directly (for the
// `PresenterView` realtime subscription, task 17.1). Constructing the real
// client throws unless VITE_SUPABASE_* is set, so stub it with the minimal
// surface `./screens` touches (a chainable Realtime channel). No network/env.
vi.mock('../lib/supabaseClient', () => {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
    unsubscribe: vi.fn(),
  };
  return {
    supabase: {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    },
  };
});

import { EventView } from './screens';

const LIVE_EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'MSS AI Demo Day 2026',
  slug: 'demo-day',
  status: 'live' as const,
};

/** Renders the EventView under a route so `useParams()` resolves `:eventRef`. */
function renderEventView(ref = 'demo-day'): void {
  render(
    <MemoryRouter initialEntries={[`/e/${ref}`]}>
      <Routes>
        <Route path="/e/:eventRef" element={<EventView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  findEventByRef.mockReset();
  getParticipantIdentifier.mockReset();
  getParticipantIdentifier.mockReturnValue(PARTICIPANT_SENTINEL);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('EventView — live event (Req 2.6)', () => {
  it('shows the event name, a "Live" status text, and the participation / Q&A area with view navigation', async () => {
    findEventByRef.mockResolvedValue(LIVE_EVENT);

    renderEventView();

    // Name (Req 2.6).
    expect(
      await screen.findByRole('heading', { name: LIVE_EVENT.name }),
    ).toBeInTheDocument();

    // Status shown as TEXT (non-colour-only) — "Live" (Req 2.6, 24.4).
    expect(screen.getByTestId('event-status')).toHaveTextContent('Live');

    // Participation area + Q&A section present (Req 2.6, 2.8).
    expect(screen.getByTestId('participation-area')).toBeInTheDocument();
    expect(screen.getByTestId('qa-section')).toBeInTheDocument();
    // Clearly-marked mount point for tasks 15.x.
    expect(screen.getByTestId('qa-mount-point')).toBeInTheDocument();

    // Navigation to the Q&A / poll / word-cloud views (Req 2.6).
    expect(screen.getByRole('tab', { name: 'Q&A' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Poll' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Word cloud' })).toBeInTheDocument();

    // The gated/closed notice must NOT be present for a live event.
    expect(
      screen.queryByTestId('participation-closed'),
    ).not.toBeInTheDocument();
  });

  it('switches the active interaction when a view tab is selected (Req 2.6)', async () => {
    findEventByRef.mockResolvedValue(LIVE_EVENT);
    const user = userEvent.setup();

    renderEventView();

    await screen.findByRole('heading', { name: LIVE_EVENT.name });

    // Q&A is active by default.
    expect(screen.getByTestId('active-interaction')).toHaveTextContent('Q&A');

    await user.click(screen.getByRole('tab', { name: 'Poll' }));

    expect(screen.getByTestId('active-interaction')).toHaveTextContent('Poll');
    expect(screen.getByTestId('poll-section')).toBeInTheDocument();
    // The Q&A section (and its submit mount point) is no longer shown.
    expect(screen.queryByTestId('qa-section')).not.toBeInTheDocument();
  });
});

describe('EventView — participation gating (Req 2.8, 1.9)', () => {
  it('shows the unavailable/closed state and WITHHOLDS participation controls when the event is not resolvable', async () => {
    // Anonymous readers can only see live events via RLS, so a non-live or
    // unknown event resolves to null.
    findEventByRef.mockResolvedValue(null);

    renderEventView('ended-or-unknown');

    // Unavailable heading is shown (Req 2.8, 1.9).
    expect(
      await screen.findByRole('heading', { name: /event unavailable/i }),
    ).toBeInTheDocument();

    // NO participation controls: no Q&A section, no mount point, no view tabs.
    expect(screen.queryByTestId('participation-area')).not.toBeInTheDocument();
    expect(screen.queryByTestId('qa-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('qa-mount-point')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Q&A' })).not.toBeInTheDocument();
  });
});

describe('EventView — participant identity (Req 8.6, 24.8)', () => {
  it('establishes the participant identifier on entry but never renders it to the DOM', async () => {
    findEventByRef.mockResolvedValue(LIVE_EVENT);

    const { container } = render(
      <MemoryRouter initialEntries={['/e/demo-day']}>
        <Routes>
          <Route path="/e/:eventRef" element={<EventView />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: LIVE_EVENT.name });

    // The identifier was established on entry (Req 2.3/2.4/2.7 groundwork).
    await waitFor(() => {
      expect(getParticipantIdentifier).toHaveBeenCalled();
    });

    // ...but its value is NEVER surfaced anywhere in the rendered DOM
    // (Req 8.6, 24.8). Assert the sentinel appears in neither the text content
    // nor any attribute of the rendered tree.
    expect(container.innerHTML).not.toContain(PARTICIPANT_SENTINEL);
    expect(document.body.textContent ?? '').not.toContain(PARTICIPANT_SENTINEL);
  });
});
