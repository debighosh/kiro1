// =============================================================================
// SHARED HTTP RESPONSE HELPERS — Supabase Edge Functions (Deno runtime)
// =============================================================================
//
// Small helpers so every privileged mutation Edge Function returns JSON with a
// consistent shape and always carries the CORS headers.
//
// Error responses follow the design's *Error Handling* contract: a structured
// body with a machine-readable `error.code`, a human-readable `error.message`,
// and — for validation failures — a per-field `error.fields` array identifying
// each invalid field and its constraint (Req 1.2, 22.7). No error path leaks
// secrets or internal details (design: "No error path leaks secrets or provider
// internals").
//
// -----------------------------------------------------------------------------
// SANITISATION GUARANTEE (Req 21.8, 19.2) — the canonical error contract.
// -----------------------------------------------------------------------------
// This is the ONE canonical error shape every privileged Edge Function returns:
// `{ error: { code, message, fields? } }`. Callers construct it via
// `errorResponse(...)`. To honour the contract, EVERY call site MUST pass:
//   - a STABLE machine-readable `code` (e.g. `validation_failed`, `unauthorized`,
//     `slug_conflict`, `event_not_found`, `method_not_allowed`, `create_failed`),
//     safe for the client to branch on and stable across releases; and
//   - a SANITISED, caller-facing `message` — a fixed, human-readable string that
//     is safe to display. It MUST NOT embed a raw `err.message`, `err.stack`, a
//     provider response body/header, a PostgREST/Postgres diagnostic (including
//     SQLSTATE text, `.details`, `.hint`), a credential, or a hostname/IP.
// The `fields[].message` strings are developer-authored validation constraints
// (e.g. from a zod schema), NOT raw diagnostics — they are caller-facing by
// design (Req 1.2).
//
// When an underlying error carries diagnostic detail worth keeping, callers log
// it SERVER-SIDE ONLY (e.g. `console.error(...)`) — never in the response body,
// and NEVER any secret/credential. The AI Gateway extends this same discipline:
// every provider/timeout/SSRF/validation failure is first collapsed to a fixed
// sanitised CATEGORY (see `ai-gateway/gateway.ts` `sanitiseError`,
// `ai-gateway/connectionTest.ts`) before it reaches a client, so provider
// internals are never surfaced in an "AI unavailable" indication (Req 19.2).
//
// This is Deno code and is excluded from the SPA `tsc`/ESLint build.
//
// Requirements traceability: 1.2 (per-field validation errors), 21.6 (Edge
// Function responses), 21.8 (sanitised responses — no secrets/internals leaked),
// 19.2 (AI failures surfaced without exposing provider internals). Design
// references: Error Handling (Validation errors, Authorization errors; sanitised
// error contract); Server-Side AI Gateway Design (sanitised error categories).
// =============================================================================

import { corsHeaders } from './cors.ts';

/** A single per-field validation problem (Req 1.2 / 22.7). */
export interface FieldError {
  /** The invalid field name (e.g. `name`, `ends_at`, `slug`). */
  field: string;
  /** Human-readable description of the constraint that was violated. */
  message: string;
}

/**
 * Returns a JSON success response with the given status (default `200`) and the
 * CORS headers for the request.
 */
export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

/**
 * Returns a structured JSON error response.
 *
 * @param code    stable machine-readable code (e.g. `validation_failed`,
 *                `unauthorized`, `slug_conflict`, `method_not_allowed`).
 * @param message human-readable, SANITISED message safe to show a client. MUST
 *                be a fixed caller-facing string — never a raw `err.message`,
 *                stack, provider body/header, SQL/PostgREST diagnostic,
 *                credential, or hostname/IP (Req 21.8, 19.2). Log any diagnostic
 *                detail server-side only (see this file's header).
 * @param fields  optional per-field validation problems — developer-authored,
 *                caller-facing constraint messages, not raw diagnostics (Req 1.2).
 */
export function errorResponse(
  req: Request,
  status: number,
  code: string,
  message: string,
  fields?: FieldError[],
): Response {
  const error: { code: string; message: string; fields?: FieldError[] } = {
    code,
    message,
  };
  if (fields && fields.length > 0) {
    error.fields = fields;
  }
  return jsonResponse(req, { error }, status);
}
