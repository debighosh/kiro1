/**
 * Task 29.2 — unit tests for the pure, Node-testable SSRF decision module
 * (src/lib/ai/ssrf.ts).
 *
 * These tests lock down the Server-Side AI Gateway's SSRF allow/deny contract
 * (Requirement 13), all WITHOUT any DNS or network I/O:
 *   - only `https`/`http` schemes are accepted; anything else → `invalid_scheme`
 *     (Req 13.4, 13.6);
 *   - the RESOLVED IP is classified into the default-blocked ranges —
 *     link-local/metadata (incl. `169.254.169.254`), loopback, private — for
 *     both IPv4 and IPv6 (Req 13.7);
 *   - a blocked-range destination is DENIED unless the resolved IP (or host) is
 *     in the deployment allowlist (Req 13.8, 13.9);
 *   - the decision FAILS CLOSED if ANY resolved IP is blocked-and-not-allowlisted
 *     — the multi-record DNS-rebinding defence (Req 13.12).
 *
 * The Property 16 test (SSRF allowlist) is written separately in task 29.7.
 *
 * Requirements: 13.4, 13.6, 13.7, 13.8, 13.9, 13.12.
 * Design: Server-Side AI Gateway Design → SSRF protection; TLS-preserving SSRF
 * resolution.
 */
import { describe, expect, it } from 'vitest';

import {
  METADATA_IPV4,
  evaluateSsrfDestination,
  isAllowedScheme,
  isAllowlisted,
  isBlockedRange,
  isLinkLocalOrMetadata,
  isLoopback,
  isParsableIp,
  isPrivate,
  parseIpv4,
  parseIpv6,
} from './ssrf';

describe('isAllowedScheme (Req 13.4, 13.6)', () => {
  it('accepts https and http case-insensitively, with or without a colon', () => {
    for (const s of ['https', 'http', 'HTTPS', 'Http', 'https:', 'HTTP:']) {
      expect(isAllowedScheme(s)).toBe(true);
    }
  });

  it('rejects every other scheme and non-strings', () => {
    for (const s of ['file', 'ftp', 'gopher', 'data', 'ws', 'wss', '', 'htt']) {
      expect(isAllowedScheme(s)).toBe(false);
    }
    expect(isAllowedScheme(null)).toBe(false);
    expect(isAllowedScheme(undefined)).toBe(false);
    expect(isAllowedScheme(123)).toBe(false);
  });
});

describe('parseIpv4', () => {
  it('parses valid dotted quads', () => {
    expect(parseIpv4('1.2.3.4')).toEqual([1, 2, 3, 4]);
    expect(parseIpv4('255.255.255.255')).toEqual([255, 255, 255, 255]);
    expect(parseIpv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
  });

  it('rejects malformed / out-of-range / padded quads', () => {
    for (const bad of [
      '1.2.3',
      '1.2.3.4.5',
      '256.0.0.1',
      '1.2.3.999',
      'a.b.c.d',
      '1.2.3.',
      '01.2.3.4', // leading zero padding
      '',
    ]) {
      expect(parseIpv4(bad)).toBeNull();
    }
  });
});

describe('parseIpv6', () => {
  it('parses full, compressed, and IPv4-tailed forms', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('fc00::')?.[0]).toBe(0xfc00);
    expect(parseIpv6('fe80::1')?.[0]).toBe(0xfe80);
    expect(parseIpv6('2001:db8::1')).toEqual([
      0x2001, 0x0db8, 0, 0, 0, 0, 0, 1,
    ]);
    // IPv4-mapped tail expands into the last two 16-bit groups.
    expect(parseIpv6('::ffff:169.254.169.254')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe,
    ]);
  });

  it('rejects malformed IPv6', () => {
    for (const bad of [
      '1.2.3.4',
      'gggg::1',
      '::1::2',
      '12345::',
      'not-an-ip',
      '',
    ]) {
      expect(parseIpv6(bad)).toBeNull();
    }
  });
});

describe('range classifiers (Req 13.7)', () => {
  it('isLinkLocalOrMetadata covers 169.254.0.0/16 incl. the metadata IP', () => {
    expect(isLinkLocalOrMetadata(METADATA_IPV4)).toBe(true);
    expect(isLinkLocalOrMetadata('169.254.0.1')).toBe(true);
    expect(isLinkLocalOrMetadata('169.254.255.255')).toBe(true);
    expect(isLinkLocalOrMetadata('fe80::1')).toBe(true);
    expect(isLinkLocalOrMetadata('8.8.8.8')).toBe(false);
    expect(isLinkLocalOrMetadata('169.253.0.1')).toBe(false);
  });

  it('isLoopback covers 127.0.0.0/8 and ::1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.255.255.255')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('8.8.8.8')).toBe(false);
    expect(isLoopback('::2')).toBe(false);
  });

  it('isPrivate covers the IPv4 private ranges and fc00::/7', () => {
    expect(isPrivate('10.0.0.1')).toBe(true);
    expect(isPrivate('10.255.255.255')).toBe(true);
    expect(isPrivate('172.16.0.1')).toBe(true);
    expect(isPrivate('172.31.255.255')).toBe(true);
    expect(isPrivate('172.15.0.1')).toBe(false); // just below the /12
    expect(isPrivate('172.32.0.1')).toBe(false); // just above the /12
    expect(isPrivate('192.168.0.1')).toBe(true);
    expect(isPrivate('192.169.0.1')).toBe(false);
    expect(isPrivate('fc00::1')).toBe(true);
    expect(isPrivate('fd12:3456::1')).toBe(true); // fd00::/8 ⊂ fc00::/7
    expect(isPrivate('8.8.8.8')).toBe(false);
  });

  it('isBlockedRange treats unparsable addresses as blocked (fail closed)', () => {
    expect(isBlockedRange('not-an-ip')).toBe(true);
    expect(isBlockedRange('')).toBe(true);
    expect(isBlockedRange('8.8.8.8')).toBe(false);
    expect(isBlockedRange('1.1.1.1')).toBe(false);
    expect(isBlockedRange('169.254.169.254')).toBe(true);
  });

  it('isParsableIp recognises both families', () => {
    expect(isParsableIp('8.8.8.8')).toBe(true);
    expect(isParsableIp('::1')).toBe(true);
    expect(isParsableIp('nope')).toBe(false);
  });
});

describe('isAllowlisted (Req 13.8)', () => {
  it('matches exactly after trim + lower-case, ignoring empty entries', () => {
    const list = ['  10.0.0.5 ', 'AI.internal.example', '', '   '];
    expect(isAllowlisted('10.0.0.5', list)).toBe(true);
    expect(isAllowlisted('ai.internal.example', list)).toBe(true);
    expect(isAllowlisted('10.0.0.6', list)).toBe(false);
    expect(isAllowlisted('', list)).toBe(false);
  });

  it('fails closed on a non-array allowlist', () => {
    // @ts-expect-error deliberately passing a bad type
    expect(isAllowlisted('10.0.0.5', null)).toBe(false);
  });
});

describe('evaluateSsrfDestination (Req 13.6-13.9, 13.12)', () => {
  it('denies a non-http(s) scheme WITHOUT resolution', () => {
    const d = evaluateSsrfDestination({
      scheme: 'file',
      resolvedIps: ['8.8.8.8'],
    });
    expect(d).toEqual({ allowed: false, reason: 'invalid_scheme' });
  });

  it('denies when there are no resolved IPs', () => {
    const d = evaluateSsrfDestination({ scheme: 'https', resolvedIps: [] });
    expect(d).toEqual({ allowed: false, reason: 'no_resolved_ips' });
  });

  it('allows a public destination', () => {
    expect(
      evaluateSsrfDestination({ scheme: 'https', resolvedIps: ['8.8.8.8'] }),
    ).toEqual({ allowed: true });
  });

  it('denies a blocked-range destination that is not allowlisted', () => {
    for (const ip of ['169.254.169.254', '127.0.0.1', '10.0.0.5', 'fc00::1']) {
      expect(
        evaluateSsrfDestination({ scheme: 'https', resolvedIps: [ip] }),
      ).toEqual({ allowed: false, reason: 'blocked_range' });
    }
  });

  it('permits a blocked-range destination only when the resolved IP is allowlisted (Req 13.8)', () => {
    expect(
      evaluateSsrfDestination({
        scheme: 'https',
        resolvedIps: ['10.0.0.5'],
        allowlist: ['10.0.0.5'],
      }),
    ).toEqual({ allowed: true });
  });

  it('permits a blocked-range destination when the originating host is allowlisted (Req 13.8)', () => {
    expect(
      evaluateSsrfDestination({
        scheme: 'https',
        resolvedIps: ['10.0.0.5'],
        host: 'ai.internal.example',
        allowlist: ['ai.internal.example'],
      }),
    ).toEqual({ allowed: true });
  });

  it('fails closed if ANY resolved IP is blocked-and-not-allowlisted (multi-record rebinding, Req 13.12)', () => {
    // One public + one internal address; the internal one is NOT allowlisted.
    const d = evaluateSsrfDestination({
      scheme: 'https',
      resolvedIps: ['8.8.8.8', '169.254.169.254'],
    });
    expect(d).toEqual({ allowed: false, reason: 'blocked_range' });
  });

  it('allows a mixed set only when every blocked IP is allowlisted', () => {
    expect(
      evaluateSsrfDestination({
        scheme: 'https',
        resolvedIps: ['8.8.8.8', '10.1.2.3'],
        allowlist: ['10.1.2.3'],
      }),
    ).toEqual({ allowed: true });
  });

  it('denies an unparsable resolved address (fail closed)', () => {
    expect(
      evaluateSsrfDestination({
        scheme: 'https',
        resolvedIps: ['garbage'],
      }),
    ).toEqual({ allowed: false, reason: 'blocked_range' });
  });
});
