/**
 * Task 28.3 (optional) — EXAMPLE-BASED unit tests for the SHARED AI provider
 * settings Zod schema boundaries (src/schemas/ai.ts).
 *
 * These are unit / example tests exercising the canonical validation contract
 * used by BOTH the SPA settings form and the AI Gateway Edge Function's
 * authoritative server-side re-validation. For each bounded field they assert
 * that:
 *   - the value one step BELOW the minimum (or above the maximum) is REJECTED,
 *   - the boundary value itself is ACCEPTED, and — crucially —
 *   - the ZodError issue is attributed to the CORRECT field (field-specific
 *     rejection: `issue.path` points at that field).
 *
 * They also cover:
 *   - the conditional `api_key_header_name` requirement (required ONLY when
 *     `auth_type === 'api_key_header'`; omitted/ignored otherwise) (Req 11.5),
 *   - `base_url` absolute-http(s)-URL validation (relative path rejected,
 *     non-http scheme rejected, valid https accepted) (Req 11.1), and
 *   - the write-only `credential` 1–8192 length bound (Req 12.2).
 *
 * Requirements: 11.1, 11.5, 12.2, 26.1.
 * Design: Error Handling → Validation errors (shared Zod schemas, client +
 * server); Data Models → `ai_provider_settings` column constraints (Req 11).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AI_API_KEY_HEADER_NAME_MAX,
  AI_BASE_URL_MAX,
  AI_CREDENTIAL_MAX,
  AI_DISPLAY_NAME_MAX,
  AI_MAX_OUTPUT_TOKENS_MAX,
  AI_MAX_OUTPUT_TOKENS_MIN,
  AI_MODEL_ID_MAX,
  AI_REQUEST_TIMEOUT_SECONDS_MAX,
  AI_REQUEST_TIMEOUT_SECONDS_MIN,
  AI_TEMPERATURE_MAX,
  AI_TEMPERATURE_MIN,
  aiProviderSettingsInputSchema,
  aiProviderSettingsEditInputSchema,
  isAbsoluteHttpUrl,
} from './ai';

// ===========================================================================
// A known-VALID create/replace input. Individual tests clone this and mutate a
// single field so any rejection is unambiguously attributable to that field.
// ===========================================================================
function validInput(): Record<string, unknown> {
  return {
    display_name: 'Primary OpenAI',
    ai_enabled: true,
    provider_type: 'openai_compatible',
    base_url: 'https://api.example.com',
    chat_completions_path: '/v1/chat/completions',
    auth_type: 'bearer',
    model_id: 'gpt-4o-mini',
    temperature: 0.7,
    max_output_tokens: 1024,
    request_timeout_seconds: 30,
    tls_verify_required: true,
  };
}

/**
 * Parse `input` and return the FIRST issue path that ends in `field`, or the
 * full issue list when none match — so a failed expectation prints something
 * useful. Asserts the parse actually failed.
 */
function expectRejectedAtField(
  input: Record<string, unknown>,
  field: string,
): void {
  const result = aiProviderSettingsInputSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) return; // narrow for TS; unreachable after the assert.
  const paths = result.error.issues.map((issue) => issue.path.join('.'));
  expect(paths).toContain(field);
}

function expectAccepted(input: Record<string, unknown>): void {
  const result = aiProviderSettingsInputSchema.safeParse(input);
  expect(result.success).toBe(true);
}

describe('aiProviderSettingsInputSchema — a fully valid input parses', () => {
  it('accepts the baseline valid input (Req 11.1)', () => {
    expectAccepted(validInput());
  });
});

describe('display_name boundaries (Req 11.1)', () => {
  it('rejects empty (min-1) attributing the error to display_name', () => {
    expectRejectedAtField(
      { ...validInput(), display_name: '' },
      'display_name',
    );
  });
  it('rejects over-max attributing the error to display_name', () => {
    expectRejectedAtField(
      { ...validInput(), display_name: 'a'.repeat(AI_DISPLAY_NAME_MAX + 1) },
      'display_name',
    );
  });
  it('accepts the max boundary length', () => {
    expectAccepted({
      ...validInput(),
      display_name: 'a'.repeat(AI_DISPLAY_NAME_MAX),
    });
  });
});

describe('base_url boundaries and absolute-URL rule (Req 11.1)', () => {
  it('rejects empty attributing the error to base_url', () => {
    expectRejectedAtField({ ...validInput(), base_url: '' }, 'base_url');
  });
  it('rejects over-max attributing the error to base_url', () => {
    // Build a syntactically-valid-but-too-long https URL.
    const tooLong = 'https://a.example.com/' + 'x'.repeat(AI_BASE_URL_MAX + 1);
    expectRejectedAtField({ ...validInput(), base_url: tooLong }, 'base_url');
  });
  it('rejects a relative path (not absolute) at base_url', () => {
    expectRejectedAtField(
      { ...validInput(), base_url: '/v1/chat' },
      'base_url',
    );
  });
  it('rejects a non-http scheme at base_url', () => {
    expectRejectedAtField(
      { ...validInput(), base_url: 'ftp://api.example.com' },
      'base_url',
    );
  });
  it('accepts a valid https absolute URL', () => {
    expectAccepted({ ...validInput(), base_url: 'https://api.example.com/v1' });
  });
  it('accepts a valid http absolute URL', () => {
    expectAccepted({ ...validInput(), base_url: 'http://localhost:8080' });
  });
});

describe('isAbsoluteHttpUrl helper (Req 11.1)', () => {
  it('returns true for http and https absolute URLs', () => {
    expect(isAbsoluteHttpUrl('https://api.example.com')).toBe(true);
    expect(isAbsoluteHttpUrl('http://localhost:1234/path')).toBe(true);
  });
  it('returns false for relative paths and non-http schemes', () => {
    expect(isAbsoluteHttpUrl('/v1/chat')).toBe(false);
    expect(isAbsoluteHttpUrl('ftp://host/x')).toBe(false);
    expect(isAbsoluteHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isAbsoluteHttpUrl('not a url')).toBe(false);
  });
});

describe('model_id boundaries (Req 11.1)', () => {
  it('rejects empty attributing the error to model_id', () => {
    expectRejectedAtField({ ...validInput(), model_id: '' }, 'model_id');
  });
  it('rejects over-max attributing the error to model_id', () => {
    expectRejectedAtField(
      { ...validInput(), model_id: 'm'.repeat(AI_MODEL_ID_MAX + 1) },
      'model_id',
    );
  });
  it('accepts the max boundary length', () => {
    expectAccepted({ ...validInput(), model_id: 'm'.repeat(AI_MODEL_ID_MAX) });
  });
});

describe('temperature boundaries 0.0–2.0 (Req 11.1)', () => {
  it('rejects below-min attributing the error to temperature', () => {
    expectRejectedAtField(
      { ...validInput(), temperature: AI_TEMPERATURE_MIN - 0.1 },
      'temperature',
    );
  });
  it('rejects above-max attributing the error to temperature', () => {
    expectRejectedAtField(
      { ...validInput(), temperature: AI_TEMPERATURE_MAX + 0.1 },
      'temperature',
    );
  });
  it('accepts both boundary values', () => {
    expectAccepted({ ...validInput(), temperature: AI_TEMPERATURE_MIN });
    expectAccepted({ ...validInput(), temperature: AI_TEMPERATURE_MAX });
  });
});

describe('max_output_tokens boundaries 1–128000 (Req 11.1)', () => {
  it('rejects below-min attributing the error to max_output_tokens', () => {
    expectRejectedAtField(
      { ...validInput(), max_output_tokens: AI_MAX_OUTPUT_TOKENS_MIN - 1 },
      'max_output_tokens',
    );
  });
  it('rejects above-max attributing the error to max_output_tokens', () => {
    expectRejectedAtField(
      { ...validInput(), max_output_tokens: AI_MAX_OUTPUT_TOKENS_MAX + 1 },
      'max_output_tokens',
    );
  });
  it('accepts both boundary values', () => {
    expectAccepted({
      ...validInput(),
      max_output_tokens: AI_MAX_OUTPUT_TOKENS_MIN,
    });
    expectAccepted({
      ...validInput(),
      max_output_tokens: AI_MAX_OUTPUT_TOKENS_MAX,
    });
  });
});

describe('request_timeout_seconds boundaries 1–300 (Req 11.1)', () => {
  it('rejects below-min attributing the error to request_timeout_seconds', () => {
    expectRejectedAtField(
      {
        ...validInput(),
        request_timeout_seconds: AI_REQUEST_TIMEOUT_SECONDS_MIN - 1,
      },
      'request_timeout_seconds',
    );
  });
  it('rejects above-max attributing the error to request_timeout_seconds', () => {
    expectRejectedAtField(
      {
        ...validInput(),
        request_timeout_seconds: AI_REQUEST_TIMEOUT_SECONDS_MAX + 1,
      },
      'request_timeout_seconds',
    );
  });
  it('accepts both boundary values', () => {
    expectAccepted({
      ...validInput(),
      request_timeout_seconds: AI_REQUEST_TIMEOUT_SECONDS_MIN,
    });
    expectAccepted({
      ...validInput(),
      request_timeout_seconds: AI_REQUEST_TIMEOUT_SECONDS_MAX,
    });
  });
});

describe('credential boundaries 1–8192 (Req 12.2)', () => {
  it('rejects empty attributing the error to credential', () => {
    expectRejectedAtField({ ...validInput(), credential: '' }, 'credential');
  });
  it('rejects over-max attributing the error to credential', () => {
    expectRejectedAtField(
      { ...validInput(), credential: 'k'.repeat(AI_CREDENTIAL_MAX + 1) },
      'credential',
    );
  });
  it('accepts the max boundary length', () => {
    expectAccepted({
      ...validInput(),
      credential: 'k'.repeat(AI_CREDENTIAL_MAX),
    });
  });
  it('accepts a credential with leading/trailing whitespace (not trimmed)', () => {
    // Credentials must be preserved byte-for-byte (Req 12.2 note in schema).
    expectAccepted({ ...validInput(), credential: '  secret  ' });
  });
});

describe('conditional api_key_header_name requirement (Req 11.5)', () => {
  it('rejects when auth_type is api_key_header and the name is missing', () => {
    const input = { ...validInput(), auth_type: 'api_key_header' };
    delete (input as Record<string, unknown>).api_key_header_name;
    expectRejectedAtField(input, 'api_key_header_name');
  });
  it('accepts when auth_type is api_key_header and a valid name is present', () => {
    expectAccepted({
      ...validInput(),
      auth_type: 'api_key_header',
      api_key_header_name: 'X-Api-Key',
    });
  });
  it('accepts when auth_type is bearer and the name is omitted', () => {
    // The name is not required for non-api_key_header auth types.
    expectAccepted({ ...validInput(), auth_type: 'bearer' });
  });
  it('accepts when auth_type is none and the name is omitted', () => {
    expectAccepted({ ...validInput(), auth_type: 'none' });
  });
  it('rejects an over-max api_key_header_name at the correct field', () => {
    expectRejectedAtField(
      {
        ...validInput(),
        auth_type: 'api_key_header',
        api_key_header_name: 'H'.repeat(AI_API_KEY_HEADER_NAME_MAX + 1),
      },
      'api_key_header_name',
    );
  });
});

describe('aiProviderSettingsEditInputSchema — partial edits (Req 11.1, 11.5)', () => {
  it('accepts an empty partial update', () => {
    const result = aiProviderSettingsEditInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });
  it('accepts a single-field update that satisfies its bound', () => {
    const result = aiProviderSettingsEditInputSchema.safeParse({
      display_name: 'Renamed',
    });
    expect(result.success).toBe(true);
  });
  it('rejects a single-field update that violates its bound, at that field', () => {
    const result = aiProviderSettingsEditInputSchema.safeParse({
      model_id: '',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('model_id');
  });
  it('re-checks the conditional header-name rule when auth_type is supplied', () => {
    const result = aiProviderSettingsEditInputSchema.safeParse({
      auth_type: 'api_key_header',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('api_key_header_name');
  });
  it('does not require the header name when auth_type is absent', () => {
    const result = aiProviderSettingsEditInputSchema.safeParse({
      display_name: 'Renamed only',
    });
    expect(result.success).toBe(true);
  });
});

// Reference `z` so an unused-import lint rule cannot fire in environments that
// tree-shake type-only usage; this also documents the schema library in use.
describe('schema library sanity', () => {
  it('uses zod safeParse discriminated results', () => {
    expect(typeof z.object).toBe('function');
  });
});
