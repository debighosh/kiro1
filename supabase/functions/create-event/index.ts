// =============================================================================
// EDGE FUNCTION: create-event — authenticated event creation (Deno runtime)
// =============================================================================
//
// Privileged mutation Edge Function that creates an `events` row on behalf of an
// authenticated administrator. This is the authoritative, server-side event
// create path: the SPA never inserts into `events` directly (RLS denies client
// inserts — task 5.1). The browser calls this function with the administrator's
// Supabase access token in the `Authorization: Bearer <jwt>` header.
//
// Behaviour (task 7.2):
//   1. Verify the caller carries a valid authenticated admin JWT. If not,
//      respond 401 and make NO changes (Req 10.1, 21.6). For V1, any
//      authenticated user is treated as an admin (Req 10.3).
//   2. Validate the JSON body against the event-create input contract — the
//      Deno-side mirror of `src/schemas/event.ts` (task 7.1): name 1–100 Unicode
//      code points, optional description ≤500, optional slug `[A-Za-z0-9-]{1,64}`,
//      ISO-8601 `starts_at`/`ends_at` with `ends_at > starts_at`, optional
//      `brand_colour`, optional `moderation_mode` ('pre'|'post', default 'pre').
//   3. On validation failure: respond 400 with a structured, per-field error and
//      persist NOTHING (Req 1.2).
//   4. On success: generate a ≥32-char alphanumeric `presenter_token` via the
//      Web Crypto CSPRNG, insert via the SERVICE-ROLE admin client with `status`
//      defaulting to 'draft' (Req 1.5). The DB generates id/timestamps.
//   5. Duplicate slug (Postgres unique violation, SQLSTATE 23505): respond 409
//      identifying the conflicting slug, leaving existing data unchanged
//      (Req 1.4). No internal details are leaked.
//   6. On success respond 201 with the created event id, the audience URL, the
//      presenter URL (embedding the presenter token), and the QR target (the
//      audience URL a QR should encode) (Req 1.1). The raw presenter token is
//      returned ONLY inside the admin-only presenter URL — never as a bare field,
//      and service-role material is never returned.
//
// CORS: the SPA calls this cross-origin, so an `OPTIONS` preflight is handled and
// every response carries CORS headers (see `_shared/cors.ts`).
//
// This is Deno / Supabase Edge Function code. It uses `Deno.*` globals and
// `npm:` / relative Deno import specifiers, and is intentionally excluded from
// the SPA `tsc -b` typecheck and ESLint run (`supabase/functions` is ignored),
// so it does not affect `npm run build` / `npm run lint`.
//
// Requirements traceability: 1.1, 1.2, 1.3, 1.4, 1.5, 7.3, 10.1, 21.6, 21.19.
// Design references: Architecture (Edge Functions — privileged mutations);
// Data Models (`events` table); Error Handling (Validation / Authorization errors).
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

// -----------------------------------------------------------------------------
// Validation contract — Deno-side mirror of `src/schemas/event.ts` (task 7.1).
//
// The SPA and this function share ONE logical contract. Because Edge Functions
// run on Deno and cannot import the SPA's npm-resolved module path directly, the
// schema is re-declared here against `npm:zod@4` (matching the SPA's `zod@^4`).
// The RULES are kept identical to `src/schemas/event.ts`; if that file changes,
// update this mirror too.
// -----------------------------------------------------------------------------

/** Maximum event name length in Unicode code points (Req 1.1, 22.5). */
const EVENT_NAME_MAX = 100;
/** Minimum event name length in Unicode code points (Req 1.1, 22.5). */
const EVENT_NAME_MIN = 1;
/** Maximum event description length in Unicode code points (Req 1.3, 22.6). */
const EVENT_DESCRIPTION_MAX = 500;
/** Slug format: 1–64 letters, digits, and hyphens (Req 1.3, 1.4). */
const EVENT_SLUG_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Optional brand colour format: `#RGB` or `#RRGGBB` hex colour (Req 1.3). */
const BRAND_COLOUR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Counts Unicode code points (not UTF-16 code units) so characters outside the
 * BMP (e.g. many emoji) count as one, matching the DB `char_length` CHECK and
 * Req 22.5 / 22.6. Mirrors `countCodePoints` in `src/schemas/event.ts`.
 */
function countCodePoints(value: string): number {
  return [...value].length;
}

const eventNameSchema = z
  .string()
  .trim()
  .refine((v) => countCodePoints(v) >= EVENT_NAME_MIN, {
    message: `Name must be at least ${EVENT_NAME_MIN} character.`,
  })
  .refine((v) => countCodePoints(v) <= EVENT_NAME_MAX, {
    message: `Name must be at most ${EVENT_NAME_MAX} characters.`,
  });

const eventDescriptionSchema = z
  .string()
  .refine((v) => countCodePoints(v) <= EVENT_DESCRIPTION_MAX, {
    message: `Description must be at most ${EVENT_DESCRIPTION_MAX} characters.`,
  })
  .optional();

const eventSlugSchema = z
  .string()
  .regex(EVENT_SLUG_PATTERN, {
    message:
      'Slug must be 1–64 characters using only letters, digits, and hyphens.',
  })
  .optional();

const brandColourSchema = z
  .string()
  .regex(BRAND_COLOUR_PATTERN, {
    message: 'Brand colour must be a hex colour like #0af or #00aaff.',
  })
  .optional();

const logoPathSchema = z.string().min(1).optional();

const moderationModeSchema = z.enum(['pre', 'post']).default('pre');

const isoDatetimeSchema = z.iso.datetime({
  message: 'Must be a valid ISO 8601 datetime.',
});

const eventInputFields = z.object({
  name: eventNameSchema,
  description: eventDescriptionSchema,
  slug: eventSlugSchema,
  starts_at: isoDatetimeSchema,
  ends_at: isoDatetimeSchema,
  brand_colour: brandColourSchema,
  logo_path: logoPathSchema,
  moderation_mode: moderationModeSchema,
});

/** `ends_at` must be strictly later than `starts_at` (Req 1.1, 1.2). */
const eventCreateInputSchema = eventInputFields.refine(
  (data) =>
    new Date(data.ends_at).getTime() > new Date(data.starts_at).getTime(),
  {
    message: 'End datetime must be later than the start datetime.',
    path: ['ends_at'],
  },
);

type EventCreateInput = z.infer<typeof eventCreateInputSchema>;

/**
 * Flattens Zod issues into the per-field error list the client renders inline
 * (Req 1.2 / 22.7). The dotted issue path becomes the `field` name; issues with
 * an empty path (e.g. a non-object body) are reported against a synthetic
 * `_root` field.
 */
function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }));
}

// -----------------------------------------------------------------------------
// Presenter token generation (Req 7.3): ≥32 characters from an alphanumeric set,
// drawn from the Web Crypto CSPRNG (`crypto.getRandomValues`). Rejection
// sampling keeps the character distribution uniform across the 62-char alphabet
// (no modulo bias). This satisfies the DB CHECK (`presenter_token` ≥32 alnum)
// and the UNIQUE constraint (collision is astronomically unlikely at 62^32).
// -----------------------------------------------------------------------------

const PRESENTER_TOKEN_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PRESENTER_TOKEN_LENGTH = 48; // > the 32-char minimum, extra entropy margin.

function generatePresenterToken(length = PRESENTER_TOKEN_LENGTH): string {
  const alphabetLength = PRESENTER_TOKEN_ALPHABET.length; // 62
  // Largest multiple of alphabetLength that fits in a byte; bytes >= this are
  // discarded to avoid modulo bias.
  const maxUnbiased = Math.floor(256 / alphabetLength) * alphabetLength; // 248
  const out: string[] = [];
  const buffer = new Uint8Array(length);

  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && out.length < length; i++) {
      const byte = buffer[i];
      if (byte < maxUnbiased) {
        out.push(PRESENTER_TOKEN_ALPHABET[byte % alphabetLength]);
      }
    }
  }
  return out.join('');
}

// -----------------------------------------------------------------------------
// URL derivation (Req 1.1): the audience URL, presenter URL, and QR target are
// derived from a configured site base URL. `PUBLIC_SITE_URL` is preferred; if it
// is unset we fall back to the request's `Origin` header, then to a sensible
// local-dev default. The QR target IS the audience URL (the QR encodes it).
// -----------------------------------------------------------------------------

const DEFAULT_SITE_URL = 'http://127.0.0.1:5173';

function resolveSiteUrl(req: Request): string {
  const configured = Deno.env.get('PUBLIC_SITE_URL');
  const base =
    (configured && configured.trim()) ||
    req.headers.get('Origin') ||
    DEFAULT_SITE_URL;
  // Normalise: drop any trailing slash so path joins are unambiguous.
  return base.replace(/\/+$/, '');
}

interface EventUrls {
  audienceUrl: string;
  presenterUrl: string;
  qrTarget: string;
}

/**
 * Builds the audience URL (`{SITE}/e/{slug ?? id}`), the admin-only presenter
 * URL (`{SITE}/present/{id}?t={presenter_token}`), and the QR target (== the
 * audience URL). Prefers the slug for the audience-facing URL when present
 * (friendlier event code), falling back to the id.
 */
function buildEventUrls(
  site: string,
  eventId: string,
  slug: string | null,
  presenterToken: string,
): EventUrls {
  const audienceRef = slug ?? eventId;
  const audienceUrl = `${site}/e/${encodeURIComponent(audienceRef)}`;
  const presenterUrl = `${site}/present/${encodeURIComponent(eventId)}?t=${encodeURIComponent(
    presenterToken,
  )}`;
  return { audienceUrl, presenterUrl, qrTarget: audienceUrl };
}

// -----------------------------------------------------------------------------
// Admin JWT verification (Req 10.1, 21.6).
//
// The `Authorization: Bearer <jwt>` header carries the administrator's Supabase
// access token. We resolve the user by binding a Supabase client to that header
// and calling `auth.getUser()`, which validates the token server-side. A missing
// header or an invalid/expired token yields no user → the caller returns 401 and
// makes no changes. For V1 any authenticated user is an admin (Req 10.3).
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

  // A request-scoped client bound to the caller's token; RLS applies and
  // `getUser` validates the JWT against Supabase Auth.
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
// Handler.
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight.
  const preflight = handlePreflight(req);
  if (preflight) {
    return preflight;
  }

  // Only POST creates an event.
  if (req.method !== 'POST') {
    return errorResponse(
      req,
      405,
      'method_not_allowed',
      'This endpoint only accepts POST requests.',
    );
  }

  // 1) Authenticate the admin (Req 10.1, 21.6). No user → 401, no changes.
  const { userId } = await resolveAuthenticatedUser(req);
  if (!userId) {
    return errorResponse(
      req,
      401,
      'unauthorized',
      'Authentication is required to create an event.',
    );
  }

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

  // 3) Validate against the shared event-create contract (Req 1.1, 1.2, 1.3).
  const parsed = eventCreateInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      req,
      400,
      'validation_failed',
      'One or more fields are invalid.',
      toFieldErrors(parsed.error),
    );
  }
  const input: EventCreateInput = parsed.data;

  // 4) Build the row. `status` defaults to 'draft' at creation (Req 1.5);
  // id/created_at/updated_at/active_presenter_mode/stop_words are DB-defaulted.
  const presenterToken = generatePresenterToken();
  const slug = input.slug ?? null;

  const insertRow: Record<string, unknown> = {
    name: input.name,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    moderation_mode: input.moderation_mode, // schema default 'pre'
    status: 'draft', // explicit; matches the DB default (Req 1.5)
    presenter_token: presenterToken,
  };
  if (input.description !== undefined)
    insertRow.description = input.description;
  if (slug !== null) insertRow.slug = slug;
  if (input.brand_colour !== undefined)
    insertRow.brand_colour = input.brand_colour;
  if (input.logo_path !== undefined) insertRow.logo_path = input.logo_path;

  // 5) Insert via the SERVICE-ROLE client (bypasses RLS; authorisation already
  // verified above). Only select back non-sensitive columns — never the
  // presenter_token (returned solely inside the presenter URL below).
  const admin = getAdminClient();
  const { data: created, error: insertError } = await admin
    .from('events')
    .insert(insertRow)
    .select('id, slug, status, created_at')
    .single();

  if (insertError) {
    // Duplicate slug → Postgres unique violation, SQLSTATE 23505 (Req 1.4).
    if (insertError.code === '23505') {
      return errorResponse(
        req,
        409,
        'slug_conflict',
        slug
          ? `The event code "${slug}" is already in use by another event.`
          : 'A unique field value is already in use by another event.',
        slug
          ? [{ field: 'slug', message: 'This event code is already in use.' }]
          : undefined,
      );
    }
    // Any other DB error: do not leak internals (design: no error leaks details).
    return errorResponse(
      req,
      500,
      'create_failed',
      'The event could not be created. Please try again.',
    );
  }

  // 6) Compute URLs and return 201. The presenter token appears ONLY inside the
  // admin-only presenter URL — never as a bare field (Req 1.1, 7.3).
  const site = resolveSiteUrl(req);
  const { audienceUrl, presenterUrl, qrTarget } = buildEventUrls(
    site,
    created.id,
    created.slug ?? null,
    presenterToken,
  );

  return jsonResponse(
    req,
    {
      event: {
        id: created.id,
        slug: created.slug ?? null,
        status: created.status,
        created_at: created.created_at,
      },
      audienceUrl,
      presenterUrl,
      qrTarget,
    },
    201,
  );
});
