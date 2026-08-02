/**
 * Resumable media download.
 *
 * WHY THIS IS A FUNCTIONAL GAP, NOT A PERFORMANCE ONE: a podcast episode is routinely
 * 50–500 MB. Without resume, a dropped connection at 90% means starting over, and on a
 * flaky link the import may never complete at all. "Eventually succeeds" versus "never
 * succeeds" is a functional difference.
 *
 * REUSE, NOT REWRITE (ADR instruction): the transfer primitives come from
 * `@openmemo/downloader` — `probeRemoteFile`, `openRangeStream`, `backoffMs`, `sleep`.
 * Those are the pieces `model-mgmt` already exercised on a real 77 MB download.
 *
 * What is NOT reused is `downloadFile()`, and the reason matters: it *requires* a known
 * SHA-256 up front to honour "verified == installed". That is exactly right for catalog
 * artifacts, and impossible for media — an arbitrary podcast URL has no digest we could
 * check against. Forcing one would mean either inventing a digest (dishonest) or
 * disabling verification inside a function whose whole contract is verification (worse).
 * So we reuse the transport and keep the integrity model appropriate to each case:
 *   catalog artifacts -> digest-verified via downloadFile
 *   media             -> size-checked + ffprobe-validated (see directHttp.ts)
 */

import { createWriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

import { backoffMs, openRangeStream, probeRemoteFile, sleep } from '@openmemo/downloader';

export interface ResumableFetchOptions {
  url: string;
  /** Final path. Bytes land in `${destPath}.partial` until the transfer completes. */
  destPath: string;
  maxBytes: number;
  signal: AbortSignal;
  onProgress?: (fraction: number, bytes: number, total: number | null) => void;
  /** Attempts before giving up. */
  maxAttempts?: number;
  /** Abort a stalled read. */
  stallTimeoutMs?: number;
}

export interface ResumableFetchResult {
  path: string;
  sizeBytes: number;
  contentType: string | null;
  /** Attempts used; > 1 means a resume actually happened. */
  attempts: number;
  /** Bytes already on disk when we started — non-zero proves resume worked. */
  resumedFromBytes: number;
  /** False when the origin refused Range and we had to restart from zero. */
  serverSupportsRanges: boolean;
}

/**
 * Download with resume.
 *
 * The `.partial` file is the resume state — no sidecar metadata, because the file length
 * IS the offset. That keeps the two from disagreeing after a crash, which is the usual
 * failure mode of a separate progress file.
 */
export async function resumableFetch(opts: ResumableFetchOptions): Promise<ResumableFetchResult> {
  const { url, destPath, maxBytes, signal } = opts;
  const maxAttempts = opts.maxAttempts ?? 5;
  const partialPath = `${destPath}.partial`;

  const info = await probeRemoteFile(url, { signal, timeoutMs: 20_000 });

  if (info.sizeBytes !== null && info.sizeBytes > maxBytes) {
    throw new Error(`file is ${String(info.sizeBytes)} bytes, over the ${String(maxBytes)} byte limit`);
  }

  const total = info.sizeBytes;
  let resumedFromBytes = await sizeOf(partialPath);

  // A partial larger than the file means the URL changed under us; start clean rather
  // than splice two different files together.
  if (total !== null && resumedFromBytes > total) {
    await unlink(partialPath).catch(() => undefined);
    resumedFromBytes = 0;
  }

  // Without Range support a partial file is unusable — appending to it would corrupt.
  if (!info.acceptRanges && resumedFromBytes > 0) {
    await unlink(partialPath).catch(() => undefined);
    resumedFromBytes = 0;
  }

  let attempts = 0;
  let lastError: unknown = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    signal.throwIfAborted();

    const startAt = await sizeOf(partialPath);
    if (total !== null && startAt >= total && total > 0) break; // already complete

    try {
      const end = total !== null ? total - 1 : startAt + maxBytes;
      const { body } = await openRangeStream(url, startAt, end, { signal });

      let written = startAt;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          written += chunk.byteLength;
          if (written > maxBytes) {
            throw new Error(`download exceeded the ${String(maxBytes)} byte limit`);
          }
          opts.onProgress?.(total !== null && total > 0 ? Math.min(1, written / total) : 0, written, total);
          controller.enqueue(chunk);
        },
      });

      await streamPipeline(
        Readable.fromWeb(body.pipeThrough(counter) as never),
        // `flags: 'a'` is what makes this a resume: append to what survived.
        createWriteStream(partialPath, { flags: startAt > 0 ? 'a' : 'w' }),
      );

      const got = await sizeOf(partialPath);
      if (total !== null && got < total) {
        // Short read — the connection dropped. Loop; the next attempt resumes from `got`.
        lastError = new Error(`incomplete transfer: ${String(got)}/${String(total)} bytes`);
        await sleep(backoffMs(attempts), signal);
        continue;
      }

      await rename(partialPath, destPath);
      return {
        path: destPath,
        sizeBytes: got,
        contentType: null,
        attempts,
        resumedFromBytes,
        serverSupportsRanges: info.acceptRanges,
      };
    } catch (err) {
      lastError = err;
      if (signal.aborted) throw err;
      // The `.partial` file is deliberately LEFT IN PLACE so the next attempt resumes.
      if (attempts >= maxAttempts) break;
      await sleep(backoffMs(attempts), signal);
    }
  }

  throw new Error(
    `download failed after ${String(attempts)} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function sizeOf(path: string): Promise<number> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}
