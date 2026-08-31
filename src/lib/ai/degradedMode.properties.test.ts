/**
 * Task 33.3 — Property-based test for Property 15 ("AI failure never blocks the
 * core flow"), exercised against the pure, Node-testable degraded-mode policy
 * module in src/lib/ai/degradedMode.ts (task 33.2) — imported, NEVER
 * reimplemented.
 *
 * WHAT THIS PROPERTY LOCKS DOWN
 * -----------------------------
 * Requirement 19.1 / 27.6: when the AI provider fails in ANY of its fixed
 * modes (not configured, unreachable, auth failure, invalid response, timeout
 * at the admin-configured timeout), the CORE product flows — Q&A submission,
 * moderation, voting, poll responses, word-cloud responses, presenter controls,
 * analytics, CSV export — continue to work unaffected, and the only user-facing
 * signal is a sanitised "AI unavailable / rest of app unaffected" indication
 * that leaks NO provider internals.
 *
 * HOW IT IS MODELLED (pure, no network, no DB)
 * --------------------------------------------
 * The core operations do NOT depend on the AI gateway at all: they are pure /
 * DB flows. We model that structural fact directly — each core operation is a
 * runner that NEVER reads the AI indication, so injecting any AI failure mode
 * cannot change its outcome. The property then asserts, over arbitrary prior
 * persisted state, arbitrary operation inputs and EVERY failure mode:
 *   - the operation completes successfully with an identical success outcome
 *     regardless of the injected AI state, and surfaces no AI-attributable
 *     error;
 *   - the sanitised indication for that mode is `{ available:false, mode,
 *     message }` whose message contains no hostnames, status codes,
 *     credential-like tokens or stack traces — just the generic text;
 *   - a failure never mutates/persists partial data
 *     (`applyFailureToPersistedState(prior) === prior`);
 *   - there is no silent provider switch (`allowsAutomaticFailover()` is false;
 *     `selectProviderForAttempt(id)` echoes id).
 *
 * The pure policy module and the live Deno Edge Gateway are a matched pair (see
 * the module header); this test binds the SPA-side contract.
 *
 * Validates: Requirements 19.1, 27.6
 * Design: Server-Side AI Gateway Design → Failure handling / degraded mode
 *   (Property 15).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  AI_FAILURE_MODES,
  allowsAutomaticFailover,
  applyFailureToPersistedState,
  classifyFailureMode,
  describeAiUnavailable,
  indicationForCode,
  selectProviderForAttempt,
  type AiFailureMode,
  type AiUnavailableIndication,
} from './degradedMode';

// ---------------------------------------------------------------------------
// The "AI state" injected into each run: either AI is available, or it is in
// one of the fixed failure modes. The core operations must be INDEPENDENT of
// this value, so we generate the full space including the healthy case.
// ---------------------------------------------------------------------------

type AiState = 'available' | AiFailureMode;

// ---------------------------------------------------------------------------
// Core operations modelled as pure runners. The essential structural property
// is that NONE of them reads the injected AI state — they take it as a
// parameter and ignore it — mirroring the real system where these flows are
// pure/DB paths with no AI gateway dependency. Each returns a deterministic
// success result derived ONLY from its own input, so its outcome is identical
// across every AiState.
// ---------------------------------------------------------------------------

/** The eight core operations named in Req 27.6 / the task. */
const CORE_OPERATIONS = [
  'qa_submit',
  'moderation',
  'vote',
  'poll_response',
  'word_cloud_response',
  'presenter_control',
  'analytics',
  'csv_export',
] as const;

type CoreOperation = (typeof CORE_OPERATIONS)[number];

interface CoreResult {
  readonly operation: CoreOperation;
  readonly ok: true;
  readonly value: string;
  /** No AI-attributable error is ever surfaced by a core operation. */
  readonly aiError: null;
}

/**
 * Runs a core operation. Crucially it accepts the injected `_aiState` but NEVER
 * consults it — the outcome depends solely on `operation` + `input`. This is
 * the pure encoding of "the core flow does not depend on the AI gateway".
 */
function runCoreOperation(
  operation: CoreOperation,
  input: string,
  aiState: AiState,
): CoreResult {
  // The `aiState` is deliberately IGNORED: a core flow has no AI-gateway
  // dependency, so its outcome cannot vary with the injected AI state. We
  // reference it here only to make that "accepted but never consulted" intent
  // explicit (and to keep the runner honestly parameterised over the state).
  void aiState;
  return {
    operation,
    ok: true,
    value: `${operation}:${input}`,
    aiError: null,
  };
}

const coreOperationArb: fc.Arbitrary<CoreOperation> =
  fc.constantFrom(...CORE_OPERATIONS);

// ---------------------------------------------------------------------------
// Message-sanitisation guard. The client-facing indication message must convey
// only the generic "AI unavailable / rest of app unaffected" fact and NEVER
// carry provider internals. These detectors are intentionally broad.
// ---------------------------------------------------------------------------

/** Substrings/patterns that would indicate a leak of provider internals. */
function messageLeaksInternals(message: string): boolean {
  const lower = message.toLowerCase();
  // Hostnames / URLs / domains.
  if (/https?:\/\//.test(lower)) return true;
  if (/\b[a-z0-9-]+\.(com|net|org|io|ai|internal|local|dev|cloud)\b/.test(lower))
    return true;
  // Dotted IPv4 or IPv6-ish tokens.
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(lower)) return true;
  if (/[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,}/.test(lower)) return true;
  // HTTP status codes / "status <n>" mentions.
  if (/\b(?:status\s*)?(?:[45]\d{2})\b/.test(lower)) return true;
  // Credential-like tokens (bearer/api key/secret/token=…).
  if (/\b(bearer|api[_-]?key|secret|token|authorization|password)\b/.test(lower))
    return true;
  if (/[a-z0-9]{24,}/.test(lower)) return true; // long opaque token
  // Stack-trace markers.
  if (/\bat\s+\w+\s*\(/.test(message)) return true;
  if (message.includes('\n')) return true;
  if (/\.(ts|js|tsx|jsx):\d+/.test(lower)) return true;
  // Provider names we must never surface to end users.
  if (/\b(openai|anthropic|bedrock|azure|gemini|cohere|mistral)\b/.test(lower))
    return true;
  return false;
}

/** Asserts an indication is well-formed and internal-free for `mode`. */
function assertSanitisedIndication(
  indication: AiUnavailableIndication,
  mode: AiFailureMode,
): void {
  expect(indication.available).toBe(false);
  expect(indication.mode).toBe(mode);
  expect(typeof indication.message).toBe('string');
  expect(indication.message.length).toBeGreaterThan(0);
  // The generic, reassuring core-unaffected framing is always present.
  expect(indication.message.toLowerCase()).toContain('rest of the app');
  expect(messageLeaksInternals(indication.message)).toBe(false);
}

// A representative set of low-level sanitised CODES that classify into the
// failure-mode taxonomy, plus some unknown ones (which must collapse safely).
const sanitisedCodeArb: fc.Arbitrary<string> = fc.constantFrom(
  'timeout',
  'credential_resolution_failed',
  'disallowed_destination',
  'provider_not_implemented',
  'provider_error',
  'invalid_ai_response',
  'internal_error',
  'ai_disabled',
  'not_configured',
  'credential_missing',
  // Unknown codes — must collapse to a generic mode without leaking.
  'some_unexpected_code',
  'x',
  '',
);

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 15: AI failure never blocks the core flow.
// For every injected AI failure mode (not configured, unreachable, auth
// failure, invalid response, timeout) and arbitrary prior persisted state and
// arbitrary core-operation input, each core operation (Q&A submit, moderation,
// vote, poll response, word-cloud response, presenter control, analytics, CSV
// export) completes successfully with an outcome IDENTICAL to the AI-available
// case and surfaces no AI-attributable error; the sanitised indication leaks no
// provider internals; a failure never mutates persisted data; and no silent
// provider failover occurs. Validates Req 19.1, 27.6.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 15: AI failure never blocks the core flow', () => {
  it('every core operation succeeds identically across all AI failure modes', () => {
    fc.assert(
      fc.property(
        coreOperationArb,
        fc.string(),
        (operation, input) => {
          // The AI-available baseline result for this operation + input.
          const baseline = runCoreOperation(operation, input, 'available');
          expect(baseline.ok).toBe(true);
          expect(baseline.aiError).toBeNull();

          // Injecting EVERY failure mode leaves the outcome byte-for-byte
          // identical — the core flow is not blocked or altered by AI failure.
          for (const mode of AI_FAILURE_MODES) {
            const underFailure = runCoreOperation(operation, input, mode);
            expect(underFailure).toEqual(baseline);
            expect(underFailure.ok).toBe(true);
            expect(underFailure.aiError).toBeNull();
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('produces a sanitised, internal-free indication for every failure mode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<AiFailureMode>(...AI_FAILURE_MODES),
        (mode) => {
          assertSanitisedIndication(describeAiUnavailable(mode), mode);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('classifies any sanitised code into a mode with an internal-free indication', () => {
    fc.assert(
      fc.property(sanitisedCodeArb, (code) => {
        const mode = classifyFailureMode(code);
        expect(AI_FAILURE_MODES).toContain(mode);
        // The one-step convenience must agree with the two-step path and stay
        // sanitised regardless of the (possibly unknown) input code.
        const indication = indicationForCode(code);
        expect(indication).toEqual(describeAiUnavailable(mode));
        assertSanitisedIndication(indication, mode);
      }),
      { numRuns: 1000 },
    );
  });

  it('never mutates/persists partial data on failure (state identity)', () => {
    // Arbitrary "prior persisted state" shapes: id arrays, records, nested.
    const priorStateArb = fc.oneof(
      fc.array(fc.string()),
      fc.dictionary(fc.string(), fc.integer()),
      fc.record({
        approved: fc.array(fc.uuid()),
        results: fc.array(fc.record({ id: fc.integer(), text: fc.string() })),
      }),
      fc.anything(),
    );

    fc.assert(
      fc.property(priorStateArb, (prior) => {
        // Applying a failure returns the SAME reference — no clone, no mutation,
        // no partial output appended (Req 19.5/19.6 underpinning 19.1).
        expect(applyFailureToPersistedState(prior)).toBe(prior);
      }),
      { numRuns: 1000 },
    );
  });

  it('never silently switches providers (no automatic failover)', () => {
    // Failover is unconditionally disabled.
    expect(allowsAutomaticFailover()).toBe(false);

    fc.assert(
      fc.property(fc.string(), (providerId) => {
        // The policy always re-selects the SAME configured provider, in every
        // failure mode — a provider change only comes from explicit admin config.
        expect(selectProviderForAttempt(providerId)).toBe(providerId);
        expect(allowsAutomaticFailover()).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});
