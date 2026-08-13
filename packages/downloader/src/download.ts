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
  ProbeFailedError,
  type RemoteFileInfo,
  backoffMs,
  describeProbeAttemptsEn,
  describeProbeAttemptsZh,
  isRetriableHttpCode,
  openRangeStream,
  probeRemoteFileWithRetry,
  sleep,
} from './http.js';
import {
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
  phase: 'resolving' | 'downloading' | 'verifying' | 'unpacking';
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
  /**
   * 中文文案。**给了就优先于 `ERROR_MESSAGES_ZH` 的码表。**
   *
   * 为什么需要它：码表是「一个码一句固定的话」，于是
   * `PROVIDER_UNREACHABLE` 永远只会说「下载源无法访问」——
   * `[用户真机 2026-08-08]` 用户看到的就是这句 + 一个 `(1/3)`，
   * **既不知道是哪台主机、也不知道失败在哪一步、更不知道下一步能做什么**。
   * 码表本身没错（它保证任何码都有中文），但它**盖掉了现场**。
   * 所以现场信息由抛出方直接给，码表退化成兜底。
   */
  readonly messageZh?: string;

  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly provider?: string,
    messageZh?: string,
  ) {
    super(message);
    this.name = 'DownloadError';
    if (messageZh !== undefined) this.messageZh = messageZh;
  }
}

/** 只取主机名给用户看 —— 完整 URL 又长又带签名参数，帮不上忙还吓人。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 「配代理」这句提示。
 *
 * `[本机实测 2026-08-09]` 起本地 CONNECT 代理、经产品自己的
 * `PATCH /api/settings/proxy` 打开，再走正常安装通道下载：
 * 代理**确实收到** `CONNECT raw.githubusercontent.com:443`，任务 `succeeded`；
 * 而对照组（不配代理）代理命中 0 次。
 * 也就是说这句话**有实测背书**，不是安慰话 —— 组件与模型的下载真的走用户配的代理。
 */
export const PROXY_HINT_ZH = '如果你在网络受限的地区，可在「设置 → 代理」里填一个代理再试。';
export const PROXY_HINT_EN =
  'If you are on a restricted network, set a proxy under Settings → Proxy and retry.';

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

      /*
       * ★ T-63：校验阶段必须**报进度**，而这里曾经传的是 `undefined`。
       *
       * 同一个 `verifyFile`，三个调用点，只有"安装"这一条不报：
       *   · `models.ts:681`（校验已装模型）传了回调 ✔
       *   · `models.ts:817`（导入本地模型，走 `sha256File`）传了回调 ✔
       *   · 这里（安装）                                   ✘ ← 漏的就是这一个参数
       *
       * 后果是量出来的，不是推的：1.66 GB 模型安装过程里有一段 **1795 ms 的黑窗**
       * （耗时 > 1s 且 0 条事件），正落在 `verifying → installing` 之间。
       * 校验就是**把整个文件读一遍算 sha256**，它天然有进度可报 ——
       * 不报的那 1.8 秒里，界面上什么都不动，而进度条还停在下载结束时的 100%，
       * 于是"正在校验"看起来和"卡住了"一模一样。
       *
       * 起点报 0 而不是 `res.sizeBytes`：校验刚开始时**确实一个字节都还没算**。
       * 报成满格再原地不动 1.8 秒，正是让人以为卡死的那种画法。
       *
       * 不在这里另做节流：`job.progress` 在 SSE 层已经按 topic 合并 250ms
       * （`sse.ts:126`），而另外两个调用点也都是直接透传 —— 同一个用途不再分叉。
       */
      const onVerifyProgress = (hashed: number): void => {
        opts.onProgress?.({
          completedBytes: hashed,
          totalBytes: res.sizeBytes,
          speedBps: 0,
          etaSeconds: null,
          phase: 'verifying',
          provider: source.provider,
        });
      };
      onVerifyProgress(0);

      const verdict = await verifyFile(
        partialPath,
        digest,
        res.sizeBytes,
        onVerifyProgress,
        opts.signal,
      );
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

      // Only conditions that make EVERY source pointless abort the loop. A per-source
      // failure — 401/404/gated/rate-limited/bad bytes — must fall through to the next
      // mirror, otherwise multi-source failover does nothing the moment the first
      // source returns something non-retryable. (Caught by the live harness: a missing
      // HF repo answers 401, which previously killed the whole job.)
      if (isFatalForAllSources(lastError.code)) throw lastError;
    }
  }

  // Every source was tried. Surface the last cause, but relabel when there were several
  // so the UI can offer "all sources failed" rather than blaming one mirror.
  if (lastError && opts.sources.length > 1) {
    throw new DownloadError(
      `All ${opts.sources.length} source(s) failed after ${attempts} attempt(s); last error from ${lastError.provider ?? 'unknown'}: ${lastError.message}. ${PROXY_HINT_EN}`,
      'INTEGRITY_ALL_SOURCES_FAILED',
      false,
      lastError.provider,
      `${opts.sources.length} 个下载源都失败了（共重试 ${attempts} 次）。` +
        `最后一次来自 ${lastError.provider ?? '未知来源'}：${lastError.messageZh ?? lastError.message}`,
    );
  }
  throw (
    lastError ??
    new DownloadError('All download sources failed', 'INTEGRITY_ALL_SOURCES_FAILED', false)
  );
}

/**
 * Errors where trying another mirror cannot help.
 * Everything else is per-source and must fall through to the next candidate.
 */
function isFatalForAllSources(code: string): boolean {
  return code === 'DISK_FULL' || code === 'CANCELLED' || code === 'PERMISSION_DENIED';
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

  /*
   * ★ 探大小这一步**单独兜住并点名**。
   *
   * 它与真正的下载**不是同一种请求**：`GET` + `Range: bytes=0-0` + `redirect:'manual'`
   * （再自己跟最多 5 跳）。也就是说它**比真正的下载多两个可失败面**。
   * `[本机实测 2026-08-08]` 有一次它抛 `fetch failed`，而同一个 URL 用 curl 与裸 fetch
   * 都能 2.5s 下完 —— 我**没能再现**，所以那次的成因仍是 `[未验证]`。
   *
   * 正因为没定罪，才更要让它在出错时**自报家门**：下次用户再撞到，
   * 消息里会直接写着"卡在探测文件大小"，而不是笼统的"下载源无法访问" ——
   * 那时我们就有证据，不用再猜。
   */
  /*
   * ★★ #108：这一步**必须带退避重试**，而它此前是零重试的。
   *
   * `[CI 实测 2026-08-12]` 那一夜六条定时腿 4 条红，全部是**同一个上游故障窗口**：
   * 19:59–20:00 六个文件一律 `Origin error 503`，而 20:06 同一批文件又全部成功。
   * 探大小这一步一失败就整源判死，于是一次分钟级的抖动 = 用户眼里的"装不上"、
   * CI 眼里的一条红 —— 而**一条会随机变红的门，教给人的是"别信这盏灯"**。
   *
   * ⚠️ 但重试的目的是滤掉抖动，**不是把真的不可达也重试成绿**：
   *   · 404 / 403 这类确定性失败 `isRetriableHttpCode()` 直接判不可重试，一次都不多试；
   *   · 次数（4）与总预算（60s）都是显式上限，用尽仍失败就**照样抛**，
   *     并且把"试了几次、每次隔多久、每次为什么失败"写进用户看得见的消息里。
   */
  let info: RemoteFileInfo;
  try {
    const probed = await probeRemoteFileWithRetry(source.url, {
      signal: opts.signal,
      token: opts.token,
      onRetry: (a, delayMs) => {
        console.warn(
          `[downloader] 探测 ${hostOf(source.url)} 文件大小第 ${String(a.attempt)} 次失败` +
            `（${a.message}），${String(Math.round(delayMs / 100) / 10)}s 后重试`,
        );
      },
    });
    info = probed.info;
    // 抖动被吸收掉时**说出来**：否则日志里"这次很慢"和"这次一切正常"长得一样。
    if (probed.attempts.length > 1) {
      console.warn(
        `[downloader] 探测 ${hostOf(source.url)} 文件大小：第 ${String(probed.attempts.length)} 次才成功` +
          `（前 ${String(probed.attempts.length - 1)} 次：${probed.attempts
            .slice(0, -1)
            .map((a) => a.message)
            .join('；')}）—— 上游抖动已被退避重试吸收。`,
      );
    }
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const de = toDownloadError(e, source.provider);
    const trailEn = e instanceof ProbeFailedError ? ` ${describeProbeAttemptsEn(e)}` : '';
    const trailZh = e instanceof ProbeFailedError ? `${describeProbeAttemptsZh(e)}` : '';
    throw new DownloadError(
      `Failed while probing file size at ${hostOf(source.url)} (before any bytes were transferred): ${de.message}.${trailEn} ${PROXY_HINT_EN}`,
      de.code,
      de.retryable,
      source.provider,
      `连接 ${hostOf(source.url)} 失败：卡在**探测文件大小**这一步，还没开始传字节。${trailZh}${PROXY_HINT_ZH}`,
    );
  }
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
    /*
     * ★★ 定时器里的 promise **必须有 catch**，否则一次写盘失败会把整个 daemon 打死。
     *
     * 原本是 `void persist()` —— 一个 floating promise。它一旦 reject 就是
     * **unhandled rejection**，而 Node 的默认行为是 `--unhandled-rejections=throw`：
     * **进程直接退出，exit code 1**。
     * `[本机实测 2026-08-08]` 照这个形状写个最小复现，进程当场 exit=1。
     * `[CI 实测 run 31261593715, win32-x64]` 用户点一次下载，daemon 整个没了 ——
     * **daemon 一死，页面上每个请求同时失败，表现就是"点按钮完全没反应"。**
     *
     * 代价上限必须是「这次下载失败并告诉用户」，而不是「所有页面一起变砖」。
     * 而周期性写边车**连"这次下载失败"都不该触发**：它只是断点续传的记账，
     * 写丢一次最多下次多下一小段。真正要紧的那次写在下面
     * （`finally` 里的 `await persist()` 与函数末尾的 `await writeSidecar`），
     * 那两处是 **await 的**，失败会正常冒泡成这次下载失败 —— 用户看得见。
     *
     * 所以这里：记下来、不静默、不升级成崩溃。
     */
    let lastPersistError: unknown = null;
    const persistTimer = setInterval(() => {
      void persist().catch((e: unknown) => {
        lastPersistError = e;
      });
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
      /*
       * ⚠️ `clearInterval` **不会取消已经开始执行的那一次** ——
       *   那正是 tmp 名字必须唯一的原因（见 sidecar.ts 里那段）。
       */
      await persist();
      if (lastPersistError !== null) {
        // 不改变红绿（周期性记账失败不该让一次成功的传输变成失败），但绝不静默。
        console.warn(
          `[downloader] 周期性写断点续传边车失败过（已忽略，不影响本次传输）：${
            lastPersistError instanceof Error ? lastPersistError.message : String(lastPersistError)
          }`,
        );
      }
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
    // 这张表**只有 http.ts 那一份**（#108 合并）：这里原本另抄了同样三个码，
    // 而"探测该不该重试"与"这个错该不该重试"必须是同一条判据 —— 分头维护会分头改。
    return new DownloadError(e.message, e.code, isRetriableHttpCode(e.code), provider);
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/ENOSPC/.test(msg)) return new DownloadError('Disk full', 'DISK_FULL', false, provider);
  if (/EACCES|EPERM/.test(msg)) {
    return new DownloadError('Permission denied', 'PERMISSION_DENIED', false, provider);
  }
  if (/abort/i.test(msg)) return new DownloadError('Cancelled', 'CANCELLED', false, provider);
  return new DownloadError(msg, 'CONNECTION_RESET', true, provider);
}
