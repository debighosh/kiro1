/**
 * Task 29.7 — Property-based test for the SSRF allowlist enforcement invariant
 * (Property 16), exercised against the pure, Node-testable SSRF decision module
 * in src/lib/ai/ssrf.ts (task 29.2) — imported, NEVER reimplemented.
 *
 * WHY A PURE MODULE AND NOT THE LIVE EDGE FUNCTION
 * ------------------------------------------------
 * The authoritative Gateway SSRF guard lives in the Deno edge function
 * (supabase/functions/ai-gateway/ssrf.ts), which performs real DNS resolution
 * and TLS-preserving connection pinning — none of which can execute under Node
 * / Vitest in this sandbox (no Deno globals, no network I/O). src/lib/ai/ssrf.ts
 * is the AUTHORITATIVE, runtime-agnostic copy of the allow/deny DECISION: it
 * takes an ALREADY-RESOLVED list of IPs (plus the scheme and allowlist) and
 * returns a pure decision with NO network I/O. The edge wrapper re-declares an
 * identical rule set; the two are a matched pair.
 *
 * This property locks down the "iff" contract the SQL/Deno side encodes: a
 * destination is sent to IFF the scheme is http/https AND every resolved IP is
 * public OR explicitly allowlisted, and a blocked destination is denied WITHOUT
 * any request being dispatched (the decision is pure — it cannot dial anything).
 *
 * Validates: Requirements 13.6, 13.7, 13.8, 13.9
 * Design: Server-Side AI Gateway Design → SSRF protection (Property 16).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  METADATA_IPV4,
  evaluateSsrfDestination,
  isAllowedScheme,
  isBlockedRange,
} from './ssrf';

// ---------------------------------------------------------------------------
// IP class generators. Each arbitrary yields an IP string together with the
// class it was drawn from, so the test can compute the EXPECTED blocked/public
// classification independently of the module under test. The `blocked` flag is
// asserted against `isBlockedRange` as a self-check so the generators can never
// silently drift from the module's classification.
// ---------------------------------------------------------------------------

type IpClass = 'public' | 'link-local' | 'loopback' | 'private';

interface ClassifiedIp {
  readonly ip: string;
  readonly ipClass: IpClass;
  /** True iff the address is in a default-blocked range (i.e. NOT public). */
  readonly blocked: boolean;
}

/** Public IPv4 — avoids every default-blocked leading octet/range. */
const publicIpv4Arb: fc.Arbitrary<ClassifiedIp> = fc
  .tuple(
    fc.integer({ min: 1, max: 223 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 254 }),
  )
  .filter(([a, b]) => {
    // Exclude every blocked range so the class label is trustworthy.
    if (a === 10 || a === 127) return false; // private 10/8, loopback 127/8
    if (a === 169 && b === 254) return false; // link-local 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
    if (a === 192 && b === 168) return false; // private 192.168/16
    return true;
  })
  .map(([a, b, c, d]) => ({
    ip: `${a}.${b}.${c}.${d}`,
    ipClass: 'public' as const,
    blocked: false,
  }));

/** A few well-known public anchors so common cases are always covered. */
const publicAnchorArb: fc.Arbitrary<ClassifiedIp> = fc
  .constantFrom('8.8.8.8', '1.1.1.1', '203.0.113.7', '2606:4700:4700::1111')
  .map((ip) => ({ ip, ipClass: 'public' as const, blocked: false }));

/** Link-local / cloud-metadata — 169.254.0.0/16 (incl. metadata) + fe80::/10. */
const linkLocalArb: fc.Arbitrary<ClassifiedIp> = fc
  .oneof(
    fc
      .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
      .map(([c, d]) => `169.254.${c}.${d}`),
    fc.constant(METADATA_IPV4),
    fc.constant('fe80::1'),
    fc.constant('fe80::abcd:1234'),
  )
  .map((ip) => ({ ip, ipClass: 'link-local' as const, blocked: true }));

/** Loopback — 127.0.0.0/8 and IPv6 ::1. */
const loopbackArb: fc.Arbitrary<ClassifiedIp> = fc
  .oneof(
    fc
      .tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 254 }),
      )
      .map(([b, c, d]) => `127.${b}.${c}.${d}`),
    fc.constant('::1'),
  )
  .map((ip) => ({ ip, ipClass: 'loopback' as const, blocked: true }));

/** Private — 10/8, 172.16/12, 192.168/16, and IPv6 fc00::/7. */
const privateArb: fc.Arbitrary<ClassifiedIp> = fc
  .oneof(
    fc
      .tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 254 }),
      )
      .map(([b, c, d]) => `10.${b}.${c}.${d}`),
    fc
      .tuple(
        fc.integer({ min: 16, max: 31 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 254 }),
      )
      .map(([b, c, d]) => `172.${b}.${c}.${d}`),
    fc
      .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 }))
      .map(([c, d]) => `192.168.${c}.${d}`),
    fc.constant('fc00::1'),
    fc.constant('fd12:3456::abcd'),
  )
  .map((ip) => ({ ip, ipClass: 'private' as const, blocked: true }));

/** Any classified IP across every class (public + all blocked ranges). */
const classifiedIpArb: fc.Arbitrary<ClassifiedIp> = fc.oneof(
  { weight: 3, arbitrary: publicIpv4Arb },
  { weight: 1, arbitrary: publicAnchorArb },
  { weight: 2, arbitrary: linkLocalArb },
  { weight: 2, arbitrary: loopbackArb },
  { weight: 2, arbitrary: privateArb },
);

/** Schemes: the two allowed ones mixed with a spread of rejected ones. */
const schemeArb: fc.Arbitrary<string> = fc.constantFrom(
  'http',
  'https',
  'HTTPS',
  'https:',
  'ftp',
  'file',
  'ws',
  'gopher',
  'data',
  '',
);

// ---------------------------------------------------------------------------
// Feature: mss-livepulse, Property 16: SSRF allowlist enforcement. For random
// URL schemes and multi-record resolved-IP sets spanning public, link-local
// (169.254/16), loopback (127/8, ::1) and private (10/8, 172.16/12, 192.168/16,
// fc00::/7) ranges — with and without allowlist entries — the "send" decision
// is `true` IFF the scheme is http/https AND every resolved IP is public OR
// allowlisted. Any blocked-and-not-allowlisted IP fails the whole destination
// closed (multi-record DNS-rebinding defence), and no request is dispatched
// (the decision is pure). Validates Req 13.6, 13.7, 13.8, 13.9.
// ---------------------------------------------------------------------------

describe('Feature: mss-livepulse, Property 16: SSRF allowlist enforcement', () => {
  it('allows iff scheme is http/https AND every resolved IP is public or allowlisted', () => {
    fc.assert(
      fc.property(
        schemeArb,
        // At least one resolved IP; a mix of classes forces multi-record cases.
        fc.array(classifiedIpArb, { minLength: 1, maxLength: 5 }),
        // An originating host that may itself be allowlisted.
        fc.constantFrom('api.example.com', 'internal.local', 'llm.on-prem'),
        // Which of the resolved IPs (by index) to place into the allowlist.
        fc.array(fc.nat({ max: 4 }), { maxLength: 5 }),
        // Whether to additionally allowlist the host.
        fc.boolean(),
        // Noise entries that must never accidentally match a resolved IP/host.
        fc.array(fc.constantFrom('9.9.9.9', 'other.example', ''), {
          maxLength: 3,
        }),
        (scheme, ips, host, allowIdxs, allowHost, noise) => {
          // Self-check: the generators' `blocked` label must agree with the
          // module's own classifier — otherwise the "expected" value is wrong.
          for (const { ip, blocked } of ips) {
            expect(isBlockedRange(ip)).toBe(blocked);
          }

          // Build the allowlist from selected resolved IPs (+ optional host,
          // + noise). Indexes beyond the array length simply contribute nothing.
          const allowlistedIps = allowIdxs
            .filter((i) => i < ips.length)
            .map((i) => ips[i].ip);
          const allowlist = [
            ...allowlistedIps,
            ...(allowHost ? [host] : []),
            ...noise,
          ];
          const allowSet = new Set(allowlistedIps);

          // Independently computed EXPECTED decision from the generated inputs:
          // send iff scheme ok AND every IP is (public) OR (IP allowlisted) OR
          // (host allowlisted).
          const schemeOk = isAllowedScheme(scheme);
          const everyIpOk = ips.every(
            ({ ip, blocked }) => !blocked || allowSet.has(ip) || allowHost,
          );
          const expectedAllowed = schemeOk && everyIpOk;

          const decision = evaluateSsrfDestination({
            scheme,
            resolvedIps: ips.map((c) => c.ip),
            allowlist,
            host,
          });

          expect(decision.allowed).toBe(expectedAllowed);

          if (!decision.allowed) {
            // A denial must carry one of the expected CATEGORY reasons and,
            // being pure, dispatches nothing.
            expect([
              'invalid_scheme',
              'no_resolved_ips',
              'blocked_range',
            ]).toContain(decision.reason);
            if (!schemeOk) {
              expect(decision.reason).toBe('invalid_scheme');
            } else {
              // Scheme is fine and there is >=1 IP, so the only remaining denial
              // cause is a blocked-and-not-allowlisted resolved IP.
              expect(decision.reason).toBe('blocked_range');
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('fails closed when ANY resolved IP is blocked-and-not-allowlisted (multi-record rebinding)', () => {
    fc.assert(
      fc.property(
        fc.array(publicIpv4Arb, { minLength: 1, maxLength: 4 }),
        fc.oneof(linkLocalArb, loopbackArb, privateArb),
        fc.nat({ max: 6 }),
        (publics, blocked, insertAt) => {
          // A set of public IPs with a single blocked IP spliced in at an
          // arbitrary position; the blocked IP is NOT allowlisted.
          const ips = publics.map((c) => c.ip);
          const pos = insertAt % (ips.length + 1);
          ips.splice(pos, 0, blocked.ip);

          const decision = evaluateSsrfDestination({
            scheme: 'https',
            resolvedIps: ips,
            allowlist: [], // blocked IP deliberately absent
          });

          expect(decision).toEqual({ allowed: false, reason: 'blocked_range' });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('example: a blocked IP is permitted only once its exact address is allowlisted', () => {
    const base = {
      scheme: 'https',
      resolvedIps: [METADATA_IPV4],
      host: 'metadata.internal',
    } as const;

    // Denied with no allowlist.
    expect(evaluateSsrfDestination({ ...base, allowlist: [] })).toEqual({
      allowed: false,
      reason: 'blocked_range',
    });
    // Denied when only an unrelated entry is present.
    expect(
      evaluateSsrfDestination({ ...base, allowlist: ['8.8.8.8'] }),
    ).toEqual({ allowed: false, reason: 'blocked_range' });
    // Allowed once the exact resolved IP is allowlisted.
    expect(
      evaluateSsrfDestination({ ...base, allowlist: [METADATA_IPV4] }),
    ).toEqual({ allowed: true });
    // Allowed when the originating host is allowlisted instead.
    expect(
      evaluateSsrfDestination({ ...base, allowlist: ['metadata.internal'] }),
    ).toEqual({ allowed: true });
  });
});
