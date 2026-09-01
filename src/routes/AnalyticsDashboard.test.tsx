/**
 * Tests for the `/admin/events/:id/analytics` admin analytics dashboard screen
 * (Task 38.3), covering:
 *   (a) Loading state renders correctly — Req 8.7, 24.7
 *   (b) Success state: all scalar metrics render — Req 8.1–8.3
 *   (c) Error state: sanitised error + retry button — Req 8.7, 24.7
 *   (d) Empty/zero-interaction state — Req 8.8
 *   (e) No participant_identifier value is ever in the DOM — Req 8.6, 24.8
 *
 * `../lib/analyticsClient` is fully mocked so importing the screen never
 * constructs the real Supabase client (which requires VITE_ env vars).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { EventAnalytics } from '../lib/analytics';

// ---------------------------------------------------------------------------
// Hoist mock factories BEFORE vi.mock so the mock factory can reference them.
// ---------------------------------------------------------------------------
const { AnalyticsClientError, readEventAnalytics } = vi.hoisted(() => {
  class AnalyticsClientError extends Error {
    kind: string;
    constructor(message: string, options: { kind: string; cause?: unknown }) {
      super(message);
      this.name = 'AnalyticsClientError';
      this.kind = options.kind;
    }
  }
  return {
    AnalyticsClientError,
    readEventAnalytics: vi.fn<(eventId: string) => Promise<EventAnalytics>>(),
  };
});

vi.mock('../lib/analyticsClient', () => ({
  AnalyticsClientError,
  readEventAnalytics: (eventId: string) => readEventAnalytics(eventId),
}));

// Import after vi.mock so the mock is in place.
import { AnalyticsDashboard } from './AnalyticsDashboard';

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

/** A realistic EventAnalytics result with non-zero metrics. */
const SAMPLE_ANALYTICS: EventAnalytics = {
  uniqueParticipants: 42,
  questionStatusCounts: {
    totalSubmitted: 30,
    approved: 15,
    featured: 5,
    answered: 8,
    hidden: 2,
  },
  totalVotes: 120,
  pollResponses: 88,
  wordCloudResponses: 55,
  engagementOverTime: [
    { bucketStart: '2026-01-01T10:00:00.000Z', count: 12 },
    { bucketStart: '2026-01-01T10:05:00.000Z', count: 20 },
    { bucketStart: '2026-01-01T10:10:00.000Z', count: 10 },
  ],
};

/** An EventAnalytics result representing a zero-interaction event (Req 8.8). */
const ZERO_ANALYTICS: EventAnalytics = {
  uniqueParticipants: 0,
  questionStatusCounts: {
    totalSubmitted: 0,
    approved: 0,
    featured: 0,
    answered: 0,
    hidden: 0,
  },
  totalVotes: 0,
  pollResponses: 0,
  wordCloudResponses: 0,
  engagementOverTime: [],
};

// ---------------------------------------------------------------------------
// Render helper.
// ---------------------------------------------------------------------------

function renderDashboard(id = 'evt-123'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/admin/events/${id}/analytics`]}>
      <Routes>
        <Route
          path="/admin/events/:id/analytics"
          element={<AnalyticsDashboard />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown.
// ---------------------------------------------------------------------------

beforeEach(() => {
  readEventAnalytics.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('AnalyticsDashboard — loading state (Req 8.7, 24.7)', () => {
  it('renders a loading indicator while fetching', async () => {
    // Never resolve so the component stays in loading state.
    readEventAnalytics.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    // role="status" loading indicator must be present immediately.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/loading analytics/i)).toBeInTheDocument();
  });
});

describe('AnalyticsDashboard — success state (Req 8.1–8.3)', () => {
  it('renders all scalar metrics on success', async () => {
    readEventAnalytics.mockResolvedValue(SAMPLE_ANALYTICS);

    renderDashboard();

    // Wait for the participant metric to appear (loading is done).
    await screen.findByText(/platform participants/i);

    // Unique participants (Req 8.1) — labeled as "Platform participants", NOT "Attendees".
    expect(screen.getByText(/platform participants/i)).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();

    // Question counts (Req 8.2).
    expect(screen.getByText(/questions submitted/i)).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();

    // Votes / poll / word-cloud (Req 8.3).
    expect(screen.getByText(/total votes/i)).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText(/poll responses/i)).toBeInTheDocument();
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText(/word-cloud responses/i)).toBeInTheDocument();
    expect(screen.getByText('55')).toBeInTheDocument();
  });

  it('renders the question status breakdown (Req 8.2)', async () => {
    readEventAnalytics.mockResolvedValue(SAMPLE_ANALYTICS);

    renderDashboard();

    // Wait for loading to finish.
    await screen.findByText(/platform participants/i);

    expect(screen.getByText(/approved questions/i)).toBeInTheDocument();
    expect(screen.getByText(/featured questions/i)).toBeInTheDocument();
    expect(screen.getByText(/answered questions/i)).toBeInTheDocument();
    expect(screen.getByText(/hidden questions/i)).toBeInTheDocument();
  });

  it('renders the engagement-over-time section (Req 8.4)', async () => {
    readEventAnalytics.mockResolvedValue(SAMPLE_ANALYTICS);

    renderDashboard();

    // Wait for loading to finish.
    await screen.findByText(/platform participants/i);

    // ARIA-labelled chart wrapper (Req 24.5).
    expect(
      screen.getByRole('img', { name: /engagement over time chart/i }),
    ).toBeInTheDocument();
  });

  it('labels metrics as platform interaction counts, not verified attendees (Req 8.5)', async () => {
    readEventAnalytics.mockResolvedValue(SAMPLE_ANALYTICS);

    renderDashboard();

    // Wait for loading to finish by checking the page heading and metric.
    await screen.findByText(/platform participants/i);

    // Must mention "platform interaction counts" somewhere in the text.
    const allMatches = screen.getAllByText(/platform interaction counts/i);
    expect(allMatches.length).toBeGreaterThan(0);
    // Must NOT use the word "Attendees" as a label for the participant count.
    expect(screen.queryByText(/^attendees$/i)).not.toBeInTheDocument();
  });
});

describe('AnalyticsDashboard — error state (Req 8.7, 24.7)', () => {
  it('renders an error alert with the sanitised message on AnalyticsClientError', async () => {
    readEventAnalytics.mockRejectedValue(
      new AnalyticsClientError(
        'Analytics could not be loaded: failed to read event data.',
        { kind: 'load_failed' },
      ),
    );

    renderDashboard();

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/analytics could not be loaded/i);
  });

  it('renders a "Try again" retry button on error', async () => {
    readEventAnalytics.mockRejectedValue(
      new AnalyticsClientError('Session expired.', { kind: 'unauthorized' }),
    );

    renderDashboard();

    const button = await screen.findByRole('button', { name: /try again/i });
    expect(button).toBeInTheDocument();
  });

  it('retries fetching when "Try again" is clicked', async () => {
    const user = userEvent.setup();

    // First call fails; second call succeeds.
    readEventAnalytics
      .mockRejectedValueOnce(
        new AnalyticsClientError('Network error.', { kind: 'unknown' }),
      )
      .mockResolvedValueOnce(SAMPLE_ANALYTICS);

    renderDashboard();

    // Wait for error state.
    await screen.findByRole('alert');
    expect(readEventAnalytics).toHaveBeenCalledTimes(1);

    // Click retry.
    await user.click(screen.getByRole('button', { name: /try again/i }));

    // Wait for success.
    await waitFor(() => {
      expect(readEventAnalytics).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    // Metrics now visible.
    expect(screen.getByText(/platform participants/i)).toBeInTheDocument();
  });
});

describe('AnalyticsDashboard — empty / zero-interaction state (Req 8.8)', () => {
  it('renders all-zero metrics without crashing', async () => {
    readEventAnalytics.mockResolvedValue(ZERO_ANALYTICS);

    renderDashboard();

    // The "no interactions yet" note must appear (Req 8.8).
    await screen.findByText(/no interactions yet for this event/i);

    // Zero counts render as "0".
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThan(0);
  });

  it('shows "No engagement data yet" in the chart section when series is empty', async () => {
    readEventAnalytics.mockResolvedValue(ZERO_ANALYTICS);

    renderDashboard();

    // Wait for metrics section to appear.
    await screen.findByText(/no interactions yet for this event/i);

    expect(screen.getByText(/no engagement data yet/i)).toBeInTheDocument();
  });
});

describe('AnalyticsDashboard — no participant_identifier in DOM (Req 8.6, 24.8)', () => {
  it('never renders any participant_identifier value in the DOM', async () => {
    // Even if somehow an analytics object had raw identifiers, they must not appear.
    readEventAnalytics.mockResolvedValue(SAMPLE_ANALYTICS);

    const { container } = renderDashboard();

    // Wait for loading to finish.
    await screen.findByText(/platform participants/i);

    // Simulate searching for any identifier-like patterns in the DOM text.
    // Participant identifiers are high-entropy UUIDs or tokens; confirm none appear.
    const allText = container.textContent ?? '';
    // The word "participant_identifier" (the column name) must never appear.
    expect(allText).not.toMatch(/participant_identifier/i);
    // The raw identifier value is never a field in EventAnalytics, so just
    // confirm the numeric count (42) is visible but no identifier token is present.
    expect(allText).toContain('42');
    // Ensure the label is "Platform participants" not something leaking identifiers.
    expect(screen.getByText(/platform participants/i)).toBeInTheDocument();
  });
});
