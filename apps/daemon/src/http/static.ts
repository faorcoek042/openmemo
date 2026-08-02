/**
 * 托管前端静态产物（apps/web/dist），让 daemon 成为**一站式入口** ——
 * 用户开一个地址就能用，不需要另外起 Vite。
 *
 * 放在鉴权闸门**之前**：index.html 和 assets 必须先能加载，
 * 页面里的 JS 才有机会拿 URL fragment 里的 token 去换 cookie 会话
 * （token 在 fragment 里，浏览器根本不会把它发给服务端）。
 * 因此这些文件是公开的 —— 它们只是构建产物，不含任何用户数据或密钥。
 * 真正的数据接口全在 /api/** 之下，一个都没放行。
 */
import { createReadStream, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

/** 解析前端产物目录。允许用环境变量覆盖（打包后布局会变）。 */
export function resolveWebDist(): string | undefined {
  const override = process.env['OPENMEMO_WEB_DIST'];
  if (override) return existsDir(override) ? resolve(override) : undefined;
  // dist/http/static.js → ../../../web/dist
  const here = dirname(fileURLToPath(import.meta.url));
  const guess = resolve(join(here, '..', '..', '..', 'web', 'dist'));
  return existsDir(guess) ? guess : undefined;
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 尝试把请求当静态资源处理。
 * @returns true 表示已经响应，调用方不要再往下走。
 */
export function serveStatic(
  root: string,
  urlPath: string,
  method: string,
  res: ServerResponse,
  isNavigation = false,
): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  // 后端命名空间永远不走静态，避免静态文件意外遮蔽接口
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/ws/') || urlPath.startsWith('/media/')) {
    return false;
  }

  const rel = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  let file = resolve(join(root, normalize(rel)));

  /*
   * 目录穿越防护：normalize 之后仍要**验证解析结果确实在 root 之内**。
   * 只做字符串前缀比较会被 `/root-evil` 这类同前缀目录骗过，所以带上分隔符。
   */
  if (file !== root && !file.startsWith(root + sep)) return false;

  let st = safeStat(file);
  if (st?.isDirectory()) {
    file = join(file, 'index.html');
    st = safeStat(file);
  }

  if (!st?.isFile()) {
    /*
     * SPA 兜底**只对浏览器导航生效**。
     *
     * 一开始我写成"任何无扩展名的路径都回 index.html"，结果把
     * `/media/../../etc/passwd`（URL 规范化后变成 `/etc/passwd`）也回成了 200 ——
     * 而 D-01 §8.5 的穿越防护用例要求这类请求必须 400/404。
     * 没泄露任何文件内容，但**把本该 404 的东西变成 200 就是在遮蔽后端的拒绝**，
     * 测试因此变红（它干得对）。
     * 判据用 Sec-Fetch-Mode / Accept：只有真正的地址栏导航才吃兜底，
     * fetch/curl 这类非导航请求照旧 404。
     */
    if (!isNavigation) return false;
    if (extOf(rel) !== '') return false;
    file = join(root, 'index.html');
    st = safeStat(file);
    if (!st?.isFile()) return false;
  }

  const isHashed = /\.[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|svg|jpg|jpeg|webp)$/.test(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extOf(file)] ?? 'application/octet-stream');
  res.setHeader('Content-Length', Number(st.size));
  // 带内容哈希的产物可以长缓存；index.html 绝不缓存，否则用户拿到旧壳配新 assets
  res.setHeader('Cache-Control', isHashed ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

function safeStat(p: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}
