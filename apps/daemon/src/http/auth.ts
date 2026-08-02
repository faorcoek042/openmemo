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
import type { IncomingMessage } from 'node:http';

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
export function checkCsrf(req: IncomingMessage, auth: AuthResult): boolean {
  if (!auth.ok) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (auth.via === 'bearer') return true;
  const provided = req.headers[CSRF_HEADER];
  if (typeof provided !== 'string' || !auth.session) return false;
  return safeEqual(provided, auth.session.csrf);
}
