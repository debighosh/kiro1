/**
 * Task 29.6 (optional) — unit tests for the pure, Node-testable AI Gateway
 * structured-output VALIDATION + bounded-retry policy
 * (src/lib/ai/structuredOutput.ts).
 *
 * The AI Gateway itself is Deno code (supabase/functions/ai-gateway/) and
 * cannot run under Vitest, but its structured-output validation step and its
 * retry-counting rule were deliberately factored into this PURE, Node-testable
 * module. These tests lock down that decision core against the shared Zod
 * contracts in src/schemas/ai.ts (the single source of truth):
 *
 *   - `validateStructuredOutput(jobType, candidateJson)` classifies a raw
 *     candidate as `no_json` (empty/whitespace/non-string), `invalid_json`
 *     (syntax error), `schema_violation` (well-formed JSON that fails the job
 *     type's contract), `unsupported_job_type` (connection_test / unknown), or
 *     `{ valid: true, data }` for a well-formed instance of EACH structured
 *     job type (Req 14.2, 14.3, 14.7).
 *   - `isStructuredOutputJobType` / `schemaForJobType` agree on which four job
 *     types have a structured contract.
 *   - The bounded-retry helpers encode the max-3-attempts cap (Req 14.4, 14.6,
 *     19.3).
 *
 * These are PURE Node tests — no DB, no Deno, no network. They must actually
 * RUN and pass.
 *
 * Requirements: 14.2, 14.3, 14.4, 14.6, 14.7.
 * Design: Server-Side AI Gateway Design → Structured output validation +
 * bounded retry.
 */
import { describe, expect, it } from 'vitest';

import type {
  AiCategorisationResult,
  AiClusterResult,
  AiSummaryResult,
  AiThemeInsightsResult,
} from '../../schemas/ai';
import {
  MAX_STRUCTURED_OUTPUT_ATTEMPTS,
  STRUCTURED_OUTPUT_JOB_TYPES,
  isStructuredOutputJobType,
  schemaForJobType,
  shouldRetryAfterValidationFailure,
  validateStructuredOutput,
} from './structuredOutput';

// -----------------------------------------------------------------------------
// Valid UUID fixtures — the structured contracts require question ids to be
// UUIDs (Req 15.1, 16.1, 17.2), so fixtures use real, syntactically valid v4
// UUID literals.
// -----------------------------------------------------------------------------
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

// -----------------------------------------------------------------------------
// Valid fixtures for EACH structured-output job type. Each is a well-formed
// instance of the corresponding schema in src/schemas/ai.ts. Typed so a schema
// drift breaks compilation of the test rather than silently passing.
// -----------------------------------------------------------------------------
const validCategorisation: AiCategorisationResult = {
  items: [
    { question_id: UUID_A, category: 'Technology', confidence: 0.92 },
    // Confidence is optional (Req 15.6) — this item omits it deliberately.
    { question_id: UUID_B, category: 'Other' },
  ],
};

const validClustering: AiClusterResult = {
  clusters: [
    { label: 'Security concerns', question_ids: [UUID_A, UUID_B] },
    { label: 'Roadmap', question_ids: [UUID_B, UUID_C] },
  ],
  insufficient_data: false,
};

const validThemeInsights: AiThemeInsightsResult = {
  top_themes: ['Security', 'Cost'],
  emerging_concerns: ['Latency'],
  frequent_topics: ['Pricing', 'Migration'],
  notable_high_vote_questions: [
    { question_id: UUID_A, vote_count: 42, text: 'When does GA ship?' },
  ],
  has_data: true,
};

const validSummary: AiSummaryResult = {
  executive_summary: 'The event surfaced strong interest in security posture.',
  suggested_follow_up_actions: [
    'Publish a security FAQ.',
    'Schedule a follow-up deep-dive.',
  ],
};

describe('structuredOutput — job-type classification (Req 14.2)', () => {
  it('recognises exactly the four structured-output job types', () => {
    expect([...STRUCTURED_OUTPUT_JOB_TYPES]).toEqual([
      'categorisation',
      'clustering',
      'theme_insights',
      'summary',
    ]);
  });

  it('isStructuredOutputJobType is true for each structured job type', () => {
    for (const jobType of STRUCTURED_OUTPUT_JOB_TYPES) {
      expect(isStructuredOutputJobType(jobType)).toBe(true);
    }
  });

  it('isStructuredOutputJobType is false for connection_test and unknown types', () => {
    expect(isStructuredOutputJobType('connection_test')).toBe(false);
    expect(isStructuredOutputJobType('totally_unknown_job')).toBe(false);
    expect(isStructuredOutputJobType('')).toBe(false);
  });

  it('schemaForJobType returns a schema for each structured type', () => {
    for (const jobType of STRUCTURED_OUTPUT_JOB_TYPES) {
      const schema = schemaForJobType(jobType);
      expect(schema).not.toBeNull();
      // The returned schema must actually validate that job type's valid fixture.
      const fixtureByType: Record<string, unknown> = {
        categorisation: validCategorisation,
        clustering: validClustering,
        theme_insights: validThemeInsights,
        summary: validSummary,
      };
      expect(schema!.safeParse(fixtureByType[jobType]).success).toBe(true);
    }
  });

  it('schemaForJobType returns null for connection_test and unknown types', () => {
    expect(schemaForJobType('connection_test')).toBeNull();
    expect(schemaForJobType('totally_unknown_job')).toBeNull();
  });
});

describe('validateStructuredOutput — no_json (Req 14.7)', () => {
  it('returns no_json for an empty string', () => {
    expect(validateStructuredOutput('categorisation', '')).toEqual({
      valid: false,
      reason: 'no_json',
    });
  });

  it('returns no_json for a whitespace-only string', () => {
    expect(validateStructuredOutput('summary', '   \n\t  ')).toEqual({
      valid: false,
      reason: 'no_json',
    });
  });

  it('returns no_json for a non-string candidate', () => {
    // The pure module is total and must not throw on a non-string candidate.
    expect(
      validateStructuredOutput(
        'clustering',
        undefined as unknown as string,
      ),
    ).toEqual({ valid: false, reason: 'no_json' });
    expect(
      validateStructuredOutput('clustering', null as unknown as string),
    ).toEqual({ valid: false, reason: 'no_json' });
    expect(
      validateStructuredOutput('clustering', 123 as unknown as string),
    ).toEqual({ valid: false, reason: 'no_json' });
  });
});

describe('validateStructuredOutput — invalid_json (Req 14.3)', () => {
  it('returns invalid_json for a syntactically invalid JSON string', () => {
    expect(validateStructuredOutput('summary', '{ not valid json')).toEqual({
      valid: false,
      reason: 'invalid_json',
    });
  });

  it('returns invalid_json for a bare non-JSON token', () => {
    expect(validateStructuredOutput('categorisation', 'hello world')).toEqual({
      valid: false,
      reason: 'invalid_json',
    });
  });
});

describe('validateStructuredOutput — schema_violation (Req 14.2)', () => {
  it('rejects a categorisation item whose category is not in the 8-value enum', () => {
    const bad = {
      items: [{ question_id: UUID_A, category: 'Nonsense' }],
    };
    expect(
      validateStructuredOutput('categorisation', JSON.stringify(bad)),
    ).toEqual({ valid: false, reason: 'schema_violation' });
  });

  it('rejects a categorisation item with a non-UUID question_id', () => {
    const bad = {
      items: [{ question_id: 'not-a-uuid', category: 'Technology' }],
    };
    expect(
      validateStructuredOutput('categorisation', JSON.stringify(bad)),
    ).toEqual({ valid: false, reason: 'schema_violation' });
  });

  it('rejects a cluster with fewer than 2 members', () => {
    const bad = {
      clusters: [{ label: 'Lonely', question_ids: [UUID_A] }],
      insufficient_data: false,
    };
    expect(
      validateStructuredOutput('clustering', JSON.stringify(bad)),
    ).toEqual({ valid: false, reason: 'schema_violation' });
  });

  it('rejects a theme-insights result exceeding the top_themes cap (>5)', () => {
    const bad = {
      top_themes: ['a', 'b', 'c', 'd', 'e', 'f'],
      emerging_concerns: [],
      frequent_topics: [],
      notable_high_vote_questions: [],
      has_data: true,
    };
    expect(
      validateStructuredOutput('theme_insights', JSON.stringify(bad)),
    ).toEqual({ valid: false, reason: 'schema_violation' });
  });

  it('rejects a notable question with a negative vote_count', () => {
    const bad = {
      top_themes: [],
      emerging_concerns: [],
      frequent_topics: [],
      notable_high_vote_questions: [
        { question_id: UUID_A, vote_count: -1, text: 'x' },
      ],
      has_data: true,
    };
    expect(
      validateStructuredOutput('theme_insights', JSON.stringify(bad)),
    ).toEqual({ valid: false, reason: 'schema_violation' });
  });

  it('rejects a summary missing required fields', () => {
    const bad = { executive_summary: 'only this field' };
    expect(
      validateStructuredOutput('summary', JSON.stringify(bad)),
    ).toEqual({ valid: false, reason: 'schema_violation' });
  });
});

describe('validateStructuredOutput — unsupported_job_type', () => {
  it('returns unsupported_job_type for connection_test', () => {
    expect(
      validateStructuredOutput(
        'connection_test',
        JSON.stringify({ anything: true }),
      ),
    ).toEqual({ valid: false, reason: 'unsupported_job_type' });
  });

  it('returns unsupported_job_type for an unknown job type', () => {
    expect(
      validateStructuredOutput('totally_unknown_job', '{}'),
    ).toEqual({ valid: false, reason: 'unsupported_job_type' });
  });

  it('checks job type BEFORE candidate content (fails closed on unknown type)', () => {
    // Even an empty candidate for an unknown type is unsupported_job_type,
    // not no_json — the job-type gate is evaluated first.
    expect(validateStructuredOutput('connection_test', '')).toEqual({
      valid: false,
      reason: 'unsupported_job_type',
    });
  });
});

describe('validateStructuredOutput — valid instances of each job type (Req 14.2)', () => {
  it('accepts a well-formed categorisation result and returns the parsed data', () => {
    const result = validateStructuredOutput(
      'categorisation',
      JSON.stringify(validCategorisation),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual(validCategorisation);
    }
  });

  it('accepts a well-formed clustering result and returns the parsed data', () => {
    const result = validateStructuredOutput(
      'clustering',
      JSON.stringify(validClustering),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual(validClustering);
    }
  });

  it('accepts a well-formed theme_insights result and returns the parsed data', () => {
    const result = validateStructuredOutput(
      'theme_insights',
      JSON.stringify(validThemeInsights),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual(validThemeInsights);
    }
  });

  it('accepts a well-formed summary result and returns the parsed data', () => {
    const result = validateStructuredOutput(
      'summary',
      JSON.stringify(validSummary),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual(validSummary);
    }
  });
});

describe('bounded-retry policy (Req 14.4, 14.6, 19.3)', () => {
  it('caps total attempts at 3 (1 initial + 2 retries)', () => {
    expect(MAX_STRUCTURED_OUTPUT_ATTEMPTS).toBe(3);
  });

  it('permits a retry after attempts 1 and 2', () => {
    expect(shouldRetryAfterValidationFailure(1)).toBe(true);
    expect(shouldRetryAfterValidationFailure(2)).toBe(true);
  });

  it('forbids a retry once attempt 3 (the cap) has completed', () => {
    expect(shouldRetryAfterValidationFailure(3)).toBe(false);
    expect(shouldRetryAfterValidationFailure(4)).toBe(false);
  });

  it('forbids a retry for boundary / invalid attempt counts', () => {
    expect(shouldRetryAfterValidationFailure(0)).toBe(false);
    expect(shouldRetryAfterValidationFailure(-1)).toBe(false);
    expect(shouldRetryAfterValidationFailure(Number.NaN)).toBe(false);
    expect(shouldRetryAfterValidationFailure(Number.POSITIVE_INFINITY)).toBe(
      false,
    );
  });
});
