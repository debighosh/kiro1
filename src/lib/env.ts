/**
 * Typed client-side environment loader.
 *
 * This module is the ONLY sanctioned way for browser/client code to read
 * environment configuration. It enforces two invariants from the design
 * (Deployment and Environment → Environment variables) and Req 21.8:
 *
 *  1. Client code may only read `VITE_`-prefixed, non-secret values.
 *  2. Server-only secrets (service role key, AI credential encryption key, and
 *     the AI endpoint allowlist) must NEVER be referenced from client code.
 *     Attempting to do so throws immediately, making the invariant testable.
 *
 * Server-side secrets live only in Supabase / Vercel server environments and
 * are never imported here, so they can never be bundled into the browser.
 */

/**
 * Names that are forbidden in client code. Referencing any of these via
 * {@link assertClientSafeEnvName} or {@link readClientEnv} throws.
 *
 * Frozen so the list cannot be mutated at runtime.
 */
export const FORBIDDEN_CLIENT_ENV_NAMES = Object.freeze([
  'SUPABASE_SERVICE_ROLE_KEY',
  'AI_CREDENTIAL_ENCRYPTION_KEY',
  'AI_ENDPOINT_ALLOWLIST',
] as const);

export type ForbiddenClientEnvName = (typeof FORBIDDEN_CLIENT_ENV_NAMES)[number];

/** Typed shape of the environment values exposed to the browser. */
export interface ClientEnv {
  /** Vite-exposed Supabase project URL. */
  readonly VITE_SUPABASE_URL: string;
  /** Vite-exposed Supabase anon key (RLS-gated public access, not a secret). */
  readonly VITE_SUPABASE_ANON_KEY: string;
}

/** Error thrown when the client environment is misconfigured or misused. */
export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

/**
 * Guard that refuses to reference a server-only secret from client code.
 *
 * Throws {@link EnvConfigError} if `name` is one of
 * {@link FORBIDDEN_CLIENT_ENV_NAMES}. Returns the (safe) name otherwise so it
 * can be used inline.
 */
export function assertClientSafeEnvName(name: string): string {
  if ((FORBIDDEN_CLIENT_ENV_NAMES as readonly string[]).includes(name)) {
    throw new EnvConfigError(
      `Server-only secret "${name}" must never be referenced from client code (Req 21.8). ` +
        `Only VITE_-prefixed, non-secret values are allowed in the browser bundle.`,
    );
  }
  return name;
}

/** Required client-side (`VITE_`-prefixed) variable names. */
const REQUIRED_VITE_ENV_NAMES = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const;

/**
 * Reads and validates the `VITE_`-prefixed client environment.
 *
 * - Reads ONLY `VITE_`-prefixed variables from `import.meta.env`.
 * - Throws {@link EnvConfigError} at startup if any required var is missing.
 * - Never reads server-only secret names (guarded defensively).
 *
 * @param source Overridable env source (defaults to `import.meta.env`), used to
 *   keep the loader unit-testable without global mutation.
 */
export function readClientEnv(
  source: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
): ClientEnv {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of REQUIRED_VITE_ENV_NAMES) {
    // Defensive: required names are VITE_-prefixed, but re-assert the invariant.
    assertClientSafeEnvName(name);
    const raw = source[name];
    if (typeof raw !== 'string' || raw.trim() === '') {
      missing.push(name);
      continue;
    }
    values[name] = raw;
  }

  if (missing.length > 0) {
    throw new EnvConfigError(
      `Missing required client environment variable(s): ${missing.join(', ')}. ` +
        `Set them (see .env.example) before starting the app.`,
    );
  }

  return Object.freeze({
    VITE_SUPABASE_URL: values.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: values.VITE_SUPABASE_ANON_KEY,
  });
}
