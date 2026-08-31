// =============================================================================
// EDGE FUNCTION: moderate-question — question moderation mutation (Deno runtime)
// =============================================================================
//
// Privileged mutation Edge Function that moderates a `questions` row on behalf
// of an authenticated administrator. This is the authoritative, server-side
// moderation path: the SPA never updates `questions.status` directly. The
// `questions` table has NO client UPDATE policy under RLS — moderation happens
// exclusively through the service role behind this JWT-verified function. The
// browser calls this function with the administrator's Supabase access token in
// the `Authorization: Bearer <jwt>` header.
//
// Behaviour (task 16.1):
//   1. Handle the CORS preflight; accept POST only (else 405).
//   2. Verify the caller carries a valid authenticated admin JWT — exactly like
//      create-event (task 7.2) and transition-event-status (task 7.3).
//      Missing/invalid → 401 and NO change made (Req 10.1, 21.6). For V1 any
//      authenticated user is an admin (Req 10.3).
//   3. Validate the JSON body { question_id: uuid, action:
//      'approve'|'feature'|'answer'|'hide' } with zod. Invalid input → 400 with a
//      structured, per-field error (Req 1.2), no change.
//   4. Map the action to the target `question_status`:
//        approve → 'approved', feature → 'featured', answer → 'answered',
//        hide → 'hidden'. (The full enum is
//        'pending'|'approved'|'featured'|'answered'|'hidden'; a moderator never
//        moves a question back to 'pending' — that is the pre-moderation arrival
//        state set by the submit path, Req 3.6.)
//   5. Load the current question by id via the SERVICE-ROLE client (capturing its
//      `event_id` for the audit entry). Not found → 404.
//   6. Update `questions.status` to the target status via the service-role client
//      (bypasses RLS; authorisation already verified). `updated_at` is refreshed
//      by the DB trigger (task 11.1).
//   7. Write an `audit_log` row { change_type: 'moderation', event_id } for the
//      moderation change (Req 21.19). `occurred_at` is DB-defaulted to now()
//      (UTC). A failed audit insert is logged server-side but does NOT fail the
//      request — mirroring transition-event-status; `audit_written` in the
//      response signals the outcome.
//   8. On success respond 200 with the updated question { id, status } and the
//      previous status. No error path leaks internals; only sanitised messages.
//
// CORS: the SPA calls this cross-origin, so an `OPTIONS` preflight is handled and
// every response carries CORS headers (see `_shared/cors.ts`).
//
// This is Deno / Supabase Edge Function code. It uses `Deno.*` globals and
// `npm:` / `jsr:` / relative Deno import specifiers, and is intentionally
// excluded from the SPA `tsc -b` typecheck and ESLint run (`supabase/functions`
// is ignored), so it does not affect `npm run build` / `npm run lint`.
//
// Requirements traceability: 3.11, 3.12, 10.1, 21.6, 21.19.
// Design references: Architecture (Edge Functions — privileged mutations,
// admin moderation via the service role behind a JWT check); Data Models
// (`questions`, `audit_log`); Error Handling (Validation / Authorization /
// Not-found errors).
// =============================================================================

import { z } from 'npm:zod@4';
import { createClient } from 'jsr:@supabase/supabase-js@2';

import { getAdminClient } from '../_shared/supabaseAdmin.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';
import {
  errorResponse,
  type FieldError,
  jsonResponse,
} from '../_shared/http.ts';

// -----------------------------------------------------------------------------
// Validation contract for the moderation-mutation input.
//
// A moderation request identifies the question by id and the moderation action
// to apply. The action set is the moderator-facing verbs (approve/feature/
// answer/hide); each maps to exactly one target `question_status` below. The DB
// `question_status` enum also includes 'pending' (the pre-moderation arrival
// state, Req 3.6) — a moderator never targets 'pending' via this endpoint, so it
// is deliberately not an accepted action.
// -----------------------------------------------------------------------------

/** Moderation actions a moderator may apply (mirrors the moderation verbs). */
const MODERATION_ACTIONS = ['approve', 'feature', 'answer', 'hide'] as const;
type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** Target question statuses (mirror the DB `question_status` enum values). */
type QuestionStatus =
  'pending' | 'approved' | 'featured' | 'answered' | 'hidden';

/**
 * Maps each moderation action to the target `question_status` it applies
 * (Req 3.5, 3.9, 3.10). 'approve' surfaces a question to the audience;
 * 'feature' spotlights it; 'answer' marks it answered; 'hide' removes it from
 * the audience/presenter views.
 */
const ACTION_TO_STATUS: Readonly<Record<ModerationAction, QuestionStatus>> = {
  approve: 'approved',
  feature: 'featured',
  answer: 'answered',
  hide: 'hidden',
};

const questionIdSchema = z.string().uuid({
  message: 'question_id must be a valid UUID.',
});

const actionSchema = z.enum(MODERATION_ACTIONS, {
  message: "action must be one of 'approve', 'feature', 'answer', or 'hide'.",
});

const moderationInputSchema = z.object({
  question_id: questionIdSchema,
  action: actionSchema,
});

type ModerationInput = z.infer<typeof moderationInputSchema>;

/**
 * Flattens Zod issues into the per-field error list the client renders inline
 * (Req 1.2 / 22.7). The dotted issue path becomes the `field` name; issues with
 * an empty path are reported against a synthetic `_root` field.
 */
function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }));
}

// -----------------------------------------------------------------------------
// Admin JWT verification (Req 10.1, 21.6) — identical approach to create-event
// and transition-event-status.
//
// The `Authorization: Bearer <jwt>` header carries the administrator's Supabase
// access token. We resolve the user by binding a request-scoped anon client to
// that header and calling `auth.getUser(token)`, which validates the token
// server-side. A missing header or invalid/expired token yields no user → the
// caller returns 401 and makes no change. For V1 any authenticated user is an
// admin (Req 10.3).
// -----------------------------------------------------------------------------

interface AuthResult {
  userId: string | null;
}

async function resolveAuthenticatedUser(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { userId: null };
  }
  const token = match[1].trim();
  if (token.length === 0) {
    return { userId: null };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    // Environment misconfiguration — treat as unauthenticated (fail closed).
    return { userId: null };
  }

  // A request-scoped client bound to the caller's token; `getUser` validates
  // the JWT against Supabase Auth.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) {
    return { userId: null };
  }
  return { userId: data.user.id };
}

// -----------------------------------------------------------------------------
// Handler.
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight.
  const preflight = handlePreflight(req);
  if (preflight) {
    return preflight;
  }

  // Only POST moderates a question.
  if (req.method !== 'POST') {
    return errorResponse(
      req,
      405,
      'method_not_allowed',
      'This endpoint only accepts POST requests.',
    );
  }

  // 1) Authenticate the admin (Req 10.1, 21.6). No user → 401, no change.
  const { userId } = await resolveAuthenticatedUser(req);
  if (!userId) {
    return errorResponse(
      req,
      401,
      'unauthorized',
      'Authentication is required to moderate a question.',
    );
  }

  // 2) Parse the JSON body.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(
      req,
      400,
      'invalid_json',
      'Request body must be valid JSON.',
    );
  }

  // 3) Validate against the moderation contract (Req 1.2). Invalid → 400, no change.
  const parsed = moderationInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      req,
      400,
      'validation_failed',
      'One or more fields are invalid.',
      toFieldErrors(parsed.error),
    );
  }
  const input: ModerationInput = parsed.data;

  // 4) Map the moderation action to the target status (Req 3.5, 3.9, 3.10).
  const targetStatus = ACTION_TO_STATUS[input.action];

  const admin = getAdminClient();

  // 5) Load the current question via the SERVICE-ROLE client, capturing its
  // `event_id` for the audit entry. Not found → 404.
  const { data: current, error: loadError } = await admin
    .from('questions')
    .select('id, status, event_id')
    .eq('id', input.question_id)
    .maybeSingle();

  if (loadError) {
    // Do not leak internals (design: no error path leaks provider internals).
    return errorResponse(
      req,
      500,
      'lookup_failed',
      'The question could not be moderated. Please try again.',
    );
  }
  if (!current) {
    return errorResponse(
      req,
      404,
      'question_not_found',
      'No question was found for the supplied question_id.',
    );
  }

  const previousStatus = current.status as QuestionStatus;
  const eventId = current.event_id as string;

  // 6) Apply the moderation change via the SERVICE-ROLE client (bypasses RLS;
  // authorisation already verified). `updated_at` is refreshed by the DB trigger.
  const { data: updated, error: updateError } = await admin
    .from('questions')
    .update({ status: targetStatus })
    .eq('id', input.question_id)
    .select('id, status')
    .single();

  if (updateError || !updated) {
    return errorResponse(
      req,
      500,
      'moderation_failed',
      'The question could not be moderated. Please try again.',
    );
  }

  // 7) AUDIT (Req 21.19): write one audit_log row per moderation change with
  // `change_type='moderation'` and the question's `event_id`. `occurred_at`
  // defaults to now() (UTC) in the DB. If the audit insert fails we log it
  // server-side but DO NOT fail the request — the moderation change has already
  // been committed and reversing it would be worse than a missing audit row.
  // `audit_written` in the response signals the outcome (mirrors
  // transition-event-status).
  let auditWritten = true;
  const { error: auditError } = await admin.from('audit_log').insert({
    change_type: 'moderation',
    event_id: eventId,
    // occurred_at is DB-defaulted to now() (UTC).
  });
  if (auditError) {
    auditWritten = false;
    // Sanitised server-side log only; no secrets/internals leaked to the client.
    console.error(
      `[moderate-question] audit_log insert failed for question ${input.question_id} ` +
        `(${previousStatus} → ${targetStatus}, event ${eventId}): ${auditError.message}`,
    );
  }

  // 8) Success → 200 with the updated question and the previous status.
  return jsonResponse(
    req,
    {
      question: {
        id: updated.id,
        status: updated.status,
      },
      status: updated.status,
      previous_status: previousStatus,
      audit_written: auditWritten,
    },
    200,
  );
});
