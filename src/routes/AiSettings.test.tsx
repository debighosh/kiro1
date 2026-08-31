/**
 * Tests for the `/admin/ai-settings` AI provider settings screen (task 34.1),
 * covering the admin-UI behaviour mandated by task 34.5:
 *   (a) the config form surfaces per-field validation errors from the shared
 *       schema (empty display name, invalid base URL) — Req 11.12, 24.7;
 *   (b) NO credential value is ever rendered — the UI shows only the presence
 *       state and the credential input is an empty password field — Req 12.10;
 *   (c) Replace/Remove are gated behind a session re-verified within 300 s, and
 *       Remove additionally requires an explicit confirmation step before
 *       `removeAiCredential` is ever called — Req 11.12, 11.13;
 *   (d) the connection test surfaces ONLY the sanitised result (outcome, status
 *       category, model, round-trip, timestamp) and the degraded/unavailable
 *       message — Req 13.1, 25.7.
 *
 * `../lib/aiClient` and `../lib/auth` are fully mocked so importing the screen
 * never constructs the real Supabase client (which needs VITE_ env vars). The
 * shared Zod schema (`../schemas/ai`) is used REAL — it is pure and env-free —
 * so the inline field-error assertions exercise the true validation path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type {
  AiProviderSettingsPublic,
  ConnectionTestResponse,
} from '../lib/aiClient';

// --- Mock the AI client the screen depends on. -----------------------------
// A self-contained `AiClientError` matching the real class's shape, plus a
// spy for every helper the screen imports.
const {
  AiClientError,
  readAiProviderSettings,
  saveAiProviderSettings,
  removeAiCredential,
  runConnectionTest,
  isSessionRecentlyVerified,
} = vi.hoisted(() => {
  class AiClientError extends Error {
    kind: string;
    status?: number;
    fields: { field: string; message: string }[];
    constructor(
      message: string,
      options: {
        kind: string;
        status?: number;
        fields?: { field: string; message: string }[];
      },
    ) {
      super(message);
      this.name = 'AiClientError';
      this.kind = options.kind;
      this.status = options.status;
      this.fields = options.fields ?? [];
    }
  }
  return {
    AiClientError,
    readAiProviderSettings: vi.fn(),
    saveAiProviderSettings: vi.fn(),
    removeAiCredential: vi.fn(),
    runConnectionTest: vi.fn(),
    isSessionRecentlyVerified: vi.fn(),
  };
});

vi.mock('../lib/aiClient', () => ({
  AiClientError,
  CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS: 300,
  readAiProviderSettings: () => readAiProviderSettings(),
  saveAiProviderSettings: (input: unknown) => saveAiProviderSettings(input),
  removeAiCredential: () => removeAiCredential(),
  runConnectionTest: () => runConnectionTest(),
  isSessionRecentlyVerified: () => isSessionRecentlyVerified(),
}));

// `../lib/auth` is only used for the re-verify (sign-in) step; stub it so the
// import never touches env/network.
const { signInWithPassword } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
}));
vi.mock('../lib/auth', () => ({
  signInWithPassword: (email: string, password: string) =>
    signInWithPassword(email, password),
}));

import { AiSettings } from './AiSettings';

/** A fully-populated NON-SECRET settings row with a credential CONFIGURED. */
function configuredSettings(
  overrides: Partial<AiProviderSettingsPublic> = {},
): AiProviderSettingsPublic {
  return {
    id: 'ai-1',
    is_active: true,
    ai_enabled: true,
    display_name: 'Primary provider',
    provider_type: 'openai_compatible',
    base_url: 'https://api.example.com',
    chat_completions_path: '/v1/chat/completions',
    auth_type: 'bearer',
    api_key_header_name: null,
    model_id: 'gpt-4o-mini',
    temperature: 0.2,
    max_output_tokens: 1024,
    request_timeout_seconds: 30,
    tls_verify_required: true,
    credential_state: 'configured',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderScreen(): void {
  render(
    <MemoryRouter initialEntries={['/admin/ai-settings']}>
      <AiSettings />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  readAiProviderSettings.mockReset();
  saveAiProviderSettings.mockReset();
  removeAiCredential.mockReset();
  runConnectionTest.mockReset();
  isSessionRecentlyVerified.mockReset();
  signInWithPassword.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AiSettings — config form validation (Req 11.12, 24.7)', () => {
  it('surfaces per-field errors for an empty display name and invalid base URL', async () => {
    const user = userEvent.setup();
    // No existing config → the CREATE form is shown with empty fields.
    readAiProviderSettings.mockResolvedValue(null);

    renderScreen();
    // Wait for the initial load to resolve into the ready form.
    const displayName = await screen.findByLabelText(/display name/i);

    // Enter an INVALID base URL (relative path — not an absolute http(s) URL)
    // and leave the display name empty, then submit.
    await user.type(screen.getByLabelText(/base url/i), 'not-a-url');
    await user.type(screen.getByLabelText(/^model id$/i), 'gpt-4o-mini');
    await user.click(
      screen.getByRole('button', { name: /create ai settings/i }),
    );

    // The shared schema rejects both fields → inline errors surface beside them.
    await waitFor(() => {
      expect(displayName).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByLabelText(/base url/i)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(
      screen.getByText(/display name must be at least 1 character/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/base url must be an absolute http\(s\) url/i),
    ).toBeInTheDocument();

    // Validation failing client-side means the network write is NEVER called.
    expect(saveAiProviderSettings).not.toHaveBeenCalled();
  });
});

describe('AiSettings — write-only credential (Req 12.10)', () => {
  it('never renders any credential value; shows only the presence state with an empty password field', async () => {
    // Configured provider. The public shape carries only `credential_state`;
    // there is no credential value anywhere in it to render.
    readAiProviderSettings.mockResolvedValue(configuredSettings());

    renderScreen();

    // Presence-only state is shown …
    expect(
      await screen.findByText(/a credential is configured/i),
    ).toBeInTheDocument();

    // … and the credential input is a PASSWORD field that starts EMPTY (a
    // write-only replace box — the stored value is never populated into it).
    const credentialInput = screen.getByLabelText(
      /enter credential to replace/i,
    );
    expect(credentialInput).toHaveAttribute('type', 'password');
    expect(credentialInput).toHaveValue('');
  });
});

describe('AiSettings — Replace/Remove gating (Req 11.12, 11.13)', () => {
  it('gates Remove behind a re-verify prompt when the session is NOT recent (does not call removeAiCredential)', async () => {
    const user = userEvent.setup();
    readAiProviderSettings.mockResolvedValue(configuredSettings());
    // Session is older than 300 s → the action must be re-verified first.
    isSessionRecentlyVerified.mockResolvedValue(false);

    renderScreen();
    await screen.findByText(/a credential is configured/i);

    await user.click(
      screen.getByRole('button', { name: /remove credential/i }),
    );

    // The re-verify prompt opens; removal is NOT performed.
    expect(
      await screen.findByRole('alertdialog', {
        name: /re-verify your session/i,
      }),
    ).toBeInTheDocument();
    expect(removeAiCredential).not.toHaveBeenCalled();
    // The explicit confirmation step is NOT shown yet either.
    expect(
      screen.queryByRole('alertdialog', {
        name: /confirm credential removal/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('when the session IS recent, Remove opens the explicit confirmation step and only calls removeAiCredential after confirm (Req 11.13)', async () => {
    const user = userEvent.setup();
    readAiProviderSettings.mockResolvedValue(configuredSettings());
    isSessionRecentlyVerified.mockResolvedValue(true);
    removeAiCredential.mockResolvedValue(
      configuredSettings({ credential_state: 'not_configured' }),
    );

    renderScreen();
    await screen.findByText(/a credential is configured/i);

    // Clicking Remove with a recent session opens the confirmation dialog …
    await user.click(
      screen.getByRole('button', { name: /remove credential/i }),
    );
    expect(
      await screen.findByRole('alertdialog', {
        name: /confirm credential removal/i,
      }),
    ).toBeInTheDocument();
    // … but does NOT remove until the admin explicitly confirms (Req 11.13).
    expect(removeAiCredential).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /confirm remove/i }));
    await waitFor(() => {
      expect(removeAiCredential).toHaveBeenCalledTimes(1);
    });
  });
});

describe('AiSettings — connection test surfaces only sanitised results (Req 13.1, 25.7)', () => {
  it('renders the sanitised outcome/status/model/round-trip/timestamp and no provider internals', async () => {
    const user = userEvent.setup();
    readAiProviderSettings.mockResolvedValue(configuredSettings());
    const sanitised: ConnectionTestResponse = {
      available: true,
      result: {
        outcome: 'established',
        status_category: '2xx',
        model_id: 'gpt-4o-mini',
        round_trip_ms: 142,
        timestamp: '2026-01-02T03:04:05.000Z',
      },
    };
    runConnectionTest.mockResolvedValue(sanitised);

    renderScreen();
    await screen.findByText(/a credential is configured/i);

    await user.click(
      screen.getByRole('button', { name: /run connection test/i }),
    );

    // Sanitised, whitelisted fields render.
    expect(
      await screen.findByText(/connection established/i),
    ).toBeInTheDocument();
    expect(screen.getByText('2xx')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('142 ms')).toBeInTheDocument();
    expect(screen.getByText('2026-01-02T03:04:05.000Z')).toBeInTheDocument();
  });

  it('renders the degraded/unavailable message when AI is not usable yet', async () => {
    const user = userEvent.setup();
    readAiProviderSettings.mockResolvedValue(
      configuredSettings({ credential_state: 'not_configured' }),
    );
    runConnectionTest.mockResolvedValue({
      available: false,
      unavailable: {
        available: false,
        reason: 'credential_missing',
        mode: 'degraded',
        message: 'AI is not available: a credential is required.',
      },
    } satisfies ConnectionTestResponse);

    renderScreen();
    await screen.findByRole('heading', { name: /ai settings/i });

    await user.click(
      screen.getByRole('button', { name: /run connection test/i }),
    );

    expect(
      await screen.findByText(/ai is not available: a credential is required/i),
    ).toBeInTheDocument();
  });
});
