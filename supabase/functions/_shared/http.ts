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
// This is Deno code and is excluded from the SPA `tsc`/ESLint build.
//
// Requirements traceability: 1.2 (per-field validation errors), 21.6 (Edge
// Function responses). Design references: Error Handling (Validation errors,
// Authorization errors).
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
 * @param message human-readable, sanitised message safe to show a client.
 * @param fields  optional per-field validation problems (Req 1.2).
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
