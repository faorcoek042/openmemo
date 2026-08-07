/**
 * 装包末尾把 GPU 着色器缓存捂热 —— 只在 macOS 做，且**失败绝不影响装包**。
 *
 * ## 它要解决的缺陷（T-172，冷启动实测）
 *
 * macOS 上第一次触碰 Metal 要初始化 shader 缓存。`[报告：CI run 31190188102]`
 * 探针冷启动 **16092 ms**（其中 `ggml_metal_library_init` 15.911 s），
 * 同一台机器紧接着热跑 **123 ms / 90 ms** —— 相差 ~131×。
 * 另一台 runner 上的冷样本是 20959 ms，所以诚实的写法是**区间不是点**：
 * 这批虚拟化 macOS runner 上冷启动 ≈ **16–21 s**（n=2）。
 *
 * `[未验证：需真 Mac]` 两台 runner 的 GPU 都是 `Apple Paravirtual device`
 * （stderr 明写 `tensor API disabled for pre-M5 and pre-A19 devices`），
 * **真机 M1/M2/M3 上这个数是多少，取不到，也不许拿 16 s 去代表真机。**
 *
 * 而 `PROBE_TIMEOUT_MS` 是 ADR-003 决策 3 定死的 10 秒 → **冷机器上首次探测必然超时**。
 *
 * ## 为什么是"挪走这一发"，不是"把 10 秒调大"
 *
 * 这笔钱**每台机器只付一次**（之后 0.02 s）；而把 10 s 抬到 30 s，
 * 会让**每一次真正的驱动挂死都要 30 秒才浮现** —— 那正是这个常量存在的理由
 * （ADR-003 决策 3 引 ROCm 驱动挂死）。**一个为罕见慢路径放宽的超时，代价由每一次真故障来付。**
 * 所以：在装包的时候捂热（那里进度条本来就在转，用户已经在等），其余地方 10 s 一个字不动。
 *
 * ## ★ 它顺带修掉的那件更严重的事：断路器会把 metal **永久**拉黑
 *
 * `[实测，本机模拟探针 + 产品自己的断路器代码]` 冷 Mac 上不捂热的完整时间线：
 *
 * ```
 * daemon 启动 RestState.create      10020ms timeout  失败=1  open=false
 * 首个 GET /api/runtime/hardware    10013ms timeout  失败=2  open=true   ← 断路器打开
 * 装包（驱动指纹改变 → 放行「一次」重试）
 * 装包后第 1 次探测                  10017ms timeout  失败=3  open=true   ← 那一次重试还是冷的
 * 装包后第 2 次探测                      9ms  ran=false            open=true   ← 探针不再被调用
 * ⇒ metal 被永久拉黑，且没有任何地方报错
 * ```
 *
 * 关键在于 `recordProbeOutcome()` **只在成功时**清 `blacklistedAt`：
 * 指纹变化（`isBlacklisted` 里"指纹变了就是新证据"）给的是**一次**重试，**不是复位**。
 * 那一次要是还冷，断路器立刻带着**新指纹**重新关上 —— 而包已经装好，
 * 指纹从此不会再变，于是**再也没有第二次机会**。
 *
 * 捂热正好落在那一次重试之前，把它从「必然失败」变成「必然成功」：
 *
 * ```
 * ★ 捂热 runProbe(timeoutMs=90000): 16011ms ok=true
 * 装包后第 1 次探测                     17ms  ok=true  失败=0  open=false  ← 断路器彻底复位
 * ```
 *
 * ⚠️ **仍未覆盖的残留情形**（已单独交回 Manager，不在本模块的职责里）：
 * 包已装好、之后缓存才变冷（系统升级清了 shader 缓存 / 换用户账户 / 缓存被回收）。
 * 那时不会有装包动作 → 不会捂热 → 指纹也不变 → 两次超时后同样永久拉黑。
 * 根治要动断路器语义（`recordProbeOutcome` 在指纹变化时应否把计数归零），那是 ADR-003 的地界。
 * 今天的人工出口是 `GET /api/runtime/hardware?reset=1`（`resetBreaker()`，已实测有效）。
 */

import { probedBackendsInDir, runProbe, type ProbeResult, type RunProbeOptions } from '@openmemo/runtime';

import { resolveRuntimeLayout, type RuntimePathsInput } from './setup.js';

/**
 * 捂热这一发**自己的**预算，作为入参传给产品自己的 `runProbe()`。
 *
 * ★ **`PROBE_TIMEOUT_MS` 一个字都没动**，也没有在这里被引用 —— 那是 ADR-003 定死的
 * 诊断阈值，交互路径上继续用它。这里放宽的只是 `runProbe()` 本来就接受的 `timeoutMs` 入参
 * （审计脚本 `scripts/ci/probe-cold-timing.mjs` 就是这么做的）。
 *
 * 取值依据：实测冷启动 16–21 s（n=2，虚拟化 runner），真机 UNKNOWN，
 * 所以给到最大观测样本的 ~4 倍余量。**仍然是有界的** —— 驱动真挂死时
 * 这一步会在 90 s 后收场并如实记一条日志，而不是把装包任务永远吊在这里。
 */
const PROBE_WARMUP_TIMEOUT_MS = 90_000;

/** 没做捂热的原因。都是正常情形，不是错误。 */
export type WarmupSkipReason =
  /** 不是 macOS —— Linux/Windows 冷跑 13ms / 39ms，没有问题要解决，不平白多跑一次探针。 */
  | 'not-darwin'
  /** 这台机器上找不到 probe 二进制（没装过带 probe 的包）。 */
  | 'no-probe-binary'
  /** 目录里没有 Metal 的 ggml 库 —— 捂的不是 Metal，就没有 16 秒要省。 */
  | 'no-metal-library';

export interface WarmProbeCacheOptions extends RuntimePathsInput {
  /** 默认 `process.platform`。可注入**只**为了让"非 macOS 不跑探针"这条能被测到。 */
  readonly platform?: NodeJS.Platform;
  /** 默认就是产品自己的 `runProbe`。可注入**只**为了测敌对输入（抛异常/超时/崩溃）。 */
  readonly probe?: (options: RunProbeOptions) => Promise<ProbeResult>;
  /** 真的要开跑了 —— 调用方在这里把进度条文案切成"正在初始化 GPU 着色器缓存…"。 */
  readonly onBeforeProbe?: () => void;
  readonly log?: (message: string) => void;
}

export interface WarmProbeCacheResult {
  /** 到底有没有真的跑探针。 */
  readonly attempted: boolean;
  /** 跑了并且成功。`attempted === false` 时恒为 false。 */
  readonly ok: boolean;
  /** 没跑的原因；跑了就是 null。 */
  readonly skipped: WarmupSkipReason | null;
  readonly durationMs: number;
  /** 人话说明，直接进日志。 */
  readonly detail: string;
}

/** 回调是调用方给的，它抛异常也不许把捂热变成异常。 */
function safely(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    /* 调用方的回调炸了不是装包的问题，咽掉 */
  }
}

/**
 * 捂热 macOS 的 Metal shader 缓存。
 *
 * ## 契约：**这个函数永不抛异常、永不 reject**
 *
 * 这条比"捂热成功"重要得多。捂热是**优化，不是安装的前提** ——
 * 超时、子进程崩溃、二进制不存在、路径解析炸了、注入的探针直接 throw，
 * 一律只体现为返回值里的 `ok: false` + 一条日志，装包照常成功。
 *
 * 判据来自队列：`DownloadQueue.run()` 是 `await entry.task(ctx)` 外面套 try/catch
 * （`packages/downloader/src/queue.ts:201`），**任务里任何一处抛出都会把整个 job 判失败**。
 * 所以安全性必须由本函数自己保证，而不是靠调用方记得写 `.catch()`。
 * `warmup.test.ts` 用六组敌对输入把这条钉死。
 */
export async function warmProbeCache(
  options: WarmProbeCacheOptions,
): Promise<WarmProbeCacheResult> {
  const startedAt = Date.now();
  const skip = (skipped: WarmupSkipReason, detail: string): WarmProbeCacheResult => ({
    attempted: false,
    ok: false,
    skipped,
    durationMs: Date.now() - startedAt,
    detail,
  });

  try {
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin') {
      // ★ 在这里就返回，**绝不 spawn**：Linux/Windows 上冷跑 13ms/39ms，没有问题要解决。
      return skip('not-darwin', `平台是 ${platform}，只有 macOS 需要捂热 Metal 着色器缓存`);
    }

    const layout = await resolveRuntimeLayout(options);
    if (!layout.probeExists) {
      return skip('no-probe-binary', `找不到 probe 二进制（${layout.probePath}）`);
    }

    // 结构判据：目录里到底有没有 Metal 的 ggml 库。
    // ★ 刻意**不**看 `pack.backend === 'metal'` —— 目录里今天没有任何一个包这么声明
    //   （macOS 的包声明的是 `backend: 'cpu'`，却装着 libggml-metal），
    //   照那个字段判会永远跳过，且没有任何地方会报错。
    const present = await probedBackendsInDir(layout.backendDir);
    if (!present.has('metal')) {
      return skip('no-metal-library', `${layout.backendDir} 里没有 Metal 的 ggml 库`);
    }

    safely(options.onBeforeProbe);

    const probe = options.probe ?? runProbe;
    const result = await probe({
      probePath: layout.probePath,
      backendDir: layout.backendDir,
      // ↓ 放宽的是入参，不是 PROBE_TIMEOUT_MS
      timeoutMs: PROBE_WARMUP_TIMEOUT_MS,
    });

    const durationMs = Date.now() - startedAt;
    const detail = result.ok
      ? `Metal 着色器缓存已捂热，用时 ${String(durationMs)}ms —— 此后探测走 10s 阈值即可`
      : `捂热未成功（${result.kind}：${result.message}）—— 安装不受影响，` +
        `首次硬件探测可能仍会超时一次`;
    safely(() => options.log?.(detail));
    return { attempted: true, ok: result.ok, skipped: null, durationMs, detail };
  } catch (err) {
    /*
     * ★ 兜底。走到这里说明是**捂热自己**的意外（路径解析、readdir、注入的探针直接 throw…）。
     * 装包已经成功了，这里绝不把它翻成失败 —— 但也绝不静默：留一条日志。
     */
    const detail = `捂热 GPU 着色器缓存时出错：${String(err)} —— 安装本身已成功，不受影响`;
    safely(() => options.log?.(detail));
    return { attempted: true, ok: false, skipped: null, durationMs: Date.now() - startedAt, detail };
  }
}
