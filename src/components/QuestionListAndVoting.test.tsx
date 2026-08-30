/**
 * Unit tests for the `QuestionListAndVoting` component (Task 15.4).
 *
 * These mock `../lib/questions` (so no real Supabase client / network is
 * touched) while keeping a REAL `QuestionError` class inside the mock, so the
 * component's `instanceof QuestionError` sanitised-message branch is exercised
 * faithfully (the component AND this test import `QuestionError` from the SAME
 * mocked module). We verify the behaviours the design + requirements mandate:
 *   (a) the sort control re-reads in the chosen order — `readAudienceQuestions`
 *       is called with `'most_recent'` after changing the select, and the
 *       rendered order reflects the returned list (Req 3.11);
 *   (b) tapping upvote calls `castQuestionVote` once; toggling again calls
 *       `removeQuestionVote` — the one-active-vote toggle behaviour (Req 4.1,
 *       4.5);
 *   (c) the participant identifier NEVER reaches the DOM — the component reads
 *       only the non-sensitive projection, so even a sentinel id passed on a
 *       row object is never rendered (Req 8.6).
 *
 * Requirements: 3.11, 4.1, 4.5, 8.6, 26.1.
 * Design: Components (`QuestionListAndVoting`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock `../lib/questions`. Importing the real module transitively loads
// `../lib/supabaseClient`, which throws unless VITE_SUPABASE_* env vars are set.
// We provide a REAL `QuestionError` inside the factory so the component's error
// branch (`instanceof QuestionError`) still matches, and stub the read/vote
// helpers with spies. `DEFAULT_QUESTION_SORT` mirrors the real default.
const readAudienceQuestions = vi.fn();
const castQuestionVote = vi.fn();
const removeQuestionVote = vi.fn();

vi.mock('../lib/questions', () => {
  class QuestionError extends Error {
    kind: string;
    cause?: unknown;
    constructor(message: string, options: { kind: string; cause?: unknown }) {
      super(message);
      this.name = 'QuestionError';
      this.kind = options.kind;
      this.cause = options.cause;
    }
  }
  return {
    QuestionError,
    DEFAULT_QUESTION_SORT: 'most_votes',
    readAudienceQuestions: (eventId: string, sort: string) =>
      readAudienceQuestions(eventId, sort),
    castQuestionVote: (id: string) => castQuestionVote(id),
    removeQuestionVote: (id: string) => removeQuestionVote(id),
  };
});

import { QuestionListAndVoting } from './QuestionListAndVoting';

const EVENT_ID = 'event-123';

/**
 * A sentinel participant identifier that must NEVER appear in the rendered DOM
 * (Req 8.6). We attach it to a row object to prove that even if an over-broad
 * read leaked it onto the row, the component still renders only text + count.
 */
const PARTICIPANT_SENTINEL = 'PARTICIPANT-SENTINEL-DO-NOT-RENDER-abc123';

/** Builds an ordered audience-question list. */
function rows(): Array<Record<string, unknown>> {
  return [
    {
      id: 'q1',
      text: 'Alpha question',
      status: 'approved',
      vote_count: 5,
      created_at: '2026-01-01T10:00:00.000Z',
    },
    {
      id: 'q2',
      text: 'Bravo question',
      status: 'featured',
      vote_count: 9,
      created_at: '2026-01-02T10:00:00.000Z',
    },
  ];
}

beforeEach(() => {
  readAudienceQuestions.mockReset();
  castQuestionVote.mockReset();
  removeQuestionVote.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('QuestionListAndVoting', () => {
  it('re-reads in the chosen sort order when the sort control changes (Req 3.11)', async () => {
    const user = userEvent.setup();

    // Initial (most_votes) read returns votes-desc order; the most_recent read
    // returns a different (created_at-desc) order so we can assert re-ordering.
    const byVotes = [rows()[1], rows()[0]]; // q2 (9), q1 (5)
    const byRecent = [rows()[1], rows()[0]]; // q2 (newer), q1 (older)
    readAudienceQuestions
      .mockResolvedValueOnce(byVotes) // initial most_votes
      .mockResolvedValueOnce(byRecent); // after change → most_recent

    render(<QuestionListAndVoting eventId={EVENT_ID} />);

    // Initial read used the default sort.
    await waitFor(() =>
      expect(readAudienceQuestions).toHaveBeenCalledWith(
        EVENT_ID,
        'most_votes',
      ),
    );
    await screen.findByTestId('question-list');

    // Change the sort control to "Most recent".
    await user.selectOptions(
      screen.getByTestId('question-sort'),
      'most_recent',
    );

    // A re-read is issued in the chosen order.
    await waitFor(() =>
      expect(readAudienceQuestions).toHaveBeenCalledWith(
        EVENT_ID,
        'most_recent',
      ),
    );

    // The rendered order reflects the returned list (q2 before q1).
    await waitFor(() => {
      const items = within(screen.getByTestId('question-list')).getAllByRole(
        'listitem',
      );
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent('Bravo question');
      expect(items[1]).toHaveTextContent('Alpha question');
    });
  });

  it('shows the friendly empty state when there are no questions (Req 24.7)', async () => {
    readAudienceQuestions.mockResolvedValue([]);
    render(<QuestionListAndVoting eventId={EVENT_ID} />);
    expect(
      await screen.findByTestId('question-list-empty'),
    ).toBeInTheDocument();
  });

  it('upvote calls castQuestionVote once; toggling again calls removeQuestionVote (one-active-vote) (Req 4.1, 4.5)', async () => {
    const user = userEvent.setup();
    readAudienceQuestions.mockResolvedValue([rows()[0]]); // single question q1, count 5
    castQuestionVote.mockResolvedValue(6);
    removeQuestionVote.mockResolvedValue(5);

    render(<QuestionListAndVoting eventId={EVENT_ID} />);
    await screen.findByTestId('question-list');

    // Cast an upvote.
    const upvote = screen.getByRole('button', {
      name: /upvote this question/i,
    });
    await user.click(upvote);

    await waitFor(() => expect(castQuestionVote).toHaveBeenCalledTimes(1));
    expect(castQuestionVote).toHaveBeenCalledWith('q1');
    expect(removeQuestionVote).not.toHaveBeenCalled();

    // The button now reflects the "voted" (pressed) state and count reconciled
    // to the authoritative server value (6).
    const remove = await screen.findByRole('button', {
      name: /remove your upvote/i,
    });
    expect(remove).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(screen.getByTestId('vote-count')).toHaveTextContent('6'),
    );

    // Toggle again → removes the vote (one-active-vote behaviour).
    await user.click(remove);
    await waitFor(() => expect(removeQuestionVote).toHaveBeenCalledTimes(1));
    expect(removeQuestionVote).toHaveBeenCalledWith('q1');
    // Cast was NOT called a second time — the single button toggles state.
    expect(castQuestionVote).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(screen.getByTestId('vote-count')).toHaveTextContent('5'),
    );
  });

  it('never renders the participant identifier even if a row carries one (Req 8.6)', async () => {
    // Deliberately include a participant_identifier on the row object to prove
    // the component renders only text + vote_count and never leaks the id.
    const leakyRow = {
      ...rows()[0],
      participant_identifier: PARTICIPANT_SENTINEL,
    };
    readAudienceQuestions.mockResolvedValue([leakyRow]);

    const { container } = render(<QuestionListAndVoting eventId={EVENT_ID} />);
    await screen.findByTestId('question-list');

    // The question text and count are rendered...
    expect(screen.getByText('Alpha question')).toBeInTheDocument();
    expect(screen.getByTestId('vote-count')).toHaveTextContent('5');

    // ...but the sentinel participant identifier is NOWHERE in the DOM.
    expect(container.innerHTML).not.toContain(PARTICIPANT_SENTINEL);
    expect(screen.queryByText(PARTICIPANT_SENTINEL)).toBeNull();
  });

  it('rolls back the optimistic vote and announces a sanitised message on a server rejection (Req 4.1)', async () => {
    const user = userEvent.setup();
    const { QuestionError } = await import('../lib/questions');
    readAudienceQuestions.mockResolvedValue([rows()[0]]); // q1, count 5
    castQuestionVote.mockRejectedValue(
      new QuestionError('You have already voted on this question.', {
        kind: 'already_voted',
      }),
    );

    render(<QuestionListAndVoting eventId={EVENT_ID} />);
    await screen.findByTestId('question-list');

    await user.click(
      screen.getByRole('button', { name: /upvote this question/i }),
    );

    await waitFor(() => expect(castQuestionVote).toHaveBeenCalledTimes(1));

    // The sanitised message is announced and the count rolls back to 5.
    expect(await screen.findByText(/already voted/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('vote-count')).toHaveTextContent('5'),
    );
    // Rolled back to not-voted (the upvote affordance is shown again).
    expect(
      screen.getByRole('button', { name: /upvote this question/i }),
    ).toHaveAttribute('aria-pressed', 'false');
  });
});
