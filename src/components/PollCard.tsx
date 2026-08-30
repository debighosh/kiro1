/**
 * `PollCard` — audience single-choice poll RESPONSE surface (Task 23.1).
 *
 * A mobile-first, accessible component that renders the current OPEN poll's
 * options for a LIVE event and lets a Participant submit — and later change —
 * their single-choice response. It delegates the authoritative read/write to
 * the `../lib/polls` client helpers:
 *   - {@link readActivePoll} — the RLS-gated anon read (never selects
 *     `participant_identifier`; a `draft` poll is never returned to anon).
 *   - {@link submitPollResponse} — the atomic, rate-limited, upsert-replace
 *     `SECURITY DEFINER` respond RPC (task 21.3) enforcing the
 *     one-response-per-participant-per-poll rule and poll-status/event gating.
 *
 * Single-choice selection & change-of-choice (Req 5.7, 5.8): the options render
 * as accessible radio-style buttons. Tapping one optimistically records the
 * local selection and calls {@link submitPollResponse}; picking a DIFFERENT
 * option replaces the prior selection (the server performs the atomic
 * upsert-replace). On a server rejection the optimistic selection is rolled
 * back and a sanitised message is announced.
 *
 * Response controls are WITHHELD (Req 2.8, 5.9, 5.10) when:
 *   - the event is not live — gated via {@link isParticipationEligible} from
 *     `../lib/participationGate` (the shared Property-11 event-live predicate);
 *   - the poll status is not `open` (a `draft` poll is not yet open — Req 5.10;
 *     a `closed` poll no longer accepts responses — Req 5.9).
 * In those cases the card shows an informative, read-only state instead of the
 * response buttons.
 *
 * Four UX states (Req 24.7):
 *  - **loading**: a polite progress indicator while the poll read runs.
 *  - **empty**: a friendly "no poll right now" message when there is no active
 *    poll (or the active poll is not currently open for responses).
 *  - **list**: the poll question + options with single-choice response controls
 *    (when eligible) or a read-only closed/not-live notice (when withheld).
 *  - **error**: a sanitised message (announced via `role="alert"`) when the
 *    read fails, with a retry affordance.
 *
 * Accessibility (Req 24.5): the options are a labelled `radiogroup`; each option
 * is a button exposing `aria-checked`/`aria-pressed`, meets the ≥44×44px touch
 * target (`.touch-target`), and response feedback is announced via an
 * `aria-live` status region. Mirrors the conventions in
 * {@link QuestionListAndVoting} / {@link QuestionSubmissionForm}.
 *
 * Security note: UI gating is defence-in-depth only; the server (RLS + the
 * `SECURITY DEFINER` respond RPC with rate limiting) is the authoritative
 * enforcement point. The participant identifier is opaque and is NEVER rendered
 * (Req 8.6, 24.8) — this component never receives, stores, or displays it.
 *
 * SCOPE: this is the RESPONSE surface only. Results rendering (Recharts,
 * visibility-aware, realtime) is task 23.2 — see the clearly-marked mount point
 * below.
 *
 * Requirements traceability: 5.7, 5.9, 5.10, 8.6, 24.7, 2.8.
 * Design references: Components (`PollCard`); Request/data flows (Poll
 * lifecycle).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import {
  readActivePoll,
  submitPollResponse,
  PollError,
  type PollWithOptions,
} from '../lib/polls';
import { isParticipationEligible } from '../lib/participationGate';
import type { EventStatus } from '../lib/eventStatus';

/** The card's load state driving the four UX states (Req 24.7). */
type CardState = 'loading' | 'empty' | 'list' | 'error';

export interface PollCardProps {
  /** The id of the event whose active poll to read and respond to. */
  readonly eventId: string;
  /**
   * The current lifecycle status of the event. Response controls are withheld
   * unless the event is live (Req 2.8); the shared
   * {@link isParticipationEligible} predicate is the client mirror of the
   * events RLS rule.
   */
  readonly eventStatus: EventStatus;
  /**
   * Optional monotonically-increasing signal (mirrors
   * `QuestionListAndVoting.refreshSignal`). When it changes, the card re-reads
   * the active poll. The audience event view (task 23.5) increments this on
   * each realtime poll update so the displayed poll stays current within the
   * 2-second target (Req 23.1) without this component needing a direct
   * realtime/Supabase dependency. Omitting it preserves mount-only behaviour.
   */
  readonly refreshSignal?: number;
}

/**
 * Maps a caught error to a sanitised, user-facing message. Known
 * {@link PollError}s already carry a safe message; anything else falls back to
 * a neutral message that never leaks internals (Req 24.7).
 */
function toDisplayMessage(error: unknown): string {
  if (error instanceof PollError) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

export function PollCard({
  eventId,
  eventStatus,
  refreshSignal = 0,
}: PollCardProps): JSX.Element {
  const groupLabelId = useId();
  const statusId = useId();

  const [state, setState] = useState<CardState>('loading');
  const [poll, setPoll] = useState<PollWithOptions | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Which option THIS participant currently has selected (UX state only; the DB
  // unique constraint + upsert-replace RPC are the authoritative one-response
  // rule). `null` until the participant picks (or after a rollback).
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  // True while a response submit is in flight, so the controls can disable+busy.
  const [pending, setPending] = useState(false);
  // A transient, sanitised message announced after a response (Req 24.7).
  const [responseMessage, setResponseMessage] = useState<string | null>(null);

  /** Loads (or reloads) the current active poll (Req 5.7, 24.7). */
  const load = useCallback(async (): Promise<void> => {
    if (!eventId) {
      setPoll(null);
      setState('empty');
      return;
    }
    setState('loading');
    setErrorMessage(null);
    try {
      const active = await readActivePoll(eventId);
      setPoll(active);
      setState(active === null ? 'empty' : 'list');
    } catch (error) {
      setErrorMessage(toDisplayMessage(error));
      setState('error');
    }
  }, [eventId]);

  // Initial load + reload whenever the event or the external `refreshSignal`
  // (task 23.5 realtime nudge) changes.
  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  // Whether the event is live (client mirror of the events RLS rule, Req 2.8).
  const eventLive = isParticipationEligible(eventStatus);
  // Whether the current poll is open for responses (Req 5.9 closed / 5.10 draft).
  const pollOpen = poll?.status === 'open';
  // Response controls are shown only when BOTH gates pass (Req 2.8, 5.9, 5.10).
  const canRespond = eventLive && pollOpen;

  /**
   * Records / changes the participant's single-choice response. Optimistically
   * sets the local selection, calls the upsert-replace RPC, and rolls back on a
   * server rejection (announcing a sanitised message). The server + DB unique
   * constraint remain authoritative (Req 5.7, 5.8).
   */
  const handleSelect = useCallback(
    async (optionId: string): Promise<void> => {
      if (!poll || pending) return; // ignore re-taps while in flight
      if (optionId === selectedOptionId) return; // no-op: already selected

      const previousSelection = selectedOptionId;
      setPending(true);
      setResponseMessage(null);
      // Optimistic selection.
      setSelectedOptionId(optionId);

      try {
        await submitPollResponse(poll.id, optionId);
        setResponseMessage('Your response was recorded.');
      } catch (error) {
        // Roll back to the prior selection on rejection.
        setSelectedOptionId(previousSelection);
        setResponseMessage(toDisplayMessage(error));
      } finally {
        setPending(false);
      }
    },
    [poll, pending, selectedOptionId],
  );

  return (
    <section
      aria-label="Poll"
      className="flex flex-col gap-4"
      data-testid="poll-card"
    >
      <h3 className="text-base font-semibold text-ink">Live poll</h3>

      {/* Transient response feedback announced to AT (Req 24.5, 24.7). */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className="text-sm text-ink-muted"
      >
        {responseMessage}
      </p>

      {/* Loading state (Req 24.7). */}
      {state === 'loading' ? (
        <p role="status" aria-live="polite" className="text-ink-muted">
          Loading the poll…
        </p>
      ) : null}

      {/* Error state (Req 24.7): sanitised message + retry. */}
      {state === 'error' ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-ink">
            {errorMessage ?? 'The poll could not be loaded.'}
          </p>
          <button
            type="button"
            onClick={() => {
              void load();
            }}
            className="touch-target self-start rounded border border-ink-muted px-4 py-2 font-medium text-ink"
          >
            Try again
          </button>
        </div>
      ) : null}

      {/* Empty state (Req 24.7): no active poll right now. */}
      {state === 'empty' ? (
        <p className="text-ink-muted" data-testid="poll-card-empty">
          There's no poll running right now. Check back soon!
        </p>
      ) : null}

      {/* List state (Req 5.7): the poll question + single-choice options. */}
      {state === 'list' && poll ? (
        <div className="flex flex-col gap-3">
          <p
            id={groupLabelId}
            className="whitespace-pre-wrap break-words text-ink"
            data-testid="poll-question"
          >
            {poll.question_text}
          </p>

          {canRespond ? (
            <div
              role="radiogroup"
              aria-labelledby={groupLabelId}
              aria-busy={pending}
              className="flex flex-col gap-2"
              data-testid="poll-options"
            >
              {poll.options.map((option) => {
                const selected = option.id === selectedOptionId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-pressed={selected}
                    disabled={pending}
                    aria-busy={pending && selected}
                    onClick={() => {
                      void handleSelect(option.id);
                    }}
                    className={`touch-target flex items-center gap-3 rounded-lg px-4 py-3 text-left font-medium disabled:opacity-60 ${
                      selected
                        ? 'bg-focus text-surface'
                        : 'border border-ink-muted/40 text-ink'
                    }`}
                    data-testid="poll-option"
                  >
                    <span aria-hidden="true">{selected ? '●' : '○'}</span>
                    <span className="flex-1 whitespace-pre-wrap break-words">
                      {option.text}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            /* Controls withheld (Req 2.8, 5.9, 5.10): read-only notice. The
               options are still listed (non-interactive) so the audience can
               see what the poll asked. */
            <div className="flex flex-col gap-2" data-testid="poll-controls-withheld">
              <p role="status" className="text-ink-muted">
                {!eventLive
                  ? 'This event is not currently live, so poll responses are closed.'
                  : poll.status === 'closed'
                    ? 'This poll is closed. Responses are no longer accepted.'
                    : 'This poll is not open for responses yet.'}
              </p>
              <ul className="flex flex-col gap-2" data-testid="poll-options-readonly">
                {poll.options.map((option) => (
                  <li
                    key={option.id}
                    className="flex items-center gap-3 rounded-lg border border-ink-muted/40 px-4 py-3 text-ink"
                  >
                    <span aria-hidden="true">○</span>
                    <span className="flex-1 whitespace-pre-wrap break-words">
                      {option.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/*
            ────────────────────────────────────────────────────────────────
            RESULTS MOUNT POINT — Task 23.2 (visibility-aware poll results).

            Task 23.2 will render the poll's results here (Recharts, ARIA-
            labelled, non-colour encodings) subscribed to the event-scoped
            poll-results channel (task 21.4), honouring `poll.results_visibility`
            ('show_always' → live tallies while open; 'hide_until_closed' →
            withhold until `poll.status === 'closed'`). PollCard is the RESPONSE
            surface only and deliberately renders NO results yet. The read
            helper already exposes `poll.options[].response_count` and
            `poll.results_visibility` for that surface to consume.
            ────────────────────────────────────────────────────────────────
          */}
        </div>
      ) : null}
    </section>
  );
}
