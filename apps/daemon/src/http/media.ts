/**
 * `/media/**` 字节流（D-01 §3.1）。
 *
 * **为什么必须独立于 REST**：`<audio>`/`<video>` 由浏览器发起请求，不经过我们的 fetch 封装
 * → 带不了 header（靠 cookie 鉴权）、**必须支持 Range/206**、需要不同的缓存头、
 * 绝不能走 JSON 序列化。混进 `/api` 会污染 REST 的中间件栈。
 *
 * **寻址规则（安全）**：只接受 asset uid（`/media/asset/<ulid>`），
 * **绝不接受文件系统路径参数** —— 这从根上消灭路径穿越（D-01 §8.5）。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { probeAssetFile } from '@openmemo/runtime';

import type { AssetRow } from '../db/repos.js';
import { sendError } from './respond.js';

const MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};

function guessMime(p: string): string {
  const i = p.lastIndexOf('.');
  return (i >= 0 ? MIME_BY_EXT[p.slice(i).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

/** 解析 `Range: bytes=a-b`。只支持单区间 —— 多区间在本地播放场景没有实际需求。 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return 'invalid';

  let start: number;
  let end: number;
  if (!rawStart) {
    // bytes=-N → 最后 N 字节
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start < 0 || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 只收窄到本路由真正用到的那一个方法 —— 测试因此可以喂一份**真 `Repos` 结构上兼容**
 * 的假实现，而不必开一个数据库。`media.test.ts` 里有编译期护栏钉住这层兼容。
 */
export interface MediaRepos {
  assetByUid(uid: string): AssetRow | undefined;
}

export interface MediaRoutesDeps {
  readonly repos: MediaRepos;
  readonly mediaRoot: string;
  /** 产物可能还在 tmp 里（尚未归档到 media/）→ 也允许从这里读。 */
  readonly extraRoots?: readonly string[];
}

export function createMediaRoutes(deps: MediaRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const roots = [deps.mediaRoot, ...(deps.extraRoots ?? [])].map((r) => resolve(r));

  /*
   * ★ T-136：路径解析交给 `@openmemo/runtime` 的 `probeAssetFile` —— 与 `/api/selfcheck`
   * **同一份实现**。这里原来的写法是「返回第一个落在根内的候选」，而候选①（`mediaRoot`）
   * 对任何相对路径**永远落在根内**，于是 `extraRoots` 这两个根**一次都没被试过**：
   * `migrateAssets` 写出来的 `media/legacy/x.wav` 被拼成 `<dataDir>/media/media/legacy/x.wav`
   * （两个 media），实测用户库 4 条资产里 **3 条播放直接 404**。
   * 现在改成「第一个**真能打开**的候选」，判据从"落在根内"变成"真的读到了字节"。
   */

  return {
    async handle(req, res, url, method): Promise<boolean> {
      if (!url.pathname.startsWith('/media/')) return false;

      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
        return true;
      }

      const m = /^\/media\/asset\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(url.pathname);
      if (!m) {
        sendError(
          res,
          400,
          'BAD_MEDIA_REF',
          'media path must be /media/asset/<ulid>',
          '媒体引用必须是 asset uid，不接受文件路径',
        );
        return true;
      }

      const asset = deps.repos.assetByUid(m[1] as string);
      if (!asset) {
        sendError(res, 404, 'ASSET_NOT_FOUND', `no asset ${m[1]}`, '媒体资源不存在');
        return true;
      }

      const probe = await probeAssetFile(roots, asset.rel_path);
      if (probe.tried.length === 0) {
        // 记录指到了所有根之外 —— 这是"越界"，与"文件不在"是两码事，别混报
        sendError(res, 403, 'ASSET_OUT_OF_ROOT', 'asset path escapes media root', '媒体路径越界');
        return true;
      }
      const abs = probe.abs;
      if (abs === null) {
        sendError(
          res,
          404,
          'ASSET_FILE_MISSING',
          // 把**找过的每个位置**都列出来：只报一个路径时，用户无从判断
          // 到底是文件没了还是我们找错了地方（T-136 就栽在这句话上）
          `file missing: ${asset.rel_path} (tried: ${probe.tried.join(', ')})`,
          '媒体文件读不到（可能是文件已移动，也可能是记录里的路径不对）',
        );
        return true;
      }

      let size: number;
      let mtime: Date;
      try {
        const st = await stat(abs);
        if (!st.isFile()) throw new Error('not a file');
        size = st.size;
        mtime = st.mtime;
      } catch {
        sendError(res, 404, 'ASSET_FILE_MISSING', `file missing: ${abs}`, '媒体文件已丢失');
        return true;
      }

      const etag = `"${asset.uid}-${size}-${mtime.getTime().toString(36)}"`;
      const mime = asset.mime ?? guessMime(abs);

      const baseHeaders: Record<string, string> = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'Last-Modified': mtime.toUTCString(),
        // private：本地单用户，但仍不希望任何中间层缓存
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      };

      // 条件请求：ETag 命中直接 304
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': baseHeaders['Cache-Control'] as string });
        res.end();
        return true;
      }

      const range = parseRange(req.headers['range'], size);
      if (range === 'invalid') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
        res.end();
        return true;
      }

      if (method === 'HEAD') {
        res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) });
        res.end();
        return true;
      }

      if (!range) {
        res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) });
        createReadStream(abs).pipe(res);
        return true;
      }

      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(length),
      });
      createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
      return true;
    },
  };
}
