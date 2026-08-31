/**
 * Task 28.3 (optional) — unit + property tests for the pure, Node-testable AI
 * credential RULE module (src/lib/ai/credentialRules.ts).
 *
 * These tests lock down the write-only credential contract (Requirement 12):
 *   - XOR: `isValidCredentialXor` returns false ONLY when BOTH a secret
 *     reference and an encrypted blob are present (Req 12.6).
 *   - Storage-path decision prefers a managed `secret_reference` when one is
 *     available, else the AEAD fallback (Req 12.3, 12.4).
 *   - A real AES-256-GCM round-trip (via `importAeadKey` + `globalThis.crypto`,
 *     which runs under Node 18+/Vitest) recovers the plaintext (Req 12.5, 12.7).
 *   - `prepareCredentialForStorage` returns a discriminated result that NEVER
 *     embeds the plaintext (asserted via `JSON.stringify`) (Req 12.4).
 *   - `decryptCredential` on a corrupt blob / wrong key throws a
 *     `CredentialResolutionError` whose message is exactly the generic
 *     `CREDENTIAL_RESOLUTION_FAILED_MESSAGE` and contains NO plaintext (Req
 *     12.8, 12.9).
 * A fast-check property covers arbitrary valid plaintext (1–8192 chars):
 * round-trip recovers it AND the storage result never embeds the plaintext.
 *
 * These are PURE Node tests — no DB, no Deno. They must actually RUN.
 *
 * Requirements: 12.2, 12.4, 12.6, 12.8, 26.1.
 * Design: Server-Side AI Gateway Design → Credential handling (secret_reference
 * preferred, AEAD fallback, XOR, plaintext never stored).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  AEAD_IV_BYTES,
  AEAD_KEY_BYTES,
  CREDENTIAL_MAX_LENGTH,
  CREDENTIAL_RESOLUTION_FAILED_MESSAGE,
  CredentialResolutionError,
  chooseStoragePath,
  decryptCredential,
  describeCredentialForLog,
  encryptCredential,
  importAeadKey,
  isValidCredentialLength,
  isValidCredentialXor,
  prepareCredentialForStorage,
} from './credentialRules';

// A deterministic 32-byte key for the example tests.
function fixedKeyBytes(fill = 7): Uint8Array {
  return new Uint8Array(AEAD_KEY_BYTES).fill(fill);
}

/**
 * True if `needle`'s UTF-8 byte sequence appears anywhere inside `haystack`.
 * We compare BYTES (not a JSON string) so the check inspects only the stored
 * ciphertext payload — never metadata like the storage `kind` label, whose
 * text ("encrypted_credential") coincidentally contains common letters and
 * would otherwise produce false positives for short plaintexts.
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

// ===========================================================================
// XOR enforcement (Req 12.6)
// ===========================================================================
describe('isValidCredentialXor — at most one storage value (Req 12.6)', () => {
  it('is valid when neither value is present', () => {
    expect(isValidCredentialXor(null, null)).toBe(true);
    expect(isValidCredentialXor(undefined, undefined)).toBe(true);
    expect(isValidCredentialXor('', new Uint8Array(0))).toBe(true);
  });
  it('is valid when only the secret reference is present', () => {
    expect(isValidCredentialXor('secret://ref', null)).toBe(true);
  });
  it('is valid when only the encrypted blob is present', () => {
    expect(isValidCredentialXor(null, new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it('is INVALID only when BOTH are present', () => {
    expect(
      isValidCredentialXor('secret://ref', new Uint8Array([1, 2, 3])),
    ).toBe(false);
  });
});

// ===========================================================================
// Storage-path decision (Req 12.3, 12.4)
// ===========================================================================
describe('chooseStoragePath — prefer secret_reference (Req 12.3)', () => {
  it('chooses secret_reference when a non-empty reference is available', () => {
    expect(chooseStoragePath({ secretReference: 'secret://ref' })).toBe(
      'secret_reference',
    );
  });
  it('falls back to encrypted_credential when no reference is available', () => {
    expect(chooseStoragePath({ secretReference: null })).toBe(
      'encrypted_credential',
    );
    expect(chooseStoragePath({ secretReference: '' })).toBe(
      'encrypted_credential',
    );
    expect(chooseStoragePath({})).toBe('encrypted_credential');
  });
});

// ===========================================================================
// Length validation (Req 12.2)
// ===========================================================================
describe('isValidCredentialLength — 1–8192 (Req 12.2)', () => {
  it('rejects empty and over-max', () => {
    expect(isValidCredentialLength('')).toBe(false);
    expect(isValidCredentialLength('x'.repeat(CREDENTIAL_MAX_LENGTH + 1))).toBe(
      false,
    );
  });
  it('accepts the boundary lengths', () => {
    expect(isValidCredentialLength('x')).toBe(true);
    expect(isValidCredentialLength('x'.repeat(CREDENTIAL_MAX_LENGTH))).toBe(
      true,
    );
  });
});

// ===========================================================================
// importAeadKey — key-length enforcement (Req 12.5)
// ===========================================================================
describe('importAeadKey — requires a 32-byte key (Req 12.5)', () => {
  it('imports a valid 32-byte key', async () => {
    const key = await importAeadKey(fixedKeyBytes());
    expect(key).toBeDefined();
  });
  it('throws CredentialResolutionError for a wrong-length key', async () => {
    await expect(importAeadKey(new Uint8Array(16))).rejects.toBeInstanceOf(
      CredentialResolutionError,
    );
  });
});

// ===========================================================================
// AEAD round-trip (Req 12.5, 12.7)
// ===========================================================================
describe('encrypt/decrypt round-trip (Req 12.5, 12.7)', () => {
  it('recovers the plaintext through a real AES-256-GCM round-trip', async () => {
    const key = await importAeadKey(fixedKeyBytes());
    const plaintext = 'sk-super-secret-value-123';
    const blob = await encryptCredential(key, plaintext);
    // Blob is IV-prefixed and does not equal the plaintext bytes.
    expect(blob.length).toBeGreaterThan(AEAD_IV_BYTES);
    const recovered = await decryptCredential(key, blob);
    expect(recovered).toBe(plaintext);
  });

  it('produces a ciphertext blob that does not contain the plaintext bytes', async () => {
    const key = await importAeadKey(fixedKeyBytes());
    const plaintext = 'plaintext-marker-ABCDEF';
    const blob = await encryptCredential(key, plaintext);
    expect(bytesContain(blob, plaintext)).toBe(false);
  });
});

// ===========================================================================
// Decrypt failures — generic, plaintext-free error (Req 12.8, 12.9)
// ===========================================================================
describe('decryptCredential failures are generic and leak nothing (Req 12.8, 12.9)', () => {
  it('throws the generic error for a structurally-too-short blob', async () => {
    const key = await importAeadKey(fixedKeyBytes());
    await expect(decryptCredential(key, new Uint8Array(4))).rejects.toThrow(
      CREDENTIAL_RESOLUTION_FAILED_MESSAGE,
    );
  });

  it('throws the generic error for a corrupted blob', async () => {
    const key = await importAeadKey(fixedKeyBytes());
    const plaintext = 'corrupt-me-please';
    const blob = await encryptCredential(key, plaintext);
    // Flip a byte in the ciphertext/tag region so the auth tag fails.
    const corrupted = blob.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    let thrown: unknown;
    try {
      await decryptCredential(key, corrupted);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CredentialResolutionError);
    expect((thrown as Error).message).toBe(
      CREDENTIAL_RESOLUTION_FAILED_MESSAGE,
    );
    expect((thrown as Error).message).not.toContain(plaintext);
  });

  it('throws the generic error when the wrong key is used', async () => {
    const encryptKey = await importAeadKey(fixedKeyBytes(1));
    const wrongKey = await importAeadKey(fixedKeyBytes(2));
    const plaintext = 'wrong-key-secret';
    const blob = await encryptCredential(encryptKey, plaintext);
    let thrown: unknown;
    try {
      await decryptCredential(wrongKey, blob);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CredentialResolutionError);
    expect((thrown as Error).message).toBe(
      CREDENTIAL_RESOLUTION_FAILED_MESSAGE,
    );
    expect((thrown as Error).message).not.toContain(plaintext);
  });
});

// ===========================================================================
// prepareCredentialForStorage — discriminated result, no plaintext (Req 12.4, 12.6)
// ===========================================================================
describe('prepareCredentialForStorage — never embeds plaintext (Req 12.4)', () => {
  it('returns the secret_reference branch without any plaintext', async () => {
    const plaintext = 'top-secret-reference-value';
    const result = await prepareCredentialForStorage(
      plaintext,
      { secretReference: 'secret://managed/ref' },
      null,
    );
    expect(result.kind).toBe('secret_reference');
    expect(JSON.stringify(result)).not.toContain(plaintext);
    // XOR holds: no encrypted blob on this branch.
    expect(
      isValidCredentialXor(
        result.kind === 'secret_reference' ? result.secret_reference : null,
        result.kind === 'encrypted_credential'
          ? result.encrypted_credential
          : null,
      ),
    ).toBe(true);
  });

  it('returns the encrypted_credential branch (blob only) without plaintext', async () => {
    const key = await importAeadKey(fixedKeyBytes());
    const plaintext = 'fallback-encrypted-secret';
    const result = await prepareCredentialForStorage(
      plaintext,
      { secretReference: null },
      key,
    );
    expect(result.kind).toBe('encrypted_credential');
    // The stored payload is ciphertext ONLY — the plaintext bytes must not
    // appear anywhere inside the encrypted blob.
    if (result.kind === 'encrypted_credential') {
      expect(bytesContain(result.encrypted_credential, plaintext)).toBe(false);
    }
  });

  it('throws the generic error when a fallback is needed but no key is given', async () => {
    await expect(
      prepareCredentialForStorage('needs-a-key', { secretReference: null }, null),
    ).rejects.toBeInstanceOf(CredentialResolutionError);
  });

  it('throws the generic error for an out-of-bounds credential length', async () => {
    await expect(
      prepareCredentialForStorage('', { secretReference: null }, null),
    ).rejects.toBeInstanceOf(CredentialResolutionError);
  });
});

// ===========================================================================
// describeCredentialForLog — redaction (Req 12.9)
// ===========================================================================
describe('describeCredentialForLog — structural, secret-free (Req 12.9)', () => {
  it('describes a secret_reference storage without revealing the target', () => {
    const desc = describeCredentialForLog({
      kind: 'secret_reference',
      secret_reference: 'secret://managed/ref',
    });
    expect(desc).toEqual({ kind: 'secret_reference', present: true });
    expect(JSON.stringify(desc)).not.toContain('secret://managed/ref');
  });
  it('describes an encrypted_credential storage without the bytes', () => {
    const desc = describeCredentialForLog({
      kind: 'encrypted_credential',
      encrypted_credential: new Uint8Array([9, 9, 9]),
    });
    expect(desc).toEqual({ kind: 'encrypted_credential', present: true });
  });
  it('describes absence', () => {
    expect(describeCredentialForLog(null)).toEqual({
      kind: 'none',
      present: false,
    });
  });
});

// ===========================================================================
// Property: round-trip recovers plaintext AND storage never embeds it.
// ===========================================================================
describe('property — credential round-trip + no-plaintext-in-storage (Req 12.4, 12.5)', () => {
  it('recovers arbitrary 1–8192-char plaintext through encrypt→decrypt', async () => {
    const key = await importAeadKey(fixedKeyBytes(42));
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 8192 }),
        async (plaintext) => {
          // Fallback (encrypt) path.
          const storage = await prepareCredentialForStorage(
            plaintext,
            { secretReference: null },
            key,
          );
          if (storage.kind !== 'encrypted_credential') return false;
          // Round-trip recovers the EXACT plaintext.
          const recovered = await decryptCredential(
            key,
            storage.encrypted_credential,
          );
          return recovered === plaintext;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('never embeds a distinctive plaintext as a contiguous byte run in the ciphertext', async () => {
    // Use a meaningfully long (≥16-char) plaintext: a coincidental contiguous
    // match of that many bytes in the random IV/ciphertext is astronomically
    // unlikely, so a positive here would indicate real plaintext leakage —
    // whereas a single random byte matching is expected noise (hence the
    // length floor rather than testing 1-char inputs).
    const key = await importAeadKey(fixedKeyBytes(42));
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 16, maxLength: 2048 }),
        async (plaintext) => {
          const storage = await prepareCredentialForStorage(
            plaintext,
            { secretReference: null },
            key,
          );
          if (storage.kind !== 'encrypted_credential') return false;
          // The stored ciphertext payload never embeds the plaintext bytes.
          return !bytesContain(storage.encrypted_credential, plaintext);
        },
      ),
      { numRuns: 100 },
    );
  });
});
