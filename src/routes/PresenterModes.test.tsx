/**
 * Task 24.3 — Unit tests for the two NEW Milestone-3 presenter modes
 * (`poll_results` and `word_cloud`) of the `/present/:eventRef` view:
 *
 *   1. the presenter view SWITCHES between the two new modes when the moderator
 *      changes `active_presenter_mode` (delivered via the realtime
 *      `onModeChange` handler), and
 *   2. each mode RETAINS its last-displayed content on a simulated connection
 *      loss, showing the interruption banner beneath which the poll/terms are
 *      still present (Req 7.7).
 *
 * These complement (and do NOT edit) src/routes/PresenterView.test.tsx, which
 * asserts the M2 modes + that the M3 modes render their sections. This file
 * REPLICATES that file's `vi.mock` setup so importing `./screens` stays
 * env/network-free, but makes `subscribeToPresenter` CONTROLLABLE: instead of a
 * no-op it CAPTURES the handlers object so a test can invoke
 * `handlers.onPollResults` / `onWordCloud` / `onModeChange` /
 * `onConnectionChange` to simulate broadcasts + interruption.
 *
 * Requirements traceability: 5.11, 6.13, 7.7, 7.9, 26.1.
 * Design: Correctness Properties (Property 10); Request/data flows (Presenter
 * mode switching + realtime retain-last-content); RLS Design
 * (`word_cloud_responses`, `polls`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// --- Mock the presenter data layer + event lookup. -------------------------
const {
  findEventByRef,
  readFeaturedQuestion,
  readPresenterQuestions,
  readPresenterActivePoll,
  readPresenterWordCloud,
  subscribeToPresenter,
} = vi.hoisted(() => ({
  findEventByRef: vi.fn(),
  readFeaturedQuestion: vi.fn(),
  readPresenterQuestions: vi.fn(),
  readPresenterActivePoll: vi.fn(),
  readPresenterWordCloud: vi.fn(),
  // task 24.3: a controllable subscribe that captures the latest handlers so a
  // test can drive realtime callbacks (broadcasts, mode change, interruption).
  subscribeToPresenter: vi.fn(),
}));

vi.mock('../lib/eventLookup', () => ({
  findEventByRef: (ref: unknown) => findEventByRef(ref),
}));

// `./screens` imports `../lib/auth` (for `AdminLogin`), which transitively
// loads the real Supabase anon client (throws unless VITE_SUPABASE_* is set).
vi.mock('../lib/auth', () => ({
  signInWithPassword: vi.fn(),
  ensureAdminProfile: vi.fn(),
  AdminAuthError: class AdminAuthError extends Error {},
}));

// `./screens` mounts `QuestionSubmissionForm`/`QuestionListAndVoting` (→
// `../lib/questions` → the real supabase client). Stub the helpers.
vi.mock('../lib/questions', () => ({
  submitQuestion: vi.fn(),
  QuestionError: class QuestionError extends Error {},
  QUESTION_TEXT_MAX: 300,
  QUESTION_LENGTH_MESSAGE:
    'Your question must be between 1 and 300 characters.',
  countQuestionCodePoints: (v: string) => [...v].length,
  readAudienceQuestions: vi.fn().mockResolvedValue([]),
  castQuestionVote: vi.fn().mockResolvedValue(0),
  removeQuestionVote: vi.fn().mockResolvedValue(0),
  DEFAULT_QUESTION_SORT: 'most_votes',
  subscribeToEventQuestions: vi.fn(() => () => {}),
}));

// `PollCard` (audience poll tab) imports `../lib/polls` (→ real supabase
// client). Stub it so importing the screen stays env/network-free.
vi.mock('../lib/polls', () => ({
  readActivePoll: vi.fn().mockResolvedValue(null),
  submitPollResponse: vi.fn().mockResolvedValue(undefined),
  subscribeToPollResults: vi.fn(() => () => {}),
  PollError: class PollError extends Error {},
}));

// `WordCloudCard` (audience word-cloud tab) imports `../lib/wordCloudClient`
// (→ real supabase client). Stub its read/write/realtime helpers + constants.
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

// Stub the presenter data layer. `isPresenterMode` stays a REAL guard so the
// view's mode-switching logic runs unchanged; the async reads are stubbed for
// determinism; `subscribeToPresenter` is the CONTROLLABLE hoisted mock so tests
// can invoke the captured handlers to simulate broadcasts + interruption.
vi.mock('../lib/presenter', () => ({
  readFeaturedQuestion: (id: string) => readFeaturedQuestion(id),
  readPresenterQuestions: (id: string, limit?: number) =>
    readPresenterQuestions(id, limit),
  readPresenterActivePoll: (id: string) => readPresenterActivePoll(id),
  readPresenterWordCloud: (id: string) => readPresenterWordCloud(id),
  subscribeToPresenter: (id: string, handlers: unknown) =>
    subscribeToPresenter(id, handlers),
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

// task 34.3: `./screens` imports `../lib/aiClient` (presenter `ai_themes` mode
// + moderation-queue categorisation). Stub the surface so importing the screen
// stays env/network-free. These tests exercise the M3 poll/word-cloud modes,
// not ai_themes, so a default empty (has_data:false) result is sufficient.
vi.mock('../lib/aiClient', () => ({
  runThemeInsights: vi.fn().mockResolvedValue({
    available: true,
    insights: {
      top_themes: [],
      emerging_concerns: [],
      frequent_topics: [],
      notable_high_vote_questions: [],
      has_data: false,
    },
  }),
  AiClientError: class AiClientError extends Error {},
}));

import { PresenterView } from './screens';

/**
 * The handler set the last `subscribeToPresenter` call captured, so a test can
 * drive realtime callbacks. Typed loosely (the concrete shape lives in
 * `../lib/presenter`, which is mocked here).
 */
interface CapturedHandlers {
  onModeChange: (mode: string) => void;
  onQuestionsChange: () => void;
  onConnectionChange: (interrupted: boolean) => void;
  onPollResults?: (payload: unknown) => void;
  onWordCloud?: (payload: unknown) => void;
}

let capturedHandlers: CapturedHandlers | null = null;

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

const OPEN_SHOW_ALWAYS_POLL = {
  id: 'poll-1',
  question_text: 'Which track are you most excited for?',
  status: 'open' as const,
  results_visibility: 'show_always' as const,
  options: [
    { id: 'opt-a', text: 'Applied AI', display_order: 0, response_count: 3 },
    { id: 'opt-b', text: 'Infra', display_order: 1, response_count: 1 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers = null;
  // Defaults: no featured/top content, empty M3 content unless overridden.
  readFeaturedQuestion.mockResolvedValue(null);
  readPresenterQuestions.mockResolvedValue([]);
  readPresenterActivePoll.mockResolvedValue(null);
  readPresenterWordCloud.mockResolvedValue({ prompt: null, responses: [] });
  // Capture the handlers on subscribe; return a no-op unsubscribe.
  subscribeToPresenter.mockImplementation(
    (_id: string, handlers: CapturedHandlers) => {
      capturedHandlers = handlers;
      return () => {};
    },
  );
});

afterEach(() => {
  cleanup();
});

describe('PresenterView — Milestone-3 modes (poll_results / word_cloud)', () => {
  it('poll_results mode: renders tallies, updates on a poll_results broadcast, and RETAINS content on connection loss (Req 5.11, 7.7)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'poll_results',
    });
    readPresenterActivePoll.mockResolvedValue(OPEN_SHOW_ALWAYS_POLL);

    renderPresenter();

    // Section + initial tallies render (show_always → visible while open).
    expect(
      await screen.findByTestId('presenter-poll-results'),
    ).toBeInTheDocument();
    const options = await screen.findAllByTestId('presenter-poll-option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Applied AI');
    expect(options[0]).toHaveTextContent('3');

    // A realtime poll_results broadcast updates a per-option count in place.
    expect(capturedHandlers).not.toBeNull();
    act(() => {
      capturedHandlers?.onPollResults?.({
        event_id: LIVE_EVENT.id,
        poll_id: 'poll-1',
        options: [
          { option_id: 'opt-a', response_count: 42 },
          { option_id: 'opt-b', response_count: 1 },
        ],
      });
    });
    const updated = await screen.findAllByTestId('presenter-poll-option');
    expect(updated[0]).toHaveTextContent('42');

    // Simulate a connection loss: banner appears AND the poll content is
    // STILL present beneath it (retain-last-content, Req 7.7).
    act(() => {
      capturedHandlers?.onConnectionChange(true);
    });
    expect(
      await screen.findByTestId('presenter-interruption'),
    ).toBeInTheDocument();
    const retained = screen.getAllByTestId('presenter-poll-option');
    expect(retained[0]).toHaveTextContent('42');
    expect(
      screen.getByText(OPEN_SHOW_ALWAYS_POLL.question_text),
    ).toBeInTheDocument();
  });

  it('word_cloud mode: renders terms, updates on a word_cloud broadcast, and RETAINS terms on connection loss (Req 6.13, 7.7, 7.9)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'word_cloud',
    });
    // The RLS-backed read returns ONLY visible responses; aggregateWordCloud
    // also drops any is_hidden === true (none here).
    readPresenterWordCloud.mockResolvedValue({
      prompt: {
        id: 'wc-1',
        prompt_text: 'One word for today',
        status: 'open',
        results_visible_while_collecting: true,
      },
      responses: [
        { normalised_text: 'ai', is_hidden: false },
        { normalised_text: 'ai', is_hidden: false },
        { normalised_text: 'cloud', is_hidden: false },
        // A hidden entry must NEVER surface in the presenter cloud (Req 6.13).
        { normalised_text: 'secret', is_hidden: true },
      ],
    });

    renderPresenter();

    expect(
      await screen.findByTestId('presenter-word-cloud'),
    ).toBeInTheDocument();
    const initialTerms = await screen.findAllByTestId(
      'presenter-word-cloud-term',
    );
    const initialText = initialTerms.map((t) => t.textContent);
    expect(initialText).toContain('ai');
    expect(initialText).toContain('cloud');
    // The hidden entry is excluded.
    expect(initialText).not.toContain('secret');

    // A realtime word_cloud broadcast refreshes the sized terms.
    expect(capturedHandlers).not.toBeNull();
    act(() => {
      capturedHandlers?.onWordCloud?.({
        event_id: LIVE_EVENT.id,
        prompt_id: 'wc-1',
        terms: [
          { term: 'edge', frequency: 5 },
          { term: 'data', frequency: 2 },
        ],
      });
    });
    await screen.findByText('edge');
    const afterBroadcast = screen
      .getAllByTestId('presenter-word-cloud-term')
      .map((t) => t.textContent);
    expect(afterBroadcast).toContain('edge');
    expect(afterBroadcast).toContain('data');

    // Connection loss: banner appears AND the terms are retained (Req 7.7).
    act(() => {
      capturedHandlers?.onConnectionChange(true);
    });
    expect(
      await screen.findByTestId('presenter-interruption'),
    ).toBeInTheDocument();
    const retained = screen
      .getAllByTestId('presenter-word-cloud-term')
      .map((t) => t.textContent);
    expect(retained).toContain('edge');
    expect(retained).toContain('data');
  });

  it('switches from poll_results to word_cloud when the moderator changes the mode (onModeChange)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'poll_results',
    });
    readPresenterActivePoll.mockResolvedValue(OPEN_SHOW_ALWAYS_POLL);
    readPresenterWordCloud.mockResolvedValue({
      prompt: {
        id: 'wc-1',
        prompt_text: 'One word for today',
        status: 'open',
        results_visible_while_collecting: true,
      },
      responses: [{ normalised_text: 'ai', is_hidden: false }],
    });

    renderPresenter();

    // Starts in poll_results.
    expect(
      await screen.findByTestId('presenter-poll-results'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('presenter-word-cloud'),
    ).not.toBeInTheDocument();

    // Moderator switches the active presenter mode to word_cloud.
    expect(capturedHandlers).not.toBeNull();
    act(() => {
      capturedHandlers?.onModeChange('word_cloud');
    });

    // The view switches to the word_cloud section (and drops poll_results).
    expect(
      await screen.findByTestId('presenter-word-cloud'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('presenter-poll-results'),
    ).not.toBeInTheDocument();
  });

  it('switches from word_cloud to poll_results when the moderator changes the mode (onModeChange)', async () => {
    findEventByRef.mockResolvedValue({
      ...LIVE_EVENT,
      active_presenter_mode: 'word_cloud',
    });
    readPresenterWordCloud.mockResolvedValue({
      prompt: {
        id: 'wc-1',
        prompt_text: 'One word for today',
        status: 'open',
        results_visible_while_collecting: true,
      },
      responses: [{ normalised_text: 'ai', is_hidden: false }],
    });
    readPresenterActivePoll.mockResolvedValue(OPEN_SHOW_ALWAYS_POLL);

    renderPresenter();

    expect(
      await screen.findByTestId('presenter-word-cloud'),
    ).toBeInTheDocument();

    act(() => {
      capturedHandlers?.onModeChange('poll_results');
    });

    expect(
      await screen.findByTestId('presenter-poll-results'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('presenter-word-cloud'),
    ).not.toBeInTheDocument();
  });
});
