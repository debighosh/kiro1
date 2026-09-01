/**
 * Tests for the `/admin/events/:id/exports` admin export panel screen
 * (Task 38.4), covering:
 *   (a) Loading state renders while data fetches — Req 24.7
 *   (b) All four export buttons are present once loaded — Req 9.1–9.4
 *   (c) Download Questions CSV triggers buildQuestionsCsv + downloadCsv — Req 9.1
 *   (d) Empty-data notice shown when questions isEmpty (Req 9.6)
 *   (e) Error state when exportEventSummary returns failed — Req 9.7
 *   (f) No participant_identifier value in the DOM — Req 8.6, 24.8
 *
 * `../lib/supabaseClient`, `../lib/exports`, `../lib/summaryExport`, and
 * `../lib/download` are fully mocked so importing the screen never constructs
 * a real Supabase client (which requires VITE_ env vars) and no real DOM
 * downloads are attempted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ExportEventSummaryResult } from '../lib/summaryExport';

// ---------------------------------------------------------------------------
// Hoist mock factories BEFORE vi.mock calls so the factory closures can use them.
// ---------------------------------------------------------------------------

const {
  supabaseMock,
  buildQuestionsCsvMock,
  buildPollsCsvMock,
  buildWordCloudCsvMock,
  downloadCsvMock,
  exportEventSummaryMock,
} = vi.hoisted(() => {
  // Supabase chained query builder mock. Supports:
  //   supabase.from(table).select(cols).eq(k,v).in(k,v[]) → Promise
  //   supabase.from(table).select(cols).eq(k,v) → Promise
  function makeQueryBuilder(
    resolveFn: () => Promise<{ data: unknown[]; error: null | Error }>,
  ) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => resolveFn(),
      then: (
        onfulfilled: (value: {
          data: unknown[];
          error: null | Error;
        }) => unknown,
      ) => resolveFn().then(onfulfilled),
    };
    return builder;
  }

  const fromMock = vi.fn(() =>
    makeQueryBuilder(() => Promise.resolve({ data: [], error: null })),
  );

  const supabaseMock = { from: fromMock };

  return {
    supabaseMock,
    buildQuestionsCsvMock: vi.fn((): { csv: string; isEmpty: boolean } => ({
      csv: 'Question,Votes\n',
      isEmpty: false,
    })),
    buildPollsCsvMock: vi.fn((): { csv: string; isEmpty: boolean } => ({
      csv: 'Poll,Option,Responses\n',
      isEmpty: false,
    })),
    buildWordCloudCsvMock: vi.fn((): { csv: string; isEmpty: boolean } => ({
      csv: 'Word,Frequency\n',
      isEmpty: false,
    })),
    downloadCsvMock: vi.fn((): undefined => undefined),
    exportEventSummaryMock: vi.fn((): Promise<ExportEventSummaryResult> =>
      Promise.resolve({ downloaded: true, aiInterpretationAvailable: true }),
    ),
  };
});

vi.mock('../lib/supabaseClient', () => ({
  supabase: supabaseMock,
}));

vi.mock('../lib/exports', () => ({
  buildQuestionsCsv: (rows: unknown) =>
    (
      buildQuestionsCsvMock as (r: unknown) => { csv: string; isEmpty: boolean }
    )(rows),
  buildPollsCsv: (polls: unknown) =>
    (buildPollsCsvMock as (p: unknown) => { csv: string; isEmpty: boolean })(
      polls,
    ),
  buildWordCloudCsv: (responses: unknown) =>
    (
      buildWordCloudCsvMock as (r: unknown) => { csv: string; isEmpty: boolean }
    )(responses),
}));

vi.mock('../lib/download', () => ({
  downloadCsv: (filename: string, csv: string) =>
    (downloadCsvMock as (f: string, c: string) => undefined)(filename, csv),
  downloadMarkdown: vi.fn(),
}));

vi.mock('../lib/summaryExport', () => ({
  exportEventSummary: (eventId: string) =>
    (
      exportEventSummaryMock as (
        id: string,
      ) => Promise<ExportEventSummaryResult>
    )(eventId),
}));

// Import component AFTER vi.mock so mocks are in place.
import { ExportPanel } from './ExportPanel';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function renderPanel(id = 'evt-abc'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/admin/events/${id}/exports`]}>
      <Routes>
        <Route path="/admin/events/:id/exports" element={<ExportPanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Returns a query builder that resolves with the given data.
 */
function makeBuilder(data: unknown[]): ReturnType<typeof supabaseMock.from> {
  const resolveFn = (): Promise<{ data: unknown[]; error: null }> =>
    Promise.resolve({ data, error: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: () => resolveFn(),
    then: (onfulfilled: (v: { data: unknown[]; error: null }) => unknown) =>
      resolveFn().then(onfulfilled),
  };
  return builder as ReturnType<typeof supabaseMock.from>;
}

/**
 * Makes supabaseMock.from return a builder that resolves with the given data.
 * Questions first, polls second, word-cloud third.
 */
function mockFromSequence(
  questionsData: unknown[],
  pollsData: unknown[],
  wcData: unknown[],
): void {
  supabaseMock.from
    .mockReturnValueOnce(makeBuilder(questionsData))
    .mockReturnValueOnce(makeBuilder(pollsData))
    .mockReturnValueOnce(makeBuilder(wcData));
}

// ---------------------------------------------------------------------------
// Setup / teardown.
// ---------------------------------------------------------------------------

beforeEach(() => {
  buildQuestionsCsvMock.mockReturnValue({
    csv: 'Question,Votes\n',
    isEmpty: false,
  });
  buildPollsCsvMock.mockReturnValue({
    csv: 'Poll,Option,Responses\n',
    isEmpty: false,
  });
  buildWordCloudCsvMock.mockReturnValue({
    csv: 'Word,Frequency\n',
    isEmpty: false,
  });
  downloadCsvMock.mockReset();
  exportEventSummaryMock.mockResolvedValue({
    downloaded: true,
    aiInterpretationAvailable: true,
  });
  // Reset and set up default empty data for the three Supabase queries.
  supabaseMock.from.mockReset();
  mockFromSequence([], [], []);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('ExportPanel — loading state (Req 24.7)', () => {
  it('renders a loading indicator while data is fetching', () => {
    // Return a never-resolving builder so the component stays loading.
    const neverBuilder = {
      select: (): unknown => neverBuilder,
      eq: (): unknown => neverBuilder,
      in: (): Promise<never> => new Promise(() => {}),
      then: (): Promise<never> => new Promise(() => {}),
    } as ReturnType<typeof supabaseMock.from>;
    supabaseMock.from.mockReset();
    supabaseMock.from.mockReturnValue(neverBuilder);

    renderPanel();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/loading event data/i)).toBeInTheDocument();
  });
});

describe('ExportPanel — all four export buttons present (Req 9.1–9.4)', () => {
  it('shows all four download buttons once data has loaded', async () => {
    renderPanel();

    // Wait for loading to complete.
    await screen.findByRole('button', { name: /download questions csv/i });

    expect(
      screen.getByRole('button', { name: /download questions csv/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download polls csv/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download word cloud csv/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download summary/i }),
    ).toBeInTheDocument();
  });
});

describe('ExportPanel — Download Questions CSV (Req 9.1, 9.6, 9.7)', () => {
  it('calls buildQuestionsCsv and downloadCsv when the button is clicked', async () => {
    const user = userEvent.setup();

    const questionData = [{ text: 'What is the plan?', vote_count: 5 }];
    // Reset and configure with specific question data.
    supabaseMock.from.mockReset();
    mockFromSequence(questionData, [], []);
    buildQuestionsCsvMock.mockReturnValue({
      csv: 'Question,Votes\nWhat is the plan?,5\n' as string,
      isEmpty: false,
    } as { csv: string; isEmpty: boolean });

    renderPanel();

    const btn = await screen.findByRole('button', {
      name: /download questions csv/i,
    });
    await user.click(btn);

    await waitFor(() => {
      expect(buildQuestionsCsvMock).toHaveBeenCalledWith([
        { text: 'What is the plan?', vote_count: 5 },
      ]);
    });
    expect(downloadCsvMock).toHaveBeenCalledWith(
      'questions.csv',
      'Question,Votes\nWhat is the plan?,5\n',
    );
  });

  it('shows a success confirmation after download', async () => {
    const user = userEvent.setup();
    renderPanel();

    const btn = await screen.findByRole('button', {
      name: /download questions csv/i,
    });
    await user.click(btn);

    await screen.findByText(/download complete/i);
  });

  it('shows empty-data notice when questions isEmpty (Req 9.6)', async () => {
    const user = userEvent.setup();
    buildQuestionsCsvMock.mockReturnValue({
      csv: 'Question,Votes\n',
      isEmpty: true,
    });

    renderPanel();

    const btn = await screen.findByRole('button', {
      name: /download questions csv/i,
    });
    await user.click(btn);

    // Expect both success and the no-data notice.
    await screen.findByText(/download complete/i);
    await screen.findByText(/no questions were available/i);
  });
});

describe('ExportPanel — Download Summary error state (Req 9.7)', () => {
  it('shows an error alert when exportEventSummary returns export_failed', async () => {
    const user = userEvent.setup();
    const failedResult: ExportEventSummaryResult = {
      downloaded: false,
      reason: 'export_failed',
      exportType: 'summary',
      message: 'The summary could not be completed. Please try again.',
    };
    exportEventSummaryMock.mockResolvedValue(failedResult);

    renderPanel();

    const btn = await screen.findByRole('button', {
      name: /download summary/i,
    });
    await user.click(btn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/summary could not be completed/i);
    // No CSV file is downloaded.
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });

  it('shows an error message when exportEventSummary returns ai_unavailable_degraded', async () => {
    const user = userEvent.setup();
    const degradedResult: ExportEventSummaryResult = {
      downloaded: false,
      reason: 'ai_unavailable_degraded',
      unavailable: {
        available: false,
        reason: 'ai_disabled',
        mode: 'disabled',
        message: 'AI features are not enabled for this event.',
      },
    };
    exportEventSummaryMock.mockResolvedValue(degradedResult);

    renderPanel();

    const btn = await screen.findByRole('button', {
      name: /download summary/i,
    });
    await user.click(btn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/ai features are not enabled/i);
  });
});

describe('ExportPanel — no participant_identifier in DOM (Req 8.6, 24.8)', () => {
  it('never renders any participant_identifier value in the DOM', async () => {
    // Provide data rows that only contain the permitted columns.
    const questionData = [{ text: 'How are you?', vote_count: 3 }];
    const pollData = [
      {
        id: 'poll-1',
        question_text: 'Favourite colour?',
        poll_options: [{ text: 'Blue', response_count: 10 }],
      },
    ];
    const wcData = [{ normalised_text: 'agile', is_hidden: false }];
    // Reset and configure so only our data is returned.
    supabaseMock.from.mockReset();
    mockFromSequence(questionData, pollData, wcData);

    const { container } = renderPanel();

    // Wait for data to load.
    await screen.findByRole('button', { name: /download questions csv/i });

    const allText = container.textContent ?? '';
    // The column name "participant_identifier" must never appear.
    expect(allText).not.toMatch(/participant_identifier/i);
  });
});
