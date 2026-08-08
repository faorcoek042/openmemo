/**
 * Probe subprocess runner — watchdogged, crash-isolated, circuit-broken.
 *
 * ADR-003 decision 3: "probe runs in a separate subprocess + 10s timeout + failure
 * circuit breaker". This file is that requirement.
 *
 * WHY A SUBPROCESS IS NOT OPTIONAL — measured on the T-012 Linux box:
 *   With every libggml-cpu-*.so removed, whisper.cpp does not return an error. It calls
 *   ggml_abort() inside ggml_backend_dev_backend_reg() and the process dies of SIGABRT
 *   (exit 134, with a gdb backtrace dumped to stderr). GPU driver faults are worse.
 *   Loading ggml in-process would make a broken backend pack fatal to the daemon.
 *
 * WHY A TIMEOUT IS NOT OPTIONAL:
 *   Ollama documents that an out-of-date ROCm kernel driver makes GPU initialisation
 *   "hang during device discovery and eventually time out". A hung probe must never
 *   become a hung daemon.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { CHILD_KILL_SIGNAL, libraryPathEnv } from '../childEnv.js';
import type { ProbeFailureKind, ProbeOutput, ProbeResult } from '../types.js';
import { isProbeOutput } from '../types.js';

/** ADR-003 decision 3 fixes this at 10 seconds. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Consecutive failures after which a backend is blacklisted until explicitly retried. */
export const CIRCUIT_BREAKER_THRESHOLD = 2;

export interface RunProbeOptions {
  /** Path to the `openmemo-probe` executable. */
  probePath: string;
  /** Directory of ggml backend shared libraries to scan. */
  backendDir: string;
  timeoutMs?: number;
  /** Extra environment for the child (e.g. GGML_VK_VISIBLE_DEVICES). */
  env?: Record<string, string>;
}

/**
 * Spawns the probe and parses its JSON. Never throws and never rejects — a probe
 * failure is an expected, routine outcome that the degradation chain consumes as data.
 */
export async function runProbe(options: RunProbeOptions): Promise<ProbeResult> {
  const { probePath, backendDir, timeoutMs = PROBE_TIMEOUT_MS } = options;
  const startedAt = Date.now();

  if (!existsSync(probePath)) {
    return failure(`probe executable not found: ${probePath}`, 'missing_probe', startedAt);
  }
  if (!existsSync(backendDir)) {
    return failure(`backend directory not found: ${backendDir}`, 'missing_backend_dir', startedAt);
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const child = execFile(
      probePath,
      [backendDir],
      {
        timeout: timeoutMs,
        // The probe prints one small JSON object; anything larger means something is wrong.
        maxBuffer: 4 * 1024 * 1024,
        killSignal: CHILD_KILL_SIGNAL,
        windowsHide: true,
        env: {
          ...process.env,
          // Resolve co-located ggml libraries without polluting the daemon's own env.
          ...libraryPathEnv(process.env, backendDir),
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;

        if (error) {
          // execFile sets `killed` when the timeout fired.
          const err = error as Error & {
            killed?: boolean;
            signal?: string | null;
            // Node types this as `string` on Error, but execFile sets the numeric
            // child exit status here — hence the widened annotation.
            code?: string | number | null;
          };
          const killed = err.killed === true;
          const signal = err.signal ?? null;
          const code: string | number | null = err.code ?? null;

          if (killed || signal === 'SIGKILL') {
            return done(
              failure(
                `probe timed out after ${timeoutMs}ms (killed). This usually means a GPU driver ` +
                  `hung during device discovery.`,
                'timeout',
                startedAt,
                { stderr: tail(stderr), durationMs },
              ),
            );
          }

          // SIGABRT / SIGSEGV: the exact class of fault that would have killed the daemon.
          if (signal === 'SIGABRT' || signal === 'SIGSEGV' || code === 134 || code === 139) {
            return done(
              failure(
                `probe crashed (${signal ?? `exit ${String(code)}`}). The backend directory is ` +
                  `incomplete or the driver faulted.`,
                'crash',
                startedAt,
                { stderr: tail(stderr), durationMs },
              ),
            );
          }

          return done(
            failure(`probe failed: ${error.message}`, 'exec_error', startedAt, {
              stderr: tail(stderr),
              durationMs,
            }),
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return done(
            failure('probe produced unparseable output', 'bad_output', startedAt, {
              stderr: tail(stderr),
              durationMs,
            }),
          );
        }

        if (!isProbeOutput(parsed)) {
          return done(
            failure('probe output failed schema validation', 'bad_output', startedAt, {
              stderr: tail(stderr),
              durationMs,
            }),
          );
        }

        done({
          ok: true,
          output: parsed satisfies ProbeOutput,
          durationMs,
          // ggml logs backend load/skip decisions here; keep it for the UI's "why" panel.
          stderr: tail(stderr),
        });
      },
    );

    child.on('error', (err) => {
      done(
        failure(`could not spawn probe: ${err.message}`, 'exec_error', startedAt, {
          durationMs: Date.now() - startedAt,
        }),
      );
    });
  });
}

function failure(
  message: string,
  kind: ProbeFailureKind,
  startedAt: number,
  extra: { stderr?: string; durationMs?: number } = {},
): ProbeResult {
  return {
    ok: false,
    kind,
    message,
    stderr: extra.stderr ?? '',
    durationMs: extra.durationMs ?? Date.now() - startedAt,
  };
}

/** Keep the last N characters of a stream; ggml's backtrace dumps can be long. */
function tail(s: string | undefined, max = 4000): string {
  if (!s) return '';
  return s.length <= max ? s : `…${s.slice(s.length - max)}`;
}

/* ========================================================================== */
/* 断路器                                                                      */
/* ========================================================================== */

/**
 * ★ T-173：**停用必须是有期限的，否则它不是断路器，是死锁。**
 *
 * 原实现只有"关"，没有"再开"。`recordProbeOutcome()` 只在 `result.ok` 时清
 * `blacklistedAt`，失败分支是 `state.blacklistedAt ?? new Date()` —— 一旦置上就
 * **再也不会被失败清掉**。于是：
 *
 * > 解除停用的唯一条件是**探测成功**；
 * > 探测成功的前提是**探针被调用**；
 * > 探针被调用的前提是**没被停用**。
 *
 * 这个环没有出口。用户不会收到任何报错，只会发现 GPU 加速"就是不工作"。
 * `[T-172 实测]` 冷 Mac 上（Metal shader 缓存冷启动 12–21 s，n=4，四个样本全部
 * > `PROBE_TIMEOUT_MS`）：daemon 启动一发 + 首个 `GET /api/runtime/hardware` 一发
 * = 两次超时 = 必然跳闸；此后 `metal` 永久拉黑、零报错。
 *
 * 指纹变化不是出口 —— 它只兑现**一次**重试（`recordProbeOutcome` 随即把新指纹
 * 写回 state，裁决带着新指纹重新关上），而装完包之后指纹从此不再变。
 *
 * ## 修法：冷却期 + 半开
 *
 * 跳闸时记一个 `retryAt`。冷却期内一律不探（这才是断路器要省的那笔钱）；
 * 冷却到期放**一发**恢复探测（半开）：成功 → 彻底复位；失败 → 退避后重新计时。
 * **`blacklistedAt` 置上之后，`retryAt` 必然存在且必然会到期** —— 这条不变式
 * 就是"死锁没有出口"的反面。
 *
 * ## 两个刻意没动的常量
 *
 * `PROBE_TIMEOUT_MS`（10 s，多久算超时）与 `CIRCUIT_BREAKER_THRESHOLD`（2，几次算坏）
 * **一个字未改**。这次改的是"停用之后怎么出来"，不是"多久算超时""几次算坏"。
 */

/**
 * 第一次跳闸后的冷却期。
 *
 * **取值依据（下界与上界都是被别的数字夹出来的，不是拍的）：**
 *
 * - **下界**：不能做成"每次自检都重试一遍"，那等于把断路器删掉、回到每次白等 10 s。
 *   诊断页的自检查询 `staleTime` 是 **30 s**（`DiagnosticsPage.tsx`），用户手动刷新
 *   还能更密。取 60 s ⇒ **无论怎么刷，一分钟内最多放一发**，且那一发在后台跑，
 *   用户不在任何一个请求上等它。
 * - **上界**：残留情形（包已装好、之后 shader 缓存才变冷）要能在用户**察觉之前**
 *   自愈。60 s 意味着 daemon 起来一分钟内就自动恢复。
 * - 真正挂死的驱动由**指数退避**来管，不由这个基数管（见 `BREAKER_COOLDOWN_MAX_MS`）。
 */
export const BREAKER_COOLDOWN_MS = 60_000;

/**
 * 指数退避的上限：`60s × 2^n` 封顶在 1 小时。
 *
 * 依据是"每次半开重试的代价"：一发恢复探测最多占 `PROBE_RECOVERY_TIMEOUT_MS`，
 * **跑在后台、不在任何交互路径上**，所以代价是一个子进程，不是用户的等待。
 * 封在 1 h ⇒ 一台驱动真挂死的机器每天最多白跑 ~24 发；而用户**修好驱动之后
 * 一小时内产品自己就会发现**，不需要他知道有个断路器存在、更不需要他去找重试按钮。
 *
 * 退避档位：60 s → 2 m → 4 m → 8 m → 16 m → 32 m → 1 h（封顶）。
 */
export const BREAKER_COOLDOWN_MAX_MS = 3_600_000;

/**
 * **半开那一发**的超时预算 —— 与交互路径上的 `PROBE_TIMEOUT_MS` 是两码事。
 *
 * ★ 这个数是本次修复里**最容易被"顺手统一"掉、而一统一就前功尽弃**的一个：
 * 冷 Mac 上 Metal 首次初始化实测 12–21 s（n=4：12306 / 16092 / 17606 / 20959 ms），
 * 而被 kill 的探针**什么都不留**（shader 缓存是全有全无的，T-172 已证伪"部分落盘"）。
 * ⇒ 用 10 s 的预算去做恢复探测，**每一次都必然超时，永远自愈不了** ——
 * 冷却期照样在转，用户照样看不到 GPU，只是从"永久拉黑"变成"永久重试"。
 *
 * 90 s = 最大观测样本（20959 ms）的 ~4 倍余量（真机 M 系列的数 UNKNOWN，取不到）。
 * 与 `apps/daemon/src/runtime/warmup.ts` 的捂热预算同源同理由：
 * **没有人在等这一发**，所以它可以慢；有界，驱动真挂死时 90 s 收场。
 */
export const PROBE_RECOVERY_TIMEOUT_MS = 90_000;

/**
 * Circuit breaker.
 *
 * Without this, a machine whose CUDA driver hangs pays the full 10s probe timeout on
 * every single daemon start. After two consecutive failures a backend is parked —
 * but only until `retryAt`, never forever (see the T-173 note above).
 */
export interface BreakerState {
  consecutiveFailures: number;
  blacklistedAt: string | null;
  lastError: string | null;
  /** Re-probing is allowed again when this changes (driver upgrade invalidates the verdict). */
  driverFingerprint: string | null;
  /**
   * 冷却到期时刻（ISO）。`null` ⇔ 没跳闸。
   *
   * **不变式：`blacklistedAt !== null` ⇒ `retryAt !== null`。** 这条就是出口本身。
   */
  retryAt: string | null;
}

export function emptyBreaker(): BreakerState {
  return {
    consecutiveFailures: 0,
    blacklistedAt: null,
    lastError: null,
    driverFingerprint: null,
    retryAt: null,
  };
}

/** 本次失败该等多久再放行。第 n 次半开失败 ⇒ `60s × 2^n`，封顶 1 h。 */
export function breakerCooldownMs(consecutiveFailures: number): number {
  const step = Math.max(0, consecutiveFailures - CIRCUIT_BREAKER_THRESHOLD);
  // 2 ** step 溢出成 Infinity 也没关系，Math.min 会把它收回上限。
  return Math.min(BREAKER_COOLDOWN_MS * 2 ** step, BREAKER_COOLDOWN_MAX_MS);
}

/**
 * `now` 可注入**只**为了让冷却期能被确定性地测到 —— 生产侧不传，
 * 行为与写死 `new Date()` 逐字相同。等一分钟的测试等于没有测试。
 */
export function recordProbeOutcome(
  state: BreakerState,
  result: ProbeResult,
  driverFingerprint: string | null,
  now: Date = new Date(),
): BreakerState {
  if (result.ok) {
    return { ...emptyBreaker(), driverFingerprint };
  }
  /*
   * ★★ 「还没装」不是「装了但坏了」。
   *
   * `missing_probe` / `missing_backend_dir` 的含义是**探针二进制/后端目录不存在** ——
   * 而它们随后端包出厂，所以**全新安装上必然如此**。`runProbe` 对这两种只做
   * 一次 `existsSync`（微秒级，不 spawn、不碰驱动），也就是说：**什么都没测**。
   *
   * 在这之前它们被记成普通失败，后果是**用户什么都没做错就看到断路器跳闸**：
   * `[实测 2026-08-08]` 全新数据目录、一个后端包都没装，daemon 启动探一发 +
   * 用户在运行时页点一下「重新检测」再探一发 = 2 次 = 正好到阈值 ⇒
   *
   *     verdict=open  blacklistedBackends=[cuda,vulkan,rocm,metal,coreml]
   *     lastError=probe executable not found: <data>/bin/runtime/openmemo-probe
   *
   * 于是他第一次打开诊断页，看到的是「加速后端断路器」告警 + 5 个后端全被停用。
   * 判据与 T-168 是同一条：**没有证据要被报成没有证据，不能被报成故障。**
   *
   * ⚠️ 刻意**没有动**三个常量（`PROBE_TIMEOUT_MS` / `CIRCUIT_BREAKER_THRESHOLD` /
   * `BREAKER_COOLDOWN_MS`）—— 有测试直接断言它们的值，而且这次要改的本来就不是
   * 「多久算超时」「几次算坏」，是**「什么算一次失败」**。
   *
   * 计数**保持原样**而不是清零：清零会把一次真实的连续失败记录抹掉
   * （包被卸载的瞬间也会走到这里）。这里只更新 `lastError`，让"为什么没探到"仍然可见。
   */
  if (result.kind === 'missing_probe' || result.kind === 'missing_backend_dir') {
    return { ...state, lastError: result.message, driverFingerprint };
  }
  /*
   * 指纹变了 = 被测的东西换了（装了包 / 换了内核）。旧的失败计数说的是**另一个配置**，
   * 不能算在新配置头上 —— 这正是"指纹变化只给一次重试，不是复位"那条缺陷的落点：
   * 放行的那一次若还失败，`state.consecutiveFailures + 1` 会立刻把它按回停用。
   */
  const prior = fingerprintChanged(state, driverFingerprint) ? emptyBreaker() : state;
  const consecutiveFailures = prior.consecutiveFailures + 1;
  if (consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) {
    return {
      consecutiveFailures,
      blacklistedAt: null,
      lastError: result.message,
      driverFingerprint,
      retryAt: null,
    };
  }
  return {
    consecutiveFailures,
    // 首次跳闸记时刻；已经跳过就保留原时刻（"从什么时候起坏的"不该被每次重试刷新）。
    blacklistedAt: prior.blacklistedAt ?? now.toISOString(),
    lastError: result.message,
    driverFingerprint,
    // ★ 出口。每一条失败路径都必须写它，否则就回到了死锁。
    retryAt: new Date(now.getTime() + breakerCooldownMs(consecutiveFailures)).toISOString(),
  };
}

function fingerprintChanged(state: BreakerState, current: string | null): boolean {
  return state.driverFingerprint !== null && state.driverFingerprint !== current;
}

/**
 * 断路器的三态。调用方据此决定**这一发探测跑不跑、用谁的预算**。
 *
 * - `closed`  —— 正常。照常探测，用 `PROBE_TIMEOUT_MS`。
 * - `open`    —— 冷却期内。**一发都不探**（这才是断路器省下的钱）。
 * - `recover` —— 半开：冷却到期，该放一发恢复探测了。它必须用
 *   `PROBE_RECOVERY_TIMEOUT_MS`，且**不能跑在交互路径上**（调用方负责，见 setup.ts）。
 */
export type BreakerVerdict = 'closed' | 'open' | 'recover';

export function breakerVerdict(
  state: BreakerState,
  currentDriverFingerprint: string | null,
  now: Date = new Date(),
): BreakerVerdict {
  if (state.blacklistedAt === null) return 'closed';
  // A driver change is new evidence: clear the verdict and let it prove itself again.
  if (fingerprintChanged(state, currentDriverFingerprint)) return 'closed';
  const due = state.retryAt === null ? Number.NaN : Date.parse(state.retryAt);
  /*
   * ★ 取不到有效的到期时刻时**放行**，不是永久停用。
   *
   * 方向选错就是原地回到死锁：一个读不出来的时间戳会变成"再也不重试"。
   * 宁可多跑一发探测（代价：一个后台子进程），也不要再造一个零报错的死角。
   */
  if (Number.isNaN(due) || now.getTime() >= due) return 'recover';
  return 'open';
}
