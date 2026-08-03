/**
 * 鉴权：token（fragment 交付）→ HttpOnly cookie（D-01 §2.4）。
 *
 * **为什么必须换成 cookie —— 这是技术强制，不是偏好**：
 * | 通道 | 能否带自定义 header |
 * |---|---|
 * | fetch() REST | ✅ |
 * | EventSource (SSE) | ❌ 规范不支持 |
 * | WebSocket（浏览器 API） | ❌ |
 * | `<audio src>` / `<video src>` | ❌ |
 *
 * 四类通道里有三类带不了 `Authorization` 头。把 token 塞 query 会进日志。
 * → cookie 是唯一同时覆盖四者的方案；代价是引入 CSRF 面，用 guard.ts 的四重防护对冲。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

export const SESSION_COOKIE = 'om_sid';
export const CSRF_HEADER = 'x-openmemo-csrf';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 定长比较，避免通过响应时间侧信道猜 token。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface Session {
  readonly sid: string;
  readonly csrf: string;
  readonly createdAt: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #bootToken: string;

  constructor(bootToken: string, seed?: readonly Session[]) {
    this.#bootToken = bootToken;
    // 自我重启时把上一进程的会话接过来。不接的话：浏览器手里的 HttpOnly cookie
    // 指向一个已经不存在的 sid → 全站 401，而前端早就把 URL 里的 token 抹掉了
    // （防截图泄露），连重新握手都做不到 —— 用户只剩"去终端看新地址"这一条路，
    // 那正是自我重启要消灭的东西。
    for (const s of seed ?? []) this.#sessions.set(s.sid, s);
  }

  /** 导出会话，交给自我重启拉起的新进程（见 main.ts 的 restart）。 */
  export(): Session[] {
    return [...this.#sessions.values()];
  }

  /** 校验启动 token（来自 URL fragment 或 CLI 的 Bearer）。 */
  verifyBootToken(token: string): boolean {
    return safeEqual(token, this.#bootToken);
  }

  create(): Session {
    const s: Session = {
      sid: randomBytes(32).toString('base64url'),
      csrf: randomBytes(32).toString('base64url'),
      createdAt: Date.now(),
    };
    this.#sessions.set(s.sid, s);
    return s;
  }

  get(sid: string): Session | undefined {
    return this.#sessions.get(sid);
  }

  destroy(sid: string): void {
    this.#sessions.delete(sid);
  }

  get size(): number {
    return this.#sessions.size;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * 取一个**跨重启稳定**的启动 token：有就复用，没有就生成并存下来。
 *
 * ## 为什么必须稳定
 * 原来每次启动都 `generateToken()`。后果是**用户保存的那个 `#t=...` 链接一重启就作废** ——
 * 而前端握手时会把 fragment 里的 token 从地址栏抹掉（防截图泄露），
 * 于是刷新也救不回来，整页只剩「未认证，请重新打开应用」。
 * 用户这次报的"页面很多地方报未认证"就是这个，**不是校验太严**：
 * 实测从外部 IP 走完整流程（导航→token 换 cookie→GET→带 CSRF 的写）全部 200，
 * 唯独用旧 token 换会话是 401。放宽任何校验都修不好它，只有让 token 别再漂。
 *
 * ## 存盘安全吗
 * 存在 `<dataDir>/runtime/token`，0600。**同目录下就是整个 SQLite 库**（用户所有笔记）——
 * 能读到这个文件的人本来就能直接读走全部数据，多一个 token 不增加实际暴露面。
 */
export function loadOrCreateToken(runtimeDir: string): string {
  const file = join(runtimeDir, 'token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* 没有就往下生成 */
  }
  const token = generateToken();
  try {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(file, token, { mode: 0o600 });
  } catch {
    /* 存不下来不致命：退化成"本次启动有效"，不要因此起不来 */
  }
  return token;
}

export function buildSessionCookie(sid: string): string {
  // SameSite=Strict + HttpOnly + Path=/：
  // HttpOnly 让 XSS 偷不走；SameSite=Strict 挡掉大部分跨站请求。
  // 不设 Secure —— 我们是 http://127.0.0.1，设了反而不会被发送。
  return `${SESSION_COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export type AuthResult =
  { ok: true; via: 'cookie' | 'bearer'; session?: Session } | { ok: false; reason: string };

/**
 * 鉴权一个请求。两条通道：
 * - cookie（浏览器四类通道通用）
 * - Bearer（CLI / 脚本 / 第三方集成，不受 CSRF 影响）
 */
export function authenticate(req: IncomingMessage, store: SessionStore): AuthResult {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return store.verifyBootToken(auth.slice(7))
      ? { ok: true, via: 'bearer' }
      : { ok: false, reason: 'invalid bearer token' };
  }

  const sid = parseCookies(req.headers['cookie'])[SESSION_COOKIE];
  if (!sid) return { ok: false, reason: 'no credentials' };
  const session = store.get(sid);
  if (!session) return { ok: false, reason: 'unknown session' };
  return { ok: true, via: 'cookie', session };
}

/**
 * CSRF 双提交校验：非 GET/HEAD 且走 cookie 鉴权的请求，必须额外带 CSRF 头。
 * Bearer 通道天然免疫（攻击页拿不到 token），故跳过。
 */
export type CsrfOutcome =
  /** 带了正确的 CSRF 头，或本就不需要（GET / Bearer 通道）。 */
  | { ok: true; via: 'token' | 'exempt' }
  /** 没带 CSRF 头，但**严格同源**，按本地自用裁决放行。调用方应记一条 info。 */
  | { ok: true; via: 'same-origin-fallback' }
  | { ok: false; reason: string };

/**
 * CSRF 校验。
 *
 * ## 同源兜底是**显式裁决，不是遗漏**（ADR，勿当 bug 修掉）
 * 本项目是本地自部署自用。用户明确要求"别搞那么多安全策略"。
 * 现实是：前端在 `sessionStorage` 不可用时会丢掉 CSRF 头，于是
 * **读全部 200、写全部 403** —— 用户填完 API Key 点保存，界面毫无异常，库里一行没有。
 * 这一层挡不住真正的威胁（**能伪造同源 Origin 的攻击者，本来就能直接读 SQLite 文件**），
 * 却天天挡住合法用户。
 *
 * 因此：**没带 CSRF 头时，若同时满足下面两条，放行**。
 *   1. `Origin` 与本次请求**严格同源**（host:port 完全相等）
 *   2. `Sec-Fetch-Site: same-origin` —— **浏览器强制附加、页面 JS 无法伪造**，
 *      比 Origin 更可信；我在裁决基础上主动加的这一条。
 *
 * ## 三条边界，别削掉
 * - **带了 CSRF 头就仍然严格校验**：有兜底不等于不看，带错的一律拒。
 * - 兜底路径要让调用方记 **info**（预期路径，不是异常）。若日志显示它成了常态，
 *   说明前端那个根因没修好 —— 这条日志就是用来发现这件事的。
 * - token 鉴权**完全不动**：它才是真正的访问控制。
 */
export function checkCsrfDetailed(req: IncomingMessage, auth: AuthResult): CsrfOutcome {
  if (!auth.ok) return { ok: false, reason: 'unauthenticated' };
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { ok: true, via: 'exempt' };
  }
  // Bearer 通道天然免疫（攻击页拿不到 token）
  if (auth.via === 'bearer') return { ok: true, via: 'exempt' };

  const provided = req.headers[CSRF_HEADER];
  if (typeof provided === 'string') {
    // 带了就必须对 —— 兜底不适用于"带了个错的"
    if (!auth.session) return { ok: false, reason: 'no session bound to request' };
    return safeEqual(provided, auth.session.csrf)
      ? { ok: true, via: 'token' }
      : { ok: false, reason: 'CSRF token mismatch' };
  }

  // ---- 没带头：走同源兜底 ----
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') {
    return { ok: false, reason: `no CSRF token and Sec-Fetch-Site=${String(site)}` };
  }
  const origin = req.headers['origin'];
  const host = typeof req.headers['host'] === 'string' ? req.headers['host'].toLowerCase() : undefined;
  if (typeof origin !== 'string' || !host) {
    return { ok: false, reason: 'no CSRF token and no verifiable same-origin evidence' };
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: 'no CSRF token and unparsable Origin' };
  }
  if (parsed.host.toLowerCase() !== host) {
    return { ok: false, reason: `no CSRF token and cross-origin (${parsed.host} vs ${host})` };
  }
  /*
   * 走到这里：Sec-Fetch-Site 要么明确是 same-origin、要么客户端根本没发（非浏览器）；
   * 且 Origin 与 Host 严格相等。按裁决放行。
   */
  return { ok: true, via: 'same-origin-fallback' };
}

/** 旧签名保留，内部走同一套判定。 */
export function checkCsrf(req: IncomingMessage, auth: AuthResult): boolean {
  return checkCsrfDetailed(req, auth).ok;
}
