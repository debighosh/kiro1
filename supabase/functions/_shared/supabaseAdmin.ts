// =============================================================================
// SERVER-SIDE ONLY — SUPABASE SERVICE-ROLE CLIENT (Supabase Edge Functions / Deno)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module is intended to run ONLY inside Supabase Edge Functions, which
//  execute on the Deno runtime — NOT inside the Vite/Node SPA bundle under
//  `src/`. It constructs a Supabase client using the SUPABASE_SERVICE_ROLE_KEY.
//
//  The service-role key has full administrative privileges and **BYPASSES Row
//  Level Security (RLS) entirely**. It must never be exposed to the browser or
//  embedded in client code. The SPA talks to Supabase using the anon key only
//  (see `src/lib/supabaseClient.ts`, task 3.2); privileged/admin mutations flow
//  exclusively through Edge Functions that use this service-role client after
//  verifying an authenticated admin JWT.
//
//  Requirements traceability:
//    - Req 21.6 — admin mutations run through Edge Functions using the service role.
//    - Req 21.8 — the service-role key is server-side only and is NEVER shipped
//      to / referenced by the client.
//
//  Design references:
//    - Architecture → "Edge Functions — privileged mutations" (service role behind
//      an authenticated JWT check).
//    - Component responsibilities (Edge Functions use the service role).
//    - RLS Design → "Admin mutations" (admin writes & status transitions run through
//      Edge Functions using the service role after verifying an authenticated JWT).
//
//  Because this is Deno code it is intentionally NOT part of the SPA's
//  `tsc -b` typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). Types for the JSR
//  import and `Deno.*` are resolved by the Supabase Edge Functions / Deno
//  toolchain at deploy time, not by the SPA build.
// =============================================================================

// Deno-style import used by Supabase Edge Functions. The `jsr:` specifier is the
// currently recommended way to import supabase-js inside Edge Functions.
import {
  createClient,
  type SupabaseClient,
} from 'jsr:@supabase/supabase-js@2';

/**
 * Reads a required environment variable from the Deno environment, throwing a
 * clear, actionable error when it is missing. Keeping this local avoids leaking
 * the *value* of secrets into error messages (only the variable NAME is shown).
 */
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.length === 0) {
    throw new Error(
      `[supabaseAdmin] Missing required environment variable "${name}". ` +
        `This Edge Function requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ` +
        `to be configured in the server-side (Edge Function) environment.`,
    );
  }
  return value;
}

/**
 * Constructs a Supabase client authenticated with the SERVICE ROLE key.
 *
 * The service-role client BYPASSES RLS, so callers are responsible for their own
 * authorisation checks (e.g. verifying an authenticated admin JWT) BEFORE
 * performing any mutation. See tasks 7.2 / 7.3 for the actual event mutation +
 * admin-JWT verification logic — this module only wires up the shared client.
 *
 * Session persistence and token auto-refresh are disabled because this runs in a
 * stateless server context (no browser storage, one client per invocation).
 *
 * @throws if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.
 */
export function createAdminClient(): SupabaseClient {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      // Server context: never persist a session or auto-refresh tokens.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Convenience accessor returning the service-role client. Currently constructs a
 * fresh client per call (safe & stateless for Edge Function invocations). Kept as
 * a distinct export so call sites can depend on an intent-revealing name.
 */
export function getAdminClient(): SupabaseClient {
  return createAdminClient();
}

// -----------------------------------------------------------------------------
// NOTE — admin JWT verification is deferred.
//
// Verifying an authenticated admin JWT before performing privileged event
// mutations is intentionally NOT implemented here. That logic (and the event
// create / status-transition mutations themselves) belongs to tasks 7.2 and 7.3.
// This task (3.3) provides ONLY the shared service-role client wiring.
// -----------------------------------------------------------------------------
