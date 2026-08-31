// =============================================================================
// EDGE-FUNCTION-ONLY — AI CREDENTIAL MODULE (Supabase Edge Functions / Deno)
// =============================================================================
//
//  ⚠️  DO NOT IMPORT THIS MODULE FROM THE REACT SPA OR ANY BROWSER BUNDLE. ⚠️
//
//  This module runs ONLY inside Supabase Edge Functions (the Deno runtime). It
//  implements the write-only AI credential handling from Requirement 12:
//
//    - Preferred: store a managed **`secret_reference`** (a non-secret pointer);
//      the plaintext lives in a managed secret store (Req 12.3).
//    - Fallback:  application-level **AEAD** = AES-256-GCM, keyed by the
//      deployment secret `AI_CREDENTIAL_ENCRYPTION_KEY`, storing ONLY the
//      ciphertext blob in `encrypted_credential` (Req 12.4, 12.5).
//    - **XOR:**   never store BOTH `secret_reference` and `encrypted_credential`
//      (Req 12.6, mirrored by the DB CHECK).
//    - Plaintext is NEVER stored (Req 12.4) and NEVER returned by a read API.
//    - The credential is resolved/decrypted in-process ONLY, immediately before
//      use, then discarded (Req 12.7).
//    - On resolve/decrypt failure a GENERIC error is thrown containing NO
//      plaintext or partial credential (Req 12.8); credentials never appear in
//      logs, errors, telemetry, exports, or `ai_jobs` (Req 12.9).
//
//  -----------------------------------------------------------------------------
//  SHARED-LOGIC NOTE — keep in sync with `src/lib/ai/credentialRules.ts`
//  -----------------------------------------------------------------------------
//  The AUTHORITATIVE, Node-testable copy of the pure crypto/XOR rule logic lives
//  at `src/lib/ai/credentialRules.ts` (the property tests in task 35 import it).
//  Deno cannot import a `src/` path at runtime, so this module RE-DECLARES an
//  identical copy of that logic (mirroring the existing `eventStatus.ts` ⇄
//  `transition-event-status` pattern). If a rule changes in one place, mirror it
//  in the other. Both rely only on the standard Web Crypto API
//  (`globalThis.crypto.subtle`), which is present in Deno AND Node 18+.
//
//  Because this is Deno code it is intentionally NOT part of the SPA `tsc -b`
//  typecheck (tsconfig `include` is `src` only) nor the SPA ESLint run
//  (`supabase/functions` is excluded in `eslint.config.js`). `Deno.*` is resolved
//  by the Supabase Edge Functions / Deno toolchain at deploy time.
//
//  Requirements traceability: 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9.
//  Design references: Server-Side AI Gateway Design (Credential handling —
//  secret_reference preferred, AEAD fallback, XOR, plaintext never stored);
//  Technology Stack (Crypto AEAD fallback — AES-256-GCM via Web/Node Crypto).
// =============================================================================

// -----------------------------------------------------------------------------
// AES-256-GCM parameters and blob layout (mirror of src/lib/ai/credentialRules).
//
//   Blob = [ IV (12 B) | ciphertext‖GCM auth tag (≥ 16 B) ]
//
// A fresh random 12-byte IV is generated per encryption and PREPENDED to the
// AES-GCM output (crypto.subtle appends the 16-byte tag to the ciphertext).
// Only this blob is written to the `encrypted_credential` bytea column.
// -----------------------------------------------------------------------------

const AEAD_ALGORITHM = 'AES-GCM' as const;
const AEAD_KEY_BYTES = 32; // AES-256
const AEAD_IV_BYTES = 12; // 96-bit GCM nonce
const AEAD_TAG_BYTES = 16; // 128-bit GCM tag
const MIN_ENCRYPTED_BLOB_BYTES = AEAD_IV_BYTES + AEAD_TAG_BYTES;

const CREDENTIAL_MIN_LENGTH = 1;
const CREDENTIAL_MAX_LENGTH = 8192; // Req 12.2

/** Fixed, credential-free failure message (Req 12.8, 12.9). */
export const CREDENTIAL_RESOLUTION_FAILED_MESSAGE =
  'AI credential could not be resolved.';

/** The deployment secret that holds the AEAD key material. */
export const AI_CREDENTIAL_ENCRYPTION_KEY_ENV = 'AI_CREDENTIAL_ENCRYPTION_KEY';

// -----------------------------------------------------------------------------
// Discriminated storage result — XOR by construction (Req 12.6).
// -----------------------------------------------------------------------------

export interface SecretReferenceStorage {
  readonly kind: 'secret_reference';
  readonly secret_reference: string;
  readonly encrypted_credential?: never;
}

export interface EncryptedCredentialStorage {
  readonly kind: 'encrypted_credential';
  readonly encrypted_credential: Uint8Array;
  readonly secret_reference?: never;
}

/** Exactly ONE storage path — never both, never plaintext (Req 12.4, 12.6). */
export type CredentialStorage =
  | SecretReferenceStorage
  | EncryptedCredentialStorage;

/** Thrown for every resolve/decrypt failure; carries no secret (Req 12.8). */
export class CredentialResolutionError extends Error {
  constructor() {
    super(CREDENTIAL_RESOLUTION_FAILED_MESSAGE);
    this.name = 'CredentialResolutionError';
  }
}

// -----------------------------------------------------------------------------
// Pure rule logic (mirror of src/lib/ai/credentialRules.ts).
// -----------------------------------------------------------------------------

export interface CredentialStorageConfig {
  readonly secretReference?: string | null;
}

/** Preferred `secret_reference` when a non-empty ref exists, else AEAD. */
export function chooseStoragePath(
  config: CredentialStorageConfig,
): CredentialStorage['kind'] {
  const ref = config.secretReference;
  if (typeof ref === 'string' && ref.length > 0) {
    return 'secret_reference';
  }
  return 'encrypted_credential';
}

/** At most one of ref / ciphertext present — never both (Req 12.6). */
export function isValidCredentialXor(
  secretReference: string | null | undefined,
  encryptedCredential: Uint8Array | null | undefined,
): boolean {
  const hasRef =
    typeof secretReference === 'string' && secretReference.length > 0;
  const hasEnc = encryptedCredential != null && encryptedCredential.length > 0;
  return !(hasRef && hasEnc);
}

/** Length check (Req 12.2); never echoes the value (Req 12.9). */
export function isValidCredentialLength(credential: string): boolean {
  return (
    typeof credential === 'string' &&
    credential.length >= CREDENTIAL_MIN_LENGTH &&
    credential.length <= CREDENTIAL_MAX_LENGTH
  );
}

// -----------------------------------------------------------------------------
// Web Crypto helpers.
// -----------------------------------------------------------------------------

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new CredentialResolutionError();
  }
  return c.subtle;
}

/** Imports raw 32-byte key material as a non-extractable AES-256-GCM key. */
export async function importAeadKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== AEAD_KEY_BYTES) {
    throw new CredentialResolutionError();
  }
  try {
    return await getSubtle().importKey(
      'raw',
      keyBytes.slice(),
      { name: AEAD_ALGORITHM },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new CredentialResolutionError();
  }
}

/** Encrypts plaintext → IV‖ciphertext‖tag blob; discards plaintext. */
export async function encryptCredential(
  key: CryptoKey,
  plaintext: string,
): Promise<Uint8Array> {
  try {
    const subtle = getSubtle();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(AEAD_IV_BYTES));
    const encoded = new TextEncoder().encode(plaintext);
    const cipher = new Uint8Array(
      await subtle.encrypt({ name: AEAD_ALGORITHM, iv }, key, encoded),
    );
    const blob = new Uint8Array(iv.length + cipher.length);
    blob.set(iv, 0);
    blob.set(cipher, iv.length);
    return blob;
  } catch {
    throw new CredentialResolutionError();
  }
}

/** Decrypts an IV-prefixed blob → plaintext (in-process only, Req 12.7). */
export async function decryptCredential(
  key: CryptoKey,
  blob: Uint8Array,
): Promise<string> {
  if (!(blob instanceof Uint8Array) || blob.length < MIN_ENCRYPTED_BLOB_BYTES) {
    throw new CredentialResolutionError();
  }
  try {
    const subtle = getSubtle();
    const iv = blob.subarray(0, AEAD_IV_BYTES);
    const cipher = blob.subarray(AEAD_IV_BYTES);
    return new TextDecoder().decode(
      await subtle.decrypt({ name: AEAD_ALGORITHM, iv }, key, cipher),
    );
  } catch {
    throw new CredentialResolutionError();
  }
}

// -----------------------------------------------------------------------------
// Deno-side glue — reading the key from the environment (NOT Node-testable).
// -----------------------------------------------------------------------------

/**
 * Reads and imports the AEAD key from the `AI_CREDENTIAL_ENCRYPTION_KEY`
 * deployment secret. The env var is expected to hold the base64-encoded 32-byte
 * (256-bit) key. Only the variable NAME (never its value) can ever appear in an
 * error, and any decode/import problem collapses to the generic resolution
 * error (Req 12.8, 12.9).
 *
 * @throws {@link CredentialResolutionError} if the secret is missing/malformed.
 */
export async function getAeadKeyFromEnv(): Promise<CryptoKey> {
  const raw = Deno.env.get(AI_CREDENTIAL_ENCRYPTION_KEY_ENV);
  if (!raw || raw.length === 0) {
    // No key configured — fail closed without echoing anything secret.
    throw new CredentialResolutionError();
  }
  let keyBytes: Uint8Array;
  try {
    const binary = atob(raw.trim());
    keyBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      keyBytes[i] = binary.charCodeAt(i);
    }
  } catch {
    throw new CredentialResolutionError();
  }
  return importAeadKey(keyBytes);
}

/**
 * Prepares a submitted plaintext credential for storage, returning the
 * discriminated {@link CredentialStorage} result (XOR by construction, Req
 * 12.6) with the PLAINTEXT DISCARDED (Req 12.4):
 *
 *   - preferred: a managed `secret_reference` (no encryption), Req 12.3;
 *   - fallback:  AEAD-encrypt using the deployment key and return ciphertext
 *                only (`encrypted_credential`), Req 12.4/12.5.
 *
 * @throws {@link CredentialResolutionError} on invalid length or crypto failure
 *         — the error contains no plaintext or partial credential (Req 12.8).
 */
export async function prepareCredentialForStorage(
  plaintext: string,
  config: CredentialStorageConfig,
): Promise<CredentialStorage> {
  if (!isValidCredentialLength(plaintext)) {
    throw new CredentialResolutionError();
  }
  if (chooseStoragePath(config) === 'secret_reference') {
    return {
      kind: 'secret_reference',
      secret_reference: config.secretReference as string,
    };
  }
  const key = await getAeadKeyFromEnv();
  const encrypted_credential = await encryptCredential(key, plaintext);
  return { kind: 'encrypted_credential', encrypted_credential };
}

/**
 * Resolves a stored credential to plaintext for IN-PROCESS use immediately
 * before an outbound AI request (Req 12.7). The caller MUST discard the
 * returned plaintext once the request completes. On any failure a generic
 * {@link CredentialResolutionError} is thrown (Req 12.8).
 *
 * When a `secret_reference` is used, resolution against the managed secret store
 * is performed by the caller/gateway (task 29.1); this helper handles the AEAD
 * `encrypted_credential` path.
 */
export async function resolveEncryptedCredential(
  encryptedCredential: Uint8Array,
): Promise<string> {
  const key = await getAeadKeyFromEnv();
  return decryptCredential(key, encryptedCredential);
}

/**
 * Redacts a credential context for safe logging/telemetry/export (Req 12.9):
 * returns the storage KIND and a presence flag only — never the reference
 * target, ciphertext bytes, or plaintext.
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
