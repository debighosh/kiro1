// =============================================================================
// SHARED CORS HELPER — Supabase Edge Functions (Deno runtime)
// =============================================================================
//
// The MSS LivePulse React SPA (served from Vercel / the local Vite dev server)
// calls privileged mutation Edge Functions cross-origin. Browsers therefore
// issue a CORS preflight (`OPTIONS`) before the actual `POST`, and require the
// real response to carry the matching `Access-Control-Allow-*` headers.
//
// This helper centralises CORS handling so every Edge Function (create-event,
// the future status-transition function, etc.) behaves consistently:
//   - `corsHeaders(origin)` returns the headers to attach to every response.
//   - `handlePreflight(req)` short-circuits an `OPTIONS` request with `204`.
//
// Origin policy (defence-in-depth; the authoritative security boundary is the
// admin-JWT check + RLS, not CORS):
//   - An allow-list of origins is read from the `CORS_ALLOWED_ORIGINS` env var
//     (comma-separated). If the request's `Origin` is on the list, it is echoed
//     back (enabling credentialed requests to a specific origin rather than the
//     wildcard `*`).
//   - If `CORS_ALLOWED_ORIGINS` is unset (typical for local dev), the request
//     origin is echoed back so local development "just works". In production,
//     set `CORS_ALLOWED_ORIGINS` to the deployed SPA origin(s).
//
// NOTE: this is Deno code (uses `Deno.env`) and is intentionally excluded from
// the SPA `tsc`/ESLint build (`supabase/functions` is ignored).
//
// Requirements traceability: 21.6 (privileged ops via Edge Functions callable
// from the SPA), 10.1 (auth enforced server-side; CORS is not the auth boundary).
// Design references: Architecture (Edge Functions — privileged mutations);
// Frontend Design (SPA calls Edge Functions for privileged operations).
// =============================================================================

/** Methods the privileged mutation functions accept from the SPA. */
const ALLOWED_METHODS = 'POST, OPTIONS';

/**
 * Request headers the SPA is permitted to send. `authorization` carries the
 * admin access token (Bearer JWT); `apikey` is the Supabase anon key the
 * platform gateway expects; `content-type` is `application/json`.
 */
const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type';

/**
 * Resolves the `Access-Control-Allow-Origin` value for a request.
 *
 * - With `CORS_ALLOWED_ORIGINS` configured: echoes the request origin only when
 *   it is on the allow-list; otherwise falls back to the first configured
 *   origin (so a disallowed origin still receives a concrete, non-matching
 *   value and the browser blocks it).
 * - Without configuration: echoes the request origin (dev convenience), or `*`
 *   when there is no `Origin` header (e.g. server-to-server / curl).
 */
function resolveAllowedOrigin(requestOrigin: string | null): string {
  const configured = Deno.env.get('CORS_ALLOWED_ORIGINS');

  if (configured && configured.trim().length > 0) {
    const allowList = configured
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);

    if (requestOrigin && allowList.includes(requestOrigin)) {
      return requestOrigin;
    }
    // Disallowed / missing origin: return a configured origin so the browser
    // (which compares against its own origin) rejects the cross-origin call.
    return allowList[0] ?? 'null';
  }

  // No allow-list configured (local dev): echo the caller's origin, or `*`.
  return requestOrigin ?? '*';
}

/**
 * Builds the CORS + `Vary` headers to attach to every Edge Function response.
 * `Vary: Origin` ensures caches do not serve an origin-specific response to a
 * different origin.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = resolveAllowedOrigin(req.headers.get('Origin'));
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Handles a CORS preflight (`OPTIONS`) request. Returns a `204 No Content`
 * response with the CORS headers when the method is `OPTIONS`, otherwise `null`
 * so the caller proceeds with normal request handling.
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  return null;
}
