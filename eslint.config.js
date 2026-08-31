import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config (ESLint 9 / typescript-eslint) for the Vite React + TS SPA.
 *
 * - TypeScript + recommended rules via `typescript-eslint`.
 * - React Hooks rules and React Refresh (Vite HMR) checks.
 * - `eslint-config-prettier` is applied last so formatting rules do not clash
 *   with Prettier (task 1.4). Prettier owns style; ESLint owns correctness.
 *
 * Design ref: Technology Stack (Lint / format). Requirements: 26.3.
 */
export default tseslint.config(
  {
    // `supabase/functions` is Deno/Edge-Function code (uses `Deno.*` globals and
    // `jsr:`/npm import specifiers). It is not part of the Vite/Node SPA and is
    // typechecked/linted by the Supabase Deno toolchain, not this ESLint run.
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      '*.tsbuildinfo',
      'supabase/functions',
      // `load` holds the k6 load-test script (load/livepulse-load.js). k6 is a
      // SEPARATE binary with its own module runtime — the file imports k6-only
      // specifiers (`k6`, `k6/http`, `k6/ws`, `k6/metrics`, `k6/data`,
      // `k6/crypto`) and uses k6 runtime globals (`__ENV`, `__VU`, `__ITER`)
      // that Node/ESLint cannot resolve. Like `supabase/functions`, it is not
      // part of the Vite/Node SPA and is NOT linted by this ESLint run.
      'load',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Node-context config files use Node globals, not browser globals.
    files: ['*.config.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Playwright E2E harness (task 41.1): the config + fixtures + `*.e2e.ts`
    // specs run under Node via the Playwright runner (NOT the browser bundle
    // and NOT Vitest). They read `process.env` for env-gating, so expose Node
    // globals. The `test`/`expect` API is imported from `./fixtures`, not
    // global, so no extra test globals are needed here. Requirements: 26.4.
    files: ['e2e/**/*.{ts,tsx}', 'playwright.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Playwright's fixture API uses a callback parameter named `use`
      // (`async ({}, use) => { await use(value); }`). The react-hooks plugin
      // mis-detects that `use(...)` call as a React Hook. This is Node test
      // harness code, not React, so the Hooks rules do not apply here.
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // Test files (Vitest) run with `globals: true`, so expose the Vitest
    // global test API (describe/it/expect/etc.) to ESLint. Added in task 1.5
    // so `npm run lint` still passes with the new test suite.
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
  prettier,
);
