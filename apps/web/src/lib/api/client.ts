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

async function apiCall<T>(surface: Surface, path: string, opts?: ApiOptions): Promise<T> {
  const state = surfaceState(surface);

  // 已判定为假 → 直接走 mock，不再每次撞真接口（省掉一串 404 噪声）
  if (state === 'mock' || state === 'offline') {
    if (!mockFetcher) {
      throw new ApiError(503, { code: 'NO_BACKEND', message: 'daemon unreachable and no mock' });
    }
    return mockFetcher<T>(path, opts);
  }

  try {
    const out = await realFetch<T>(path, opts);
    if (state !== 'live') markSurface(surface, 'live');
    return out;
  } catch (err) {
    if (isNotImplemented(err) && mockFetcher) {
      // daemon 在跑，但这条路由还没实现 → 这个面回落 mock
      markSurface(surface, 'mock');
      return mockFetcher<T>(path, opts);
    }
    if (err instanceof TypeError && mockFetcher) {
      // fetch 抛 TypeError = 网络层失败 = daemon 没起
      markSurface(surface, 'offline');
      return mockFetcher<T>(path, opts);
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
