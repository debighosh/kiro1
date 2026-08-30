/**
 * PostCSS configuration for the Vite build.
 *
 * Tailwind processes the @tailwind directives in the global stylesheet and
 * Autoprefixer adds vendor prefixes for the supported browser matrix.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
