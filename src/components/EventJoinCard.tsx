/**
 * `EventJoinCard` — the audience landing / join-flow component (Task 14.3).
 *
 * This single component serves the two related surfaces of the audience join
 * flow (Design → Components → `EventJoinCard`: "Show event name/status, join
 * CTA, code entry", Req 2.1, 2.6):
 *
 *  - **Code-entry mode** (`mode="code-entry"`, used on the landing page `/`):
 *    an accessible Event_Code input + submit button. On submit it resolves the
 *    code via {@link findEventByRef}; a known/live code navigates the
 *    participant to the event join route, while an unknown code shows an
 *    accessible "That event code is invalid" error and keeps the participant on
 *    the landing page (Req 2.1, 2.2).
 *
 *  - **Join-card mode** (`mode="join-card"`, used on `/join/:eventRef`): shows
 *    the resolved event's name + status and a CTA button that enters the event
 *    view. When no event is provided it renders a friendly not-found /
 *    unavailable state (the parent resolves the event; see `JoinScreen`).
 *
 * Accessibility (Req 24.5, 24.7): the code input has a programmatically
 * associated `<label>`; the four UX states (idle / loading / success-navigate /
 * error) are each represented and announced to assistive tech via `role`/
 * `aria-live`; buttons and inputs meet the ≥44×44px touch target (`.touch-target`);
 * the flow is fully keyboard-navigable with the global `:focus-visible` ring.
 *
 * Requirements traceability: 2.1, 2.2, 24.5, 24.7.
 * Design: Frontend Design (Route map — `/`, `/join/:eventRef`); Components
 * (`EventJoinCard`); Request/data flows (Audience join).
 */

import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { findEventByRef, type PublicEvent } from '../lib/eventLookup';
import { cx, FOCUS_RING } from '../lib/a11y';

/** Human-readable label for each event status, shown in join-card mode. */
const STATUS_LABEL: Record<PublicEvent['status'], string> = {
  draft: 'Not started',
  live: 'Live now',
  ended: 'Ended',
  archived: 'Archived',
};

/** Resolution state of the code-entry form (Req 24.7 four UX states). */
type CodeEntryStatus = 'idle' | 'resolving' | 'success' | 'error';

/**
 * Builds the audience join path for a resolved reference. We prefer the slug
 * (the friendly Event_Code) when present, falling back to the id. The join
 * route (`/join/:eventRef`) then re-resolves and shows the join card; the CTA
 * from there enters the event view (`/e/:eventRef`, task 14.4).
 */
function joinPathFor(event: PublicEvent): string {
  const ref = event.slug ?? event.id;
  return `/join/${encodeURIComponent(ref)}`;
}

/** Builds the event-view path for a resolved reference (task 14.4 owns it). */
function eventViewPathFor(ref: string): string {
  return `/e/${encodeURIComponent(ref)}`;
}

export interface EventJoinCardProps {
  /**
   * Which surface to render:
   *  - `'code-entry'` — the landing-page Event_Code form (default).
   *  - `'join-card'` — the resolved-event card with an "enter" CTA.
   */
  readonly mode: 'code-entry' | 'join-card';
  /**
   * The resolved event (join-card mode). When `mode="join-card"` and this is
   * `null`/`undefined`, a friendly not-found/unavailable state is shown.
   */
  readonly event?: PublicEvent | null;
  /**
   * The reference used to enter the event view in join-card mode (usually the
   * `:eventRef` route param). Defaults to the event's slug/id when omitted.
   */
  readonly eventRef?: string;
}

/**
 * Code-entry form for the landing page. Owns its own resolution + navigation so
 * the landing screen stays a thin wrapper.
 */
function CodeEntryCard(): JSX.Element {
  const navigate = useNavigate();
  const inputId = useId();
  const errorId = useId();
  const hintId = useId();

  const [code, setCode] = useState('');
  const [status, setStatus] = useState<CodeEntryStatus>('idle');

  const isResolving = status === 'resolving';

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (isResolving) return;

    const trimmed = code.trim();
    // Treat an empty submission as an invalid code (Req 2.2) rather than a
    // network call — keeps the participant on the landing page with feedback.
    if (trimmed.length === 0) {
      setStatus('error');
      return;
    }

    setStatus('resolving');
    try {
      const resolved = await findEventByRef(trimmed);
      if (resolved) {
        // Success → navigate to the join route for the resolved event
        // (Req 2.1). We surface a brief success state for AT before the
        // route transition completes.
        setStatus('success');
        navigate(joinPathFor(resolved));
        return;
      }
      // Unknown (or not-live) code: reject the join, keep the participant on
      // the landing page, and show the invalid-code error (Req 2.2).
      setStatus('error');
    } catch {
      // A transport failure is surfaced the same way as an unknown code so we
      // never leak internals and the participant stays on the landing page.
      setStatus('error');
    }
  }

  return (
    <section className="rounded-lg border border-ink-muted/40 p-4">
      <h2 className="text-lg font-semibold text-ink">Join an event</h2>
      <p id={hintId} className="mt-1 text-ink-muted">
        Enter the event code shown on screen to join.
      </p>

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="font-medium text-ink">
            Event code
          </label>
          <input
            id={inputId}
            name="event-code"
            type="text"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              // Clear a stale error as soon as the participant edits the code.
              if (status === 'error') setStatus('idle');
            }}
            disabled={isResolving}
            aria-invalid={status === 'error' ? true : undefined}
            aria-describedby={
              status === 'error' ? `${errorId} ${hintId}` : hintId
            }
            className={cx(
              'touch-target w-full rounded border border-ink-muted px-3 py-2 text-ink',
              FOCUS_RING,
            )}
          />
        </div>

        {/* Error state (Req 24.7 / 2.2): invalid code, announced to AT. */}
        {status === 'error' ? (
          <p id={errorId} role="alert" className="text-ink">
            That event code is invalid. Please check it and try again.
          </p>
        ) : null}

        {/* Success state (Req 24.7): confirmation while the route transitions. */}
        {status === 'success' ? (
          <p role="status" aria-live="polite" className="text-ink">
            Event found. Taking you there…
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isResolving}
          aria-busy={isResolving}
          className={cx(
            'touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60',
            FOCUS_RING,
          )}
        >
          {isResolving ? 'Finding event…' : 'Join'}
        </button>

        {/* Loading state (Req 24.7): a progress indicator distinct from the
            button label, announced politely. */}
        {isResolving ? (
          <span role="status" aria-live="polite" className="text-ink-muted">
            Looking up that event code…
          </span>
        ) : null}
      </form>
    </section>
  );
}

/**
 * Join card for a resolved event. Shows the event name + status and a CTA to
 * enter the event view. When `event` is null, renders the not-found state.
 */
function ResolvedEventCard({
  event,
  eventRef,
}: {
  event: PublicEvent | null | undefined;
  eventRef?: string;
}): JSX.Element {
  const navigate = useNavigate();

  if (!event) {
    // Friendly not-found / unavailable state (Req 2.2, 1.9): the event does not
    // exist, or it is not live and therefore not visible to anonymous visitors.
    return (
      <section
        role="alert"
        className="rounded-lg border border-ink-muted/40 p-4"
      >
        <h2 className="text-lg font-semibold text-ink">Event unavailable</h2>
        <p className="mt-1 text-ink-muted">
          We couldn&rsquo;t find a live event for that code. It may not have
          started yet, may have ended, or the code may be incorrect.
        </p>
      </section>
    );
  }

  const ref = eventRef ?? event.slug ?? event.id;
  const statusLabel = STATUS_LABEL[event.status];

  return (
    <section className="rounded-lg border border-ink-muted/40 p-4">
      <h2 className="text-lg font-semibold text-ink">{event.name}</h2>
      <p className="mt-1 text-ink-muted">
        Status: <span data-testid="event-status">{statusLabel}</span>
      </p>

      <button
        type="button"
        onClick={() => navigate(eventViewPathFor(ref))}
        className={cx(
          'touch-target mt-4 rounded bg-focus px-4 py-2 font-medium text-surface',
          FOCUS_RING,
        )}
      >
        Enter event
      </button>
    </section>
  );
}

/**
 * The audience join card. Delegates to the code-entry form or the resolved
 * event card based on `mode` (see module docstring).
 */
export function EventJoinCard(props: EventJoinCardProps): JSX.Element {
  if (props.mode === 'code-entry') {
    return <CodeEntryCard />;
  }
  return <ResolvedEventCard event={props.event} eventRef={props.eventRef} />;
}

export default EventJoinCard;
