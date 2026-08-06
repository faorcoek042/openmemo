/**
 * F2 主入口：`POST /api/notes/upload` —— 浏览器把文件**拖到网页上**直接上传。
 *
 * 为什么必须单独开一个端点：`/api/notes/import` 只接受**服务端绝对路径**，
 * 而浏览器根本拿不到真实路径（`<input type=file>` / drop 事件给的 `File` 没有路径），
 * 所以在这个端点存在之前，"把文件拖到网页上"这条主路径在浏览器里是走不通的。
 * 落库结果与 import 完全一致：note + media_source(local) + 一个 `transcribe` job。
 *
 * 三条硬约束：
 *
 * 1. **全程流式**。文件字节从 socket 直接进 `createWriteStream`，任何时刻内存里
 *    只有一个 chunk。用户会传 500MB+ 的视频，一个 33 分钟的音频就已经 ~60MB ——
 *    先 `Buffer.concat` 再落盘的写法必然 OOM。
 * 2. **零依赖解析**。只用 `node:*`，自己写边界扫描状态机（`MultipartParser`）。
 *    解析器与 HTTP 处理是分开导出的，可以脱离 server 单测（跨 chunk 的分隔符是经典 bug）。
 * 3. **客户端文件名绝不进路径**。磁盘名 = 新 `ulid()` + 白名单扩展名；原名只作为
 *    展示用元数据入库（D-01 §8.5 路径穿越防护）。
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

import type { SseEvent } from '@openmemo/shared';
import { UPLOAD_MEDIA_EXTENSIONS, makeEvent, topics, ulid } from '@openmemo/shared';

import type { EnqueueParams } from '../jobs/queue.js';
import { sendError, sendJson } from './respond.js';

// ---------------------------------------------------------------------------
// multipart/form-data 解析器（无第三方依赖）
// ---------------------------------------------------------------------------

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SP = 0x20;
const TAB = 0x09;
const HEADER_SEP = Buffer.from('\r\n\r\n');
const EMPTY = Buffer.alloc(0);
/** 分隔符与行尾之间允许的空白字节数上限（RFC 2046 的 transport padding）。 */
const MAX_BOUNDARY_PADDING = 64;

export class MultipartError extends Error {
  constructor(
    message: string,
    readonly code: string = 'BAD_MULTIPART',
  ) {
    super(message);
    this.name = 'MultipartError';
  }
}

export interface PartInfo {
  readonly name: string;
  /** 有 `filename=` 才算文件部件；纯文本字段这里是 undefined。 */
  readonly filename: string | undefined;
  readonly contentType: string | undefined;
}

export interface FilePartInfo extends PartInfo {
  readonly filename: string;
}

export interface MultipartHandlers {
  /** 文本字段（无 filename）。值已按 `maxFieldBytes` 限流，可以安全地留在内存。 */
  readonly onField?: (name: string, value: string, info: PartInfo) => void;
  readonly onFileStart?: (info: FilePartInfo) => void;
  /** chunk 是 `push()` 入参的**视图**，同步用掉或自己拷贝，别长期持有。 */
  readonly onFileChunk?: (chunk: Buffer) => void;
  readonly onFileEnd?: () => void;
  readonly onFinish?: () => void;
}

export interface MultipartLimits {
  /** 单个部件的 header 块上限，默认 16 KiB。 */
  readonly maxHeaderBytes?: number;
  /** 单个文本字段的值上限，默认 64 KiB。 */
  readonly maxFieldBytes?: number;
  /** 部件数量上限，默认 32（防"一百万个空部件"打 CPU）。 */
  readonly maxParts?: number;
}

type ParserState = 'preamble' | 'headers' | 'body' | 'done';

/**
 * 边界扫描状态机。
 *
 * 报文结构（RFC 2046 §5.1）：
 * ```
 * [preamble] CRLF --boundary CRLF <headers> CRLF CRLF <body>
 *            CRLF --boundary CRLF <headers> CRLF CRLF <body>
 *            CRLF --boundary-- [epilogue]
 * ```
 * 关键实现选择：**开局先往缓冲里塞一个 CRLF**。这样"首个分隔符顶在正文开头（前面
 * 没有 CRLF）"和"前面有 preamble"两种情况就能共用同一条 `\r\n--boundary` 搜索路径，
 * 少一个特判就少一类 bug。
 *
 * 跨 chunk 的分隔符（分隔符被 TCP 切成两半）靠"没搜到时保留 needle.length-1 字节尾巴"
 * 处理 —— 部分匹配最长就这么长，留住它就绝不会漏判。
 */
export class MultipartParser {
  readonly #needle: Buffer;
  readonly #handlers: MultipartHandlers;
  readonly #maxHeaderBytes: number;
  readonly #maxFieldBytes: number;
  readonly #maxParts: number;

  #buf: Buffer;
  #state: ParserState = 'preamble';
  #partCount = 0;
  #part: PartInfo | undefined;
  #isFile = false;
  #fieldChunks: Buffer[] = [];
  #fieldBytes = 0;

  constructor(boundary: string, handlers: MultipartHandlers, limits: MultipartLimits = {}) {
    if (!/^[\x20-\x7e]{1,70}$/.test(boundary)) {
      throw new MultipartError(`invalid boundary: ${JSON.stringify(boundary)}`, 'BAD_BOUNDARY');
    }
    // 分隔符只可能是 ASCII，用 latin1 逐字节映射，避免任何编码折算
    this.#needle = Buffer.from(`\r\n--${boundary}`, 'latin1');
    this.#handlers = handlers;
    this.#maxHeaderBytes = limits.maxHeaderBytes ?? 16 * 1024;
    this.#maxFieldBytes = limits.maxFieldBytes ?? 64 * 1024;
    this.#maxParts = limits.maxParts ?? 32;
    this.#buf = Buffer.from('\r\n', 'latin1');
  }

  get finished(): boolean {
    return this.#state === 'done';
  }

  /** 喂一段字节。回调在这里同步触发；回调抛出的异常会原样冒泡给调用方。 */
  push(chunk: Buffer): void {
    if (this.#state === 'done') return; // epilogue 一律丢弃
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    this.#run();
  }

  /** 输入结束。没读到 `--boundary--` 就是截断的报文 —— 必须报错，不能当成功。 */
  end(): void {
    if (this.#state !== 'done') {
      throw new MultipartError('unexpected end of multipart body', 'MULTIPART_TRUNCATED');
    }
  }

  #run(): void {
    for (;;) {
      if (this.#state === 'done') {
        this.#buf = EMPTY;
        return;
      }
      const progressed = this.#state === 'headers' ? this.#stepHeaders() : this.#stepBody();
      if (!progressed) return;
    }
  }

  /** @returns 是否推进了状态（false = 数据不够，等下一个 chunk） */
  #stepHeaders(): boolean {
    // 零个 header 的部件：分隔符后的 CRLF 已消费，紧跟的空行就是 header 块结束
    if (this.#buf.length >= 2 && this.#buf[0] === CR && this.#buf[1] === LF) {
      this.#buf = this.#buf.subarray(2);
      this.#beginPart('');
      return true;
    }
    const end = this.#buf.indexOf(HEADER_SEP);
    if (end === -1) {
      if (this.#buf.length > this.#maxHeaderBytes) {
        throw new MultipartError('part headers too large', 'PART_HEADERS_TOO_LARGE');
      }
      return false;
    }
    if (end > this.#maxHeaderBytes) {
      throw new MultipartError('part headers too large', 'PART_HEADERS_TOO_LARGE');
    }
    // header 里可能有 UTF-8 文件名（浏览器就这么发），按 UTF-8 解
    const raw = this.#buf.subarray(0, end).toString('utf8');
    this.#buf = this.#buf.subarray(end + HEADER_SEP.length);
    this.#beginPart(raw);
    return true;
  }

  #stepBody(): boolean {
    const idx = this.#buf.indexOf(this.#needle);

    if (idx === -1) {
      // 没命中：尾部可能是分隔符的前半截，保留 needle.length-1 字节（可能的最长部分匹配）
      const keep = this.#needle.length - 1;
      if (this.#buf.length > keep) {
        this.#consumeBody(this.#buf.subarray(0, this.#buf.length - keep));
        this.#buf = this.#buf.subarray(this.#buf.length - keep);
      }
      return false;
    }

    if (idx > 0) this.#consumeBody(this.#buf.subarray(0, idx));

    // 分隔符之后还得再看 2 个字节才能区分 `--`（收尾）和 CRLF（下一个部件）
    const after = idx + this.#needle.length;
    if (this.#buf.length < after + 2) {
      this.#buf = this.#buf.subarray(idx); // 前面的正文已经吐出去了，从分隔符处重来
      return false;
    }

    if (this.#buf[after] === DASH && this.#buf[after + 1] === DASH) {
      this.#endPart();
      this.#state = 'done';
      this.#buf = EMPTY;
      this.#handlers.onFinish?.();
      return false;
    }

    // RFC 2046 允许分隔符后跟 transport padding（空格/TAB），之后必须是 CRLF
    let i = after;
    const paddingCap = Math.min(after + MAX_BOUNDARY_PADDING, this.#buf.length);
    while (i < paddingCap && (this.#buf[i] === SP || this.#buf[i] === TAB)) i += 1;
    if (i + 1 >= this.#buf.length && i - after < MAX_BOUNDARY_PADDING) {
      this.#buf = this.#buf.subarray(idx); // padding 还没读完，等下一个 chunk
      return false;
    }

    if (this.#buf[i] !== CR || this.#buf[i + 1] !== LF) {
      // 命中了 needle 但后面不是合法收尾 → 这只是**正文里恰好出现的相同字节串**，
      // 不是真分隔符（正文完全可以包含 `\r\n--boundaryXXX`）。原样当数据吐出去继续扫。
      this.#consumeBody(this.#buf.subarray(idx, after));
      this.#buf = this.#buf.subarray(after);
      return true;
    }

    this.#endPart();
    this.#buf = this.#buf.subarray(i + 2);
    this.#state = 'headers';
    return true;
  }

  #consumeBody(data: Buffer): void {
    if (this.#state === 'preamble' || data.length === 0) return;
    if (this.#isFile) {
      this.#handlers.onFileChunk?.(data);
      return;
    }
    this.#fieldBytes += data.length;
    if (this.#fieldBytes > this.#maxFieldBytes) {
      throw new MultipartError(
        `field ${this.#part?.name ?? '?'} exceeds ${this.#maxFieldBytes} bytes`,
        'FIELD_TOO_LARGE',
      );
    }
    // 拷贝：data 是 #buf 的视图，字段要攒到部件结束才用得上
    this.#fieldChunks.push(Buffer.from(data));
  }

  #beginPart(rawHeaders: string): void {
    this.#partCount += 1;
    if (this.#partCount > this.#maxParts) {
      throw new MultipartError(`too many parts (> ${this.#maxParts})`, 'TOO_MANY_PARTS');
    }
    const headers = parseHeaderBlock(rawHeaders);
    const disposition = headers['content-disposition'] ?? '';
    const name = dispositionParam(disposition, 'name');
    if (name === undefined) {
      throw new MultipartError('part without Content-Disposition name', 'PART_WITHOUT_NAME');
    }
    const cte = headers['content-transfer-encoding']?.toLowerCase();
    if (cte !== undefined && cte !== '7bit' && cte !== '8bit' && cte !== 'binary') {
      // 宁可明确拒绝，也不要"看起来收下了其实解错码"（base64 等浏览器根本不会用）
      throw new MultipartError(`unsupported Content-Transfer-Encoding: ${cte}`, 'UNSUPPORTED_CTE');
    }

    const info: PartInfo = {
      name,
      filename: dispositionParam(disposition, 'filename'),
      contentType: headers['content-type'],
    };
    this.#part = info;
    this.#isFile = info.filename !== undefined;
    this.#fieldChunks = [];
    this.#fieldBytes = 0;
    this.#state = 'body';
    if (info.filename !== undefined) {
      this.#handlers.onFileStart?.({ ...info, filename: info.filename });
    }
  }

  #endPart(): void {
    const part = this.#part;
    if (this.#state !== 'body' || !part) return;
    if (this.#isFile) {
      this.#handlers.onFileEnd?.();
    } else {
      this.#handlers.onField?.(part.name, Buffer.concat(this.#fieldChunks).toString('utf8'), part);
    }
    this.#part = undefined;
    this.#isFile = false;
    this.#fieldChunks = [];
    this.#fieldBytes = 0;
  }
}

/** header 块 → 小写 key 的字典。重复 header 取第一次出现的值。 */
function parseHeaderBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw.length === 0) return out;
  for (const line of raw.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key in out) continue;
    out[key] = line.slice(colon + 1).trim();
  }
  return out;
}

/**
 * 取 `Content-Disposition` 的参数（`name=` / `filename=`）。
 *
 * 注意 `;\s*` 前缀是必须的：否则找 `name` 会误命中 `filename` 的尾巴。
 */
export function dispositionParam(header: string, key: string): string | undefined {
  // RFC 5987 扩展形式优先（非 ASCII 文件名时部分客户端会发 `filename*=UTF-8''…`）
  const ext = new RegExp(`;\\s*${key}\\*\\s*=\\s*([^;]+)`, 'i').exec(header);
  const extValue = ext?.[1]?.trim();
  if (extValue) {
    const m = /^[^']*'[^']*'(.*)$/.exec(extValue);
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        /* 百分号编码坏了就退回普通形式 */
      }
    }
  }
  const m = new RegExp(`;\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, 'i').exec(
    header,
  );
  if (!m) return undefined;
  if (m[1] !== undefined) return m[1].replace(/\\(.)/g, '$1');
  return m[2];
}

/** 从 `Content-Type` 里取 boundary；不是 multipart/form-data 则返回 undefined。 */
export function parseBoundary(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  if (!/^\s*multipart\/form-data\s*(?:;|$)/i.test(contentType)) return undefined;
  const m = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  return b !== undefined && b.length > 0 && b.length <= 70 ? b : undefined;
}

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

/** 默认单文件上限 2 GiB。够一部电影，又不至于让手滑拖进来的磁盘镜像撑爆数据目录。 */
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 允许的扩展名白名单（音视频）。白名单而非黑名单 —— 这是文件写入路径。
 *
 * ★ T-152：清单本体已经搬到 `@openmemo/shared` 的 `UPLOAD_MEDIA_EXTENSIONS`，
 * **apps/web 的拖拽预检 `looksLikeMedia()` 用的是同一个常量**。
 * 收敛前这里是手抄的 17 项，而 web 那边写死了另一条 18 项的正则，
 * `[实测]` `web ∖ daemon = {flv, wmv}`：用户拖一个 `.flv` 进来，前端放行、
 * 界面上出现上传行、然后服务端在这里回 415。
 *
 * 这里保留导出名不变（`apps/daemon/dist/http/upload.d.ts` 里有它），
 * 也保留 `readonly string[]` 这个类型不变 —— 变的只有"值从哪来"。
 * ⚠️ 要加扩展名请改 shared 那一份，别在这里补，否则三份分叉当场复活。
 */
export const ALLOWED_UPLOAD_EXTENSIONS: readonly string[] = [...UPLOAD_MEDIA_EXTENSIONS];

/** 文件之外的部分（字段、header、分隔符）留的余量，用于 Content-Length 预检。 */
const ENVELOPE_SLACK_BYTES = 64 * 1024;

/** 落库只用到这两个方法 —— 收窄依赖，测试就不必造一个真 SQLite。真 `Repos` 结构上满足它。 */
export interface UploadRepos {
  createNote(p: { title: string; kind?: string; language?: string | null }): {
    readonly id: number;
    readonly uid: string;
  };
  createSource(p: {
    noteId: number;
    kind: string;
    originalUrl?: string | null;
    title?: string | null;
  }): number;
}

/** 真 `JobQueue` 结构上满足它。 */
export interface UploadQueue {
  enqueue(p: EnqueueParams): { readonly uid: string };
}

/** 真 `SseHub` 结构上满足它。 */
export interface UploadSse {
  publish(event: SseEvent): void;
}

export interface UploadRoutesDeps {
  readonly repos: UploadRepos;
  readonly queue: UploadQueue;
  /** 不传就不广播；main.ts 应该把 SseHub 传进来。 */
  readonly sse?: UploadSse | undefined;
  /** 上传文件的落盘目录（通常是 `paths.mediaDir`）。不存在会自动创建。 */
  readonly uploadDir: string;
  /** 半成品目录，默认 `<uploadDir>/.incoming`。**必须与 uploadDir 同一文件系统**，否则 rename 不原子。 */
  readonly tmpDir?: string | undefined;
  /** 单文件上限，默认 {@link DEFAULT_MAX_UPLOAD_BYTES}。 */
  readonly maxBytes?: number | undefined;
  /** 覆盖扩展名白名单（小写、带点）。 */
  readonly allowedExtensions?: readonly string[] | undefined;
}

class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly messageZh: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * 客户端文件名 → 安全扩展名。**只取扩展名，其余一律丢弃**。
 * 返回 undefined 表示"没有可信的扩展名"，调用方按 415 处理。
 */
export function safeExtension(filename: string): string | undefined {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined; // 无扩展名；`.mp3` 这种隐藏文件也不算
  const ext = base.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : undefined;
}

/** 原始文件名只做展示元数据（display_name）—— 去掉目录与控制字符，绝不进路径。 */
export function sanitizeDisplayName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- 就是要滤掉控制字符（含 NUL），别让它污染日志与前端渲染
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.slice(0, 255) || '未命名文件';
}

export function createUploadRoutes(deps: UploadRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const allowed = new Set(
    (deps.allowedExtensions ?? ALLOWED_UPLOAD_EXTENSIONS).map((e) => e.toLowerCase()),
  );
  const uploadDir = resolve(deps.uploadDir);
  const tmpDir = resolve(deps.tmpDir ?? join(uploadDir, '.incoming'));

  return {
    async handle(req, res, url, method): Promise<boolean> {
      if (url.pathname !== '/api/notes/upload') return false;
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST', '方法不允许');
        return true;
      }

      const boundary = parseBoundary(req.headers['content-type']);
      if (!boundary) {
        failFast(
          req,
          res,
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'expected Content-Type: multipart/form-data with a boundary',
          '请用 multipart/form-data 上传文件',
        );
        return true;
      }

      // Content-Length 预检：能在读第一个字节之前就拒掉超大上传
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes + ENVELOPE_SLACK_BYTES) {
        failFast(
          req,
          res,
          413,
          'PAYLOAD_TOO_LARGE',
          `body ${declared} bytes exceeds limit ${maxBytes}`,
          `文件超过上限（${formatBytes(maxBytes)}）`,
        );
        return true;
      }

      await mkdir(uploadDir, { recursive: true });
      await mkdir(tmpDir, { recursive: true });

      const fields = new Map<string, string>();
      let ws: WriteStream | undefined;
      let tmpPath: string | undefined;
      let finalPath: string | undefined;
      let committed = false;
      let displayName = '';
      let bytes = 0;
      let diskName = '';
      let sawFile = false;
      let writeError: Error | undefined;
      let drainNeeded = false;

      const cleanup = async (): Promise<void> => {
        if (ws) await destroyStream(ws);
        // 半成品必须删掉：留一个长度不对的文件在那儿，比没有文件更危险
        for (const p of [tmpPath, committed ? finalPath : undefined]) {
          if (!p) continue;
          try {
            await unlink(p);
          } catch {
            /* 没写出来 / 已删掉 */
          }
        }
      };

      try {
        const parser = new MultipartParser(boundary, {
          onField: (name, value) => {
            if (fields.size < 16) fields.set(name, value);
          },
          onFileStart: (info) => {
            if (sawFile) {
              throw new UploadError(
                400,
                'TOO_MANY_FILES',
                'only one file part is accepted',
                '一次只能上传一个文件',
              );
            }
            if (info.name !== 'file') {
              throw new UploadError(
                400,
                'UNEXPECTED_FILE_FIELD',
                `file part must be named "file", got ${JSON.stringify(info.name)}`,
                '文件字段名必须是 file',
              );
            }
            sawFile = true;
            displayName = sanitizeDisplayName(info.filename);
            const ext = safeExtension(info.filename);
            if (!ext || !allowed.has(ext)) {
              throw new UploadError(
                415,
                'UNSUPPORTED_MEDIA_TYPE',
                `extension not allowed: ${ext ?? '(none)'}`,
                `不支持的文件类型${ext ? `（${ext}）` : ''}，请上传音频或视频文件`,
              );
            }
            // 磁盘名与客户端输入**完全无关**：新 ulid + 白名单扩展名（D-01 §8.5）
            diskName = `${ulid()}${ext}`;
            finalPath = join(uploadDir, diskName);
            tmpPath = join(tmpDir, `${diskName}.part`);
            // 先写临时名再 rename：崩溃时绝不会在 media/ 里留下"看起来完整"的半个文件
            ws = createWriteStream(tmpPath, { flags: 'wx' });
            ws.on('error', (e: Error) => {
              writeError ??= e;
            });
          },
          onFileChunk: (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              throw new UploadError(
                413,
                'PAYLOAD_TOO_LARGE',
                `file exceeds limit ${maxBytes} bytes`,
                `文件超过上限（${formatBytes(maxBytes)}）`,
              );
            }
            if (writeError) throw writeError;
            // write() 返回 false 只是"缓冲满了"，数据不会丢；下一轮再等 drain 即可
            if (!ws?.write(chunk)) drainNeeded = true;
          },
        });

        let received = 0;
        await pumpRequest(req, (chunk) => {
          received += chunk.length;
          if (received > maxBytes + ENVELOPE_SLACK_BYTES) {
            throw new UploadError(
              413,
              'PAYLOAD_TOO_LARGE',
              `body exceeds limit ${maxBytes} bytes`,
              `文件超过上限（${formatBytes(maxBytes)}）`,
            );
          }
          parser.push(chunk);
          if (!drainNeeded || !ws) return undefined;
          drainNeeded = false;
          return waitDrain(ws);
        });
        parser.end();

        if (!sawFile || !ws || !tmpPath || !finalPath) {
          throw new UploadError(
            400,
            'MISSING_FILE',
            'no "file" part in the body',
            '缺少 file 部件',
          );
        }

        await endStream(ws);
        if (writeError) throw writeError;

        await rename(tmpPath, finalPath);
        committed = true;
        tmpPath = undefined;

        // ---- 与 /api/notes/import 落到完全相同的状态 ----
        const title = (fields.get('title') ?? '').trim() || displayName;
        const rawLang = (fields.get('language') ?? '').trim();
        const language = rawLang.length > 0 ? rawLang : null;

        const note = deps.repos.createNote({ title, kind: 'media', language });
        deps.repos.createSource({
          noteId: note.id,
          kind: 'local',
          originalUrl: null,
          // 原始文件名只活在元数据里（display_name），不参与任何路径拼接
          title: displayName,
        });

        const job = deps.queue.enqueue({
          type: 'transcribe',
          lane: 'gpu.asr',
          priority: 10,
          noteId: note.id,
          payload: {
            noteId: note.id,
            input: finalPath,
            language,
            // multipart 的这三个字段来自表单字段，缺省为 null = 自动选择
            engineId: (fields.get('engineId') ?? '').trim() || null,
            modelId: (fields.get('modelId') ?? '').trim() || null,
            prompt: (fields.get('prompt') ?? '').trim() || null,
            sourceKind: 'local',
          },
        });

        /*
         * 两处 `as never` 已删（T-130）。
         *
         * `note.created` 的载荷本来就是对的，断言纯属多余；
         * 而 `job.created` 那条**载荷是错的**：契约要求 `{ job: … }`，这里发的是
         * `{ jobUid, kind, label }`。`as never` 把编译器彻底消音，于是它一路发到了浏览器，
         * 前端 `ev.job.jobId` 读到 undefined —— `[实测]` 控制台每次上传都抛一次
         * `TypeError: Cannot read properties of undefined (reading 'jobId')`，
         * 事件被 bus 的 try/catch 吞掉，**看起来像"这条事件没人管"**。
         * 比不发更糟：不发只是缺反馈，发错还制造了一条假线索。
         *
         * 现在 `job.created` 由 `JobQueue` 的 onCreated 钩子统一发（main.ts），
         * 这里只留 `note.created`，不再有第二个发送方。
         */
        deps.sse?.publish(
          makeEvent('note.created', topics.note(note.uid), {
            noteUid: note.uid,
            title,
            folderUid: null,
          }),
        );

        // 202：写操作异步化（D-01 §3.2 规则 2），进度走 SSE
        sendJson(res, 202, {
          noteUid: note.uid,
          jobUid: job.uid,
          bytes,
          filename: displayName,
          storedAs: diskName,
        });
        return true;
      } catch (err) {
        await cleanup();
        if (res.headersSent) {
          res.destroy();
          return true;
        }
        if (err instanceof UploadError) {
          failFast(req, res, err.status, err.code, err.message, err.messageZh);
        } else if (err instanceof MultipartError) {
          failFast(req, res, 400, err.code, err.message, '上传数据格式不正确');
        } else {
          failFast(
            req,
            res,
            500,
            'UPLOAD_FAILED',
            err instanceof Error ? err.message : String(err),
            '上传失败',
          );
        }
        return true;
      }
    },
  };
}

/**
 * 读请求体。**刻意不用 `for await`** —— 提前 return/throw 时异步迭代器会直接
 * destroy 请求流，而我们还想先把错误响应写出去、再礼貌地丢弃剩余字节（见 drainAndClose）。
 *
 * `onChunk` 返回 Promise 时暂停读取直到它 resolve —— 这就是落盘的背压，
 * 保证内存里同时只有一个 chunk。
 */
function pumpRequest(
  req: IncomingMessage,
  onChunk: (chunk: Buffer) => Promise<void> | undefined,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      let pending: Promise<void> | undefined;
      try {
        pending = onChunk(chunk);
      } catch (e) {
        fail(e);
        return;
      }
      if (!pending) return;
      req.pause();
      pending.then(() => {
        if (!settled) req.resume();
      }, fail);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    req.on('error', fail);
    req.on('close', () => {
      if (!req.complete) fail(new Error('client aborted the upload'));
    });
  });
}

function waitDrain(ws: WriteStream): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const off = (): void => {
      ws.off('drain', ok);
      ws.off('error', bad);
      ws.off('close', closed);
    };
    const ok = (): void => {
      off();
      resolvePromise();
    };
    const bad = (e: Error): void => {
      off();
      reject(e);
    };
    const closed = (): void => {
      off();
      reject(new Error('write stream closed before drain'));
    };
    ws.on('drain', ok);
    ws.on('error', bad);
    ws.on('close', closed);
  });
}

function endStream(ws: WriteStream): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    ws.end();
    ws.once('error', reject);
    // 等 'close' 而不是 'finish'：必须确认 fd 已关闭，随后的 rename 才安全（Windows 尤其）
    ws.once('close', () => resolvePromise());
  });
}

function destroyStream(ws: WriteStream): Promise<void> {
  return new Promise((resolvePromise) => {
    if (ws.closed) {
      resolvePromise();
      return;
    }
    ws.once('close', () => resolvePromise());
    ws.destroy();
  });
}

/**
 * 早退（4xx/5xx）之后的收尾 —— 这里的每一步都有具体原因：
 *
 * 1. `Connection: close`：连接上还挂着一个我们不打算读完的请求体，
 *    复用它下一个请求就会错位。同时也让 Node 在响应发完后走"发 FIN 但继续读"的
 *    半关闭路径，而不是直接 destroy。
 * 2. `req.resume()` 丢弃剩余字节（不占内存、不落盘）。**不能直接 destroy socket**：
 *    内核接收缓冲里还有未读数据时 close 会发 RST，客户端可能连我们刚写出去的 413
 *    都读不到（经典的"上传超限却报 ECONNRESET"）。
 * 3. 兜底 2 秒硬断：不至于为了一个已经被拒的 2GB 上传把连接一直挂着。
 */
function failFast(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  messageZh: string,
): void {
  if (!res.headersSent) res.setHeader('Connection', 'close');
  sendError(res, status, code, message, messageZh);
  if (req.complete || req.destroyed) return;
  req.resume();
  const timer = setTimeout(() => req.destroy(), 2000);
  timer.unref();
  const stop = (): void => clearTimeout(timer);
  req.once('end', stop);
  req.once('close', stop);
  req.once('error', stop);
}

function formatBytes(n: number): string {
  const gib = n / (1024 * 1024 * 1024);
  if (gib >= 1) return `${Number(gib.toFixed(2))} GiB`;
  const mib = n / (1024 * 1024);
  if (mib >= 1) return `${Number(mib.toFixed(2))} MiB`;
  return `${n} B`;
}
