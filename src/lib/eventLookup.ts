/**
 * Anonymous event lookup helper (Task 14.3).
 *
 * The audience/landing join flow needs to resolve an event from a
 * human-entered Event_Code (slug) or from the `:eventRef` route param (which
 * may be a slug or a raw event id). This module is the single, typed gateway
 * the landing screen and the `/join/:eventRef` flow use to perform that
 * resolution through the anonymous Supabase browser client.
 *
 * Security / visibility invariant (Design → Request/data flows → "Audience
 * join"; RLS Design → `events`): the anon client can ONLY read an `events` row
 * while its `status = 'live'` (task 5.1 RLS). Consequently, for anonymous
 * participants this helper resolves ONLY live events — draft/ended/archived
 * events are invisible and therefore return `null`. That is the expected,
 * by-design behaviour: an unknown OR not-yet-live code is indistinguishable to
 * an anonymous visitor, and both correctly surface as "not found" on the
 * landing page (Req 2.2) or as a friendly unavailable state on the join screen.
 *
 * Only the minimal PUBLIC fields are selected (`id`, `name`, `slug`,
 * `status`); no `presenter_token` or other sensitive column is ever requested
 * by the browser.
 *
 * Requirements traceability: 2.1, 2.2 (join by code / invalid-code handling),
 * 1.6/1.7/1.9 (status-gated visibility via RLS).
 * Design: Frontend Design (Route map — `/`, `/join/:eventRef`); Request/data
 * flows (Audience join).
 */

import { supabase } from './supabaseClient';
import type { EventStatus } from './eventStatus';
import type { PresenterMode } from './presenter';

/**
 * The minimal, public projection of an event returned to anonymous
 * participants. Deliberately excludes every sensitive/admin-only column
 * (notably `presenter_token`).
 */
export interface PublicEvent {
  readonly id: string;
  readonly name: string;
  /** The human-enterable Event_Code; may be null if the event has no slug. */
  readonly slug: string | null;
  readonly status: EventStatus;
  /**
   * The event's currently-selected presenter display mode (Req 7.4, 7.5).
   *
   * This is a NON-SENSITIVE field the moderator sets and the presenter view
   * reflects. It is optional here so existing callers (the landing/join/event
   * screens) that predate task 17.1 continue to work unchanged — they simply
   * ignore it. The presenter view (task 17.1) reads it to decide which mode to
   * render. When the column is absent from a row (older projection) it is left
   * `undefined` and the presenter falls back to the waiting screen.
   */
  readonly active_presenter_mode?: PresenterMode;
}

/**
 * The columns the anon client requests — kept in one place and minimal.
 *
 * `active_presenter_mode` is additive (task 17.1): it is non-sensitive and the
 * anon RLS policy already only returns live events, so selecting it here is
 * safe and lets the presenter view resolve the mode in the same round-trip.
 */
const PUBLIC_EVENT_COLUMNS =
  'id, name, slug, status, active_presenter_mode' as const;

/**
 * Type guard narrowing an untyped Supabase row to {@link PublicEvent}. Guards
 * against a malformed/partial row so callers always get a well-typed value or
 * `null` (never a half-populated object).
 */
function isPublicEvent(value: unknown): value is PublicEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.slug === null || typeof v.slug === 'string') &&
    typeof v.status === 'string' &&
    // active_presenter_mode is additive/optional: accept when absent, null, or
    // a string (its precise membership is validated by the presenter helper).
    (v.active_presenter_mode === undefined ||
      v.active_presenter_mode === null ||
      typeof v.active_presenter_mode === 'string')
  );
}

/**
 * Loose UUID v4-ish shape check. Used only to decide whether a `ref` is worth
 * trying as an `id` lookup (so we do not send obviously-non-uuid values, e.g.
 * a slug, into an `id = ...` filter where the DB would raise a type error).
 * This is NOT a security check — resolution is authoritatively gated by RLS.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves an event by an opaque reference that is EITHER a slug (Event_Code)
 * OR a raw event id, using the anonymous browser client.
 *
 * Behaviour:
 *  - Trims the input; an empty/whitespace-only ref resolves to `null` without a
 *    network call.
 *  - Looks up by `slug` first (the common case: a human-entered code or the
 *    slug embedded in an audience URL). If the ref also looks like a UUID and
 *    the slug lookup found nothing, it falls back to an `id` lookup so a direct
 *    `/join/<uuid>` link still resolves.
 *  - Returns the minimal {@link PublicEvent} projection when a row is visible to
 *    the anon client (i.e. the event is live), or `null` when no row is
 *    visible — whether because the code is unknown OR the event is not live.
 *    Callers treat both cases identically (Req 2.2).
 *
 * This function never throws for a "not found"; it only returns `null`. A
 * genuine transport/query error is swallowed to `null` as well, so the UI
 * uniformly shows the invalid/not-found state rather than leaking internals —
 * callers that need to distinguish a network failure can layer that on later,
 * but Req 2.2's contract is simply "unknown code → invalid".
 *
 * @param ref A slug (Event_Code) or an event id. Case is preserved; slug
 *   matching is case-insensitive at the DB level (the `slug` column is
 *   `citext`).
 * @returns The public event, or `null` if none is resolvable/visible.
 */
export async function findEventByRef(
  ref: string | null | undefined,
): Promise<PublicEvent | null> {
  const trimmed = ref?.trim() ?? '';
  if (trimmed.length === 0) return null;

  // 1) Primary lookup by slug (Event_Code / URL segment). `maybeSingle()`
  //    returns `null` data (not an error) when zero rows match, which is the
  //    normal "not found / not live" path.
  const bySlug = await supabase
    .from('events')
    .select(PUBLIC_EVENT_COLUMNS)
    .eq('slug', trimmed)
    .maybeSingle();

  if (!bySlug.error && isPublicEvent(bySlug.data)) {
    return bySlug.data;
  }

  // 2) Fallback: if the ref looks like a UUID, try an id lookup so a direct
  //    `/join/<id>` link (or QR encoding the id) still resolves.
  if (UUID_PATTERN.test(trimmed)) {
    const byId = await supabase
      .from('events')
      .select(PUBLIC_EVENT_COLUMNS)
      .eq('id', trimmed)
      .maybeSingle();

    if (!byId.error && isPublicEvent(byId.data)) {
      return byId.data;
    }
  }

  // Nothing visible to the anon client: unknown code, or the event is not live.
  return null;
}
