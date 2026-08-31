// =============================================================================
// AI GATEWAY — PRE-TRANSMISSION IDENTIFIER GUARD (Deno mirror, Req 20.2)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This is the Deno-side MIRROR of the authoritative, Node-testable identifier
//  guard in `src/lib/ai/payloadGuard.ts`. The SPA copy is exercised by the
//  Property 19 property test (task 35.2); this copy runs inside the edge
//  function as DEFENCE-IN-DEPTH before the outbound provider call.
//
//  The minimal-payload builder in `gateway.ts` already enforces "no identifiers
//  BY CONSTRUCTION" — it does not accept identifier fields at all (Req 20.1,
//  20.3). This guard is a second, independent line of defence (Req 20.2): it
//  SCANS the already-built payload for participant-identifier SHAPES (email,
//  phone, IP v4/v6, UUID user id) that might have been embedded inside a
//  question text or metadata value, and reports the FIRST category found so the
//  caller can BLOCK transmission and record the restricted-data error WITHOUT
//  dispatching a request.
//
//  If a rule changes here, mirror it in `src/lib/ai/payloadGuard.ts` too — the
//  two are a matched pair (same pattern as ssrf.ts ⇄ src/lib/ai/ssrf.ts).
//
//  Requirements traceability: 20.1, 20.2, 20.3.
// =============================================================================

/** The identifier categories that block transmission (Req 20.1). */
export type IdentifierKind = 'email' | 'phone' | 'ip' | 'user_id' | 'name';

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;
const PHONE_CANDIDATE_RE = /\+?[\d][\d\s().-]{5,}\d/;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/;
const IPV6_RE =
  /(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{0,4}|::(?:[0-9a-fA-F]{1,4}:?){1,}|(?:[0-9a-fA-F]{1,4}:){1,}:/;
const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;

function containsEmail(text: string): boolean {
  return typeof text === 'string' && EMAIL_RE.test(text);
}

function containsPhone(text: string): boolean {
  if (typeof text !== 'string') return false;
  const match = text.match(PHONE_CANDIDATE_RE);
  if (!match) return false;
  const digitCount = (match[0].match(/\d/g) ?? []).length;
  return digitCount >= 7 && digitCount <= 15;
}

function containsIp(text: string): boolean {
  if (typeof text !== 'string') return false;
  const v4 = text.match(IPV4_RE);
  if (v4) {
    const octetsOk = [v4[1], v4[2], v4[3], v4[4]].every((o) => {
      const n = Number(o);
      return n >= 0 && n <= 255;
    });
    if (octetsOk) return true;
  }
  return IPV6_RE.test(text);
}

function containsUserId(text: string): boolean {
  return typeof text === 'string' && UUID_RE.test(text);
}

const SHAPE_DETECTORS: ReadonlyArray<
  readonly [IdentifierKind, (text: string) => boolean]
> = [
  ['email', containsEmail],
  ['user_id', containsUserId],
  ['ip', containsIp],
  ['phone', containsPhone],
];

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectStrings(key, out);
      collectStrings((value as Record<string, unknown>)[key], out);
    }
  }
}

/** Outcome of scanning a candidate payload for participant identifiers (Req 20.2). */
export type IdentifierScanResult =
  | { readonly detected: false }
  | { readonly detected: true; readonly kind: IdentifierKind };

/**
 * Scans a candidate payload for any participant-identifier shape (Req 20.2).
 * Returns the FIRST category found, or `{ detected: false }`. The offending
 * value is never included (Req 20.7).
 */
export function scanForIdentifiers(
  payload: unknown,
  knownNames: readonly string[] = [],
): IdentifierScanResult {
  const strings: string[] = [];
  collectStrings(payload, strings);

  for (const text of strings) {
    for (const [kind, detect] of SHAPE_DETECTORS) {
      if (detect(text)) {
        return { detected: true, kind };
      }
    }
  }

  const haystack = strings.join('\n').toLowerCase();
  for (const raw of knownNames) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length > 0 && haystack.includes(name.toLowerCase())) {
      return { detected: true, kind: 'name' };
    }
  }

  return { detected: false };
}

/**
 * Raised when the pre-transmission guard detects a participant identifier in the
 * built payload. The Gateway maps this to the sanitised `restricted_data`
 * category and blocks the outbound call — no request is dispatched (Req 20.2).
 * The detected KIND is a category label only; no offending value is carried.
 */
export class RestrictedDataError extends Error {
  constructor(public readonly kind: IdentifierKind) {
    super('Request payload contains restricted participant data.');
    this.name = 'RestrictedDataError';
  }
}

/**
 * Asserts a candidate payload is free of participant identifiers, throwing
 * {@link RestrictedDataError} if any is detected so the caller blocks the
 * outbound call BEFORE opening a connection (Req 20.2).
 */
export function assertNoParticipantIdentifiers(
  payload: unknown,
  knownNames: readonly string[] = [],
): void {
  const scan = scanForIdentifiers(payload, knownNames);
  if (scan.detected) {
    throw new RestrictedDataError(scan.kind);
  }
}
