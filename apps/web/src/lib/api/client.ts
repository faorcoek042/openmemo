/**
 * REST 客户端（D-05 §3.2 / D-01 §2.4、§3.5）。
 *
 * ## T-029 的核心改动：**按面（surface）自动切换真/假**
 *
 * 每次调用要声明它属于哪个 surface。第一次调用先打真 daemon：
 * - 成功 → 该面标 `live`，之后一直走真接口；
 * - 404/501（`oss-scout` 还没实现这条路由）→ 该面标 `mock`，回落内存实现；
 * - 连不上 → 该面标 `offline`，同样回落，但 UI 提示不同（"本地服务未启动"）。
 *
 * 于是 **daemon 每接通一个端点，前端自动切过去，这边一行代码都不用改。**
 * 这是"靠契约对齐、别互相等"的具体落地。
 *
 * ## 其余三件事仍在这里收口
 * 1. token 交接（fragment → cookie，握手在 connect.ts）
 * 2. 错误信封 `{error:{code,message,messageZh,retryable,…}}`
 * 3. CSRF：非 GET 带 `X-OpenMemo-CSRF`（双提交），配合服务端 Host/Origin 校验
 */

import type { ApiErrorBody } from '@openmemo/shared';

import { markSurface, surfaceState, type Surface } from './surfaces';

const CSRF_HEADER = 'X-OpenMemo-CSRF';
const CSRF_STORAGE_KEY = 'openmemo.csrf';

/** 前端统一的错误对象。`code` 是稳定字符串，UI 按它查本地文案表（D-05 §6.2）。 */
export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: unknown;
  /** 服务端文案。**只作未知 code 的兜底**，不作首选（ADR-007 决策 3）。 */
  readonly serverMessage: string;
  readonly serverMessageZh: string;
  /**
   * 服务端给的机器可读补救动作（ADR-007 决策 2）。
   *
   * ⚠️ T-140 修：这里原本**只留 `action` 和 `params`，把 `labelZh`/`label` 扔了**。
   * daemon 15 个发出点每一个都写了中文按钮文案（"查看如何支持该站点" /
   * "去接受许可" / "直接使用此目录"…），信封里也确实带着，
   * 在这一行被解析掉 —— 于是就算 UI 渲染出按钮，按钮上也没有服务端那句话。
   * 一句"后端最清楚缺的是什么"的文案，在离终点一行的地方丢掉了。
   */
  readonly remediation: {
    action: string;
    params?: Record<string, unknown>;
    labelZh?: string;
    label?: string;
  } | null;

  constructor(status: number, body: Partial<ApiErrorBody['error']> & Record<string, unknown>) {
    super(String(body.message ?? `HTTP ${status}`));
    this.name = 'ApiError';
    this.status = status;
    this.code = String(body.code ?? `HTTP_${status}`);
    this.retryable = Boolean(body.retryable);
    this.details = body.details;
    this.serverMessage = String(body.message ?? '');
    this.serverMessageZh = String(body.messageZh ?? '');
    // 不加类型断言：`ApiErrorBody['error'].remediation` 就是 `Remediation`，
    // 而 `Remediation` 结构上就是上面那个更宽的形状（规矩 5：把契约交给编译器守）
    this.remediation = body.remediation ?? null;
  }
}

/**
 * CSRF 令牌的**权威副本在内存里**。
 *
 * ## 这一行改动对应一次真实事故
 *
 * 原实现把令牌**只**写进 `sessionStorage`，写失败就 `catch {}` 吞掉，
 * 注释写着「降级为无 CSRF 头，**由 Origin 校验兜底**」——
 * **服务端并没有这个兜底，它是硬拒**：持有效 cookie 但不带 CSRF 头时，
 * GET 200、而 PATCH/PUT 全部 403。
 *
 * 于是现象是：界面一切正常（读全通），**所有保存静默失败**，库里 0 行。
 * 用户设了 DeepSeek key，什么都没存下来，而屏幕上没有任何异常。
 *
 * 两个错叠在一起，缺一不可：
 * 1. **假设了一个对端并不存在的兜底** —— 降级的前提是我方单方面想象出来的；
 * 2. **降级是静默的** —— 没有任何一层把"我没带令牌"这件事说出来。
 *
 * 修法不是给 `sessionStorage` 加重试，而是**根本不该依赖它**：
 * CSRF 令牌的生命周期就是"本页这次会话"，**内存变量完全够用**，
 * 它不需要跨标签共享（每个标签各自握手），也不需要跨进程持久化。
 * `sessionStorage` 降级为**可选加速**（刷新后省一次握手），
 * 存不进去只是少一点便利，**不再影响正确性**。
 */
let csrfToken: string | null = null;

function getCsrf(): string | null {
  if (csrfToken !== null) return csrfToken;
  // 内存里没有才去看缓存：刷新后能直接复用，省一次握手往返
  try {
    const cached = sessionStorage.getItem(CSRF_STORAGE_KEY);
    if (cached) csrfToken = cached;
  } catch {
    /* 无痕模式 / 存储被策略拦截：不影响正确性，内存那份才是权威 */
  }
  return csrfToken;
}

export function setCsrf(token: string): void {
  // ★ 先写内存 —— 这一步不会失败，也就不存在"令牌丢了还继续发请求"
  csrfToken = token;
  try {
    sessionStorage.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    /* 可选加速失败而已，令牌已在内存中，写操作照常带头 */
  }
}

export function clearCsrf(): void {
  csrfToken = null;
  try {
    sessionStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}

/** 供诊断页 / 测试查询令牌是否就位 —— **不回显令牌本身**。 */
export function hasCsrf(): boolean {
  return getCsrf() !== null;
}

/**
 * 从 URL fragment 取出 daemon 交接的 token 并**立刻抹掉**。
 * 抹掉是为了防止 URL 被截图 / 分享 / 进浏览器历史记录。
 */
/**
 * 交接 token 在**模块加载时同步抓取**，而不是等握手时再读。
 *
 * ## 为什么必须同步
 *
 * 原实现在 `connectToDaemon()` 里读 hash，而那之前有一个
 * `await rawFetch('/api/health')` —— 一次**真实网络往返**。
 * 而 react-router 首屏会**同步**地 `replaceState` 重定向
 * （新用户 `/` → `/onboarding`），把 `#t=…` 一起抹掉。
 *
 * **同步的重定向必然赢过排在 await 后面的读取** —— 这不是竞态，是必然：
 * 新用户 100% 丢 token，而且 URL 里再无副本，**刷新和重开浏览器都救不回来**。
 *
 * 所以捕获必须发生在任何路由代码运行之前 —— 模块顶层求值是最早的同步时机。
 */
const HANDOFF_TOKEN: string | null = (() => {
  if (typeof window === 'undefined') return null;
  const m = /^#t=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!m) return null;
  // 立刻抹掉，避免 token 停留在地址栏 / 被写进浏览器历史
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1] ?? null;
})();

/** 取模块加载时抓到的交接 token（幂等，可重复调用）。 */
export function consumeHandoffToken(): string | null {
  return HANDOFF_TOKEN;
}

/** 裸 fetch：不做 surface 记账，供 connect.ts 的握手阶段使用。 */
export function rawFetch(path: string, init?: RequestInit): Promise<Response> {
  const h = new Headers(init?.headers);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCsrf();
    if (csrf) h.set(CSRF_HEADER, csrf);
  }
  return fetch(path, { ...init, headers: h, credentials: 'same-origin' });
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** 幂等键：SSE 重连后前端可能重发，用户也会狂点按钮（D-01 §3.2 规则 3） */
  idempotencyKey?: string;
}

export type Fetcher = <T>(path: string, opts?: ApiOptions) => Promise<T>;

/** 打真 daemon。 */
async function realFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { body, idempotencyKey, headers, ...rest } = opts;
  const method = (rest.method ?? 'GET').toUpperCase();

  const h = new Headers(headers);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCsrf();
    if (csrf) h.set(CSRF_HEADER, csrf);
    if (idempotencyKey) h.set('Idempotency-Key', idempotencyKey);
  }

  const res = await fetch(`/api${path}`, {
    ...rest,
    method,
    headers: h,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let parsed: Record<string, unknown> = {};
    try {
      const json = (await res.json()) as { error?: Record<string, unknown> };
      parsed = json.error ?? {};
    } catch {
      /* 非 JSON 错误体（如反向代理返回的 HTML），走默认 code */
    }
    throw new ApiError(res.status, parsed);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** mock 回落实现，由 mock.ts 注册。 */
let mockFetcher: Fetcher | null = null;

export function registerMockFetcher(f: Fetcher): void {
  mockFetcher = f;
}

/** 这个错误是否说明"路由还没实现"，而不是业务错误。 */
function isNotImplemented(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return (
    err.status === 404 ||
    err.status === 501 ||
    err.code === 'NOT_FOUND' ||
    err.code === 'NOT_IMPLEMENTED'
  );
}

/**
 * 主入口。
 *
 * 两种调用形式（**都支持，且不含糊**：surface 名不以 `/` 开头，路径一定以 `/` 开头）：
 *
 * ```ts
 * api<T>('notes', '/notes')   // 推荐：声明所属 surface，参与按面真假切换与 UI 状态展示
 * api<T>('/notes')            // 兼容：不声明，按 'notes' 之外的通用面处理
 * ```
 *
 * 保留第二种形式是为了**不打断并行开发** —— `features/models` 与 `features/runtime`
 * 归 `model-mgmt`，我不能替他改文件。他按自己的节奏加 surface 参数即可，
 * 在那之前这些调用照常工作（只是不出现在"已接通/模拟"统计里）。
 */
export async function api<T>(path: string, opts?: ApiOptions): Promise<T>;
export async function api<T>(surface: Surface, path: string, opts?: ApiOptions): Promise<T>;
export async function api<T>(
  a: Surface | string,
  b?: string | ApiOptions,
  c?: ApiOptions,
): Promise<T> {
  // 路径一定以 '/' 开头，surface 名一定不以 '/' 开头 —— 据此区分两种重载
  const hasSurface = typeof a === 'string' && !a.startsWith('/');
  const surface = (hasSurface ? (a as Surface) : 'generic') as Surface;
  const path = hasSurface ? (b as string) : (a as string);
  const opts = (hasSurface ? c : (b as ApiOptions | undefined)) ?? undefined;

  return apiCall<T>(surface, path, opts);
}

/**
 * 端点级的"这条路由不存在"记账。
 *
 * ## 为什么不能按 surface 记（这是一次真实事故的根因）
 *
 * 原来的实现是：任何一条 404 就把**整个 surface** 标成 mock，之后该面所有调用
 * 直接走内存实现、**一个网络请求都不发**。
 *
 * 真浏览器实测的症状是：星标 / 标签 / 段落编辑「渲染是绿的，点了没用，
 * 抓包一个非 GET 请求都没有」。而 daemon 侧这三个端点直连全部 200 且真落库。
 *
 * 根因：`PATCH /notes/:uid/mindmap` 不存在（daemon 只有 GET/POST）→ 一个 404 →
 * **整个 `notes` 面被毒化** → 星标、标签、段落编辑全部改走 mock。
 * 一条缺失的路由，废掉了同面所有功能。
 *
 * 我在 D-08 §4.5 里预测过这个失败模式，但没修。这次修掉。
 */
const missingEndpoints = new Set<string>();

/** 记账键：方法 + 路径模板（把 ULID / 数字段位归一化，避免每个 uid 各记一条）。 */
function endpointKey(method: string, path: string): string {
  const template = path
    .split('?')[0]!
    .replace(/\/[0-9A-HJKMNP-TV-Z]{26}(?=\/|$)/g, '/:uid')
    .replace(/\/\d+(?=\/|$)/g, '/:n');
  return `${method} ${template}`;
}

/** 供诊断页/测试查看当前被判定为"未实现"的端点。 */
export function missingEndpointList(): string[] {
  return [...missingEndpoints].sort();
}

/** 端点恢复（例如 daemon 升级后补上了路由）。 */
export function forgetMissingEndpoints(): void {
  missingEndpoints.clear();
}

/**
 * 握手闸门与 401 自愈。
 *
 * `connect.ts` 反过来要用 `rawFetch`，静态 import 会成环 —— 用惰性 import 打破。
 */
async function gate(): Promise<void> {
  const { ensureConnected } = await import('./connect');
  await ensureConnected().catch(() => undefined); // 握手失败不阻断：让请求自己去报真实错误
}

async function reHandshake(): Promise<boolean> {
  const { resetConnection } = await import('./connect');
  const r = await resetConnection().catch(() => null);
  return Boolean(r?.authed);
}

function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.code === 'UNAUTHENTICATED');
}

/**
 * CSRF 校验失败 —— 与 401 **同一形状**：都是"凭证过期了，重新握手就能好"。
 *
 * 之所以要单独认这个 code：403 本身还可能是 `FORBIDDEN_ORIGIN` 那类**重握手也没用**的拒绝，
 * 全部当成可自愈会变成无意义的重试循环。
 * `oss-scout` 已给这条加了 `retryable:true` + `remediation{action:'reauth'}`，两边对齐。
 */
function isCsrfFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 403 && (err.code === 'CSRF_FAILED' || err.remediation?.action === 'reauth');
}

async function apiCall<T>(surface: Surface, path: string, opts?: ApiOptions): Promise<T> {
  const method = (opts?.method ?? 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const key = endpointKey(method, path);

  /**
   * ★ 写操作**永不静默回落 mock**。
   *
   * 读操作回落 mock 只是"显示了假数据"，界面上有 MockNotice 标着；
   * 而写操作回落 mock 会让用户以为**改动保存了**，实际什么都没发生 ——
   * 这比报错糟糕得多。所以写必须要么真成功、要么把错误抛给用户看见。
   */
  if (!isWrite && missingEndpoints.has(key)) {
    if (!mockFetcher) {
      throw new ApiError(503, { code: 'NO_BACKEND', message: 'daemon unreachable and no mock' });
    }
    return mockFetcher<T>(path, opts);
  }

  // ★ 等握手完成再发请求 —— 首屏的每个 query 都比握手快，不等就是必然 401
  await gate();

  /*
   * ★ **令牌不在手上就不发写请求** —— 明知会 403 还发，是这次事故的形状。
   *
   * 最常见的触发路径不是"storage 坏了"，而是**开了第二个标签页**：
   * cookie 是 **per-origin**（跨标签共享），而 CSRF 令牌是 **per-tab** ——
   * 新标签里 cookie 有效所以**读全通**，却没有令牌所以**写全 403**。
   * 两半凭证存放范围不一致，界面就表现为"看起来登录着、但什么都保存不了"。
   *
   * 这里先补一次握手再发。补不上也照发 ——
   * 让服务端给出**真实拒绝**并走下面的自愈/报错分支，
   * 而不是我们自己在本地判定失败：本地判定会掩盖"其实服务端允许"的情况。
   */
  if (isWrite && !hasCsrf()) await reHandshake();

  try {
    const out = await realFetch<T>(path, opts);
    // 真接通了：既清掉该端点的"缺失"记录，也把该面标成 live
    missingEndpoints.delete(key);
    if (surfaceState(surface) !== 'live') markSurface(surface, 'live');
    return out;
  } catch (err) {
    /**
     * ★ 401 自愈：daemon 重启会换 token、cookie 也可能过期。
     * 这时应该**自己重新握手再试一次**，而不是让用户去猜"重新打开应用"是什么意思。
     * 只重试一次，避免握手本身失败时打转。
     */
    /*
     * 401 / CSRF-403 自愈：重新握手一次再试。
     * 403 这条是本次事故的收尾 —— 令牌丢了或过期了，用户不该被要求"重新打开应用"。
     * 只重试一次：握手本身失败时不打转，把错误如实抛给 UI，由它给可点的动作。
     */
    if ((isUnauthenticated(err) || isCsrfFailure(err)) && (await reHandshake())) {
      const out = await realFetch<T>(path, opts);
      missingEndpoints.delete(key);
      markSurface(surface, 'live');
      return out;
    }
    if (isNotImplemented(err)) {
      // 只记这一条端点，**不再牵连同面的其它端点**
      missingEndpoints.add(key);
      if (!isWrite && mockFetcher) {
        markSurface(surface, 'mock');
        return mockFetcher<T>(path, opts);
      }
      throw err; // 写操作：如实报错，让用户知道没保存成功
    }
    if (err instanceof TypeError) {
      // 网络层失败 = daemon 没起。这是整机状态，按面记没问题
      markSurface(surface, 'offline');
      if (!isWrite && mockFetcher) return mockFetcher<T>(path, opts);
      throw new ApiError(503, {
        code: 'DAEMON_UNREACHABLE',
        message: 'local service unreachable',
        messageZh: '连不上本地服务，改动未保存',
        retryable: true,
      });
    }
    throw err;
  }
}

/**
 * 媒体 URL：走 `/media/asset/<uid>`，只接受 asset uid，绝不接受路径参数
 * （D-01 §3.1 / §8.5 —— 这从根上消灭路径穿越）。
 */
export function mediaUrl(assetUid: string, variant?: string): string {
  const q = variant ? `?variant=${encodeURIComponent(variant)}` : '';
  return `/media/asset/${encodeURIComponent(assetUid)}${q}`;
}
