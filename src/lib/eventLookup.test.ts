/**
 * Task 42.3 — Unit tests for the anonymous event lookup helper
 * (src/lib/eventLookup.ts).
 *
 * These tests cover the audience join flow (Req 2.1, 2.2) with positive
 * (found) and negative (not-found, invalid code) cases.
 *
 * Requirements: 2.1, 2.2, 26.1
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('./supabaseClient', () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
}));

// ── Subject under test ────────────────────────────────────────────────────────
import { findEventByRef } from './eventLookup';

/** Build a chainable mock that ends in maybeSingle(). */
function makeMaybeSingleChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const fn = vi.fn(() => chain);
  chain.select = fn;
  chain.eq = fn;
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  return chain;
}

const VALID_EVENT = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Demo Day 2026',
  slug: 'demo-day',
  status: 'live',
  active_presenter_mode: 'waiting',
};

describe('findEventByRef', () => {
  beforeEach(() => fromMock.mockReset());

  it('positive: returns null for null ref', async () => {
    await expect(findEventByRef(null)).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns null for undefined ref', async () => {
    await expect(findEventByRef(undefined)).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns null for empty string ref', async () => {
    await expect(findEventByRef('')).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: returns null for whitespace-only ref', async () => {
    await expect(findEventByRef('   ')).resolves.toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('positive: resolves event by slug (Req 2.1)', async () => {
    fromMock.mockReturnValue(
      makeMaybeSingleChain({ data: VALID_EVENT, error: null }),
    );
    const result = await findEventByRef('demo-day');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Demo Day 2026');
    expect(result!.slug).toBe('demo-day');
  });

  it('negative: returns null for unknown slug (event not visible — Req 2.2)', async () => {
    fromMock.mockReturnValue(makeMaybeSingleChain({ data: null, error: null }));
    const result = await findEventByRef('unknown-code');
    expect(result).toBeNull();
  });

  it('positive: falls back to id lookup when slug returns nothing and ref is a UUID', async () => {
    const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    fromMock
      .mockReturnValueOnce(makeMaybeSingleChain({ data: null, error: null })) // slug miss
      .mockReturnValueOnce(
        makeMaybeSingleChain({ data: VALID_EVENT, error: null }),
      ); // id hit

    const result = await findEventByRef(uuid);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(uuid);
  });

  it('negative: returns null on slug query error (swallowed, Req 2.2)', async () => {
    fromMock.mockReturnValue(
      makeMaybeSingleChain({ data: null, error: { message: 'db fail' } }),
    );
    const result = await findEventByRef('some-slug');
    expect(result).toBeNull();
  });

  it('negative: returns null when UUID id lookup also fails', async () => {
    const uuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    fromMock
      .mockReturnValueOnce(
        makeMaybeSingleChain({ data: null, error: { message: 'fail' } }),
      ) // slug miss
      .mockReturnValueOnce(
        makeMaybeSingleChain({ data: null, error: { message: 'fail' } }),
      ); // id miss

    const result = await findEventByRef(uuid);
    expect(result).toBeNull();
  });
});
