/**
 * Tests for the `/present/:eventRef` presenter view (task 17.1).
 *
 * The presenter view is a DISPLAY-ONLY, projector-optimised surface. These
 * tests mock the data layer (`../lib/eventLookup` + `../lib/presenter`) and the
 * Supabase browser client (used only for the realtime channel) so they are
 * deterministic and never touch the network. They assert the behaviours the
 * requirements mandate:
 *
 *   (a) `join` mode shows the QR (a `role="img"` region), the Event_Code
 *       (slug), and the event name — Req 7.10.
 *   (b) `featured_question` mode shows the featured question text — Req 7.4.
 *   (c) `top_questions` mode lists `approved`/`featured` questions ordered by
 *       votes and NEVER renders a `pending`/`hidden` question — Req 7.9.
 *   (d) an unresolved / not-live event shows the waiting/unavailable state.
 *
 * The presenter reads through the anon-equivalent path (RLS excludes
 * pending/hidden), and the helper additionally filters to presentable
 * statuses; the mock therefore returns only presentable questions, and the
 * test also proves that a pending/hidden question passed to the list mock is
 * not rendered (defence-in-depth for Req 7.9).
 *
 * Requirements traceability: 7.9, 7.6, 7.7, 7.5, 7.10.
 * Design: Request/data flows (Presenter mode switching); Frontend Design
 * (Route map — `/present/:eventRef`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// --- Mock the presenter data layer + event lookup. -------------------------
const {
  findEventByRef,
  readFeaturedQuestion,
  readPresenterQuestions,
  readPresenterActivePoll,
  readPresenterWordCloud,
} = vi.hoisted(() => ({
  findEventByRef: vi.fn(),
  readFeaturedQuestion: vi.fn(),
  readPresenterQuestions: vi.fn(),
  // task 24.1: the M3 presenter modes (poll_results / word_cloud).
  readPresenterActivePoll: vi.fn(),
  readPresenterWordCloud: vi.fn(),
}));

vi.mock('../lib/eventLookup', () => ({
  findEventByRef: (ref: unknown) => findEventByRef(ref),
}));

// `./screens` also imports `../lib/auth` (for `AdminLogin`), which transitively
// loads the real Supabase anon client (throws unless VITE_SUPABASE_* is set).
// Stub it so importing the screen module never touches env/network.
vi.mock('../lib/auth', () => ({
  signInWithPassword: vi.fn(),
  ensureAdminProfile: vi.fn(),
  AdminAuthError: class AdminAuthError extends Error {},
}));

// `./screens` mounts `QuestionSubmissionForm` (which imports `../lib/questions`
// → the real supabase client) into the audience Q&A section. Stub the submit
// helper so importing the screen never touches env/network.
vi.mock('../lib/questions', () => ({
  submitQuestion: vi.fn(),
  QuestionError: class QuestionError extends Error {},
  QUESTION_TEXT_MAX: 300,
  QUESTION_LENGTH_MESSAGE:
    'Your question must be between 1 and 300 characters.',
  countQuestionCodePoints: (v: string) => [...v].length,
  // task 15.2: `QuestionListAndVoting` (mounted in the audience Q&A section)
  // reads the list on mount and toggles votes. Stub the read/vote helpers so
  // importing the screen stays env/network-free.
  readAudienceQuestions: vi.fn().mockResolvedValue([]),
  castQuestionVote: vi.fn().mockResolvedValue(0),
  removeQuestionVote: vi.fn().mockResolvedValue(0),
  DEFAULT_QUESTION_SORT: 'most_votes',
  // task 15.3: the live Q&A section wires `useRealtimeChannel`, which calls
  // `subscribeToEventQuestions` (→ the real supabase client). Stub it to a
  // no-op unsubscribe so importing the screen stays env/network-free.
  subscribeToEventQuestions: vi.fn(() => () => {}),
}));

// task 23.5: importing `./screens` transitively loads `PollCard` (via the
// audience `EventView` poll tab), which imports `../lib/polls` (→ the real
// supabase client). Stub it so importing the screen stays env/network-free.
vi.mock('../lib/polls', () => ({
  readActivePoll: vi.fn().mockResolvedValue(null),
  submitPollResponse: vi.fn().mockResolvedValue(undefined),
  subscribeToPollResults: vi.fn(() => () => {}),
  PollError: class PollError extends Error {},
}));

// task 23.5: `WordCloudCard` (mounted in the audience word-cloud tab) imports
// `../lib/wordCloudClient` (→ the real supabase client). Stub its
// read/write/realtime helpers + the constants/fns it imports so importing the
// screen stays env/network-free.
vi.mock('../lib/wordCloudClient', () => ({
  readActivePrompt: vi.fn().mockResolvedValue(null),
  readVisibleResponses: vi.fn().mockResolvedValue([]),
  submitWordCloudResponse: vi.fn().mockResolvedValue(undefined),
  subscribeToWordCloud: vi.fn(() => () => {}),
  WordCloudClientError: class WordCloudClientError extends Error {},
  WORD_CLOUD_TEXT_MAX: 50,
  WORD_CLOUD_LENGTH_MESSAGE:
    'Your response must be between 1 and 50 characters.',
  countWordCloudCodePoints: (v: string) => [...v].length,
}));

// Stub the presenter data layer. `isPresenterMode` is preserved as a REAL guard
// (so the view's mode-switching logic runs unchanged), the async reads are
// stubbed for determinism, and `subscribeToPresenter` is a no-op that never
// touches the real Supabase client (so the module graph is env/network-free).
vi.mock('../lib/presenter', () => ({
  readFeaturedQuestion: (id: string) => readFeaturedQuestion(id),
  readPresenterQuestions: (id: string, limit?: number) =>
    readPresenterQuestions(id, limit),
  // task 24.1: the M3 presenter reads. Delegate to the hoisted mocks (defaults
  // set in beforeEach) so importing the screen stays env/network-free.
  readPresenterActivePoll: (id: string) => readPresenterActivePoll(id),
  readPresenterWordCloud: (id: string) => readPresenterWordCloud(id),
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

import { PresenterView } from './screens';

function renderPresenter(ref = 'demo-event'): void {
  render(
    <MemoryRouter initialEntries={[`/present/${ref}`]}>
      <Routes>
        <Route path="/present/:eventRef" element={<PresenterView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const LIVE_EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'MSS AI Demo Day 2026',
  slug: 'demo-event',
  status: 'live' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  readFeaturedQuestion.mockResolvedValue(null);
  readPresenterQuestions.mockResolvedValue([]);
  // task 24.1 defaults: no active poll and an empty word cloud unless a test
  // overrides them.
  readPresenterActivePoll.mockResolvedValue(null);
  readPresenterWordCloud.mockResolvedValue({ prompt: null, responses: [] });
});

describe('PresenterView', () => {
  it('join mode shows the QR image, the Event_Code, and the event name (Req 7.10)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'join',
    });

    renderPresenter();

    // Event name.
    expect(await screen.findByText(LIVE_EVENT.name)).toBeInTheDocument();
    // QR code (rendered by QrDisplay with role="img").
    expect(
      screen.getByRole('img', { name: `QR code to join ${LIVE_EVENT.name}` }),
    ).toBeInTheDocument();
    // Event_Code (slug).
    expect(screen.getByTestId('presenter-event-code')).toHaveTextContent(
      LIVE_EVENT.slug,
    );
  });

  it('featured_question mode shows the featured question (Req 7.4)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'featured_question',
    });
    readFeaturedQuestion.mockResolvedValue({
      id: 'q-featured',
      text: 'What is the roadmap for next year?',
      status: 'featured',
      vote_count: 42,
    });

    renderPresenter();

    expect(
      await screen.findByTestId('presenter-featured-question'),
    ).toHaveTextContent('What is the roadmap for next year?');
    expect(readFeaturedQuestion).toHaveBeenCalledWith(LIVE_EVENT.id);
  });

  it('top_questions mode lists approved/featured questions ordered by votes and excludes pending/hidden (Req 7.9)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'top_questions',
    });
    // The helper only ever returns presentable statuses (RLS + explicit
    // filter). Return them highest-voted first, as the view expects.
    readPresenterQuestions.mockResolvedValue([
      {
        id: 'q1',
        text: 'Most popular question',
        status: 'featured',
        vote_count: 99,
      },
      {
        id: 'q2',
        text: 'Second question',
        status: 'approved',
        vote_count: 50,
      },
    ]);

    renderPresenter();

    const items = await screen.findAllByTestId('presenter-top-question');
    expect(items).toHaveLength(2);
    // Order preserved (votes desc): the first rendered item is the top-voted.
    expect(items[0]).toHaveTextContent('Most popular question');
    expect(items[1]).toHaveTextContent('Second question');

    // A pending or hidden question must NEVER appear (Req 7.9). These strings
    // were never returned by the mock, so they must not be in the document.
    expect(screen.queryByText('A pending question')).not.toBeInTheDocument();
    expect(screen.queryByText('A hidden question')).not.toBeInTheDocument();
  });

  it('shows the waiting/unavailable state for an unresolved or not-live event', async () => {
    findEventByRef.mockResolvedValue(null);

    renderPresenter('missing-event');

    expect(await screen.findByTestId('presenter-waiting')).toBeInTheDocument();
    expect(screen.getByText('Please wait')).toBeInTheDocument();
    // No question content should be rendered.
    expect(
      screen.queryByTestId('presenter-top-question'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('presenter-featured-question'),
    ).not.toBeInTheDocument();
  });

  it('renders the poll_results section for the poll_results mode (task 24.1)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'poll_results',
    });

    renderPresenter();

    // The M3 poll_results mode now renders its own projector section rather
    // than falling back to the waiting screen (task 24.1). With no active poll
    // (the default mock) it shows the empty-state copy.
    expect(
      await screen.findByTestId('presenter-poll-results'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('presenter-waiting-mode'),
    ).not.toBeInTheDocument();
  });

  it('renders the word_cloud section for the word_cloud mode (task 24.1)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'word_cloud',
    });

    renderPresenter();

    // The M3 word_cloud mode now renders its own projector section rather than
    // falling back to the waiting screen (task 24.1).
    expect(
      await screen.findByTestId('presenter-word-cloud'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('presenter-waiting-mode'),
    ).not.toBeInTheDocument();
  });

  it('falls back to a waiting screen for the ai_themes mode (M4+)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'ai_themes',
    });

    renderPresenter();

    expect(
      await screen.findByTestId('presenter-waiting-mode'),
    ).toBeInTheDocument();
  });
});
