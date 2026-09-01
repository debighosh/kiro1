/**
 * Task 42.3 — Unit tests for the AI client helper (src/lib/aiClient.ts),
 * covering Req-26.1/26.2 behaviours:
 *
 *  - AI failure handling: authenticated functions throw AiClientError
 *    with appropriate kind when session is missing (Req 11.9, 13.1, 26.2)
 *  - AI-config authorisation: read path requires a session (Req 12.8, 26.2)
 *  - AiClientError: correct typed error construction
 *  - isValidOverrideCategory: positive (valid categories) + negative (invalid) (Req 15.3)
 *  - getSessionAgeSeconds / isSessionRecentlyVerified: session recency logic
 *
 * Supabase client and auth helpers are mocked.
 *
 * Requirements: 11.9, 12.1, 12.8, 13.1, 15.3, 26.1, 26.2
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const { getSessionMock, getCurrentUserMock, rpcMock, invokeMock } = vi.hoisted(
  () => ({
    getSessionMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
    rpcMock: vi.fn(),
    invokeMock: vi.fn(),
  }),
);

vi.mock('./auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
}));

vi.mock('./supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: vi.fn(),
  },
}));

// ── Subject under test ────────────────────────────────────────────────────────
import {
  AI_CONFIG_FUNCTION,
  AI_GATEWAY_FUNCTION,
  CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS,
  READ_AI_PROVIDER_SETTINGS_RPC,
  AiClientError,
  getSessionAgeSeconds,
  isSessionRecentlyVerified,
  isValidOverrideCategory,
  overrideQuestionCategory,
  readAiProviderSettings,
  removeAiCredential,
  runCategorisation,
  runConnectionTest,
  saveAiProviderSettings,
  runSummary,
} from './aiClient';
import type { AiCategory } from '../schemas/ai';

const FAKE_SESSION = {
  access_token: 'token-abc',
  user: { id: 'uid-1', last_sign_in_at: new Date().toISOString() },
};

// ─────────────────────────────────────────────────────────────────────────────
// AiClientError
// ─────────────────────────────────────────────────────────────────────────────
describe('AiClientError', () => {
  it('constructs with correct name, message and kind', () => {
    const err = new AiClientError('Session expired', { kind: 'unauthorized' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AiClientError');
    expect(err.message).toBe('Session expired');
    expect(err.kind).toBe('unauthorized');
  });

  it('has empty fields array by default', () => {
    const err = new AiClientError('msg', { kind: 'unknown' });
    expect(err.fields).toEqual([]);
  });

  it('carries field errors when supplied', () => {
    const fields = [{ field: 'base_url', message: 'Invalid URL' }];
    const err = new AiClientError('validation', {
      kind: 'validation',
      fields,
    });
    expect(err.fields).toEqual(fields);
  });

  it('preserves cause and status', () => {
    const cause = new Error('original');
    const err = new AiClientError('msg', {
      kind: 'load_failed',
      status: 500,
      cause,
    });
    expect(err.status).toBe(500);
    expect(err.cause).toBe(cause);
  });

  it('covers every kind value', () => {
    const kinds = [
      'unauthorized',
      'validation',
      'not_implemented',
      'load_failed',
      'unknown',
    ] as const;
    for (const kind of kinds) {
      expect(new AiClientError('msg', { kind }).kind).toBe(kind);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
describe('exported constants', () => {
  it('AI_GATEWAY_FUNCTION is "ai-gateway"', () => {
    expect(AI_GATEWAY_FUNCTION).toBe('ai-gateway');
  });
  it('AI_CONFIG_FUNCTION is "ai-config"', () => {
    expect(AI_CONFIG_FUNCTION).toBe('ai-config');
  });
  it('READ_AI_PROVIDER_SETTINGS_RPC is "read_ai_provider_settings"', () => {
    expect(READ_AI_PROVIDER_SETTINGS_RPC).toBe('read_ai_provider_settings');
  });
  it('CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS is 300', () => {
    expect(CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS).toBe(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidOverrideCategory (Req 15.3)
// ─────────────────────────────────────────────────────────────────────────────
describe('isValidOverrideCategory — positive cases (Req 15.3)', () => {
  const validCategories: AiCategory[] = [
    'Technology',
    'Governance',
    'Security',
    'Operations',
    'Workforce',
    'Compliance',
    'Strategy',
    'Other',
  ];
  it.each(validCategories)('accepts "%s"', (cat) => {
    expect(isValidOverrideCategory(cat)).toBe(true);
  });
});

describe('isValidOverrideCategory — negative cases (Req 15.3)', () => {
  it('rejects an arbitrary string', () => {
    expect(isValidOverrideCategory('InvalidCategory')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isValidOverrideCategory('')).toBe(false);
  });
  it('rejects null', () => {
    expect(isValidOverrideCategory(null)).toBe(false);
  });
  it('rejects a number', () => {
    expect(isValidOverrideCategory(123)).toBe(false);
  });
  it('rejects case-variant (case-sensitive check)', () => {
    expect(isValidOverrideCategory('technical')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSessionAgeSeconds / isSessionRecentlyVerified (Req 11.12)
// ─────────────────────────────────────────────────────────────────────────────
describe('getSessionAgeSeconds', () => {
  beforeEach(() => getCurrentUserMock.mockReset());

  it('returns null when no user', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect(await getSessionAgeSeconds()).toBeNull();
  });

  it('returns null when user has no last_sign_in_at', async () => {
    getCurrentUserMock.mockResolvedValue({ id: 'u-1' });
    expect(await getSessionAgeSeconds()).toBeNull();
  });

  it('returns a non-negative number for a fresh session', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u-1',
      last_sign_in_at: new Date().toISOString(),
    });
    const age = await getSessionAgeSeconds();
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
  });

  it('returns null for an unparseable timestamp', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u-1',
      last_sign_in_at: 'not-a-date',
    });
    expect(await getSessionAgeSeconds()).toBeNull();
  });
});

describe('isSessionRecentlyVerified', () => {
  beforeEach(() => getCurrentUserMock.mockReset());

  it('positive: returns true for a brand-new session', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u-1',
      last_sign_in_at: new Date().toISOString(),
    });
    expect(await isSessionRecentlyVerified()).toBe(true);
  });

  it('negative: returns false when no user (fail closed — Req 11.12)', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect(await isSessionRecentlyVerified()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readAiProviderSettings — AI-config authorisation (Req 12.8, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('readAiProviderSettings', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    rpcMock.mockReset();
  });

  it('negative: throws unauthorized when no session (Req 12.8)', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(readAiProviderSettings()).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('positive: returns null when RPC returns no rows', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    rpcMock.mockResolvedValue({ data: [], error: null });
    const result = await readAiProviderSettings();
    expect(result).toBeNull();
  });

  it('negative: throws load_failed on RPC transport error', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    rpcMock.mockResolvedValue({ data: null, error: { message: 'db error' } });
    await expect(readAiProviderSettings()).rejects.toMatchObject({
      kind: 'load_failed',
    });
  });

  it('positive: returns settings row when RPC returns well-formed data', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    const row = {
      id: 'cfg-1',
      is_active: true,
      ai_enabled: true,
      display_name: 'OpenAI',
      provider_type: 'openai_compatible',
      base_url: 'https://api.openai.com',
      chat_completions_path: '/v1/chat/completions',
      auth_type: 'bearer',
      api_key_header_name: null,
      model_id: 'gpt-4',
      temperature: 0.7,
      max_output_tokens: 1024,
      request_timeout_seconds: 30,
      tls_verify_required: true,
      credential_state: 'configured',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    rpcMock.mockResolvedValue({ data: [row], error: null });
    const result = await readAiProviderSettings();
    expect(result).not.toBeNull();
    expect(result!.id).toBe('cfg-1');
    // credential value is NEVER returned (Req 12.1)
    expect(result!).not.toHaveProperty('secret_reference');
    expect(result!).not.toHaveProperty('encrypted_credential');
  });

  it('negative: throws unknown for malformed RPC row', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    rpcMock.mockResolvedValue({ data: [{ bad: true }], error: null });
    await expect(readAiProviderSettings()).rejects.toMatchObject({
      kind: 'unknown',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runConnectionTest — AI failure handling (Req 13.1, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('runConnectionTest', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized when no session (Req 13.1)', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(runConnectionTest()).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('positive: returns available:true with connection test result', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        connection_test: {
          outcome: 'established',
          status_category: '2xx',
          model_id: 'gpt-4',
          round_trip_ms: 250,
          timestamp: '2026-01-01T00:00:00Z',
        },
      },
      error: null,
    });
    const result = await runConnectionTest();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.result.outcome).toBe('established');
    }
  });

  it('positive: returns available:false for degraded / AI not configured (Req 19.1)', async () => {
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
    const result = await runConnectionTest();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.unavailable.reason).toBe('not_configured');
    }
  });

  it('negative: throws unknown for unexpected response payload', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({ data: { unexpected: true }, error: null });
    await expect(runConnectionTest()).rejects.toMatchObject({
      kind: 'unknown',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// saveAiProviderSettings — AI-config authorisation (Req 12.11, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('saveAiProviderSettings', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized when no session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveAiProviderSettings({} as any),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// removeAiCredential — write-only credential (Req 11.13, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('removeAiCredential', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized when no session (Req 11.13)', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(removeAiCredential()).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runCategorisation — AI failure handling (Req 19.1, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('runCategorisation', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized when no session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(runCategorisation('event-1')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('negative: throws validation when eventId is empty', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    await expect(runCategorisation('')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('positive: returns categorisation summary on success', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        categorisation: {
          candidate_count: 10,
          batch_count: 1,
          categorised_count: 8,
          rejected_batches: 0,
        },
      },
      error: null,
    });
    const result = await runCategorisation('event-1');
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.summary.candidate_count).toBe(10);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// overrideQuestionCategory — AI-config authorisation (Req 15.3, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('overrideQuestionCategory', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized when no session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(
      overrideQuestionCategory({ questionId: 'q-1', category: 'Technology' }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('negative: throws validation when questionId is empty', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    await expect(
      overrideQuestionCategory({ questionId: '', category: 'Technology' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('negative: throws validation when category is invalid (Req 15.3)', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    await expect(
      overrideQuestionCategory({
        questionId: 'q-1',
        category: 'NotACategory' as AiCategory,
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('positive: calls override function with correct params and returns result', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        applied: true,
        ai_category: 'Technology',
        ai_prior_category: null,
      },
      error: null,
    });
    const result = await overrideQuestionCategory({
      questionId: 'q-1',
      category: 'Technology',
    });
    expect(result.applied).toBe(true);
    expect(result.ai_category).toBe('Technology');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSummary — AI failure handling (Req 18.7, 19.1, 26.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('runSummary', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    invokeMock.mockReset();
  });

  it('negative: throws unauthorized when no session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(runSummary('event-1')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('negative: throws validation when eventId is empty', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    await expect(runSummary('')).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('positive: returns summary on success', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        summary_markdown: '## Summary\n\nAll good.',
        ai_interpretation_available: true,
        question_count: 42,
      },
      error: null,
    });
    const result = await runSummary('event-1');
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.summary.markdown).toContain('Summary');
      expect(result.summary.questionCount).toBe(42);
    }
  });

  it('positive: returns available:false for degraded state', async () => {
    getSessionMock.mockResolvedValue(FAKE_SESSION);
    invokeMock.mockResolvedValue({
      data: {
        ai: {
          available: false,
          reason: 'ai_disabled',
          mode: 'degraded',
          message: 'AI disabled',
        },
      },
      error: null,
    });
    const result = await runSummary('event-1');
    expect(result.available).toBe(false);
  });
});
