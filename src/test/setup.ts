// Vitest global test setup (task 1.5).
//
// Registers @testing-library/jest-dom custom matchers (e.g. toBeInTheDocument,
// toHaveTextContent) on Vitest's expect, so later UI tests (RequireAuth, the
// admin login form, etc.) have DOM assertions available. Referenced from the
// Vitest `setupFiles` config in vite.config.ts.
//
// Design ref: Testing Strategy. Requirements: 26.1, 26.3.
import '@testing-library/jest-dom/vitest';
