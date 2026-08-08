/**
 * Resume state ("sidecar") persistence.
 *
 * Modelled on Ollama's server/download.go, which keeps a sparse `<blob>-partial` data
 * file plus per-part JSON sidecars recording each part's completed offset. On restart it
 * globs the sidecars and skips parts already finished, so only the missing byte ranges
 * are re-requested.
 *
 * Two deliberate departures from Ollama:
 *   1. ONE sidecar for the whole file instead of one per part. We cap at 8 parts (see
 *      DEFAULT_MAX_PARTS) so a single small JSON is simpler and atomically writable;
 *      16 separate files buys nothing at this scale.
 *   2. We record `sha256` (the expected digest) in the sidecar. Ollama has no checksum
 *      step at all, which is the gap we are explicitly closing.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface SidecarPart {
  index: number;
  start: number;
  /** Inclusive end offset. */
  end: number;
  completed: number;
}

export interface Sidecar {
  schema: 1;
  /** Expected content digest, "sha256:<hex>". The trust anchor for this download. */
  digest: string;
  total: number;
  createdAt: string;
  updatedAt: string;
  /** Provider that produced the current byte ranges. */
  provider: string | null;
  /**
   * Response validators from the origin. Used to detect the file changing underneath a
   * resumed download. Cleared when switching providers, since ETags are origin-specific
   * while the content digest is not.
   */
  validators: { etag: string | null; lastModified: string | null };
  parts: SidecarPart[];
}

export const DEFAULT_PART_SIZE = 128 * 1024 * 1024;
/**
 * Max concurrent parts per file.
 *
 * Ollama uses 16. We use 8 max / 4 default because this is a desktop app on consumer
 * links: 16 parallel streams over a home router or phone hotspot mostly compete with
 * each other and trip CDN rate limits, while making every ETA unstable.
 */
export const DEFAULT_MAX_PARTS = 8;

export function planParts(
  total: number,
  partSize = DEFAULT_PART_SIZE,
  maxParts = DEFAULT_MAX_PARTS,
): SidecarPart[] {
  if (total <= 0) return [];
  let count = Math.ceil(total / partSize);
  if (count > maxParts) count = maxParts;
  if (count < 1) count = 1;
  const size = Math.ceil(total / count);
  const parts: SidecarPart[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * size;
    if (start >= total) break;
    const end = Math.min(start + size, total) - 1;
    parts.push({ index: parts.length, start, end, completed: 0 });
  }
  return parts;
}

export function sidecarPath(partialPath: string): string {
  return `${partialPath}.json`;
}

export function completedBytes(s: Sidecar): number {
  return s.parts.reduce((a, p) => a + p.completed, 0);
}

export function isComplete(s: Sidecar): boolean {
  return s.parts.every((p) => p.completed === p.end - p.start + 1);
}

export async function readSidecar(partialPath: string): Promise<Sidecar | null> {
  try {
    const raw = await fs.readFile(sidecarPath(partialPath), 'utf8');
    const parsed = JSON.parse(raw) as Sidecar;
    if (parsed.schema !== 1 || !Array.isArray(parsed.parts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomic write: temp file then rename. A torn sidecar would make us resume from a wrong
 * offset and silently produce a corrupt file — the digest check would catch it, but only
 * after re-downloading gigabytes.
 */
export async function writeSidecar(partialPath: string, s: Sidecar): Promise<void> {
  const target = sidecarPath(partialPath);
  const tmp = `${target}.tmp`;
  s.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export async function removeSidecar(partialPath: string): Promise<void> {
  await fs.rm(sidecarPath(partialPath), { force: true });
}

export function newSidecar(
  digest: string,
  total: number,
  provider: string | null,
  partSize = DEFAULT_PART_SIZE,
  maxParts = DEFAULT_MAX_PARTS,
): Sidecar {
  const now = new Date().toISOString();
  return {
    schema: 1,
    digest,
    total,
    createdAt: now,
    updatedAt: now,
    provider,
    validators: { etag: null, lastModified: null },
    parts: planParts(total, partSize, maxParts),
  };
}

/**
 * Decide whether an existing sidecar can be resumed against a (possibly different) source.
 *
 * Rules:
 *  - digest mismatch  → discard. We are downloading a different artifact.
 *  - total mismatch   → discard. The remote file changed; offsets are meaningless.
 *  - provider changed → KEEP byte progress, clear validators. This is what makes mirror
 *    switching cheap: the content digest is source-independent, so bytes already fetched
 *    from HF are equally valid when we fail over to ModelScope. Verified in R-04: the
 *    same ggml file on HF and ModelScope is byte-identical.
 */
export function canResume(
  s: Sidecar,
  digest: string,
  total: number,
  provider: string | null,
): { resumable: boolean; reason: string; clearValidators: boolean } {
  if (s.digest !== digest)
    return { resumable: false, reason: 'digest changed', clearValidators: false };
  if (s.total !== total)
    return { resumable: false, reason: 'size changed', clearValidators: false };
  if (s.provider !== provider) {
    return { resumable: true, reason: 'provider switched', clearValidators: true };
  }
  return { resumable: true, reason: 'same source', clearValidators: false };
}
