/**
 * Shared Zod schemas for event create/edit input.
 *
 * These schemas are the single source of truth for validating administrator
 * event input and are intended to be shared by BOTH:
 *
 *  - the client event editor form (task 8.1) for fast, inline feedback, and
 *  - the authenticated event-create Edge Function (task 7.2) as the
 *    authoritative server-side check.
 *
 * Design references:
 *  - Error Handling → Validation errors: "All input is validated with shared
 *    Zod schemas on the client (fast feedback) and again server-side in Edge
 *    Functions / RPCs (authoritative). Character counts use Unicode code
 *    points."
 *  - Data Models → `events` table (column constraints).
 *
 * Requirements traceability: 1.1, 1.2, 1.3, 22.5, 22.6.
 *
 * IMPORTANT — keep this module framework-agnostic and dependency-light:
 *  - No React (or any UI framework) imports — the Edge Function must be able to
 *    import it too.
 *  - Only `zod` is imported. The Edge Function runs on Deno and imports Zod via
 *    a Deno specifier; it can re-import or mirror this module as needed. The
 *    logic here is plain, pure TypeScript.
 *
 * Datetime representation (documented decision):
 *  - `starts_at` / `ends_at` are validated as **ISO 8601 datetime strings**
 *    (`z.iso.datetime()`), the on-the-wire representation used by the SPA and
 *    the Edge Function. Ordering (`ends_at > starts_at`, Req 1.1/1.2) is checked
 *    by comparing parsed `Date` values. Keeping strings (rather than coercing to
 *    `Date`) avoids ambiguity across the client/server boundary and matches the
 *    JSON payload that crosses it.
 */

import { z } from 'zod';

/**
 * Counts the number of Unicode code points in a string.
 *
 * Requirements 22.5 / 22.6 mandate counting each Unicode **code point** as one
 * character. JavaScript's `String.prototype.length` counts UTF-16 code units,
 * so characters outside the Basic Multilingual Plane (e.g. many emoji) count as
 * 2. Spreading the string (`[...value]`) iterates by code point, giving the
 * correct count.
 */
export function countCodePoints(value: string): number {
  return [...value].length;
}

/** Maximum event name length in Unicode code points (Req 1.1, 22.5). */
export const EVENT_NAME_MAX = 100;
/** Minimum event name length in Unicode code points (Req 1.1, 22.5). */
export const EVENT_NAME_MIN = 1;
/** Maximum event description length in Unicode code points (Req 1.3, 22.6). */
export const EVENT_DESCRIPTION_MAX = 500;
/** Slug format: 1–64 letters, digits, and hyphens (Req 1.3, 1.4). */
export const EVENT_SLUG_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Optional brand colour format: `#RGB` or `#RRGGBB` hex colour (Req 1.3). */
export const BRAND_COLOUR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Event name (Req 1.1, 22.5).
 *
 * Trimmed, then required to be 1–100 Unicode code points. Trimming first means a
 * whitespace-only name is rejected as empty, matching the DB `char_length` 1–100
 * CHECK constraint on `events.name`.
 */
export const eventNameSchema = z
  .string()
  .trim()
  .refine((v) => countCodePoints(v) >= EVENT_NAME_MIN, {
    message: `Name must be at least ${EVENT_NAME_MIN} character.`,
  })
  .refine((v) => countCodePoints(v) <= EVENT_NAME_MAX, {
    message: `Name must be at most ${EVENT_NAME_MAX} characters.`,
  });

/**
 * Optional event description (Req 1.3, 22.6): 0–500 Unicode code points.
 */
export const eventDescriptionSchema = z
  .string()
  .refine((v) => countCodePoints(v) <= EVENT_DESCRIPTION_MAX, {
    message: `Description must be at most ${EVENT_DESCRIPTION_MAX} characters.`,
  })
  .optional();

/**
 * Optional event code / slug (Req 1.3, 1.4): 1–64 chars of letters, digits, and
 * hyphens. Matches the `events.slug` format constraint.
 */
export const eventSlugSchema = z
  .string()
  .regex(EVENT_SLUG_PATTERN, {
    message:
      'Slug must be 1–64 characters using only letters, digits, and hyphens.',
  })
  .optional();

/**
 * Optional brand colour (Req 1.3): a 3- or 6-digit hex colour (e.g. `#0af`,
 * `#00aaff`). Kept optional and lenient — colour is a cosmetic branding field.
 */
export const brandColourSchema = z
  .string()
  .regex(BRAND_COLOUR_PATTERN, {
    message: 'Brand colour must be a hex colour like #0af or #00aaff.',
  })
  .optional();

/**
 * Optional storage path for a previously uploaded logo asset (Req 1.3).
 *
 * Milestone 1 handles the logo minimally: the create-input schema only carries
 * an optional reference string to an already-stored asset. The ≤2 MB upload
 * enforcement itself happens at the storage/upload layer, not here.
 */
export const logoPathSchema = z.string().min(1).optional();

/** Moderation mode enum, mirroring the `moderation_mode` DB enum (Req 3.6, 3.8). */
export const moderationModeSchema = z.enum(['pre', 'post']).default('pre');

/** ISO 8601 datetime string (Req 1.1). */
export const isoDatetimeSchema = z.iso.datetime({
  message: 'Must be a valid ISO 8601 datetime.',
});

/**
 * Shared shape for the create/edit fields, before the cross-field ordering
 * refinement. Kept as a `ZodObject` so both create and (future) edit schemas can
 * reuse it.
 *
 * NOTE: `presenter_token` and `status` are intentionally absent — they are
 * server-generated / transitioned separately (tasks 7.2 / 7.3), not client
 * input.
 */
export const eventInputFields = z.object({
  /** Event name — required, 1–100 code points (Req 1.1, 22.5). */
  name: eventNameSchema,
  /** Optional description — ≤500 code points (Req 1.3, 22.6). */
  description: eventDescriptionSchema,
  /** Optional slug/event code — `[A-Za-z0-9-]{1,64}` (Req 1.3, 1.4). */
  slug: eventSlugSchema,
  /** Event start (ISO 8601 datetime string) (Req 1.1). */
  starts_at: isoDatetimeSchema,
  /** Event end (ISO 8601 datetime string); must be after `starts_at` (Req 1.1, 1.2). */
  ends_at: isoDatetimeSchema,
  /** Optional cosmetic brand colour (Req 1.3). */
  brand_colour: brandColourSchema,
  /** Optional reference to an already-stored logo asset (Req 1.3). */
  logo_path: logoPathSchema,
  /** Moderation mode; defaults to `'pre'` (Req 3.6, 3.8). */
  moderation_mode: moderationModeSchema,
});

/**
 * Cross-field refinement enforcing `ends_at > starts_at` (Req 1.1, 1.2).
 *
 * The error is attached to `ends_at` so the client can surface a per-field
 * inline message (Design: Validation errors → "structured error identifying
 * each invalid field").
 */
const endsAfterStarts = (data: {
  starts_at: string;
  ends_at: string;
}): boolean =>
  new Date(data.ends_at).getTime() > new Date(data.starts_at).getTime();

const endsAfterStartsIssue = {
  message: 'End datetime must be later than the start datetime.',
  path: ['ends_at'],
};

/**
 * Schema for **creating** an event (Req 1.1, 1.2, 1.3, 22.5, 22.6).
 *
 * Validates all client-supplied fields and the `ends_at > starts_at` ordering.
 * Does NOT include `presenter_token` or `status` (server-generated /
 * server-transitioned).
 */
export const eventCreateInputSchema = eventInputFields.refine(
  endsAfterStarts,
  endsAfterStartsIssue,
);

/**
 * Schema for **editing** an event.
 *
 * Same field constraints as create; ordering is only re-checked when both
 * datetimes are present. Every field is optional so a partial update payload
 * validates, but any field that IS supplied must satisfy its create-time
 * constraint. Also excludes `presenter_token` / `status`.
 */
export const eventEditInputSchema = eventInputFields
  .partial()
  .refine(
    (data) =>
      data.starts_at === undefined ||
      data.ends_at === undefined ||
      new Date(data.ends_at).getTime() > new Date(data.starts_at).getTime(),
    endsAfterStartsIssue,
  );

/** Inferred type for validated event-create input. */
export type EventCreateInput = z.infer<typeof eventCreateInputSchema>;

/** Inferred type for validated event-edit input. */
export type EventEditInput = z.infer<typeof eventEditInputSchema>;

/** Inferred type for the moderation mode value. */
export type ModerationMode = z.infer<typeof moderationModeSchema>;
