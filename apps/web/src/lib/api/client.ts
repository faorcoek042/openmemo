/**
 * REST 客户端（D-05 §3.2 / D-01 §2.4、§3.5）。
 *
 * 三件事在这里收口：
 * 1. **token 交接**：daemon 启动时把 token 放在 URL fragment（`#t=…`）——
 *    fragment 不进 access log、不进 Referer。前端拿到后立刻 `replaceState` 抹掉，
 *    换成 HttpOnly cookie。**必须换 cookie**，因为 SSE / WS / `<audio src>`
 *    这三类通道都带不了 Authorization header（D-01 §2.4）。
 * 2. **错误信封**：`{error:{code,message,messageZh,retryable,details?}}`
 *    （以 `packages/shared` 的实现为准，D-01 §3.5 已订正）。
 * 3. **CSRF**：非 GET 请求带 `X-OpenMemo-CSRF`（双提交），配合服务端的 Host/Origin 校验。
 */

import type { ApiErrorBody } from '@openmemo/shared';

const CSRF_HEADER = 'X-OpenMemo-CSRF';
const CSRF_STORAGE_KEY = 'openmemo.csrf';

/** 前端统一的错误对象。`code` 是稳定字符串，UI 按它查本地文案表（D-05 §6.2）。 */
export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: unknown;
  /** 服务端给的文案。**只作未知 code 的兜底**，不作首选（D-05 §6.2）。 */
  readonly serverMessage: string;
  readonly serverMessageZh: string;
  /**
   * 机器可读的补救动作。ADR-007 决策 2 批准加入 `ApiErrorBody`，
   * 但 `packages/shared` 尚未落地 → 这里先按可选处理。
   */
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
    /* 隐私模式下 sessionStorage 可能不可用；降级为无 CSRF 头，由 Origin 校验兜底 */
  }
}

/**
 * 从 URL fragment 取出 daemon 交接的 token 并立刻抹掉。
 * 抹掉是为了防止 URL 被截图 / 分享 / 进历史记录。
 */
export function consumeHandoffToken(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  const m = /^#t=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1];
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** 幂等键：SSE 断线重连后前端可能重发，用户也会狂点按钮（D-01 §3.2 规则 3） */
  idempotencyKey?: string;
}

export type Fetcher = <T>(path: string, opts?: ApiOptions) => Promise<T>;

/** 真实 daemon 的 fetcher。基址为同 origin 的 `/api`（无 v1 段，D-01 §3.5 已订正）。 */
export const httpFetcher: Fetcher = async <T,>(path: string, opts: ApiOptions = {}): Promise<T> => {
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
};

/**
 * 当前生效的 fetcher。
 * daemon 尚未实现时由 `installMockApi()` 换成 mock —— **UI 上会显式标注 mock**。
 */
let active: Fetcher = httpFetcher;

export function setFetcher(f: Fetcher): void {
  active = f;
}

export function api<T>(path: string, opts?: ApiOptions): Promise<T> {
  return active<T>(path, opts);
}

/** 媒体 URL：走 `/media/asset/<uid>`，只接受 asset uid，绝不接受路径参数（D-01 §3.1/§8.5）。 */
export function mediaUrl(assetUid: string, variant?: string): string {
  const q = variant ? `?variant=${encodeURIComponent(variant)}` : '';
  return `/media/asset/${encodeURIComponent(assetUid)}${q}`;
}
