// =============================================================================
// EDGE FUNCTION: ai-gateway — the single server-side AI egress (Deno runtime)
// =============================================================================
//
// The AI Gateway is the ONE and ONLY path from MSS LivePulse to any AI provider
// (Req 11, 20). Every AI operation — categorisation, clustering, theme insights,
// end-of-event summary, and the connection test — enters here. The SPA never
// talks to a provider directly; it calls this JWT-verified, service-role Edge
// Function with the administrator's Supabase access token in the
// `Authorization: Bearer <jwt>` header.
//
// This file is the HTTP handler; the invariant-bearing core (enablement
// precondition, credential resolve/discard, minimal-payload build, hard timeout,
// `ai_jobs` lifecycle logging, and the `callProvider` seam) lives in
// `./gateway.ts`. It mirrors the shape of `moderate-question/index.ts`:
//   1. CORS preflight via `handlePreflight`; POST only (else 405).
//   2. `resolveAuthenticatedUser(req)` — verify the admin JWT; no user → 401.
//      For V1 any authenticated user is an admin (Req 10.3, 20.4); a non-admin
//      is rejected with an insufficient-privileges error once roles exist.
//   3. zod-validate the JSON body { job_type, event_id?, question_texts?,
//      aggregate_metadata? }; invalid → 400 with per-field errors (Req 1.2).
//   4. Load the SINGLE active `ai_provider_settings` row via the service role.
//   5. Evaluate the AI enablement precondition (Req 11.1, 11.9, 12.3, 12.5,
//      12.6, 19.1). If degraded → return the sanitised "AI unavailable" /
//      not-configured state WITHOUT any outbound call.
//   6. Otherwise insert an `ai_jobs` row (pending) and run one attempt: resolve
//      the credential in-process, call the provider under the hard timeout, then
//      discard the plaintext (Req 12.7, 14.5); log succeeded/failed (Req 20.6,
//      20.7). The provider call itself is a seam completed by task 29.3.
//
// No error path leaks provider internals, credentials, or full prompt text
// (Req 12.9, 13.10, 20.7). This is Deno / Supabase Edge Function code and is
// intentionally excluded from the SPA `tsc -b` typecheck and ESLint run.
//
// Requirements traceability: 10.3, 11.1, 11.9, 12.3, 12.5, 12.6, 12.7, 14.5,
// 19.1, 20.1, 20.3, 20.4, 20.6, 20.7.
// Design references: Server-Side AI Gateway Design (Responsibilities; AI
// enablement precondition; AI job sequence; Failure handling / degraded mode);
// Architecture (single AI egress).
// =============================================================================

import { z } from 'npm:zod@4';
import { createClient } from 'jsr:@supabase/supabase-js@2';

import { getAdminClient } from '../_shared/supabaseAdmin.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';
import {
  errorResponse,
  type FieldError,
  jsonResponse,
} from '../_shared/http.ts';
import {
  AI_JOB_TYPES,
  type ActiveProviderConfig,
  type AiAuthType,
  type DegradedReason,
  type GatewayRequest,
  evaluateEnablement,
  runSingleAttempt,
  runValidatedOperation,
  startAiJob,
} from './gateway.ts';
import { isStructuredOutputJobType } from './structuredOutput.ts';
import { runConnectionTest } from './connectionTest.ts';

// -----------------------------------------------------------------------------
// Request contract (wire body → GatewayRequest).
//
// A request identifies the AI operation (`job_type`), an optional event scope
// (`event_id`), the candidate question texts, and non-identifying aggregate
// metadata. NO participant identifiers may appear anywhere in the body — the
// schema does not accept identifier fields, and the minimal-payload builder in
// `gateway.ts` re-enforces that only truncated question text + aggregate
// metadata are ever transmitted (Req 20.1, 20.3).
// -----------------------------------------------------------------------------

const gatewayInputSchema = z.object({
  job_type: z.enum(AI_JOB_TYPES, {
    message:
      "job_type must be one of 'categorisation', 'clustering', 'theme_insights', 'summary', or 'connection_test'.",
  }),
  event_id: z
    .string()
    .uuid({ message: 'event_id must be a valid UUID.' })
    .nullish(),
  question_texts: z.array(z.string()).default([]),
  aggregate_metadata: z
    .record(z.string(), z.union([z.number(), z.string()]))
    .default({}),
});

type GatewayInput = z.infer<typeof gatewayInputSchema>;

/** Flattens Zod issues into the per-field error list the client renders (Req 1.2). */
function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }));
}

// -----------------------------------------------------------------------------
// Admin JWT verification (Req 10.1, 20.4) — identical approach to
// moderate-question. Missing/invalid token → no user → 401 and NO outbound call.
// For V1 any authenticated user is an admin (Req 10.3); when roles land, a
// non-admin returns a 403 insufficient-privileges error (Req 20.4).
// -----------------------------------------------------------------------------

interface AuthResult {
  userId: string | null;
}

async function resolveAuthenticatedUser(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { userId: null };
  }
  const token = match[1].trim();
  if (token.length === 0) {
    return { userId: null };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    // Environment misconfiguration — treat as unauthenticated (fail closed).
    return { userId: null };
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) {
    return { userId: null };
  }
  return { userId: data.user.id };
}

// -----------------------------------------------------------------------------
// Active-config loader — the whitelisted NON-SECRET projection PLUS the
// presence-only credential columns needed for the enablement precondition. The
// base table has no client SELECT policy; the SERVICE-ROLE client reads it here
// (authorisation already verified). The credential columns are used ONLY to
// decide presence (precondition) and to resolve in-process at call time; their
// values are never returned to the client.
// -----------------------------------------------------------------------------

/** The DB row shape we select. `encrypted_credential` arrives as bytea. */
interface ActiveConfigRow {
  ai_enabled: boolean;
  provider_type: 'openai_compatible' | 'custom_adapter';
  base_url: string;
  chat_completions_path: string;
  auth_type: AiAuthType;
  api_key_header_name: string | null;
  model_id: string;
  temperature: number;
  max_output_tokens: number;
  request_timeout_seconds: number;
  tls_verify_required: boolean;
  secret_reference: string | null;
  encrypted_credential: string | Uint8Array | null;
}

/**
 * Normalises a bytea column (supabase-js may surface it as a `\x…` hex string or
 * a byte array) into a `Uint8Array | null` for the presence check and, later,
 * AEAD resolution. Only presence/shape are used here — never the plaintext.
 */
function toBytes(value: string | Uint8Array | null): Uint8Array | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value.length > 0 ? value : null;
  }
  // Postgres bytea hex format: leading "\x" then hex pairs.
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  if (hex.length === 0 || hex.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toActiveProviderConfig(row: ActiveConfigRow): ActiveProviderConfig {
  return {
    aiEnabled: row.ai_enabled,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    chatCompletionsPath: row.chat_completions_path,
    authType: row.auth_type,
    apiKeyHeaderName: row.api_key_header_name,
    modelId: row.model_id,
    temperature: Number(row.temperature),
    maxOutputTokens: row.max_output_tokens,
    requestTimeoutSeconds: row.request_timeout_seconds,
    tlsVerifyRequired: row.tls_verify_required,
    secretReference: row.secret_reference,
    encryptedCredential: toBytes(row.encrypted_credential),
  };
}

/** Client-facing message for each degraded reason — no provider internals (Req 19.2). */
const DEGRADED_MESSAGE: Readonly<Record<DegradedReason, string>> = {
  ai_disabled:
    'AI features are currently unavailable. The rest of the app is unaffected.',
  not_configured:
    'AI is not configured. The rest of the app is unaffected.',
  credential_missing:
    'AI is not configured (a provider credential is required). The rest of the app is unaffected.',
};

/**
 * Builds the standard degraded / "AI unavailable" response (HTTP 200 — the core
 * flow is fully functional, this is not an error, Req 19.1/19.2). No outbound
 * call was made.
 */
function degradedResponse(req: Request, reason: DegradedReason): Response {
  return jsonResponse(
    req,
    {
      ai: {
        available: false,
        reason,
        message: DEGRADED_MESSAGE[reason],
      },
    },
    200,
  );
}

// -----------------------------------------------------------------------------
// Handler.
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight.
  const preflight = handlePreflight(req);
  if (preflight) {
    return preflight;
  }

  // Only POST invokes an AI operation.
  if (req.method !== 'POST') {
    return errorResponse(
      req,
      405,
      'method_not_allowed',
      'This endpoint only accepts POST requests.',
    );
  }

  // 1) Authenticate the admin (Req 10.1, 20.4). No user → 401, no outbound call.
  const { userId } = await resolveAuthenticatedUser(req);
  if (!userId) {
    return errorResponse(
      req,
      401,
      'unauthorized',
      'Authentication is required to invoke an AI operation.',
    );
  }
  // NOTE (Req 20.4): for V1 any authenticated user is an administrator
  // (Req 10.3), mirroring moderate-question. When a role model exists, verify
  // the Administrator role here and return 403 `insufficient_privileges` for a
  // non-admin BEFORE any config load or outbound call.

  // 2) Parse the JSON body.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(
      req,
      400,
      'invalid_json',
      'Request body must be valid JSON.',
    );
  }

  // 3) Validate against the Gateway contract (Req 1.2). Invalid → 400.
  const parsed = gatewayInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      req,
      400,
      'validation_failed',
      'One or more fields are invalid.',
      toFieldErrors(parsed.error),
    );
  }
  const input: GatewayInput = parsed.data;

  const admin = getAdminClient();

  // 4) Load the SINGLE active AI provider config (WHERE is_active) via the
  // service role. `maybeSingle` returns null when no config exists.
  const { data: configRow, error: configError } = await admin
    .from('ai_provider_settings')
    .select(
      'ai_enabled, provider_type, base_url, chat_completions_path, auth_type, ' +
        'api_key_header_name, model_id, temperature, max_output_tokens, ' +
        'request_timeout_seconds, tls_verify_required, secret_reference, ' +
        'encrypted_credential',
    )
    .eq('is_active', true)
    .maybeSingle<ActiveConfigRow>();

  if (configError) {
    // Do not leak internals; treat as unavailable rather than surfacing details.
    return errorResponse(
      req,
      500,
      'config_load_failed',
      'The AI operation could not be completed. Please try again.',
    );
  }

  const config = configRow ? toActiveProviderConfig(configRow) : null;

  // 5) AI enablement precondition (Req 11.1, 11.9, 12.3, 12.5, 12.6, 19.1).
  // A degraded outcome returns the sanitised "AI unavailable" state and makes
  // NO outbound call — in particular, never an unauthenticated one.
  const enablement = evaluateEnablement(config);
  if (!enablement.available) {
    return degradedResponse(req, enablement.reason);
  }
  // `config` is non-null here (evaluateEnablement returns degraded on null).
  const activeConfig = config as ActiveProviderConfig;

  // 6) Build the internal request, open an `ai_jobs` record (pending), and run
  // one attempt: resolve credential in-process → call provider under the hard
  // timeout → discard plaintext → log succeeded/failed (Req 12.7, 14.5, 20.6,
  // 20.7). The provider call is a seam (task 29.3); until then a well-structured
  // failure is logged and a sanitised recoverable error is returned.
  const gatewayRequest: GatewayRequest = {
    jobType: input.job_type,
    eventId: input.event_id ?? null,
    questionTexts: input.question_texts,
    aggregateMetadata: input.aggregate_metadata,
  };

  const recorder = await startAiJob(admin, {
    jobType: gatewayRequest.jobType,
    eventId: gatewayRequest.eventId,
    modelId: activeConfig.modelId,
  });

  // `connection_test` (task 29.5) runs its own DEDICATED path: a minimal
  // ≤256-char non-sensitive probe verifying a non-empty usable response, then a
  // representative structured-output probe; compatibility is "established" only
  // when BOTH succeed (Req 13.2, 13.4, 13.11). It returns ONLY sanitised results
  // (outcome, status category, model id, round-trip ms, ISO 8601 UTC timestamp,
  // and on failure a fixed failure category) and makes NO persisted config
  // change — HTTP 200; the `outcome` field conveys success/failure (Req 13.1,
  // 13.3, 13.5, 13.10).
  if (gatewayRequest.jobType === 'connection_test') {
    const connectionTest = await runConnectionTest(activeConfig, recorder);
    return jsonResponse(
      req,
      {
        ai: { available: true },
        job_id: recorder.jobId,
        job_type: gatewayRequest.jobType,
        connection_test: connectionTest,
      },
      200,
    );
  }

  // Structured-output job types (categorisation / clustering / theme_insights /
  // summary) go through the VALIDATED runner (task 29.4): each provider response
  // is validated server-side against the shared Zod contract BEFORE any
  // storing/displaying, with up to 3 attempts (1 + 2 retries) on validation
  // failure / no candidate JSON; a final failure rejects WITHOUT storing and
  // returns a recoverable `invalid_ai_response` (Req 14.2, 14.4, 14.6, 14.7).
  if (isStructuredOutputJobType(gatewayRequest.jobType)) {
    const validated = await runValidatedOperation(
      activeConfig,
      gatewayRequest,
      recorder,
    );

    if (validated.ok) {
      return jsonResponse(
        req,
        {
          ai: { available: true },
          job_id: recorder.jobId,
          job_type: gatewayRequest.jobType,
          attempt_count: validated.result.attemptCount,
          // Req 14.8: the SPA renders every field of `result` as PLAIN TEXT —
          // never as executable HTML/script. This payload is inert data only.
          result: validated.result.data,
        },
        200,
      );
    }

    // All attempts failed validation, or a transport/timeout/SSRF failure — a
    // recoverable AI error; the core flow is unaffected (Req 19.1). The sanitised
    // code/message carry no provider internals, credential, or offending text
    // (Req 13.10, 20.7); the final attempt_count is recorded in ai_jobs.
    return jsonResponse(
      req,
      {
        ai: { available: true },
        job_id: recorder.jobId,
        job_type: gatewayRequest.jobType,
        attempt_count: validated.attemptCount,
        error: validated.error,
      },
      502,
    );
  }

  // DEFENSIVE FALLBACK: every AI_JOB_TYPE is handled above (connection_test on
  // its dedicated path; the four structured-output types via the validated
  // runner). This single-attempt path only runs if a new job type is added
  // without wiring — it fails safely with a sanitised recoverable error rather
  // than an unhandled pass-through. `runSingleAttempt` remains imported for this
  // guard and for the validated runner's per-attempt use.
  const outcome = await runSingleAttempt(activeConfig, gatewayRequest, recorder);

  if (outcome.ok) {
    return jsonResponse(
      req,
      {
        ai: { available: true },
        job_id: recorder.jobId,
        job_type: gatewayRequest.jobType,
        result: outcome.result,
      },
      200,
    );
  }

  // Failure → recoverable AI error; the core flow is unaffected (Req 19.1). The
  // sanitised code/message carry no provider internals or credential (Req 20.7).
  return jsonResponse(
    req,
    {
      ai: { available: true },
      job_id: recorder.jobId,
      job_type: gatewayRequest.jobType,
      error: outcome.error,
    },
    502,
  );
});
