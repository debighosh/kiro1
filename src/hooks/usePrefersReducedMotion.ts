/**
 * `usePrefersReducedMotion` — reactive access to the user's OS/browser
 * "reduce motion" preference (Task 40.1).
 *
 * This hook is the SHARED, React-side source of truth for whether the current
 * user has requested reduced motion via their operating system or browser
 * (`prefers-reduced-motion: reduce`). Screens use it to switch off non-essential
 * animation/transition and to keep any remaining essential state change
 * effectively instantaneous (Req 24.6). It complements the CSS-only
 * `@media (prefers-reduced-motion: reduce)` block in `src/index.css`: the CSS
 * handles declarative animation, while this hook lets components make
 * JavaScript-level decisions (e.g. skip an imperative transition, choose a
 * non-animated code path, or pass `reducedMotion` down to a chart/word-cloud
 * renderer).
 *
 * ── Reactivity ───────────────────────────────────────────────────────────────
 * The preference can change AT RUNTIME (the user toggles the OS setting while
 * the page is open). The hook therefore subscribes to the underlying
 * `MediaQueryList` and re-renders when the preference flips, then unsubscribes
 * on unmount so no listener leaks. Both the modern `addEventListener('change')`
 * API and the legacy `addListener` API (older Safari/WebKit) are supported.
 *
 * ── SSR / jsdom safety & the chosen default ──────────────────────────────────
 * `window` / `window.matchMedia` may be ABSENT during server-side rendering and
 * are frequently absent (or unimplemented) under jsdom in tests. In every such
 * case the hook returns its documented DEFAULT of `false`, meaning "NO reduction
 * requested" — i.e. animate normally. This is the deliberately SAFE default:
 *
 *   - It matches the browser default (most users have not opted into reduced
 *     motion), so hydration on the client agrees with an SSR render.
 *   - It degrades toward the richer (animated) experience only when we genuinely
 *     cannot detect a preference; any user who HAS opted in is still fully
 *     honoured by the CSS `@media` rule regardless of this hook, so no
 *     accessibility guarantee is lost by defaulting to `false` here.
 *
 * Requirements traceability: 24.6 (respect `prefers-reduced-motion`).
 * Design references: Frontend Design (Mobile-first & accessibility approach —
 * "Respect `prefers-reduced-motion`: disable non-essential animation").
 */
import { useEffect, useState } from 'react';

/**
 * The media query that is true when the user has requested reduced motion at the
 * OS/browser level. Kept as a module constant so the hook and any future helper
 * reference the identical string.
 */
export const PREFERS_REDUCED_MOTION_QUERY =
  '(prefers-reduced-motion: reduce)' as const;

/**
 * Reads the current reduced-motion preference once, guarding against SSR/jsdom
 * environments where `window`/`matchMedia` are unavailable. Returns `false`
 * (animate; no reduction requested) whenever the preference cannot be detected —
 * see the module doc for why this default is safe.
 */
function getPrefersReducedMotion(): boolean {
  // SSR / non-DOM environments: no `window` at all.
  if (typeof window === 'undefined') {
    return false;
  }
  // jsdom and very old browsers may not implement `matchMedia`.
  if (typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(PREFERS_REDUCED_MOTION_QUERY).matches;
}

/**
 * Returns whether the user has requested reduced motion, updating reactively if
 * the preference changes while the component is mounted.
 *
 * @returns `true` when `prefers-reduced-motion: reduce` matches; `false`
 *   otherwise, including whenever the preference cannot be detected (SSR/jsdom
 *   or no `matchMedia`) — see the module doc for the rationale behind this
 *   default.
 */
export function usePrefersReducedMotion(): boolean {
  // Initialise from the current preference so the very first render is correct
  // on the client and falls back to the safe default under SSR/jsdom.
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(
    getPrefersReducedMotion,
  );

  useEffect(() => {
    // Re-guard inside the effect: the effect only runs in the browser, but we
    // still defend against a missing `matchMedia` (jsdom) so tests never throw.
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }

    const mediaQueryList = window.matchMedia(PREFERS_REDUCED_MOTION_QUERY);

    // Sync once on mount in case the preference changed between the initial
    // `useState` read and the effect running (e.g. after hydration).
    setPrefersReducedMotion(mediaQueryList.matches);

    const handleChange = (event: MediaQueryListEvent): void => {
      setPrefersReducedMotion(event.matches);
    };

    // Modern browsers expose `addEventListener`; older WebKit/Safari only
    // expose the deprecated `addListener`. Support both, and clean up whichever
    // we attached on unmount so no listener leaks.
    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', handleChange);
      return () => {
        mediaQueryList.removeEventListener('change', handleChange);
      };
    }

    // Legacy fallback (deprecated API, still present in older engines).
    mediaQueryList.addListener(handleChange);
    return () => {
      mediaQueryList.removeListener(handleChange);
    };
  }, []);

  return prefersReducedMotion;
}
