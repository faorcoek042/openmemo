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
  readonly remediation: { action: string; params?: Record<string, unknown> } | null;

  constructor(status: number, body: Partial<ApiErrorBody['error']> & Record<string, unknown>) {
    super(String(body.message ?? `HTTP ${status}`));
    this.name = 'ApiError';
    this.status = status;
    this.code = String(body.code ?? `HTTP_${status}`);
    this.retryable = Boolean(body.retryable);
    this.details = body.details;
    this.serverMessage = String(body.message ?? '');
    this.serverMessageZh = String(body.messageZh ?? '');
    this.remediation =
      (body.remediation as { action: string; params?: Record<string, unknown> } | undefined) ?? null;
  }
}

function getCsrf(): string | null {
  try {
    return sessionStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setCsrf(token: string): void {
  try {
    sessionStorage.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    /* 隐私模式下 sessionStorage 不可用 → 降级为无 CSRF 头，由 Origin 校验兜底 */
  }
}

/**
 * 从 URL fragment 取出 daemon 交接的 token 并**立刻抹掉**。
 * 抹掉是为了防止 URL 被截图 / 分享 / 进浏览器历史记录。
 */
export function consumeHandoffToken(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /^#t=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!m) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1];
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
    if (isUnauthenticated(err) && (await reHandshake())) {
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
