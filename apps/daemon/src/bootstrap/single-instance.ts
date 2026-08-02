/**
 * 单实例锁与端口选择（D-01 §2.2 / §2.3，ADR-006 决策 2）。
 *
 * **主锁 = 端口绑定本身。** 这是唯一「原子 + 进程死了自动释放」的机制。
 * lockfile 做不到 —— 崩溃后残留 stale lock 是经典故障。
 * `runtime.json` 只是元数据 sidecar，不承担互斥职责。
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ulid } from '@openmemo/shared';

/** ADR-006 决策 2：固定端口。不是审美偏好，见下方注释。 */
export const DEFAULT_PORT = 17650;
/** 冲突时的递增上限（D-01 §2.2 阶梯第 3 步）。 */
export const MAX_PORT = 17659;
export const BIND_HOST = '127.0.0.1';

/**
 * 为什么端口必须尽量稳定：浏览器的 localStorage / cookie / **麦克风授权**
 * 全部按 origin（scheme+host+port）隔离。端口一变，
 * **用户的麦克风授权要重新点一遍**（直接影响 F3 录音转文字）。
 * 所以端口漂移必须对用户**显式可见**，绝不静默。
 */
export interface RuntimeInfo {
  readonly schema: 1;
  readonly app: 'openmemo';
  readonly version: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly dataDir: string;
}

export interface AcquireResult {
  readonly kind: 'acquired';
  readonly server: Server;
  readonly port: number;
  readonly instanceId: string;
  /** 端口发生了漂移 —— UI 必须明确警告"麦克风需要重新授权"。 */
  readonly portDrifted: boolean;
  readonly requestedPort: number;
}

export interface ExistingResult {
  readonly kind: 'existing';
  readonly info: RuntimeInfo;
}

export interface ConflictResult {
  readonly kind: 'conflict';
  readonly reason: string;
}

export type BindOutcome = AcquireResult | ExistingResult | ConflictResult;

/** 尝试绑定单个端口。成功即持锁。 */
function tryBind(server: Server, port: number): Promise<'ok' | 'in-use'> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve('in-use');
      else reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve('ok');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // 只绑回环地址。ADR-003 安全硬要求：绝不 0.0.0.0，也不用 'localhost'
    // （'localhost' 在部分系统会解析到 :: 或外部网卡）。
    server.listen({ host: BIND_HOST, port, exclusive: true });
  });
}

/** 探测某端口上跑的是不是「我们自己」。 */
export async function probeExisting(
  port: number,
  timeoutMs = 1500,
): Promise<RuntimeInfo | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${BIND_HOST}:${port}/api/health`, { signal: ac.signal });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<RuntimeInfo> & { app?: string };
    return body.app === 'openmemo' ? (body as RuntimeInfo) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface AcquireOptions {
  readonly requestedPort?: number;
  readonly dataDir: string;
  /** 传入已建好的 server（这样调用方可以先挂好 request handler 再绑定）。 */
  readonly server: Server;
  readonly maxPort?: number;
}

/**
 * 获取单实例锁。
 *
 * 判定「已有实例」必须**同时**满足（D-01 §2.3）：
 *   端口被占 且 /api/health 返回我们的应用标识 且 dataDir 一致。
 * dataDir 不一致 = 用户想跑第二个 profile → v1 不支持，明确报错。
 */
export async function acquireSingleInstance(opts: AcquireOptions): Promise<BindOutcome> {
  const requested = opts.requestedPort ?? DEFAULT_PORT;
  const maxPort = opts.maxPort ?? MAX_PORT;

  for (let port = requested; port <= maxPort; port++) {
    const outcome = await tryBind(opts.server, port);
    if (outcome === 'ok') {
      return {
        kind: 'acquired',
        server: opts.server,
        port,
        instanceId: ulid(),
        portDrifted: port !== requested,
        requestedPort: requested,
      };
    }

    // 端口被占：是我们自己吗？
    const existing = await probeExisting(port);
    if (existing) {
      if (existing.dataDir === opts.dataDir) {
        return { kind: 'existing', info: existing };
      }
      return {
        kind: 'conflict',
        reason:
          `端口 ${port} 被另一个数据目录的 OpenMemo 实例占用` +
          `（对方 dataDir=${existing.dataDir}，本次 dataDir=${opts.dataDir}）。` +
          `v1 不支持多 profile 并存，请用 --port 指定其它端口。`,
      };
    }
    // 是别人的服务 → 继续往下扫
  }

  return {
    kind: 'conflict',
    reason: `端口 ${requested}..${maxPort} 全部被占用，无法启动。请用 --port 指定其它端口。`,
  };
}

export function writeRuntimeJson(path: string, info: RuntimeInfo): void {
  mkdirSync(dirname(path), { recursive: true });
  // 0600：token 在里面，只有属主可读
  writeFileSync(path, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
}

export function readRuntimeJson(path: string): RuntimeInfo | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeInfo;
  } catch {
    return undefined;
  }
}

export function removeRuntimeJson(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* 退出路径上的清理失败不值得让进程崩掉 */
  }
}

/** 建一个尚未绑定的 http server（调用方挂 handler 后交给 acquireSingleInstance）。 */
export function createUnboundServer(): Server {
  return createServer();
}
