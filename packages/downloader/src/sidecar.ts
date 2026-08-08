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
let sidecarTmpSeq = 0;

export async function writeSidecar(partialPath: string, s: Sidecar): Promise<void> {
  const target = sidecarPath(partialPath);
  /*
   * ★★ 临时文件名必须**每次调用都不同**。
   *
   * 这里原本是写死的 `${target}.tmp`，而**同一个 partialPath 会有并发写者**：
   * `download.ts` 里有一个每 2s 一次的 `setInterval(() => void persist())`，
   * 而 `clearInterval` **不会取消已经开始执行的那一次**。于是"定时器那次还在飞"
   * 与"传输结束后那次无条件 `writeSidecar`"可以重叠：
   *
   *     定时器: writeFile(tmp) ──────────────► rename(tmp→target)   ✘ ENOENT
   *     收尾:        writeFile(tmp) ► rename(tmp→target) ✓（tmp 已经被搬走）
   *
   * `[本机实测 2026-08-08]` 同一路径并发调用 600 次：**400 次 ENOENT**。
   * 也就是说这**不是 Windows 特有**的 —— Windows 只是把窗口拉宽了
   * （文件操作更慢：Defender、无 page-cache 语义），所以先在那儿被撞见。
   * `[CI 实测 run 31261593715, win32-x64]` daemon 因此整个退出，exitCode=1。
   *
   * 唯一名字之后，每个写者 rename 的是**自己那一份**，谁也搬不走谁的。
   * 「谁最后落地谁生效」对进度边车是安全的：边车只影响断点续传的起点，
   * 落后一点最多重下一小段，而**撕裂**（这个函数真正要防的东西）由 rename 的
   * 原子性保证，与并发无关。
   */
  const tmp = `${target}.${process.pid}.${sidecarTmpSeq++}.tmp`;
  s.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
    await fs.rename(tmp, target);
  } catch (e) {
    // 失败时别把半个 tmp 留在 blobs 目录里（那会让"目录里有什么"这件事变脏）
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
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
