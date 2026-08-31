/**
 * AI payload minimisation + participant-identifier guard — the SHARED,
 * framework-agnostic, PURE decision core for Requirement 20 (AI data handling
 * and privacy).
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI
 * =============================================================================
 * This module is the canonical, Node-testable definition of two invariants the
 * Server-Side AI Gateway enforces before ANY outbound provider call:
 *
 *   1. MINIMAL PAYLOAD (Req 20.1, 20.3). The ONLY data ever transmitted to an
 *      AI provider is (a) the question texts, each truncated to at most
 *      {@link MAX_QUESTION_TEXT_CHARS} (10,000) characters, and (b) aggregate,
 *      non-identifying metadata (counts / labels) whose values are `number` or
 *      `string` only. NO participant-identifier FIELD is accepted by the
 *      builder, so an identifier field cannot leak through it by construction.
 *
 *   2. PRE-TRANSMISSION IDENTIFIER GUARD (Req 20.2). As defence-in-depth, a
 *      candidate payload is SCANNED for participant-identifier SHAPES —
 *      participant name, email address, phone number, user id (UUID), and IP
 *      address (v4 / v6) — that might have been embedded inside a question text
 *      or a metadata value. If any identifier is detected, the guard reports
 *      `detected = true` so the caller BLOCKS transmission and records the
 *      restricted-data error; NO request is dispatched.
 *
 * The pure {@link decideSend} folds the guard into a send/no-send decision that
 * dispatches NOTHING (it has no I/O): `{ send: true }` IFF the guard detects no
 * identifier, `{ send: false, reason: 'restricted_data' }` otherwise.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * The AUTHORITATIVE Gateway minimal-payload builder lives in the Deno edge
 * function (`supabase/functions/ai-gateway/gateway.ts` —
 * `buildMinimalPayload` / `truncateQuestionText` / `MinimalPayload`). That
 * builder already enforces "no identifiers BY CONSTRUCTION": it does not accept
 * identifier fields at all. `supabase/functions` is Deno code, excluded from the
 * SPA `tsc` build and from Vitest, so it cannot be exercised by the Node
 * property tests (Property 19, task 35.2).
 *
 * This module is therefore the AUTHORITATIVE, Node-testable COPY of the
 * minimisation semantics PLUS the pre-transmission identifier guard. It mirrors
 * the Deno gateway's `buildMinimalPayload` semantics exactly
 * (`MAX_QUESTION_TEXT_CHARS = 10_000`; aggregate metadata values are
 * `number | string` only) — the same "pure `src/lib/ai/` module ⇄ Deno mirror"
 * pattern as `ssrf.ts` ⇄ `supabase/functions/ai-gateway/ssrf.ts` and
 * `credentialRules.ts` ⇄ `supabase/functions/_shared/aiCredential.ts`. If a rule
 * changes here, mirror it in the Deno gateway too.
 *
 * The detector reason codes are CATEGORIES only — they never carry the offending
 * value, so a caller may surface/log them without leaking the identifier itself
 * (Req 20.7).
 *
 * Requirements traceability: 20.1, 20.2, 20.3.
 * Design references: Correctness Properties (Property 19); Server-Side AI
 * Gateway Design (AI data handling / privacy).
 */

// -----------------------------------------------------------------------------
// Payload bounds (Req 20.3) — MUST match the Deno gateway constant.
// -----------------------------------------------------------------------------

/** Question text is truncated to at most this many chars before transmission (Req 20.3). */
export const MAX_QUESTION_TEXT_CHARS = 10_000;

// -----------------------------------------------------------------------------
// Minimal payload shape (Req 20.1, 20.3) — mirrors the Deno `MinimalPayload`.
// -----------------------------------------------------------------------------

/**
 * The ONLY data ever sent to a provider: question texts (each truncated) plus
 * aggregate, non-identifying metadata. NO participant-identifier field exists on
 * this type — identifiers cannot appear by construction (Req 20.1).
 */
export interface MinimalPayload {
  /** Question texts, each truncated to ≤ {@link MAX_QUESTION_TEXT_CHARS} (Req 20.3). */
  readonly questionTexts: readonly string[];
  /** Aggregate, non-identifying metadata only — `number | string` values (Req 20.3). */
  readonly aggregateMetadata: Readonly<Record<string, number | string>>;
}

/**
 * The minimal set of request inputs the builder accepts. It DELIBERATELY has no
 * `name` / `email` / `phone` / `userId` / `ip` fields — the minimisation is
 * enforced by the SHAPE of this input, so an identifier field is un-passable
 * (Req 20.1). Mirrors the relevant subset of the Deno `GatewayRequest`.
 */
export interface PayloadBuildInput {
  readonly questionTexts: readonly string[];
  readonly aggregateMetadata: Readonly<Record<string, number | string>>;
}

/** Truncates a single text to at most {@link MAX_QUESTION_TEXT_CHARS} (Req 20.3). */
export function truncateQuestionText(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }
  return text.length > MAX_QUESTION_TEXT_CHARS
    ? text.slice(0, MAX_QUESTION_TEXT_CHARS)
    : text;
}

/**
 * Builds the minimal payload from a validated request: truncates every question
 * text and passes through ONLY the aggregate metadata. No identifiers are
 * accepted or emitted (Req 20.1, 20.3). Byte-for-byte mirrors the Deno gateway's
 * `buildMinimalPayload`.
 */
export function buildMinimalPayload(input: PayloadBuildInput): MinimalPayload {
  return {
    questionTexts: input.questionTexts.map(truncateQuestionText),
    aggregateMetadata: { ...input.aggregateMetadata },
  };
}

// -----------------------------------------------------------------------------
// Participant-identifier detectors (Req 20.1, 20.2).
//
// Each detector answers "does this string CONTAIN a value shaped like this kind
// of participant identifier?". They are deliberately conservative about their
// SHAPE (documented per-detector) so a candidate payload can be scanned for the
// PRESENCE of an identifier before transmission. The categories mirror the
// Req 20.1 definition of Participant_Identifiers exactly: participant name,
// email address, phone number, user id, and IP address.
// -----------------------------------------------------------------------------

/** The identifier categories that block transmission (Req 20.1). */
export type IdentifierKind = 'email' | 'phone' | 'ip' | 'user_id' | 'name';

/**
 * EMAIL — a `local@domain.tld` shape: one or more non-space/non-`@` chars, an
 * `@`, a dotted domain with a ≥2-letter TLD. Case-insensitive.
 *   e.g. `alice@example.com`, `bob.jones+tag@sub.co.uk`
 */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;

/**
 * PHONE — a run of digits (optionally `+`-prefixed and separated by spaces /
 * dashes / dots / parens) totalling 7–15 digits, matching the E.164-ish range.
 * The digit COUNT is checked separately (below) to avoid matching short numbers
 * or long numeric ids that are not phone-shaped.
 */
const PHONE_CANDIDATE_RE = /\+?[\d][\d\s().-]{5,}\d/;

/**
 * IPv4 — four dotted octets each 0–255. Anchored on word boundaries so it does
 * not match a version string like `1.2.3.4.5` sub-run incorrectly (each octet
 * is validated ≤ 255 by the range check in {@link containsIp}).
 */
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/;

/**
 * IPv6 — at least two hex groups joined by colons, OR a `::`-compressed form.
 * Deliberately broad: any colon-separated hex-group shape (incl. compressed)
 * counts as an IP identifier for the purposes of the guard.
 */
const IPV6_RE =
  /(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{0,4}|::(?:[0-9a-fA-F]{1,4}:?){1,}|(?:[0-9a-fA-F]{1,4}:){1,}:/;

/**
 * USER ID — a canonical UUID (8-4-4-4-12 hex), the shape user ids take across
 * the schema (`auth.users.id`, etc.). Case-insensitive.
 *   e.g. `3f2504e0-4f89-41d3-9a0c-0305e82c3301`
 */
const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;

/** True iff `text` contains an email-shaped substring (Req 20.1). */
export function containsEmail(text: string): boolean {
  return typeof text === 'string' && EMAIL_RE.test(text);
}

/**
 * True iff `text` contains a phone-number-shaped substring: a `+`/digit run
 * (with common separators) whose DIGIT count is in the 7–15 range (Req 20.1).
 */
export function containsPhone(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const match = text.match(PHONE_CANDIDATE_RE);
  if (!match) {
    return false;
  }
  const digitCount = (match[0].match(/\d/g) ?? []).length;
  return digitCount >= 7 && digitCount <= 15;
}

/** True iff `text` contains an IPv4 (valid octets) or IPv6 address (Req 20.1). */
export function containsIp(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const v4 = text.match(IPV4_RE);
  if (v4) {
    const octetsOk = [v4[1], v4[2], v4[3], v4[4]].every((o) => {
      const n = Number(o);
      return n >= 0 && n <= 255;
    });
    if (octetsOk) {
      return true;
    }
  }
  return IPV6_RE.test(text);
}

/** True iff `text` contains a UUID-shaped user id (Req 20.1). */
export function containsUserId(text: string): boolean {
  return typeof text === 'string' && UUID_RE.test(text);
}

// -----------------------------------------------------------------------------
// Deep scan of a candidate payload (Req 20.2).
//
// The guard walks a candidate payload — every question text and every metadata
// value, recursively through arrays/objects — and reports the FIRST identifier
// kind it detects, if any. "Name" is handled explicitly and separately: the
// builder never emits a name field, but if the CALLER supplies a set of known
// participant names (e.g. drawn from the event) the guard flags any that appear
// verbatim inside the serialised payload, closing the last identifier category.
// -----------------------------------------------------------------------------

/** The shape-based detectors, tried in a fixed, documented order. */
const SHAPE_DETECTORS: ReadonlyArray<
  readonly [IdentifierKind, (text: string) => boolean]
> = [
  ['email', containsEmail],
  ['user_id', containsUserId],
  ['ip', containsIp],
  ['phone', containsPhone],
];

/** Collects every string value reachable in a candidate payload. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      // Scan both the KEY and its VALUE — an identifier could hide in either.
      collectStrings(key, out);
      collectStrings((value as Record<string, unknown>)[key], out);
    }
  }
}

/**
 * The outcome of scanning a candidate payload for participant identifiers.
 * `detected = false` means the payload is clean and may be transmitted;
 * `detected = true` names the CATEGORY that must block transmission (Req 20.2).
 * The offending VALUE is never included (Req 20.7).
 */
export type IdentifierScanResult =
  | { readonly detected: false }
  | { readonly detected: true; readonly kind: IdentifierKind };

/**
 * Scans a candidate payload for any participant-identifier shape (Req 20.2).
 * Every reachable string (question texts, metadata keys/values, nested
 * structures) is checked against the shape detectors; when `knownNames` is
 * supplied, a verbatim (case-insensitive) occurrence of a known participant name
 * is also flagged. Returns the FIRST category found, or `{ detected: false }`.
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

  // Name detection is caller-supplied (a name has no intrinsic shape): flag any
  // known participant name that appears verbatim in the payload (Req 20.1).
  const haystack = strings.join('\n').toLowerCase();
  for (const raw of knownNames) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length > 0 && haystack.includes(name.toLowerCase())) {
      return { detected: true, kind: 'name' };
    }
  }

  return { detected: false };
}

// -----------------------------------------------------------------------------
// Pure send decision (Req 20.2).
//
// Folds the identifier scan into a send/no-send decision that dispatches
// NOTHING. This models "no call is made": a payload bearing an identifier
// resolves to `{ send: false }` so the caller never opens an outbound
// connection and instead records the restricted-data error (Req 20.2).
// -----------------------------------------------------------------------------

/** Why transmission was blocked — a fixed category, never the offending value. */
export type SendBlockReason = 'restricted_data';

/**
 * The pure transmission decision. `send: true` IFF the candidate payload is free
 * of participant identifiers; otherwise `send: false` with the blocking category
 * and the detected identifier kind (Req 20.2).
 */
export type SendDecision =
  | { readonly send: true }
  | {
      readonly send: false;
      readonly reason: SendBlockReason;
      readonly kind: IdentifierKind;
    };

/**
 * Decides whether a candidate payload may be transmitted. Returns `{ send: true }`
 * IFF {@link scanForIdentifiers} detects no identifier; otherwise blocks with
 * `restricted_data` and the offending category. Being pure, a `send: false`
 * decision dispatches nothing — it is the "block transmission, make no call"
 * contract of Req 20.2 expressed as data.
 */
export function decideSend(
  payload: unknown,
  knownNames: readonly string[] = [],
): SendDecision {
  const scan = scanForIdentifiers(payload, knownNames);
  if (scan.detected) {
    return { send: false, reason: 'restricted_data', kind: scan.kind };
  }
  return { send: true };
}
