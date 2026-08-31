/**
 * Task 35.1 (optional) — Property-based tests for the credential-protection
 * invariants (Property 12 and Property 13), exercised against the pure,
 * Node-testable AI credential RULE module src/lib/ai/credentialRules.ts
 * (task 28.2) — imported, NEVER reimplemented — plus the whitelisted NON-SECRET
 * read-path column set defined by migration
 * `20260101000033_ai_provider_settings_rls.sql` (task 27.1) and mirrored by the
 * `AiProviderSettingsPublic` shape in src/lib/aiClient.ts (task 34.1).
 *
 * WHY A PURE MODULE (AND AN ENV-GATED LIVE-DB PORTION)
 * ---------------------------------------------------
 * The authoritative credential write/resolve logic runs in the Deno edge
 * functions (which cannot execute under Node / Vitest in this sandbox — no Deno
 * globals). src/lib/ai/credentialRules.ts is the AUTHORITATIVE, runtime-agnostic
 * copy of that crypto/XOR/redaction logic (it relies only on the Web Crypto API
 * present in Node 18+ / Vitest). These properties therefore drive that pure
 * module directly.
 *
 * The LIVE-DB assertion — that a client can NEVER select `secret_reference` /
 * `encrypted_credential` from the base table, and that the whitelisted read path
 * omits them — requires a real Postgres+RLS instance and is covered, ENV-GATED,
 * by src/db/rls.ai.test.ts (task 27.3). Here we assert the Node-runnable half:
 * (a) the storage result and the log descriptor NEVER carry the secret, and
 * (b) the whitelisted read-column set (modelled as a constant, mirroring the
 * migration + `AiProviderSettingsPublic`) STRUCTURALLY excludes every secret
 * column. The same `hasLiveSupabase` env-gate as src/db/rls.ai.test.ts guards
 * the optional live-DB reinforcement so this file never fake-passes over a
 * missing DB — it skips that portion cleanly and the pure portion always runs.
 *
 * Validates: Requirements 12.4, 12.6, 12.8, 12.9, 12.10, 21.8 (Req 26.1 for the
 * env-gated live posture).
 * Design: Server-Side AI Gateway Design → Credential handling (secret_reference
 * preferred, AEAD fallback, XOR, plaintext never stored, generic resolve error,
 * redaction for logs); RLS Design → `ai_provider_settings` (non-secret read
 * path; secret columns never client-readable).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  AEAD_KEY_BYTES,
  CREDENTIAL_MAX_LENGTH,
  CredentialStorage,
  chooseStoragePath,
  describeCredentialForLog,
  importAeadKey,
  isValidCredentialXor,
  prepareCredentialForStorage,
} from './credentialRules';

// ---------------------------------------------------------------------------
// Live-DB env-gate — mirrors src/db/rls.ai.test.ts EXACTLY. When a real TEST
// Supabase project is configured the (optional) live secret-exclusion posture
// is reinforced; otherwise it skips cleanly. The PURE properties below always
// run regardless of this flag.
// ---------------------------------------------------------------------------
function readTestEnv(name: string): string | undefined {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  const value = proc?.env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

const hasLiveSupabase =
  readTestEnv('TEST_SUPABASE_URL') !== undefined &&
  readTestEnv('TEST_SUPABASE_ANON_KEY') !== undefined &&
  readTestEnv('TEST_SUPABASE_SERVICE_ROLE_KEY') !== undefined;

// ---------------------------------------------------------------------------
// The whitelisted NON-SECRET read-path column set, mirroring the SECURITY
// DEFINER `read_ai_provider_settings()` return type / `ai_provider_settings_public`
// view (migration …000033) and the `AiProviderSettingsPublic` interface in
// src/lib/aiClient.ts. The SECRET column names below MUST NEVER appear in any
// client-reachable projection (Req 12.8, 12.10, 21.8).
// ---------------------------------------------------------------------------
const WHITELISTED_READ_COLUMNS: readonly string[] = [
  'id',
  'is_active',
  'ai_enabled',
  'display_name',
  'provider_type',
  'base_url',
  'chat_completions_path',
  'auth_type',
  'api_key_header_name',
  'model_id',
  'temperature',
  'max_output_tokens',
  'request_timeout_seconds',
  'tls_verify_required',
  'credential_state',
  'created_at',
  'updated_at',
];

/** The secret columns that must never be in a client read projection. */
const SECRET_COLUMNS: readonly string[] = [
  'secret_reference',
  'encrypted_credential',
];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** A fresh 32-byte AES-256 key material buffer for the fallback path. */
function keyBytes(fill: number): Uint8Array {
  return new Uint8Array(AEAD_KEY_BYTES).fill(fill & 0xff);
}

/**
 * True iff `needle`'s UTF-8 byte sequence appears anywhere inside `haystack`.
 * BYTE-level (not JSON-string) so the ciphertext payload is inspected directly
 * without false positives from the `kind` label text (which is ASCII and would
 * otherwise "contain" short plaintexts). Mirrors credentialRules.test.ts.
 */
function bytesContain(haystack: Uint8Array, needle: string): boolean {
  const needleBytes = new TextEncoder().encode(needle);
  if (needleBytes.length === 0) return false;
  outer: for (let i = 0; i + needleBytes.length <= haystack.length; i++) {
    for (let j = 0; j < needleBytes.length; j++) {
      if (haystack[i + j] !== needleBytes[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * A DISTINCTIVE plaintext credential (≥16 chars, within the 1–8192 bound of
 * Req 12.2) for the leak-detection assertions. A coincidental CONTIGUOUS match
 * of ≥16 bytes inside the random IV/ciphertext (or the structural JSON) is
 * astronomically unlikely, so any positive would indicate REAL leakage —
 * whereas a single random byte matching a 1-char plaintext is expected noise.
 * This mirrors the ≥16-char length floor used by the byte-containment property
 * in credentialRules.test.ts (task 28.3). The full 1–8192 range (incl. the
 * 1-char boundary) round-trip and no-plaintext-in-storage coverage lives in
 * that companion suite; here every plaintext-bearing property is a leak check,
 * so the distinctive floor applies throughout.
 */
const distinctiveCredentialArb: fc.Arbitrary<string> = fc.string({
  minLength: 16,
  maxLength: Math.min(2048, CREDENTIAL_MAX_LENGTH),
});

/**
 * Arbitrary NON-EMPTY secret-reference pointer (the managed-store handle). It
 * is a non-secret pointer, not the credential itself, but must still never be
 * echoed into a log descriptor. A ≥16-char floor keeps the "descriptor never
 * echoes the ref" substring check meaningful: a shorter ref could coincidentally
 * appear inside the descriptor's FIXED field-name text ("secret_reference",
 * "present", "kind"), which is a check artefact, not a real echo of the value.
 */
const secretRefArb: fc.Arbitrary<string> = fc.string({
  minLength: 16,
  maxLength: 128,
});

/** A short secret-reference pointer (1–15 chars) for path-decision cases where
 * no substring leak check is performed — only the storage-path branch matters. */
const shortSecretRefArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 15,
});

// ===========================================================================
// Feature: mss-livepulse, Property 12: Credential never present in any read API
// response or log. For random plaintext credentials and provider configs, the
// prepared storage result and the log/telemetry descriptor NEVER contain the
// plaintext, the ciphertext bytes, or the secret_reference target string; the
// log descriptor is only { kind, present }; and the whitelisted read-column set
// (the client-reachable read API projection) contains NONE of the secret
// columns. Validates Req 12.8, 12.9, 12.10, 21.8.
// ===========================================================================
describe('Feature: mss-livepulse, Property 12: Credential never present in any read API response or log', () => {
  it('the encryption-fallback storage result never embeds the plaintext, and its log descriptor carries no secret (Req 12.8, 12.9)', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctiveCredentialArb,
        fc.integer({ min: 0, max: 255 }),
        async (plaintext, fill) => {
          const key = await importAeadKey(keyBytes(fill));
          // Fallback path: no secret_reference → AEAD-encrypt.
          const storage = await prepareCredentialForStorage(
            plaintext,
            { secretReference: null },
            key,
          );

          expect(storage.kind).toBe('encrypted_credential');
          const blob = (storage as { encrypted_credential: Uint8Array })
            .encrypted_credential;

          // (1) The ciphertext blob must NOT embed the plaintext bytes.
          expect(bytesContain(blob, plaintext)).toBe(false);
          // (2) The storage result carries no plaintext field of any name.
          expect(Object.prototype.hasOwnProperty.call(storage, 'plaintext')).toBe(
            false,
          );
          expect(
            Object.prototype.hasOwnProperty.call(storage, 'credential'),
          ).toBe(false);
          expect(
            Object.prototype.hasOwnProperty.call(storage, 'secret_reference'),
          ).toBe(false);

          // (3) The log descriptor is ONLY { kind, present } — no ciphertext,
          // no plaintext, no reference target.
          const descriptor = describeCredentialForLog(storage);
          expect(Object.keys(descriptor).sort()).toEqual(['kind', 'present']);
          expect(descriptor.kind).toBe('encrypted_credential');
          expect(descriptor.present).toBe(true);
          const descriptorJson = JSON.stringify(descriptor);
          // The descriptor JSON must not contain the plaintext (unless the
          // plaintext is a trivial substring of the fixed field text, which we
          // exclude by asserting no non-field key exists and checking bytes on
          // the blob above — here we assert the descriptor is byte-free of the
          // ciphertext).
          expect(descriptorJson.includes('encrypted_credential')).toBe(true);
          // No raw blob bytes leak: the descriptor holds ONLY primitive
          // string/boolean values (a string `kind` + boolean `present`) — never
          // a typed-array/object carrying ciphertext bytes.
          for (const v of Object.values(descriptor) as unknown[]) {
            expect(['string', 'boolean']).toContain(typeof v);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the secret_reference storage result and its log descriptor never carry the reference target string in the descriptor (Req 12.9)', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctiveCredentialArb,
        secretRefArb,
        async (plaintext, ref) => {
        const storage = await prepareCredentialForStorage(
          plaintext,
          { secretReference: ref },
          null,
        );

        expect(storage.kind).toBe('secret_reference');
        // The result carries the (non-secret) pointer but NEVER the plaintext.
        const storageJson = JSON.stringify(storage);
        expect(storageJson.includes('encrypted_credential')).toBe(false);
        // The plaintext credential must never appear in the storage result.
        // (Only assert when the plaintext isn't coincidentally equal to / a
        // substring of the reference pointer, which is a legitimate stored
        // non-secret value — a ≥16-char distinctive plaintext makes an
        // accidental structural match astronomically unlikely.)
        if (!ref.includes(plaintext)) {
          expect(storageJson.includes(plaintext)).toBe(false);
        }

        // The log descriptor is ONLY { kind, present } — it NEVER echoes the
        // secret_reference target string (Req 12.9).
        const descriptor = describeCredentialForLog(storage);
        expect(Object.keys(descriptor).sort()).toEqual(['kind', 'present']);
        expect(descriptor.kind).toBe('secret_reference');
        expect(descriptor.present).toBe(true);
        const descriptorJson = JSON.stringify(descriptor);
        expect(descriptorJson.includes(ref)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the whitelisted read API column set (client-reachable read path) contains NONE of the secret columns (Req 12.10, 21.8)', () => {
    // A pure STRUCTURAL assertion mirroring migration …000033 and
    // AiProviderSettingsPublic: the client read projection whitelists only
    // non-secret columns, so neither secret column can ever be selected.
    const whitelist = new Set(WHITELISTED_READ_COLUMNS);
    for (const secret of SECRET_COLUMNS) {
      expect(whitelist.has(secret)).toBe(false);
    }
    // credential_state (presence-only) IS surfaced; the value never is.
    expect(whitelist.has('credential_state')).toBe(true);

    // Property form: for any generated "requested column", a client can only
    // ever receive it if it is whitelisted — and no whitelisted column is a
    // secret column.
    fc.assert(
      fc.property(
        fc.constantFrom(...WHITELISTED_READ_COLUMNS, ...SECRET_COLUMNS),
        (column) => {
          const clientReachable = whitelist.has(column);
          if (SECRET_COLUMNS.includes(column)) {
            // A secret column is NEVER client-reachable.
            expect(clientReachable).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Optional live-DB reinforcement — same env-gate/precedent as
  // src/db/rls.ai.test.ts (task 27.3). Skips cleanly with no live DB; the pure
  // properties above always run. The full live secret-exclusion behaviour is
  // asserted by src/db/rls.ai.test.ts against a real Postgres+RLS instance.
  describe.skipIf(!hasLiveSupabase)(
    'live-DB reinforcement: secret columns are never client-selectable',
    () => {
      it('is covered by the live RLS suite (src/db/rls.ai.test.ts) — env-gated here', () => {
        // The authoritative live assertion lives in src/db/rls.ai.test.ts. This
        // placeholder documents the gate so a live run reports it explicitly.
        expect(hasLiveSupabase).toBe(true);
      });
    },
  );
});

// ===========================================================================
// Feature: mss-livepulse, Property 13: Credential storage is exclusive (XOR).
// For random save operations over BOTH the secret_reference path and the
// encryption-fallback path, prepareCredentialForStorage yields EXACTLY ONE of
// secret_reference / encrypted_credential (never both, never plaintext) — the
// XOR invariant (num_nonnulls(secret_reference, encrypted_credential) <= 1)
// holds on the result; and isValidCredentialXor is false ONLY when both a
// non-empty ref and non-empty blob are present. Validates Req 12.4, 12.6.
// ===========================================================================
describe('Feature: mss-livepulse, Property 13: Credential storage is exclusive (XOR)', () => {
  it('prepareCredentialForStorage yields EXACTLY ONE storage value across both paths, never both, never plaintext (Req 12.4, 12.6)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A ≥16-char distinctive plaintext so the no-plaintext-in-result
        // byte/substring leak sub-check is meaningful (see notes on
        // distinctiveCredentialArb); the XOR structural guarantees hold for any
        // length and are additionally covered by credentialArb-driven suites.
        distinctiveCredentialArb,
        // A save operation is EITHER over the secret_reference path (non-empty
        // ref) OR the fallback path (null/empty ref → AEAD-encrypt).
        fc.oneof(
          secretRefArb.map((ref) => ({ secretReference: ref })),
          shortSecretRefArb.map((ref) => ({ secretReference: ref })),
          fc.constantFrom<{ secretReference: string | null }>(
            { secretReference: null },
            { secretReference: '' },
          ),
        ),
        fc.integer({ min: 0, max: 255 }),
        async (plaintext, config, fill) => {
          const expectedPath = chooseStoragePath(config);
          const key =
            expectedPath === 'encrypted_credential'
              ? await importAeadKey(keyBytes(fill))
              : null;

          const storage: CredentialStorage =
            await prepareCredentialForStorage(plaintext, config, key);

          // The chosen path matches the pure decision.
          expect(storage.kind).toBe(expectedPath);

          // Extract the two candidate stored values from the result.
          const ref =
            storage.kind === 'secret_reference'
              ? storage.secret_reference
              : undefined;
          const blob =
            storage.kind === 'encrypted_credential'
              ? storage.encrypted_credential
              : undefined;

          // XOR invariant: num_nonnulls(secret_reference, encrypted_credential)
          // <= 1 — never both present.
          expect(isValidCredentialXor(ref, blob)).toBe(true);
          const present =
            (typeof ref === 'string' && ref.length > 0 ? 1 : 0) +
            (blob != null && blob.length > 0 ? 1 : 0);
          expect(present).toBe(1); // EXACTLY one, never zero, never both.

          // The result NEVER carries the plaintext.
          const json = JSON.stringify(storage);
          if (storage.kind === 'encrypted_credential') {
            expect(bytesContain(blob!, plaintext)).toBe(false);
          } else if (!ref!.includes(plaintext)) {
            expect(json.includes(plaintext)).toBe(false);
          }
          expect(
            Object.prototype.hasOwnProperty.call(storage, 'plaintext'),
          ).toBe(false);
          expect(
            Object.prototype.hasOwnProperty.call(storage, 'credential'),
          ).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('isValidCredentialXor is false ONLY when BOTH a non-empty ref and a non-empty blob are present (num_nonnulls <= 1) (Req 12.6)', () => {
    fc.assert(
      fc.property(
        // ref: null | '' (absent) | non-empty (present)
        fc.oneof(
          fc.constant(null),
          fc.constant(''),
          fc.string({ minLength: 1, maxLength: 64 }),
        ),
        // blob: null | empty | non-empty (present)
        fc.oneof(
          fc.constant(null),
          fc.constant(new Uint8Array(0)),
          fc
            .array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 32 })
            .map((a) => Uint8Array.from(a)),
        ),
        (ref, blob) => {
          const hasRef = typeof ref === 'string' && ref.length > 0;
          const hasBlob = blob != null && blob.length > 0;
          // Independent expected: valid unless BOTH present.
          const expected = !(hasRef && hasBlob);
          expect(isValidCredentialXor(ref, blob)).toBe(expected);
          // num_nonnulls semantics: the count of present values is <= 1 exactly
          // when the XOR check passes.
          const nonNulls = (hasRef ? 1 : 0) + (hasBlob ? 1 : 0);
          expect(nonNulls <= 1).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });
});
