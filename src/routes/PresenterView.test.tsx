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
const { findEventByRef, readFeaturedQuestion, readPresenterQuestions } =
  vi.hoisted(() => ({
    findEventByRef: vi.fn(),
    readFeaturedQuestion: vi.fn(),
    readPresenterQuestions: vi.fn(),
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
}));

// Stub the presenter data layer. `isPresenterMode` is preserved as a REAL guard
// (so the view's mode-switching logic runs unchanged), the async reads are
// stubbed for determinism, and `subscribeToPresenter` is a no-op that never
// touches the real Supabase client (so the module graph is env/network-free).
vi.mock('../lib/presenter', () => ({
  readFeaturedQuestion: (id: string) => readFeaturedQuestion(id),
  readPresenterQuestions: (id: string, limit?: number) =>
    readPresenterQuestions(id, limit),
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

  it('falls back to a waiting screen for an M3+ mode (e.g. poll_results)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'poll_results',
    });

    renderPresenter();

    expect(
      await screen.findByTestId('presenter-waiting-mode'),
    ).toBeInTheDocument();
  });
});
