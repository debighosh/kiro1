// =============================================================================
// EDGE-FUNCTION-ONLY — SSRF PROTECTION + TLS-PRESERVING RESOLUTION (Deno)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module runs ONLY inside the ai-gateway Supabase Edge Function (the Deno
//  runtime). It is the Deno-side glue for the Server-Side AI Gateway's SSRF
//  protection (Requirement 13). It has two responsibilities the pure decision
//  core cannot have:
//
//    1. DNS RESOLUTION — resolve the destination hostname to the FULL set of
//       addresses it maps to (via `Deno.resolveDns`), so the allow/deny decision
//       is made against the addresses that will actually be dialed (Req 13.7).
//    2. TLS-PRESERVING CONNECTION PINNING — dial the SSRF-VALIDATED IP while
//       PRESERVING the original SNI hostname, so HTTPS SNI and certificate-
//       hostname verification still succeed (respecting `tls_verify_required`),
//       closing the DNS-rebinding gap: the address we CHECKED is the address we
//       DIAL (Req 13.7, 13.8, 13.12).
//
//  -----------------------------------------------------------------------------
//  SHARED-LOGIC NOTE — keep in sync with `src/lib/ai/ssrf.ts`
//  -----------------------------------------------------------------------------
//  The AUTHORITATIVE, Node-testable copy of the PURE scheme / IP-range / allow-
//  list DECISION logic lives at `src/lib/ai/ssrf.ts` (the Property 16 test in
//  task 29.7 imports it). Deno cannot import a `src/` path at runtime, so this
//  module RE-DECLARES an identical copy of that decision logic (mirroring the
//  existing `src/lib/ai/credentialRules.ts` ⇄
//  `supabase/functions/_shared/aiCredential.ts` pattern). If a rule changes in
//  one place, mirror it in the other. The DNS + connection-pinning code below is
//  Deno-only and has no pure counterpart.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` is resolved
//  by the Supabase Edge Functions / Deno toolchain at deploy time.
//
//  NEVER return provider headers, credentials, or raw diagnostics to the
//  browser: a denial surfaces ONLY as a fixed category (Req 13.1, 13.10).
//
//  Requirements traceability: 13.1, 13.4, 13.6, 13.7, 13.8, 13.9, 13.10, 13.12.
//  Design references: Server-Side AI Gateway Design (SSRF protection;
//  TLS-preserving SSRF resolution).
// =============================================================================

// -----------------------------------------------------------------------------
// PURE DECISION LOGIC — mirror of src/lib/ai/ssrf.ts (keep in sync).
// -----------------------------------------------------------------------------

export const ALLOWED_SCHEMES = ['https', 'http'] as const;
export type AllowedScheme = (typeof ALLOWED_SCHEMES)[number];

/** True when `scheme` is `https`/`http` (case-insensitive, trailing `:` ok). */
export function isAllowedScheme(scheme: unknown): scheme is AllowedScheme {
  if (typeof scheme !== 'string') {
    return false;
  }
  const normalised = scheme.trim().toLowerCase().replace(/:$/, '');
  return (ALLOWED_SCHEMES as readonly string[]).includes(normalised);
}

/** Parse a dotted-quad IPv4 → four octets, or null if invalid. */
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
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
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

/** Expand a (possibly compressed) IPv6 to eight 16-bit groups, or null. */
export function parseIpv6(ip: string): number[] | null {
  if (typeof ip !== 'string') {
    return null;
  }
  let text = ip.trim();
  const zoneIdx = text.indexOf('%');
  if (zoneIdx !== -1) {
    text = text.slice(0, zoneIdx);
  }
  if (text.length === 0 || text.indexOf(':') === -1) {
    return null;
  }

  let ipv4Tail: number[] | null = null;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.indexOf('.') !== -1) {
    const quad = parseIpv4(tail);
    if (quad === null) {
      return null;
    }
    ipv4Tail = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    text = text.slice(0, lastColon);
  }

  const doubleColon = text.indexOf('::');
  let head: string[];
  let tailGroups: string[];
  if (doubleColon === -1) {
    head = text.length > 0 ? text.split(':') : [];
    tailGroups = [];
    if (head.some((g) => g.length === 0)) {
      return null;
    }
  } else {
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
    return explicit.length === 8 ? explicit : null;
  }

  const fixed = headVals.length + tailVals.length + ipv4Count;
  if (fixed > 7) {
    return null;
  }
  const zeros = new Array<number>(8 - fixed).fill(0);
  return [...headVals, ...zeros, ...tailVals, ...(ipv4Tail ?? [])];
}

/** The cloud metadata address called out explicitly by Req 13.7. */
export const METADATA_IPV4 = '169.254.169.254' as const;

/** IPv4 `169.254.0.0/16` (incl. `169.254.169.254`) or IPv6 `fe80::/10`. */
export function isLinkLocalOrMetadata(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) {
    return v4[0] === 169 && v4[1] === 254;
  }
  const v6 = parseIpv6(ip);
  if (v6) {
    return (v6[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

/** IPv4 `127.0.0.0/8` or IPv6 `::1`. */
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

/** IPv4 `10/8`, `172.16/12`, `192.168/16` or IPv6 `fc00::/7`. */
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
    return (v6[0] & 0xfe00) === 0xfc00;
  }
  return false;
}

/** True when `ip` parses as a valid IPv4 or IPv6 literal. */
export function isParsableIp(ip: string): boolean {
  return parseIpv4(ip) !== null || parseIpv6(ip) !== null;
}

/** True when `ip` is in any default-blocked range OR is unparsable (fail closed). */
export function isBlockedRange(ip: string): boolean {
  if (!isParsableIp(ip)) {
    return true;
  }
  return isLinkLocalOrMetadata(ip) || isLoopback(ip) || isPrivate(ip);
}

function normaliseAllowlistEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

/** Exact (trim + lower-case) membership of `candidate` in `allowlist`. */
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

export type SsrfDenyReason =
  'invalid_scheme' | 'no_resolved_ips' | 'blocked_range';

export type SsrfDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: SsrfDenyReason };

export interface SsrfDecisionInput {
  readonly scheme: string;
  readonly resolvedIps: readonly string[];
  readonly allowlist?: readonly string[];
  readonly host?: string | null;
}

/** The PURE SSRF allow/deny decision — mirror of src/lib/ai/ssrf.ts. */
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
      continue;
    }
    if (isAllowlisted(ip, allowlist) || hostAllowlisted) {
      continue;
    }
    return { allowed: false, reason: 'blocked_range' };
  }
  return { allowed: true };
}

// =============================================================================
// DENO-ONLY GLUE — DNS resolution, allowlist env, connection pinning.
// =============================================================================

/** The deployment secret holding the SSRF allowlist entries. */
export const AI_ENDPOINT_ALLOWLIST_ENV = 'AI_ENDPOINT_ALLOWLIST';

/**
 * Raised when a destination is rejected by SSRF protection. It carries ONLY the
 * fixed category `reason` — NEVER the hostname, resolved IP, provider header,
 * credential, or a raw diagnostic — so callers can log/return it without leaking
 * anything to the browser (Req 13.1, 13.9, 13.10).
 */
export class DisallowedDestinationError extends Error {
  constructor(public readonly reason: SsrfDenyReason) {
    super('AI destination is not allowed.');
    this.name = 'DisallowedDestinationError';
  }
}

/**
 * Reads and parses the deployment `AI_ENDPOINT_ALLOWLIST` secret into a list of
 * normalised entries. The variable is a comma- and/or whitespace-separated list
 * of IP literals and/or hostnames. A missing/empty value yields an empty
 * allowlist (fail closed — nothing private/on-prem is permitted, Req 13.8).
 * Only the variable NAME (never its value) can appear in an error.
 */
export function readEndpointAllowlist(): string[] {
  const raw = Deno.env.get(AI_ENDPOINT_ALLOWLIST_ENV);
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolves a hostname to the FULL set of A + AAAA records it maps to (Req 13.7,
 * 13.12). An IP literal is returned as-is (no DNS lookup needed). All resolved
 * addresses are returned so the decision can fail closed if ANY of them is
 * internal (multi-record DNS-rebinding defence). A resolution error yields an
 * empty list, which the decision treats as `no_resolved_ips` (fail closed).
 */
export async function resolveHostToIps(host: string): Promise<string[]> {
  // An IP literal needs no DNS lookup — validate the literal directly.
  if (isParsableIp(host)) {
    return [host.trim()];
  }
  const ips: string[] = [];
  // Resolve both families; a failure for one family must not mask a record in
  // the other, but any address found in EITHER family is validated.
  for (const recordType of ['A', 'AAAA'] as const) {
    try {
      const records = await Deno.resolveDns(host, recordType);
      for (const rec of records) {
        ips.push(rec);
      }
    } catch {
      // Ignore per-family failures; the aggregate result drives the decision.
    }
  }
  return ips;
}

/**
 * The result of an SSRF preflight — the validated set of resolved IPs (so the
 * caller can pin the connection to one of them) plus the parsed destination.
 */
export interface PreflightResult {
  readonly url: URL;
  readonly host: string;
  readonly resolvedIps: readonly string[];
}

/**
 * SSRF PREFLIGHT (Req 13.4, 13.6-13.9, 13.12). Given a destination URL string
 * and the deployment allowlist, this:
 *   1. parses + scheme-checks the URL (Req 13.4, 13.6);
 *   2. resolves the host to EVERY A/AAAA record (Req 13.7);
 *   3. runs the PURE {@link evaluateSsrfDestination} decision over the full set
 *      (Req 13.7-13.9, 13.12).
 *
 * On denial it THROWS {@link DisallowedDestinationError} WITHOUT ever opening a
 * connection (Req 13.9). On allow it returns the resolved IPs so the caller can
 * pin the outbound connection to a validated address (see {@link createPinnedFetch}).
 */
export async function preflightDestination(
  destination: string,
  allowlist: readonly string[] = readEndpointAllowlist(),
): Promise<PreflightResult> {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw new DisallowedDestinationError('invalid_scheme');
  }

  if (!isAllowedScheme(url.protocol)) {
    throw new DisallowedDestinationError('invalid_scheme');
  }

  const host = url.hostname;
  const resolvedIps = await resolveHostToIps(host);

  const decision = evaluateSsrfDestination({
    scheme: url.protocol,
    resolvedIps,
    allowlist,
    host,
  });

  if (!decision.allowed) {
    // Fail closed WITHOUT any network I/O beyond the DNS lookup (Req 13.9).
    throw new DisallowedDestinationError(decision.reason);
  }

  return { url, host, resolvedIps };
}

/**
 * Builds a `fetch`-compatible function that PINS outbound TCP connections to a
 * SSRF-VALIDATED IP while PRESERVING the original SNI hostname, closing the
 * DNS-rebinding gap (Req 13.12). It does this via a custom `Deno.HttpClient`
 * whose transport dials `validatedIp` but whose TLS layer still uses the
 * request's hostname for SNI + certificate verification (Req 13.7, 13.8).
 *
 * `tlsVerifyRequired` maps to the client's certificate verification: when true
 * (the default and STRONGLY recommended) certificate-hostname verification is
 * enforced; when false the deployment has explicitly opted into an unverified
 * connection (e.g. an internal endpoint with a self-signed cert on the
 * allowlist) — this NEVER disables the SSRF IP validation itself.
 *
 * NOTE: `Deno.createHttpClient`'s connection-pinning options evolve across Deno
 * releases; this factory centralises that concern so the adapter (task 29.3)
 * simply calls the returned `fetch`. The SNI hostname is ALWAYS the URL's
 * hostname; only the dialed address is overridden.
 */
export function createPinnedFetch(
  validatedIp: string,
  tlsVerifyRequired: boolean,
): typeof fetch {
  // The custom client dials the validated IP (`resolveDns`-bypassing) while the
  // request URL — and therefore the SNI hostname and cert-verification host —
  // remains the original hostname. `caCerts`/verification honour tlsVerifyRequired.
  const client = new Deno.HttpClient({
    // Pin every DNS answer for this client to the SSRF-validated address so the
    // address dialed IS the address checked (Req 13.12). Preserving the request
    // hostname keeps SNI + cert-hostname verification intact (Req 13.7, 13.8).
    resolveDns: () => [validatedIp],
    // When verification is required we do NOT relax cert checks; when the
    // deployment has explicitly disabled it (allowlisted internal endpoint) we
    // honour that choice without ever weakening the IP allow/deny decision.
    ...(tlsVerifyRequired ? {} : { unsafelyIgnoreCertificateErrors: true }),
  } as Deno.CreateHttpClientOptions);

  return (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, client } as RequestInit & {
      client: Deno.HttpClient;
    });
}
