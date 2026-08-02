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
import { isAbsolute, join, resolve, sep } from 'node:path';

import type { Repos } from '../db/repos.js';
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

export interface MediaRoutesDeps {
  readonly repos: Repos;
  readonly mediaRoot: string;
  /** 产物可能还在 tmp 里（尚未归档到 media/）→ 也允许从这里读。 */
  readonly extraRoots?: readonly string[];
}

export function createMediaRoutes(deps: MediaRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const roots = [deps.mediaRoot, ...(deps.extraRoots ?? [])].map((r) => resolve(r));

  /** 把 asset 的 rel_path 解析成一个**确认落在允许根内**的绝对路径。 */
  function resolveAssetPath(relOrAbs: string): string | undefined {
    const candidates = isAbsolute(relOrAbs)
      ? [resolve(relOrAbs)]
      : roots.map((r) => resolve(join(r, relOrAbs)));
    for (const abs of candidates) {
      // 即使 rel_path 是我们自己写的，也要再确认一次没跑出根
      // （DB 可能被手工改过；纵深防御，成本为零）
      if (roots.some((r) => abs === r || abs.startsWith(r + sep))) return abs;
    }
    return undefined;
  }

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

      const abs = resolveAssetPath(asset.rel_path);
      if (!abs) {
        sendError(res, 403, 'ASSET_OUT_OF_ROOT', 'asset path escapes media root', '媒体路径越界');
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
