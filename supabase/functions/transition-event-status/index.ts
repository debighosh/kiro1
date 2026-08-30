// =============================================================================
// EDGE FUNCTION: transition-event-status — event lifecycle transitions (Deno)
// =============================================================================
//
// Privileged mutation Edge Function that advances an `events` row through its
// lifecycle status on behalf of an authenticated administrator. This is the
// authoritative, server-side status-transition path: the SPA never updates
// `events.status` directly (RLS denies client writes — task 5.1). The browser
// calls this function with the administrator's Supabase access token in the
// `Authorization: Bearer <jwt>` header.
//
// Behaviour (task 7.3):
//   1. Handle the CORS preflight; accept POST only (else 405).
//   2. Verify the caller carries a valid authenticated admin JWT — exactly like
//      create-event (task 7.2). Missing/invalid → 401 and NO change made
//      (Req 10.1, 21.6). For V1 any authenticated user is an admin (Req 10.3).
//   3. Validate the JSON body { event_id: uuid, target_status:
//      'live'|'ended'|'archived' } with zod. A transition never targets 'draft'
//      (draft is the creation state — Req 1.5), so 'draft' is not a valid target.
//      Invalid input → 400 with a structured, per-field error (Req 1.2), no change.
//   4. Load the current event by id via the SERVICE-ROLE client. Not found → 404.
//   5. Enforce the lifecycle state machine (Req 1.5, 1.8, 1.10, 1.11):
//        Allowed: draft → live, live → ended, ended → archived.
//        Everything else is rejected with a 409 and NO change is made. In
//        particular, reactivating an archived event (archived → anything) is
//        rejected with the V1 message that archived events cannot be reactivated
//        (Req 1.11). A no-op (target == current) is likewise rejected with a
//        clear "already in status X" message — see NO_OP note below.
//   6. On a valid transition:
//        - Update `events.status` to `target_status` via the service-role client.
//          `updated_at` is refreshed by the DB trigger (task 4.2).
//        - When target == 'ended', participation is closed by the event's own
//          status; see the ENDED note below (Req 1.8).
//        - When target == 'archived', immutability is enforced by rejecting any
//          further transition; see the ARCHIVED note below (Req 1.10, 1.11).
//        - Insert an `audit_log` row { change_type: 'event_status', event_id }
//          for each successful transition (Req 21.19). A failed audit insert is
//          logged server-side but does NOT fail the status change — see the
//          AUDIT note below.
//   7. On success respond 200 with the updated event { id, status } and the new
//      status. No error path leaks internals; only sanitised messages.
//
// CORS: the SPA calls this cross-origin, so an `OPTIONS` preflight is handled and
// every response carries CORS headers (see `_shared/cors.ts`).
//
// This is Deno / Supabase Edge Function code. It uses `Deno.*` globals and
// `npm:` / `jsr:` / relative Deno import specifiers, and is intentionally
// excluded from the SPA `tsc -b` typecheck and ESLint run (`supabase/functions`
// is ignored), so it does not affect `npm run build` / `npm run lint`.
//
// Requirements traceability: 1.5, 1.8, 1.9, 1.10, 1.11, 10.1, 21.6, 21.19.
// Design references: Architecture (Edge Functions — privileged mutations,
// event-status transitions with the service role behind a JWT check); Data
// Models (`events`, `audit_log`); Error Handling (Validation / Authorization /
// Conflict errors).
// =============================================================================

import { z } from 'npm:zod@4';
import { createClient } from 'jsr:@supabase/supabase-js@2';

import { getAdminClient } from '../_shared/supabaseAdmin.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';
import { errorResponse, type FieldError, jsonResponse } from '../_shared/http.ts';

// -----------------------------------------------------------------------------
// Validation contract for the status-transition input.
//
// A transition body identifies the event by id and the status to move it to.
// `target_status` deliberately EXCLUDES 'draft': draft is the status assigned at
// creation (Req 1.5) and is never a transition target. The full event_status
// enum is ('draft','live','ended','archived'); the reachable transition targets
// are the latter three.
// -----------------------------------------------------------------------------

/** Event lifecycle statuses (mirrors the DB `event_status` enum). */
const EVENT_STATUSES = ['draft', 'live', 'ended', 'archived'] as const;
type EventStatus = (typeof EVENT_STATUSES)[number];

/** Statuses a transition may target (never 'draft' — Req 1.5). */
const TARGET_STATUSES = ['live', 'ended', 'archived'] as const;

const eventIdSchema = z.string().uuid({
  message: 'event_id must be a valid UUID.',
});

const targetStatusSchema = z.enum(TARGET_STATUSES, {
  message: "target_status must be one of 'live', 'ended', or 'archived'.",
});

const transitionInputSchema = z.object({
  event_id: eventIdSchema,
  target_status: targetStatusSchema,
});

type TransitionInput = z.infer<typeof transitionInputSchema>;

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
// Lifecycle state machine (Req 1.5, 1.8, 1.10, 1.11).
//
// The ONLY forward transitions are:
//   draft → live      (open a prepared event for participation, Req 1.5→1.7)
//   live  → ended      (close participation, Req 1.8)
//   ended → archived  (retain for reporting, Req 1.10)
//
// Every other pair is disallowed and must be rejected leaving the status
// unchanged. Skipping states (draft → ended, live → archived), going backwards
// (ended → live, live → draft), and reactivating an archived event
// (archived → anything, Req 1.11) are all rejected.
// -----------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ['live'],
  live: ['ended'],
  ended: ['archived'],
  archived: [], // terminal — archived events cannot be reactivated in V1 (Req 1.11)
};

function isAllowedTransition(from: EventStatus, to: EventStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// -----------------------------------------------------------------------------
// Admin JWT verification (Req 10.1, 21.6) — identical approach to create-event.
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

  // Only POST transitions an event.
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
      'Authentication is required to change an event status.',
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

  // 3) Validate against the transition contract (Req 1.2). Invalid → 400, no change.
  const parsed = transitionInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      req,
      400,
      'validation_failed',
      'One or more fields are invalid.',
      toFieldErrors(parsed.error),
    );
  }
  const input: TransitionInput = parsed.data;
  const targetStatus = input.target_status as EventStatus;

  const admin = getAdminClient();

  // 4) Load the current event via the SERVICE-ROLE client. Not found → 404.
  const { data: current, error: loadError } = await admin
    .from('events')
    .select('id, status')
    .eq('id', input.event_id)
    .maybeSingle();

  if (loadError) {
    // Do not leak internals (design: no error path leaks provider internals).
    return errorResponse(
      req,
      500,
      'lookup_failed',
      'The event status could not be changed. Please try again.',
    );
  }
  if (!current) {
    return errorResponse(
      req,
      404,
      'event_not_found',
      'No event was found for the supplied event_id.',
    );
  }

  const currentStatus = current.status as EventStatus;

  // 5) Enforce the state machine (Req 1.5, 1.8, 1.10, 1.11). No change on reject.

  // 5a) NO_OP: target == current. DECISION — we REJECT no-ops with a 409 and a
  // clear "already in status X" message rather than silently returning success.
  // This keeps transitions explicit: a client asking to move to a status the
  // event already holds is treated as a conflict so the intent is unambiguous
  // and the (single) audit entry per real transition stays meaningful (Req 21.19).
  if (targetStatus === currentStatus) {
    return errorResponse(
      req,
      409,
      'no_op_transition',
      `The event is already in status "${currentStatus}".`,
    );
  }

  // 5b) Reactivating an archived event is explicitly rejected in V1 (Req 1.11).
  // Handled ahead of the generic check so we can return the required message.
  if (currentStatus === 'archived') {
    return errorResponse(
      req,
      409,
      'archived_not_reactivatable',
      'Archived events cannot be reactivated in V1.',
    );
  }

  // 5c) Any other disallowed transition (skipping/backwards) → 409, no change.
  if (!isAllowedTransition(currentStatus, targetStatus)) {
    return errorResponse(
      req,
      409,
      'invalid_transition',
      `An event cannot transition from "${currentStatus}" to "${targetStatus}". ` +
        'Allowed transitions are draft → live, live → ended, and ended → archived.',
    );
  }

  // 6) Apply the valid transition via the SERVICE-ROLE client (bypasses RLS;
  // authorisation already verified). `updated_at` is refreshed by the DB trigger.
  //
  // ENDED note (Req 1.8): ending an event must close question submission,
  // voting, poll responses, and word-cloud responses. For Milestone 1 those
  // child tables do not exist yet; participation is gated on the event's own
  // status. The questions/votes/polls/word-cloud tables (Milestones 2–3) and
  // their anon RLS policies close participation based on event status (see the
  // `event_is_live` helper, task 4.6), so setting status = 'ended' is what
  // closes participation now — no child-table writes are needed here.
  //
  // ARCHIVED note (Req 1.10, 1.11): once archived the event becomes immutable
  // for reporting. Immutability is enforced by rejecting any further transition
  // (handled in 5a/5b above — archived is terminal). create-event does not edit
  // existing events; a future event-edit endpoint must likewise refuse to modify
  // an event whose status is 'archived'.
  const { data: updated, error: updateError } = await admin
    .from('events')
    .update({ status: targetStatus })
    .eq('id', input.event_id)
    .select('id, status')
    .single();

  if (updateError || !updated) {
    return errorResponse(
      req,
      500,
      'transition_failed',
      'The event status could not be changed. Please try again.',
    );
  }

  // 6b) AUDIT note (Req 21.19): write one audit_log row per successful
  // transition. `occurred_at` defaults to now() (UTC) in the DB. If the audit
  // insert fails we log it server-side but DO NOT fail the request — the status
  // change has already been committed and reversing it would be worse than a
  // missing audit row. `audit_written` in the response signals the outcome.
  let auditWritten = true;
  const { error: auditError } = await admin.from('audit_log').insert({
    change_type: 'event_status',
    event_id: input.event_id,
    // occurred_at is DB-defaulted to now() (UTC).
  });
  if (auditError) {
    auditWritten = false;
    // Sanitised server-side log only; no secrets/internals leaked to the client.
    console.error(
      `[transition-event-status] audit_log insert failed for event ${input.event_id} ` +
        `(${currentStatus} → ${targetStatus}): ${auditError.message}`,
    );
  }

  // 7) Success → 200 with the updated event and the new status.
  return jsonResponse(
    req,
    {
      event: {
        id: updated.id,
        status: updated.status,
      },
      status: updated.status,
      previous_status: currentStatus,
      audit_written: auditWritten,
    },
    200,
  );
});
