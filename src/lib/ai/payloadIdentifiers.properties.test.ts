/**
 * Task 35.2 — Property-based test for the AI payload participant-identifier
 * exclusion invariant (Property 19), exercised against the pure, Node-testable
 * payload-guard module in src/lib/ai/payloadGuard.ts (mirrored by the Deno
 * gateway) — imported, NEVER reimplemented.
 *
 * WHY A PURE MODULE AND NOT THE LIVE EDGE FUNCTION
 * ------------------------------------------------
 * The authoritative Gateway minimal-payload builder lives in the Deno edge
 * function (supabase/functions/ai-gateway/gateway.ts — buildMinimalPayload /
 * MinimalPayload), which already enforces "no identifiers BY CONSTRUCTION" (it
 * does not accept identifier fields at all). That Deno code cannot execute under
 * Node / Vitest in this sandbox. src/lib/ai/payloadGuard.ts is the
 * AUTHORITATIVE, runtime-agnostic COPY of the minimisation semantics
 * (MAX_QUESTION_TEXT_CHARS = 10,000; aggregate metadata number|string only) PLUS
 * the pre-transmission identifier guard, and the Deno gateway re-declares an
 * identical guard (supabase/functions/ai-gateway/payloadGuard.ts) that it calls
 * as defence-in-depth before the outbound provider call. The two are a matched
 * pair.
 *
 * This property locks down the two-part contract of Requirement 20:
 *   (a) the built MinimalPayload contains ONLY truncated question texts (≤10,000)
 *       + aggregate metadata — NO participant-identifier field is present, and
 *       none of the generated identifier VALUES appear in the serialised payload
 *       (Req 20.1, 20.3); and
 *   (b) the pre-transmission guard flags an identifier-bearing candidate payload
 *       so the pure send-decision returns { send: false } (blocked, no call) and
 *       returns { send: true } for a clean payload — the iff: send is true IFF no
 *       identifier is detected (Req 20.2).
 *
 * Validates: Requirements 20.1, 20.2, 20.3
 * Design: Correctness Properties (Property 19); Server-Side AI Gateway Design
 * (AI data handling / privacy).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  MAX_QUESTION_TEXT_CHARS,
  buildMinimalPayload,
  decideSend,
  scanForIdentifiers,
} from './payloadGuard';

// ---------------------------------------------------------------------------
// Identifier VALUE generators. Each yields an identifier-shaped string; the test
// asserts (a) such a value never survives into the built payload (the builder
// does not accept identifier fields) and (b) if one is embedded into a candidate
// payload the guard detects it and blocks the send.
// ---------------------------------------------------------------------------

/** Email `local@domain.tld`. */
const emailArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9.]{0,12}$/),
    fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
    fc.constantFrom('com', 'co.uk', 'org', 'io', 'net'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

/** Phone: `+` optional, 7–15 digits with common separators. */
const phoneArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.boolean(),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 7, maxLength: 12 }),
  )
  .map(([plus, digits]) => (plus ? '+' : '') + digits.join(''));

/** IPv4 with all octets 0–255. */
const ipv4Arb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/** IPv6 (a few representative full / compressed forms). */
const ipv6Arb: fc.Arbitrary<string> = fc.constantFrom(
  '2001:db8::1',
  'fe80::1',
  'fc00::abcd:1234',
  '2606:4700:4700::1111',
  '::1',
  'abcd:ef01:2345:6789:abcd:ef01:2345:6789',
);

/** UUID user id (8-4-4-4-12 hex). */
const uuidArb: fc.Arbitrary<string> = fc.uuid();

/** Participant name (caller-supplied identifier category). */
const nameArb: fc.Arbitrary<string> = fc.constantFrom(
  'Alice Smith',
  'Bob Jones',
  'María González',
  'Chen Wei',
  'Priya Patel',
);

/**
 * Any identifier value tagged with its category, so the test can reason about
 * which kind it expects the guard to detect.
 */
type IdKind = 'email' | 'phone' | 'ip' | 'user_id' | 'name';
interface TaggedIdentifier {
  readonly value: string;
  readonly kind: IdKind;
}

const identifierArb: fc.Arbitrary<TaggedIdentifier> = fc.oneof(
  emailArb.map((value) => ({ value, kind: 'email' as const })),
  phoneArb.map((value) => ({ value, kind: 'phone' as const })),
  ipv4Arb.map((value) => ({ value, kind: 'ip' as const })),
  ipv6Arb.map((value) => ({ value, kind: 'ip' as const })),
  uuidArb.map((value) => ({ value, kind: 'user_id' as const })),
);

/**
 * A "clean" free-text token guaranteed to contain NO identifier shape: short
 * alphabetic words and simple punctuation only (no `@`, no long digit runs, no
 * dotted quads, no colons, no UUIDs).
 */
const cleanWordArb: fc.Arbitrary<string> = fc.constantFrom(
  'how',
  'does',
  'the',
  'roadmap',
  'affect',
  'pricing',
  'team',
  'roll out',
  'next quarter',
  'what about hiring',
  'budget question',
  'timeline please',
);

/** A clean question text assembled from clean words. */
const cleanQuestionArb: fc.Arbitrary<string> = fc
  .array(cleanWordArb, { minLength: 1, maxLength: 8 })
  .map((words) => words.join(' '));

/** Clean aggregate metadata: number|string values with no identifier shapes. */
const cleanMetadataArb: fc.Arbitrary<Record<string, number | string>> = fc
  .record({
    questionCount: fc.integer({ min: 0, max: 10_000 }),
    voteTotal: fc.integer({ min: 0, max: 1_000_000 }),
    status: fc.constantFrom('active', 'closed', 'draft'),
    label: fc.constantFrom('townhall', 'allhands', 'ama'),
  })
  .map((m) => ({ ...m }));

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 19: AI payloads exclude participant
// identifiers. The minimal-payload builder accepts ONLY question texts (each
// truncated to ≤10,000 chars) and aggregate metadata (number|string) — it has
// NO identifier fields, so participant name / email / phone / user id / IP
// cannot appear in the built payload by construction (Req 20.1, 20.3). The
// pre-transmission guard scans a candidate payload for identifier shapes and the
// pure send-decision is `{ send: true }` IFF no identifier is detected, else
// `{ send: false }` (blocked, no call) (Req 20.2). Validates Req 20.1, 20.2,
// 20.3.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 19: AI payloads exclude participant identifiers', () => {
  it('builds a minimal payload of only truncated question texts + aggregate metadata; identifier VALUES never survive into it (Req 20.1, 20.3)', () => {
    fc.assert(
      fc.property(
        // Event data that INCLUDES identifier-shaped fields alongside the real
        // question texts + metadata. The builder input type does not have these
        // identifier fields — the minimisation is enforced by SHAPE.
        fc.record({
          questionTexts: fc.array(cleanQuestionArb, {
            minLength: 1,
            maxLength: 6,
          }),
          aggregateMetadata: cleanMetadataArb,
          // Identifier-shaped fields present in the raw "event data" but NOT
          // part of the builder's accepted input.
          participantName: nameArb,
          email: emailArb,
          phone: phoneArb,
          userId: uuidArb,
          ip: fc.oneof(ipv4Arb, ipv6Arb),
          // A flag to exercise the ≤10,000-char truncation on an over-long text
          // (a fixed, just-over-cap length keeps the generator cheap).
          oversize: fc.boolean(),
        }),
        (event) => {
          // Add an oversized question text (cap + 500) to test the ≤10,000 cap
          // when `oversize` is set; otherwise a normal short text.
          const oversized = event.oversize
            ? 'x'.repeat(MAX_QUESTION_TEXT_CHARS + 500)
            : 'a short trailing question';
          // Truncation check (Req 20.3): build with the (possibly oversized)
          // text and assert every question text is capped. This is asserted on a
          // dedicated payload so the expensive deep-scan/serialise assertions
          // below run on the cheap (identifier-bearing) event fields only.
          const truncPayload = buildMinimalPayload({
            questionTexts: [...event.questionTexts, oversized],
            aggregateMetadata: event.aggregateMetadata,
          });
          for (const qt of truncPayload.questionTexts) {
            expect(qt.length).toBeLessThanOrEqual(MAX_QUESTION_TEXT_CHARS);
          }

          // Main payload for the no-leak / minimisation assertions uses the
          // normal-length question texts (no giant filler block).
          const payload = buildMinimalPayload({
            questionTexts: event.questionTexts,
            aggregateMetadata: event.aggregateMetadata,
          });

          // (a) The payload has EXACTLY the two minimal fields and nothing else.
          expect(Object.keys(payload).sort()).toEqual([
            'aggregateMetadata',
            'questionTexts',
          ]);

          // Aggregate metadata passed through unchanged, values number|string.
          expect(payload.aggregateMetadata).toEqual(event.aggregateMetadata);
          for (const v of Object.values(payload.aggregateMetadata)) {
            expect(['number', 'string']).toContain(typeof v);
          }

          // None of the identifier VALUES from the event appear anywhere in the
          // serialised payload — they were never accepted by the builder
          // (Req 20.1). (The oversized text is 'x'*n so it cannot coincidentally
          // contain any identifier.)
          const serialised = JSON.stringify(payload);
          for (const idValue of [
            event.participantName,
            event.email,
            event.phone,
            event.userId,
            event.ip,
          ]) {
            expect(serialised.includes(idValue)).toBe(false);
          }

          // The scan agrees the built payload is clean, so it may be sent.
          expect(scanForIdentifiers(payload).detected).toBe(false);
          expect(decideSend(payload)).toEqual({ send: true });
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('send is true IFF no participant identifier is detected in the candidate payload (Req 20.2)', () => {
    fc.assert(
      fc.property(
        // A base clean payload.
        fc.record({
          questionTexts: fc.array(cleanQuestionArb, {
            minLength: 1,
            maxLength: 5,
          }),
          aggregateMetadata: cleanMetadataArb,
        }),
        // Optionally an identifier to embed, and WHERE to embed it.
        fc.option(identifierArb, { nil: undefined }),
        fc.constantFrom('question', 'metadata'),
        // Known participant names the caller supplies to the guard.
        fc.array(nameArb, { maxLength: 3 }),
        // Whether to also embed one of the known names into the payload.
        fc.boolean(),
        (base, identifier, where, knownNames, embedName) => {
          const questionTexts = [...base.questionTexts];
          const aggregateMetadata: Record<string, number | string> = {
            ...base.aggregateMetadata,
          };

          // Track what we expect the guard to detect.
          let expectIdentifier = false;

          if (identifier !== undefined) {
            expectIdentifier = true;
            if (where === 'question') {
              questionTexts.push(`please contact ${identifier.value} soon`);
            } else {
              aggregateMetadata.injected = String(identifier.value);
            }
          }

          if (embedName && knownNames.length > 0) {
            expectIdentifier = true;
            questionTexts.push(`asked by ${knownNames[0]} yesterday`);
          }

          const payload = buildMinimalPayload({
            questionTexts,
            aggregateMetadata,
          });

          const scan = scanForIdentifiers(payload, knownNames);
          const decision = decideSend(payload, knownNames);

          // The iff: detected IFF we embedded an identifier (shape or known
          // name). Since all base tokens are clean, no false positives arise.
          expect(scan.detected).toBe(expectIdentifier);

          // send is true IFF no identifier detected → the two agree exactly.
          expect(decision.send).toBe(!expectIdentifier);

          if (decision.send) {
            expect(decision).toEqual({ send: true });
          } else {
            // Blocked: fixed category, an identifier kind, and (being pure) no
            // call is dispatched (Req 20.2).
            expect(decision.reason).toBe('restricted_data');
            expect(['email', 'phone', 'ip', 'user_id', 'name']).toContain(
              decision.kind,
            );
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('example: a clean payload sends; an email / IP / UUID / name-bearing payload is blocked with no call (Req 20.2)', () => {
    const clean = buildMinimalPayload({
      questionTexts: ['What is the roadmap for next quarter?'],
      aggregateMetadata: { questionCount: 3, status: 'active' },
    });
    expect(decideSend(clean)).toEqual({ send: true });

    // Email embedded in a question text → blocked.
    const withEmail = buildMinimalPayload({
      questionTexts: ['ping me at alice@example.com'],
      aggregateMetadata: { questionCount: 1 },
    });
    expect(decideSend(withEmail)).toEqual({
      send: false,
      reason: 'restricted_data',
      kind: 'email',
    });

    // IPv4 embedded in a metadata value → blocked.
    const withIp = buildMinimalPayload({
      questionTexts: ['normal question'],
      aggregateMetadata: { source: '203.0.113.7' },
    });
    expect(decideSend(withIp).send).toBe(false);
    expect(scanForIdentifiers(withIp)).toEqual({ detected: true, kind: 'ip' });

    // UUID user id embedded → blocked.
    const withUuid = buildMinimalPayload({
      questionTexts: ['submitted by 3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
      aggregateMetadata: {},
    });
    expect(decideSend(withUuid)).toEqual({
      send: false,
      reason: 'restricted_data',
      kind: 'user_id',
    });

    // Known participant name embedded verbatim → blocked.
    const withName = buildMinimalPayload({
      questionTexts: ['a question asked by Alice Smith earlier'],
      aggregateMetadata: {},
    });
    expect(decideSend(withName, ['Alice Smith'])).toEqual({
      send: false,
      reason: 'restricted_data',
      kind: 'name',
    });
    // ...but the same payload without the name in knownNames is clean.
    expect(decideSend(withName, [])).toEqual({ send: true });
  });
});
