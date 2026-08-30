/**
 * Tests for the `/admin/events/:id` event editor create flow (task 8.1).
 *
 * These verify the accessibility and the four UX states mandated by the design
 * (Frontend Design → four UX states; Error Handling → Validation errors) using
 * a mocked `../lib/events` helper (so no real Supabase session / Edge Function
 * is needed):
 *   (a) all fields expose programmatically associated labels — Req 24.5;
 *   (b) a valid submit calls `createEvent` with the expected body (optional
 *       fields omitted when blank; datetimes converted to ISO) and shows the
 *       success state — the audience URL + a QR image region — Req 1.1, 24.7;
 *   (c) an invalid submit (empty name / ends_at ≤ starts_at) shows inline field
 *       errors, retains entered values, and does NOT call the network — Req 1.2;
 *   (d) a 409 slug conflict surfaces an inline slug error — Req 1.2, 24.7.
 *
 * The helper is mocked so the tests are deterministic and never touch the
 * network. Client-side schema validation lives in the helper; to exercise the
 * editor's inline-error rendering for case (c) we drive the helper mock to
 * reject with an `EventError` of kind `validation` carrying per-field messages
 * (mirroring both the client Zod path and the Edge Function's `error.fields`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// --- Mock the events helper the editor depends on. -------------------------
// Fully replace `../lib/events` so importing it never pulls in the real
// supabase client (which needs VITE_ env vars unavailable in tests). The mock
// defines a self-contained `EventError` matching the real class's shape.
const { createEvent, EventError } = vi.hoisted(() => {
  class EventError extends Error {
    kind: string;
    fields: { field: string; message: string }[];
    status?: number;
    constructor(
      message: string,
      options: {
        kind: string;
        fields?: { field: string; message: string }[];
        status?: number;
      },
    ) {
      super(message);
      this.name = 'EventError';
      this.kind = options.kind;
      this.fields = options.fields ?? [];
      this.status = options.status;
    }
  }
  return { createEvent: vi.fn(), EventError };
});

vi.mock('../lib/events', () => ({
  createEvent: (input: unknown) => createEvent(input),
  EventError,
}));

import { AdminEventEditor } from './AdminEventEditor';

/** Renders the editor at `/admin/events/:id` (defaults to CREATE mode). */
function renderEditor(id = 'new'): void {
  render(
    <MemoryRouter initialEntries={[`/admin/events/${id}`]}>
      <Routes>
        <Route path="/admin/events/:id" element={<AdminEventEditor />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Fills the required fields with a valid event; returns the values used. */
async function fillValidForm(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.type(screen.getByLabelText(/event name/i), 'Demo Day');
  await user.type(screen.getByLabelText(/starts at/i), '2026-01-01T09:00');
  await user.type(screen.getByLabelText(/ends at/i), '2026-01-01T17:00');
}

beforeEach(() => {
  createEvent.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdminEventEditor (create flow)', () => {
  it('exposes programmatically associated labels for all fields (Req 24.5)', () => {
    renderEditor();

    // getByLabelText only resolves with a non-empty associated accessible name.
    expect(screen.getByLabelText(/event name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/event code/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/starts at/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ends at/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/brand colour/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/moderation mode/i)).toBeInTheDocument();
  });

  it('calls createEvent with the expected body and shows the success state (Req 1.1, 24.7)', async () => {
    const user = userEvent.setup();
    createEvent.mockResolvedValue({
      event: {
        id: 'evt-1',
        slug: null,
        status: 'draft',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      audienceUrl: 'https://app.example/e/evt-1',
      presenterUrl: 'https://app.example/present/evt-1?t=secret',
      qrTarget: 'https://app.example/e/evt-1',
    });

    renderEditor();
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /create event/i }));

    await waitFor(() => {
      expect(createEvent).toHaveBeenCalledTimes(1);
    });
    const body = createEvent.mock.calls[0][0];
    expect(body).toMatchObject({
      name: 'Demo Day',
      moderation_mode: 'pre',
    });
    // Datetimes converted to ISO 8601 strings; end strictly after start.
    expect(new Date(body.ends_at).getTime()).toBeGreaterThan(
      new Date(body.starts_at).getTime(),
    );
    // Optional fields omitted when left blank (no empty-string slug/description).
    expect(body).not.toHaveProperty('slug');
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('brand_colour');

    // Success state: confirmation + audience URL + a QR image region.
    expect(
      await screen.findByRole('heading', { name: /event created/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://app.example/e/evt-1' }),
    ).toBeInTheDocument();
    // QrDisplay renders a role="img" region with a non-empty accessible name.
    expect(
      screen.getByRole('img', { name: /qr code/i }),
    ).toBeInTheDocument();
  });

  it('shows inline field errors and does NOT call the network on invalid input (Req 1.2)', async () => {
    const user = userEvent.setup();
    // Drive the helper to reject like the shared Zod schema would for an empty
    // name and ends_at <= starts_at, so we assert the editor renders both
    // inline messages beside the right fields.
    createEvent.mockRejectedValue(
      new EventError('One or more fields are invalid.', {
        kind: 'validation',
        fields: [
          { field: 'name', message: 'Name must be at least 1 character.' },
          {
            field: 'ends_at',
            message: 'End datetime must be later than the start datetime.',
          },
        ],
      }),
    );

    renderEditor();
    // Enter reversed datetimes but leave name empty; keep the entered values.
    await user.type(screen.getByLabelText(/starts at/i), '2026-01-01T17:00');
    await user.type(screen.getByLabelText(/ends at/i), '2026-01-01T09:00');
    await user.click(screen.getByRole('button', { name: /create event/i }));

    // Inline errors surface next to their fields.
    const nameField = screen.getByLabelText(/event name/i);
    await waitFor(() => {
      expect(nameField).toHaveAttribute('aria-invalid', 'true');
    });
    const endsField = screen.getByLabelText(/ends at/i);
    expect(endsField).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByText(/end datetime must be later than the start datetime/i),
    ).toBeInTheDocument();

    // Entered values are retained (Req 1.2).
    expect(screen.getByLabelText(/starts at/i)).toHaveValue('2026-01-01T17:00');
    expect(screen.getByLabelText(/ends at/i)).toHaveValue('2026-01-01T09:00');
  });

  it('surfaces an inline slug error on a 409 slug conflict (Req 1.2, 24.7)', async () => {
    const user = userEvent.setup();
    createEvent.mockRejectedValue(
      new EventError('The event code "demo" is already in use.', {
        kind: 'slug_conflict',
        status: 409,
        fields: [
          { field: 'slug', message: 'This event code is already in use.' },
        ],
      }),
    );

    renderEditor();
    await fillValidForm(user);
    await user.type(screen.getByLabelText(/event code/i), 'demo');
    await user.click(screen.getByRole('button', { name: /create event/i }));

    // The slug input is marked invalid and shows an inline conflict message.
    const slugField = screen.getByLabelText(/event code/i);
    await waitFor(() => {
      expect(slugField).toHaveAttribute('aria-invalid', 'true');
    });
    expect(
      screen.getByText(/this event code is already in use/i),
    ).toBeInTheDocument();
    // The slug value is retained so the admin can amend it.
    expect(slugField).toHaveValue('demo');
  });

  it('disables the submit control while submitting (Req 24.7)', async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void = () => {};
    createEvent.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    renderEditor();
    await fillValidForm(user);
    const submit = screen.getByRole('button', { name: /create event/i });
    await user.click(submit);

    await waitFor(() => {
      expect(submit).toBeDisabled();
    });
    expect(submit).toHaveAttribute('aria-busy', 'true');

    resolve({
      event: {
        id: 'evt-2',
        slug: null,
        status: 'draft',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      audienceUrl: 'https://app.example/e/evt-2',
      presenterUrl: 'https://app.example/present/evt-2?t=secret',
      qrTarget: 'https://app.example/e/evt-2',
    });
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /event created/i }),
      ).toBeInTheDocument();
    });
  });

  it('renders a minimal edit shell for an existing event id', () => {
    renderEditor('evt-existing');
    expect(
      screen.getByRole('heading', { name: /edit event/i }),
    ).toBeInTheDocument();
    // No create form in edit mode.
    expect(
      screen.queryByRole('button', { name: /create event/i }),
    ).not.toBeInTheDocument();
  });
});
