/**
 * `a11y` — SHARED, framework-agnostic accessibility primitives (Task 40.1).
 *
 * =============================================================================
 * SHARED CONTRACT — SINGLE SOURCE OF TRUTH
 * =============================================================================
 * This PURE module (no React, no JSX, no DOM) is the canonical home for small
 * accessibility building blocks reused across every screen:
 *
 *   1. {@link FOCUS_RING} — the standard visible keyboard focus-ring class
 *      string, held to ≥3:1 non-text contrast (Req 24.3).
 *   2. {@link statusIndicator} + {@link StatusIndicator} — a mapping from a
 *      semantic status `kind` to a NON-COLOUR indicator (text label + icon/shape
 *      token) so status is never conveyed by colour alone (Req 24.4).
 *   3. {@link cx} — a tiny, dependency-free class-name join helper (there is no
 *      `clsx`/`classnames` dependency in this project, so this fills that gap
 *      without adding one).
 *
 * Returning DATA (strings/objects) rather than JSX keeps this importable from
 * anywhere — components, hooks, and tests — and keeps the accessibility
 * decisions in ONE reviewable place.
 *
 * The reduced-motion preference (Req 24.6) is intentionally NOT here because it
 * is inherently React/DOM-reactive; it lives in the
 * `usePrefersReducedMotion` hook (`src/hooks/usePrefersReducedMotion.ts`), which
 * is the companion piece of this task.
 *
 * Requirements traceability: 24.3 (visible ≥3:1 focus indicator), 24.4
 * (non-colour status indicators), 24.6 (reduced motion — see the hook).
 * Design references: Frontend Design (Mobile-first & accessibility approach —
 * "All status is conveyed with a text/icon indicator in addition to colour";
 * "focus indicators ≥3:1").
 */

// ----------------------------------------------------------------------------
// Class-name join helper.
// ----------------------------------------------------------------------------

/**
 * Joins class-name fragments into a single space-separated string, dropping any
 * falsy entries (`false`, `null`, `undefined`, `''`, `0`). This lets call sites
 * write conditional classes inline without a `clsx`/`classnames` dependency
 * (the project has none):
 *
 *     cx('btn', isActive && 'btn--active', FOCUS_RING)
 *
 * @param classes any mix of strings and falsy values.
 * @returns the truthy string fragments joined by a single space (possibly
 *   empty).
 */
export function cx(
  ...classes: ReadonlyArray<string | false | null | undefined>
): string {
  return classes.filter((c): c is string => Boolean(c)).join(' ');
}

// ----------------------------------------------------------------------------
// Visible focus ring (Req 24.3).
// ----------------------------------------------------------------------------

/**
 * The STANDARD visible keyboard focus-ring class string, to be applied to every
 * interactive control (buttons, links, inputs, tabs, …) for a consistent,
 * clearly visible focus indicator (Req 24.3).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *   - `focus-visible:outline-none` — removes the browser's default outline, but
 *     only under `:focus-visible`, so we never strip focus styling for keyboard
 *     users; we REPLACE it with the ring below.
 *   - `focus-visible:ring-2` — a 2px ring, drawn only on keyboard/AT focus (not
 *     on mouse click), matching the `:focus-visible` semantics in the global
 *     stylesheet.
 *   - `focus-visible:ring-offset-2` — a 2px offset gap so the ring reads clearly
 *     against the control's own background/border.
 *   - `focus-visible:ring-focus` — colours the ring with the theme `focus`
 *     token (see below).
 *
 * ── ≥3:1 contrast rationale (Req 24.3) ───────────────────────────────────────
 * The `ring-focus` colour is the Tailwind theme token `focus` = `#1d4ed8`
 * (blue-700), configured in `tailwind.config.ts`. Against the light app surfaces
 * (`surface.DEFAULT` `#ffffff` and `surface.muted` `#f4f5f7`) that ring colour
 * has a contrast ratio of roughly 5.6:1 — comfortably above the WCAG 1.4.11
 * non-text-contrast minimum of 3:1 for a focus indicator. The `ring-offset-2`
 * gap further guarantees the indicator is distinguishable even when the focused
 * control's own background is similar in colour to the ring, so the visible
 * boundary of the ring always meets ≥3:1 against the ADJACENT background.
 *
 * Keep this token in sync with the `focus` colour and the `:focus-visible`
 * outline rule in `src/index.css`; changing one without the other risks
 * dropping below the 3:1 threshold.
 */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-focus' as const;

// ----------------------------------------------------------------------------
// Non-colour status indicators (Req 24.4).
// ----------------------------------------------------------------------------

/**
 * The set of semantic status kinds this module can describe. These cover the UX
 * states every screen implements (loading / empty / success / error) plus the
 * common informational/warning states, so any status shown to a user can be
 * backed by a non-colour indicator (Req 24.4).
 */
export type StatusKind =
  'success' | 'warning' | 'error' | 'info' | 'loading' | 'empty';

/**
 * A NON-COLOUR representation of a status (Req 24.4). Every field here is
 * independent of colour, so a consumer can convey the status with a text label,
 * an icon/glyph, AND a distinct shape — guaranteeing the status is legible to
 * users who cannot perceive (or whose device/theme alters) colour.
 *
 * This is DATA, not JSX: a component decides how to render it (e.g. an `<svg>`
 * for the `shape`, a font/emoji glyph for the `icon`, and the `label` as
 * visible text or an accessible name).
 */
export interface StatusIndicator {
  /** The status kind this indicator describes (mirrors the lookup key). */
  readonly kind: StatusKind;
  /**
   * A short, human-readable text label (e.g. `"Error"`). Suitable for visible
   * text and/or an accessible name so the status is conveyed WITHOUT colour.
   */
  readonly label: string;
  /**
   * A Unicode glyph/emoji icon token conveying the status non-verbally (e.g.
   * `"✓"` for success). Distinct per kind so it is never colour-dependent.
   */
  readonly icon: string;
  /**
   * A colour-independent SHAPE token (e.g. `'check'`, `'triangle'`). A renderer
   * can map this to a distinct outline/glyph so the status is distinguishable by
   * shape alone — an additional non-colour channel beyond `label`/`icon`.
   */
  readonly shape: StatusShape;
}

/**
 * Colour-independent shape tokens for {@link StatusIndicator.shape}. Chosen so
 * each status maps to a VISUALLY DISTINCT outline (a circle differs from a
 * triangle differs from an octagon), giving a non-colour channel that survives
 * greyscale/high-contrast rendering.
 */
export type StatusShape =
  | 'check' // success — tick
  | 'triangle' // warning — caution triangle
  | 'octagon' // error — stop/octagon
  | 'circle' // info — informational disc
  | 'spinner' // loading — in-progress
  | 'dashed'; // empty — nothing here yet

/**
 * The canonical, immutable table mapping each {@link StatusKind} to its
 * non-colour {@link StatusIndicator}. Declared once so labels/icons/shapes stay
 * consistent everywhere and cannot drift screen-to-screen (Req 24.4).
 */
const STATUS_INDICATORS: { readonly [K in StatusKind]: StatusIndicator } = {
  success: { kind: 'success', label: 'Success', icon: '✓', shape: 'check' },
  warning: { kind: 'warning', label: 'Warning', icon: '⚠', shape: 'triangle' },
  error: { kind: 'error', label: 'Error', icon: '✕', shape: 'octagon' },
  info: { kind: 'info', label: 'Info', icon: 'ℹ', shape: 'circle' },
  loading: { kind: 'loading', label: 'Loading', icon: '⏳', shape: 'spinner' },
  empty: {
    kind: 'empty',
    label: 'Nothing here yet',
    icon: '∅',
    shape: 'dashed',
  },
} as const;

/**
 * Returns the NON-COLOUR indicator (text label + icon glyph + shape token) for a
 * status kind, so callers can convey status without relying on colour alone
 * (Req 24.4).
 *
 * The returned object is the shared, frozen-by-convention constant from
 * {@link STATUS_INDICATORS}; treat it as READ-ONLY (its fields are `readonly`).
 * Because the lookup is exhaustive over {@link StatusKind}, every valid kind
 * resolves to a defined indicator.
 *
 * @param kind the semantic status to describe.
 * @returns the corresponding {@link StatusIndicator}.
 */
export function statusIndicator(kind: StatusKind): StatusIndicator {
  return STATUS_INDICATORS[kind];
}
