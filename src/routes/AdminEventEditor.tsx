import { useId, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { QrDisplay } from '../components/QrDisplay';
import {
  createEvent,
  EventError,
  type CreateEventResult,
  type EventFieldError,
} from '../lib/events';
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_NAME_MAX,
  type EventCreateInput,
  type ModerationMode,
} from '../schemas/event';

/**
 * `/admin/events/:id` — the admin event editor (Task 8.1).
 *
 * For Milestone 1 this focuses on the CREATE flow. The route param `id` selects
 * the mode:
 *  - `new` → CREATE mode: an empty, accessible form that creates an event via
 *    the authenticated `create-event` Edge Function (through the
 *    {@link createEvent} helper).
 *  - any other id → EDIT mode: intentionally minimal. The edit Edge Function
 *    does not exist yet (only `create-event` is deployed), so edit is stubbed
 *    with an explanatory note rather than presenting a form that cannot save.
 *
 * Four UX states (Design → Frontend Design → four UX states; Req 24.7):
 *  - idle: the empty form with descriptive helper text.
 *  - submitting: submit disabled + `aria-busy`; inputs disabled; a polite
 *    progress indicator.
 *  - success: a confirmation plus the created event's audience URL, a
 *    {@link QrDisplay} of the audience URL (== `qrTarget`), and the presenter
 *    URL. The form is replaced by the confirmation.
 *  - error: inline per-field messages beside the relevant inputs (from the
 *    shared Zod schema client-side and from the Edge Function's `error.fields`
 *    server-side); a general message for non-field failures (e.g. session
 *    expiry). Entered values are always retained (Req 1.2).
 *
 * Accessibility & mobile-first (Design → Mobile-first & accessibility approach;
 * Req 24.5, 25.4):
 *  - every field has a programmatically associated `<label>`;
 *  - invalid fields set `aria-invalid` and `aria-describedby` pointing at their
 *    inline message;
 *  - `.app-container` mobile-first layout; inputs and the submit button meet the
 *    ≥44×44px touch target (`.touch-target`); keyboard-navigable with the global
 *    `:focus-visible` ring.
 *
 * Requirements traceability: 1.1, 1.2, 1.3, 24.7, 25.4.
 * Design: Components and Interfaces (event editor); Error Handling (Validation
 * errors).
 */

/** Resolution state of the create form (Req 24.7 four UX states). */
type EditorStatus = 'idle' | 'submitting' | 'success' | 'error';

/** Controlled form values. Datetimes are `datetime-local` strings until submit. */
interface FormValues {
  name: string;
  description: string;
  slug: string;
  startsAt: string;
  endsAt: string;
  brandColour: string;
  moderationMode: ModerationMode;
}

const EMPTY_FORM: FormValues = {
  name: '',
  description: '',
  slug: '',
  startsAt: '',
  endsAt: '',
  brandColour: '',
  moderationMode: 'pre',
};

/**
 * Converts a `datetime-local` value (local wall-clock, no zone) to an ISO 8601
 * string with an offset, which is what the shared schema + Edge Function expect.
 * Returns `''` for an empty input so the schema surfaces a "required" style
 * error rather than an `Invalid Date`.
 */
function datetimeLocalToIso(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value; // let the schema reject it
  return date.toISOString();
}

/** Builds the typed create-input payload from the controlled form values. */
function toCreateInput(values: FormValues): EventCreateInput {
  const input: EventCreateInput = {
    name: values.name.trim(),
    starts_at: datetimeLocalToIso(values.startsAt),
    ends_at: datetimeLocalToIso(values.endsAt),
    moderation_mode: values.moderationMode,
  };
  // Only include optional fields when the user actually entered something, so
  // an empty string does not trip an optional field's format validation.
  if (values.description.trim() !== '') {
    input.description = values.description;
  }
  if (values.slug.trim() !== '') {
    input.slug = values.slug.trim();
  }
  if (values.brandColour.trim() !== '') {
    input.brand_colour = values.brandColour.trim();
  }
  return input;
}

/**
 * Indexes a list of {@link EventFieldError} by field name for O(1) lookup while
 * rendering. When multiple issues target one field, the first is shown.
 */
function indexFieldErrors(
  fields: readonly EventFieldError[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { field, message } of fields) {
    if (!(field in map)) map[field] = message;
  }
  return map;
}

export function AdminEventEditor(): JSX.Element {
  const { id } = useParams();
  const isCreate = id === 'new' || id === undefined;

  // Stable ids so labels/inline errors associate with their controls (Req 24.5).
  const nameId = useId();
  const descriptionId = useId();
  const slugId = useId();
  const startsAtId = useId();
  const endsAtId = useId();
  const brandColourId = useId();
  const moderationModeId = useId();
  const generalErrorId = useId();

  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [status, setStatus] = useState<EditorStatus>('idle');
  const [fieldErrors, setFieldErrors] = useState<EventFieldError[]>([]);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateEventResult | null>(null);

  const isSubmitting = status === 'submitting';
  const errorsByField = useMemo(
    () => indexFieldErrors(fieldErrors),
    [fieldErrors],
  );

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (isSubmitting) return;

    setStatus('submitting');
    setFieldErrors([]);
    setGeneralError(null);

    try {
      const created = await createEvent(toCreateInput(values));
      setResult(created);
      setStatus('success');
    } catch (error) {
      if (error instanceof EventError) {
        setFieldErrors(error.fields);
        // Show a general message when there are no per-field errors to attach
        // it to, OR for a slug conflict (which carries both a field error and a
        // helpful general explanation), OR for auth/unknown failures.
        if (error.fields.length === 0 || error.kind !== 'validation') {
          setGeneralError(error.message);
        }
      } else {
        setGeneralError(
          'The event could not be created. Please try again.',
        );
      }
      setStatus('error');
    }
  }

  // EDIT mode is intentionally minimal for Milestone 1 (no edit Edge Function).
  if (!isCreate) {
    return (
      <main className="app-container py-8">
        <h1 className="text-2xl font-semibold text-ink">Edit event</h1>
        <p className="mt-2 text-ink-muted">
          Editing existing event <code>{id}</code> is not available yet. For
          Milestone 1 only event creation is supported; the edit capability will
          arrive with the event-update endpoint in a later milestone.
        </p>
      </main>
    );
  }

  // SUCCESS state (Req 24.7): confirmation + audience URL + QR + presenter URL.
  if (status === 'success' && result) {
    return (
      <main className="app-container py-8">
        <h1 className="text-2xl font-semibold text-ink">Event created</h1>
        <p role="status" aria-live="polite" className="mt-2 text-ink">
          Your event has been created as a draft. Share the audience link or QR
          code below, and open the presenter view when you are ready.
        </p>

        <section aria-labelledby={`${generalErrorId}-audience`} className="mt-6">
          <h2
            id={`${generalErrorId}-audience`}
            className="text-lg font-medium text-ink"
          >
            Audience link
          </h2>
          <p className="mt-1 break-all text-ink">
            <a href={result.audienceUrl} className="underline">
              {result.audienceUrl}
            </a>
          </p>
          <div className="mt-3">
            <QrDisplay
              value={result.qrTarget}
              title="QR code linking to the audience join page"
            />
          </div>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-medium text-ink">Presenter link</h2>
          <p className="mt-1 break-all text-ink-muted">
            Keep this private — it grants presenter access.
          </p>
          <p className="mt-1 break-all text-ink">
            <a href={result.presenterUrl} className="underline">
              {result.presenterUrl}
            </a>
          </p>
        </section>

        <button
          type="button"
          onClick={() => {
            setResult(null);
            setValues(EMPTY_FORM);
            setStatus('idle');
          }}
          className="touch-target mt-8 rounded bg-focus px-4 py-2 font-medium text-surface"
        >
          Create another event
        </button>
      </main>
    );
  }

  const nameError = errorsByField.name;
  const descriptionError = errorsByField.description;
  const slugError = errorsByField.slug;
  const startsAtError = errorsByField.starts_at;
  const endsAtError = errorsByField.ends_at;
  const brandColourError = errorsByField.brand_colour;

  return (
    <main className="app-container py-8">
      <h1 className="text-2xl font-semibold text-ink">Create event</h1>
      <p className="mt-2 text-ink-muted">
        Set up a new event. It starts as a draft; you can make it live later.
      </p>

      <form
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
      >
        {/* Name — required, ≤100 (Req 1.1). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="font-medium text-ink">
            Event name
          </label>
          <input
            id={nameId}
            name="name"
            type="text"
            required
            maxLength={EVENT_NAME_MAX * 2}
            value={values.name}
            onChange={(e) => update('name', e.target.value)}
            disabled={isSubmitting}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${nameId}-error` : undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {nameError ? (
            <p id={`${nameId}-error`} role="alert" className="text-ink">
              {nameError}
            </p>
          ) : null}
        </div>

        {/* Description — optional, ≤500 (Req 1.3). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={descriptionId} className="font-medium text-ink">
            Description <span className="text-ink-muted">(optional)</span>
          </label>
          <textarea
            id={descriptionId}
            name="description"
            rows={3}
            maxLength={EVENT_DESCRIPTION_MAX * 2}
            value={values.description}
            onChange={(e) => update('description', e.target.value)}
            disabled={isSubmitting}
            aria-invalid={descriptionError ? true : undefined}
            aria-describedby={
              descriptionError ? `${descriptionId}-error` : undefined
            }
            className="rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {descriptionError ? (
            <p id={`${descriptionId}-error`} role="alert" className="text-ink">
              {descriptionError}
            </p>
          ) : null}
        </div>

        {/* Slug / event code — optional (Req 1.3). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={slugId} className="font-medium text-ink">
            Event code <span className="text-ink-muted">(optional)</span>
          </label>
          <input
            id={slugId}
            name="slug"
            type="text"
            inputMode="text"
            autoComplete="off"
            value={values.slug}
            onChange={(e) => update('slug', e.target.value)}
            disabled={isSubmitting}
            aria-invalid={slugError ? true : undefined}
            aria-describedby={slugError ? `${slugId}-error` : undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {slugError ? (
            <p id={`${slugId}-error`} role="alert" className="text-ink">
              {slugError}
            </p>
          ) : null}
        </div>

        {/* Start / end datetimes (Req 1.1). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={startsAtId} className="font-medium text-ink">
            Starts at
          </label>
          <input
            id={startsAtId}
            name="starts_at"
            type="datetime-local"
            required
            value={values.startsAt}
            onChange={(e) => update('startsAt', e.target.value)}
            disabled={isSubmitting}
            aria-invalid={startsAtError ? true : undefined}
            aria-describedby={
              startsAtError ? `${startsAtId}-error` : undefined
            }
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {startsAtError ? (
            <p id={`${startsAtId}-error`} role="alert" className="text-ink">
              {startsAtError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={endsAtId} className="font-medium text-ink">
            Ends at
          </label>
          <input
            id={endsAtId}
            name="ends_at"
            type="datetime-local"
            required
            value={values.endsAt}
            onChange={(e) => update('endsAt', e.target.value)}
            disabled={isSubmitting}
            aria-invalid={endsAtError ? true : undefined}
            aria-describedby={endsAtError ? `${endsAtId}-error` : undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {endsAtError ? (
            <p id={`${endsAtId}-error`} role="alert" className="text-ink">
              {endsAtError}
            </p>
          ) : null}
        </div>

        {/* Brand colour — optional (Req 1.3). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={brandColourId} className="font-medium text-ink">
            Brand colour <span className="text-ink-muted">(optional)</span>
          </label>
          <input
            id={brandColourId}
            name="brand_colour"
            type="text"
            inputMode="text"
            autoComplete="off"
            placeholder="#0af"
            value={values.brandColour}
            onChange={(e) => update('brandColour', e.target.value)}
            disabled={isSubmitting}
            aria-invalid={brandColourError ? true : undefined}
            aria-describedby={
              brandColourError ? `${brandColourId}-error` : undefined
            }
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {brandColourError ? (
            <p
              id={`${brandColourId}-error`}
              role="alert"
              className="text-ink"
            >
              {brandColourError}
            </p>
          ) : null}
        </div>

        {/* Moderation mode — select, default 'pre' (Req 3.6, 3.8). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={moderationModeId} className="font-medium text-ink">
            Moderation mode
          </label>
          <select
            id={moderationModeId}
            name="moderation_mode"
            value={values.moderationMode}
            onChange={(e) =>
              update('moderationMode', e.target.value as ModerationMode)
            }
            disabled={isSubmitting}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          >
            <option value="pre">
              Pre-moderation (approve before showing)
            </option>
            <option value="post">
              Post-moderation (show, then remove if needed)
            </option>
          </select>
        </div>

        {/* Error state (Req 24.7): a general message for non-field failures. */}
        {status === 'error' && generalError ? (
          <p id={generalErrorId} role="alert" className="text-ink">
            {generalError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
          className="touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60"
        >
          {isSubmitting ? 'Creating…' : 'Create event'}
        </button>

        {/* Submitting/loading indicator distinct from the button label. */}
        {isSubmitting ? (
          <span role="status" aria-live="polite" className="text-ink-muted">
            Creating your event…
          </span>
        ) : null}
      </form>
    </main>
  );
}

export default AdminEventEditor;
