/**
 * Chunked, resumable, verified single-file downloader.
 *
 * Design lineage (R-04 §1.1, from reading Ollama's server/download.go):
 *   - split into byte-range parts, fetch them concurrently
 *   - persist per-part completion so an interrupted transfer resumes
 *   - stall watchdog per part, exponential backoff with jitter on retry
 *   - write into a `.partial` file, atomically rename on success
 *
 * What we add that Ollama does not do:
 *   - mandatory SHA-256 verification before the rename (ADR-004 decision 5)
 *   - mirror failover that PRESERVES byte progress across sources, which is sound
 *     because the digest is source-independent (verified: the same ggml file on HF and
 *     ModelScope is byte-identical)
 *   - graceful degradation to a single stream when the origin does not honour Range
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  HttpError,
  MAX_RETRIES,
  backoffMs,
  openRangeStream,
  probeRemoteFile,
  sleep,
} from './http.js';
import {
  type Sidecar,
  canResume,
  completedBytes,
  isComplete,
  newSidecar,
  readSidecar,
  removeSidecar,
  writeSidecar,
} from './sidecar.js';
import { blobFileName, normalizeDigest, verifyFile } from './verify.js';

export interface DownloadSource {
  provider: string;
  url: string;
  official: boolean;
}

export interface DownloadProgress {
  completedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  phase: 'resolving' | 'downloading' | 'verifying';
  provider: string;
}

export interface DownloadOptions {
  /** Expected content digest — required. Without it we cannot honour "verified == installed". */
  sha256: string;
  /** Expected size in bytes; when known it is checked against the origin before transferring. */
  sizeBytes?: number;
  sources: DownloadSource[];
  /** Directory for blobs and `.partial` files. */
  blobDir: string;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  maxParts?: number;
  partSize?: number;
  /** Optional bearer token, for gated HF repos. */
  token?: string;
  /** Per-part inactivity timeout. Ollama uses 30 s; a hung socket must not wedge a job. */
  stallTimeoutMs?: number;
}

export interface DownloadResult {
  /** Absolute path to the verified blob. */
  blobPath: string;
  sha256: string;
  sizeBytes: number;
  provider: string;
  /** True when the blob already existed and no bytes were transferred. */
  cached: boolean;
  bytesTransferred: number;
  attempts: number;
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly provider?: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

const DEFAULT_STALL_TIMEOUT_MS = 30_000;

/**
 * Download one file, verify it, and place it in the content-addressed blob store.
 *
 * Dedup is by SHA-256 only. Never by size or name: ggml-tiny.bin (77,691,713 B) and
 * ggml-tiny.en.bin (77,704,715 B) differ by 13,002 bytes, close enough that a size
 * heuristic conflates them — which is exactly the mistake ADR-004 decision 4 codifies
 * against.
 */
export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const digest = normalizeDigest(opts.sha256);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new DownloadError(`Invalid sha256: ${opts.sha256}`, 'INTERNAL', false);
  }
  if (opts.sources.length === 0) {
    throw new DownloadError('No download sources configured', 'PROVIDER_UNREACHABLE', false);
  }

  await fs.mkdir(opts.blobDir, { recursive: true });
  const blobPath = path.join(opts.blobDir, blobFileName(digest));
  const partialPath = `${blobPath}.partial`;

  // Cache hit: the blob is already present. Trust it — it can only have been created by
  // a verified download, and re-hashing multi-GB files on every request is unacceptable.
  // `POST /api/models/verify` exists for when the user wants an explicit re-check.
  try {
    const st = await fs.stat(blobPath);
    if (st.isFile() && st.size > 0) {
      return {
        blobPath,
        sha256: digest,
        sizeBytes: st.size,
        provider: 'cache',
        cached: true,
        bytesTransferred: 0,
        attempts: 0,
      };
    }
  } catch {
    /* not present, continue */
  }

  let lastError: DownloadError | null = null;
  let attempts = 0;
  let bytesTransferred = 0;

  // Try each source in order. A checksum failure demotes the source and moves on:
  // the digest is the trust anchor, so a mirror serving wrong bytes is simply skipped.
  for (const source of opts.sources) {
    attempts++;
    try {
      const res = await downloadFromSource(source, digest, partialPath, opts);
      bytesTransferred += res.bytesTransferred;

      opts.onProgress?.({
        completedBytes: res.sizeBytes,
        totalBytes: res.sizeBytes,
        speedBps: 0,
        etaSeconds: null,
        phase: 'verifying',
        provider: source.provider,
      });

      const verdict = await verifyFile(partialPath, digest, res.sizeBytes, undefined, opts.signal);
      if (!verdict.ok) {
        // Bad bytes: discard everything from this source and try the next one.
        await fs.rm(partialPath, { force: true });
        await removeSidecar(partialPath);
        lastError = new DownloadError(
          `Checksum mismatch from ${source.provider}: expected ${verdict.expected.slice(0, 12)}…, got ${verdict.actual.slice(0, 12)}…`,
          'CHECKSUM_MISMATCH',
          true,
          source.provider,
        );
        continue;
      }

      // Verified — only now does it become a real blob.
      await fs.rename(partialPath, blobPath);
      await removeSidecar(partialPath);

      return {
        blobPath,
        sha256: digest,
        sizeBytes: res.sizeBytes,
        provider: source.provider,
        cached: false,
        bytesTransferred,
        attempts,
      };
    } catch (e) {
      if (opts.signal?.aborted) {
        // Cancellation keeps the .partial so the user can resume later.
        throw new DownloadError('Download cancelled', 'CANCELLED', false, source.provider);
      }
      lastError = toDownloadError(e, source.provider);
      if (!lastError.retryable) throw lastError;
    }
  }

  throw (
    lastError ??
    new DownloadError('All download sources failed', 'INTEGRITY_ALL_SOURCES_FAILED', false)
  );
}

interface SourceResult {
  sizeBytes: number;
  bytesTransferred: number;
}

async function downloadFromSource(
  source: DownloadSource,
  digest: string,
  partialPath: string,
  opts: DownloadOptions,
): Promise<SourceResult> {
  opts.onProgress?.({
    completedBytes: 0,
    totalBytes: opts.sizeBytes ?? 0,
    speedBps: 0,
    etaSeconds: null,
    phase: 'resolving',
    provider: source.provider,
  });

  const info = await probeRemoteFile(source.url, { signal: opts.signal, token: opts.token });
  const total = info.sizeBytes ?? opts.sizeBytes ?? 0;
  if (total <= 0) {
    throw new DownloadError(
      `Could not determine size from ${source.provider}`,
      'PROVIDER_UNREACHABLE',
      true,
      source.provider,
    );
  }
  if (opts.sizeBytes != null && total !== opts.sizeBytes) {
    // Size disagreement means the manifest and the origin describe different files.
    // Transferring gigabytes only to fail the hash would be wasteful.
    throw new DownloadError(
      `Size mismatch from ${source.provider}: manifest says ${opts.sizeBytes}, origin says ${total}`,
      'SIZE_MISMATCH',
      true,
      source.provider,
    );
  }

  // If the origin already advertises the content digest (HF and ModelScope both expose
  // it via x-linked-etag), we can reject a wrong file before transferring a single byte.
  if (info.sha256 && info.sha256 !== digest) {
    throw new DownloadError(
      `${source.provider} advertises a different digest (${info.sha256.slice(0, 12)}…)`,
      'CHECKSUM_MISMATCH',
      true,
      source.provider,
    );
  }

  let sidecar = await readSidecar(partialPath);
  if (sidecar) {
    const check = canResume(sidecar, digest, total, source.provider);
    if (!check.resumable) {
      await fs.rm(partialPath, { force: true });
      await removeSidecar(partialPath);
      sidecar = null;
    } else if (check.clearValidators) {
      // Mirror switch: keep the bytes, drop origin-specific validators.
      sidecar.validators = { etag: null, lastModified: null };
      sidecar.provider = source.provider;
    }
  }

  if (!sidecar) {
    sidecar = newSidecar(digest, total, source.provider, opts.partSize, opts.maxParts);
    sidecar.validators = { etag: info.etag, lastModified: info.lastModified };
  }

  // Origin will not do Range: fall back to a single stream from offset 0.
  if (!info.acceptRanges && sidecar.parts.length > 1) {
    sidecar.parts = [{ index: 0, start: 0, end: total - 1, completed: 0 }];
  }

  await ensurePartialFile(partialPath, total);
  await writeSidecar(partialPath, sidecar);

  const startBytes = completedBytes(sidecar);
  let transferred = 0;
  const startedAt = Date.now();
  let lastEmit = 0;

  const emit = (phase: DownloadProgress['phase'] = 'downloading') => {
    const now = Date.now();
    // Throttle to ~4 Hz; at 8 MB/s an unthrottled callback floods the SSE stream.
    if (phase === 'downloading' && now - lastEmit < 250) return;
    lastEmit = now;
    const done = completedBytes(sidecar!);
    const elapsed = (now - startedAt) / 1000;
    const speed = elapsed > 0 ? transferred / elapsed : 0;
    const remaining = total - done;
    opts.onProgress?.({
      completedBytes: done,
      totalBytes: total,
      speedBps: Math.round(speed),
      etaSeconds: speed > 0 ? Math.round(remaining / speed) : null,
      phase,
      provider: source.provider,
    });
  };
  emit();

  const fh = await fs.open(partialPath, 'r+');
  try {
    const pending = sidecar.parts.filter((p) => p.completed < p.end - p.start + 1);
    const limit = Math.max(1, Math.min(sidecar.parts.length, opts.maxParts ?? 4));

    let cursor = 0;
    let sidecarDirty = false;
    const persist = async () => {
      if (sidecarDirty) {
        sidecarDirty = false;
        await writeSidecar(partialPath, sidecar!);
      }
    };
    const persistTimer = setInterval(() => {
      void persist();
    }, 2000);

    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= pending.length) return;
        const part = pending[idx];

        for (let attempt = 0; ; attempt++) {
          try {
            // Byte accounting happens per chunk, not per part, so the reported speed and
            // ETA stay live during a multi-hundred-MB part instead of reading zero.
            await downloadPart(fh, source, part, opts, (chunkBytes) => {
              transferred += chunkBytes;
              sidecarDirty = true;
              emit();
            });
            sidecarDirty = true;
            break;
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            const de = toDownloadError(e, source.provider);
            if (!de.retryable || attempt >= MAX_RETRIES) throw de;
            await sleep(backoffMs(attempt), opts.signal);
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: limit }, () => worker()));
    } finally {
      clearInterval(persistTimer);
      await persist();
    }

    if (!isComplete(sidecar)) {
      throw new DownloadError(
        `Transfer incomplete: ${completedBytes(sidecar)}/${total} bytes`,
        'CONNECTION_RESET',
        true,
        source.provider,
      );
    }
  } finally {
    await fh.close();
  }

  await writeSidecar(partialPath, sidecar);
  emit('downloading');

  return { sizeBytes: total, bytesTransferred: completedBytes(sidecar) - startBytes };
}

/** Fetch one part's remaining bytes, writing at the correct absolute offset. */
async function downloadPart(
  fh: fs.FileHandle,
  source: DownloadSource,
  part: { index: number; start: number; end: number; completed: number },
  opts: DownloadOptions,
  onChunk: (chunkBytes: number) => void,
): Promise<number> {
  const partTotal = part.end - part.start + 1;
  if (part.completed >= partTotal) return 0;

  const from = part.start + part.completed;
  const to = part.end;

  // Per-part stall watchdog. Ollama uses 30 s; without it a half-open socket hangs the
  // whole job forever.
  const ac = new AbortController();
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  let stallTimer = setTimeout(() => ac.abort(), stallMs);
  const bump = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ac.abort(), stallMs);
  };
  const onOuterAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  let written = 0;
  try {
    const { body, status } = await openRangeStream(source.url, from, to, {
      signal: ac.signal,
      token: opts.token,
    });

    // A 200 where we asked for a mid-file range means Range was ignored. Writing that
    // stream at `from` would silently corrupt the file.
    if (status === 200 && from > 0) {
      throw new DownloadError(
        `${source.provider} ignored Range and returned the whole file`,
        'RANGE_NOT_SUPPORTED',
        false,
        source.provider,
      );
    }

    const reader = body.getReader();
    let offset = from;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      bump();
      await fh.write(value, 0, value.length, offset);
      offset += value.length;
      written += value.length;
      part.completed += value.length;
      if (part.completed > partTotal) part.completed = partTotal;
      onChunk(value.length);
    }
  } catch (e) {
    if (ac.signal.aborted && !opts.signal?.aborted) {
      throw new DownloadError(
        `Part ${part.index} stalled for ${stallMs}ms`,
        'NETWORK_TIMEOUT',
        true,
        source.provider,
      );
    }
    throw e;
  } finally {
    clearTimeout(stallTimer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
  return written;
}

/**
 * Create the `.partial` file as a sparse file of the right length.
 *
 * Sparse matters for UX as much as for disk: preallocating 3 GB of real blocks makes the
 * OS report the download as finished the instant it starts.
 */
async function ensurePartialFile(partialPath: string, total: number): Promise<void> {
  await fs.mkdir(path.dirname(partialPath), { recursive: true });
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(partialPath, 'r+');
    const st = await handle.stat();
    if (st.size !== total) await handle.truncate(total);
  } catch {
    handle = await fs.open(partialPath, 'w');
    await handle.truncate(total);
  } finally {
    await handle?.close();
  }
}

function toDownloadError(e: unknown, provider?: string): DownloadError {
  if (e instanceof DownloadError) return e;
  if (e instanceof HttpError) {
    const retryable =
      e.code === 'NETWORK_TIMEOUT' ||
      e.code === 'RATE_LIMITED' ||
      e.code === 'PROVIDER_UNREACHABLE';
    return new DownloadError(e.message, e.code, retryable, provider);
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/ENOSPC/.test(msg)) return new DownloadError('Disk full', 'DISK_FULL', false, provider);
  if (/EACCES|EPERM/.test(msg)) {
    return new DownloadError('Permission denied', 'PERMISSION_DENIED', false, provider);
  }
  if (/abort/i.test(msg)) return new DownloadError('Cancelled', 'CANCELLED', false, provider);
  return new DownloadError(msg, 'CONNECTION_RESET', true, provider);
}
