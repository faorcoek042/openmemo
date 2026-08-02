/**
 * Content verification.
 *
 * "Verified == installed" is the rule (GPT4All's model — the only one of the nine apps
 * surveyed in R-04 that hashes before committing the file into place). Ollama's
 * download.go has no checksum step whatsoever: a pre-existing blob is a cache hit from
 * os.Stat alone. ADR-004 decision 5 requires us not to inherit that.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export interface HashProgress {
  (hashedBytes: number, totalBytes: number): void;
}

/** Stream a file through SHA-256. Constant memory regardless of file size. */
export async function sha256File(
  filePath: string,
  totalBytes?: number,
  onProgress?: HashProgress,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    let hashed = 0;

    const onAbort = () => {
      stream.destroy(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    stream.on('data', (chunk) => {
      hash.update(chunk);
      hashed += chunk.length;
      if (onProgress && totalBytes) onProgress(hashed, totalBytes);
    });
    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(hash.digest('hex'));
    });
  });
}

/** Normalise "sha256:abc…" or "ABC…" to bare lowercase hex. */
export function normalizeDigest(digest: string): string {
  return digest.replace(/^sha256:/i, '').toLowerCase();
}

export function isValidSha256(digest: string): boolean {
  return /^[a-f0-9]{64}$/.test(normalizeDigest(digest));
}

export interface VerifyResult {
  ok: boolean;
  expected: string;
  actual: string;
}

export async function verifyFile(
  filePath: string,
  expectedDigest: string,
  totalBytes?: number,
  onProgress?: HashProgress,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const expected = normalizeDigest(expectedDigest);
  const actual = await sha256File(filePath, totalBytes, onProgress, signal);
  return { ok: actual === expected, expected, actual };
}

/**
 * Blob filename for a digest.
 *
 * Uses `sha256-<hex>`, with a dash. Ollama's own docs are self-contradictory here
 * (modelfile.mdx shows `sha256-`, api.md shows `sha256:`), but `:` is illegal in
 * Windows paths, so the dash form is the only portable choice.
 */
export function blobFileName(digest: string): string {
  return `sha256-${normalizeDigest(digest)}`;
}
