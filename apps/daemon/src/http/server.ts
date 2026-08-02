/**
 * HTTP 服务器：四通道路由骨架（D-01 §3.1）。
 *
 * | 前缀 | 通道 | 说明 |
 * |---|---|---|
 * | `/api/**` | REST/JSON | 短请求。具体 endpoint 的类型契约归 `packages/shared`（model-mgmt） |
 * | `/api/events` | **SSE 全局唯一一条** | 所有服务端→客户端异步通知 |
 * | `/ws/**` | WebSocket | 仅 `/ws/recorder` 与 `/ws/asr-worker` 两种双向场景 |
 * | `/media/**` | 字节流 | 必须支持 Range；只接受 asset uid，**绝不接受文件系统路径** |
 *
 * ⚠️ 本文件只实现**路由骨架与信封**。业务 endpoint 的请求/响应 schema 归 `packages/shared`。
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { CONTRACT_VERSION } from '@openmemo/shared';

import {
  CSRF_HEADER,
  type SessionStore,
  authenticate,
  buildSessionCookie,
  checkCsrf,
} from './auth.js';
import { guardRequest } from './guard.js';
import { readJsonBody as readBody, sendError, sendJson } from './respond.js';
import { modelRoutesFor } from './rest/models.js';
import type { SseHub } from './sse.js';

export interface ServerDeps {
  readonly sessions: SessionStore;
  readonly sse: SseHub;
  /**
   * 取 instanceId。**必须是函数而不是值** —— instanceId 在端口绑定成功之后才产生，
   * 而 handler 必须在绑定之前就挂好（否则会有"端口已通但没有 handler"的窗口，
   * 单实例探测正好打 /api/health，那个窗口会让探测误判）。
   */
  readonly instanceId: () => string;
  readonly version: string;
  readonly dataDir: string;
  readonly port: () => number;
  /** 健康检查里暴露的运行时状态（不含任何 secret）。 */
  readonly status: () => Record<string, unknown>;
  /**
   * 业务路由模块。按顺序尝试，第一个返回 true 的即处理完毕。
   * 放在鉴权与 CSRF **之后**、404 **之前**。
   */
  readonly routers?: readonly RouteModule[];
}

export interface RouteModule {
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
  ): Promise<boolean>;
}

// 响应 helpers 统一放 respond.ts，各路由模块共用同一套信封
export { readJsonBody, sendError, sendJson } from './respond.js';

export function attachHttpHandlers(server: Server, deps: ServerDeps): void {
  server.on('request', (req, res) => {
    void handleRequest(req, res, deps).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(
        res,
        500,
        'INTERNAL',
        err instanceof Error ? err.message : String(err),
        '服务内部错误',
      );
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? '127.0.0.1'}`);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // ---- /api/health：**公开**，不需要鉴权 ----
  // 单实例探测在拿到 token 之前就要调它（D-01 §2.2 阶梯第 2 步）。
  // 因此它**绝不能**包含 token 或任何 secret。
  if (path === '/api/health') {
    sendJson(res, 200, {
      app: 'openmemo',
      version: deps.version,
      instanceId: deps.instanceId(),
      contractVersion: CONTRACT_VERSION,
      dataDir: deps.dataDir,
      // host 必须回传：单实例探测拿它拼「已在运行」的提示 URL（少了会显示 undefined）
      host: '127.0.0.1',
      port: deps.port(),
      pid: process.pid,
      ...deps.status(),
    });
    return;
  }

  // ---- 闸门：Host / Origin / Sec-Fetch（DNS rebinding + CSRF）----
  const guard = guardRequest(req, [deps.port()]);
  if (!guard.ok) {
    sendError(res, 403, 'FORBIDDEN_ORIGIN', guard.reason ?? 'blocked', '请求来源不被信任');
    return;
  }

  // ---- 建立会话：Bearer token → HttpOnly cookie（D-01 §2.4）----
  if (path === '/api/auth/session' && method === 'POST') {
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      sendError(res, 401, 'UNAUTHENTICATED', 'missing bearer token', '缺少启动令牌');
      return;
    }
    if (!deps.sessions.verifyBootToken(auth.slice(7))) {
      sendError(res, 401, 'UNAUTHENTICATED', 'invalid token', '启动令牌无效');
      return;
    }
    const session = deps.sessions.create();
    res.setHeader('Set-Cookie', buildSessionCookie(session.sid));
    // CSRF token 走响应体（前端存 sessionStorage），非 GET 请求需回传该头
    sendJson(res, 200, {
      csrf: session.csrf,
      csrfHeader: CSRF_HEADER,
      contractVersion: CONTRACT_VERSION,
    });
    return;
  }

  // ---- 其余一律需要鉴权 ----
  const auth = authenticate(req, deps.sessions);
  if (!auth.ok) {
    sendError(res, 401, 'UNAUTHENTICATED', auth.reason, '未认证，请重新打开应用');
    return;
  }
  if (!checkCsrf(req, auth)) {
    sendError(res, 403, 'CSRF_FAILED', 'missing or bad CSRF token', 'CSRF 校验失败');
    return;
  }

  // ---- SSE：全局唯一一条 ----
  if (path === '/api/events') {
    if (method !== 'GET') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
      return;
    }
    const sid = auth.session?.sid ?? `bearer:${deps.instanceId()}`;
    const lastIdRaw = req.headers['last-event-id'];
    const lastId = typeof lastIdRaw === 'string' ? Number(lastIdRaw) : undefined;
    deps.sse.attach(sid, res, Number.isFinite(lastId) ? lastId : undefined);
    return;
  }

  // ---- REST 骨架 ----
  if (path === '/api/daemon/status' && method === 'GET') {
    sendJson(res, 200, deps.status());
    return;
  }

  if (path === '/api/daemon/shutdown' && method === 'POST') {
    sendJson(res, 202, { ok: true });
    // 让响应先发出去再退出
    setTimeout(() => process.emit('SIGTERM'), 10);
    return;
  }

  if (path === '/api/echo' && method === 'POST') {
    // 骨架自检用：验证 body 解析 + CSRF 链路通了
    const body = await readBody(req);
    sendJson(res, 200, { echo: body ?? null });
    return;
  }

  // ---- 业务路由（models / backends / jobs / notes / media …）----
  for (const router of deps.routers ?? []) {
    if (await router.handle(req, res, url, method)) return;
  }

  // 模型 / 后端 / 下载任务（shared ENDPOINTS 的 26 条 REST）。按 deps 记忆化，
  // 不经由 deps.routers 是因为 main.ts 归属其他任务，不在本次改动范围内。
  if (await modelRoutesFor(deps).handle(req, res, url, method)) return;

  sendError(res, 404, 'NOT_FOUND', `no route for ${method} ${path}`, '接口不存在');
}
