/**
 * Task 42.3 — Coverage-gap tests for src/lib/ai/degradedMode.ts (Req 26.1, 26.2, 26.3).
 *
 * Targets functions NOT called by degradedMode.properties.test.ts:
 *   - planManualRetry(): must return exactly MANUAL_RETRY_PLAN (Req 19.4)
 *   - isAiFailureMode(): positive (known modes) + negative (unknown strings) (Req 19.1)
 *
 * Requirements: 19.1, 19.4, 26.1, 26.2
 */
import { describe, expect, it } from 'vitest';
import {
  AI_FAILURE_MODES,
  isAiFailureMode,
  MANUAL_RETRY_PLAN,
  planManualRetry,
} from './degradedMode';

// ─────────────────────────────────────────────────────────────────────────────
// planManualRetry (Req 19.4)
// ─────────────────────────────────────────────────────────────────────────────
describe('planManualRetry — positive cases (Req 19.4)', () => {
  it('positive: returns an object with attempts = 1 and allowsAutomaticRetry = false', () => {
    const plan = planManualRetry();
    expect(plan.attempts).toBe(1);
    expect(plan.allowsAutomaticRetry).toBe(false);
  });

  it('positive: returns the canonical MANUAL_RETRY_PLAN constant (referential equality)', () => {
    // The function must return the frozen constant — callers rely on it being the same shape
    const plan = planManualRetry();
    expect(plan).toBe(MANUAL_RETRY_PLAN);
  });

  it('positive: is immutable — plan cannot be mutated by a caller (Req 19.4)', () => {
    const plan = planManualRetry();
    expect(() => {
      // Attempting to assign on a frozen object throws in strict mode
      (plan as unknown as Record<string, unknown>).attempts = 99;
    }).toThrow();
  });
});

describe('planManualRetry — negative cases (Req 19.4)', () => {
  it('negative: plan.allowsAutomaticRetry is never true', () => {
    // A manual retry MUST NOT allow automatic chaining (Req 19.4)
    expect(planManualRetry().allowsAutomaticRetry).not.toBe(true);
  });

  it('negative: plan.attempts is never more than 1', () => {
    expect(planManualRetry().attempts).not.toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isAiFailureMode (Req 19.1)
// ─────────────────────────────────────────────────────────────────────────────
describe('isAiFailureMode — positive cases (Req 19.1)', () => {
  it('positive: returns true for every fixed AI_FAILURE_MODE', () => {
    for (const mode of AI_FAILURE_MODES) {
      expect(isAiFailureMode(mode)).toBe(true);
    }
  });

  it('positive: accepts "not_configured"', () => {
    expect(isAiFailureMode('not_configured')).toBe(true);
  });

  it('positive: accepts "unreachable"', () => {
    expect(isAiFailureMode('unreachable')).toBe(true);
  });

  it('positive: accepts "auth_failure"', () => {
    expect(isAiFailureMode('auth_failure')).toBe(true);
  });

  it('positive: accepts "invalid_response"', () => {
    expect(isAiFailureMode('invalid_response')).toBe(true);
  });

  it('positive: accepts "timeout"', () => {
    expect(isAiFailureMode('timeout')).toBe(true);
  });
});

describe('isAiFailureMode — negative cases (Req 19.1)', () => {
  it('negative: rejects an arbitrary unknown string', () => {
    expect(isAiFailureMode('network_error')).toBe(false);
  });

  it('negative: rejects an empty string', () => {
    expect(isAiFailureMode('')).toBe(false);
  });

  it('negative: rejects a case-variant of a known mode', () => {
    expect(isAiFailureMode('Timeout')).toBe(false);
    expect(isAiFailureMode('UNREACHABLE')).toBe(false);
  });

  it('negative: rejects a partial match of a known mode', () => {
    expect(isAiFailureMode('timeout_exceeded')).toBe(false);
  });
});
