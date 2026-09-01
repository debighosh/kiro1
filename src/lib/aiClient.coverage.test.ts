/**
 * Task 42.3 — Coverage-gap tests for src/lib/aiClient.ts (Req 26.1, 26.2, 26.3).
 *
 * Targets the runThemeInsights function which has NO tests in aiClient.test.ts:
 *   - positive: returns available:true with theme insights on success (Req 17.1)
 *   - positive: returns available:false for degraded AI state (Req 19.1)
 *   - negative: throws unauthorized when no session (Req 12.8)
 *   - negative: throws validation when eventId is empty
 *   - negative: throws unknown when payload is unexpected
 *
 * Requirements: 12.8, 17.1, 19.1, 26.1, 26.2
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const { getSessionMock, invokeMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock('./auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  getCurrentUser: vi.fn(),
}));

vi.mock('./supabaseClient', () => ({
  supabase: {
    rpc: vi.fn(),
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: vi.fn(),
  },
}));

import { runThemeInsights } from './aiClient';

const FAKE_SESSION = {
  access_token: 'token-xyz',
  user: { id: 'uid-1', last_sign_in_at: new Date().toISOString() },
};

// Minimal valid theme-insights payload (Req 17.1)
// top_themes/emerging_concerns/frequent_topics are arrays of strings (aiThemeLabelSchema = z.string())
const VALID_THEME_INSIGHTS = {
  top_themes: ['Technology', 'Security'],
  emerging_concerns: ['AI risks'],
  frequent_topics: ['Cost', 'Governance'],
  notable_high_vote_questions: [],
  has_data: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// runThemeInsights — positive cases (Req 17.1, 19.1, 26.1)
// ─────────────────────────────────────────────────────────────────────────────
describe('runThemeInsights — positive cases (Req 17.1)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('positive: returns available:true with validated theme insights on success', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: { theme_insights: VALID_THEME_INSIGHTS },
      error: null,
    });

    const result = await runThemeInsights('event-1');
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.insights.has_data).toBe(true);
      expect(result.insights.top_themes).toHaveLength(2);
      expect(result.insights.top_themes[0]).toBe('Technology');
    }
  });

  it('positive: returns available:false for degraded AI state (Req 19.1)', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        ai: {
          available: false,
          reason: 'ai_disabled',
          mode: 'degraded',
          message: 'AI is not configured.',
        },
      },
      error: null,
    });

    const result = await runThemeInsights('event-1');
    expect(result.available).toBe(false);
  });

  it('positive: handles empty-event case (has_data: false, all arrays empty, Req 17.5)', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        theme_insights: {
          top_themes: [],
          emerging_concerns: [],
          frequent_topics: [],
          notable_high_vote_questions: [],
          has_data: false,
        },
      },
      error: null,
    });

    const result = await runThemeInsights('event-1');
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.insights.has_data).toBe(false);
      expect(result.insights.top_themes).toHaveLength(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runThemeInsights — negative cases (Req 12.8, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('runThemeInsights — negative cases (Req 12.8, 26.2)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized when no session (Req 12.8)', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(runThemeInsights('event-1')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('negative: throws validation when eventId is empty', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    await expect(runThemeInsights('')).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('negative: throws unknown when payload is malformed (no theme_insights key)', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: { unexpected_key: 'some value' },
      error: null,
    });

    await expect(runThemeInsights('event-1')).rejects.toMatchObject({
      kind: 'unknown',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional imports for extended coverage
// ─────────────────────────────────────────────────────────────────────────────
import {
  saveAiProviderSettings,
  removeAiCredential,
  runCategorisation,
  overrideQuestionCategory,
  runSummary,
} from './aiClient';

// A minimal valid provider settings row (AiProviderSettingsPublic shape)
const VALID_SETTINGS_ROW = {
  id: 'settings-1',
  is_active: true,
  ai_enabled: true,
  display_name: 'Test Provider',
  provider_type: 'openai_compatible',
  base_url: 'https://api.example.com',
  chat_completions_path: '/v1/chat/completions',
  auth_type: 'bearer_token',
  api_key_header_name: null,
  model_id: 'gpt-4',
  temperature: 0.7,
  max_output_tokens: 1000,
  request_timeout_seconds: 30,
  tls_verify_required: true,
  credential_state: 'set',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// saveAiProviderSettings — success + edge-error paths (Req 12.11, 26.1, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('saveAiProviderSettings — positive cases (Req 12.11)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('positive: returns settings when response contains a valid settings row', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: { settings: VALID_SETTINGS_ROW },
      error: null,
    });

    // We need to provide the minimal required shape — using cast for brevity
    const input = { base_url: 'https://api.example.com' } as Parameters<
      typeof saveAiProviderSettings
    >[0];
    const result = await saveAiProviderSettings(input);
    expect(result.id).toBe('settings-1');
    expect(result.ai_enabled).toBe(true);
  });

  it('positive: returns settings when data itself is the row (not wrapped)', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: VALID_SETTINGS_ROW,
      error: null,
    });

    const input = { base_url: 'https://api.example.com' } as Parameters<
      typeof saveAiProviderSettings
    >[0];
    const result = await saveAiProviderSettings(input);
    expect(result.id).toBe('settings-1');
  });
});

describe('saveAiProviderSettings — negative cases (Req 12.11, 26.2)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws validation when edge function returns validation_failed error body', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        error: {
          code: 'validation_failed',
          message: 'Invalid URL',
          fields: [{ field: 'base_url', message: 'Invalid URL' }],
        },
      },
      error: null,
    });

    const input = { base_url: 'not-a-url' } as Parameters<
      typeof saveAiProviderSettings
    >[0];
    await expect(saveAiProviderSettings(input)).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('negative: throws not_implemented when edge function returns not_implemented error body', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        error: {
          code: 'not_implemented',
          message: 'Endpoint not available',
        },
      },
      error: null,
    });

    const input = { base_url: 'https://api.example.com' } as Parameters<
      typeof saveAiProviderSettings
    >[0];
    await expect(saveAiProviderSettings(input)).rejects.toMatchObject({
      kind: 'not_implemented',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// removeAiCredential — success path (Req 11.13, 26.1)
// ─────────────────────────────────────────────────────────────────────────────
describe('removeAiCredential — positive cases (Req 11.13)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('positive: returns settings row when removal echoes settings back', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        settings: { ...VALID_SETTINGS_ROW, credential_state: 'not_set' },
      },
      error: null,
    });

    const result = await removeAiCredential();
    expect(result).not.toBeNull();
    expect(result!.credential_state).toBe('not_set');
  });
});

describe('removeAiCredential — negative cases (Req 11.13, 26.2)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws not_implemented when edge function returns not_implemented error body', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        error: { code: 'not_implemented', message: 'Not available' },
      },
      error: null,
    });

    await expect(removeAiCredential()).rejects.toMatchObject({
      kind: 'not_implemented',
    });
  });

  it('negative: throws unauthorized when edge function returns unauthorized error body', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        error: { code: 'unauthorized', message: 'Session expired' },
      },
      error: null,
    });

    await expect(removeAiCredential()).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runCategorisation — degraded + edge-error + unknown branches (Req 19.1, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('runCategorisation — degraded/edge-error coverage (Req 19.1, 26.2)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('positive: returns available:false for degraded AI state (Req 19.1)', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        ai: {
          available: false,
          reason: 'not_configured',
          mode: 'degraded',
          message: 'AI not configured',
        },
      },
      error: null,
    });

    const result = await runCategorisation('event-1');
    expect(result.available).toBe(false);
  });

  it('negative: throws unauthorized from edge error body in categorisation', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        error: { code: 'unauthorized', message: 'Session expired' },
      },
      error: null,
    });

    await expect(runCategorisation('event-1')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('negative: throws unknown when payload is malformed in categorisation', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: { some_unexpected_field: true },
      error: null,
    });

    await expect(runCategorisation('event-1')).rejects.toMatchObject({
      kind: 'unknown',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// overrideQuestionCategory — success path (Req 15.3, 26.1)
// ─────────────────────────────────────────────────────────────────────────────
describe('overrideQuestionCategory — edge-error + success coverage (Req 15.3)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('positive: returns applied:true on success', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        applied: true,
        ai_category: 'Security',
        ai_prior_category: 'Other',
      },
      error: null,
    });

    const result = await overrideQuestionCategory({
      questionId: 'q-1',
      category: 'Security',
    });
    expect(result.applied).toBe(true);
    expect(result.ai_category).toBe('Security');
    expect(result.ai_prior_category).toBe('Other');
  });

  it('negative: throws validation from edge error body in override', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        error: {
          code: 'validation_failed',
          message: 'Invalid category',
          fields: [{ field: 'category', message: 'Invalid value' }],
        },
      },
      error: null,
    });

    await expect(
      overrideQuestionCategory({ questionId: 'q-1', category: 'Technology' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('negative: throws unknown when override response is malformed', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: { unexpected: 'response' },
      error: null,
    });

    await expect(
      overrideQuestionCategory({ questionId: 'q-1', category: 'Technology' }),
    ).rejects.toMatchObject({ kind: 'unknown' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSummary — edge error path (Req 18.7, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('runSummary — edge-error path coverage (Req 18.7, 26.2)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized from edge error body in summary', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        error: { code: 'unauthorized', message: 'Session expired' },
      },
      error: null,
    });

    await expect(runSummary('event-1')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('negative: throws unknown when summary payload is malformed', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: { some_unexpected_key: true },
      error: null,
    });

    await expect(runSummary('event-1')).rejects.toMatchObject({
      kind: 'unknown',
    });
  });
});
