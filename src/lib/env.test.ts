/**
 * Task 2.2 — Unit test asserting no server-only secret is referenced in client code.
 *
 * Validates that the client env loader (src/lib/env.ts) enforces the invariant
 * from Req 21.8 / Design "Deployment and Environment": client code may read only
 * `VITE_`-prefixed, non-secret values, and any reference to a server-only secret
 * name throws immediately.
 *
 * The tests use the `source` override parameter of `readClientEnv` so they never
 * depend on the real `import.meta.env`.
 *
 * Requirements: 21.8
 * Design: Deployment and Environment
 */
import { describe, expect, it } from 'vitest';
import {
  assertClientSafeEnvName,
  EnvConfigError,
  FORBIDDEN_CLIENT_ENV_NAMES,
  readClientEnv,
} from './env';

const SERVER_ONLY_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'AI_CREDENTIAL_ENCRYPTION_KEY',
  'AI_ENDPOINT_ALLOWLIST',
] as const;

const VALID_SOURCE = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-public-key-123',
};

describe('FORBIDDEN_CLIENT_ENV_NAMES', () => {
  it('contains exactly the three server-only secret names', () => {
    // Compare as a set so order does not matter, plus assert the exact length.
    expect(FORBIDDEN_CLIENT_ENV_NAMES).toHaveLength(3);
    expect([...FORBIDDEN_CLIENT_ENV_NAMES].sort()).toEqual(
      [...SERVER_ONLY_NAMES].sort(),
    );
  });
});

describe('assertClientSafeEnvName', () => {
  it.each(SERVER_ONLY_NAMES)(
    'throws EnvConfigError for server-only secret "%s"',
    (name) => {
      expect(() => assertClientSafeEnvName(name)).toThrow(EnvConfigError);
    },
  );

  it('returns the name for a safe VITE_-prefixed variable', () => {
    expect(assertClientSafeEnvName('VITE_SUPABASE_URL')).toBe(
      'VITE_SUPABASE_URL',
    );
    expect(assertClientSafeEnvName('VITE_SUPABASE_ANON_KEY')).toBe(
      'VITE_SUPABASE_ANON_KEY',
    );
  });
});

describe('readClientEnv', () => {
  it('returns the expected typed object for a valid source with both VITE_ vars', () => {
    const env = readClientEnv({ ...VALID_SOURCE });

    expect(env).toEqual({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-public-key-123',
    });
  });

  it('returns a frozen object', () => {
    const env = readClientEnv({ ...VALID_SOURCE });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('throws EnvConfigError when a required VITE_ var is missing', () => {
    const source = { VITE_SUPABASE_URL: 'https://example.supabase.co' };
    expect(() => readClientEnv(source)).toThrow(EnvConfigError);
  });

  it('throws EnvConfigError when a required VITE_ var is blank/whitespace', () => {
    const source = {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: '   ',
    };
    expect(() => readClientEnv(source)).toThrow(EnvConfigError);
  });

  it('does not read or expose any server-only secret even if present in the source', () => {
    const source = {
      ...VALID_SOURCE,
      SUPABASE_SERVICE_ROLE_KEY: 'super-secret',
      AI_CREDENTIAL_ENCRYPTION_KEY: 'another-secret',
      AI_ENDPOINT_ALLOWLIST: 'https://ai.example.com',
    };

    const env = readClientEnv(source);

    // Only the two VITE_ keys are exposed; no server-only name leaks through.
    expect(Object.keys(env).sort()).toEqual([
      'VITE_SUPABASE_ANON_KEY',
      'VITE_SUPABASE_URL',
    ]);
    for (const name of SERVER_ONLY_NAMES) {
      expect(env).not.toHaveProperty(name);
    }
  });
});
