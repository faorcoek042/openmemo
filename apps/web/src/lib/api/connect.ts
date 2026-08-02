/**
 * daemon 连接与鉴权握手（D-01 §2.4）。
 *
 * 顺序（每一步都可能失败，失败不阻断其余功能）：
 *   1. GET /api/health          —— **公开**，不需要鉴权。确认 daemon 在跑 + 契约版本一致
 *   2. 从 URL fragment 取 token —— daemon 启动时放的 `#t=…`，取完立刻抹掉 URL
 *   3. POST /api/auth/session   —— Bearer token 换 HttpOnly cookie + CSRF token
 *   4. 打开 SSE                 —— cookie 已就位，EventSource 才能带上鉴权
 *
 * 为什么必须换 cookie：SSE / WebSocket / `<audio src>` 这三类通道
 * **都带不了 Authorization header**，cookie 是唯一同时覆盖它们的方案（D-01 §2.4）。
 */

import { CONTRACT_VERSION } from '@openmemo/shared';

import { consumeHandoffToken, rawFetch, setCsrf } from './client';
import { markSurface, useSurfaceStore } from './surfaces';
import { useConnectionStore } from '../stores/connection.store';

export interface HealthResponse {
  app: string;
  version: string;
  instanceId: string;
  contractVersion: number;
  dataDir: string;
  host: string;
  port: number;
  pid: number;
}

export interface ConnectResult {
  reachable: boolean;
  authed: boolean;
  health: HealthResponse | null;
  /** 契约版本不一致 —— 静默不匹配比崩溃更糟，必须阻断并提示刷新 */
  contractMismatch: boolean;
}

export async function connectToDaemon(): Promise<ConnectResult> {
  const store = useSurfaceStore.getState();

  // ── 1. health（公开端点，不带鉴权）──
  let health: HealthResponse | null = null;
  try {
    const res = await rawFetch('/api/health', { method: 'GET' });
    if (res.ok) {
      health = (await res.json()) as HealthResponse;
      markSurface('health', 'live');
      store.setHealth({
        version: health.version,
        instanceId: health.instanceId,
        contractVersion: health.contractVersion,
        dataDir: health.dataDir,
        port: health.port,
        pid: health.pid,
      });
    } else {
      markSurface('health', 'offline');
    }
  } catch {
    // daemon 没起 —— 这是开发期的常态，不是错误
    markSurface('health', 'offline');
    return { reachable: false, authed: false, health: null, contractMismatch: false };
  }

  if (!health) {
    return { reachable: false, authed: false, health: null, contractMismatch: false };
  }

  // ── 契约版本校验（D-05 §2.3）：不匹配就阻断，不要"尽力而为"地跑下去 ──
  if (health.contractVersion !== CONTRACT_VERSION) {
    useConnectionStore
      .getState()
      .setContractMismatch({ web: CONTRACT_VERSION, daemon: health.contractVersion });
    return { reachable: true, authed: false, health, contractMismatch: true };
  }

  // ── 端口漂移检测（ADR-006 决策 2）：麦克风授权按 origin 隔离，端口变了要重新授权 ──
  const expected = 17650;
  if (health.port !== expected) {
    useConnectionStore.getState().setPortDrift({ expected, actual: health.port });
  }

  // ── 2 & 3. token → cookie ──
  let authed = false;
  const token = consumeHandoffToken();
  try {
    const res = await rawFetch('/api/auth/session', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (res.ok) {
      const body = (await res.json()) as { csrf: string };
      setCsrf(body.csrf);
      authed = true;
      markSurface('auth', 'live');
    } else {
      // 401 = 没 token 或 token 无效。常见于用户手敲 URL 打开页面。
      markSurface('auth', 'offline');
    }
  } catch {
    markSurface('auth', 'offline');
  }

  useSurfaceStore.getState().setAuthed(authed);
  return { reachable: true, authed, health, contractMismatch: false };
}
