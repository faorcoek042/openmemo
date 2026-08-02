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
 * Signature verification is specified but NOT yet implemented — see verifyCatalogSignature.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  type ValidationResult,
  validateBackendManifest,
  validateModelManifest,
} from '@openmemo/shared';

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
 * NOT IMPLEMENTED. Specified here because it is a real requirement, not an optional
 * nicety: a catalog contains download URLs, so whoever controls the catalog controls
 * what the app fetches. ComfyUI-Manager relies on a URL allowlist plus a post-hoc
 * malware blocklist and has needed repeated security patches.
 *
 * Planned: Ed25519 detached signature, public key compiled into the binary, verification
 * failure rejects the catalog outright (degrade to cache/bundled, never "accept anyway").
 * Until this exists, the real protection is that every file carries a SHA-256 in a
 * manifest committed to git, and the schema restricts URLs to an allowlisted host set.
 */
export async function verifyCatalogSignature(
  _catalogBytes: Uint8Array,
  _signature: Uint8Array,
  _publicKey: Uint8Array,
): Promise<boolean> {
  throw new Error('verifyCatalogSignature is not implemented yet — see TODO(T-020)');
}
