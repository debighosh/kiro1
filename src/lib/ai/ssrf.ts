/**
 * SSRF protection RULES — the SHARED, framework-agnostic, PURE decision core.
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI
 * =============================================================================
 * This module is the canonical, Node-testable definition of the Server-Side AI
 * Gateway's SSRF (Server-Side Request Forgery) allow/deny decision from
 * Requirement 13. It answers ONE question, deterministically and WITHOUT any
 * network I/O:
 *
 *   "Given a URL scheme, the set of IP addresses the destination hostname
 *    RESOLVED to, and the deployment AI_ENDPOINT_ALLOWLIST — may the Gateway
 *    dial this destination, or must it fail closed?"
 *
 * The rules it enforces:
 *
 *   - Accept ONLY the `https` / `http` URL schemes; reject everything else
 *     (`file:`, `ftp:`, `gopher:`, `data:`, …) → `invalid_scheme` (Req 13.4,
 *     13.6).
 *   - BLOCK by default, on the RESOLVED IP, the address ranges an SSRF attacker
 *     abuses to reach internal infrastructure (Req 13.7):
 *       * link-local / cloud metadata — `169.254.0.0/16` (incl. the AWS/GCP
 *         metadata address `169.254.169.254` explicitly) and IPv6 `fe80::/10`;
 *       * loopback — `127.0.0.0/8` and `::1`;
 *       * private — `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and IPv6
 *         unique-local `fc00::/7`.
 *   - PERMIT a blocked-range destination ONLY when the RESOLVED IP (or its
 *     originating host) appears in the deployment-level `AI_ENDPOINT_ALLOWLIST`
 *     — this is the explicit on-prem / private escape hatch (Req 13.8).
 *   - A destination that is neither public nor allowlisted is rejected
 *     `blocked_range` WITHOUT sending the request (Req 13.9).
 *   - FAIL CLOSED across ALL resolved addresses: if ANY resolved IP is
 *     blocked-and-not-allowlisted the whole destination is denied. This defends
 *     against multi-record DNS rebinding, where a hostname resolves to a public
 *     address AND an internal one so an attacker races the check against the
 *     dial (Req 13.7, 13.12).
 *
 * The reason codes this module returns are CATEGORIES only — they carry no
 * hostname, no resolved address, no provider header, credential, or raw
 * diagnostic, so a caller may surface/log them without leaking anything to the
 * browser (Req 13.1, 13.10).
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node property tests (Property 16,
 * task 29.7). This pure module is therefore the AUTHORITATIVE, Node-testable
 * copy of the SSRF DECISION logic. It has NO React, NO zod, NO Deno globals, NO
 * Node built-ins, and — crucially — performs NO DNS resolution itself. It takes
 * an ALREADY-RESOLVED list of IP strings (plus the scheme and allowlist) as
 * INPUTS and returns a pure allow/deny decision. This keeps the range/scheme/
 * allowlist logic runtime-agnostic and trivially property-testable.
 *
 * The Deno-side glue that performs the actual `Deno.resolveDns` lookup and the
 * TLS-preserving connection pinning (validate the resolved IP, then connect to
 * that IP while PRESERVING the SNI hostname so HTTPS certificate-hostname
 * verification still succeeds, respecting `tls_verify_required`) lives in
 * `supabase/functions/ai-gateway/ssrf.ts`, a thin wrapper that RE-DECLARES an
 * identical copy of these ranges/scheme/allowlist rules (mirroring the existing
 * `src/lib/ai/credentialRules.ts` ⇄ `supabase/functions/_shared/aiCredential.ts`
 * pattern). If a rule changes here, mirror it there too.
 *
 * Requirements traceability: 13.1, 13.4, 13.6, 13.7, 13.8, 13.9, 13.10, 13.12.
 * Design references: Server-Side AI Gateway Design (SSRF protection;
 * TLS-preserving SSRF resolution).
 */

// -----------------------------------------------------------------------------
// Allowed URL schemes (Req 13.4, 13.6).
// -----------------------------------------------------------------------------

/** The ONLY URL schemes the Gateway may dial (compared case-insensitively). */
export const ALLOWED_SCHEMES = ['https', 'http'] as const;
export type AllowedScheme = (typeof ALLOWED_SCHEMES)[number];

/**
 * True when `scheme` is one of {@link ALLOWED_SCHEMES}. The comparison is
 * case-insensitive and tolerates a trailing colon (e.g. `'HTTPS:'`) so a raw
 * `URL.protocol` value can be passed directly. Anything else (`file`, `ftp`,
 * `gopher`, `data`, empty, non-string) → `false` (Req 13.4, 13.6).
 */
export function isAllowedScheme(scheme: unknown): scheme is AllowedScheme {
  if (typeof scheme !== 'string') {
    return false;
  }
  const normalised = scheme.trim().toLowerCase().replace(/:$/, '');
  return (ALLOWED_SCHEMES as readonly string[]).includes(normalised);
}

// -----------------------------------------------------------------------------
// IP address parsing — dotted-quad IPv4 and basic (incl. compressed) IPv6.
//
// These parsers are DELIBERATELY strict: an address we cannot confidently parse
// is treated by the classifiers below as "not safe" so the decision fails
// closed rather than accidentally green-lighting a malformed/ambiguous address.
// -----------------------------------------------------------------------------

/** A parsed IPv4 address as its four octets, or `null` if not a valid dotted quad. */
export function parseIpv4(ip: string): [number, number, number, number] | null {
  if (typeof ip !== 'string') {
    return null;
  }
  const parts = ip.trim().split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    // Reject empty, non-numeric, or out-of-range octets.
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    // Reject leading-zero padding (e.g. `01`, `010`) — such ambiguous octets
    // must never be silently accepted (fail closed).
    if (part.length > 1 && part[0] === '0') {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * Expands a (possibly `::`-compressed) IPv6 address to its eight 16-bit groups,
 * or `null` if it is not a well-formed IPv6 address. Supports the common forms:
 *   - full `a:b:c:d:e:f:g:h`,
 *   - compressed `::`, `::1`, `fc00::`, `2001:db8::1`,
 *   - an IPv4-mapped tail `::ffff:169.254.169.254` (the trailing dotted-quad is
 *     expanded into the final two 16-bit groups so it is classified correctly).
 */
export function parseIpv6(ip: string): number[] | null {
  if (typeof ip !== 'string') {
    return null;
  }
  let text = ip.trim();
  // A zone index (e.g. `fe80::1%eth0`) is not relevant to range classification.
  const zoneIdx = text.indexOf('%');
  if (zoneIdx !== -1) {
    text = text.slice(0, zoneIdx);
  }
  if (text.length === 0 || text.indexOf(':') === -1) {
    return null;
  }

  // Split an embedded IPv4 tail (e.g. `::ffff:1.2.3.4`) into two 16-bit groups.
  let ipv4Tail: number[] | null = null;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.indexOf('.') !== -1) {
    const quad = parseIpv4(tail);
    if (quad === null) {
      return null;
    }
    ipv4Tail = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    // Drop the IPv4 tail AND its preceding colon, leaving the hex-group prefix
    // (which may still end in `::`, e.g. `::ffff` from `::ffff:1.2.3.4`).
    text = text.slice(0, lastColon);
  }

  const doubleColon = text.indexOf('::');
  let head: string[];
  let tailGroups: string[];
  if (doubleColon === -1) {
    // No compression — must be exactly the right number of groups.
    head = text.length > 0 ? text.split(':') : [];
    tailGroups = [];
    if (head.some((g) => g.length === 0)) {
      return null; // stray empty group without `::`
    }
  } else {
    // At most ONE `::` is permitted.
    if (text.indexOf('::', doubleColon + 1) !== -1) {
      return null;
    }
    const [before, after] = text.split('::');
    head = before.length > 0 ? before.split(':') : [];
    tailGroups = after.length > 0 ? after.split(':') : [];
  }

  const parseGroups = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
        return null;
      }
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const headVals = parseGroups(head);
  const tailVals = parseGroups(tailGroups);
  if (headVals === null || tailVals === null) {
    return null;
  }

  const explicit = [...headVals, ...tailVals, ...(ipv4Tail ?? [])];
  const ipv4Count = ipv4Tail ? 2 : 0;

  if (doubleColon === -1) {
    // Full form: exactly 8 groups (an IPv4 tail counts as its 2 groups).
    return explicit.length === 8 ? explicit : null;
  }

  // Compressed: fill the gap with zero groups up to a total of 8.
  const fixed = headVals.length + tailVals.length + ipv4Count;
  if (fixed > 7) {
    // `::` must stand in for AT LEAST one zero group.
    return null;
  }
  const zeros = new Array<number>(8 - fixed).fill(0);
  return [...headVals, ...zeros, ...tailVals, ...(ipv4Tail ?? [])];
}

// -----------------------------------------------------------------------------
// Range classifiers (Req 13.7). Each returns `true` when the RESOLVED IP falls
// in the corresponding blocked range. An address that parses as NEITHER IPv4
// NOR IPv6 is treated as "unclassifiable" — the top-level decision fails closed
// on such input rather than trusting it.
// -----------------------------------------------------------------------------

/** The cloud metadata address, called out explicitly by Req 13.7. */
export const METADATA_IPV4 = '169.254.169.254' as const;

/**
 * True when `ip` is a link-local or cloud-metadata address:
 *   - IPv4 `169.254.0.0/16` (which INCLUDES `169.254.169.254`), or
 *   - IPv6 link-local `fe80::/10`.
 */
export function isLinkLocalOrMetadata(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) {
    return v4[0] === 169 && v4[1] === 254;
  }
  const v6 = parseIpv6(ip);
  if (v6) {
    // fe80::/10 → first 10 bits are 1111 1110 10.
    return (v6[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * True when `ip` is a loopback address:
 *   - IPv4 `127.0.0.0/8`, or
 *   - IPv6 `::1`.
 */
export function isLoopback(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) {
    return v4[0] === 127;
  }
  const v6 = parseIpv6(ip);
  if (v6) {
    return v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1;
  }
  return false;
}

/**
 * True when `ip` is a private / internal address:
 *   - IPv4 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, or
 *   - IPv6 unique-local `fc00::/7`.
 */
export function isPrivate(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) {
    if (v4[0] === 10) {
      return true;
    }
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) {
      return true;
    }
    if (v4[0] === 192 && v4[1] === 168) {
      return true;
    }
    return false;
  }
  const v6 = parseIpv6(ip);
  if (v6) {
    // fc00::/7 → first 7 bits are 1111 110.
    return (v6[0] & 0xfe00) === 0xfc00;
  }
  return false;
}

/**
 * True when `ip` parses as a well-formed IPv4 or IPv6 literal. Used by the
 * decision to fail closed on any address it cannot classify (Req 13.7, 13.12).
 */
export function isParsableIp(ip: string): boolean {
  return parseIpv4(ip) !== null || parseIpv6(ip) !== null;
}

/**
 * True when `ip` is in ANY of the default-blocked ranges (link-local/metadata,
 * loopback, or private). An address that cannot be parsed at all is ALSO treated
 * as blocked — we never dial an address we cannot confidently classify.
 */
export function isBlockedRange(ip: string): boolean {
  if (!isParsableIp(ip)) {
    return true;
  }
  return isLinkLocalOrMetadata(ip) || isLoopback(ip) || isPrivate(ip);
}

// -----------------------------------------------------------------------------
// Allowlist normalisation (Req 13.8).
//
// `AI_ENDPOINT_ALLOWLIST` is a deployment secret carrying the private/on-prem
// destinations that are explicitly permitted despite falling in a blocked
// range. Entries may be IP literals OR hostnames; comparison is done on both
// the resolved IP and the originating host so a deployment can allowlist either.
// Matching is exact (after trimming + lower-casing); no CIDR wildcards in V1.
// -----------------------------------------------------------------------------

/** Normalises an allowlist entry / candidate for exact comparison. */
function normaliseAllowlistEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

/**
 * True when `candidate` (a resolved IP or the originating host) appears in
 * `allowlist`. Empty / whitespace-only allowlist entries are ignored, and a
 * non-array allowlist is treated as empty (fail closed).
 */
export function isAllowlisted(
  candidate: string,
  allowlist: readonly string[],
): boolean {
  if (typeof candidate !== 'string' || !Array.isArray(allowlist)) {
    return false;
  }
  const target = normaliseAllowlistEntry(candidate);
  if (target.length === 0) {
    return false;
  }
  for (const entry of allowlist) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalised = normaliseAllowlistEntry(entry);
    if (normalised.length > 0 && normalised === target) {
      return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Top-level SSRF decision (Req 13.6, 13.7, 13.8, 13.9, 13.12).
// -----------------------------------------------------------------------------

/**
 * The category of an SSRF denial. These are CATEGORIES ONLY — they never carry
 * a hostname, resolved address, provider header, credential, or raw diagnostic,
 * so they are safe to surface/log without leaking anything (Req 13.1, 13.10):
 *
 *   - `invalid_scheme`  — the URL scheme is not `https`/`http` (Req 13.4, 13.6);
 *   - `no_resolved_ips` — the destination resolved to zero usable addresses;
 *   - `blocked_range`   — at least one resolved IP is in a default-blocked range
 *                         and is NOT allowlisted → disallowed destination
 *                         (Req 13.7, 13.9, 13.12).
 */
export type SsrfDenyReason =
  'invalid_scheme' | 'no_resolved_ips' | 'blocked_range';

/** The result of the pure SSRF decision — allow, or deny with a reason. */
export type SsrfDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: SsrfDenyReason };

/**
 * The inputs to the SSRF decision. Everything here is ALREADY resolved by the
 * Deno wrapper (this module performs NO DNS and NO network I/O):
 *
 *   - `scheme`      — the URL scheme (with or without trailing colon);
 *   - `resolvedIps` — EVERY address the destination hostname resolved to. The
 *                     decision fails closed if ANY of them is blocked (Req 13.12
 *                     — multi-record DNS-rebinding defence);
 *   - `allowlist`   — the deployment `AI_ENDPOINT_ALLOWLIST` entries;
 *   - `host`        — optional originating hostname, so a deployment may
 *                     allowlist by host as well as by resolved IP (Req 13.8).
 */
export interface SsrfDecisionInput {
  readonly scheme: string;
  readonly resolvedIps: readonly string[];
  readonly allowlist?: readonly string[];
  readonly host?: string | null;
}

/**
 * The PURE SSRF allow/deny decision (Req 13.6–13.9, 13.12). It performs NO
 * network I/O — a denial is returned WITHOUT sending any request (Req 13.9).
 *
 * Order of checks (all fail closed):
 *   1. scheme must be `https`/`http`                       → `invalid_scheme`;
 *   2. there must be at least one resolved IP              → `no_resolved_ips`;
 *   3. EVERY resolved IP must be either a public address OR present in the
 *      allowlist (the resolved IP, or the originating host, may match). If ANY
 *      resolved IP is blocked-and-not-allowlisted the whole destination is
 *      denied `blocked_range` (Req 13.7, 13.9, 13.12).
 */
export function evaluateSsrfDestination(
  input: SsrfDecisionInput,
): SsrfDecision {
  if (!isAllowedScheme(input.scheme)) {
    return { allowed: false, reason: 'invalid_scheme' };
  }

  const ips = Array.isArray(input.resolvedIps) ? input.resolvedIps : [];
  if (ips.length === 0) {
    return { allowed: false, reason: 'no_resolved_ips' };
  }

  const allowlist = Array.isArray(input.allowlist) ? input.allowlist : [];
  const hostAllowlisted =
    typeof input.host === 'string' && isAllowlisted(input.host, allowlist);

  for (const ip of ips) {
    if (!isBlockedRange(ip)) {
      // Public, parsable address — always permitted regardless of allowlist.
      continue;
    }
    // A blocked-range (or unparsable) address is permitted ONLY if the resolved
    // IP itself, or its originating host, is explicitly allowlisted (Req 13.8).
    if (isAllowlisted(ip, allowlist) || hostAllowlisted) {
      continue;
    }
    // Fail closed on the FIRST blocked-and-not-allowlisted address — defends
    // against multi-record DNS rebinding (Req 13.9, 13.12).
    return { allowed: false, reason: 'blocked_range' };
  }

  return { allowed: true };
}
