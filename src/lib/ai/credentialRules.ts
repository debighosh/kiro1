/**
 * AI credential storage RULES — the SHARED, framework-agnostic, PURE contract.
 *
 * =============================================================================
 * EDGE-FUNCTION-ONLY LOGIC — NEVER IMPORTED BY THE SPA UI
 * =============================================================================
 * This module is the canonical, Node-testable definition of how an AI provider
 * credential is prepared for storage and later resolved. It implements the
 * write-only credential contract from Requirement 12:
 *
 *   - Preferred:  a managed **`secret_reference`** (a non-secret pointer) is
 *                 stored; the plaintext lives in a managed secret store.
 *   - Fallback:   application-level **AEAD** = AES-256-GCM, keyed by the
 *                 deployment secret `AI_CREDENTIAL_ENCRYPTION_KEY`, storing ONLY
 *                 the ciphertext blob in `encrypted_credential`.
 *   - **XOR:**    exactly ONE of `secret_reference` / `encrypted_credential` is
 *                 ever produced — NEVER both (Req 12.6, mirrored by the DB
 *                 `CHECK (num_nonnulls(secret_reference, encrypted_credential) <= 1)`).
 *   - Plaintext is **never** returned by any function here and is **never**
 *                 part of a storage result (Req 12.4).
 *   - On resolve/decrypt failure a GENERIC error is thrown whose message
 *                 contains NO plaintext and NO partial credential (Req 12.8);
 *                 the raw underlying cause is deliberately discarded so it can
 *                 never leak into logs, telemetry, exports, or `ai_jobs`
 *                 (Req 12.9).
 *
 * -----------------------------------------------------------------------------
 * WHY THIS LIVES UNDER `src/lib/ai/` (and NOT under `supabase/functions/`)
 * -----------------------------------------------------------------------------
 * `supabase/functions` is Deno code, excluded from the SPA `tsc` build and from
 * Vitest, so it cannot be exercised by the Node property tests (task 35). This
 * pure module is therefore the AUTHORITATIVE, Node-testable copy. It has NO
 * React, NO zod, NO Deno globals and NO Node built-in imports — it relies only
 * on the Web Crypto API exposed as `globalThis.crypto.subtle`, which is present
 * in BOTH the Deno runtime AND Node 18+/Vitest. This makes the rule logic
 * runtime-agnostic.
 *
 * The Deno Edge-Function glue (reading the key from `Deno.env`, writing the row
 * with the service-role client) lives in
 * `supabase/functions/_shared/aiCredential.ts`, a thin wrapper that re-declares
 * an identical copy of this crypto/XOR logic (Deno cannot import `src/` at
 * runtime). If a rule changes here, mirror it there too.
 *
 * Requirements traceability: 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9.
 * Design references: Server-Side AI Gateway Design (Credential handling —
 * secret_reference preferred, AEAD fallback, XOR, plaintext never stored);
 * Technology Stack (Crypto AEAD fallback — AES-256-GCM via Web/Node Crypto).
 */

// -----------------------------------------------------------------------------
// Constants — AES-256-GCM parameters and the on-disk byte layout.
// -----------------------------------------------------------------------------

/** AEAD algorithm name (Req 12.5 — authenticated encryption). */
export const AEAD_ALGORITHM = 'AES-GCM' as const;

/** AES-256 key length, in BYTES (256 bits). */
export const AEAD_KEY_BYTES = 32 as const;

/**
 * IV / nonce length, in BYTES. 96-bit (12-byte) is the recommended nonce size
 * for AES-GCM. A fresh random IV is generated for every encryption.
 */
export const AEAD_IV_BYTES = 12 as const;

/**
 * GCM authentication-tag length, in BYTES (128-bit). `crypto.subtle` appends
 * the tag to the ciphertext, so the blob layout does not carry the tag length
 * separately — it is a fixed protocol constant.
 */
export const AEAD_TAG_BYTES = 16 as const;

/**
 * Minimum length of a well-formed encrypted blob: the IV plus at least the auth
 * tag (a zero-length plaintext still yields a tag). Anything shorter is
 * structurally corrupt and must fail closed.
 */
export const MIN_ENCRYPTED_BLOB_BYTES = AEAD_IV_BYTES + AEAD_TAG_BYTES;

/**
 * The generic, credential-free message used for every resolve/decrypt failure.
 * It intentionally reveals NOTHING about the key, the ciphertext, or the
 * plaintext (Req 12.8, 12.9).
 */
export const CREDENTIAL_RESOLUTION_FAILED_MESSAGE =
  'AI credential could not be resolved.';

// Credential length bounds (Req 12.2). Mirrors the shared Zod schema (task 28.1)
// so the rule module fails closed even if an unvalidated value reaches it.
/** Minimum accepted credential length, in characters (Req 12.2). */
export const CREDENTIAL_MIN_LENGTH = 1 as const;
/** Maximum accepted credential length, in characters (Req 12.2). */
export const CREDENTIAL_MAX_LENGTH = 8192 as const;

// -----------------------------------------------------------------------------
// Byte layout of `encrypted_credential`
// -----------------------------------------------------------------------------
//
//   ┌──────────────┬──────────────────────────────────────────────┐
//   │  IV (12 B)   │  ciphertext‖GCM auth tag (≥ 16 B)              │
//   └──────────────┴──────────────────────────────────────────────┘
//   offset 0        offset AEAD_IV_BYTES                     end
//
// The random 12-byte IV is PREPENDED to the AES-GCM output (which itself is the
// ciphertext with the 16-byte auth tag appended by `crypto.subtle`). Decryption
// slices the IV back off and passes the remainder to `crypto.subtle.decrypt`,
// which verifies the tag. The whole blob — and ONLY this blob — is what gets
// written to the `encrypted_credential` `bytea` column (Req 12.5). No plaintext,
// no key material, and no IV-free ciphertext is ever persisted.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Discriminated storage result — XOR by construction (Req 12.6)
// -----------------------------------------------------------------------------

/** Storage decision: the credential lives in a managed secret store. */
export interface SecretReferenceStorage {
  readonly kind: 'secret_reference';
  /** Non-secret pointer to the managed secret (Req 12.3). */
  readonly secret_reference: string;
  /** Always absent on this branch — encodes the XOR at the type level. */
  readonly encrypted_credential?: never;
}

/** Storage decision: the credential is AEAD-encrypted in the DB (fallback). */
export interface EncryptedCredentialStorage {
  readonly kind: 'encrypted_credential';
  /** IV‖ciphertext‖tag blob — ciphertext ONLY, never plaintext (Req 12.5). */
  readonly encrypted_credential: Uint8Array;
  /** Always absent on this branch — encodes the XOR at the type level. */
  readonly secret_reference?: never;
}

/**
 * The result of preparing a credential for storage. It is a discriminated union
 * so EXACTLY ONE storage path is chosen — the XOR (Req 12.6) is guaranteed by
 * construction, and NEITHER variant carries the plaintext (Req 12.4).
 */
export type CredentialStorage =
  SecretReferenceStorage | EncryptedCredentialStorage;

/**
 * Error thrown for every credential resolve/decrypt failure. Its message is the
 * fixed {@link CREDENTIAL_RESOLUTION_FAILED_MESSAGE}; it deliberately carries no
 * `cause`, no key, no ciphertext, and no plaintext (Req 12.8, 12.9). A distinct
 * class lets callers `instanceof`-check without inspecting message text.
 */
export class CredentialResolutionError extends Error {
  constructor() {
    super(CREDENTIAL_RESOLUTION_FAILED_MESSAGE);
    this.name = 'CredentialResolutionError';
  }
}

// -----------------------------------------------------------------------------
// Pure rule logic — storage-path decision and XOR validation
// -----------------------------------------------------------------------------

/**
 * Whether a managed secret store is available for this write. When it is, the
 * preferred path stores a `secret_reference` (Req 12.3); otherwise the AEAD
 * fallback path is used (Req 12.4, 12.5).
 */
export interface CredentialStorageConfig {
  /**
   * The non-secret reference returned by the managed secret store once the
   * plaintext has been handed off to it. When present (non-empty), the
   * preferred `secret_reference` path is taken. When absent, the AEAD fallback
   * is used.
   */
  readonly secretReference?: string | null;
}

/**
 * Classifies which storage path a write will take, WITHOUT touching plaintext.
 * Pure and synchronous so it is trivially property-testable.
 *
 *   - a non-empty `secretReference` → `'secret_reference'` (preferred, Req 12.3)
 *   - otherwise                     → `'encrypted_credential'` (AEAD fallback)
 */
export function chooseStoragePath(
  config: CredentialStorageConfig,
): CredentialStorage['kind'] {
  const ref = config.secretReference;
  if (typeof ref === 'string' && ref.length > 0) {
    return 'secret_reference';
  }
  return 'encrypted_credential';
}

/**
 * Enforces the XOR invariant on a candidate pair of stored values (Req 12.6):
 * at most ONE of `secret_reference` / `encrypted_credential` may be present.
 * Returns `true` when the pair is valid (zero or one present), `false` when
 * BOTH are present. Treats empty string / zero-length blob as "absent" to match
 * the DB `num_nonnulls(...) <= 1` semantics on NULLs.
 */
export function isValidCredentialXor(
  secretReference: string | null | undefined,
  encryptedCredential: Uint8Array | null | undefined,
): boolean {
  const hasRef =
    typeof secretReference === 'string' && secretReference.length > 0;
  const hasEnc = encryptedCredential != null && encryptedCredential.length > 0;
  return !(hasRef && hasEnc);
}

/**
 * Validates that a raw credential string is within the accepted length bounds
 * (Req 12.2) BEFORE any encryption is attempted. Returns `true`/`false` only —
 * it NEVER echoes the credential value, so it is safe to use on a rejection
 * path without risking leakage (Req 12.9).
 */
export function isValidCredentialLength(credential: string): boolean {
  return (
    typeof credential === 'string' &&
    credential.length >= CREDENTIAL_MIN_LENGTH &&
    credential.length <= CREDENTIAL_MAX_LENGTH
  );
}

// -----------------------------------------------------------------------------
// Web Crypto helpers (runtime-agnostic: Deno + Node 18+ + Vitest/jsdom)
// -----------------------------------------------------------------------------

/**
 * Returns the ambient Web Crypto `SubtleCrypto` implementation. `globalThis.
 * crypto` is available as a standard global in the Deno runtime and in Node
 * 18+ (and hence Vitest). We resolve it lazily so the module can be imported in
 * any environment; a missing implementation surfaces as a generic resolution
 * failure rather than a descriptive (and potentially fingerprinting) error.
 */
function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new CredentialResolutionError();
  }
  return c.subtle;
}

/**
 * Imports raw 32-byte key material as an AES-256-GCM {@link CryptoKey}. Throws a
 * generic {@link CredentialResolutionError} if the key is the wrong length —
 * without echoing the key or its length in a way that could aid an attacker.
 */
export async function importAeadKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== AEAD_KEY_BYTES) {
    throw new CredentialResolutionError();
  }
  try {
    return await getSubtle().importKey(
      'raw',
      // Copy into a fresh ArrayBuffer-backed view so a subarray/offset view of a
      // larger buffer cannot smuggle extra bytes into the key.
      keyBytes.slice(),
      { name: AEAD_ALGORITHM },
      false, // non-extractable — the key can never be read back out
      ['encrypt', 'decrypt'],
    );
  } catch {
    // Discard the underlying cause (Req 12.8, 12.9).
    throw new CredentialResolutionError();
  }
}

/**
 * ENCRYPTS a plaintext credential with AES-256-GCM and returns the storage
 * blob (IV‖ciphertext‖tag) — the `encrypted_credential` value. The PLAINTEXT IS
 * DISCARDED: it is never returned, never logged, and never part of the result
 * (Req 12.4, 12.5). A fresh random 12-byte IV is generated per call.
 *
 * @returns the IV-prefixed ciphertext blob to store in `encrypted_credential`.
 * @throws  {@link CredentialResolutionError} on any crypto failure — the error
 *          contains no plaintext or partial credential (Req 12.8).
 */
export async function encryptCredential(
  key: CryptoKey,
  plaintext: string,
): Promise<Uint8Array> {
  try {
    const subtle = getSubtle();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(AEAD_IV_BYTES));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await subtle.encrypt(
      { name: AEAD_ALGORITHM, iv },
      key,
      encoded,
    );
    const cipher = new Uint8Array(cipherBuf);
    // Prepend the IV: [ IV | ciphertext‖tag ].
    const blob = new Uint8Array(iv.length + cipher.length);
    blob.set(iv, 0);
    blob.set(cipher, iv.length);
    return blob;
  } catch {
    // Never surface the plaintext or the underlying cause (Req 12.8, 12.9).
    throw new CredentialResolutionError();
  }
}

/**
 * Prepares a credential for storage, returning the discriminated
 * {@link CredentialStorage} result. This is the single entry point that takes
 * PLAINTEXT and CONFIG and decides the storage path, DISCARDING the plaintext:
 *
 *   - preferred: a managed `secret_reference` (no encryption performed);
 *   - fallback:  AEAD-encrypt and return the ciphertext-only blob.
 *
 * The returned object NEVER contains the plaintext, and by construction carries
 * exactly one of `secret_reference` / `encrypted_credential` (Req 12.4, 12.6).
 *
 * @throws {@link CredentialResolutionError} if the credential fails the length
 *         check or encryption fails — with no plaintext in the error.
 */
export async function prepareCredentialForStorage(
  plaintext: string,
  config: CredentialStorageConfig,
  keyForFallback: CryptoKey | null,
): Promise<CredentialStorage> {
  if (!isValidCredentialLength(plaintext)) {
    // Fail closed without echoing the value (Req 12.2, 12.9).
    throw new CredentialResolutionError();
  }

  if (chooseStoragePath(config) === 'secret_reference') {
    // Preferred path — the managed store holds the plaintext; we keep only the
    // non-secret pointer (Req 12.3). Nothing is encrypted here.
    return {
      kind: 'secret_reference',
      secret_reference: config.secretReference as string,
    };
  }

  // AEAD fallback (Req 12.4, 12.5). A key is required to encrypt.
  if (keyForFallback == null) {
    throw new CredentialResolutionError();
  }
  const encrypted_credential = await encryptCredential(
    keyForFallback,
    plaintext,
  );
  return { kind: 'encrypted_credential', encrypted_credential };
}

/**
 * DECRYPTS an `encrypted_credential` blob back to the plaintext credential, for
 * IN-PROCESS use immediately before an outbound AI request (Req 12.7). The
 * caller MUST discard the returned plaintext as soon as the request completes.
 *
 * On ANY failure — malformed blob, wrong key, corrupt ciphertext, auth-tag
 * mismatch — a generic {@link CredentialResolutionError} is thrown whose message
 * contains NO plaintext and NO partial credential (Req 12.8). The underlying
 * cause is discarded so nothing leaks to logs/telemetry/exports (Req 12.9).
 *
 * @returns the resolved plaintext credential (for immediate, in-memory use).
 */
export async function decryptCredential(
  key: CryptoKey,
  blob: Uint8Array,
): Promise<string> {
  // Fail closed on structurally invalid input before touching the cipher.
  if (!(blob instanceof Uint8Array) || blob.length < MIN_ENCRYPTED_BLOB_BYTES) {
    throw new CredentialResolutionError();
  }
  try {
    const subtle = getSubtle();
    // `.slice()` yields fresh ArrayBuffer-backed views (a stable `BufferSource`)
    // rather than subarrays that may share a `SharedArrayBuffer`-typed buffer.
    const iv = blob.slice(0, AEAD_IV_BYTES);
    const cipher = blob.slice(AEAD_IV_BYTES);
    const plainBuf = await subtle.decrypt(
      { name: AEAD_ALGORITHM, iv },
      key,
      cipher,
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    // Discard the cause; never surface plaintext or partial credential.
    throw new CredentialResolutionError();
  }
}

// -----------------------------------------------------------------------------
// Log/telemetry safety helper (Req 12.9)
// -----------------------------------------------------------------------------

/**
 * Redacts any credential-bearing value for safe logging/telemetry/export. Given
 * a {@link CredentialStorage} (or arbitrary value), returns a structural
 * descriptor that contains NO secret material: the storage KIND and a boolean
 * presence flag only — never the reference target, the ciphertext bytes, or the
 * plaintext (Req 12.9). Use this anywhere a credential context must be logged.
 */
export function describeCredentialForLog(
  value: CredentialStorage | null | undefined,
): { kind: CredentialStorage['kind'] | 'none'; present: boolean } {
  if (value == null) {
    return { kind: 'none', present: false };
  }
  if (value.kind === 'secret_reference') {
    return {
      kind: 'secret_reference',
      present:
        typeof value.secret_reference === 'string' &&
        value.secret_reference.length > 0,
    };
  }
  return {
    kind: 'encrypted_credential',
    present:
      value.encrypted_credential != null &&
      value.encrypted_credential.length > 0,
  };
}
