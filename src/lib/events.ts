/**
 * Event create/edit client helper (Task 8.1).
 *
 * This module is the client-side gateway the admin event editor uses to create
 * an event. It validates input with the shared Zod schema for fast, inline
 * feedback, then delegates the authoritative mutation to the authenticated
 * `create-event` Edge Function (task 7.2). The SPA never inserts into `events`
 * directly — RLS denies client inserts (task 5.1); all privileged mutations go
 * through Edge Functions using the caller's admin JWT.
 *
 * Design references:
 *  - Architecture: privileged mutations run in Edge Functions; the browser
 *    calls them with the administrator's Supabase access token.
 *  - Error Handling → Validation errors: "All input is validated with shared
 *    Zod schemas on the client (fast feedback) and again server-side in Edge
 *    Functions / RPCs (authoritative)." The Edge Function returns a structured
 *    error with a per-field `error.fields[]` array (Req 1.2, 22.7).
 *  - Components and Interfaces (event editor).
 *
 * Requirements traceability: 1.1, 1.2, 1.3, 24.7, 25.4.
 */

import { getSession } from './auth';
import { supabase } from './supabaseClient';
import {
  eventCreateInputSchema,
  type EventCreateInput,
} from '../schemas/event';

/**
 * A single per-field validation problem, mirroring the Edge Function's
 * `error.fields[]` contract (see `supabase/functions/_shared/http.ts`) and the
 * flattened output of a client-side Zod validation failure (Req 1.2, 22.7).
 */
export interface EventFieldError {
  /** The invalid field name (e.g. `name`, `ends_at`, `slug`). */
  readonly field: string;
  /** Human-readable description of the constraint that was violated. */
  readonly message: string;
}

/** The subset of the created event echoed back by the Edge Function. */
export interface CreatedEvent {
  readonly id: string;
  readonly slug: string | null;
  readonly status: string;
  readonly created_at: string;
}

/**
 * The success payload returned by the `create-event` Edge Function (201).
 *
 * The presenter token is never returned as a bare field — it is embedded only
 * inside `presenterUrl`. `qrTarget` is the URL a QR code should encode (equal
 * to `audienceUrl`).
 */
export interface CreateEventResult {
  readonly event: CreatedEvent;
  readonly audienceUrl: string;
  readonly presenterUrl: string;
  readonly qrTarget: string;
}

/** Stable, machine-readable classification of an event-create/transition failure. */
export type EventErrorKind =
  /** Client- or server-side field validation failed (400 with fields). */
  | 'validation'
  /** The requested slug/event code is already in use (409). */
  | 'slug_conflict'
  /** No authenticated admin session / rejected token (401). */
  | 'unauthorized'
  /** The target event does not exist (404). */
  | 'not_found'
  /**
   * A requested status transition was rejected as a conflict (409): an
   * illegal transition (skipping states / going backwards), a no-op (target
   * equals the current status), or an attempt to reactivate an archived event
   * (archived is terminal — Req 1.11).
   */
  | 'invalid_transition'
  /** Any other/unexpected failure (network, 5xx, malformed response). */
  | 'unknown';

/**
 * Typed error thrown by {@link createEvent}.
 *
 * Carries a `kind` for branching plus an optional `fields[]` list of per-field
 * messages so the editor can render inline errors beside the relevant inputs
 * while retaining the user's entered values (Req 1.2). The message is always
 * a sanitised, user-safe string (never raw provider/internal detail).
 */
export class EventError extends Error {
  readonly kind: EventErrorKind;
  readonly fields: EventFieldError[];
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      kind: EventErrorKind;
      fields?: EventFieldError[];
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'EventError';
    this.kind = options.kind;
    this.fields = options.fields ?? [];
    this.status = options.status;
    this.cause = options.cause;
  }
}

/** Name of the authenticated event-create Edge Function (task 7.2). */
export const CREATE_EVENT_FUNCTION = 'create-event' as const;

/**
 * Flattens a client-side Zod error into the same per-field shape the Edge
 * Function uses, so the editor renders both identically. Issues with an empty
 * path (e.g. a whole-object refinement) map to a synthetic `_root` field.
 */
function zodIssuesToFieldErrors(
  error: import('zod').ZodError,
): EventFieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }));
}

/**
 * Narrows an unknown value to the Edge Function's structured error body:
 * `{ error: { code, message, fields? } }`.
 */
interface EdgeErrorBody {
  error: {
    code?: string;
    message?: string;
    fields?: EventFieldError[];
  };
}

function isEdgeErrorBody(value: unknown): value is EdgeErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null;
}

function isCreateEventResult(value: unknown): value is CreateEventResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.audienceUrl === 'string' &&
    typeof v.presenterUrl === 'string' &&
    typeof v.qrTarget === 'string' &&
    typeof v.event === 'object' &&
    v.event !== null
  );
}

/**
 * Maps an Edge Function error body + HTTP status to a typed {@link EventError}.
 */
function toEventError(status: number, body: EdgeErrorBody): EventError {
  const code = body.error.code;
  const message =
    body.error.message ?? 'The event could not be created. Please try again.';
  const fields = body.error.fields ?? [];

  if (status === 401 || code === 'unauthorized') {
    return new EventError(
      'Your session has expired. Please sign in again.',
      { kind: 'unauthorized', status },
    );
  }
  if (status === 409 || code === 'slug_conflict') {
    // Surface the conflict on the slug field so the editor can render it inline
    // next to the event-code input (Req 1.2), while keeping a general message.
    return new EventError(message, {
      kind: 'slug_conflict',
      status,
      fields:
        fields.length > 0
          ? fields
          : [{ field: 'slug', message: 'This event code is already in use.' }],
    });
  }
  if (status === 400 || code === 'validation_failed') {
    return new EventError(message, {
      kind: 'validation',
      status,
      fields,
    });
  }
  return new EventError(message, { kind: 'unknown', status });
}

/**
 * Creates an event via the authenticated `create-event` Edge Function.
 *
 * Flow:
 *  1. Validate `input` client-side with {@link eventCreateInputSchema} for fast
 *     inline feedback. On failure, throw an {@link EventError} of kind
 *     `validation` carrying per-field messages — no network call is made.
 *  2. Ensure there is an authenticated admin session (access token). If not,
 *     throw an {@link EventError} of kind `unauthorized` — no network call.
 *  3. Invoke the Edge Function with `supabase.functions.invoke`, which attaches
 *     the caller's `Authorization: Bearer <access_token>` automatically.
 *  4. On success return the parsed 201 payload; on a structured error map it to
 *     a typed {@link EventError} (validation / slug_conflict / unauthorized /
 *     unknown).
 *
 * @throws {EventError} on validation failure, missing session, or any error
 *   returned by (or transport failure invoking) the Edge Function.
 */
export async function createEvent(
  input: EventCreateInput,
): Promise<CreateEventResult> {
  // 1) Client-side validation (fast feedback). The Edge Function re-validates
  //    authoritatively, but this avoids a round-trip for obviously-bad input.
  const parsed = eventCreateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new EventError('One or more fields are invalid.', {
      kind: 'validation',
      fields: zodIssuesToFieldErrors(parsed.error),
    });
  }

  // 2) Require an authenticated admin session. The browser client normally
  //    attaches the token itself, but we assert it explicitly so we can fail
  //    fast with a clear message and avoid an unauthenticated round-trip.
  const session = await getSession();
  if (!session?.access_token) {
    throw new EventError('Your session has expired. Please sign in again.', {
      kind: 'unauthorized',
    });
  }

  // 3) Invoke the Edge Function. `functions.invoke` attaches the current
  //    session's `Authorization: Bearer <access_token>` header automatically.
  const { data, error } = await supabase.functions.invoke(
    CREATE_EVENT_FUNCTION,
    { body: parsed.data },
  );

  // 4a) Transport/non-2xx error surfaced by supabase-js. The structured JSON
  //     error body (with status + `error.fields`) is available on
  //     `FunctionsHttpError.context` (a `Response`); read it when present.
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      let parsedBody: unknown = null;
      try {
        parsedBody = await context.clone().json();
      } catch {
        parsedBody = null;
      }
      if (isEdgeErrorBody(parsedBody)) {
        throw toEventError(context.status, parsedBody);
      }
      // Non-JSON error body — classify by status alone.
      if (context.status === 401) {
        throw new EventError(
          'Your session has expired. Please sign in again.',
          { kind: 'unauthorized', status: context.status, cause: error },
        );
      }
      throw new EventError(
        'The event could not be created. Please try again.',
        { kind: 'unknown', status: context.status, cause: error },
      );
    }
    // No response context (e.g. network failure) — generic unknown error.
    throw new EventError(
      'The event could not be created. Please check your connection and try again.',
      { kind: 'unknown', cause: error },
    );
  }

  // 4b) supabase-js sometimes returns a non-2xx body without throwing; guard by
  //     detecting a structured error body in the success channel too.
  if (isEdgeErrorBody(data)) {
    // We do not know the HTTP status here; classify from the error code.
    const code = data.error.code;
    const status =
      code === 'unauthorized' ? 401 : code === 'slug_conflict' ? 409 : 400;
    throw toEventError(status, data);
  }

  if (!isCreateEventResult(data)) {
    throw new EventError(
      'The event was created but the server response was malformed.',
      { kind: 'unknown', cause: data },
    );
  }

  return data;
}


// =============================================================================
// Event status-transition helper (Task 8.2)
// =============================================================================
//
// The client-side gateway the admin UI uses to move an event through its
// lifecycle (draft → live → ended → archived). Exactly like createEvent, the
// SPA never writes `events.status` directly (RLS denies it); the authoritative
// mutation is delegated to the authenticated `transition-event-status` Edge
// Function (task 7.3), which re-enforces the shared transition contract from
// `./eventStatus`.
//
// Requirements traceability: 1.8 (ending closes participation via status), 1.9,
// 1.11 (archived is terminal), 24.7 (four UX states surfaced by the caller).
// Design references: Components and Interfaces; Error Handling → Conflict /
// Authorization errors; Data Models (`event_status`).

import type { EventStatus } from './eventStatus';

/** Name of the authenticated status-transition Edge Function (task 7.3). */
export const TRANSITION_EVENT_STATUS_FUNCTION = 'transition-event-status' as const;

/**
 * The subset of the event echoed back by the `transition-event-status` Edge
 * Function on success (200): the id plus its new status.
 */
export interface TransitionedEvent {
  readonly id: string;
  readonly status: EventStatus;
}

/**
 * Narrows an unknown value to the transition success payload, which nests the
 * updated event under `event: { id, status }`.
 */
function isTransitionSuccess(
  value: unknown,
): value is { event: TransitionedEvent } {
  if (typeof value !== 'object' || value === null) return false;
  const event = (value as { event?: unknown }).event;
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.status === 'string';
}

/**
 * Maps a `transition-event-status` Edge Function error body + HTTP status to a
 * typed {@link EventError}. Messages are always sanitised, user-safe strings
 * (the Edge Function never leaks internals — Design → Error Handling).
 *
 * The three 409 conflict codes — `no_op_transition`,
 * `archived_not_reactivatable`, and `invalid_transition` — all collapse to the
 * single `invalid_transition` kind, since from the UI's perspective they share
 * the same handling: the transition was refused and the status is unchanged.
 * The archived-terminal case carries a clear, Req-1.11-aligned default message.
 */
function toTransitionError(status: number, body: EdgeErrorBody): EventError {
  const code = body.error.code;
  const message = body.error.message;

  if (status === 401 || code === 'unauthorized') {
    return new EventError('Your session has expired. Please sign in again.', {
      kind: 'unauthorized',
      status,
    });
  }
  if (status === 404 || code === 'event_not_found') {
    return new EventError(
      message ?? 'That event could not be found. It may have been removed.',
      { kind: 'not_found', status },
    );
  }
  if (
    status === 409 ||
    code === 'no_op_transition' ||
    code === 'archived_not_reactivatable' ||
    code === 'invalid_transition'
  ) {
    const fallback =
      code === 'archived_not_reactivatable'
        ? 'This event is archived and cannot be reactivated.'
        : code === 'no_op_transition'
          ? 'The event is already in that status.'
          : 'That status change is not allowed for this event.';
    return new EventError(message ?? fallback, {
      kind: 'invalid_transition',
      status,
    });
  }
  if (status === 400 || code === 'validation_failed' || code === 'invalid_json') {
    return new EventError(message ?? 'The request was invalid.', {
      kind: 'validation',
      status,
      fields: body.error.fields ?? [],
    });
  }
  return new EventError(
    message ?? 'The event status could not be changed. Please try again.',
    { kind: 'unknown', status },
  );
}

/**
 * Transitions an event's status via the authenticated `transition-event-status`
 * Edge Function.
 *
 * Flow (mirrors {@link createEvent}):
 *  1. Require an authenticated admin session (access token). If absent, throw
 *     an {@link EventError} of kind `unauthorized` — no network call is made.
 *  2. Invoke the Edge Function with `supabase.functions.invoke`, which attaches
 *     the caller's `Authorization: Bearer <access_token>` automatically.
 *  3. On success return the updated `{ id, status }`; on a structured error map
 *     it to a typed {@link EventError} (unauthorized / not_found /
 *     invalid_transition / validation / unknown).
 *
 * @param eventId The id of the event to transition.
 * @param targetStatus The status to move the event to (`live` | `ended` |
 *   `archived`). Only forward transitions are accepted by the server.
 * @throws {EventError} on a missing session or any error returned by (or
 *   transport failure invoking) the Edge Function.
 */
export async function transitionEventStatus(
  eventId: string,
  targetStatus: EventStatus,
): Promise<TransitionedEvent> {
  // 1) Require an authenticated admin session; fail fast with a clear message
  //    and avoid an unauthenticated round-trip (Design → Authorization errors).
  const session = await getSession();
  if (!session?.access_token) {
    throw new EventError('Your session has expired. Please sign in again.', {
      kind: 'unauthorized',
    });
  }

  // 2) Invoke the Edge Function. `functions.invoke` attaches the current
  //    session's `Authorization: Bearer <access_token>` header automatically.
  const { data, error } = await supabase.functions.invoke(
    TRANSITION_EVENT_STATUS_FUNCTION,
    { body: { event_id: eventId, target_status: targetStatus } },
  );

  // 3a) Transport/non-2xx error surfaced by supabase-js. The structured JSON
  //     error body is available on `FunctionsHttpError.context` (a `Response`).
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      let parsedBody: unknown = null;
      try {
        parsedBody = await context.clone().json();
      } catch {
        parsedBody = null;
      }
      if (isEdgeErrorBody(parsedBody)) {
        throw toTransitionError(context.status, parsedBody);
      }
      if (context.status === 401) {
        throw new EventError(
          'Your session has expired. Please sign in again.',
          { kind: 'unauthorized', status: context.status, cause: error },
        );
      }
      throw new EventError(
        'The event status could not be changed. Please try again.',
        { kind: 'unknown', status: context.status, cause: error },
      );
    }
    // No response context (e.g. network failure) — generic unknown error.
    throw new EventError(
      'The event status could not be changed. Please check your connection and try again.',
      { kind: 'unknown', cause: error },
    );
  }

  // 3b) supabase-js sometimes returns a non-2xx body without throwing; guard by
  //     detecting a structured error body in the success channel too.
  if (isEdgeErrorBody(data)) {
    const code = data.error.code;
    const status =
      code === 'unauthorized'
        ? 401
        : code === 'event_not_found'
          ? 404
          : code === 'no_op_transition' ||
              code === 'archived_not_reactivatable' ||
              code === 'invalid_transition'
            ? 409
            : 400;
    throw toTransitionError(status, data);
  }

  if (!isTransitionSuccess(data)) {
    throw new EventError(
      'The event status may have changed but the server response was malformed.',
      { kind: 'unknown', cause: data },
    );
  }

  return data.event;
}
