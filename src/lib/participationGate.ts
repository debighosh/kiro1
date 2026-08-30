/**
 * Participation gate — pure, importable predicate for event-status gating.
 *
 * This module encodes the Milestone-1 groundwork for **Property 11:
 * Event-status gating of participation**. It mirrors the rule the database
 * enforces authoritatively via Row Level Security:
 *
 *   - `events` anonymous SELECT policy: allowed only WHERE `status = 'live'`
 *     (draft/ended/archived are hidden from anonymous readers).
 *   - The `event_is_live(event_id)` SQL helper (task 4.6), which returns true
 *     when the parent event's `status = 'live'` and is reused across the
 *     anonymous RLS policies.
 *
 * The DATABASE is the authoritative enforcement point (the live-RLS integration
 * tests in `src/db/rls.events.test.ts` exercise the actual DB behaviour in CI).
 * This pure predicate is the shared, unit-/property-testable *contract* used by
 * the audience UI to decide whether to show or withhold participation controls
 * (Req 2.8), keeping the client-side gate in lock-step with the DB rule.
 *
 * NOTE: `EventStatus` is intentionally defined locally here (rather than
 * imported from `./eventStatus`, which is authored by a concurrent task) to keep
 * this module self-contained and avoid a cross-task import race. The union must
 * stay in sync with the `event_status` enum: 'draft' | 'live' | 'ended' |
 * 'archived'.
 *
 * NOTE: This module can be re-exported from the `./index` barrel later; it is
 * deliberately NOT added to the barrel in this task to avoid a write conflict
 * with the concurrent task that also edits `src/lib/index.ts`.
 *
 * Requirements: 1.6, 1.7, 1.9, 2.8 (Property 11)
 * Design: Correctness Properties (Property 11); RLS Design (`events`)
 */

/**
 * The four event lifecycle statuses, matching the PostgreSQL `event_status`
 * enum. Defined locally (see module header) to keep this file self-contained.
 */
export type EventStatus = 'draft' | 'live' | 'ended' | 'archived';

/**
 * Returns `true` iff the event is participation-eligible — i.e. visible/joinable
 * to anonymous participants and eligible for participation writes — which is the
 * case exactly when its status is `'live'`.
 *
 * This is the client-side mirror of the events anonymous RLS policy
 * (`status = 'live'`) and the `event_is_live` SQL helper. The database remains
 * the authoritative enforcement; this predicate exists so the audience UI can
 * consistently show or withhold participation controls (Req 2.8).
 */
export function isParticipationEligible(status: EventStatus): boolean {
  return status === 'live';
}
