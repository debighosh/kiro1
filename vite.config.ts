import { defineConfig } from 'vite';
// Importing from `vitest/config` augments the Vite config type with the `test`
// field (replacing the former `/// <reference types="vitest/config" />`, which
// eslint flags as redundant once the module is imported) and gives us
// `configDefaults` to preserve Vitest's built-in excludes below.
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vitest configuration (task 1.5). Kept in the Vite config to stay consistent
  // with the existing build setup. Design ref: Testing Strategy (Vitest, fast-check).
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Playwright E2E specs (task 41.1) live under `e2e/` and are named
    // `*.e2e.ts` — already outside the `{test,spec}` include glob above. This
    // explicit exclude is belt-and-suspenders so Vitest NEVER imports the
    // Playwright runner (`@playwright/test`), which throws outside `playwright
    // test`. Playwright is a separate runner (see playwright.config.ts).
    exclude: [...configDefaults.exclude, 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**'],
    },
  },
});
