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
  type AuthResult,
  type CsrfOutcome,
  authRequired,
  authenticate,
  buildSessionCookie,
  checkCsrfDetailed,
} from './auth.js';
import { guardRequest } from './guard.js';
import { resolveWebDist, serveStatic } from './static.js';
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
  /** 构建来源（commit / 构建时刻）+ 本进程启动时刻。见 main.ts 的 BUILD_INFO。 */
  readonly build?: {
    readonly commit: string;
    readonly commitTime: string | null;
    readonly dirty: boolean;
    readonly builtAt: string | null;
    readonly startedAt: string;
  };
  readonly dataDir: string;
  readonly port: () => number;
  /**
   * **实际绑定到的监听地址**，不是一个字面量。
   *
   * 这里原来写死 `'127.0.0.1'`。它不是显示错误，是**安全结论的输入**：
   *   · 单实例探测用它拼「已在运行 http://<host>:<port>」的提示（`AlreadyRunningError`）；
   *   · 任何读这个字段判断"是不是只绑回环"的人或脚本，在
   *     `OPENMEMO_HOST=0.0.0.0` 的部署上会得到**恰好相反**的结论。
   * `[本机实测]` `ss -ltnp` 显示当前实例绑在 `0.0.0.0`，而 `/api/health` 回 `127.0.0.1`。
   *
   * 与 `port` 同理必须是函数：地址在端口绑定成功之后才由 `server.address()` 确定，
   * 而 handler 必须在绑定之前就挂好。
   */
  readonly host: () => string;
  /** 健康检查里暴露的运行时状态（不含任何 secret）。 */
  readonly status: () => Record<string, unknown>;
  /**
   * 触发自我重启。
   *
   * SQLite 扩展只能在**新建连接**时加载，所以"网页装完中文分词器立刻生效"
   * 只能靠换一个进程。让 daemon 自己重启，用户点一下按钮即可 ——
   * 要求 2.1「用户不碰命令行」在字面上仍然成立。
   */
  readonly requestRestart?: (reason: string, opts?: { dataDir?: string }) => void;
  /**
   * 业务路由模块。按顺序尝试，第一个返回 true 的即处理完毕。
   * 放在鉴权与 CSRF **之后**、404 **之前**。
   */
  readonly routers?: readonly RouteModule[];
  /**
   * **本进程是否已经装完它承诺的东西。**
   *
   * ## 为什么需要它（一次真实的、用户可见的 404）
   *
   * `[CI 实测 2026-08-08 run 31205369931, windows-2025]`
   * 预编译包的升级验证红在 `POST /api/folders` → **404 `no route for POST /api/folders`**，
   * 而**同一份代码在 Linux 与 macOS 上都是绿的**。
   *
   * 成因不是 Windows 特有缺陷，是一个一直开着的窗口被慢一点的机器撞上了：
   *   · `/api/health` 由本文件**直接**应答，不经过路由表；
   *   · 而业务路由是 `main.ts` 的 `routers.push(...)`，发生在 server 建好**之后**。
   * 于是「health 说 200」与「路由表装完了」之间有一段真空。
   * 上面 `instanceId` 的注释里其实早就记着**单实例探测撞过同一个窗口** ——
   * **同一个形状撞第二次了，而且这次是用户可见的 404。**
   *
   * ## 判据不是"让 health 晚点答"，是"health 说 ready 的时候它承诺的东西必须真的在"
   *
   * 一个在路由还没挂上时就答 200 的就绪信号，本身就是在说谎。所以：
   *   · 没 ready  → `/api/health` 回 **503**，`ready:false`；
   *     其余会落到 404 的请求也回 **503 `SERVICE_STARTING`**，
   *     而不是 404 —— 404 的语义是"这个端点不存在"，那是假话。
   *   · ready 了  → 一切照旧。
   *
   * ⚠️ **不给（undefined）= 永远 ready。** 这是刻意的：`healthHost.test.ts` 之类
   * 只测某一个字段的用例不必关心启动阶段，而生产路径（main.ts）必须显式传。
   */
  readonly ready?: () => boolean;
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
    const ready = deps.ready?.() ?? true;
    /*
     * ★★ 身份字段在 **ready 与未 ready 两种情况下都必须原样给全**。
     *
     * 这不是为了好看，是**单实例探测赖以工作的东西**：另一个进程撞到
     * `EADDRINUSE` 之后会打这个端点，靠 `app === 'openmemo'` + `dataDir`
     * 判断「占着端口的是不是我们自己」。
     *
     * 如果启动中的实例在这里少给身份、或者干脆不应答，探测方会判定
     * 「这不是我们的服务」→ **顺延到下一个端口**。而端口漂移的代价写在
     * `single-instance.ts` 的注释里：**浏览器按 origin 隔离麦克风授权，
     * 端口一变用户要重新授权一次**（直接影响录音转文字）。
     * 也就是说"把启动探测饿死"的后果不是慢一点，是用户功能坏掉。
     */
    const identity = {
      app: 'openmemo',
      version: deps.version,
      build: deps.build,
      instanceId: deps.instanceId(),
      contractVersion: CONTRACT_VERSION,
      dataDir: deps.dataDir,
      // host 必须回传：单实例探测拿它拼「已在运行」的提示 URL（少了会显示 undefined）。
      // **必须是真实绑定地址** —— 见 ServerDeps.host 的说明。
      host: deps.host(),
      port: deps.port(),
      pid: process.pid,
      ready,
    };
    if (!ready) {
      /*
       * 503 而不是 200：**这台服务器还不能兑现它承诺的东西。**
       *
       * 这里**刻意不展开 `deps.status()`** —— 那个闭包读的是启动过程中才逐个
       * 赋值的东西（数据库、扩展状态、pipeline）。在未 ready 阶段调它，
       * 轻则字段是 undefined，重则 TDZ 抛错，而抛错会让健康检查
       * **从"我还没好"变成"我 500 了"** —— 那对探测方是完全不同的结论。
       * 未 ready 时只给身份，是能诚实给出的最大集合。
       */
      res.setHeader('Retry-After', '1');
      sendJson(res, 503, { ...identity, status: 'starting' });
      return;
    }
    sendJson(res, 200, {
      ...identity,
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

  /*
   * ---- 前端静态产物 ----
   * 必须在鉴权**之前**：token 在 URL fragment 里，服务端根本收不到，
   * 只有先把 index.html 和 JS 发出去，页面才有机会拿它去换会话。
   * 放行范围仅限构建产物本身，/api/** 与 /ws/** 在 serveStatic 里被显式排除。
   */
  const webDist = resolveWebDist();
  if (webDist) {
    // 只有浏览器地址栏导航才吃 SPA 兜底（见 static.ts 里的说明）
    const accept = req.headers['accept'];
    const isNavigation =
      req.headers['sec-fetch-mode'] === 'navigate' ||
      (typeof accept === 'string' && accept.includes('text/html'));
    if (serveStatic(webDist, path, method, res, isNavigation)) return;
  }

  /*
   * ---- 建立 / 续签会话（D-01 §2.4）----
   *
   * 两条入口，缺一不可：
   *   1. **Bearer**（来自 URL fragment 的启动令牌）→ 新建会话。首次进入走这条。
   *   2. **仅 cookie 续签** → 发回**该会话现有的** CSRF 令牌。
   *
   * 为什么必须有第 2 条：**cookie 是 per-origin（跨标签共享），CSRF 令牌是 per-tab。**
   * 用户在第二个标签页打开（地址里没有 `#t=`）时，cookie 带得过去、CSRF 令牌带不过去，
   * 于是**读全通、界面完全正常、写全部 403、库里一行没有** ——
   * 用户以为 key 设好了，其实什么都没落。这不需要任何存储故障，是正常语义下的必然结果。
   *
   * 没有这条续签，新标签页就**无法自愈**：它既没有 token 可以重新握手，
   * 又拿不到 CSRF 令牌，只能让用户回去翻那条带 `#t=` 的原始链接 ——
   * 而前端为了防截图泄露，早就把它从地址栏抹掉了。
   *
   * ★ 续签**复用同一个会话**、不新建：所有标签页因此收敛到同一个 session + 同一个 CSRF 令牌。
   *   每个标签新建一个 session 会让会话表随标签数无限增长，且退出登录时清不干净。
   */
  if (path === '/api/auth/session' && method === 'POST') {
    const auth = req.headers['authorization'];
    const hasBearer = typeof auth === 'string' && auth.startsWith('Bearer ');

    /*
     * ★ 鉴权关掉时，握手**不该失败**。
     *
     * 关掉 token 鉴权之后，各个端点确实都放行了，但这条握手仍然要求
     * "有 Bearer 或有有效 cookie"，两个都没有就 401 —— 而**没人再发得出 Bearer**。
     * 于是 `authed` 恒为 false，前端 `providers.tsx` 那句
     * `if (reachable && authed) startSse()` 永远不成立：
     * **SSE 端点开着 200，前端却从不去连**，所有"实时"能力（转写逐段出字、
     * 下载进度、装完提示）全部静默失效 —— 而每个单独的端点测起来都是好的。
     *
     * 这是"删功能时留下的闸门"：开关翻了，但依赖这个开关的那道门没跟着翻。
     *
     * 修在 daemon 而不是前端加一句 `|| health.auth === 'none'`：
     * 不变量应该是**"鉴权关了握手就不该失败"**，而不是
     * **"每个调用方都要记得判断鉴权关没关"** —— 后者是在给未来每个新调用点
     * 埋同一个坑。CSRF 令牌照发，因为写请求那侧的双提交校验在鉴权关闭时也会跳过，
     * 发了无害，且前端不必为两种模式写两套流程。
     */
    if (!authRequired()) {
      const session = deps.sessions.create();
      res.setHeader('Set-Cookie', buildSessionCookie(session.sid));
      sendJson(res, 200, {
        csrf: session.csrf,
        csrfHeader: CSRF_HEADER,
        contractVersion: CONTRACT_VERSION,
        renewed: false,
        /** 让前端/诊断页能看出这是"鉴权已关"的握手，而不是误以为验过身份。 */
        authMode: 'none',
      });
      return;
    }

    if (hasBearer) {
      if (!deps.sessions.verifyBootToken(auth.slice(7))) {
        sendError(res, 401, 'UNAUTHENTICATED', 'invalid token', '启动令牌无效');
        return;
      }
      const session = deps.sessions.create();
      res.setHeader('Set-Cookie', buildSessionCookie(session.sid));
      sendJson(res, 200, {
        csrf: session.csrf,
        csrfHeader: CSRF_HEADER,
        contractVersion: CONTRACT_VERSION,
        renewed: false,
      });
      return;
    }

    // 无 Bearer：只要 cookie 指向一个仍然有效的会话，就把它的 CSRF 令牌发回去
    const viaCookie = authenticate(req, deps.sessions);
    if (viaCookie.ok && viaCookie.via === 'cookie' && viaCookie.session) {
      // 顺手续一次 cookie，避免它比会话先过期
      res.setHeader('Set-Cookie', buildSessionCookie(viaCookie.session.sid));
      sendJson(res, 200, {
        csrf: viaCookie.session.csrf,
        csrfHeader: CSRF_HEADER,
        contractVersion: CONTRACT_VERSION,
        /** 告诉前端这是续签而非新建，便于它区分"新标签自愈"和"首次握手"。 */
        renewed: true,
      });
      return;
    }

    /*
     * 两者都没有 → 只能让用户拿回启动令牌。
     * 这里必须给**可执行的**指引：用户看不到 daemon 的终端时，
     * "请重新打开应用"是句废话（他打开的还是同一个没有 token 的地址）。
     */
    sendError(
      res,
      401,
      'UNAUTHENTICATED',
      'no bearer token and no valid session cookie',
      '尚未建立会话，且没有可续签的登录状态。请从 daemon 启动横幅里那条带 #t= 的完整链接重新打开一次。',
      {
        retryable: false,
        remediation: {
          action: 'openHandoffUrl',
          params: { hint: 'daemon 启动日志中的 http://<host>:<port>/#t=<token>' },
          label: 'Reopen the handoff URL',
          labelZh: '用启动链接重新打开',
        },
      },
    );
    return;
  }

  /*
   * ---- 鉴权闸门 ----
   *
   * `OPENMEMO_AUTH=none`（**默认**）时整段跳过 —— 用户显式决定，见 `auth.ts` 的 `AUTH_MODE` 注释。
   *
   * ⚠️ 跳过的是**鉴权与 CSRF**，**不包括** Host / Origin 校验：
   * 那两条在上游已经跑过，且它们挡的是 DNS rebinding 与跨站请求 ——
   * **与"有没有凭据"无关**，零成本，没有理由一起关掉。
   */
  const auth = authRequired()
    ? authenticate(req, deps.sessions)
    : ({ ok: true, via: 'disabled' } satisfies AuthResult);
  if (!auth.ok) {
    /*
     * 文案要**可执行**。原来写"请重新打开应用"——用户根本不知道该重新打开什么：
     * 前端握手时已经把 URL 里的 token 抹掉了（防截图泄露），地址栏里那串没了，
     * 他"重新打开"的还是同一个没有 token 的地址，于是永远转不出来。
     * 现在直接告诉他会话过期、点重新连接，并给出 retryable 让前端能自动重试握手。
     */
    sendError(
      res,
      401,
      'UNAUTHENTICATED',
      auth.reason,
      '会话已过期或尚未建立。点击「重新连接」即可，无需重启应用。',
      { retryable: true },
    );
    return;
  }
  // 无鉴权时 CSRF 无意义：它防的是"攻击页借用你已有的凭据"，而凭据根本不存在。
  // Host / Origin 校验**不在此列**，它们在上游已跑过、挡的是与凭据无关的威胁。
  const csrf = authRequired()
    ? checkCsrfDetailed(req, auth)
    : ({ ok: true, via: 'disabled' } satisfies CsrfOutcome);
  if (csrf.ok && csrf.via === 'same-origin-fallback') {
    /*
     * **info，不是 warn** —— 这是裁决允许的预期路径，不是异常。
     * 但必须留痕：`architect` 正在修根因（前端 sessionStorage 不可用时静默丢 CSRF 头），
     * 根因修好后这条应该基本不出现。**如果它天天刷屏，就说明根因没修好** ——
     * 这条日志的唯一用途就是让我们发现"兜底变成了常态"。
     */
    console.info(
      `[auth] CSRF 同源兜底放行：${req.method} ${path}（无 CSRF 头，Origin 与 Host 严格同源）`,
    );
  }
  if (!csrf.ok) {
    /*
     * ★ 这条必须**可恢复且说得清**，否则表现为"页面正常、保存悄悄失败"。
     *
     * 实测：持有有效 cookie 但缺 CSRF 头时，**读全部 200、写全部 403** ——
     * 用户填完 API Key 点保存，界面看不出异常，库里却一行没有。
     * 而前端在 sessionStorage 不可用时会主动降级成"不带 CSRF 头"
     * （它注释里写的是"由 Origin 校验兜底"，但服务端并没有这个兜底 —— 契约对不上）。
     *
     * 服务端不放宽校验，但要给出**明确的自救路径**：重新握手就能拿到新的 CSRF token。
     */
    sendError(
      res,
      403,
      'CSRF_FAILED',
      'missing or bad CSRF token',
      '写操作缺少 CSRF 令牌（读操作不受影响，所以页面看起来正常）。请重新连接以获取新令牌。',
      {
        retryable: true,
        remediation: {
          action: 'reauth',
          params: { endpoint: '/api/auth/session', method: 'POST' },
          label: 'Re-establish session',
          labelZh: '重新连接',
        },
      },
    );
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

  if (path === '/api/daemon/restart' && method === 'POST') {
    if (!deps.requestRestart) {
      sendError(res, 501, 'NOT_IMPLEMENTED', 'restart not wired', '当前构建不支持自我重启');
      return;
    }
    const body = (await readBody(req).catch(() => undefined)) as { reason?: unknown } | undefined;
    const reason = typeof body?.reason === 'string' ? body.reason : 'user-requested';
    // 先回 202，前端才能显示"正在重启"并等 SSE 重连；重启在响应之后发生
    sendJson(res, 202, {
      ok: true,
      reason,
      /** 重启后端口不变（新进程会在同一端口上等老进程退干净），前端可以直连原地址重试。 */
      port: deps.port(),
      hint: '重启中，SSE 会自动重连',
    });
    setTimeout(() => deps.requestRestart?.(reason), 50);
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

  /*
   * ★★ 落到这里 + 还没 ready ⇒ **503，不是 404。**
   *
   * 这一格就是 Windows 上那个用户可见的 404 的落点：路由表还没 push，
   * `POST /api/folders` 一路穿到这里，被告知"接口不存在" —— **那是假话**，
   * 它存在，只是还没挂上。调用方据此做的判断全是错的
   * （前端会认为版本不兼容，脚本会认为端点被删了）。
   *
   * 放在 404 **之前**、其余一切之后，是刻意选的位置：
   * 上面所有内联处理（health / 静态产物 / 会话握手 / models 路由）
   * 在 ready 之前本来就能正常工作，**这个门一个都不挡** ——
   * 于是"别把启动探测饿死"这条要求在结构上就成立，而不是靠逐条豁免。
   * 它只把**本来就要失败的那些请求**，从一句假话换成一句真话。
   */
  if (!(deps.ready?.() ?? true)) {
    res.setHeader('Retry-After', '1');
    sendError(
      res,
      503,
      'SERVICE_STARTING',
      `daemon is still starting; route table not mounted yet (${method} ${path})`,
      '服务正在启动，请稍候重试',
      /*
       * ★ `retryable: true`，而且必须显式给 —— `sendError` 的默认值是 `false`。
       *   `[本机实测]` 第一版没给，抓到的响应体里是 `"retryable":false`：
       *   一个**过几百毫秒就会自己好**的状态，却告诉调用方"重试没用"。
       *   那是把刚修好的那个谎换了个字段接着说。
       */
      { retryable: true },
    );
    return;
  }

  sendError(res, 404, 'NOT_FOUND', `no route for ${method} ${path}`, '接口不存在');
}
