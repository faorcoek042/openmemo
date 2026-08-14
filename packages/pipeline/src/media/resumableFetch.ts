/**
 * Resumable media download.
 *
 * WHY THIS IS A FUNCTIONAL GAP, NOT A PERFORMANCE ONE: a podcast episode is routinely
 * 50–500 MB. Without resume, a dropped connection at 90% means starting over, and on a
 * flaky link the import may never complete at all. "Eventually succeeds" versus "never
 * succeeds" is a functional difference.
 *
 * REUSE, NOT REWRITE (ADR instruction): the transfer primitives come from
 * `@openmemo/downloader` — `probeRemoteFileWithRetry`, `openRangeStream`, `backoffMs`, `sleep`.
 * Those are the pieces `model-mgmt` already exercised on a real 77 MB download.
 * (The probe used to be the un-retried `probeRemoteFile`; see the call site for why
 * that was a functional gap and why this leg uses a *shorter* policy than installs.)
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

import {
  MEDIA_PROBE_RETRY_POLICY,
  backoffMs,
  openRangeStream,
  probeRemoteFileWithRetry,
  sleep,
} from '@openmemo/downloader';

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

  /*
   * ★★ #111 ②：这一行以前是 `probeRemoteFile()` —— **零重试**。
   *
   * 它坐在下面那个 `while (attempts < maxAttempts)` 重试循环**外面**，也没有任何
   * try/catch 包着，所以上游抖一下（503、socket hang up）就**原样抛出整个函数**，
   * 一次尝试都不记。下面那套 `maxAttempts ?? 5` + `backoffMs` 只保护取字节那一段，
   * 从来没保护过探测这一下。用户看到的是"从链接导入"直接失败。
   *
   * `probeRemoteFileWithRetry()` 是 #108 / PR #56 为组件下载加的，
   * 这条腿当时没跟上（`http.ts` 里那段注释还点名说 `resumableFetch.ts` 留在旧层）。
   *
   * ⚠️ 用 `MEDIA_PROBE_RETRY_POLICY` 而**不是**出厂的 `PROBE_RETRY_POLICY`：
   *    探测发生在任何 `onProgress` 之前，重试全程界面是**冻住的**
   *    （实测停在「解析中 · 10%」，不是 0% —— 详见那个常量的注释），
   *    而组件安装是用户可以走开的后台任务。
   *    ★ `budgetMs` 压到 4 秒，是为了让**最坏值 ≈ 24 秒**、
   *      而上游挂起这种最常见的坏**恰好还是今天的 20 秒**。
   *      理由、算式和"牺牲了什么"全写在那个常量上，改数字前请先读。
   *
   * ⚠️ **确定性失败一次都不重试**：404 / 403 / 其它 4xx 的分类
   *    （`isRetriableHttpCode()` 是三码白名单）决定了它们直接抛，
   *    不会被"重试成绿"，也不会白等两轮退避。
   *
   * `ProbeFailedError` 仍然是 `HttpError`（码/状态逐字沿用最后一次失败），
   * 所以 `directHttp.ts` 那侧的错误处理一个字都不用改。
   */
  const { info } = await probeRemoteFileWithRetry(url, {
    signal,
    timeoutMs: 20_000,
    policy: MEDIA_PROBE_RETRY_POLICY,
    /*
     * 界面这段时间是冻住的，而**重试对用户完全不可见**（那条路上没有任何
     * 现成信号能承载"正在重试"，走查见常量注释）。所以日志是唯一的痕迹 ——
     * 排查"用户说导入卡了半分钟"时，这几行是唯一能还原现场的东西。
     * 组件下载那条路（PR #56）也只 `console.warn`，保持一致。
     */
    onRetry: (attempt, delayMs) => {
      console.warn(
        `[media] 探测 ${url} 第 ${String(attempt.attempt)} 次失败（${attempt.code} ${String(attempt.status)}：${attempt.message}），` +
          `${String(delayMs)}ms 后重试`,
      );
    },
  });

  if (info.sizeBytes !== null && info.sizeBytes > maxBytes) {
    throw new Error(
      `file is ${String(info.sizeBytes)} bytes, over the ${String(maxBytes)} byte limit`,
    );
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
  let observedContentType: string | null = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    signal.throwIfAborted();

    const startAt = await sizeOf(partialPath);
    if (total !== null && startAt >= total && total > 0) break; // already complete

    try {
      const end = total !== null ? total - 1 : startAt + maxBytes;
      const { body, headers } = await openRangeStream(url, startAt, end, { signal });
      // Captured from the real response rather than guessed from the extension; the
      // caller still re-validates with ffprobe (D-01 §8.5) before trusting it.
      observedContentType = headers.get('content-type') ?? observedContentType;

      let written = startAt;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          written += chunk.byteLength;
          if (written > maxBytes) {
            throw new Error(`download exceeded the ${String(maxBytes)} byte limit`);
          }
          opts.onProgress?.(
            total !== null && total > 0 ? Math.min(1, written / total) : 0,
            written,
            total,
          );
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
        contentType: observedContentType,
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
