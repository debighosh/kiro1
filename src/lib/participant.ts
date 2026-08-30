/**
 * Anonymous participant identifier — the SHARED, framework-agnostic identity module.
 *
 * =============================================================================
 * WHAT THIS IS
 * =============================================================================
 * A `Participant_Identifier` is a random, NON-PERSONAL token stored locally in
 * the participant's browser. It is used ONLY as an opaque parameter to the
 * submit / vote / poll-response / word-cloud RPCs so the server can enforce the
 * "one vote/response per participant" uniqueness rules. It is NOT an account,
 * NOT a session token, and carries NO information that identifies a natural
 * person (no name, email, phone, or IP) — it is pure `crypto`-grade randomness
 * (Req 2.5).
 *
 * =============================================================================
 * DO NOT RENDER THIS IN THE UI  (Req 8.6, 24.8)
 * =============================================================================
 * The participant identifier MUST NEVER be displayed in any user-facing element
 * (audience view, presenter view, analytics dashboard, or exports). It exists
 * only to be handed to RPC helpers/hooks as an opaque argument. This module
 * therefore deliberately exposes ONLY `getParticipantIdentifier()` — there is
 * no "formatted", "display", or "label" accessor by design, so nothing here
 * encourages putting the value on screen.
 *
 * =============================================================================
 * BEHAVIOUR
 * =============================================================================
 *  - First entry (no id present): generate a ≥128-bit random identifier via
 *    `crypto` and persist it under a namespaced `localStorage` key (Req 2.3).
 *  - Re-entry (id already present): reuse the stored identifier — NEVER
 *    regenerate (Req 2.4).
 *  - Fallback (Req 2.7): if `localStorage` is unavailable or a read/write throws
 *    (e.g. Safari Private Browsing, disabled storage, quota errors), fall back
 *    to a module-scoped in-memory identifier (mirrored to `sessionStorage` when
 *    possible) so the participant can still interact for the current session.
 *    The fallback yields a SINGLE stable value per session.
 *
 * This module is intentionally framework-agnostic (no React import) so RPC
 * helpers and hooks can call it directly, and so it can be exercised by Vitest.
 * Storage access is funnelled through small internal helpers and an injectable
 * storage accessor to keep the module testable (task 14.2 exercises these).
 *
 * Requirements traceability: 2.3, 2.4, 2.5, 2.7, 8.6, 24.8.
 * Design references: Frontend Design (Participant identity handling, Req 2.3–2.5, 2.7).
 */

/**
 * The namespaced key under which the participant identifier is persisted in
 * `localStorage` (and mirrored to `sessionStorage` in the fallback path).
 * Exported so tests can read/seed/clear the exact key the module uses.
 */
export const PARTICIPANT_ID_STORAGE_KEY = 'mss-livepulse.participant-id';

/**
 * The number of random bytes used to build a fresh identifier. 16 bytes = 128
 * bits of entropy, satisfying the "≥128 bits" requirement (Req 2.3). This is
 * the same entropy budget as a UUIDv4's random bits.
 */
const RANDOM_BYTE_LENGTH = 16;

/**
 * Module-scoped in-memory fallback identifier. Once set (either because storage
 * was unavailable on first access, or a persistent read failed), the SAME value
 * is returned for the remainder of the session, guaranteeing a single stable
 * value per session even when no persistent storage is usable (Req 2.7).
 */
let inMemoryFallbackId: string | null = null;

/**
 * A minimal structural view of the Web Storage API. Declared locally so this
 * module needs no DOM lib assumptions beyond what it actually uses, and so a
 * fake storage object can be injected in tests.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Resolves the ambient storage of the requested kind (`local` | `session`),
 * returning `null` when it is entirely unavailable. Accessing
 * `window.localStorage` can THROW (not just return `null`) in some browsers
 * (e.g. sandboxed iframes, disabled cookies), so the access itself is guarded.
 */
function getBrowserStorage(kind: 'local' | 'session'): StorageLike | null {
  try {
    // `globalThis.window` may be undefined in non-browser (SSR/test) contexts.
    const w = (globalThis as { window?: Window }).window ?? (globalThis as unknown as Window);
    const storage = kind === 'local' ? w?.localStorage : w?.sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * Safely reads a key from a storage object, treating any thrown error as
 * "unavailable" (returns `null`).
 */
function safeRead(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Safely writes a key to a storage object. Returns `true` on success and
 * `false` if the write throws (e.g. quota exceeded / private mode) or storage
 * is unavailable — the caller uses this to decide whether persistence held.
 */
function safeWrite(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates a fresh identifier with ≥128 bits of entropy using the platform
 * crypto primitives (Req 2.3). Prefers `crypto.randomUUID()` (a UUIDv4, 122
 * random bits) where available for a compact, well-known shape; otherwise
 * builds a 128-bit hex token from `crypto.getRandomValues`.
 *
 * The output is random-only and contains NO personal data (Req 2.5).
 */
export function generateParticipantIdentifier(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;

  // Preferred: 128-bit+ token from getRandomValues, guaranteeing the ≥128-bit
  // entropy budget explicitly (16 bytes = 128 bits).
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(RANDOM_BYTE_LENGTH);
    c.getRandomValues(bytes);
    let hex = '';
    for (const b of bytes) {
      hex += b.toString(16).padStart(2, '0');
    }
    return hex;
  }

  // Secondary: crypto.randomUUID (still crypto-backed) if getRandomValues is
  // somehow absent but randomUUID is present.
  if (c?.randomUUID) {
    return c.randomUUID();
  }

  // If no crypto source exists at all we must NOT fall back to a weak,
  // predictable value (that would violate the entropy requirement). This is not
  // expected in any supported browser; surface it loudly instead of degrading.
  throw new Error(
    'Secure random source (crypto.getRandomValues) is unavailable; cannot generate a participant identifier.',
  );
}

/**
 * Options for {@link getParticipantIdentifier}, used primarily by tests to
 * inject fake storage. In production callers pass nothing and the ambient
 * browser `localStorage`/`sessionStorage` are used.
 */
export interface ParticipantIdentifierOptions {
  /** Persistent storage to use instead of the ambient `localStorage`. */
  localStorage?: StorageLike | null;
  /** Session storage to use instead of the ambient `sessionStorage`. */
  sessionStorage?: StorageLike | null;
}

/**
 * Returns the current participant identifier, generating and persisting one on
 * first call. On every subsequent call within the same browser (or session, in
 * the fallback path) the SAME value is returned — a new identifier is never
 * generated when one already exists (Req 2.4).
 *
 * Resolution order:
 *   1. If a valid id is already in the module-scoped in-memory fallback, return
 *      it (keeps the session stable once we have degraded to fallback).
 *   2. Try persistent `localStorage`: reuse an existing value, or generate one
 *      and persist it there (Req 2.3, 2.4).
 *   3. If persistence is unavailable OR the write did not hold, fall back to a
 *      session-scoped identifier: reuse/seed `sessionStorage` when possible and
 *      always mirror into the in-memory value so it stays stable for the
 *      session even if `sessionStorage` is also unusable (Req 2.7).
 *
 * The returned value is opaque and MUST NOT be rendered in the UI (Req 8.6,
 * 24.8) — see the module header.
 */
export function getParticipantIdentifier(
  options: ParticipantIdentifierOptions = {},
): string {
  // 1. Already degraded to an in-memory value this session → stay stable.
  if (inMemoryFallbackId !== null) {
    return inMemoryFallbackId;
  }

  const local =
    options.localStorage !== undefined
      ? options.localStorage
      : getBrowserStorage('local');

  // 2. Persistent path (the common case).
  const existing = safeRead(local, PARTICIPANT_ID_STORAGE_KEY);
  if (existing) {
    return existing; // reuse — never regenerate (Req 2.4)
  }

  const generated = generateParticipantIdentifier();
  if (safeWrite(local, PARTICIPANT_ID_STORAGE_KEY, generated)) {
    // Persisted successfully; confirm the write held by reading it back so a
    // storage that silently drops writes still routes us to the fallback.
    if (safeRead(local, PARTICIPANT_ID_STORAGE_KEY) === generated) {
      return generated;
    }
  }

  // 3. Fallback path (Req 2.7): localStorage unavailable or the write did not
  // hold. Use a session-scoped identifier and pin it in memory so it is a
  // single stable value for the session.
  const session =
    options.sessionStorage !== undefined
      ? options.sessionStorage
      : getBrowserStorage('session');

  const sessionExisting = safeRead(session, PARTICIPANT_ID_STORAGE_KEY);
  if (sessionExisting) {
    inMemoryFallbackId = sessionExisting;
    return inMemoryFallbackId;
  }

  // Reuse the value we already generated above so we don't burn extra entropy.
  inMemoryFallbackId = generated;
  // Best-effort mirror to sessionStorage; failure is fine — the in-memory value
  // already guarantees session stability.
  safeWrite(session, PARTICIPANT_ID_STORAGE_KEY, inMemoryFallbackId);
  return inMemoryFallbackId;
}

/**
 * Test-only helper: clears the module-scoped in-memory fallback so each test can
 * start from a clean slate. Has no effect on any persistent/session storage.
 * Not part of the participant-facing contract.
 */
export function __resetInMemoryFallbackForTests(): void {
  inMemoryFallbackId = null;
}
