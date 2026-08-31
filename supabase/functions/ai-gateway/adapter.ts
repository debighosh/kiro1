// =============================================================================
// AI GATEWAY — PROVIDER ADAPTER LAYER (Supabase Edge Functions / Deno runtime)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module is the provider-agnostic ADAPTER LAYER of the Server-Side AI
//  Gateway (Req 11.3, 16.1). It normalises the differences between AI providers
//  behind a SINGLE interface so the Gateway core (`gateway.ts`) never has to know
//  which provider it is talking to. It ships two things:
//
//    1. A first-class `openai_compatible` adapter that constructs and performs an
//       OpenAI-style chat-completions call from the resolved, non-secret provider
//       config (Req 11.3). It requests NATIVE JSON MODE
//       (`response_format: { type: 'json_object' }`) — the model supports it —
//       AND instructs JSON output IN-PROMPT as a fallback, then extracts the
//       candidate JSON from the assistant text server-side (Req 14.1, 14.3).
//    2. A documented `custom_adapter` EXTENSION POINT — a clearly-marked seam a
//       deployment overrides to talk to a provider whose wire shape is not
//       OpenAI-compatible. Out of the box it fails closed with a sanitised
//       "custom adapter not configured" error; a deployment registers its own
//       implementation via {@link registerCustomAdapter}.
//
//  WHAT THIS TASK DOES (29.3) AND DOES NOT DO:
//    - DOES: build the chat-completions request, apply auth per `auth_type`,
//      perform the outbound fetch through the SSRF-pinned `fetch` supplied by the
//      caller, map the HTTP status to a coarse `statusCategory`, measure the
//      round-trip, and return the RAW assistant text.
//    - DOES NOT: validate the structured-output contract / Zod schema — that is
//      task 29.4, which wraps `callChatCompletion`. Here we only surface the raw
//      assistant text (plus a best-effort extracted JSON candidate) so the
//      validator has something to check.
//
//  PRIVACY / LEAK-PROOFING (Req 13.10, 20.7):
//    - The credential is used ONLY to build the auth header and is NEVER logged.
//    - Provider response HEADERS, the raw error BODY, and any provider diagnostic
//      NEVER escape this module. On a non-2xx status we surface ONLY the coarse
//      status category; on a transport error we throw a generic
//      {@link ProviderCallError}. The caller (`gateway.ts`) further collapses
//      everything to a fixed sanitised category before it reaches the client.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` and the
//  runtime `fetch` are resolved by the Supabase Edge Functions / Deno toolchain.
//
//  Requirements traceability: 11.3, 13.7, 13.8, 13.10, 13.12, 14.1, 14.3, 16.1.
//  Design references: Server-Side AI Gateway Design (provider-agnostic adapter;
//  openai_compatible adapter; custom_adapter extension point; Structured output
//  validation — native JSON mode vs in-prompt JSON extraction).
// =============================================================================

import type {
  ActiveProviderConfig,
  MinimalPayload,
  ProviderCallResult,
} from './gateway.ts';

// -----------------------------------------------------------------------------
// Provider-agnostic adapter interface.
//
// Every adapter is a single async function with the SAME shape. The Gateway core
// resolves the right adapter from `config.providerType` and calls it with:
//   - the non-secret provider `config` (base URL, path, auth type, model, …),
//   - the minimal, identifier-free `payload` (Req 20.1, 20.3),
//   - the resolved `credential` (or `undefined` when auth_type = 'none'); used
//     ONLY to build the auth header, never logged,
//   - a `fetchImpl` — the SSRF-PINNED fetch (see `createPinnedFetch` in
//     ./ssrf.ts) that dials the SSRF-validated IP while preserving the SNI
//     hostname (Req 13.7, 13.8, 13.12); an adapter MUST use this, not the global
//     `fetch`, so the connection stays pinned to the checked address,
//   - the hard-timeout `signal` so an in-flight request is cancelled on timeout.
//
// The adapter returns a {@link ProviderCallResult} (raw assistant text + coarse
// status category + round-trip ms) — NEVER provider headers or raw bodies.
// -----------------------------------------------------------------------------

export interface ProviderAdapter {
  (
    config: ActiveProviderConfig,
    payload: MinimalPayload,
    credential: string | undefined,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
  ): Promise<ProviderCallResult>;
}

/**
 * Raised for ANY provider transport/shape failure that is not itself a
 * recognisable timeout/SSRF error. It carries NO provider diagnostic, header,
 * body, or credential — only a fixed, credential-free message. `gateway.ts`
 * maps it to the sanitised `provider_error` category (Req 13.10, 20.7).
 */
export class ProviderCallError extends Error {
  constructor(message = 'The AI provider returned an error.') {
    super(message);
    this.name = 'ProviderCallError';
  }
}

/**
 * Raised when the active config selects `custom_adapter` but no custom adapter
 * has been registered by the deployment. Fails closed with a sanitised message;
 * `gateway.ts` collapses it to `provider_error` (never leaks that a custom
 * adapter was even expected beyond this generic text).
 */
export class CustomAdapterNotConfiguredError extends ProviderCallError {
  constructor() {
    super('The AI provider is not configured.');
    this.name = 'CustomAdapterNotConfiguredError';
  }
}

// -----------------------------------------------------------------------------
// HTTP status → coarse category (Req 13.2, 13.10).
//
// The ONLY status signal that ever leaves the adapter is this coarse bucket —
// never the exact code, reason phrase, or body. 1xx (unexpected for a completed
// fetch) is bucketed with 2xx as a non-error informational class.
// -----------------------------------------------------------------------------

export function categoriseStatus(status: number): ProviderCallResult['statusCategory'] {
  if (status >= 500) {
    return '5xx';
  }
  if (status >= 400) {
    return '4xx';
  }
  if (status >= 300) {
    return '3xx';
  }
  return '2xx';
}

// -----------------------------------------------------------------------------
// Candidate-JSON extraction (Req 14.3).
//
// When a provider lacks a native JSON mode we ask for JSON in the prompt and then
// have to pull the JSON object out of a possibly-chatty assistant message (it may
// wrap the object in prose or a ```json fenced block). This is a BEST-EFFORT
// extraction only: it returns the assistant text unchanged if it already looks
// like a bare JSON object, otherwise it returns the substring between the first
// balanced `{` … `}` (ignoring braces inside strings). The Gateway's validator
// (task 29.4) is the authority on whether the extracted text actually satisfies
// the schema — this function NEVER decides validity, it only narrows the text.
// -----------------------------------------------------------------------------

export function extractCandidateJson(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }
  // Already a bare JSON object/array → return as-is.
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed;
  }

  // Otherwise scan for the first balanced `{...}` object, tracking string state
  // so braces inside string literals don't unbalance the count.
  const start = trimmed.indexOf('{');
  if (start === -1) {
    return trimmed;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  // Unbalanced — hand back the original trimmed text; the validator will reject.
  return trimmed;
}

// -----------------------------------------------------------------------------
// Auth-header construction (Req 11.5, 12.7).
//
// Applies the outbound auth scheme from `auth_type`. The credential is READ here
// ONLY to compose the header value and is never persisted or logged. When no
// credential is present (auth_type = 'none', or a required credential was
// resolved to `undefined`) no auth header is added.
//   - bearer         → Authorization: Bearer <credential>
//   - api_key_header → <apiKeyHeaderName>: <credential>
//   - none           → (no auth header)
// -----------------------------------------------------------------------------

export function buildAuthHeaders(
  config: Pick<ActiveProviderConfig, 'authType' | 'apiKeyHeaderName'>,
  credential: string | undefined,
): Record<string, string> {
  if (config.authType === 'none' || credential === undefined) {
    return {};
  }
  if (config.authType === 'bearer') {
    return { Authorization: `Bearer ${credential}` };
  }
  if (config.authType === 'api_key_header') {
    const headerName = config.apiKeyHeaderName?.trim();
    if (!headerName) {
      // Misconfiguration: api_key_header selected but no header name. Fail closed
      // rather than silently sending the credential under a wrong/empty header.
      throw new ProviderCallError('The AI provider is not configured.');
    }
    return { [headerName]: credential };
  }
  return {};
}

// -----------------------------------------------------------------------------
// Prompt / chat-completions body construction.
//
// The Gateway sends only the minimal, identifier-free payload (Req 20.1, 20.3).
// This builder turns it into an OpenAI chat-completions body:
//   - a SYSTEM message that instructs strict JSON-only output (the IN-PROMPT
//     JSON fallback for providers/paths without native JSON mode, Req 14.3),
//   - a USER message carrying the truncated question texts + aggregate metadata,
//   - the model / temperature / max_tokens from config, and
//   - `response_format: { type: 'json_object' }` to request NATIVE JSON MODE
//     (Req 14.1) — the openai_compatible provider supports it.
// The per-job-type prompt specialisation (categorisation, clustering, …) is
// layered on by tasks 30.1/31.1/… ; this generic body is the transport-level
// shape the adapter always produces.
// -----------------------------------------------------------------------------

/** OpenAI chat-completions message shape. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** The OpenAI chat-completions request body this adapter constructs. */
export interface ChatCompletionsBody {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly max_tokens: number;
  readonly response_format: { readonly type: 'json_object' };
}

/** System instruction: strict JSON output — the in-prompt fallback (Req 14.3). */
export const JSON_SYSTEM_INSTRUCTION =
  'You are a JSON API. Respond with a single valid JSON object only. ' +
  'Do not include prose, explanations, or markdown code fences.';

export function buildChatCompletionsBody(
  config: Pick<
    ActiveProviderConfig,
    'modelId' | 'temperature' | 'maxOutputTokens'
  >,
  payload: MinimalPayload,
): ChatCompletionsBody {
  // The user message is a compact, non-identifying description of the batch.
  // Only truncated question texts + aggregate metadata appear (Req 20.1, 20.3).
  const userContent = JSON.stringify({
    questions: payload.questionTexts,
    aggregate_metadata: payload.aggregateMetadata,
  });

  return {
    model: config.modelId,
    messages: [
      { role: 'system', content: JSON_SYSTEM_INSTRUCTION },
      { role: 'user', content: userContent },
    ],
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    // Native JSON mode (Req 14.1). The in-prompt system instruction above is the
    // fallback for providers/paths that ignore this field (Req 14.3).
    response_format: { type: 'json_object' },
  };
}

// -----------------------------------------------------------------------------
// Assistant-text extraction from an OpenAI chat-completions response.
//
// Pulls `choices[0].message.content`. We are DELIBERATELY defensive and treat any
// unexpected shape as "no text" (empty string) rather than throwing on the
// provider's payload — the validator (task 29.4) turns an empty/invalid body into
// a validation failure. We never surface the raw response object.
// -----------------------------------------------------------------------------

export function extractAssistantText(responseJson: unknown): string {
  if (responseJson == null || typeof responseJson !== 'object') {
    return '';
  }
  const choices = (responseJson as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const first = choices[0];
  if (first == null || typeof first !== 'object') {
    return '';
  }
  const message = (first as { message?: unknown }).message;
  if (message == null || typeof message !== 'object') {
    return '';
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

// -----------------------------------------------------------------------------
// First-class `openai_compatible` adapter.
//
// POSTs the chat-completions body to `baseUrl + chatCompletionsPath` through the
// SSRF-pinned `fetchImpl`, applying auth per `auth_type`. On a completed response
// it returns { text, statusCategory, roundTripMs }; on a non-2xx status it STILL
// returns the (best-effort) text with the coarse category so the caller can
// decide whether to retry (task 29.4) — but NEVER the provider's error body or
// headers. A transport failure / aborted signal surfaces as a generic
// {@link ProviderCallError} (the timeout AbortError propagates so the core maps
// it to `timeout`).
// -----------------------------------------------------------------------------

export const openAiCompatibleAdapter: ProviderAdapter = async (
  config,
  payload,
  credential,
  fetchImpl,
  signal,
) => {
  const url = config.baseUrl + config.chatCompletionsPath;
  const body = buildChatCompletionsBody(config, payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...buildAuthHeaders(config, credential),
  };

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Re-throw an abort (timeout) so the core can classify it as `timeout`;
    // everything else collapses to a generic provider error with NO diagnostic.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    if (
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    ) {
      throw err;
    }
    throw new ProviderCallError();
  }

  const statusCategory = categoriseStatus(response.status);
  const roundTripMs = Date.now() - startedAt;

  // Read the body as text defensively; we parse JSON ourselves so a malformed
  // body becomes empty text (a validation failure downstream) rather than a
  // thrown parse error that could carry the raw body into a stack trace.
  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    rawText = '';
  }

  let assistantText = '';
  if (rawText.length > 0) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      assistantText = extractAssistantText(parsed);
    } catch {
      // Body was not JSON — leave assistantText empty; the validator rejects it.
      assistantText = '';
    }
  }

  // Server-side candidate-JSON extraction (Req 14.3): narrow chatty text to the
  // JSON object where possible. Validity is decided later (task 29.4).
  const text = extractCandidateJson(assistantText);

  return { text, statusCategory, roundTripMs };
};

// -----------------------------------------------------------------------------
// `custom_adapter` EXTENSION POINT (Req 11.3, 16.1).
//
// Some deployments front an AI provider whose wire protocol is NOT
// OpenAI-compatible (different body shape, auth, or response envelope). Rather
// than baking every provider into the Gateway, we expose a single overridable
// seam: a deployment implements the {@link ProviderAdapter} contract and
// registers it here. The registered adapter receives the EXACT same arguments as
// the built-in one — including the SSRF-pinned `fetchImpl` it MUST use for its
// outbound call (Req 13.7, 13.8, 13.12) — and MUST obey the same leak-proofing
// rules: return only { text, statusCategory, roundTripMs }; never surface
// provider headers, bodies, or the credential (Req 13.10, 20.7).
//
// Registration is process-wide (an Edge Function instance). A deployment wires it
// once at module load (e.g. from its own `custom-adapter.ts` imported by
// `index.ts`). Until then the seam FAILS CLOSED: selecting `custom_adapter`
// without a registration throws {@link CustomAdapterNotConfiguredError}, so no
// half-configured or unauthenticated call is ever made.
//
// Example (in a deployment-owned module, imported before the first request):
//
//     import { registerCustomAdapter } from './adapter.ts';
//     registerCustomAdapter(async (config, payload, credential, fetchImpl, signal) => {
//       const res = await fetchImpl(config.baseUrl + config.chatCompletionsPath, {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json', ...myAuth(credential) },
//         body: JSON.stringify(myProviderBody(config, payload)),
//         signal,
//       });
//       const category = categoriseStatus(res.status);
//       const text = extractCandidateJson(myExtractText(await res.text()));
//       return { text, statusCategory: category, roundTripMs: /* measured */ 0 };
//     });
// -----------------------------------------------------------------------------

let registeredCustomAdapter: ProviderAdapter | null = null;

/** Registers (or replaces) the deployment's custom provider adapter. */
export function registerCustomAdapter(adapter: ProviderAdapter): void {
  registeredCustomAdapter = adapter;
}

/** Clears any registered custom adapter (primarily for tests). */
export function clearCustomAdapter(): void {
  registeredCustomAdapter = null;
}

/**
 * The `custom_adapter` dispatch. Delegates to the deployment-registered adapter
 * when present, else fails closed with {@link CustomAdapterNotConfiguredError}.
 */
export const customAdapter: ProviderAdapter = (
  config,
  payload,
  credential,
  fetchImpl,
  signal,
) => {
  if (registeredCustomAdapter == null) {
    throw new CustomAdapterNotConfiguredError();
  }
  return registeredCustomAdapter(config, payload, credential, fetchImpl, signal);
};

// -----------------------------------------------------------------------------
// Adapter resolution — the provider-agnostic dispatch entry point.
//
// Maps `config.providerType` to the concrete adapter. This is the ONE place that
// knows the set of provider types; `gateway.ts` calls {@link resolveAdapter}
// (or the higher-level {@link callChatCompletion}) and never branches on type.
// -----------------------------------------------------------------------------

export function resolveAdapter(
  providerType: ActiveProviderConfig['providerType'],
): ProviderAdapter {
  switch (providerType) {
    case 'openai_compatible':
      return openAiCompatibleAdapter;
    case 'custom_adapter':
      return customAdapter;
    default: {
      // Exhaustiveness guard: a new provider type must add a case above.
      const _exhaustive: never = providerType;
      void _exhaustive;
      throw new ProviderCallError('The AI provider is not configured.');
    }
  }
}

// -----------------------------------------------------------------------------
// High-level entry point used by the Gateway core's `callProvider` seam.
//
// Resolves the adapter for the config's provider type and invokes it with the
// SSRF-pinned `fetchImpl` and the hard-timeout `signal`. This is the single
// function `gateway.ts` needs to call to perform the outbound provider request;
// the return value is the RAW assistant text + coarse status + round-trip ms
// (structured-output validation is task 29.4).
// -----------------------------------------------------------------------------

export function callChatCompletion(
  config: ActiveProviderConfig,
  payload: MinimalPayload,
  credential: string | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ProviderCallResult> {
  const adapter = resolveAdapter(config.providerType);
  return adapter(config, payload, credential, fetchImpl, signal);
}
