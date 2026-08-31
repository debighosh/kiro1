/**
 * Tests for the `/admin/events/:id/summary` end-of-event summary screen
 * (task 34.4), covering task 34.5:
 *   (a) Generate renders the returned Markdown report — the "## Calculated
 *       Data" and "## AI Interpretation" sections appear as TEXT — Req 18.1,
 *       18.4;
 *   (b) when `aiInterpretationAvailable` is false, the prominent AI-unavailable
 *       notice/banner renders (the calculated data is still shown) — Req 18.7;
 *   (c) the Markdown is rendered as INERT plain text inside a whitespace-
 *       preserving `<pre>` block — the raw markup is present as text content and
 *       is NOT parsed into HTML elements (e.g. no `<h2>` is produced) — Req 14.8.
 *
 * `../lib/aiClient` is fully mocked so importing the screen never constructs
 * the real Supabase client (which needs VITE_ env vars).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { SummaryResponse } from '../lib/aiClient';

const { AiClientError, runSummary } = vi.hoisted(() => {
  class AiClientError extends Error {
    kind: string;
    constructor(message: string, options: { kind: string }) {
      super(message);
      this.name = 'AiClientError';
      this.kind = options.kind;
    }
  }
  return { AiClientError, runSummary: vi.fn() };
});

vi.mock('../lib/aiClient', () => ({
  AiClientError,
  runSummary: (eventId: string) => runSummary(eventId),
}));

import { AiSummary } from './AiSummary';

/** A Markdown report carrying BOTH the calculated + AI-interpretation sections. */
const MARKDOWN_WITH_AI = [
  '## Calculated Data',
  '',
  '- Questions: 12',
  '- Total votes: 87',
  '',
  '## AI Interpretation',
  '',
  'The audience focused on roadmap and security topics.',
].join('\n');

/** A Markdown report whose AI section carries the in-report unavailable notice. */
const MARKDOWN_NO_AI = [
  '## Calculated Data',
  '',
  '- Questions: 12',
  '- Total votes: 87',
  '',
  '## AI Interpretation',
  '',
  'AI content could not be produced.',
].join('\n');

function renderScreen(id = 'evt-1'): void {
  render(
    <MemoryRouter initialEntries={[`/admin/events/${id}/summary`]}>
      <Routes>
        <Route path="/admin/events/:id/summary" element={<AiSummary />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  runSummary.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AiSummary — Generate renders calculated + AI sections (Req 18.1, 18.4)', () => {
  it('renders the returned Markdown with both section headings as text', async () => {
    const user = userEvent.setup();
    runSummary.mockResolvedValue({
      available: true,
      summary: {
        markdown: MARKDOWN_WITH_AI,
        aiInterpretationAvailable: true,
        questionCount: 12,
      },
    } satisfies SummaryResponse);

    renderScreen();
    await user.click(screen.getByRole('button', { name: /generate summary/i }));

    await waitFor(() => {
      expect(runSummary).toHaveBeenCalledWith('evt-1');
    });

    // Both section headings + body appear as literal text in the report.
    const report = await screen.findByText(/## Calculated Data/i);
    expect(report).toBeInTheDocument();
    expect(screen.getByText(/## AI Interpretation/i)).toBeInTheDocument();
    expect(
      screen.getByText(/focused on roadmap and security topics/i),
    ).toBeInTheDocument();
    // No AI-unavailable banner when the interpretation is available.
    expect(
      screen.queryByText(/ai interpretation unavailable/i),
    ).not.toBeInTheDocument();
  });

  it('renders the Markdown as INERT plain text — the raw markup is not parsed to HTML elements (Req 14.8)', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={['/admin/events/evt-1/summary']}>
        <Routes>
          <Route path="/admin/events/:id/summary" element={<AiSummary />} />
        </Routes>
      </MemoryRouter>,
    );
    runSummary.mockResolvedValue({
      available: true,
      summary: {
        markdown: MARKDOWN_WITH_AI,
        aiInterpretationAvailable: true,
        questionCount: 12,
      },
    } satisfies SummaryResponse);

    await user.click(screen.getByRole('button', { name: /generate summary/i }));

    // The report lives inside a whitespace-preserving <pre> block …
    const pre = await waitFor(() => {
      const el = container.querySelector('pre');
      expect(el).not.toBeNull();
      return el as HTMLPreElement;
    });
    // … containing the LITERAL markdown string (including the `##` markers) …
    expect(pre.textContent).toContain('## Calculated Data');
    expect(pre.textContent).toContain('## AI Interpretation');
    // … and the `##` markup was NOT parsed into any heading elements.
    expect(container.querySelectorAll('h2, h3')).toHaveLength(0);
  });
});

describe('AiSummary — AI-unavailable notice (Req 18.7)', () => {
  it('renders the prominent AI-unavailable banner while still showing calculated data', async () => {
    const user = userEvent.setup();
    runSummary.mockResolvedValue({
      available: true,
      summary: {
        markdown: MARKDOWN_NO_AI,
        aiInterpretationAvailable: false,
        questionCount: 12,
      },
    } satisfies SummaryResponse);

    renderScreen();
    await user.click(screen.getByRole('button', { name: /generate summary/i }));

    // The up-front banner surfaces that the AI interpretation is unavailable …
    expect(
      await screen.findByText(/ai interpretation unavailable/i),
    ).toBeInTheDocument();
    // … while the calculated data (from the report Markdown) is still rendered.
    expect(screen.getByText(/## Calculated Data/i)).toBeInTheDocument();
  });

  it('renders the degraded/unavailable message when AI is not usable yet', async () => {
    const user = userEvent.setup();
    runSummary.mockResolvedValue({
      available: false,
      unavailable: {
        available: false,
        reason: 'ai_disabled',
        mode: 'degraded',
        message: 'AI is not available: AI features are disabled.',
      },
    } satisfies SummaryResponse);

    renderScreen();
    await user.click(screen.getByRole('button', { name: /generate summary/i }));

    expect(
      await screen.findByText(/ai features are disabled/i),
    ).toBeInTheDocument();
  });
});
