/**
 * Accessibility invariant tests — Task 40.4 (Wave 47).
 *
 * Uses jsdom + @testing-library/react to assert structural accessibility
 * invariants across the main interactive surfaces. No source files are
 * modified; only the behaviour visible in the rendered DOM is asserted.
 *
 * Requirements covered:
 *   Req 24.4 — Status is conveyed with a non-colour indicator (text/icon),
 *              never by colour alone.
 *   Req 24.5 — Form fields/controls expose non-empty accessible names.
 *   Req 24.6 — Reduced-motion path disables non-essential animation.
 *   Req 24.7 — Async surfaces render loading/empty/success/error states +
 *              a retry action on error.
 *   Req 24.8 — No Participant_Identifier string reaches the DOM.
 *   Req 26.1 — Tests validate behaviour mandated by the requirements.
 *
 * Design references: Frontend Design (Accessibility & UX states); Testing
 * Strategy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// ===========================================================================
// SHARED MOCK HELPERS
// ===========================================================================

/**
 * Install a minimal `window.matchMedia` stub.  Returns `true` for
 * `(prefers-reduced-motion: reduce)` when `reduceMotion` is `true`, so the
 * `usePrefersReducedMotion` hook can be exercised in jsdom.
 */
function mockMatchMedia(reduceMotion: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const matches =
        reduceMotion && query === '(prefers-reduced-motion: reduce)';
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(), // legacy
        removeListener: vi.fn(), // legacy
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    },
  });
}

// ===========================================================================
// Req 24.5 — ACCESSIBLE LABELS
// ===========================================================================

// ---------------------------------------------------------------------------
// AdminLogin (email + password inputs, submit button)
// ---------------------------------------------------------------------------
//
// AdminLogin is exported from ./routes/screens and pulling the whole module
// requires stubbing a large number of transitive dependencies.  We replicate
// only the stubs that are already present in AdminLogin.test.tsx so importing
// ./routes/screens succeeds without env vars.
// ---------------------------------------------------------------------------

vi.mock('./lib/auth', () => ({
  signInWithPassword: vi.fn(),
  ensureAdminProfile: vi
    .fn()
    .mockResolvedValue({ status: 'provision_deferred', profile: null }),
  AdminAuthError: class AdminAuthError extends Error {},
}));

vi.mock('./lib/eventLookup', () => ({
  findEventByRef: vi.fn().mockResolvedValue(null),
}));

vi.mock('./lib/presenter', () => ({
  readPresenterQuestions: vi.fn().mockResolvedValue([]),
  readFeaturedQuestion: vi.fn().mockResolvedValue(null),
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

vi.mock('./lib/polls', () => ({
  readActivePoll: vi.fn().mockResolvedValue(null),
  submitPollResponse: vi.fn().mockResolvedValue(undefined),
  subscribeToPollResults: vi.fn(() => () => {}),
  PollError: class PollError extends Error {},
}));

vi.mock('./lib/wordCloudClient', () => ({
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

vi.mock('./lib/questions', () => ({
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

vi.mock('./lib/supabaseClient', () => {
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

// aiClient is mocked once here; sub-tests that need different behaviour use
// vi.mocked() to adjust the return values of the already-stubbed spies.
const { runSummary, readAiProviderSettings, AiClientError } = vi.hoisted(() => {
  class AiClientError extends Error {
    kind: string;
    constructor(message: string, options: { kind: string }) {
      super(message);
      this.name = 'AiClientError';
      this.kind = options.kind;
    }
  }
  return {
    AiClientError,
    runSummary: vi.fn(),
    readAiProviderSettings: vi.fn(),
    runCategorisation: vi.fn(),
    overrideQuestionCategory: vi.fn(),
    runConnectionTest: vi.fn(),
    isSessionRecentlyVerified: vi.fn(),
    saveAiProviderSettings: vi.fn(),
    removeAiCredential: vi.fn(),
  };
});

vi.mock('./lib/aiClient', () => ({
  AiClientError,
  runSummary: (eventId: string) => runSummary(eventId),
  readAiProviderSettings: () => readAiProviderSettings(),
  runCategorisation: vi.fn().mockResolvedValue({
    available: true,
    summary: {
      candidate_count: 0,
      batch_count: 0,
      categorised_count: 0,
      rejected_batches: 0,
    },
  }),
  overrideQuestionCategory: vi.fn().mockResolvedValue({
    applied: true,
    ai_category: null,
    ai_prior_category: null,
  }),
  runConnectionTest: vi.fn(),
  isSessionRecentlyVerified: vi.fn().mockResolvedValue(false),
  saveAiProviderSettings: vi.fn(),
  removeAiCredential: vi.fn(),
  CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS: 300,
}));

// moderation is used by ModerationQueue
const { readModerationQuestions } = vi.hoisted(() => ({
  readModerationQuestions: vi.fn(),
}));

vi.mock('./lib/moderation', () => ({
  ModerationError: class ModerationError extends Error {
    kind: string;
    constructor(message: string, options: { kind: string }) {
      super(message);
      this.name = 'ModerationError';
      this.kind = options.kind;
    }
  },
  MODERATION_ACTIONS: ['approve', 'feature', 'answer', 'hide'] as const,
  MODERATION_QUESTION_STATUSES: [
    'pending',
    'approved',
    'featured',
    'answered',
    'hidden',
  ] as const,
  readModerationQuestions: (eventId: string) =>
    readModerationQuestions(eventId),
  moderateQuestion: vi.fn().mockResolvedValue(undefined),
  filterModerationQuestions: (
    questions: Array<{
      status?: string;
      ai_category?: string | null;
      text: string;
    }>,
    filter: { status?: string; category?: string; searchText?: string },
  ) =>
    questions.filter((q) => {
      if (filter.status && q.status !== filter.status) return false;
      if (filter.category && q.ai_category !== filter.category) return false;
      if (
        filter.searchText &&
        filter.searchText.trim() !== '' &&
        !q.text.toLowerCase().includes(filter.searchText.trim().toLowerCase())
      ) {
        return false;
      }
      return true;
    }),
}));

// events helper used by AdminEventEditor
const { createEvent } = vi.hoisted(() => ({
  createEvent: vi.fn(),
}));

vi.mock('./lib/events', () => {
  class EventError extends Error {
    kind: string;
    fields: { field: string; message: string }[];
    status?: number;
    constructor(
      message: string,
      options: {
        kind: string;
        fields?: { field: string; message: string }[];
        status?: number;
      },
    ) {
      super(message);
      this.name = 'EventError';
      this.kind = options.kind;
      this.fields = options.fields ?? [];
      this.status = options.status;
    }
  }
  return { createEvent: (input: unknown) => createEvent(input), EventError };
});

// useNavigate stub (AdminLogin needs navigation)
const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom',
    );
  return { ...actual, useNavigate: () => navigate };
});

// Lazy imports placed AFTER vi.mock calls so the module graph picks up stubs.
import { AdminLogin } from './routes/screens';
import { AdminEventEditor } from './routes/AdminEventEditor';
import { QuestionSubmissionForm } from './components/QuestionSubmissionForm';
import { ModerationQueue } from './routes/ModerationQueue';
import { AiSummary } from './routes/AiSummary';
import { QuestionListAndVoting } from './components/QuestionListAndVoting';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Req 24.5 — ACCESSIBLE LABELS
// Form fields and controls must expose non-empty accessible names.
// ===========================================================================

describe('Req 24.5 — Accessible labels: AdminLogin', () => {
  it('email input has an accessible name', () => {
    render(
      <MemoryRouter initialEntries={['/admin/login']}>
        <AdminLogin />
      </MemoryRouter>,
    );
    // getByLabelText only resolves when a non-empty label is associated.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('password input has an accessible name', () => {
    render(
      <MemoryRouter initialEntries={['/admin/login']}>
        <AdminLogin />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('submit button has an accessible name', () => {
    render(
      <MemoryRouter initialEntries={['/admin/login']}>
        <AdminLogin />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('button', { name: /sign in/i }),
    ).toBeInTheDocument();
  });
});

describe('Req 24.5 — Accessible labels: AdminEventEditor', () => {
  function renderEditor(): void {
    render(
      <MemoryRouter initialEntries={['/admin/events/new']}>
        <Routes>
          <Route path="/admin/events/:id" element={<AdminEventEditor />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('event name input has an accessible name', () => {
    renderEditor();
    expect(screen.getByLabelText(/event name/i)).toBeInTheDocument();
  });

  it('starts-at and ends-at datetime inputs have accessible names', () => {
    renderEditor();
    expect(screen.getByLabelText(/starts at/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ends at/i)).toBeInTheDocument();
  });

  it('submit button has an accessible name', () => {
    renderEditor();
    expect(
      screen.getByRole('button', { name: /create event/i }),
    ).toBeInTheDocument();
  });
});

describe('Req 24.5 — Accessible labels: QuestionSubmissionForm', () => {
  const EVENT_ID = '00000000-0000-4000-8000-000000000000';

  it('textarea / question input has an accessible name', () => {
    render(<QuestionSubmissionForm eventId={EVENT_ID} />);
    expect(
      screen.getByRole('textbox', { name: /ask a question/i }),
    ).toBeInTheDocument();
  });

  it('submit button has an accessible name', () => {
    render(<QuestionSubmissionForm eventId={EVENT_ID} />);
    expect(
      screen.getByRole('button', { name: /submit question/i }),
    ).toBeInTheDocument();
  });
});

// ===========================================================================
// Req 24.4 — NON-COLOUR STATUS INDICATORS
// Status is conveyed with text/icon, not by colour alone.
// ===========================================================================

describe('Req 24.4 — Non-colour status indicators: ModerationQueue', () => {
  function renderQueue(): void {
    render(
      <MemoryRouter initialEntries={['/admin/events/evt-1/moderation']}>
        <Routes>
          <Route
            path="/admin/events/:id/moderation"
            element={<ModerationQueue />}
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    readModerationQuestions.mockReset();
  });

  it('renders the "Approved" text label alongside the status badge (not colour alone)', async () => {
    readModerationQuestions.mockResolvedValue([
      {
        id: 'q-1',
        text: 'Will there be a v2?',
        status: 'approved',
        ai_category: null,
        vote_count: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'evt-1',
      },
    ]);
    renderQueue();
    // The non-colour text label "Approved" appears in the DOM.
    expect(await screen.findByText(/Approved/)).toBeInTheDocument();
  });

  it('renders the "Pending" text label for a pending question', async () => {
    readModerationQuestions.mockResolvedValue([
      {
        id: 'q-2',
        text: 'Is this approved yet?',
        status: 'pending',
        ai_category: null,
        vote_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'evt-1',
      },
    ]);
    renderQueue();
    expect(await screen.findByText(/Pending/)).toBeInTheDocument();
  });

  it('renders a non-colour icon character alongside the status text (double non-colour channel)', async () => {
    readModerationQuestions.mockResolvedValue([
      {
        id: 'q-3',
        text: 'What is the roadmap?',
        status: 'approved',
        ai_category: null,
        vote_count: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'evt-1',
      },
    ]);
    renderQueue();
    // The icon character "✓" appears for approved questions (statusIndicator
    // returns icon:'✓' for the 'success' kind, which maps to approved).
    await screen.findByText(/Approved/);
    // The icon span uses aria-hidden so the icon itself is in the DOM but not
    // announced by screen readers. Check it exists as a DOM node.
    const iconEl = document.querySelector('[aria-hidden="true"]');
    expect(iconEl).not.toBeNull();
    expect(iconEl?.textContent?.trim()).toMatch(/✓|ℹ|⚠/);
  });
});

// ===========================================================================
// Req 24.7 — LOADING / EMPTY / SUCCESS / ERROR STATES + RETRY
// Each async surface renders all four UX states with a retry action on error.
// ===========================================================================

describe('Req 24.7 — UX states: QuestionListAndVoting', () => {
  const EVENT_ID = 'event-a11y-test';

  it('renders a role="status" element while loading', async () => {
    // Never-resolving promise keeps the component in the loading state.
    vi.mocked(
      (await import('./lib/questions')).readAudienceQuestions as ReturnType<
        typeof vi.fn
      >,
    ).mockReturnValue(new Promise(() => {}));

    render(<QuestionListAndVoting eventId={EVENT_ID} />);

    // Loading state: the component renders multiple role="status" nodes (one
    // empty live region + one loading message). Assert at least one is present
    // and that the one with the loading text is in the DOM.
    const statusEls = screen.getAllByRole('status');
    expect(statusEls.length).toBeGreaterThanOrEqual(1);
    // The loading message itself should be present in the document.
    expect(statusEls.some((el) => el.textContent?.includes('Loading'))).toBe(
      true,
    );
  });

  it('renders the empty state when there are no questions', async () => {
    vi.mocked(
      (await import('./lib/questions')).readAudienceQuestions as ReturnType<
        typeof vi.fn
      >,
    ).mockResolvedValue([]);

    render(<QuestionListAndVoting eventId={EVENT_ID} />);

    expect(
      await screen.findByTestId('question-list-empty'),
    ).toBeInTheDocument();
  });

  it('renders a role="alert" element on a load error', async () => {
    vi.mocked(
      (await import('./lib/questions')).readAudienceQuestions as ReturnType<
        typeof vi.fn
      >,
    ).mockRejectedValue(new Error('network failure'));

    render(<QuestionListAndVoting eventId={EVENT_ID} />);

    // Error state: role="alert" (assertive announcement).
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a retry button in the error state', async () => {
    vi.mocked(
      (await import('./lib/questions')).readAudienceQuestions as ReturnType<
        typeof vi.fn
      >,
    ).mockRejectedValue(new Error('network failure'));

    render(<QuestionListAndVoting eventId={EVENT_ID} />);

    await screen.findByRole('alert');
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });
});

describe('Req 24.7 — UX states: ModerationQueue', () => {
  function renderQueue(): void {
    render(
      <MemoryRouter initialEntries={['/admin/events/evt-q/moderation']}>
        <Routes>
          <Route
            path="/admin/events/:id/moderation"
            element={<ModerationQueue />}
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    readModerationQuestions.mockReset();
  });

  it('renders a role="status" loading indicator while the queue loads', async () => {
    readModerationQuestions.mockReturnValue(new Promise(() => {}));
    renderQueue();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders a role="status" empty notice when the queue is empty', async () => {
    readModerationQuestions.mockResolvedValue([]);
    renderQueue();
    // An empty queue shows a "no questions" notice (role="status").
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/no questions/i);
  });

  it('renders a role="alert" element on a load error', async () => {
    readModerationQuestions.mockRejectedValue(new Error('DB error'));
    renderQueue();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a retry button in the error state', async () => {
    readModerationQuestions.mockRejectedValue(new Error('DB error'));
    renderQueue();
    await screen.findByRole('alert');
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });
});

describe('Req 24.7 — UX states: AiSummary', () => {
  function renderSummary(): void {
    render(
      <MemoryRouter initialEntries={['/admin/events/evt-s/summary']}>
        <Routes>
          <Route path="/admin/events/:id/summary" element={<AiSummary />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    runSummary.mockReset();
  });

  it('renders the idle/initial state with a generate button (no loading or error yet)', () => {
    renderSummary();
    expect(
      screen.getByRole('button', { name: /generate summary/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the success state (Markdown report visible) after generating', async () => {
    runSummary.mockResolvedValue({
      available: true,
      summary: {
        markdown: '## Calculated Data\n\n- Questions: 5',
        aiInterpretationAvailable: true,
        questionCount: 5,
      },
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderSummary();

    await user.click(screen.getByRole('button', { name: /generate summary/i }));
    expect(await screen.findByText(/## Calculated Data/i)).toBeInTheDocument();
  });
});

// ===========================================================================
// Req 24.6 — REDUCED-MOTION PATH
// usePrefersReducedMotion returns true when matchMedia signals reduce.
// ===========================================================================

describe('Req 24.6 — Reduced-motion path: usePrefersReducedMotion hook', () => {
  afterEach(() => {
    // Remove the matchMedia stub so subsequent tests start clean.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: undefined,
    });
  });

  it('returns false (animate) when matchMedia is absent (jsdom default)', () => {
    // jsdom does not implement matchMedia by default — the hook should return
    // the safe default of false (animate normally).
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('returns true when matchMedia reports prefers-reduced-motion: reduce', () => {
    mockMatchMedia(/* reduceMotion */ true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it('returns false when matchMedia reports no reduced-motion preference', () => {
    mockMatchMedia(/* reduceMotion */ false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});

// ===========================================================================
// Req 24.8 — NO PARTICIPANT_IDENTIFIER IN THE DOM
// Participant identifiers must never reach any rendered surface.
// ===========================================================================

/** A sentinel that must never appear in the DOM. */
const PARTICIPANT_SENTINEL = 'PARTICIPANT-ID-SENTINEL-a11y-test-9z7x';

describe('Req 24.8 — No Participant_Identifier: QuestionListAndVoting', () => {
  const EVENT_ID = 'event-pii-guard';

  it('never renders participant_identifier even when a row carries one', async () => {
    vi.mocked(
      (await import('./lib/questions')).readAudienceQuestions as ReturnType<
        typeof vi.fn
      >,
    ).mockResolvedValue([
      {
        id: 'q-pii',
        text: 'A real question text',
        status: 'approved',
        vote_count: 3,
        created_at: '2026-01-01T00:00:00.000Z',
        // Leaky field — must never reach the DOM.
        participant_identifier: PARTICIPANT_SENTINEL,
      },
    ]);

    const { container } = render(<QuestionListAndVoting eventId={EVENT_ID} />);

    // Wait for the list to render.
    await screen.findByTestId('question-list');

    // The question text is visible...
    expect(screen.getByText('A real question text')).toBeInTheDocument();

    // ...but the sentinel participant identifier is NOWHERE in the DOM.
    expect(container.innerHTML).not.toContain(PARTICIPANT_SENTINEL);
    expect(screen.queryByText(PARTICIPANT_SENTINEL)).toBeNull();
  });
});

describe('Req 24.8 — No Participant_Identifier: ModerationQueue', () => {
  function renderQueue(): ReturnType<typeof render> {
    return render(
      <MemoryRouter initialEntries={['/admin/events/evt-pii/moderation']}>
        <Routes>
          <Route
            path="/admin/events/:id/moderation"
            element={<ModerationQueue />}
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    readModerationQuestions.mockReset();
  });

  it('never renders participant_identifier even when a moderation row carries one', async () => {
    readModerationQuestions.mockResolvedValue([
      {
        id: 'q-mod-pii',
        text: 'What is the deployment strategy?',
        status: 'pending',
        ai_category: null,
        vote_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'evt-pii',
        // Leaky field — must never reach the DOM.
        participant_identifier: PARTICIPANT_SENTINEL,
      },
    ]);

    const { container } = renderQueue();

    // The question text renders...
    expect(
      await screen.findByText('What is the deployment strategy?'),
    ).toBeInTheDocument();

    // ...but the sentinel participant identifier is NOWHERE in the DOM.
    expect(container.innerHTML).not.toContain(PARTICIPANT_SENTINEL);
    expect(screen.queryByText(PARTICIPANT_SENTINEL)).toBeNull();
  });

  it('question text is rendered without exposing participant identifiers for multiple rows', async () => {
    readModerationQuestions.mockResolvedValue([
      {
        id: 'q-m1',
        text: 'First question',
        status: 'pending',
        ai_category: null,
        vote_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'evt-pii',
        participant_identifier: PARTICIPANT_SENTINEL + '-user-1',
      },
      {
        id: 'q-m2',
        text: 'Second question',
        status: 'approved',
        ai_category: null,
        vote_count: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'evt-pii',
        participant_identifier: PARTICIPANT_SENTINEL + '-user-2',
      },
    ]);

    const { container } = renderQueue();

    await screen.findByText('First question');
    expect(screen.getByText('Second question')).toBeInTheDocument();

    // Neither variant of the sentinel appears in the DOM.
    expect(container.innerHTML).not.toContain(PARTICIPANT_SENTINEL);
  });
});
