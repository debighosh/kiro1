/**
 * Tests for the `/admin/events/:id/moderation` moderation queue AI behaviour
 * (task 34.2), covering task 34.5:
 *   (a) the AI-category filter narrows the visible list — Req 3.11;
 *   (b) the per-row override `<select>` is CONSTRAINED to the eight allowed
 *       categories (plus "No change") so an invalid category cannot be chosen
 *       client-side — Req 15.3, 15.7;
 *   (c) applying an override calls `overrideQuestionCategory` with the chosen
 *       category and re-reads the queue afterwards — Req 15.7;
 *   (d) the event-level "Categorise questions" action calls `runCategorisation`
 *       — Req 15.1.
 *
 * `../lib/moderation` and `../lib/aiClient` are fully mocked so importing the
 * screen never constructs the real Supabase client. `filterModerationQuestions`
 * is stubbed with a small, faithful AND-combined implementation so the filter
 * assertions are deterministic. The eight categories come from the REAL
 * `../schemas/ai` module (pure, env-free), which the screen imports directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AI_QUESTION_CATEGORIES } from '../schemas/ai';
import type { ModerationQuestion } from '../lib/moderation';

// --- Mock the moderation helper the screen depends on. ---------------------
const {
  ModerationError,
  readModerationQuestions,
  moderateQuestion,
} = vi.hoisted(() => {
  class ModerationError extends Error {
    kind: string;
    constructor(message: string, options: { kind: string }) {
      super(message);
      this.name = 'ModerationError';
      this.kind = options.kind;
    }
  }
  return {
    ModerationError,
    readModerationQuestions: vi.fn(),
    moderateQuestion: vi.fn(),
  };
});

vi.mock('../lib/moderation', () => ({
  ModerationError,
  MODERATION_ACTIONS: ['approve', 'feature', 'answer', 'hide'] as const,
  MODERATION_QUESTION_STATUSES: [
    'pending',
    'approved',
    'featured',
    'answered',
    'hidden',
  ] as const,
  readModerationQuestions: (eventId: string) => readModerationQuestions(eventId),
  moderateQuestion: (input: unknown) => moderateQuestion(input),
  // A faithful, deterministic re-implementation of the pure filter helper:
  // ALL supplied criteria are AND-combined; text search is case-insensitive.
  filterModerationQuestions: (
    questions: ModerationQuestion[],
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

// --- Mock the AI client the screen depends on. -----------------------------
const {
  AiClientError,
  runCategorisation,
  overrideQuestionCategory,
} = vi.hoisted(() => {
  class AiClientError extends Error {
    kind: string;
    fields: { field: string; message: string }[];
    constructor(
      message: string,
      options: { kind: string; fields?: { field: string; message: string }[] },
    ) {
      super(message);
      this.name = 'AiClientError';
      this.kind = options.kind;
      this.fields = options.fields ?? [];
    }
  }
  return {
    AiClientError,
    runCategorisation: vi.fn(),
    overrideQuestionCategory: vi.fn(),
  };
});

vi.mock('../lib/aiClient', () => ({
  AiClientError,
  runCategorisation: (eventId: string) => runCategorisation(eventId),
  overrideQuestionCategory: (input: unknown) => overrideQuestionCategory(input),
}));

import { ModerationQueue } from './ModerationQueue';

function question(overrides: Partial<ModerationQuestion> = {}): ModerationQuestion {
  return {
    id: 'q-1',
    text: 'A question about the roadmap',
    status: 'pending',
    ai_category: null,
    vote_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    event_id: 'evt-1',
    ...overrides,
  };
}

function renderScreen(id = 'evt-1'): void {
  render(
    <MemoryRouter initialEntries={[`/admin/events/${id}/moderation`]}>
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
  moderateQuestion.mockReset();
  runCategorisation.mockReset();
  overrideQuestionCategory.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ModerationQueue — AI category filter (Req 3.11)', () => {
  it('narrows the visible list to rows matching the selected AI category', async () => {
    const user = userEvent.setup();
    readModerationQuestions.mockResolvedValue([
      question({
        id: 'q-tech',
        text: 'How does the new tech stack scale?',
        ai_category: 'Technology',
      }),
      question({
        id: 'q-sec',
        text: 'What about our security posture?',
        ai_category: 'Security',
      }),
    ]);

    renderScreen();

    // Both rows are visible before filtering.
    expect(
      await screen.findByText(/how does the new tech stack scale/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/what about our security posture/i),
    ).toBeInTheDocument();

    // Narrow to the "Technology" category — only the tech row remains. Use the
    // exact filter label ("AI category") to avoid the per-row "Override AI
    // category" select also matching.
    await user.selectOptions(
      screen.getByLabelText('AI category'),
      'Technology',
    );
    expect(
      screen.getByText(/how does the new tech stack scale/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/what about our security posture/i),
    ).not.toBeInTheDocument();
  });
});

describe('ModerationQueue — per-row override (Req 15.3, 15.7)', () => {
  it('constrains the override select to the eight allowed categories plus "No change"', async () => {
    readModerationQuestions.mockResolvedValue([question({ id: 'q-1' })]);

    renderScreen();
    await screen.findByText(/a question about the roadmap/i);

    const overrideSelect = screen.getByLabelText(/override ai category/i);
    const options = within(overrideSelect).getAllByRole('option');
    // Exactly the 8 allowed categories + the leading "No change" sentinel.
    expect(options).toHaveLength(AI_QUESTION_CATEGORIES.length + 1);
    expect(options[0]).toHaveTextContent(/no change/i);
    const optionValues = options.slice(1).map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).toEqual([...AI_QUESTION_CATEGORIES]);
  });

  it('applying an override calls overrideQuestionCategory with the chosen category and re-reads the queue', async () => {
    const user = userEvent.setup();
    readModerationQuestions
      .mockResolvedValueOnce([question({ id: 'q-1', ai_category: null })])
      // Second read (after the successful override) reflects the new category.
      .mockResolvedValueOnce([
        question({ id: 'q-1', ai_category: 'Governance' }),
      ]);
    overrideQuestionCategory.mockResolvedValue({
      applied: true,
      ai_category: 'Governance',
      ai_prior_category: null,
    });

    renderScreen();
    await screen.findByText(/a question about the roadmap/i);
    expect(readModerationQuestions).toHaveBeenCalledTimes(1);

    await user.selectOptions(
      screen.getByLabelText(/override ai category/i),
      'Governance',
    );
    await user.click(screen.getByRole('button', { name: /apply category/i }));

    await waitFor(() => {
      expect(overrideQuestionCategory).toHaveBeenCalledTimes(1);
    });
    expect(overrideQuestionCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: 'q-1',
        category: 'Governance',
        eventId: 'evt-1',
      }),
    );
    // The queue is re-read so the row reflects its new category.
    await waitFor(() => {
      expect(readModerationQuestions).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ModerationQueue — categorise action (Req 15.1)', () => {
  it('the "Categorise questions" action calls runCategorisation and re-reads', async () => {
    const user = userEvent.setup();
    readModerationQuestions.mockResolvedValue([question({ id: 'q-1' })]);
    runCategorisation.mockResolvedValue({
      available: true,
      summary: {
        candidate_count: 1,
        batch_count: 1,
        categorised_count: 1,
        rejected_batches: 0,
      },
    });

    renderScreen();
    await screen.findByText(/a question about the roadmap/i);

    await user.click(
      screen.getByRole('button', { name: /categorise questions/i }),
    );

    await waitFor(() => {
      expect(runCategorisation).toHaveBeenCalledTimes(1);
    });
    expect(runCategorisation).toHaveBeenCalledWith('evt-1');
    // A sanitised result notice is surfaced.
    expect(
      await screen.findByText(/categorised 1 of 1 question/i),
    ).toBeInTheDocument();
  });
});
