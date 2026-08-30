import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration for MSS LivePulse.
 *
 * Establishes the mobile-first, accessibility-oriented design foundation that
 * later screens build on (Requirement 24).
 *
 * Design references:
 * - Technology Stack → Styling: Tailwind CSS (utility-first, mobile-first tokens).
 * - Frontend Design → Mobile-first & accessibility approach.
 *
 * Requirements traceability:
 * - 24.1 mobile-first layout reflows without horizontal scroll from 320–768px.
 * - 24.2 touch targets ≥44×44px with ≥8px spacing.
 * - 24.3 visible focus indicators with ≥3:1 contrast (see global stylesheet).
 * - 24.9 text/foreground contrast ratios (colour tokens chosen for AA contrast).
 */
const config: Config = {
  // Content globs so Tailwind can tree-shake unused utilities in production.
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Mobile-first breakpoints. `xs` targets the 320px lower bound from
    // Req 24.1; the default (unprefixed) styles are the ~320px baseline.
    screens: {
      xs: '320px',
      sm: '480px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      // Presenter view is 16:9 / large-screen oriented (Req 7.1).
      present: '1280px',
    },
    extend: {
      // Minimum touch-target size (Req 24.2): use `min-w-touch min-h-touch`
      // on interactive controls to guarantee ≥44×44 CSS px.
      spacing: {
        touch: '44px',
        'touch-gap': '8px',
      },
      minWidth: {
        touch: '44px',
      },
      minHeight: {
        touch: '44px',
      },
      // Mobile-first content container: fluid up to a comfortable reading
      // measure, centred, with safe-area-aware gutters (Req 24.1).
      maxWidth: {
        container: '48rem', // 768px — aligns with the mobile-first upper bound.
      },
      colors: {
        // Neutral, AA-contrast-friendly palette (Req 24.9). Kept minimal;
        // brand colours are applied per-event at runtime (see events.brand_colour).
        surface: {
          DEFAULT: '#ffffff',
          muted: '#f4f5f7',
        },
        ink: {
          // #1a1d21 on #ffffff ≈ 15.9:1 — comfortably exceeds 4.5:1 (Req 24.9).
          DEFAULT: '#1a1d21',
          // #4b5563 on #ffffff ≈ 7.6:1 — safe for secondary text.
          muted: '#4b5563',
        },
        // Focus ring colour chosen to hold ≥3:1 against both light surfaces
        // and typical interactive backgrounds (Req 24.3).
        focus: '#1d4ed8',
      },
    },
  },
  plugins: [],
};

export default config;
