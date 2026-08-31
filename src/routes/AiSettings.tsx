import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  AiClientError,
  CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS,
  isSessionRecentlyVerified,
  readAiProviderSettings,
  removeAiCredential,
  runConnectionTest,
  saveAiProviderSettings,
  type AiFieldError,
  type AiProviderSettingsPublic,
  type ConnectionTestResult,
  type ConnectionTestResponse,
} from '../lib/aiClient';
import { signInWithPassword } from '../lib/auth';
import {
  aiProviderSettingsInputSchema,
  type AiAuthType,
  type AiProviderSettingsInput,
  type AiProviderType,
} from '../schemas/ai';

/**
 * `/admin/ai-settings` — the admin-only AI provider settings / config screen
 * (Task 34.1).
 *
 * This is the single place an administrator configures the (one, global) AI
 * provider: the non-secret connection settings (validated CLIENT-SIDE against
 * the shared {@link aiProviderSettingsInputSchema} for fast inline feedback,
 * and AUTHORITATIVELY server-side by the AI-config Edge Function), a WRITE-ONLY
 * credential (never displayed — Req 12.1, 12.10), and a connection test that
 * surfaces only sanitised results (Req 13.1, 25.7).
 *
 * ── Write-only credential (Req 11.12, 11.13, 12.1, 12.10, 12.11) ─────────────
 * The stored credential value is NEVER rendered — the UI shows only
 * `credential_state` (configured / not configured / required-for-this-auth).
 * Replace and Remove both REQUIRE a session established or re-verified within
 * {@link CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS} (300 s); when the session is
 * older the action is gated behind a re-verify (re-enter password) prompt.
 * Remove additionally requires an explicit confirmation step (Req 11.13).
 *
 * ── Connection test (Req 13.1, 25.7) ─────────────────────────────────────────
 * Invokes the Gateway `connection_test` and surfaces ONLY the sanitised result
 * (outcome, status category, model id, round-trip ms, timestamp, or a fixed
 * failure category). No provider internals are shown.
 *
 * ── Pre-AI notice (Req 20.5) ─────────────────────────────────────────────────
 * A persistent, visible notice states that event text will be sent to the
 * configured endpoint before any AI operation runs.
 *
 * Four UX states + accessibility mirror the sibling admin screens
 * ({@link import('./AdminEventEditor').AdminEventEditor},
 * {@link import('./ModerationQueue').ModerationQueue}; Req 24.5, 24.7, 25.4):
 * `.app-container` mobile-first layout, `.touch-target` controls, labelled
 * inputs (`htmlFor`/`id` via `useId`), `aria-invalid`/`aria-describedby` on
 * invalid fields, `role="status"` for progress and `role="alert"` for errors.
 *
 * Requirements traceability: 11.12, 11.13, 12.1, 12.10, 12.11, 13.1, 20.5, 25.7.
 * Design: Server-Side AI Gateway Design (Credential handling — Replace/Remove;
 * Connection test); Frontend Design (Protected-route strategy).
 */

/** Resolution state of the initial settings load (Req 24.7 four UX states). */
type LoadStatus = 'loading' | 'ready' | 'error';

/** Controlled form values. Numeric fields are strings until parsed on submit. */
interface FormValues {
  display_name: string;
  ai_enabled: boolean;
  provider_type: AiProviderType;
  base_url: string;
  chat_completions_path: string;
  auth_type: AiAuthType;
  api_key_header_name: string;
  model_id: string;
  temperature: string;
  max_output_tokens: string;
  request_timeout_seconds: string;
  tls_verify_required: boolean;
}

const EMPTY_FORM: FormValues = {
  display_name: '',
  ai_enabled: false,
  provider_type: 'openai_compatible',
  base_url: '',
  chat_completions_path: '/v1/chat/completions',
  auth_type: 'bearer',
  api_key_header_name: '',
  model_id: '',
  temperature: '0.2',
  max_output_tokens: '1024',
  request_timeout_seconds: '30',
  tls_verify_required: true,
};

/** Maps a loaded NON-SECRET settings row onto the controlled form values. */
function toFormValues(settings: AiProviderSettingsPublic): FormValues {
  return {
    display_name: settings.display_name,
    ai_enabled: settings.ai_enabled,
    provider_type: settings.provider_type,
    base_url: settings.base_url,
    chat_completions_path: settings.chat_completions_path,
    auth_type: settings.auth_type,
    api_key_header_name: settings.api_key_header_name ?? '',
    model_id: settings.model_id,
    temperature: String(settings.temperature),
    max_output_tokens: String(settings.max_output_tokens),
    request_timeout_seconds: String(settings.request_timeout_seconds),
    tls_verify_required: settings.tls_verify_required,
  };
}

/**
 * Parses a numeric text field to a number, or `NaN` when blank/invalid so the
 * shared schema surfaces the appropriate "must be a number/whole number" error.
 */
function toNumber(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return Number.NaN;
  return Number(trimmed);
}

/**
 * Builds the typed settings input from the controlled form values, including
 * the write-only `credential` ONLY when the admin entered one (Replace flow).
 * `api_key_header_name` is included only when the auth type needs it.
 */
function toSettingsInput(
  values: FormValues,
  credential: string,
): AiProviderSettingsInput {
  const input: AiProviderSettingsInput = {
    display_name: values.display_name.trim(),
    ai_enabled: values.ai_enabled,
    provider_type: values.provider_type,
    base_url: values.base_url.trim(),
    chat_completions_path: values.chat_completions_path.trim(),
    auth_type: values.auth_type,
    model_id: values.model_id.trim(),
    temperature: toNumber(values.temperature),
    max_output_tokens: toNumber(values.max_output_tokens),
    request_timeout_seconds: toNumber(values.request_timeout_seconds),
    tls_verify_required: values.tls_verify_required,
  };
  if (values.auth_type === 'api_key_header') {
    input.api_key_header_name = values.api_key_header_name.trim();
  }
  // Write-only: only include the credential when the admin typed one (Replace).
  if (credential.length > 0) {
    input.credential = credential;
  }
  return input;
}

/** Indexes field errors by field name for O(1) inline lookup (first wins). */
function indexFieldErrors(
  fields: readonly AiFieldError[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { field, message } of fields) {
    if (!(field in map)) map[field] = message;
  }
  return map;
}

/** Human-readable label for a connection-test outcome (sanitised). */
const OUTCOME_LABELS: Readonly<
  Record<ConnectionTestResult['outcome'], string>
> = {
  established: 'Connection established (provider reachable and compatible).',
  reachable_but_incompatible:
    'Provider reachable, but the structured-output check did not pass.',
  failed: 'Connection failed.',
};

/** Human-readable label for each sanitised failure category. */
const FAILURE_LABELS: Readonly<Record<string, string>> = {
  invalid_url_scheme: 'The endpoint URL scheme is not allowed.',
  timeout: 'The request timed out.',
  disallowed_destination: 'The endpoint destination is not permitted.',
  connection_error: 'A connection error occurred.',
  invalid_response: 'The provider did not return a usable response.',
};

/** Derived credential display state (Req 11.9) — presence only, never a value. */
type CredentialDisplayState = 'configured' | 'not_configured' | 'required';

/**
 * Derives the credential display state (Req 11.9): 'configured' when a
 * credential is stored; otherwise 'required' when the selected auth type needs
 * one (bearer / api_key_header) but none is stored; else 'not_configured'.
 */
function deriveCredentialDisplayState(
  storedState: 'configured' | 'not_configured' | null,
  authType: AiAuthType,
): CredentialDisplayState {
  if (storedState === 'configured') return 'configured';
  if (authType === 'none') return 'not_configured';
  return 'required';
}

const CREDENTIAL_STATE_LABELS: Readonly<
  Record<CredentialDisplayState, string>
> = {
  configured: 'A credential is configured.',
  not_configured: 'No credential is configured (this auth type needs none).',
  required: 'No credential is configured — one is required for this auth type.',
};

export function AiSettings(): JSX.Element {
  // Stable ids for label/inline-error association (Req 24.5).
  const displayNameId = useId();
  const aiEnabledId = useId();
  const providerTypeId = useId();
  const baseUrlId = useId();
  const chatPathId = useId();
  const authTypeId = useId();
  const apiKeyHeaderNameId = useId();
  const modelIdId = useId();
  const temperatureId = useId();
  const maxTokensId = useId();
  const timeoutId = useId();
  const tlsVerifyId = useId();
  const credentialId = useId();
  const reverifyPasswordId = useId();
  const formErrorId = useId();

  // Initial load (Req 24.7).
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storedCredentialState, setStoredCredentialState] = useState<
    'configured' | 'not_configured' | null
  >(null);
  const [hasExistingConfig, setHasExistingConfig] = useState(false);

  // Form.
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [credential, setCredential] = useState('');
  const [fieldErrors, setFieldErrors] = useState<AiFieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');

  // Connection test.
  const [testStatus, setTestStatus] = useState<
    'idle' | 'testing' | 'done' | 'error'
  >('idle');
  const [testResult, setTestResult] = useState<ConnectionTestResponse | null>(
    null,
  );
  const [testError, setTestError] = useState<string | null>(null);

  // Re-verify (300 s) gate + Remove confirmation.
  const [pendingAction, setPendingAction] = useState<'save' | 'remove' | null>(
    null,
  );
  const [needsReverify, setNeedsReverify] = useState(false);
  const [reverifyPassword, setReverifyPassword] = useState('');
  const [reverifyEmail, setReverifyEmail] = useState('');
  const [reverifyError, setReverifyError] = useState<string | null>(null);
  const [reverifying, setReverifying] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [credentialActionError, setCredentialActionError] = useState<
    string | null
  >(null);
  // Holds the validated input while a Save is paused for re-verification.
  const [pendingSaveInput, setPendingSaveInput] =
    useState<AiProviderSettingsInput | null>(null);

  const errorsByField = useMemo(
    () => indexFieldErrors(fieldErrors),
    [fieldErrors],
  );
  const isSaving = saveStatus === 'saving';
  const isTesting = testStatus === 'testing';

  const credentialDisplayState = deriveCredentialDisplayState(
    storedCredentialState,
    values.auth_type,
  );

  const loadSettings = useCallback(async (): Promise<void> => {
    setLoadStatus('loading');
    setLoadError(null);
    try {
      const settings = await readAiProviderSettings();
      if (settings) {
        setValues(toFormValues(settings));
        setStoredCredentialState(settings.credential_state);
        setHasExistingConfig(true);
      } else {
        setValues(EMPTY_FORM);
        setStoredCredentialState(null);
        setHasExistingConfig(false);
      }
      setLoadStatus('ready');
    } catch (error) {
      setLoadError(
        error instanceof AiClientError
          ? error.message
          : 'The AI settings could not be loaded. Please try again.',
      );
      setLoadStatus('error');
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  function update<K extends keyof FormValues>(
    key: K,
    value: FormValues[K],
  ): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Validates the form CLIENT-SIDE against the shared schema. On success returns
   * the typed input; on failure sets per-field inline errors and returns null.
   */
  function validateForm(): AiProviderSettingsInput | null {
    const input = toSettingsInput(values, credential);
    const parsed = aiProviderSettingsInputSchema.safeParse(input);
    if (parsed.success) {
      setFieldErrors([]);
      return parsed.data;
    }
    setFieldErrors(
      parsed.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? String(issue.path[0]) : '_root',
        message: issue.message,
      })),
    );
    setFormError('Please correct the highlighted fields and try again.');
    setSaveStatus('error');
    return null;
  }

  /** Performs the authoritative save via the (service-role) AI-config endpoint. */
  const performSave = useCallback(
    async (input: AiProviderSettingsInput): Promise<void> => {
      setSaveStatus('saving');
      setFormError(null);
      setFieldErrors([]);
      try {
        const saved = await saveAiProviderSettings(input);
        setValues(toFormValues(saved));
        setStoredCredentialState(saved.credential_state);
        setHasExistingConfig(true);
        setCredential('');
        setSaveStatus('saved');
      } catch (error) {
        if (error instanceof AiClientError) {
          if (error.fields.length > 0) setFieldErrors([...error.fields]);
          setFormError(error.message);
        } else {
          setFormError('The AI settings could not be saved. Please try again.');
        }
        setSaveStatus('error');
      }
    },
    [],
  );

  /** Performs the credential removal via the (service-role) AI-config endpoint. */
  const performRemove = useCallback(async (): Promise<void> => {
    setCredentialActionError(null);
    try {
      const updated = await removeAiCredential();
      if (updated) {
        setValues(toFormValues(updated));
        setStoredCredentialState(updated.credential_state);
      } else {
        setStoredCredentialState('not_configured');
      }
      setConfirmRemove(false);
    } catch (error) {
      setCredentialActionError(
        error instanceof AiClientError
          ? error.message
          : 'The credential could not be removed. Please try again.',
      );
    }
  }, []);

  /**
   * Gates a credential-affecting action (Save-with-credential or Remove) behind
   * the 300 s re-verify window (Req 11.12, 12.11). When recent, runs the action
   * immediately; otherwise opens the re-verify prompt and stores the pending
   * action to resume after a successful re-verify.
   */
  const gateCredentialSave = useCallback(
    async (input: AiProviderSettingsInput): Promise<void> => {
      const recent = await isSessionRecentlyVerified();
      if (recent) {
        await performSave(input);
        return;
      }
      setPendingAction('save');
      setPendingSaveInput(input);
      setNeedsReverify(true);
    },
    [performSave],
  );

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (isSaving) return;
    const input = validateForm();
    if (!input) return;

    // Replacing the credential (a credential was entered) requires the 300 s
    // re-verify gate; a settings-only save does not touch the credential.
    if (credential.length > 0) {
      await gateCredentialSave(input);
    } else {
      await performSave(input);
    }
  }

  /** Handles the Remove control: 300 s gate → explicit confirmation → remove. */
  async function handleRemoveClick(): Promise<void> {
    setCredentialActionError(null);
    const recent = await isSessionRecentlyVerified();
    if (!recent) {
      setPendingAction('remove');
      setNeedsReverify(true);
      return;
    }
    // Session is recent → require the explicit confirmation step (Req 11.13).
    setConfirmRemove(true);
  }

  /** Completes the re-verify prompt by re-signing-in, then resumes the action. */
  async function handleReverify(): Promise<void> {
    if (reverifying) return;
    setReverifying(true);
    setReverifyError(null);
    try {
      await signInWithPassword(reverifyEmail.trim(), reverifyPassword);
      setReverifyPassword('');
      setNeedsReverify(false);
      // Resume the gated action now that the session is freshly re-verified.
      if (pendingAction === 'save' && pendingSaveInput) {
        const input = pendingSaveInput;
        setPendingSaveInput(null);
        setPendingAction(null);
        await performSave(input);
      } else if (pendingAction === 'remove') {
        setPendingAction(null);
        setConfirmRemove(true); // still require explicit Remove confirmation.
      }
    } catch {
      setReverifyError(
        'Re-verification failed. Please check your email and password.',
      );
    } finally {
      setReverifying(false);
    }
  }

  async function handleConnectionTest(): Promise<void> {
    if (isTesting) return;
    setTestStatus('testing');
    setTestError(null);
    setTestResult(null);
    try {
      const response = await runConnectionTest();
      setTestResult(response);
      setTestStatus('done');
    } catch (error) {
      setTestError(
        error instanceof AiClientError
          ? error.message
          : 'The connection test could not be completed. Please try again.',
      );
      setTestStatus('error');
    }
  }

  // ---- LOADING state (Req 24.7) --------------------------------------------
  if (loadStatus === 'loading') {
    return (
      <main className="app-container py-8">
        <h1 className="text-2xl font-semibold text-ink">AI settings</h1>
        <p role="status" aria-live="polite" className="mt-4 text-ink-muted">
          Loading AI settings…
        </p>
      </main>
    );
  }

  // ---- ERROR (load) state (Req 24.7) ---------------------------------------
  if (loadStatus === 'error') {
    return (
      <main className="app-container py-8">
        <h1 className="text-2xl font-semibold text-ink">AI settings</h1>
        <p role="alert" className="mt-4 text-ink">
          {loadError}
        </p>
        <button
          type="button"
          onClick={() => void loadSettings()}
          className="touch-target mt-4 rounded bg-focus px-4 py-2 font-medium text-surface"
        >
          Retry
        </button>
      </main>
    );
  }

  const displayNameError = errorsByField.display_name;
  const baseUrlError = errorsByField.base_url;
  const chatPathError = errorsByField.chat_completions_path;
  const apiKeyHeaderNameError = errorsByField.api_key_header_name;
  const modelIdError = errorsByField.model_id;
  const temperatureError = errorsByField.temperature;
  const maxTokensError = errorsByField.max_output_tokens;
  const timeoutError = errorsByField.request_timeout_seconds;
  const credentialError = errorsByField.credential;

  return (
    <main className="app-container py-8">
      <h1 className="text-2xl font-semibold text-ink">AI settings</h1>
      <p className="mt-2 text-ink-muted">
        Configure the single AI provider used for categorisation, clustering,
        theme insights and end-of-event summaries.
      </p>

      {/* Pre-AI data notice (Req 20.5): always visible, before any AI op. */}
      <p
        role="note"
        className="mt-4 rounded border border-ink-muted bg-surface p-3 text-ink"
      >
        <strong>Note:</strong> before any AI operation runs, the relevant event
        text (question text and aggregate metadata — never participant
        identifiers) is sent to the configured provider endpoint. Only enable AI
        for endpoints you trust with this data.
      </p>

      <form
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
      >
        {/* Display name */}
        <div className="flex flex-col gap-1">
          <label htmlFor={displayNameId} className="font-medium text-ink">
            Display name
          </label>
          <input
            id={displayNameId}
            name="display_name"
            type="text"
            value={values.display_name}
            onChange={(e) => update('display_name', e.target.value)}
            disabled={isSaving}
            aria-invalid={displayNameError ? true : undefined}
            aria-describedby={
              displayNameError ? `${displayNameId}-error` : undefined
            }
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {displayNameError ? (
            <p id={`${displayNameId}-error`} role="alert" className="text-ink">
              {displayNameError}
            </p>
          ) : null}
        </div>

        {/* AI enabled */}
        <div className="flex items-center gap-2">
          <input
            id={aiEnabledId}
            name="ai_enabled"
            type="checkbox"
            checked={values.ai_enabled}
            onChange={(e) => update('ai_enabled', e.target.checked)}
            disabled={isSaving}
            className="touch-target"
          />
          <label htmlFor={aiEnabledId} className="font-medium text-ink">
            AI features enabled
          </label>
        </div>

        {/* Provider type */}
        <div className="flex flex-col gap-1">
          <label htmlFor={providerTypeId} className="font-medium text-ink">
            Provider type
          </label>
          <select
            id={providerTypeId}
            name="provider_type"
            value={values.provider_type}
            onChange={(e) =>
              update('provider_type', e.target.value as AiProviderType)
            }
            disabled={isSaving}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          >
            <option value="openai_compatible">OpenAI-compatible</option>
            <option value="custom_adapter">Custom adapter</option>
          </select>
        </div>

        {/* Base URL */}
        <div className="flex flex-col gap-1">
          <label htmlFor={baseUrlId} className="font-medium text-ink">
            Base URL
          </label>
          <input
            id={baseUrlId}
            name="base_url"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://api.example.com"
            value={values.base_url}
            onChange={(e) => update('base_url', e.target.value)}
            disabled={isSaving}
            aria-invalid={baseUrlError ? true : undefined}
            aria-describedby={baseUrlError ? `${baseUrlId}-error` : undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {baseUrlError ? (
            <p id={`${baseUrlId}-error`} role="alert" className="text-ink">
              {baseUrlError}
            </p>
          ) : null}
        </div>

        {/* Chat completions path */}
        <div className="flex flex-col gap-1">
          <label htmlFor={chatPathId} className="font-medium text-ink">
            Chat-completions path
          </label>
          <input
            id={chatPathId}
            name="chat_completions_path"
            type="text"
            autoComplete="off"
            value={values.chat_completions_path}
            onChange={(e) => update('chat_completions_path', e.target.value)}
            disabled={isSaving}
            aria-invalid={chatPathError ? true : undefined}
            aria-describedby={chatPathError ? `${chatPathId}-error` : undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {chatPathError ? (
            <p id={`${chatPathId}-error`} role="alert" className="text-ink">
              {chatPathError}
            </p>
          ) : null}
        </div>

        {/* Auth type */}
        <div className="flex flex-col gap-1">
          <label htmlFor={authTypeId} className="font-medium text-ink">
            Authentication type
          </label>
          <select
            id={authTypeId}
            name="auth_type"
            value={values.auth_type}
            onChange={(e) => update('auth_type', e.target.value as AiAuthType)}
            disabled={isSaving}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          >
            <option value="bearer">Bearer token</option>
            <option value="api_key_header">API key header</option>
            <option value="none">None</option>
          </select>
        </div>

        {/* API key header name — conditional on auth_type === 'api_key_header' */}
        {values.auth_type === 'api_key_header' ? (
          <div className="flex flex-col gap-1">
            <label
              htmlFor={apiKeyHeaderNameId}
              className="font-medium text-ink"
            >
              API-key header name
            </label>
            <input
              id={apiKeyHeaderNameId}
              name="api_key_header_name"
              type="text"
              autoComplete="off"
              placeholder="x-api-key"
              value={values.api_key_header_name}
              onChange={(e) => update('api_key_header_name', e.target.value)}
              disabled={isSaving}
              aria-invalid={apiKeyHeaderNameError ? true : undefined}
              aria-describedby={
                apiKeyHeaderNameError
                  ? `${apiKeyHeaderNameId}-error`
                  : undefined
              }
              className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
            />
            {apiKeyHeaderNameError ? (
              <p
                id={`${apiKeyHeaderNameId}-error`}
                role="alert"
                className="text-ink"
              >
                {apiKeyHeaderNameError}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Model id */}
        <div className="flex flex-col gap-1">
          <label htmlFor={modelIdId} className="font-medium text-ink">
            Model id
          </label>
          <input
            id={modelIdId}
            name="model_id"
            type="text"
            autoComplete="off"
            value={values.model_id}
            onChange={(e) => update('model_id', e.target.value)}
            disabled={isSaving}
            aria-invalid={modelIdError ? true : undefined}
            aria-describedby={modelIdError ? `${modelIdId}-error` : undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {modelIdError ? (
            <p id={`${modelIdId}-error`} role="alert" className="text-ink">
              {modelIdError}
            </p>
          ) : null}
        </div>

        {/* Temperature */}
        <div className="flex flex-col gap-1">
          <label htmlFor={temperatureId} className="font-medium text-ink">
            Temperature
          </label>
          <input
            id={temperatureId}
            name="temperature"
            type="number"
            inputMode="decimal"
            step="0.01"
            min={0}
            max={2}
            value={values.temperature}
            onChange={(e) => update('temperature', e.target.value)}
            disabled={isSaving}
            aria-invalid={temperatureError ? true : undefined}
            aria-describedby={
              temperatureError ? `${temperatureId}-error` : undefined
            }
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {temperatureError ? (
            <p id={`${temperatureId}-error`} role="alert" className="text-ink">
              {temperatureError}
            </p>
          ) : null}
        </div>

        {/* Max output tokens */}
        <div className="flex flex-col gap-1">
          <label htmlFor={maxTokensId} className="font-medium text-ink">
            Max output tokens
          </label>
          <input
            id={maxTokensId}
            name="max_output_tokens"
            type="number"
            inputMode="numeric"
            step="1"
            min={1}
            max={128000}
            value={values.max_output_tokens}
            onChange={(e) => update('max_output_tokens', e.target.value)}
            disabled={isSaving}
            aria-invalid={maxTokensError ? true : undefined}
            aria-describedby={
              maxTokensError ? `${maxTokensId}-error` : undefined
            }
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {maxTokensError ? (
            <p id={`${maxTokensId}-error`} role="alert" className="text-ink">
              {maxTokensError}
            </p>
          ) : null}
        </div>

        {/* Request timeout seconds */}
        <div className="flex flex-col gap-1">
          <label htmlFor={timeoutId} className="font-medium text-ink">
            Request timeout (seconds)
          </label>
          <input
            id={timeoutId}
            name="request_timeout_seconds"
            type="number"
            inputMode="numeric"
            step="1"
            min={1}
            max={300}
            value={values.request_timeout_seconds}
            onChange={(e) => update('request_timeout_seconds', e.target.value)}
            disabled={isSaving}
            aria-invalid={timeoutError ? true : undefined}
            aria-describedby={timeoutError ? `${timeoutId}-error` : undefined}
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {timeoutError ? (
            <p id={`${timeoutId}-error`} role="alert" className="text-ink">
              {timeoutError}
            </p>
          ) : null}
        </div>

        {/* TLS verify required */}
        <div className="flex items-center gap-2">
          <input
            id={tlsVerifyId}
            name="tls_verify_required"
            type="checkbox"
            checked={values.tls_verify_required}
            onChange={(e) => update('tls_verify_required', e.target.checked)}
            disabled={isSaving}
            className="touch-target"
          />
          <label htmlFor={tlsVerifyId} className="font-medium text-ink">
            Require TLS certificate verification
          </label>
        </div>

        {/* ── Write-only credential section (Req 12.1, 12.10, 12.11) ────── */}
        <fieldset className="mt-2 flex flex-col gap-2 rounded border border-ink-muted p-3">
          <legend className="px-1 font-medium text-ink">Credential</legend>

          {/* Presence-only state — NEVER the value (Req 11.9, 12.1, 12.10). */}
          <p role="status" className="text-ink">
            {CREDENTIAL_STATE_LABELS[credentialDisplayState]}
          </p>

          <label htmlFor={credentialId} className="font-medium text-ink">
            Enter credential to replace{' '}
            <span className="text-ink-muted">
              (write-only — never displayed)
            </span>
          </label>
          <input
            id={credentialId}
            name="credential"
            type="password"
            autoComplete="new-password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            disabled={isSaving || values.auth_type === 'none'}
            aria-invalid={credentialError ? true : undefined}
            aria-describedby={
              credentialError ? `${credentialId}-error` : undefined
            }
            className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
          />
          {credentialError ? (
            <p id={`${credentialId}-error`} role="alert" className="text-ink">
              {credentialError}
            </p>
          ) : null}
          <p className="text-ink-muted">
            Saving with a credential entered will replace the stored credential.
            Replacing or removing a credential requires a session verified
            within the last {CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS} seconds.
          </p>

          {/* Remove control (Req 11.13 — explicit confirmation). */}
          {storedCredentialState === 'configured' ? (
            <div className="flex flex-col gap-2">
              {!confirmRemove ? (
                <button
                  type="button"
                  onClick={() => void handleRemoveClick()}
                  className="touch-target rounded border border-ink px-4 py-2 font-medium text-ink"
                >
                  Remove credential
                </button>
              ) : (
                <div
                  role="alertdialog"
                  aria-label="Confirm credential removal"
                  className="flex flex-col gap-2 rounded border border-ink p-3"
                >
                  <p className="text-ink">
                    Remove the stored credential? AI operations that need it
                    will stop working until a new credential is configured.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void performRemove()}
                      className="touch-target rounded bg-focus px-4 py-2 font-medium text-surface"
                    >
                      Confirm remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(false)}
                      className="touch-target rounded border border-ink-muted px-4 py-2 font-medium text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {credentialActionError ? (
                <p role="alert" className="text-ink">
                  {credentialActionError}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        {/* Re-verify prompt (300 s gate — Req 11.12, 12.11). */}
        {needsReverify ? (
          <div
            role="alertdialog"
            aria-label="Re-verify your session"
            className="flex flex-col gap-2 rounded border border-ink p-3"
          >
            <p className="text-ink">
              Your session is older than{' '}
              {CREDENTIAL_ACTION_REVERIFY_WINDOW_SECONDS} seconds. Re-enter your
              password to continue with this credential change.
            </p>
            <label htmlFor={`${reverifyPasswordId}-email`} className="text-ink">
              Email
            </label>
            <input
              id={`${reverifyPasswordId}-email`}
              type="email"
              autoComplete="email"
              value={reverifyEmail}
              onChange={(e) => setReverifyEmail(e.target.value)}
              className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
            />
            <label htmlFor={reverifyPasswordId} className="text-ink">
              Password
            </label>
            <input
              id={reverifyPasswordId}
              type="password"
              autoComplete="current-password"
              value={reverifyPassword}
              onChange={(e) => setReverifyPassword(e.target.value)}
              className="touch-target rounded border border-ink-muted px-3 py-2 text-ink"
            />
            {reverifyError ? (
              <p role="alert" className="text-ink">
                {reverifyError}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={reverifying}
                aria-busy={reverifying}
                onClick={() => void handleReverify()}
                className="touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60"
              >
                {reverifying ? 'Verifying…' : 'Re-verify'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNeedsReverify(false);
                  setPendingAction(null);
                  setPendingSaveInput(null);
                  setReverifyPassword('');
                }}
                className="touch-target rounded border border-ink-muted px-4 py-2 font-medium text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {/* Form-level error / success (Req 24.7). */}
        {saveStatus === 'error' && formError ? (
          <p id={formErrorId} role="alert" className="text-ink">
            {formError}
          </p>
        ) : null}
        {saveStatus === 'saved' ? (
          <p role="status" aria-live="polite" className="text-ink">
            AI settings saved.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSaving}
          aria-busy={isSaving}
          className="touch-target rounded bg-focus px-4 py-2 font-medium text-surface disabled:opacity-60"
        >
          {isSaving
            ? 'Saving…'
            : hasExistingConfig
              ? 'Save AI settings'
              : 'Create AI settings'}
        </button>
        {isSaving ? (
          <span role="status" aria-live="polite" className="text-ink-muted">
            Saving AI settings…
          </span>
        ) : null}
      </form>

      {/* ── Connection test (Req 13.1, 25.7) ──────────────────────────────── */}
      <section aria-labelledby={`${formErrorId}-test`} className="mt-8">
        <h2 id={`${formErrorId}-test`} className="text-lg font-medium text-ink">
          Connection test
        </h2>
        <p className="mt-1 text-ink-muted">
          Sends a minimal, non-sensitive probe to the configured endpoint and
          reports only a sanitised result.
        </p>
        <button
          type="button"
          onClick={() => void handleConnectionTest()}
          disabled={isTesting}
          aria-busy={isTesting}
          className="touch-target mt-3 rounded border border-ink px-4 py-2 font-medium text-ink disabled:opacity-60"
        >
          {isTesting ? 'Testing…' : 'Run connection test'}
        </button>

        {isTesting ? (
          <p role="status" aria-live="polite" className="mt-3 text-ink-muted">
            Running connection test…
          </p>
        ) : null}

        {testStatus === 'error' && testError ? (
          <p role="alert" className="mt-3 text-ink">
            {testError}
          </p>
        ) : null}

        {testStatus === 'done' && testResult ? (
          testResult.available ? (
            <dl role="status" aria-live="polite" className="mt-3 text-ink">
              <div className="flex flex-col">
                <dt className="font-medium">Outcome</dt>
                <dd>{OUTCOME_LABELS[testResult.result.outcome]}</dd>
              </div>
              {testResult.result.failure_category ? (
                <div className="mt-2 flex flex-col">
                  <dt className="font-medium">Reason</dt>
                  <dd>
                    {FAILURE_LABELS[testResult.result.failure_category] ??
                      'The connection test failed.'}
                  </dd>
                </div>
              ) : null}
              {testResult.result.status_category ? (
                <div className="mt-2 flex flex-col">
                  <dt className="font-medium">Status category</dt>
                  <dd>{testResult.result.status_category}</dd>
                </div>
              ) : null}
              <div className="mt-2 flex flex-col">
                <dt className="font-medium">Model</dt>
                <dd>{testResult.result.model_id}</dd>
              </div>
              {testResult.result.round_trip_ms !== null ? (
                <div className="mt-2 flex flex-col">
                  <dt className="font-medium">Round-trip</dt>
                  <dd>{testResult.result.round_trip_ms} ms</dd>
                </div>
              ) : null}
              <div className="mt-2 flex flex-col">
                <dt className="font-medium">Tested at</dt>
                <dd>{testResult.result.timestamp}</dd>
              </div>
            </dl>
          ) : (
            <p role="status" aria-live="polite" className="mt-3 text-ink">
              {testResult.unavailable.message}
            </p>
          )
        ) : null}
      </section>
    </main>
  );
}

export default AiSettings;
