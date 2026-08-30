/**
 * Event-status lifecycle: the SHARED, framework-agnostic transition contract.
 *
 * =============================================================================
 * SHARED CONTRACT — SINGLE SOURCE OF TRUTH
 * =============================================================================
 * This pure module is the canonical definition of the event-status state
 * machine. It has NO dependencies (no React, no zod, no Deno globals) so it can
 * be imported by the SPA and exercised directly by Vitest.
 *
 * The Supabase Edge Function `supabase/functions/transition-event-status`
 * enforces the SAME rules server-side (it is the authoritative path — the SPA
 * never writes `events.status` directly; RLS denies client writes). Because
 * Deno cannot import this `src/` path directly, that Edge Function currently
 * RE-DECLARES the identical `ALLOWED_TRANSITIONS` table and decision logic.
 * These two definitions MUST be kept identical: if you change a rule here,
 * change it there too (and vice-versa).
 *
 * The lifecycle (Req 1.5, 1.8, 1.10, 1.11):
 *   draft → live      (open a prepared event for participation, Req 1.5→1.7)
 *   live  → ended      (close participation, Req 1.8)
 *   ended → archived  (retain for reporting, Req 1.10)
 *
 * Every other pair is rejected leaving the status unchanged. Skipping states
 * (draft → ended, live → archived), going backwards (ended → live, live →
 * draft), and reactivating an archived event (archived → anything, Req 1.11)
 * are all disallowed. `archived` is terminal.
 *
 * Requirements traceability: 1.5, 1.8, 1.10, 1.11.
 * Design references: Architecture (privileged mutation Edge Functions); Data
 * Models (`events`); Error Handling (Conflict errors).
 */

/** Event lifecycle statuses (mirrors the DB `event_status` enum). */
export type EventStatus = 'draft' | 'live' | 'ended' | 'archived';

/** All event statuses, in lifecycle order. */
export const EVENT_STATUSES: readonly EventStatus[] = [
  'draft',
  'live',
  'ended',
  'archived',
] as const;

/**
 * The allowed forward transitions. Each status maps to the set of statuses it
 * may transition INTO. `archived` maps to the empty set because it is terminal
 * (archived events cannot be reactivated in V1 — Req 1.11).
 *
 * This table is the shared contract; the Edge Function re-declares an identical
 * table (see the module header).
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<EventStatus, readonly EventStatus[]>
> = {
  draft: ['live'],
  live: ['ended'],
  ended: ['archived'],
  archived: [], // terminal — archived events cannot be reactivated in V1 (Req 1.11)
} as const;

/**
 * Whether V1 permits reactivating an archived event. Always `false`: `archived`
 * is a terminal state (Req 1.11).
 */
export const CAN_REACTIVATE_ARCHIVED = false as const;

/**
 * Returns `true` iff moving from `from` to `to` is an allowed lifecycle
 * transition. A no-op (`from === to`) is NOT an allowed transition (it is a
 * conflict — see {@link classifyTransition}).
 */
export function isAllowedTransition(from: EventStatus, to: EventStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The classification of a requested transition, mirroring the Edge Function's
 * decision branches:
 *
 *  - `allowed`                    — a valid forward transition; apply it.
 *  - `no_op`                      — target equals current status; rejected as a
 *                                   conflict so intent stays explicit and the
 *                                   single audit entry per real transition stays
 *                                   meaningful (Req 1.8/1.10 semantics, 21.19).
 *  - `archived_not_reactivatable` — current status is `archived`; rejected
 *                                   because archived is terminal (Req 1.11).
 *  - `invalid`                    — any other disallowed transition (skipping
 *                                   states or going backwards).
 */
export type TransitionClassification =
  | 'allowed'
  | 'no_op'
  | 'archived_not_reactivatable'
  | 'invalid';

/**
 * Classifies a requested transition using the SAME ordered decision branches as
 * the `transition-event-status` Edge Function:
 *
 *   1. `from === to`            → `no_op`
 *   2. `from === 'archived'`    → `archived_not_reactivatable`
 *   3. `isAllowedTransition`    → `allowed`
 *   4. otherwise               → `invalid`
 *
 * The ordering matters: a no-op is reported ahead of the archived check so that
 * `archived → archived` is classified as `no_op` (it is asking for the status it
 * already holds), matching the Edge Function's 5a-before-5b ordering.
 */
export function classifyTransition(
  from: EventStatus,
  to: EventStatus,
): TransitionClassification {
  if (from === to) {
    return 'no_op';
  }
  if (from === 'archived') {
    return 'archived_not_reactivatable';
  }
  if (isAllowedTransition(from, to)) {
    return 'allowed';
  }
  return 'invalid';
}
