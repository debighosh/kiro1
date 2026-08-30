/**
 * Supabase browser client (anon key only).
 *
 * This is the single, shared browser-side Supabase client used by the React
 * SPA for RLS-gated reads/writes, Realtime subscriptions, and admin auth.
 *
 * Security invariant (Req 21.8; Design → Architecture / Component
 * responsibilities): the browser client ONLY ever uses the public anon key.
 * It never references the Supabase service role key or any other server-only
 * secret. All privileged operations (admin mutations, event-status
 * transitions, rate-limited anonymous submit/vote, and every AI call) go
 * through Supabase Edge Functions, never through this client. The anon key and
 * URL are sourced from the vetted {@link readClientEnv} loader, which forbids
 * referencing server-only secrets by name.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readClientEnv } from './env';

/** The type of the shared browser Supabase client. */
export type BrowserSupabaseClient = SupabaseClient;

const { VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY } = readClientEnv();

/**
 * Singleton Supabase browser client.
 *
 * Auth is configured for a SPA: the admin session is persisted and refreshed
 * automatically, and session state is detected from the URL for auth
 * redirects. The audience is anonymous and simply never establishes a session.
 */
export const supabase: BrowserSupabaseClient = createClient(
  VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
