/**
 * Input sanitisation / allow-list validation and inert-text rendering: the
 * SHARED, framework-agnostic contract for what submitted free text is permitted
 * to contain before it is persisted, and for rendering any string as plain,
 * non-executable text.
 *
 * =============================================================================
 * SHARED CONTRACT — SINGLE SOURCE OF TRUTH
 * =============================================================================
 * This pure module is the canonical definition of two closely-related
 * behaviours:
 *
 *   1. VALIDATION / SANITISATION on the write path — submitted free-text is
 *      checked against a CONFIGURABLE allow-list of permitted characters and a
 *      CONFIGURABLE maximum length BEFORE it is persisted (Req 21.9, 21.10). On
 *      any violation the whole submission is rejected with a validation-failure
 *      reason that names the offending FIELD and the LIMIT that was violated
 *      (Req 21.11, 22.7); the input is NEVER mutated, trimmed, or "cleaned" —
 *      validation is a pure predicate, and the caller retains the original
 *      values so it can re-display them alongside an inline error (Req 3.2).
 *
 *   2. INERT-TEXT RENDERING on the read path — {@link toInertText} one-way
 *      HTML-escapes a string so it can never be interpreted as executable
 *      HTML/script/markup when rendered (Req 21.12, 24.8).
 *
 * It has NO dependencies (no React, no zod, no Supabase/DB/network, no Deno
 * globals, no I/O). It is deterministic and never mutates its inputs, so it can
 * be imported by BOTH:
 *
 *   - the SPA (client-side validation for fast feedback + inert rendering in any
 *     non-React or attribute/interpolation context), and
 *   - conceptually the server write path — the Edge Functions / RPCs that
 *     authoritatively validate length + allow-list before insert (Req 21.9–21.11).
 *     Because Deno/SQL cannot import this `src/` path directly, that path
 *     RE-IMPLEMENTS the identical rule; if you change the semantics here, change
 *     them there too (and vice-versa).
 *
 * ── Code-point semantics ────────────────────────────────────────────────────
 * Length is counted by Unicode CODE POINTS, and the allow-list is applied per
 * code point — NOT per UTF-16 code unit. This matches the rest of the codebase
 * and the DB `char_length` semantics (Req 22.6: "counting each Unicode code
 * point as one character"), so a surrogate-pair character (e.g. an emoji) counts
 * as one character and is allow-listed as a single unit.
 *
 * Requirements traceability: 21.9, 21.10, 21.11, 21.12, 22.7, 24.8.
 * Design references: Error Handling (Validation errors — allow-list + length cap
 * before persistence, reject whole submission with field + limit, inert text on
 * display); Frontend Design (submitted/AI text rendered as plain text, never
 * executable HTML/script — Req 14.8, 21.12).
 */

// ----------------------------------------------------------------------------
// Length limit.
// ----------------------------------------------------------------------------

/**
 * The default maximum length (in Unicode code points) enforced per free-text
 * field when {@link SanitiseOptions.maxLength} is not supplied (Req 21.10 —
 * "a default maximum of 500 characters per free-text field").
 */
export const DEFAULT_MAX_LENGTH = 500 as const;

// ----------------------------------------------------------------------------
// Allow-lists.
// ----------------------------------------------------------------------------

/**
 * A predicate deciding whether a SINGLE Unicode code point (passed as its
 * one-code-point string, e.g. `"a"`, `"😀"`) is permitted. Returning `true`
 * admits the code point; `false` rejects it.
 *
 * A predicate (rather than a raw `RegExp`) is the canonical representation
 * because it composes cleanly and sidesteps the UTF-16-vs-code-point pitfalls of
 * matching astral characters with a character-class regex. Callers who prefer a
 * regex can adapt one with {@link allowListFromRegExp}.
 */
export type AllowListPredicate = (codePoint: string) => boolean;

/**
 * Adapts a `RegExp` that matches exactly ONE permitted character into an
 * {@link AllowListPredicate}. The regex is tested against each code point's
 * string form; supply a pattern intended to match a single character (e.g.
 * `/[A-Za-z0-9 ]/`). A fresh test is performed per code point and the `g`/`y`
 * flags' `lastIndex` state is irrelevant because a one-code-point string is
 * tested each time, but callers should still avoid stateful flags for clarity.
 *
 * @param re a regex matching a single permitted character.
 * @returns a predicate that admits a code point iff `re` matches it.
 */
export function allowListFromRegExp(re: RegExp): AllowListPredicate {
  return (codePoint: string): boolean => re.test(codePoint);
}

/**
 * A permissive "plain text" allow-list preset: admits every code point EXCEPT
 * ASCII C0 control characters (U+0000–U+001F) and the DEL control (U+007F),
 * while explicitly permitting the common whitespace controls TAB (U+0009),
 * LINE FEED (U+000A), and CARRIAGE RETURN (U+000D).
 *
 * This is a sensible default for user-authored free text (questions, word-cloud
 * responses, descriptions): letters, digits, punctuation, spaces, and emoji from
 * ANY language are permitted, but raw control bytes — which have no legitimate
 * place in submitted text and can corrupt logs/rendering — are rejected. It is
 * only a PRESET; callers pass their own {@link SanitiseOptions.allowList} when a
 * stricter set (e.g. slugs) is required.
 */
export const PLAIN_TEXT_ALLOW_LIST: AllowListPredicate = (
  codePoint: string,
): boolean => {
  const cp = codePoint.codePointAt(0);
  if (cp === undefined) {
    return false;
  }
  // Permit the three common whitespace controls.
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
    return true;
  }
  // Reject C0 controls (U+0000–U+001F) and DEL (U+007F).
  if (cp <= 0x1f || cp === 0x7f) {
    return false;
  }
  return true;
};

/**
 * A strict slug allow-list preset: admits ASCII letters, digits, and the hyphen
 * only (`A–Z`, `a–z`, `0–9`, `-`). Suitable for event codes / slugs (Req 3 —
 * "letters, digits, and hyphens").
 */
export const SLUG_ALLOW_LIST: AllowListPredicate =
  allowListFromRegExp(/^[A-Za-z0-9-]$/);

// ----------------------------------------------------------------------------
// Validation options and result.
// ----------------------------------------------------------------------------

/**
 * Configuration for a single {@link sanitise} call — both the allow-list and the
 * maximum length are CONFIGURABLE (Req 21.9, 21.10).
 */
export interface SanitiseOptions {
  /**
   * The name of the field being validated. It is echoed back verbatim in the
   * failure reason so the caller (and ultimately the UI / API response) can
   * identify WHICH field failed (Req 21.11, 22.7).
   */
  readonly field: string;
  /**
   * The maximum permitted length in Unicode CODE POINTS (inclusive). Defaults
   * to {@link DEFAULT_MAX_LENGTH} (500) when omitted (Req 21.10). A value of `0`
   * is honoured (permits only the empty string); it is NOT treated as "unset".
   */
  readonly maxLength?: number;
  /**
   * The allow-list of permitted characters, either as an
   * {@link AllowListPredicate} over code points or as a `RegExp` matching a
   * SINGLE permitted character (adapted internally via
   * {@link allowListFromRegExp}). Input is accepted only if EVERY code point is
   * permitted (Req 21.9).
   */
  readonly allowList: AllowListPredicate | RegExp;
}

/** The reason a value failed {@link sanitise}. */
export type SanitiseFailure =
  | {
      /** The value exceeded the configured maximum length (Req 21.10, 22.7). */
      readonly kind: 'too_long';
      /** The field that failed (Req 21.11, 22.7). */
      readonly field: string;
      /** The maximum permitted length in code points that was exceeded. */
      readonly limit: number;
      /** The actual code-point length of the offending value. */
      readonly actualLength: number;
    }
  | {
      /** The value contained a code point not permitted by the allow-list. */
      readonly kind: 'disallowed_char';
      /** The field that failed (Req 21.11, 22.7). */
      readonly field: string;
      /**
       * The maximum permitted length in code points that applied to this field
       * (the "limit" the caller advertises for the field), included so a single
       * failure reason always carries the field's applicable limit (Req 22.7).
       */
      readonly limit: number;
      /** The first disallowed code point (its one-code-point string form). */
      readonly disallowedChar: string;
      /**
       * The zero-based CODE-POINT index of the first disallowed character, for
       * precise caller diagnostics (not by UTF-16 unit).
       */
      readonly index: number;
    };

/**
 * The outcome of {@link sanitise}: either an acceptance carrying the ORIGINAL,
 * unmodified value, or a rejection carrying a {@link SanitiseFailure}.
 *
 * Note that on success `value` is the input unchanged — this validator NEVER
 * mutates, trims, or otherwise rewrites the input (Req 21.9: the submission is
 * validated before persistence and rejected wholesale on violation; it is not
 * silently "sanitised" into a different value).
 */
export type SanitiseResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: SanitiseFailure };

/**
 * Validates `input` against a configurable allow-list and maximum length,
 * WITHOUT mutating it (Req 21.9, 21.10, 21.11, 22.7).
 *
 * Semantics — `input` is ACCEPTED iff BOTH hold:
 *   - its length in Unicode CODE POINTS is `<= maxLength` (default 500); and
 *   - EVERY code point is permitted by the allow-list.
 *
 * Otherwise it is REJECTED with a {@link SanitiseFailure} that always names the
 * `field` and carries the applicable `limit` (Req 21.11, 22.7). The whole
 * submission is expected to be rejected by the caller on any failure — no
 * partial persistence — and the original `input` is returned untouched on
 * success (never trimmed/normalised here).
 *
 * Check ORDER: the length check runs first, so an over-long value is reported as
 * `too_long` even if it also contains a disallowed character. This gives the
 * caller a single, deterministic primary reason per submission.
 *
 * Iteration is by code point (`for (const cp of input)`), so surrogate-pair
 * characters (emoji, astral scripts) count as one character and are allow-listed
 * as a single unit, matching `char_length` semantics (Req 22.6).
 *
 * @param input the raw submitted text to validate.
 * @param options the field name, optional max length, and allow-list.
 * @returns a {@link SanitiseResult}.
 */
export function sanitise(
  input: string,
  options: SanitiseOptions,
): SanitiseResult {
  const { field } = options;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const isAllowed: AllowListPredicate =
    options.allowList instanceof RegExp
      ? allowListFromRegExp(options.allowList)
      : options.allowList;

  // Count length by CODE POINTS (not UTF-16 units) to match char_length
  // semantics (Req 22.6). `[...input]` iterates by code point.
  const codePoints = [...input];

  // (1) Length check first — reported as the primary reason when exceeded
  // (Req 21.10, 22.7).
  if (codePoints.length > maxLength) {
    return {
      ok: false,
      reason: {
        kind: 'too_long',
        field,
        limit: maxLength,
        actualLength: codePoints.length,
      },
    };
  }

  // (2) Allow-list check — reject on the FIRST disallowed code point (Req 21.9),
  // reporting its code-point index for caller diagnostics.
  for (let index = 0; index < codePoints.length; index += 1) {
    const codePoint = codePoints[index];
    if (!isAllowed(codePoint)) {
      return {
        ok: false,
        reason: {
          kind: 'disallowed_char',
          field,
          limit: maxLength,
          disallowedChar: codePoint,
          index,
        },
      };
    }
  }

  // Accepted — return the ORIGINAL value, unmodified (Req 21.9: no mutation).
  return { ok: true, value: input };
}

/**
 * Convenience wrapper over {@link sanitise} that returns only whether `input`
 * is valid, for callers that do not need the failure reason.
 *
 * @param input the raw submitted text to validate.
 * @param options the field name, optional max length, and allow-list.
 * @returns `true` iff `input` satisfies the allow-list and length limit.
 */
export function isValid(input: string, options: SanitiseOptions): boolean {
  return sanitise(input, options).ok;
}

// ----------------------------------------------------------------------------
// Inert text rendering.
// ----------------------------------------------------------------------------

/**
 * The one-way HTML-escape map applied by {@link toInertText}. Each unsafe
 * character maps to its HTML character reference so it can never open or close a
 * tag, break out of an attribute value, or begin an entity.
 */
const INERT_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', // must be escaped FIRST so we don't double-escape the entities below
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;', // defence-in-depth: neutralises `</script>` and closing-tag sequences
} as const;

/**
 * A single regex matching any character that {@link INERT_ESCAPES} rewrites.
 * Because `&` is the first alternation handled by the replace callback (and the
 * map itself keys `&` → `&amp;`), a single pass over the source string cannot
 * double-escape: each source character maps to exactly one entity.
 */
const INERT_ESCAPE_PATTERN = /[&<>"'/]/g;

/**
 * HTML-escapes `s` so it renders as INERT plain text — it can never be
 * interpreted as executable HTML, script, or other executable markup (Req 21.12,
 * 24.8). The escape is ONE-WAY (there is deliberately no inverse helper here):
 * this module only ever makes text safer to render, never re-activates markup.
 *
 * ── When you need this ──────────────────────────────────────────────────────
 * React already escapes string children by default, so rendering `{text}` in
 * JSX is inert WITHOUT this helper. `toInertText` is DEFENCE-IN-DEPTH for the
 * contexts React does NOT auto-escape, for example:
 *   - building HTML strings outside React (server-rendered emails, CSV/HTML
 *     exports, `document.title`, or any `innerHTML` sink);
 *   - interpolating user text into an attribute value or a `<script>`/`<style>`
 *     block; and
 *   - any non-React consumer of this shared library.
 * NEVER pass user text to `dangerouslySetInnerHTML`/`innerHTML` even after this
 * escape unless you fully understand the sink; prefer text nodes.
 *
 * Escaped characters: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`,
 * `'` → `&#39;`, `/` → `&#x2F;` (`/` is escaped to neutralise closing-tag
 * sequences such as `</script>`). `&` is handled first so entities are not
 * double-escaped. The function is PURE and never mutates its input.
 *
 * @param s the (already length/allow-list-validated) text to render inertly.
 * @returns the HTML-escaped, render-safe string.
 */
export function toInertText(s: string): string {
  return s.replace(INERT_ESCAPE_PATTERN, (char) => INERT_ESCAPES[char] ?? char);
}
