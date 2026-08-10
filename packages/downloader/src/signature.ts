/**
 * Ed25519 detached-signature verification, via `node:crypto` — no dependency.
 *
 * Node's `crypto.verify` accepts `null` as the algorithm for Ed25519/Ed448 keys (the
 * signature algorithm is fixed by the key type itself, unlike RSA/ECDSA where you choose
 * a hash). That is the entire cryptographic operation; everything else in this file is
 * plumbing to accept a public key in whatever shape a caller reasonably has one in:
 * a PEM-encoded SPKI blob, a full DER SPKI buffer, or the bare 32-byte Ed25519 point that
 * `ssh-keygen`/most key-generation tooling hands you.
 *
 * The raw-32-byte case needs unwrapping because Node's `createPublicKey` only accepts
 * PEM or a DER-encoded SPKI structure, never a bare key. SPKI wraps the key in an
 * AlgorithmIdentifier + BIT STRING; for Ed25519 specifically that wrapper is always the
 * same 12 fixed bytes (OID 1.3.101.112, no parameters) followed by the 32 key bytes —
 * verified empirically against `crypto.generateKeyPairSync('ed25519')`'s own SPKI export,
 * which is exactly `302a300506032b6570032100` + the 32 raw bytes, 44 bytes total.
 */

import { KeyObject, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import process from 'node:process';

/** Fixed SPKI prefix for an Ed25519 public key: AlgorithmIdentifier(1.3.101.112) + BIT STRING header. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_KEY_LEN = 32;

function bufferFromRawKey(raw: Buffer): KeyObject {
  if (raw.length === ED25519_RAW_KEY_LEN) {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  }
  // Not 32 bytes: try it as a full DER SPKI structure (44 bytes for Ed25519, but this
  // function is not Ed25519-specific about the *shape* check — createPublicKey validates).
  try {
    return createPublicKey({ key: raw, format: 'der', type: 'spki' });
  } catch (derErr) {
    // Last resort: maybe these bytes are a PEM string that arrived as a Buffer/Uint8Array.
    const text = raw.toString('utf8');
    if (text.includes('-----BEGIN')) {
      return createPublicKey({ key: text, format: 'pem' });
    }
    throw new Error(
      `Not a recognizable Ed25519 public key: expected a raw ${ED25519_RAW_KEY_LEN}-byte key, ` +
        `a DER SPKI buffer, or PEM text (got ${raw.length} bytes).`,
      { cause: derErr },
    );
  }
}

/**
 * Accepts a raw 32-byte Ed25519 public key, or PEM/SPKI text or bytes, and returns a
 * `KeyObject` usable with `verifyEd25519` / `crypto.verify`. Throws on anything else —
 * a key that fails to parse must fail loudly, not be silently treated as "no key".
 */
export function parseEd25519PublicKey(raw: Uint8Array | string): KeyObject {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.includes('-----BEGIN')) {
      return createPublicKey({ key: trimmed, format: 'pem' });
    }
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return bufferFromRawKey(Buffer.from(trimmed, 'hex'));
    }
    // Fall back to base64 (the common wire format for a raw 32-byte key: 44 base64 chars).
    const asBase64 = Buffer.from(trimmed, 'base64');
    if (asBase64.length === ED25519_RAW_KEY_LEN) {
      return bufferFromRawKey(asBase64);
    }
    throw new Error(
      'String public key is neither PEM, 64-char hex, nor base64 of a 32-byte raw Ed25519 key',
    );
  }
  return bufferFromRawKey(Buffer.from(raw));
}

/**
 * Verify a detached Ed25519 signature. Returns false (never throws) for a malformed
 * signature or a mismatch — mirrors `crypto.verify`'s own behavior for bad signature
 * bytes, extended to also swallow key-parsing failures so callers get a plain boolean
 * for "is this trustworthy", not a mix of exceptions and booleans to handle.
 */
export function verifyEd25519(
  data: Uint8Array,
  signature: Uint8Array,
  publicKey: KeyObject | Uint8Array | string,
): boolean {
  try {
    const keyObject =
      publicKey instanceof KeyObject
        ? publicKey
        : parseEd25519PublicKey(publicKey as Uint8Array | string);
    return cryptoVerify(null, data, keyObject, signature);
  } catch {
    return false;
  }
}

/**
 * The catalog's Ed25519 public key, compiled into the binary — `null` until a real
 * signing key has actually been provisioned.
 *
 * HONESTY NOTE: no such key exists yet. Inventing a placeholder here would be worse than
 * leaving this null — a fake key that happens to verify nothing gives a false sense of
 * the feature being "on". `verifyCatalogSignature` in manifest.ts checks this and fails
 * closed (throws) if it is ever asked to verify a signature while this is null, rather
 * than silently accepting or silently no-op-ing.
 */
export const OPENMEMO_CATALOG_PUBLIC_KEY: string | null = null;

/**
 * The catalog public key actually in effect: an env override, if set, wins over the
 * compiled-in constant above (D-20 §17, "签名 + 客户端钉死公钥").
 *
 * ── why an env override exists at all ───────────────────────────────────────────────
 *
 * The private key that signs a catalog must be generated and held by the user on their
 * own machine — never by an agent working in this shared tree (git history here gets
 * pushed to a remote; a key generated in-tree would effectively be a leaked key). That
 * means an agent cannot simply hardcode a real public key into this file either, because
 * doing so requires the user to have already run keygen and handed the resulting public
 * key back — a manual, out-of-band step. `OPENMEMO_CATALOG_PUBLIC_KEY_HEX` lets the user
 * provision (and rotate) that key by setting an environment variable when they run the
 * daemon/build, without needing an agent to edit source and cut a new release first. The
 * exact keygen + this-env-var invocation is documented in `docs/design/D-20-bundled-deps.md`
 * §17 ("给用户的那条命令").
 *
 * This mirrors the existing "env override > compiled default" shape already used
 * elsewhere in this codebase for exactly the same "don't guess, let the operator say
 * so" reason — `OPENMEMO_MANIFEST_DIR` / `OPENMEMO_BUNDLED_MODELS_DIR`
 * (`apps/daemon/src/http/rest/manifests.ts`, `apps/daemon/src/http/rest/modelReconcile.ts`).
 *
 * Once a key is trusted for good (e.g. baked into an official release), the maintainer
 * can also just replace the `null` above directly — the env var is the low-ceremony path
 * for provisioning/testing, not the only path.
 */
export function resolveConfiguredCatalogPublicKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env['OPENMEMO_CATALOG_PUBLIC_KEY_HEX']?.trim();
  return fromEnv ? fromEnv : OPENMEMO_CATALOG_PUBLIC_KEY;
}
