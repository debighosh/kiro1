/**
 * Shared Zod schemas for AI provider settings input and AI structured-output
 * contracts.
 *
 * These schemas are the **single source of truth** for validating:
 *
 *  (a) the administrator's AI provider settings input (the AI settings form,
 *      task 33.x), submitted over authenticated HTTPS to the AI Gateway Edge
 *      Function which re-validates it authoritatively; and
 *  (b) the AI provider's **structured output** — categorisation, cluster,
 *      theme-insights, and end-of-event summary responses — which the AI
 *      Gateway validates server-side against the *same* schema before storing
 *      or displaying (Req 14.2).
 *
 * They are intended to be shared by BOTH:
 *  - the SPA (client-side forms for fast, inline feedback), and
 *  - the Supabase Edge Functions (Deno) which perform the authoritative
 *    server-side validation.
 *
 * Design references:
 *  - Error Handling → Validation errors: "All input is validated with shared
 *    Zod schemas on the client (fast feedback) and again server-side in Edge
 *    Functions / RPCs (authoritative)."
 *  - Server-Side AI Gateway Design → Structured output validation: "Validate
 *    every response server-side against the schema before storing/displaying
 *    (Req 14.2)."
 *  - Data Models → `ai_provider_settings` table (column constraints, Req 11).
 *
 * Requirements traceability: 11.1, 11.5, 12.2, 14.1, 14.2, 15, 16, 17, 18.
 *
 * IMPORTANT — keep this module framework-agnostic and dependency-light:
 *  - No React (or any UI framework) imports — the Edge Function must be able to
 *    import it too.
 *  - Only `zod` is imported. The Edge Function runs on Deno and cannot import
 *    the SPA's npm-resolved module path directly, so it re-declares (mirrors)
 *    these pure schema definitions against `npm:zod@4` (matching the SPA's
 *    `zod@^4`), exactly as `supabase/functions/create-event/index.ts` mirrors
 *    `src/schemas/event.ts`. The RULES defined here are the canonical contract;
 *    any Deno-side mirror must be kept in sync.
 */

import { z } from 'zod';

// =============================================================================
// (a) AI provider settings input (Req 11.1, 11.5, 12.2)
// =============================================================================

/** Minimum display name length (Req 11.1). */
export const AI_DISPLAY_NAME_MIN = 1;
/** Maximum display name length (Req 11.1). */
export const AI_DISPLAY_NAME_MAX = 100;
/** Minimum base URL length (Req 11.1). */
export const AI_BASE_URL_MIN = 1;
/** Maximum base URL length (Req 11.1). */
export const AI_BASE_URL_MAX = 2048;
/** Minimum chat-completions path length (Req 11.1). */
export const AI_CHAT_PATH_MIN = 1;
/** Maximum chat-completions path length (Req 11.1). */
export const AI_CHAT_PATH_MAX = 512;
/** Minimum API-key header name length (Req 11.5). */
export const AI_API_KEY_HEADER_NAME_MIN = 1;
/** Maximum API-key header name length (Req 11.5). */
export const AI_API_KEY_HEADER_NAME_MAX = 100;
/** Minimum model id length (Req 11.1). */
export const AI_MODEL_ID_MIN = 1;
/** Maximum model id length (Req 11.1). */
export const AI_MODEL_ID_MAX = 200;
/** Minimum temperature (Req 11.1). */
export const AI_TEMPERATURE_MIN = 0.0;
/** Maximum temperature (Req 11.1). */
export const AI_TEMPERATURE_MAX = 2.0;
/** Minimum max-output-tokens (Req 11.1). */
export const AI_MAX_OUTPUT_TOKENS_MIN = 1;
/** Maximum max-output-tokens (Req 11.1). */
export const AI_MAX_OUTPUT_TOKENS_MAX = 128000;
/** Minimum request-timeout seconds (Req 11.1). */
export const AI_REQUEST_TIMEOUT_SECONDS_MIN = 1;
/** Maximum request-timeout seconds (Req 11.1). */
export const AI_REQUEST_TIMEOUT_SECONDS_MAX = 300;
/** Minimum write-only credential length (Req 12.2). */
export const AI_CREDENTIAL_MIN = 1;
/** Maximum write-only credential length (Req 12.2). */
export const AI_CREDENTIAL_MAX = 8192;

/**
 * Provider type enum, mirroring the `provider_type` DB enum (Req 11.3).
 *  - `openai_compatible`: the first-class OpenAI chat-completions adapter.
 *  - `custom_adapter`: the documented extension point.
 */
export const aiProviderTypeSchema = z.enum([
  'openai_compatible',
  'custom_adapter',
]);

/**
 * Auth type enum, mirroring the `ai_auth_type` DB enum (Req 11.5).
 *  - `bearer`: `Authorization: Bearer <credential>`.
 *  - `api_key_header`: credential sent in a named custom header.
 *  - `none`: no credential is sent.
 */
export const aiAuthTypeSchema = z.enum(['bearer', 'api_key_header', 'none']);

/** Display name — required, 1–100 chars (Req 11.1). */
export const aiDisplayNameSchema = z
  .string()
  .trim()
  .min(AI_DISPLAY_NAME_MIN, {
    message: `Display name must be at least ${AI_DISPLAY_NAME_MIN} character.`,
  })
  .max(AI_DISPLAY_NAME_MAX, {
    message: `Display name must be at most ${AI_DISPLAY_NAME_MAX} characters.`,
  });

/**
 * Base URL — required, 1–2048 chars, and a well-formed **absolute** URL
 * (Req 11.1). Only `http`/`https` schemes are accepted, matching the DB
 * `base_url ~ '^https?://'` CHECK and the Gateway's SSRF scheme restriction
 * (Req 13.4, 13.6).
 */
export const aiBaseUrlSchema = z
  .string()
  .trim()
  .min(AI_BASE_URL_MIN, {
    message: `Base URL must be at least ${AI_BASE_URL_MIN} character.`,
  })
  .max(AI_BASE_URL_MAX, {
    message: `Base URL must be at most ${AI_BASE_URL_MAX} characters.`,
  })
  .refine(isAbsoluteHttpUrl, {
    message: 'Base URL must be an absolute http(s) URL.',
  });

/**
 * Returns true only for an absolute `http:`/`https:` URL.
 *
 * Uses the WHATWG `URL` parser (available in both the browser and Deno). A
 * relative URL like `/v1/chat` throws when parsed without a base and is thus
 * rejected; a non-HTTP scheme (e.g. `ftp:`, `file:`) parses but is rejected by
 * the protocol check.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Chat-completions path — required, 1–512 chars (Req 11.1). */
export const aiChatCompletionsPathSchema = z
  .string()
  .trim()
  .min(AI_CHAT_PATH_MIN, {
    message: `Chat-completions path must be at least ${AI_CHAT_PATH_MIN} character.`,
  })
  .max(AI_CHAT_PATH_MAX, {
    message: `Chat-completions path must be at most ${AI_CHAT_PATH_MAX} characters.`,
  });

/**
 * API-key header name — 1–100 chars. Optional at the field level because it is
 * only REQUIRED when `auth_type === 'api_key_header'`; the cross-field
 * `superRefine` on the object enforces that conditional requirement (Req 11.5).
 */
export const aiApiKeyHeaderNameSchema = z
  .string()
  .trim()
  .min(AI_API_KEY_HEADER_NAME_MIN, {
    message: `API-key header name must be at least ${AI_API_KEY_HEADER_NAME_MIN} character.`,
  })
  .max(AI_API_KEY_HEADER_NAME_MAX, {
    message: `API-key header name must be at most ${AI_API_KEY_HEADER_NAME_MAX} characters.`,
  });

/** Model id — required, 1–200 chars (Req 11.1). */
export const aiModelIdSchema = z
  .string()
  .trim()
  .min(AI_MODEL_ID_MIN, {
    message: `Model id must be at least ${AI_MODEL_ID_MIN} character.`,
  })
  .max(AI_MODEL_ID_MAX, {
    message: `Model id must be at most ${AI_MODEL_ID_MAX} characters.`,
  });

/** Temperature — required, 0.0–2.0 inclusive (Req 11.1). */
export const aiTemperatureSchema = z
  .number()
  .min(AI_TEMPERATURE_MIN, {
    message: `Temperature must be at least ${AI_TEMPERATURE_MIN}.`,
  })
  .max(AI_TEMPERATURE_MAX, {
    message: `Temperature must be at most ${AI_TEMPERATURE_MAX}.`,
  });

/** Max output tokens — required integer, 1–128000 inclusive (Req 11.1). */
export const aiMaxOutputTokensSchema = z
  .number()
  .int({ message: 'Max output tokens must be a whole number.' })
  .min(AI_MAX_OUTPUT_TOKENS_MIN, {
    message: `Max output tokens must be at least ${AI_MAX_OUTPUT_TOKENS_MIN}.`,
  })
  .max(AI_MAX_OUTPUT_TOKENS_MAX, {
    message: `Max output tokens must be at most ${AI_MAX_OUTPUT_TOKENS_MAX}.`,
  });

/** Request timeout seconds — required integer, 1–300 inclusive (Req 11.1). */
export const aiRequestTimeoutSecondsSchema = z
  .number()
  .int({ message: 'Request timeout must be a whole number of seconds.' })
  .min(AI_REQUEST_TIMEOUT_SECONDS_MIN, {
    message: `Request timeout must be at least ${AI_REQUEST_TIMEOUT_SECONDS_MIN} second.`,
  })
  .max(AI_REQUEST_TIMEOUT_SECONDS_MAX, {
    message: `Request timeout must be at most ${AI_REQUEST_TIMEOUT_SECONDS_MAX} seconds.`,
  });

/**
 * Write-only credential — 1–8192 chars (Req 12.2).
 *
 * This value is **write-only** from the UI: it is submitted only over
 * authenticated HTTPS to the Edge Function and is NEVER returned by any read
 * API (Req 12.1, 12.10, 21.8). It is optional in the settings object because a
 * settings update may leave an already-stored credential untouched; when
 * present it must satisfy the 1–8192 length bound. It is NOT trimmed —
 * credentials may legitimately contain leading/trailing whitespace and must be
 * preserved byte-for-byte.
 */
export const aiCredentialSchema = z
  .string()
  .min(AI_CREDENTIAL_MIN, {
    message: `Credential must be at least ${AI_CREDENTIAL_MIN} character.`,
  })
  .max(AI_CREDENTIAL_MAX, {
    message: `Credential must be at most ${AI_CREDENTIAL_MAX} characters.`,
  });

/**
 * Base object fields for AI provider settings input, before the cross-field
 * refinement. Kept as a `ZodObject` so both the create/replace input and a
 * future partial-edit variant can reuse it.
 *
 * NOTE: server-generated / server-managed fields (`id`, `is_active`,
 * `credential_state`, `secret_reference`, `encrypted_credential`,
 * `created_at`, `updated_at`) are intentionally absent — they are not client
 * input. The plaintext `credential` is carried here (write-only) but is never
 * persisted as plaintext by the server (Req 12.4).
 */
export const aiProviderSettingsFields = z.object({
  /** Human-readable label for the config — 1–100 chars (Req 11.1). */
  display_name: aiDisplayNameSchema,
  /** Whether AI features are enabled for this config (Req 11.9). */
  ai_enabled: z.boolean(),
  /** Provider adapter type (Req 11.3). */
  provider_type: aiProviderTypeSchema,
  /** Absolute base URL of the provider — 1–2048 chars (Req 11.1). */
  base_url: aiBaseUrlSchema,
  /** Chat-completions path relative to `base_url` — 1–512 chars (Req 11.1). */
  chat_completions_path: aiChatCompletionsPathSchema,
  /** Authentication scheme for outbound provider calls (Req 11.5). */
  auth_type: aiAuthTypeSchema,
  /**
   * Custom header name for the credential — 1–100 chars; REQUIRED when
   * `auth_type === 'api_key_header'`, otherwise it may be omitted (Req 11.5).
   */
  api_key_header_name: aiApiKeyHeaderNameSchema.optional(),
  /** Provider model identifier — 1–200 chars (Req 11.1). */
  model_id: aiModelIdSchema,
  /** Sampling temperature — 0.0–2.0 (Req 11.1). */
  temperature: aiTemperatureSchema,
  /** Maximum output tokens — 1–128000 (Req 11.1). */
  max_output_tokens: aiMaxOutputTokensSchema,
  /** Per-request timeout in seconds — 1–300 (Req 11.1). */
  request_timeout_seconds: aiRequestTimeoutSecondsSchema,
  /** Whether TLS certificate verification is required (Req 11.1, 13.12). */
  tls_verify_required: z.boolean(),
  /**
   * Write-only credential — 1–8192 chars; optional so an update can leave an
   * existing stored credential untouched (Req 12.1, 12.2).
   */
  credential: aiCredentialSchema.optional(),
});

/**
 * Cross-field rule: `api_key_header_name` is REQUIRED (and must be a valid
 * 1–100 char header name) when — and only when — `auth_type` is
 * `'api_key_header'` (Req 11.5). The issue is attached to
 * `api_key_header_name` so the client can surface a per-field inline message.
 */
const requireApiKeyHeaderName = (
  data: { auth_type: string; api_key_header_name?: string },
  ctx: z.RefinementCtx,
): void => {
  if (
    data.auth_type === 'api_key_header' &&
    (data.api_key_header_name === undefined ||
      data.api_key_header_name.length === 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        "API-key header name is required when auth type is 'api_key_header'.",
      path: ['api_key_header_name'],
    });
  }
};

/**
 * Schema for **creating / replacing** AI provider settings (Req 11.1, 11.5,
 * 12.2). Validates all client-supplied fields and the conditional
 * `api_key_header_name` requirement.
 */
export const aiProviderSettingsInputSchema =
  aiProviderSettingsFields.superRefine(requireApiKeyHeaderName);

/**
 * Schema for **editing** AI provider settings.
 *
 * Every field is optional so a partial update payload validates, but any field
 * that IS supplied must satisfy its create-time constraint. The conditional
 * `api_key_header_name` requirement is only re-checked when `auth_type` is
 * supplied as `'api_key_header'`.
 */
export const aiProviderSettingsEditInputSchema = aiProviderSettingsFields
  .partial()
  .superRefine((data, ctx) => {
    if (
      data.auth_type === 'api_key_header' &&
      (data.api_key_header_name === undefined ||
        data.api_key_header_name.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          "API-key header name is required when auth type is 'api_key_header'.",
        path: ['api_key_header_name'],
      });
    }
  });

// =============================================================================
// (b) AI structured-output contracts (server-side response validation, Req 14.2)
// =============================================================================

/**
 * The fixed set of eight question categories (Req 15.1, 15.3). Categorisation
 * results are validated by exact, case-sensitive match against these values;
 * any other value causes the whole response to be rejected (Req 15.4).
 */
export const AI_QUESTION_CATEGORIES = [
  'Technology',
  'Governance',
  'Security',
  'Operations',
  'Workforce',
  'Compliance',
  'Strategy',
  'Other',
] as const;

/** Enum schema for the eight allowed question categories (Req 15.3). */
export const aiCategorySchema = z.enum(AI_QUESTION_CATEGORIES);

/** Minimum confidence value (Req 15.5). */
export const AI_CONFIDENCE_MIN = 0.0;
/** Maximum confidence value (Req 15.5). */
export const AI_CONFIDENCE_MAX = 1.0;

/** Cluster label bounds (Req 16.1, 16.7). */
export const AI_CLUSTER_LABEL_MIN = 1;
export const AI_CLUSTER_LABEL_MAX = 100;
/** Cluster member-count bounds (Req 16.1). */
export const AI_CLUSTER_MEMBERS_MIN = 2;
export const AI_CLUSTER_MEMBERS_MAX = 500;

/** Theme-insights caps (Req 17.1). */
export const AI_MAX_TOP_THEMES = 5;
export const AI_MAX_EMERGING_CONCERNS = 5;
export const AI_MAX_FREQUENT_TOPICS = 10;
export const AI_MAX_NOTABLE_QUESTIONS = 5;

// -- Categorisation result (Req 15) -------------------------------------------

/**
 * A single categorised question: the question id, its assigned category (one of
 * the eight allowed values), and an OPTIONAL confidence in [0.00, 1.00]
 * (absent when the provider returns none) (Req 15.1, 15.5, 15.6).
 */
export const aiCategorisationItemSchema = z.object({
  /** The question id the category applies to. */
  question_id: z.uuid({ message: 'question_id must be a UUID.' }),
  /** The assigned category — exact, case-sensitive match (Req 15.3). */
  category: aiCategorySchema,
  /** Optional confidence, 0.00–1.00 inclusive (Req 15.5, 15.6). */
  confidence: z
    .number()
    .min(AI_CONFIDENCE_MIN, {
      message: `Confidence must be at least ${AI_CONFIDENCE_MIN}.`,
    })
    .max(AI_CONFIDENCE_MAX, {
      message: `Confidence must be at most ${AI_CONFIDENCE_MAX}.`,
    })
    .optional(),
});

/**
 * The full categorisation response: a list of categorised items. If any item's
 * category is not an exact match the enum validation fails and the whole
 * response is rejected (Req 15.4).
 */
export const aiCategorisationResultSchema = z.object({
  items: z.array(aiCategorisationItemSchema),
});

// -- Cluster result (Req 16) --------------------------------------------------

/**
 * A single cluster: a 1–100 char label and 2–500 member question ids
 * (Req 16.1, 16.7). Member id membership in the current event is validated
 * separately server-side (Req 16.10) — it cannot be expressed purely by shape.
 */
export const aiClusterSchema = z.object({
  /** Human-readable cluster label — 1–100 chars (Req 16.1, 16.7). */
  label: z
    .string()
    .trim()
    .min(AI_CLUSTER_LABEL_MIN, {
      message: `Cluster label must be at least ${AI_CLUSTER_LABEL_MIN} character.`,
    })
    .max(AI_CLUSTER_LABEL_MAX, {
      message: `Cluster label must be at most ${AI_CLUSTER_LABEL_MAX} characters.`,
    }),
  /** Member question ids — 2–500 UUIDs (Req 16.1). */
  question_ids: z
    .array(z.uuid({ message: 'question_ids must contain UUIDs.' }))
    .min(AI_CLUSTER_MEMBERS_MIN, {
      message: `A cluster must contain at least ${AI_CLUSTER_MEMBERS_MIN} member questions.`,
    })
    .max(AI_CLUSTER_MEMBERS_MAX, {
      message: `A cluster must contain at most ${AI_CLUSTER_MEMBERS_MAX} member questions.`,
    }),
});

/**
 * The full clustering response: a list of clusters plus an
 * `insufficient_data` flag. When fewer than 2 approved questions exist, the
 * Gateway returns zero clusters and `insufficient_data: true` (Req 16.2).
 */
export const aiClusterResultSchema = z.object({
  clusters: z.array(aiClusterSchema),
  /** True when there were too few questions to cluster (Req 16.2). */
  insufficient_data: z.boolean(),
});

// -- Theme insights (Req 17) --------------------------------------------------

/** A short theme / concern / topic label. */
const aiThemeLabelSchema = z.string().trim().min(1).max(200);

/**
 * A notable high-vote question: the question id, its (grounded, non-invented)
 * vote count, and the question text. Vote count must be a non-negative integer
 * (Req 17.2, 17.4).
 */
export const aiNotableQuestionSchema = z.object({
  question_id: z.uuid({ message: 'question_id must be a UUID.' }),
  vote_count: z
    .number()
    .int({ message: 'vote_count must be a whole number.' })
    .min(0, { message: 'vote_count must be non-negative.' }),
  text: z.string(),
});

/**
 * The theme-insights response with the four capped categories (Req 17.1):
 * ≤5 top themes, ≤5 emerging concerns, ≤10 frequent topics, ≤5 notable
 * high-vote questions. The empty-event case is represented by all four arrays
 * being empty plus `has_data: false` (Req 17.5).
 */
export const aiThemeInsightsResultSchema = z.object({
  top_themes: z.array(aiThemeLabelSchema).max(AI_MAX_TOP_THEMES, {
    message: `At most ${AI_MAX_TOP_THEMES} top themes are allowed.`,
  }),
  emerging_concerns: z.array(aiThemeLabelSchema).max(AI_MAX_EMERGING_CONCERNS, {
    message: `At most ${AI_MAX_EMERGING_CONCERNS} emerging concerns are allowed.`,
  }),
  frequent_topics: z.array(aiThemeLabelSchema).max(AI_MAX_FREQUENT_TOPICS, {
    message: `At most ${AI_MAX_FREQUENT_TOPICS} frequent topics are allowed.`,
  }),
  notable_high_vote_questions: z
    .array(aiNotableQuestionSchema)
    .max(AI_MAX_NOTABLE_QUESTIONS, {
      message: `At most ${AI_MAX_NOTABLE_QUESTIONS} notable questions are allowed.`,
    }),
  /** False for the empty-event / no-data case (Req 17.5). */
  has_data: z.boolean(),
});

// -- End-of-event summary (Req 18) --------------------------------------------

/**
 * The AI-produced portion of the end-of-event summary (Req 18.1, 18.5, 18.6).
 *
 * Only the **AI Interpretation** content is validated here — the executive
 * summary and the suggested follow-up actions. All *calculated* data (interaction
 * counts, top questions, poll/word-cloud results, etc.) is computed directly
 * from the DB independently of the model (Req 18.4) and is therefore not part of
 * this model-output contract.
 */
export const aiSummaryResultSchema = z.object({
  /** AI executive summary (rendered under "AI-Generated") (Req 18.1, 18.6). */
  executive_summary: z.string(),
  /** Suggested follow-up actions (rendered under "AI-Generated") (Req 18.1, 18.6). */
  suggested_follow_up_actions: z.array(z.string()),
});

// =============================================================================
// Inferred TypeScript types
// =============================================================================

/** Provider adapter type. */
export type AiProviderType = z.infer<typeof aiProviderTypeSchema>;
/** Outbound authentication scheme. */
export type AiAuthType = z.infer<typeof aiAuthTypeSchema>;
/** Validated AI provider settings create/replace input. */
export type AiProviderSettingsInput = z.infer<
  typeof aiProviderSettingsInputSchema
>;
/** Validated AI provider settings edit (partial) input. */
export type AiProviderSettingsEditInput = z.infer<
  typeof aiProviderSettingsEditInputSchema
>;

/** One of the eight allowed question categories. */
export type AiCategory = z.infer<typeof aiCategorySchema>;
/** A single categorised question. */
export type AiCategorisationItem = z.infer<typeof aiCategorisationItemSchema>;
/** The full categorisation response. */
export type AiCategorisationResult = z.infer<
  typeof aiCategorisationResultSchema
>;
/** A single semantic cluster. */
export type AiCluster = z.infer<typeof aiClusterSchema>;
/** The full clustering response. */
export type AiClusterResult = z.infer<typeof aiClusterResultSchema>;
/** A notable high-vote question. */
export type AiNotableQuestion = z.infer<typeof aiNotableQuestionSchema>;
/** The full theme-insights response. */
export type AiThemeInsightsResult = z.infer<typeof aiThemeInsightsResultSchema>;
/** The AI-produced portion of the end-of-event summary. */
export type AiSummaryResult = z.infer<typeof aiSummaryResultSchema>;
