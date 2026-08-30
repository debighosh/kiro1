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
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, LabelList } from 'recharts';
import {
  readActivePoll,
  submitPollResponse,
  subscribeToPollResults,
  PollError,
  type PollWithOptions,
  type PollOption,
  type PollResultsBroadcast,
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
  // The poll's options held in LOCAL state (task 23.2) so realtime
  // `poll_results` broadcasts can update per-option `response_count` and the
  // results chart re-renders within the 2-second target (Req 5.11, 23.1)
  // WITHOUT re-reading the whole poll. Seeded from the read on each load; the
  // option identity/order/text always comes from the authoritative read.
  const [options, setOptions] = useState<readonly PollOption[]>([]);
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
      setOptions([]);
      setState('empty');
      return;
    }
    setState('loading');
    setErrorMessage(null);
    try {
      const active = await readActivePoll(eventId);
      setPoll(active);
      // Seed the local option state (with authoritative counts) from the read;
      // realtime `poll_results` broadcasts then update these counts in place.
      setOptions(active?.options ?? []);
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

  // ────────────────────────────────────────────────────────────────────────
  // RESULTS VISIBILITY GATING (Task 23.2 / Req 5.11).
  //
  // Reveal results to the audience when the poll is configured `show_always`
  // (render live tallies while it is open) OR once the poll status is `closed`.
  // A `hide_until_closed` poll that is still open (`draft`/`open`) WITHHOLDS its
  // results — the placeholder is shown instead of the chart.
  // ────────────────────────────────────────────────────────────────────────
  const revealResults =
    poll !== null &&
    (poll.results_visibility === 'show_always' || poll.status === 'closed');

  // Realtime poll-results subscription (Task 23.2 / Decision D9). Subscribe to
  // the event-scoped `poll_results` broadcast (task 21.4) and, when a payload
  // for THIS poll arrives, update the per-option `response_count` in local
  // state so the chart updates within the 2-second target (Req 5.11, 5.12,
  // 23.1). The subscription is kept regardless of visibility so that when a
  // `hide_until_closed` poll later closes the tallies are already current; the
  // WITHHOLD gate above governs *display* only (never the subscription).
  useEffect(() => {
    const pollId = poll?.id;
    if (!eventId || !pollId) return;

    const unsubscribe = subscribeToPollResults(eventId, {
      onPollResults: (payload: PollResultsBroadcast) => {
        // Only apply broadcasts for the poll this card is currently showing.
        if (payload.poll_id !== pollId) return;
        // Map broadcast option counts by id, then update matching local options
        // in place — preserving option identity, order and text from the read
        // (the broadcast carries only aggregate counts, never text/PII).
        const nextCounts = new Map(
          payload.options.map((o) => [o.option_id, o.response_count]),
        );
        setOptions((current) =>
          current.map((option) =>
            nextCounts.has(option.id)
              ? {
                  ...option,
                  response_count:
                    nextCounts.get(option.id) ?? option.response_count,
                }
              : option,
          ),
        );
      },
    });

    return unsubscribe;
  }, [eventId, poll?.id]);

  // The per-option chart data (label + count), derived from the live-updating
  // local option state. Bars are labelled with the option text + count so the
  // encoding never relies on colour alone (Req 24.5).
  const resultsData = useMemo(
    () =>
      options.map((option) => ({
        optionId: option.id,
        label: option.text,
        count: option.response_count,
      })),
    [options],
  );

  // The total number of responses across all options — surfaced in the
  // accessible summary so screen-reader users get the aggregate too.
  const totalResponses = useMemo(
    () => resultsData.reduce((sum, d) => sum + d.count, 0),
    [resultsData],
  );

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
            <div
              className="flex flex-col gap-2"
              data-testid="poll-controls-withheld"
            >
              <p role="status" className="text-ink-muted">
                {!eventLive
                  ? 'This event is not currently live, so poll responses are closed.'
                  : poll.status === 'closed'
                    ? 'This poll is closed. Responses are no longer accepted.'
                    : 'This poll is not open for responses yet.'}
              </p>
              <ul
                className="flex flex-col gap-2"
                data-testid="poll-options-readonly"
              >
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
            POLL RESULTS — Task 23.2 (visibility-aware, realtime, accessible).

            Visibility gating (Req 5.11): `revealResults` is true only for a
            `show_always` poll or once the poll is `closed`. A still-open
            `hide_until_closed` poll shows the accessible placeholder below and
            NEVER the chart/tallies. When revealed we render a Recharts bar
            chart PLUS an always-present, ARIA-labelled text list of each
            option's text + count so the tallies are conveyed without relying on
            colour or the SVG alone (Req 24.5). The counts live-update from the
            `poll_results` broadcast (Decision D9) within the 2-second target
            (Req 5.11, 5.12, 23.1). No `participant_identifier` is ever rendered
            (Req 8.6).
            ────────────────────────────────────────────────────────────────
          */}
          {!revealResults ? (
            <p
              role="status"
              className="text-sm text-ink-muted"
              data-testid="poll-results-hidden"
            >
              Results are hidden until the poll closes.
            </p>
          ) : (
            <section
              aria-label="Poll results"
              className="flex flex-col gap-3"
              data-testid="poll-results"
            >
              {/*
                Accessible companion (Req 24.5): an ARIA-labelled description
                list of every option's text + response count. This is ALWAYS
                rendered when results are revealed (not sr-only) so screen-reader
                and non-colour users receive the tallies even where the SVG
                chart is unavailable (e.g. jsdom). It is the accessible source of
                truth for the chart alongside it.
              */}
              <dl
                aria-label={`Poll results — ${totalResponses} ${
                  totalResponses === 1 ? 'response' : 'responses'
                } total`}
                className="flex flex-col gap-1"
                data-testid="poll-results-list"
              >
                {resultsData.map((datum) => (
                  <div
                    key={datum.optionId}
                    className="flex items-baseline justify-between gap-3 text-sm text-ink"
                    data-testid="poll-results-row"
                  >
                    <dt className="flex-1 whitespace-pre-wrap break-words">
                      {datum.label}
                    </dt>
                    <dd className="font-semibold tabular-nums">
                      {datum.count}{' '}
                      <span className="font-normal text-ink-muted">
                        {datum.count === 1 ? 'response' : 'responses'}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>

              {/*
                The Recharts bar chart. Wrapped in a fixed-size container (no
                ResponsiveContainer) so it renders deterministically in jsdom
                without a ResizeObserver. Marked role="img" with an aria-label
                summarising the data; the accessible text list above is the
                primary tally source. Each bar is labelled with its response
                count (LabelList) plus the categorical option text on the X axis
                so the encoding never relies on colour alone (Req 24.5).
              */}
              <div
                role="img"
                aria-label={`Bar chart of poll responses by option (${totalResponses} total)`}
                className="w-full overflow-x-auto"
                data-testid="poll-results-chart"
              >
                <BarChart
                  width={320}
                  height={200}
                  data={
                    resultsData as {
                      optionId: string;
                      label: string;
                      count: number;
                    }[]
                  }
                >
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} interval={0} />
                  <YAxis allowDecimals={false} width={28} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#2563eb" name="Responses">
                    <LabelList dataKey="count" position="top" />
                  </Bar>
                </BarChart>
              </div>
            </section>
          )}
        </div>
      ) : null}
    </section>
  );
}
