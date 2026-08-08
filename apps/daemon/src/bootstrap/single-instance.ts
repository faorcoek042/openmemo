/**
 * 单实例锁与端口选择（D-01 §2.2 / §2.3，ADR-006 决策 2）。
 *
 * **主锁 = 端口绑定本身。** 这是唯一「原子 + 进程死了自动释放」的机制。
 * lockfile 做不到 —— 崩溃后残留 stale lock 是经典故障。
 * `runtime.json` 只是元数据 sidecar，不承担互斥职责。
 */
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ulid } from '@openmemo/shared';

import { tlsEnabled } from './tls.js';

/** ADR-006 决策 2：固定端口。不是审美偏好，见下方注释。 */
export const DEFAULT_PORT = 17650;
/** 冲突时的递增上限（D-01 §2.2 阶梯第 3 步）。 */
export const MAX_PORT = 17659;

/**
 * 监听地址。**默认 `127.0.0.1` —— 这个默认值不会因为任何配置而改变**（ADR-003）。
 *
 * 仅当用户**显式**设置 `OPENMEMO_HOST` 时才改变绑定地址。
 * 典型场景：机器在 NAT 之后、只有特定端口能从外部访问，回环地址根本够不着。
 *
 * ⚠️ 设成非回环地址意味着**同网段任何设备都能打到这个端口**，
 * 此时唯一的访问控制是 token。启动横幅会就此显式告警（见 main.ts）。
 * Host 头仍然只接受 IP 字面量、拒绝一切域名，所以 DNS rebinding 防护**不受影响**。
 */
export const BIND_HOST = process.env['OPENMEMO_HOST']?.trim() || '127.0.0.1';

/** 自探测/单实例握手一律走回环，与对外绑定地址无关（`0.0.0.0` 不是可连接地址）。 */
export const PROBE_HOST = '127.0.0.1';

/** 是否绑定在非回环地址 —— 用于启动告警与 Host 校验的日志说明。 */
export const IS_PUBLIC_BIND = BIND_HOST !== '127.0.0.1' && BIND_HOST !== '::1';

/**
 * 内核**实际**绑定到的地址（`server.address().address`）。
 *
 * 为什么不直接用 `BIND_HOST`：那只是我们**请求**的地址。`/api/health` 的 `host`
 * 字段是安全结论的输入（谁在读它判断"是不是只绑回环"），所以要报实际发生的事，
 * 不是报意图。UNIX 域套接字 / Windows 命名管道下 `address()` 返回路径字符串，
 * 那种情形根本没有"主机"，返回 null 让调用方自己兜底而不是编一个。
 */
export function boundAddress(server: Server): string | null {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') return null;
  return addr.address.length > 0 ? addr.address : null;
}

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

/** 同步小睡。锁的获取是同步 API，这里不能用 await。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
    // 走回环而非 BIND_HOST：`0.0.0.0` 是绑定通配符、不是可连接地址。
    /*
     * 协议必须跟着实际监听走：开了 TLS 还用 http:// 探测会永远失败，
     * 于是单实例判定误以为"端口上没有我们的实例"，可能把用户的数据目录抢过来。
     * 自签证书对**自己探自己**没有校验意义，所以显式放行（仅限回环这一跳）。
     */
    const scheme = tlsEnabled() ? 'https' : 'http';
    const prevReject = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    if (scheme === 'https') process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    let res: Response;
    try {
      res = await fetch(`${scheme}://${PROBE_HOST}:${port}/api/health`, { signal: ac.signal });
    } finally {
      if (scheme === 'https') {
        if (prevReject === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
        else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prevReject;
      }
    }
    /*
     * ★★ **503 也算"是我们自己"** —— 这一条不能少，少了会让用户重新授权麦克风。
     *
     * 2026-08-08 起 `/api/health` 在路由表装完之前回 **503 + `ready:false`**
     * （见 `http/server.ts` 的 `ServerDeps.ready`：一个在路由还没挂上时就答 200 的
     * 就绪信号本身就是在说谎）。
     *
     * 这里原本是 `if (!res.ok) return undefined`。**如果就这么放着，改动会引入一个
     * 比它修的那个更坏的 bug**：
     *   实例 A 正在启动（health 503）→ 实例 B 起来，绑端口撞 EADDRINUSE
     *   → 探测 A → `!res.ok` → 判定「端口上不是我们的服务」
     *   → `acquireSingleInstance` 的循环走「是别人的服务 → 继续往下扫」
     *   → **静默漂到 17651**。
     * 而端口漂移的代价就写在本文件开头：**浏览器按 origin 隔离麦克风授权，
     * 端口一变用户要重新点一次授权**，直接影响 F3 录音转文字。
     *
     * 判据因此不是「HTTP 状态码好不好看」，是「**这个端口上蹲着的是不是一个
     * OpenMemo 实例**」—— 而那个问题的答案在 body 的 `app` 字段里，不在状态码里。
     * 启动中的实例**同样占着这个端口**，对调用方来说结论完全一样。
     *
     * 只接受 200 与 503 两种：其余状态码（404 / 500 / 代理的 502…）说明
     * 那头要么不是我们，要么是坏的，不该被当成"已有实例"。
     */
    if (res.status !== 200 && res.status !== 503) return undefined;
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
  /**
   * 请求的端口被占时，**先原地重试多久**再考虑顺延。
   *
   * 用于**自我重启**：新进程起来时老进程可能还在收尾，端口要过一会儿才释放。
   * 这时绝不能顺延到下一个端口 —— 浏览器的麦克风授权按 origin 隔离，
   * 端口一变用户就得重新授权一次（ADR-006 决策 2）。为了一次重启把授权弄丢，
   * 比多等几秒糟糕得多。
   */
  readonly waitForPortMs?: number;
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
  /*
   * 扫描窗口是**相对请求端口**的，不是写死到 MAX_PORT。
   *
   * 写死会有一个很蠢的故障：`--port 17660` 时范围变成 `17660..17659`（空区间），
   * 循环一次都不跑，直接报"全部被占用" —— 而实际上那个端口是空的。
   * 这是我自己踩到的，只有在显式指定高于默认上限的端口时才会出现。
   */
  const span = MAX_PORT - DEFAULT_PORT;
  const maxPort = opts.maxPort ?? Math.max(requested + span, MAX_PORT);

  // 自我重启路径：先在**同一个端口**上等老进程退干净，等不到再走顺延阶梯
  const waitMs = opts.waitForPortMs ?? 0;
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const outcome = await tryBind(opts.server, requested);
      if (outcome === 'ok') {
        return {
          kind: 'acquired',
          server: opts.server,
          port: requested,
          instanceId: ulid(),
          portDrifted: false,
          requestedPort: requested,
        };
      }
      // 端口上如果已经有一个**健康的、同 dataDir 的**实例，说明不是"老进程没退干净"，
      // 而是真的已经有人在跑 —— 立刻走正常判定，不要傻等
      const existing = await probeExisting(requested, 500);
      if (existing && existing.dataDir === opts.dataDir) {
        return { kind: 'existing', info: existing };
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

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

/**
 * 建一个尚未绑定的 server（调用方挂 handler 后交给 acquireSingleInstance）。
 *
 * 传了 `tls` 就是 HTTPS。**默认仍是明文** —— 回环本来就是 secure context，
 * 不该给所有人默认加上证书信任成本。
 */
export function createUnboundServer(tls?: { key: string; cert: string }): Server {
  return tls
    ? (createHttpsServer({ key: tls.key, cert: tls.cert }) as unknown as Server)
    : createServer();
}

/**
 * **数据目录级互斥锁**（D-01 §2.3 第二道）。
 *
 * 端口绑定只挡住"同端口"的第二个实例。**换个端口起第二个、指向同一个 dataDir**，
 * 端口锁完全不生效 —— 而 `recoverOnStartup()` 会把第一个实例**正在跑**的 job
 * 无条件拉回 `queued`，两个实例于是同时跑同一个任务、写同一个库。
 *
 * 这里用 `O_CREAT|O_EXCL` 独占创建一个 lock 文件补上这道。
 * 选它而不是 `flock(2)`：Node 标准库没有 flock，且 `O_EXCL` 在 Windows 上语义一致。
 * 代价是**进程崩溃会留下 stale lock**，所以锁文件里记 pid，启动时校验：
 * pid 不存在就认定是 stale 并接管（这正是端口锁天然免疫、而文件锁必须自己处理的问题）。
 */
export interface DataDirLock {
  release(): void;
}

export class DataDirLockedError extends Error {
  constructor(
    readonly holderPid: number,
    readonly path: string,
  ) {
    super(
      `另一个 OpenMemo 实例（pid ${holderPid}）正在使用同一个数据目录。` +
        `同一个数据目录只能有一个实例，否则任务会被互相抢走、数据库会被并发写坏。`,
    );
    this.name = 'DataDirLockedError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但不属于我们 → 仍算存活
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * @param handoverWaitMs 前任还在收尾时，**最多等多久再判定"已有实例"**。
 *
 * 只有**自我重启拉起的接班进程**会传它（见 main.ts 的 restart）。
 * 不传 = 0 = 行为与从前完全一致：撞上活着的持有者立刻报错。
 *
 * 为什么非要有：自我重启是"先拉起接班人、确认它没当场死、再停自己"，
 * 而父进程在那一秒里**仍然持有本锁**。接班人如果一撞锁就退（实测 633ms），
 * 就一定死在父进程的 1s 确认窗口之内 → 每次重启都被判定为"新进程没起来"而取消。
 * 我的 T-061 e2e 曾经跑绿过，那是**时序侥幸**，不是它真的对。
 */
export function acquireDataDirLock(dataDir: string, handoverWaitMs = 0): DataDirLock {
  const lockPath = join(dataDir, 'daemon.lock');
  mkdirSync(dataDir, { recursive: true });

  const tryCreate = (): number | undefined => {
    try {
      return openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return undefined;
    }
  };

  let fd = tryCreate();
  if (fd === undefined) {
    // 已存在：看看持有者还活着吗
    let holder: number;
    try {
      holder = Number(readFileSync(lockPath, 'utf8').trim()) || 0;
    } catch {
      holder = 0;
    }
    if (holder > 0 && holder !== process.pid && pidAlive(holder)) {
      // 接班模式：给前任一点时间退干净，而不是立刻判死
      const deadline = Date.now() + handoverWaitMs;
      let handedOver = false;
      while (Date.now() < deadline) {
        sleepSync(100);
        if (!pidAlive(holder)) {
          handedOver = true;
          break;
        }
      }
      if (!handedOver) throw new DataDirLockedError(holder, lockPath);
    }
    // stale lock（进程已死）→ 接管
    rmSync(lockPath, { force: true });
    fd = tryCreate();
    if (fd === undefined) {
      // 极小概率的竞态：另一个实例刚好同时接管
      throw new DataDirLockedError(holder, lockPath);
    }
  }

  writeFileSync(fd, String(process.pid));
  closeSync(fd);

  return {
    release(): void {
      try {
        const cur = Number(readFileSync(lockPath, 'utf8').trim()) || 0;
        if (cur === process.pid) rmSync(lockPath, { force: true });
      } catch {
        /* 退出路径上的清理失败不值得让进程崩掉 */
      }
    },
  };
}
