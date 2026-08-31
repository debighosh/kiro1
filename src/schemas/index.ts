/**
 * Shared Zod schemas live here (event input validation, and — in later tasks —
 * AI structured-output schemas). These schemas are framework-agnostic and
 * dependency-light so they can be shared by both the client (forms) and the
 * Supabase Edge Functions.
 */
export * from './event';
export * from './ai';
