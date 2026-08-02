/**
 * Manifest loading with three-tier degradation.
 *
 * Copied deliberately from ComfyUI-Manager's `local | cache | remote` mode system, which
 * is battle-tested in production: it fetches remotely, caches for a day, and silently
 * falls back to the bundled copy on any network error.
 *
 * Our additions over ComfyUI-Manager:
 *   - zod validation at every tier (its registry has string sizes and no hashes)
 *   - HTTPS-only, host-allowlisted URLs enforced by the schema
 *   - the bundled tier is committed to git (ADR-001 mandates manifests be in-repo so
 *     "what did we download" stays auditable)
 *
 * Signature verification is implemented (see verifyCatalogSignature below) but NOT yet
 * ACTIVE in production, because no signing key has been provisioned — see that function's
 * doc comment for what protects the catalog in the meantime.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  type ValidationResult,
  validateBackendManifest,
  validateModelManifest,
} from '@openmemo/shared';
import { OPENMEMO_CATALOG_PUBLIC_KEY, verifyEd25519 } from './signature.js';

export type ManifestTier = 'remote' | 'cache' | 'bundled';

export interface LoadedManifest<T> {
  data: T;
  source: ManifestTier;
  fetchedAt: string;
  /** True when serving cached/bundled data; the UI shows an offline banner. */
  stale: boolean;
}

export const CATALOG_TTL_MS = 24 * 3600 * 1000;
export const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;

export interface LoadManifestOptions {
  /** Remote catalog URL. Omit to stay offline. */
  remoteUrl?: string;
  /** Directory for the cached copy. */
  cacheDir: string;
  /** Path to the bundled manifest committed in vendor/manifests/. */
  bundledPath: string;
  cacheFileName: string;
  /** Force a network fetch even when the cache is fresh. */
  refresh?: boolean;
  timeoutMs?: number;
  validate: (input: unknown) => ValidationResult<unknown>;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function fileAgeMs(file: string): Promise<number | null> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Load a manifest, preferring fresh remote data but never failing outright.
 * Degradation order: remote → cache (any age) → bundled.
 */
export async function loadManifest<T>(opts: LoadManifestOptions): Promise<LoadedManifest<T>> {
  const cacheFile = path.join(opts.cacheDir, opts.cacheFileName);
  const etagFile = `${cacheFile}.etag`;
  const cacheAge = await fileAgeMs(cacheFile);
  const cacheFresh = cacheAge != null && cacheAge < CATALOG_TTL_MS;

  if (opts.remoteUrl && (opts.refresh || !cacheFresh)) {
    try {
      const prevEtag = await fs.readFile(etagFile, 'utf8').catch(() => '');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
      let res: Response;
      try {
        res = await fetch(opts.remoteUrl, {
          headers: prevEtag ? { 'if-none-match': prevEtag } : {},
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 304) {
        const cached = await readJson(cacheFile);
        const v = opts.validate(cached);
        if (v.ok) {
          return {
            data: v.data as T,
            source: 'cache',
            fetchedAt: new Date(Date.now() - (cacheAge ?? 0)).toISOString(),
            stale: false,
          };
        }
      } else if (res.ok) {
        const body = await res.json();
        const v = opts.validate(body);
        if (!v.ok) {
          // A remote catalog that fails validation is treated as hostile, not as
          // "close enough" — fall through to the cached/bundled copy.
          throw new Error(`remote manifest failed validation: ${v.errors.slice(0, 3).join('; ')}`);
        }
        await fs.mkdir(opts.cacheDir, { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(body), 'utf8');
        const etag = res.headers.get('etag');
        if (etag) await fs.writeFile(etagFile, etag, 'utf8');
        return {
          data: v.data as T,
          source: 'remote',
          fetchedAt: new Date().toISOString(),
          stale: false,
        };
      }
    } catch {
      // Any network/validation failure degrades rather than propagating.
    }
  }

  const cached = await readJson(cacheFile);
  if (cached) {
    const v = opts.validate(cached);
    if (v.ok) {
      return {
        data: v.data as T,
        source: 'cache',
        fetchedAt: new Date(Date.now() - (cacheAge ?? 0)).toISOString(),
        stale: (cacheAge ?? 0) > STALE_AFTER_MS,
      };
    }
  }

  const bundled = await readJson(opts.bundledPath);
  const v = opts.validate(bundled);
  if (!v.ok) {
    throw new Error(
      `Bundled manifest ${opts.bundledPath} is invalid: ${v.errors.slice(0, 5).join('; ')}`,
    );
  }
  return {
    data: v.data as T,
    source: 'bundled',
    fetchedAt: new Date().toISOString(),
    stale: true,
  };
}

export function loadModelManifest<T>(
  o: Omit<LoadManifestOptions, 'validate' | 'cacheFileName'> & { cacheFileName?: string },
) {
  return loadManifest<T>({
    ...o,
    cacheFileName: o.cacheFileName ?? 'models.json',
    validate: validateModelManifest as (i: unknown) => ValidationResult<unknown>,
  });
}

export function loadBackendManifest<T>(
  o: Omit<LoadManifestOptions, 'validate' | 'cacheFileName'> & { cacheFileName?: string },
) {
  return loadManifest<T>({
    ...o,
    cacheFileName: o.cacheFileName ?? 'backends.json',
    validate: validateBackendManifest as (i: unknown) => ValidationResult<unknown>,
  });
}

/**
 * Detached-signature verification for remote catalogs.
 *
 * A real requirement, not an optional nicety: a catalog contains download URLs, so
 * whoever controls the catalog controls what the app fetches. ComfyUI-Manager relies on a
 * URL allowlist plus a post-hoc malware blocklist and has needed repeated security
 * patches — Ed25519 signing is the harder-to-bypass layer on top of that same allowlist
 * idea.
 *
 * The verification itself (Ed25519 via node:crypto, see signature.ts) is fully
 * implemented and correct. What is HONESTLY NOT TRUE YET: this is not active in
 * production, because `OPENMEMO_CATALOG_PUBLIC_KEY` is `null` — no signing key has been
 * provisioned. `loadManifest` above never calls this function; nothing currently produces
 * a `.sig` file to verify against. Wiring it into the remote-fetch path is future work,
 * gated on actually having a key.
 *
 * Until a key exists, the real protection against a hostile/compromised catalog is:
 *   (a) every file carries a SHA-256 in `vendor/manifests/*.json`, committed to git and
 *       schema-validated at every load tier (remote/cache/bundled) — ADR-001;
 *   (b) the schema restricts mirror URLs to an allowlisted host set (see @openmemo/shared
 *       schemas.ts), so a compromised catalog cannot simply point at an arbitrary origin.
 *
 * Fail-closed by design: if a caller supplies a signature to check but no key is
 * configured (the `publicKey` param, or the module default, is null), this THROWS rather
 * than returning `true` or silently skipping the check. A signature nobody can verify
 * must never be treated as equivalent to "verified" — that would be strictly worse than
 * not attempting verification at all, because it would look secure while being a no-op.
 */
export async function verifyCatalogSignature(
  catalogBytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array | string | null = OPENMEMO_CATALOG_PUBLIC_KEY,
): Promise<boolean> {
  if (publicKey == null) {
    throw new Error(
      'verifyCatalogSignature: a signature was supplied but no catalog signing key is ' +
        'configured (OPENMEMO_CATALOG_PUBLIC_KEY is null — no key has been provisioned yet). ' +
        'Failing closed rather than silently accepting an unverifiable signature.',
    );
  }
  return verifyEd25519(catalogBytes, signature, publicKey);
}
