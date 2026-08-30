// Smoke test (task 1.5).
//
// Proves the Vitest runner works and that fast-check is wired up for the
// property-based tests introduced in later milestones (e.g. Property 11).
// This intentionally exercises only the test harness — no feature logic.
//
// Design ref: Testing Strategy (Vitest, fast-check). Requirements: 26.1, 26.3.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

describe('test harness smoke test', () => {
  it('runs a plain assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('runs a fast-check property: adding zero is the identity', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        return n + 0 === n;
      }),
      { numRuns: 100 },
    );
  });
});
