/**
 * Task 42.3 — Unit tests for the summary export path (src/lib/summaryExport.ts).
 *
 * These tests mock runSummary and downloadMarkdown to cover the three designed
 * export outcomes (A/B/C) — Req 9.4, 9.7, 18.7, 19.1, 26.1.
 *
 * Requirements: 9.4, 9.7, 18.7, 19.1, 26.1
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const { runSummaryMock, downloadMarkdownMock } = vi.hoisted(() => ({
  runSummaryMock: vi.fn(),
  downloadMarkdownMock: vi.fn(),
}));

vi.mock('./aiClient', () => ({
  AiClientError: class AiClientError extends Error {
    kind: string;
    fields: never[];
    constructor(
      message: string,
      options: { kind: string; cause?: unknown; status?: number },
    ) {
      super(message);
      this.name = 'AiClientError';
      this.kind = options.kind;
      this.fields = [];
    }
  },
  runSummary: (...args: unknown[]) => runSummaryMock(...args),
}));

vi.mock('./download', () => ({
  downloadMarkdown: (...args: unknown[]) => downloadMarkdownMock(...args),
}));

import {
  DEFAULT_SUMMARY_FILENAME,
  SUMMARY_EXPORT_TYPE,
  exportEventSummary,
} from './summaryExport';

describe('exported constants', () => {
  it('DEFAULT_SUMMARY_FILENAME is livepulse-summary.md', () =>
    expect(DEFAULT_SUMMARY_FILENAME).toBe('livepulse-summary.md'));
  it('SUMMARY_EXPORT_TYPE is "summary"', () =>
    expect(SUMMARY_EXPORT_TYPE).toBe('summary'));
});

describe('exportEventSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('positive (Outcome A): downloads report and returns downloaded:true', async () => {
    runSummaryMock.mockResolvedValue({
      available: true,
      summary: {
        markdown: '## Summary\n\nAll good.',
        aiInterpretationAvailable: true,
        questionCount: 10,
      },
    });
    downloadMarkdownMock.mockReturnValue(undefined);

    const result = await exportEventSummary('event-1');
    expect(result.downloaded).toBe(true);
    if (result.downloaded) {
      expect(result.aiInterpretationAvailable).toBe(true);
    }
    expect(downloadMarkdownMock).toHaveBeenCalledWith(
      DEFAULT_SUMMARY_FILENAME,
      expect.stringContaining('Summary'),
    );
  });

  it('positive (Outcome A): still downloaded when aiInterpretationAvailable is false (Req 18.7)', async () => {
    runSummaryMock.mockResolvedValue({
      available: true,
      summary: {
        markdown: '## Summary\n\n(AI unavailable)',
        aiInterpretationAvailable: false,
        questionCount: 5,
      },
    });
    downloadMarkdownMock.mockReturnValue(undefined);

    const result = await exportEventSummary('event-1');
    expect(result.downloaded).toBe(true);
    if (result.downloaded) {
      expect(result.aiInterpretationAvailable).toBe(false);
    }
  });

  it('positive (Outcome A): uses custom filename when supplied', async () => {
    runSummaryMock.mockResolvedValue({
      available: true,
      summary: {
        markdown: '## Summary',
        aiInterpretationAvailable: true,
        questionCount: 1,
      },
    });
    downloadMarkdownMock.mockReturnValue(undefined);

    await exportEventSummary('event-1', { filename: 'my-summary.md' });
    expect(downloadMarkdownMock).toHaveBeenCalledWith(
      'my-summary.md',
      expect.any(String),
    );
  });

  it('negative (Outcome B): returns ai_unavailable_degraded when AI not configured (Req 19.1)', async () => {
    runSummaryMock.mockResolvedValue({
      available: false,
      unavailable: {
        available: false,
        reason: 'not_configured',
        mode: 'degraded',
        message: 'AI is not configured.',
      },
    });

    const result = await exportEventSummary('event-1');
    expect(result.downloaded).toBe(false);
    if (!result.downloaded) {
      expect(result.reason).toBe('ai_unavailable_degraded');
      if (result.reason === 'ai_unavailable_degraded') {
        expect(result.unavailable.reason).toBe('not_configured');
      }
    }
    expect(downloadMarkdownMock).not.toHaveBeenCalled();
  });

  it('negative (Outcome C): returns export_failed when runSummary throws AiClientError (Req 9.7)', async () => {
    const { AiClientError } = await import('./aiClient');
    runSummaryMock.mockRejectedValue(
      new AiClientError('No event was specified.', { kind: 'validation' }),
    );

    const result = await exportEventSummary('event-1');
    expect(result.downloaded).toBe(false);
    if (!result.downloaded) {
      expect(result.reason).toBe('export_failed');
      if (result.reason === 'export_failed') {
        expect(result.exportType).toBe('summary');
        expect(result.message).toBe('No event was specified.');
      }
    }
    expect(downloadMarkdownMock).not.toHaveBeenCalled();
  });

  it('negative (Outcome C): returns export_failed for generic thrown error (Req 9.7)', async () => {
    runSummaryMock.mockRejectedValue(new Error('Unexpected network failure'));

    const result = await exportEventSummary('event-1');
    expect(result.downloaded).toBe(false);
    if (!result.downloaded) {
      expect(result.reason).toBe('export_failed');
    }
  });

  it('negative (Outcome C): returns export_failed when download fails (Req 9.7)', async () => {
    runSummaryMock.mockResolvedValue({
      available: true,
      summary: {
        markdown: '## Report',
        aiInterpretationAvailable: true,
        questionCount: 2,
      },
    });
    downloadMarkdownMock.mockImplementation(() => {
      throw new Error('DOM unavailable');
    });

    const result = await exportEventSummary('event-1');
    expect(result.downloaded).toBe(false);
    if (!result.downloaded) {
      expect(result.reason).toBe('export_failed');
    }
  });
});
