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
