/**
 * Task 14.2 — Unit tests for participant-identifier generation / reuse / fallback.
 *
 * Exercises the SHARED, framework-agnostic identity module in
 * `src/lib/participant.ts`. Storage is injected via the `options` parameter with
 * small in-memory fake `StorageLike` implementations, so the tests never depend
 * on the real browser `localStorage`/`sessionStorage`. The module-scoped
 * in-memory fallback is reset before each test via
 * `__resetInMemoryFallbackForTests()` so cases stay isolated.
 *
 * Assertions map to the acceptance criteria:
 *   - Req 2.3: first entry generates a ≥128-bit identifier and persists it in
 *     local storage under the namespaced key.
 *   - Req 2.4: re-entry reuses the stored identifier — a new value is NEVER
 *     generated / persisted when one already exists.
 *   - Req 2.7: when local storage is unavailable or a write fails, a
 *     session-scoped identifier is used and stays STABLE for the session.
 *   - Req 8.6: the value is never surfaced through a UI-facing accessor — the
 *     module exposes no display/label/formatted accessor.
 *
 * Requirements traceability: 2.3, 2.4, 2.7, 8.6, 26.1.
 * Design references: Frontend Design (Participant identity handling, Req 2.3–2.5, 2.7).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  __resetInMemoryFallbackForTests,
  generateParticipantIdentifier,
  getParticipantIdentifier,
  PARTICIPANT_ID_STORAGE_KEY,
  type StorageLike,
} from './participant';
import * as participantModule from './participant';

/**
 * Minimal in-memory `StorageLike` fake. Backed by a plain `Map`, so it behaves
 * like a working `localStorage`/`sessionStorage` with no browser dependency.
 */
function createMemoryStorage(seed?: Record<string, string>): StorageLike & {
  snapshot(): Record<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    snapshot(): Record<string, string> {
      return Object.fromEntries(store.entries());
    },
  };
}

/**
 * A `StorageLike` fake whose `getItem`/`setItem` always throw — models a browser
 * where storage is present but unusable (Safari Private Browsing, disabled
 * storage, quota errors). `removeItem` also throws for completeness.
 */
function createThrowingStorage(): StorageLike {
  return {
    getItem(): string | null {
      throw new Error('storage unavailable');
    },
    setItem(): void {
      throw new Error('storage write blocked');
    },
    removeItem(): void {
      throw new Error('storage unavailable');
    },
  };
}

/** A working-read but write-dropping storage (silently discards writes). */
function createWriteDroppingStorage(): StorageLike {
  return {
    getItem(): string | null {
      return null; // never reflects any write
    },
    setItem(): void {
      /* silently drop the write — read-back will not find it */
    },
    removeItem(): void {
      /* no-op */
    },
  };
}

/** Matches a 32-char lowercase hex token (16 bytes = 128 bits). */
const HEX_128_RE = /^[0-9a-f]{32}$/;
/** Matches a canonical UUID (the secondary generation shape). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  // Isolate the module-scoped in-memory fallback between tests (Req 2.7 path).
  __resetInMemoryFallbackForTests();
});

afterEach(() => {
  // Leave no fallback state behind for the next file/test.
  __resetInMemoryFallbackForTests();
});

describe('generateParticipantIdentifier — entropy (Req 2.3)', () => {
  it('produces a value with ≥128 bits of entropy (32 hex chars or a UUID)', () => {
    const id = generateParticipantIdentifier();

    expect(typeof id).toBe('string');
    // On Node (where Vitest runs) crypto.getRandomValues is available, so the
    // hex path is taken. Accept the UUID shape too so the assertion documents
    // the ≥128-bit contract without over-fitting to one platform.
    const isHex128 = HEX_128_RE.test(id);
    const isUuid = UUID_RE.test(id);
    expect(isHex128 || isUuid).toBe(true);

    // For the hex path, 32 hex chars == 128 bits, satisfying the requirement.
    if (isHex128) {
      expect(id).toHaveLength(32);
      expect(id.length * 4).toBeGreaterThanOrEqual(128);
    }
  });

  it('yields a different value on two successive generations', () => {
    const a = generateParticipantIdentifier();
    const b = generateParticipantIdentifier();
    expect(a).not.toBe(b);
  });

  it('produces distinct values across many generations (no obvious collisions)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(generateParticipantIdentifier());
    }
    expect(seen.size).toBe(200);
  });
});

describe('getParticipantIdentifier — first entry persists (Req 2.3)', () => {
  it('generates and persists a value under PARTICIPANT_ID_STORAGE_KEY, then returns it', () => {
    const local = createMemoryStorage();

    const id = getParticipantIdentifier({ localStorage: local });

    expect(id).toBeTruthy();
    // The returned value was written to the exact namespaced key.
    expect(local.getItem(PARTICIPANT_ID_STORAGE_KEY)).toBe(id);
    expect(local.snapshot()[PARTICIPANT_ID_STORAGE_KEY]).toBe(id);
    // Shape implies ≥128 bits (hex or UUID).
    expect(HEX_128_RE.test(id) || UUID_RE.test(id)).toBe(true);
  });
});

describe('getParticipantIdentifier — reuse, never regenerate (Req 2.4)', () => {
  it('returns the SAME value on a second call and does not overwrite the store', () => {
    const local = createMemoryStorage();

    const first = getParticipantIdentifier({ localStorage: local });
    const stored = local.getItem(PARTICIPANT_ID_STORAGE_KEY);
    const second = getParticipantIdentifier({ localStorage: local });

    expect(second).toBe(first);
    // The stored value must be unchanged between the two calls.
    expect(local.getItem(PARTICIPANT_ID_STORAGE_KEY)).toBe(stored);
  });

  it('returns the exact pre-seeded value without regenerating', () => {
    const seeded = 'seeded000000000000000000000000ab';
    const local = createMemoryStorage({ [PARTICIPANT_ID_STORAGE_KEY]: seeded });

    const id = getParticipantIdentifier({ localStorage: local });

    expect(id).toBe(seeded);
    // The seeded value is returned unchanged (no regeneration/overwrite).
    expect(local.getItem(PARTICIPANT_ID_STORAGE_KEY)).toBe(seeded);
  });

  it('is idempotent across repeated calls with a working store', () => {
    const seeded = 'seededabcdef0123456789abcdef01234';
    const local = createMemoryStorage({ [PARTICIPANT_ID_STORAGE_KEY]: seeded });

    const results = Array.from({ length: 5 }, () =>
      getParticipantIdentifier({ localStorage: local }),
    );

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(seeded);
  });
});

describe('getParticipantIdentifier — session-scoped fallback (Req 2.7)', () => {
  it('returns a stable non-empty id when localStorage throws, stable across calls', () => {
    const local = createThrowingStorage();
    const session = createMemoryStorage();

    const first = getParticipantIdentifier({
      localStorage: local,
      sessionStorage: session,
    });
    const second = getParticipantIdentifier({
      localStorage: local,
      sessionStorage: session,
    });

    expect(first).toBeTruthy();
    // Same session → same identifier (in-memory fallback keeps it stable).
    expect(second).toBe(first);
    // Best-effort mirror into the writable sessionStorage fake.
    expect(session.getItem(PARTICIPANT_ID_STORAGE_KEY)).toBe(first);
  });

  it('stays stable when the localStorage write silently drops (read-back fails)', () => {
    const local = createWriteDroppingStorage();
    const session = createMemoryStorage();

    const first = getParticipantIdentifier({
      localStorage: local,
      sessionStorage: session,
    });
    const second = getParticipantIdentifier({
      localStorage: local,
      sessionStorage: session,
    });

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(session.getItem(PARTICIPANT_ID_STORAGE_KEY)).toBe(first);
  });

  it('remains usable when BOTH localStorage and sessionStorage are unavailable', () => {
    const local = createThrowingStorage();
    const session = createThrowingStorage();

    const first = getParticipantIdentifier({
      localStorage: local,
      sessionStorage: session,
    });
    const second = getParticipantIdentifier({
      localStorage: local,
      sessionStorage: session,
    });

    // The in-memory fallback alone guarantees a single stable value.
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('reuses an existing sessionStorage value in the fallback path', () => {
    const existing = 'sessionseed0123456789abcdef012345';
    const local = createThrowingStorage();
    const session = createMemoryStorage({
      [PARTICIPANT_ID_STORAGE_KEY]: existing,
    });

    const id = getParticipantIdentifier({
      localStorage: local,
      sessionStorage: session,
    });

    expect(id).toBe(existing);
  });
});

describe('participant module — value is never surfaced in the UI (Req 8.6)', () => {
  it('exposes no display/label/formatted accessor', () => {
    const exportNames = Object.keys(participantModule);

    // The only id-returning API is the two documented functions.
    expect(exportNames).toContain('getParticipantIdentifier');
    expect(exportNames).toContain('generateParticipantIdentifier');

    // Guard against a UI-facing accessor sneaking in.
    const forbidden = [
      'formatParticipantId',
      'formatParticipantIdentifier',
      'participantLabel',
      'displayParticipantId',
      'getParticipantLabel',
      'getParticipantDisplayName',
      'renderParticipantId',
    ];
    for (const name of forbidden) {
      expect(exportNames).not.toContain(name);
    }

    // Nothing named like display/label/format is exported for the identifier.
    const suspicious = exportNames.filter((n) =>
      /(display|label|format|render)/i.test(n),
    );
    expect(suspicious).toEqual([]);
  });
});

describe('Feature: mss-livepulse, participant-identifier idempotence property (Req 2.4)', () => {
  it('is invariant after the first call for any sequence length with a working store', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 25 }), (calls) => {
        // Fresh isolated state per property run.
        __resetInMemoryFallbackForTests();
        const local = createMemoryStorage();

        const first = getParticipantIdentifier({ localStorage: local });
        for (let i = 1; i < calls; i += 1) {
          const next = getParticipantIdentifier({ localStorage: local });
          // Every subsequent call returns the first value unchanged.
          if (next !== first) return false;
        }
        // The persisted value equals the first result and never changed.
        return local.getItem(PARTICIPANT_ID_STORAGE_KEY) === first;
      }),
    );
  });
});
