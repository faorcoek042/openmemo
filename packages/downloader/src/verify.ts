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
import { open } from 'node:fs/promises';

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

// =========================================================================================
// 格式判定 —— sha256 回答"是不是我们要的那份字节"，这一段回答"这份字节谁能加载"
// =========================================================================================

/**
 * whisper.cpp / ggml 权重的文件魔数。
 *
 * 来源是上游头文件一行，不是我们推断的：
 * `vendor/whisper.cpp/ggml/include/ggml.h:216` → `#define GGML_FILE_MAGIC 0x67676d6c`
 * （小端落盘就是 ASCII `"ggml"`）。
 */
export const GGML_FILE_MAGIC = 0x67676d6c;

/**
 * 这个文件是不是 ggml 格式的权重？
 *
 * ## 为什么判据是"读头四字节"而不是"看文件名 / 看清单里的 format 字段"
 *
 * 因为**后果**发生在这四个字节上：`whisper_vad_init_with_params`
 * （`vendor/whisper.cpp/src/whisper.cpp:4779-4785`）做的第一件事就是
 *
 * ```c
 * read_safe(loader, magic);
 * if (magic != GGML_FILE_MAGIC) { WHISPER_LOG_ERROR("invalid model data (bad magic)"); return nullptr; }
 * ```
 *
 * 名字对、清单字段对、sha256 对，只要这四个字节不对，whisper 一样 `nullptr`。
 * 反过来：老安装记录里**没有** `engines` 字段（那是后加的），
 * 按字段过滤会把一份完全能用的权重误判成"不能用"。
 * 所以按内容判 —— 它同时覆盖新记录、老记录、用户手工拷进来的文件。
 *
 * （HANDOFF ⑤A 规矩 7：断言要钉后果，不要钉形式。）
 *
 * 不存在 / 读不动 / 是目录 / 不足四字节 → `false`，绝不抛。
 * 注意**必须**用 `read()` 而不是 `access()`：`access(R_OK)` 对目录也返回成功，
 * 而 `std::ifstream` 打开目录在 glibc 上同样"成功"、第一次读才失败 ——
 * 那正是 `model.vad` 这条自检以前会给出假绿灯的形状之一。
 */
export async function isGgmlModelFile(path: string | null | undefined): Promise<boolean> {
  if (path === null || path === undefined || path.length === 0) return false;
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return buf.readUInt32LE(0) === GGML_FILE_MAGIC;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
