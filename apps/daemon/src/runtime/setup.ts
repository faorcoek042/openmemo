/**
 * `@openmemo/runtime` 的 daemon 侧接线。
 *
 * 背景（P0 缺陷）：`packages/runtime` 已完整实现并测过，但 daemon 从来没 import 过它 ——
 * 硬件探测、降级链、probe 断路器、自检全是死代码，`GET /api/runtime/hardware` 走的是
 * daemon 自己手写的 `node:os` 兜底。本文件就是那条缺失的接线：**唯一**负责
 *
 *   1. 从 `AppPaths` 解析出 runtime 需要的四个路径（probePath / backendDir /
 *      modelsRoot / runtimesRoot），不硬编码任何一个；
 *   2. 持有 probe 断路器状态（ADR-003 决策 3：子进程 + 10s 超时 + 失败断路器）；
 *   3. 把 `detectHardware()` / `runSelfTest()` 的真实结果交给 REST 层。
 *
 * 诚实边界（ADR-004 决策 3）：
 *   - probe 二进制不存在时**不伪造 GPU**。`runProbe` 会返回 `missing_probe`，
 *     `buildHardwareInfo` 于是给出 `gpus: []` + 每个后端一条 `unavailableReason`。
 *     这正是本机（Linux x86_64 无 GPU、没人构建过 probe）应该看到的输出。
 *   - 自检跑不了就返回 blocked + remediation，绝不返回一个假的 passed。
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArtifactStore } from '@openmemo/downloader';
/*
 * ★ 用 `packages/pipeline` 的**同一个**发现函数，不要在这里再写一个。
 *
 * `[用户实测]` 同一台实例上，"whisper-cli 在不在"有四个出口给了两种答案：
 *   1. `discoverTools()` → `findInBackendPacks()`      找得到（976,312 B，在盘上）
 *   2. `/api/selfcheck` 读 bundle                       找得到，路径一字不差
 *   3. 磁盘                                             在
 *   4. `runBackendSelfTest()`（本文件）                  **null** → 点「自测」得到
 *      `409 SELF_TEST_BLOCKED missing:["whisper-cli"]`
 * 第 4 个之所以不同，是因为它**自己解析、不吃流水线那份答案**，而且只搜 `bin/runtime`。
 * 修法不是给它补一条搜索路径（那是第五个实现），是让它去问 1 号 ——
 * 与 `canonicalAssetRelPath` 那次"读取侧/写入侧各归一一次"同一条判据：
 * **同一个问题只准有一个回答的人。**
 */
import { findInBackendPacks, resolveBackendTool } from '@openmemo/pipeline';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  PROBE_RECOVERY_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  SELF_TEST_TIMEOUT_MS,
  breakerVerdict,
  buildHardwareInfo,
  detectCpu,
  detectDisks,
  detectGpus,
  detectHardware,
  detectMemory,
  detectOs,
  detectUnifiedMemory,
  emptyBreaker,
  formatSelfTest,
  preferenceOrder,
  probedBackendsInDir,
  recordProbeOutcome,
  runProbe,
  runSelfTest,
  type AdvisoryDetection,
  type BreakerState,
  type BreakerVerdict,
  type ProbeFailureKind,
  type ProbeResult,
  type SelfTestOutcome,
} from '@openmemo/runtime';
import type { Backend, HardwareInfo, InstalledBackendPack, Remediation } from '@openmemo/shared';

/**
 * 除 cpu 外的全部后端。
 *
 * 断路器跳闸时把它们一起拉黑，但**永远不拉黑 cpu**：L1 内置 CPU 后端是降级链的地板，
 * ggml 在完全没有 CPU 后端时会 `ggml_abort()` 直接 SIGABRT（manager.ts 已实测），
 * 所以它必须始终可选。
 */
const ACCELERATOR_BACKENDS: readonly Backend[] = ['cuda', 'vulkan', 'rocm', 'metal', 'coreml'];

/**
 * probe 由 `gpu-runtime` 的构建从 `packages/runtime/src/native/probe.c` 产出。
 *
 * ★ T-144（platform C10）：这里**曾经**找的是 `probe` / `probe.exe`，而
 * **产出方与其余全部使用方用的都是 `openmemo-probe`**：
 *   产出 `scripts/build-probe.sh:3`、`.github/workflows/build-backends.yml:105,227,313`
 *   消费 `http/rest/selfcheck.ts:94`、`packages/runtime/src/probe/runProbe.ts`、
 *        `packages/runtime/src/selfcheck.ts:125,346`、`scripts/selfcheck.mjs:250`
 * 全仓只有这一行是另一个名字 —— 后果是 `probeExists` 恒 false、
 * `GET /api/runtime/hardware` 永远报"未探测"、**L2 加速包在所有平台上都装不上**
 * （章程要求 2.1 的「检测硬件 → 推荐后端」整条链的总开关）。
 */
function probeBinaryName(): string {
  return process.platform === 'win32' ? 'openmemo-probe.exe' : 'openmemo-probe';
}

/**
 * 导出，因为 `pipeline/setup.ts` 也要用它去问"这次的 whisper-cli 是哪个包给的"。
 * 两处各写一份字面量 = 又一次「产出方与使用方用了两个名字」（见上面 probe 的 T-144）。
 */
export function whisperCliName(): string {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

/* ========================================================================== */
/* 路径解析                                                                    */
/* ========================================================================== */

export interface RuntimePathsInput {
  /** `AppPaths.dataDir`。 */
  readonly dataDir: string;
  /** `AppPaths.modelsDir`；不传就按 downloader 的约定落在 `<dataDir>/models`。 */
  readonly modelsDir?: string | undefined;
}

export interface RuntimeLayout {
  /** probe 可执行文件。不存在时仍是"它本该在哪"，好让 UI 能把路径显示出来。 */
  readonly probePath: string;
  /** ggml 后端动态库所在目录（probe 的同级目录 —— ggml 从二进制自身目录 dlopen）。 */
  readonly backendDir: string;
  readonly modelsRoot: string;
  readonly runtimesRoot: string;
  readonly probeExists: boolean;
  readonly backendDirExists: boolean;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 在一个根目录下按层级找**第一个满足谓词的文件**。
 *
 * 后端包解包后可能多嵌几层（如 `<archive>/<顶层>/bin/`），所以深度到 4 足够，
 * 又不至于把整个数据目录翻一遍。BFS 保证浅层（也就是更"正式"的安装位置）优先命中。
 *
 * 谓词而不是固定文件名：ggml 后端库的文件名带版本号（`libggml-base.0.15.1.dylib`），
 * 写死名字就等于每次上游改版都静默失效 —— 与"写死 `ggml-silero-v6.2.0.bin`"同一个坑。
 */
async function findUnder(
  root: string,
  match: (name: string) => boolean,
  maxDepth = 4,
): Promise<string | null> {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && match(entry.name)) return full;
        if (entry.isDirectory()) next.push(full);
      }
    }
    level = next;
  }
  return null;
}

const named = (fileName: string) => (n: string) => n === fileName;

/**
 * 一个 ggml 后端动态库？
 *
 * 判据是"ggml 会 dlopen 的那类文件"，不是某个具体名字：
 * `libggml-cpu.so` / `libggml-base.0.15.1.dylib` / `ggml-cuda.dll` 都算。
 */
function isGgmlLibrary(name: string): boolean {
  if (!/^lib?ggml|^ggml/i.test(name)) return false;
  return /\.(so|dylib|dll)(\.\d+)*$/i.test(name);
}

/**
 * 解析 runtime 需要的四个路径。
 *
 * ## ★ T-160：安装器写的目录和这里读的目录**不是同一个**
 *
 * `[本机实测]` live `GET /api/runtime/hardware` → `backendDirExists: false`，
 * 而 `whispercpp-cpu-linux-x64` **已装、`integrity: "ok"`**。原因是两边各写各的：
 *
 * ```
 * 安装器落点   <modelsRoot>/by-name/backend/<archive>/…      （backends.json 的包没有 linkInto）
 * 这里只搜     <dataDir>/bin/runtime                          （空目录）
 * ```
 *
 * 于是 probe 永远"找不到"、ggml 后端库永远"没装"、L2 加速包永远不可装 ——
 * 而**每一层都没有报错**：安装成功、校验 ok、健康检查绿，只有加速功能静默缺席。
 * 这与 T-093（网页装好中文分词器、搜索仍是 trigram 降级）是同一个形状，
 * 那次的修法也一样：**读安装器真正写下的位置，而不是读一个约定俗成的位置**。
 *
 * `packages/pipeline` 的 `findInBackendPacks()` 早就在做这件事了（whisper-cli / ffmpeg
 * 就是这么找到的），只有 runtime 这一路没跟上。这里补上同一条搜索路径。
 *
 * 顺序：环境变量（开发/自检覆盖）> `bin/runtime`（正式布局，将来 linkInto 生效时用）
 *       > `by-name/backend`（安装器**今天**真正写下的位置）。
 */
export async function resolveRuntimeLayout(input: RuntimePathsInput): Promise<RuntimeLayout> {
  const runtimesRoot = path.join(input.dataDir, 'bin', 'runtime');
  // 与 downloader 的 `resolveModelsRoot` 同序：OPENMEMO_MODELS > AppPaths.modelsDir
  const modelsRoot =
    process.env['OPENMEMO_MODELS'] ?? input.modelsDir ?? path.join(input.dataDir, 'models');
  const backendPacksRoot = path.join(modelsRoot, 'by-name', 'backend');

  // 显式环境变量优先（开发/自检用），与 pipeline/setup.ts 的工具解析约定一致
  const envProbe = process.env['OPENMEMO_PROBE'];
  const envBackendDir = process.env['OPENMEMO_BACKEND_DIR'];

  const found =
    envProbe ??
    (await findUnder(runtimesRoot, named(probeBinaryName()))) ??
    // ← 与 discoverTools() 用的是同一个函数，所以两边对"它在不在"不可能给出不同答案
    (await findInBackendPacks(modelsRoot, probeBinaryName()));
  const probePath = found ?? path.join(runtimesRoot, probeBinaryName());

  /*
   * backendDir 的定义是「ggml 从哪里 dlopen 后端库」，而 ggml 找的是**二进制自身所在目录**。
   * 所以 probe 找得到时就用它的同级目录（那才是 ggml 真正会看的地方）。
   *
   * probe 还没有分发通道（章程要求 2.1 断点①，见 inbox/gates-fix.md）时，
   * 退而求其次指向**真的装了 ggml 库的那个目录** —— 这样 `backendDirExists` 与
   * 断路器的驱动指纹（它 readdir 这个目录数动态库）说的都是实话，而不是恒 false。
   */
  const ggmlLib =
    found !== null
      ? null
      : ((await findUnder(runtimesRoot, isGgmlLibrary)) ??
        (await findUnder(backendPacksRoot, isGgmlLibrary)));
  const backendDir =
    envBackendDir ??
    (found !== null
      ? path.dirname(found)
      : ggmlLib !== null
        ? path.dirname(ggmlLib)
        : runtimesRoot);

  return {
    probePath,
    backendDir,
    modelsRoot,
    runtimesRoot,
    probeExists: await isFile(probePath),
    backendDirExists: await isDir(backendDir),
  };
}

/* ========================================================================== */
/* 断路器                                                                      */
/* ========================================================================== */

/**
 * 每个 backendDir 一份断路器状态。
 *
 * 为什么按 backendDir 分片而不是按 backend 分片：一次 probe 子进程枚举的是**整个目录**里
 * 所有 ggml 后端，失败（超时/SIGABRT）是目录级事件，落到单个 backend 上没有依据。
 * 跳闸后拉黑的是全部加速后端，cpu 不受影响。
 */
const breakers = new Map<string, BreakerState>();

export function breakerSnapshot(backendDir: string): BreakerState {
  return breakers.get(backendDir) ?? emptyBreaker();
}

/*
 * ★ T-175 删掉了 `resetBreaker()`。
 *
 * 它的唯一调用方是 `GET /api/runtime/hardware?reset=1`，而那条路已经改成
 * `requestBreakerRecovery()`（后台 + 90 s 预算 + 单飞）。留着它就是一个零调用方的导出，
 * 而且是**危险**的那种零调用方：它不带参数调用时 `breakers.clear()` 会清掉
 * **所有** backendDir 的裁决，下一个人看见它会以为那是"重试当前这个"的正确做法。
 *
 * 判据（Manager T-175）：**不许留半个功能。零读者 → 删。**
 * 零读者字段/函数最坏的地方不是浪费空间，是下一个人会以为它在起作用。
 */

/* -------------------------------------------------------------------------- */
/* 半开：恢复探测跑在后台                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 每个 backendDir 至多**一发**在跑的恢复探测。
 *
 * ★ **为什么必须是后台，而不是就地探一发**：半开那一发的预算是
 * `PROBE_RECOVERY_TIMEOUT_MS`（90 s，冷 Mac 上的 Metal 初始化要 12–21 s，10 s 一定不够）。
 * 而 `detectRuntimeHardware()` 的调用方是 `GET /api/runtime/hardware` 与 daemon 启动 ——
 * **就地探就是让用户的请求最长挂 90 s**，那比原来的病还重。
 * 所以：当次请求立刻返回"仍停用 + 正在重试"，恢复在后台跑完自己改 state，下一次请求就看见好了。
 *
 * ★ **为什么是单飞（Map 里有就不再起）**：冷却到期后每一个并发请求都会看到 `recover`。
 * 不去重的话，一台冷 Mac 上十几个请求会同时 spawn 十几个探针**去抢同一块 GPU 初始化** ——
 * 那正是断路器本来要防的"猛敲一个坏掉的东西"。
 *
 * ★ T-175：`startedAt` 是为**界面**记的。恢复那一发最长 90 s，用户完全可能在中途切走再回来
 * （或者干脆是另一个标签页）。进度如果记在前端，切走就归零、回来重新从 0 数 ——
 * 那是在**编一个进度**。记在这里，谁来问都得到同一个"已经跑了多久"。
 */
const recoveries = new Map<string, { task: Promise<void>; startedAt: string }>();

/**
 * 该目录上正在跑的恢复探测；没有就是 `null`。
 *
 * 生产侧用它回答"现在是不是正在重试"（`/api/runtime/breaker`、自检的 `hw.breaker`），
 * 测试侧用它等那一发跑完 —— 后台任务没有别的落点可以等。
 */
export function breakerRecovery(backendDir: string): Promise<void> | null {
  return recoveries.get(backendDir)?.task ?? null;
}

/**
 * 那一发是什么时候起跑的（ISO）；没在跑就是 `null`。
 *
 * 刻意**不导出**：唯一的读者是本文件里那两处组装（`breakerStatus()` 与
 * `detectRuntimeHardware()`），外面要这个值就该去读那两个报告。
 * 多导出一个零跨文件引用的函数会进 `check:orphans` 的棘轮，而那条棘轮是对的。
 */
function breakerRecoveryStartedAt(backendDir: string): string | null {
  return recoveries.get(backendDir)?.startedAt ?? null;
}

async function recoveryProbe(layout: RuntimeLayout, fingerprint: string): Promise<void> {
  try {
    const probe = await runProbe({
      probePath: layout.probePath,
      backendDir: layout.backendDir,
      // ↓ 放宽的是 runProbe 本来就接受的入参，PROBE_TIMEOUT_MS 一个字没动
      timeoutMs: PROBE_RECOVERY_TIMEOUT_MS,
    });
    const prev = breakers.get(layout.backendDir) ?? emptyBreaker();
    breakers.set(layout.backendDir, recordProbeOutcome(prev, probe, fingerprint));
  } catch {
    /*
     * `runProbe` 契约上永不抛。真抛了也绝不能把 daemon 带走 —— 这条任务没有 await 它的人，
     * 一个 unhandled rejection 会直接杀进程。state 保持原样，下一轮冷却照常再放一发。
     */
  }
}

/** `breakerStatus()` 的回传。**纯观测**，不含任何会改变状态的东西。 */
export interface BreakerStatusReport {
  readonly backendDir: string;
  readonly verdict: BreakerVerdict;
  /** 此刻被停用的后端；空数组 = 没有停用。cpu 永不入列。 */
  readonly blacklistedBackends: Backend[];
  readonly consecutiveFailures: number;
  readonly threshold: number;
  readonly lastError: string | null;
  readonly blacklistedAt: string | null;
  readonly retryAt: string | null;
  readonly recovering: boolean;
  /**
   * 正在跑的那一发恢复探测的**起跑时刻**（ISO）；没在跑就是 null。
   *
   * 界面拿它算"已经等了多久" —— 记在服务端而不是前端，是因为那一发最长 90 s，
   * 用户完全可能切走再回来。进度记在前端就会归零重数，那是编一个进度出来。
   */
  readonly recoveryStartedAt: string | null;
  /**
   * 恢复那一发的预算（ms）。**发出来是为了让界面别硬编一个 90。**
   * 那个数是 `PROBE_RECOVERY_TIMEOUT_MS`，前端抄一份必然漂。
   */
  readonly recoveryTimeoutMs: number;
}

/**
 * 只看一眼断路器，**不跑探测、不起恢复、不改任何状态**。
 *
 * 两个理由必须是纯的：
 *   1. `/api/runtime/breaker` 与自检的 `hw.breaker` 都是**排障入口** ——
 *      一个"看一眼就把它改了"的诊断，测出来的永远是自己造成的那个状态；
 *   2. CLI 与 `/api/selfcheck` 的逐 id 同源校验（`meta.sameSource`，required）
 *      要求两个出口给出同一个 status。观测带副作用 ⇒ 先问的那一方改变了后问的那一方
 *      看到的东西 ⇒ 那条 required 的红线会开始随机变红。
 */
export async function breakerStatus(options: RuntimePathsInput): Promise<BreakerStatusReport> {
  const layout = await resolveRuntimeLayout(options);
  const state = breakerSnapshot(layout.backendDir);
  const verdict = breakerVerdict(state, await driverFingerprint(layout));
  return {
    backendDir: layout.backendDir,
    verdict,
    blacklistedBackends: verdict === 'closed' ? [] : [...ACCELERATOR_BACKENDS],
    consecutiveFailures: state.consecutiveFailures,
    threshold: CIRCUIT_BREAKER_THRESHOLD,
    lastError: state.lastError,
    blacklistedAt: state.blacklistedAt,
    retryAt: state.retryAt,
    recovering: breakerRecovery(layout.backendDir) !== null,
    recoveryStartedAt: breakerRecoveryStartedAt(layout.backendDir),
    recoveryTimeoutMs: PROBE_RECOVERY_TIMEOUT_MS,
  };
}

/** @returns `true` = 本次真的起了一发；`false` = 已经有一发在跑，**加入等待**而不是再起一发。 */
function startBreakerRecovery(layout: RuntimeLayout, fingerprint: string): boolean {
  const dir = layout.backendDir;
  if (recoveries.has(dir)) return false;
  /*
   * `.finally()` 的回调**至少要等一个 microtask**才可能跑，而 `recoveries.set` 是同步的
   * —— 所以 set 必然先于 delete，不会留下一条永远删不掉的占位。
   */
  const task = recoveryProbe(layout, fingerprint).finally(() => {
    recoveries.delete(dir);
  });
  recoveries.set(dir, { task, startedAt: new Date().toISOString() });
  return true;
}

/**
 * ★ T-175：**用户显式点「立刻重试」时走这里。**
 *
 * ## 为什么手点不该走"就地探一发"
 *
 * 这里以前是 `resetBreaker()` + `detect(true)`：清掉裁决 ⇒ 裁决变回 `closed` ⇒
 * **就地跑一发探测，用的是交互预算 `PROBE_TIMEOUT_MS`（10 s）**。
 * 而冷 Mac 上 Metal 首次初始化要 12–21 s（T-172 实测 n=4），被 kill 的探针又什么都不留 ——
 * 也就是说**用户手点的那一发几乎必然超时，而后台自动那发（90 s）反而能成**。
 * 按钮点了跟没点一样，只是多记了一次失败。
 *
 * Manager 的判据（T-175 裁定）：
 *
 * > 那 10 秒是用来保护"**顺带发生**"的请求的（页面加载时的硬件查询），
 * > **不是用来保护一次显式的用户动作的**。用户按下「立刻重试」就是在说"我愿意等" ——
 * > 拿一个为别的目的设的预算去掐他，是把保护用错了对象。
 *
 * 所以手点与冷却到期**走同一条路**：后台、`PROBE_RECOVERY_TIMEOUT_MS`（90 s）、单飞。
 * 手点相对自动的唯一区别是**不必等冷却到期**（`open` 也照起），这正是"显式重试"的含义。
 *
 * ## 单飞怎么和手点共存
 *
 * 已经有一发在跑 ⇒ **加入等待**（返回 `started: false`），不再起第二发、也不报错。
 * 「再起一发」会让两个探针抢同一块 GPU 初始化 —— 那正是断路器本该防的；
 * 「报错」则会让用户以为自己点坏了什么。两种都不对，正确答案是"你要的事情已经在发生了"。
 *
 * **不清 `breakers` 里的计数**：那一发的成败由 `recordProbeOutcome()` 如实记账。
 * 先把失败计数抹掉再探，等于让界面短暂显示一个"已恢复"的假象。
 */
export async function requestBreakerRecovery(
  options: RuntimePathsInput,
): Promise<{ started: boolean; status: BreakerStatusReport }> {
  const layout = await resolveRuntimeLayout(options);
  const started = startBreakerRecovery(layout, await driverFingerprint(layout));
  return { started, status: await breakerStatus(options) };
}

/**
 * 驱动指纹。
 *
 * `isBlacklisted` 的语义是"指纹变了就是新证据，裁决作废"。我们拿不到通用的 GPU 驱动
 * 版本号（那要先跑 advisory 探测，而断路器判断必须发生在探测之前），所以用一个**代理**：
 * 内核版本 + probe 二进制的大小/mtime + backendDir 里的动态库清单。
 * 装/升级一个后端包或换内核都会改变它 —— 这正是"值得重试"的时刻。
 */
async function driverFingerprint(layout: RuntimeLayout): Promise<string> {
  const parts: string[] = [`${os.platform()}/${os.release()}`];
  try {
    const st = await stat(layout.probePath);
    parts.push(`probe:${String(st.size)}:${String(Math.round(st.mtimeMs))}`);
  } catch {
    parts.push('probe:absent');
  }
  try {
    const libs = (await readdir(layout.backendDir))
      .filter((f) => /\.(so|so\.\d+|dll|dylib)$/.test(f))
      .sort();
    parts.push(`libs:${libs.join(',')}`);
  } catch {
    parts.push('libs:absent');
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/* ========================================================================== */
/* 硬件探测                                                                    */
/* ========================================================================== */

export interface ProbeDiagnostics {
  /** 是否真的跑了 probe。断路器打开时为 false（这正是断路器的意义）。 */
  readonly ran: boolean;
  readonly ok: boolean;
  readonly failureKind: ProbeFailureKind | null;
  readonly message: string | null;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly probePath: string;
  readonly probeExists: boolean;
  readonly backendDir: string;
  readonly backendDirExists: boolean;
  readonly devicesFound: number;
  readonly ggmlVersion: string | null;
  /** probe 缺失/失败时，告诉用户下一步该干什么，而不是让他猜。 */
  readonly remediation: Remediation | null;
}

export interface BreakerDiagnostics {
  readonly consecutiveFailures: number;
  readonly threshold: number;
  /** 加速后端此刻是不是被停用着（冷却中或半开待重试都算停用）。 */
  readonly open: boolean;
  readonly blacklistedAt: string | null;
  readonly lastError: string | null;
  readonly driverFingerprint: string | null;
  /** 三态裁决（T-173）。`open` 只说"停不停用"，这一项说"为什么以及接下来怎么办"。 */
  readonly verdict: BreakerVerdict;
  /** 冷却到期时刻（ISO）。null = 没跳闸。**跳闸了它就不可能是 null** —— 那是出口。 */
  readonly retryAt: string | null;
  /** 此刻是不是有一发后台恢复探测正在跑。 */
  readonly recovering: boolean;
  /** 那一发的起跑时刻（ISO）；没在跑就是 null。界面拿它算"已经等了多久"（T-175）。 */
  readonly recoveryStartedAt: string | null;
  /** 恢复那一发的预算（ms）。发出来是为了让界面别硬编那个 90。 */
  readonly recoveryTimeoutMs: number;
}

export interface RuntimeDetection {
  readonly hardware: HardwareInfo;
  readonly layout: RuntimeLayout;
  readonly probe: ProbeDiagnostics;
  readonly breaker: BreakerDiagnostics;
  /** 断路器拉黑的后端（cpu 永不入列）。 */
  readonly blacklistedBackends: Backend[];
  readonly installedBackends: Backend[];
  /**
   * **advisory 探测**（nvidia-smi / sysfs DRM / system_profiler / DXGI）认为本机
   * 可能支持的后端，取所有探到的 GPU 的 `candidateBackends` 并集。
   *
   * 它是 L2 适用性判定里**唯一不依赖"包已经装了"的证据**，也就是解开
   * 「要先有 A 才能装 B，而 A 要 B 装好才能被发现」那个环的东西
   * （见 `packages/runtime/src/backends/applicability.ts` 的文件头）。
   *
   * ⚠️ 它**不是**"这个后端能用"的结论 —— 那个结论只能来自 probe。
   * 空数组的含义是"没有独立证据"，不是"本机没有 GPU"。
   */
  readonly advisoryBackends: Backend[];
}

/** 已装后端包 = store 里真实存在的 backend manifest。cpu 是内置 L1，恒为已装。 */
async function installedBackendsFromStore(modelsRoot: string): Promise<Set<Backend>> {
  const store = new ArtifactStore(modelsRoot);
  const packs = await store.listManifests<InstalledBackendPack>('backend');
  return new Set<Backend>(['cpu', ...packs.map((p) => p.backend)]);
}

function probeRemediation(probe: ProbeResult, layout: RuntimeLayout): Remediation | null {
  if (probe.ok) return null;
  if (probe.kind === 'missing_probe' || probe.kind === 'missing_backend_dir') {
    return {
      action: 'install_backend',
      params: { probePath: layout.probePath, backendDir: layout.backendDir },
      labelZh: '安装后端包（其中含 probe 与 ggml 后端库）',
      label: 'Install a backend pack (it ships the probe and the ggml backends)',
    };
  }
  return {
    action: 'retry_probe',
    params: { backendDir: layout.backendDir, timeoutMs: PROBE_TIMEOUT_MS },
    labelZh: '重试硬件探测',
    label: 'Retry hardware detection',
  };
}

function toDiagnostics(probe: ProbeResult, layout: RuntimeLayout, ran: boolean): ProbeDiagnostics {
  return {
    ran,
    ok: probe.ok,
    failureKind: probe.ok ? null : probe.kind,
    message: probe.ok ? null : probe.message,
    durationMs: probe.durationMs,
    timeoutMs: PROBE_TIMEOUT_MS,
    probePath: layout.probePath,
    probeExists: layout.probeExists,
    backendDir: layout.backendDir,
    backendDirExists: layout.backendDirExists,
    devicesFound: probe.ok ? probe.output.devices.length : 0,
    ggmlVersion: probe.ok ? probe.output.ggmlVersion : null,
    remediation: probeRemediation(probe, layout),
  };
}

/** 用已经拿到的 ProbeResult 组装 HardwareInfo —— 与 `detectHardware()` 同一批函数。 */
async function composeHardware(
  layout: RuntimeLayout,
  probe: ProbeResult,
  advisory: AdvisoryDetection,
  installedBackends: Set<Backend>,
  blacklistedBackends: Set<Backend>,
): Promise<HardwareInfo> {
  const [cpu, disks] = await Promise.all([
    detectCpu(),
    detectDisks({ modelsRoot: layout.modelsRoot, runtimesRoot: layout.runtimesRoot }),
  ]);
  return buildHardwareInfo({
    os: detectOs(),
    cpu,
    ram: detectMemory(),
    unifiedMemory: detectUnifiedMemory(),
    disks,
    advisory,
    probe,
    installedBackends,
    blacklistedBackends,
    /*
     * ★ T-168：`backendDir` 是单值的，一次探测只扫一个包的目录。
     * 少了这一项，"这个包没被加载"会被当成"这个包的驱动坏了"报给用户 ——
     * 一句具体的、错的诊断。用 `packages/runtime` 那**同一个**函数，
     * 不在这里再写一份（`detectHardware()` 走的也是它）。
     */
    probedBackends: await probedBackendsInDir(layout.backendDir),
  });
}

export interface DetectRuntimeHardwareOptions extends RuntimePathsInput {
  /** 已安装后端包；不传就从 store 的 backend manifest 里读（daemon 的真实状态）。 */
  readonly installedBackends?: ReadonlySet<Backend> | undefined;
  /**
   * 判断冷却期是否到期用的"现在"。**只给测试用；生产侧不传，行为与写死 `new Date()`
   * 逐字相同**（同 `SelfCheckInput.platform` 那条注释的理由）。
   *
   * 没有它，"冷却到期之后会自愈"这条只能靠**真等一分钟**来测 ——
   * 而一个要等一分钟的测试，等于一条迟早会被 skip 掉的测试。
   *
   * ⚠️ 它**只影响读**（`breakerVerdict`）。恢复探测跑完后记账仍用真实时间，
   * 否则会把一个假的 `retryAt` 写进 state 里。
   */
  readonly now?: Date;
}

/**
 * 一次完整探测。`GET /api/runtime/hardware` 的真实数据源。
 *
 * 断路器接线（ADR-003 决策 3）：
 *   - 探测前 `isBlacklisted` 一票否决 —— 跳闸后不再每次请求都付 10s 超时；
 *   - 探测后 `recordProbeOutcome` 记账。
 *
 * ⚠️ 已知代价：`detectHardware()` 只回传 `HardwareInfo`，**不回传 `ProbeResult`**，
 * 而断路器要的正是后者，所以这里先自己跑一次 `runProbe`。为了不把 10s 超时付两遍，
 * 只有当重跑**不花钱**时才继续调 `detectHardware()`：
 *   - probe 成功 —— 它刚刚才返回，再跑一次是毫秒级；
 *   - `missing_probe` / `missing_backend_dir` —— `runProbe` 只做 existsSync，微秒级
 *     （本机就是这一支：没人构建过 probe）。
 * 其余失败（timeout / crash）直接复用已有结果组装，绝不重跑。
 * 根治办法是让 `packages/runtime` 的 `detectHardware()` 把 `ProbeResult` 一并返回 ——
 * 那个包不在本次改动范围内。
 */
export async function detectRuntimeHardware(
  options: DetectRuntimeHardwareOptions,
): Promise<RuntimeDetection> {
  const layout = await resolveRuntimeLayout(options);
  const fingerprint = await driverFingerprint(layout);
  const installed = new Set<Backend>(
    options.installedBackends ?? (await installedBackendsFromStore(layout.modelsRoot)),
  );
  /*
   * advisory 探测在这里跑**一次**，然后同时喂给 `detectHardware()` 与
   * `composeHardware()`。它是 L2 解环用的独立证据（见 RuntimeDetection.advisoryBackends），
   * 而 macOS 上 `system_profiler` 要几秒 —— 探两遍是实打实的成本。
   */
  const advisory = await detectGpus();

  let breaker = breakers.get(layout.backendDir) ?? emptyBreaker();
  let ran = true;
  let probe: ProbeResult;

  const verdict = breakerVerdict(breaker, fingerprint, options.now);
  if (verdict === 'closed') {
    probe = await runProbe({ probePath: layout.probePath, backendDir: layout.backendDir });
    breaker = recordProbeOutcome(breaker, probe, fingerprint);
    breakers.set(layout.backendDir, breaker);
  } else {
    ran = false;
    /*
     * 冷却到期 ⇒ 后台放一发恢复探测。**当次请求不等它**（预算 90 s，见 startBreakerRecovery）。
     * 这一发的结果由它自己写回 breakers，下一次 detect 就能看见复位。
     */
    if (verdict === 'recover') startBreakerRecovery(layout, fingerprint);
    probe = {
      ok: false,
      kind: 'exec_error',
      message:
        `probe skipped: circuit breaker open after ${String(breaker.consecutiveFailures)} ` +
        `consecutive failures (last: ${breaker.lastError ?? 'no detail'}); ` +
        (verdict === 'recover'
          ? 'cooldown elapsed, a recovery probe is running in the background'
          : `next retry at ${breaker.retryAt ?? 'unknown'}`),
      durationMs: 0,
      stderr: '',
    };
  }

  const after = breakerVerdict(breaker, fingerprint, options.now);
  // 冷却中(open)与半开待重试(recover)**都还是停用状态** —— 只有 closed 才是能用。
  const open = after !== 'closed';
  const blacklisted = new Set<Backend>(open ? ACCELERATOR_BACKENDS : []);

  const cheapToRerun =
    ran && (probe.ok || probe.kind === 'missing_probe' || probe.kind === 'missing_backend_dir');

  const hardware = cheapToRerun
    ? await detectHardware({
        probePath: layout.probePath,
        backendDir: layout.backendDir,
        modelsRoot: layout.modelsRoot,
        runtimesRoot: layout.runtimesRoot,
        installedBackends: installed,
        blacklistedBackends: blacklisted,
        advisory,
      })
    : await composeHardware(layout, probe, advisory, installed, blacklisted);

  const advisoryBackends = [...new Set(advisory.gpus.flatMap((g) => g.candidateBackends))];

  return {
    hardware,
    layout,
    probe: toDiagnostics(probe, layout, ran),
    breaker: {
      consecutiveFailures: breaker.consecutiveFailures,
      threshold: CIRCUIT_BREAKER_THRESHOLD,
      open,
      blacklistedAt: breaker.blacklistedAt,
      lastError: breaker.lastError,
      driverFingerprint: breaker.driverFingerprint,
      verdict: after,
      retryAt: breaker.retryAt,
      recovering: breakerRecovery(layout.backendDir) !== null,
      recoveryStartedAt: breakerRecoveryStartedAt(layout.backendDir),
      recoveryTimeoutMs: PROBE_RECOVERY_TIMEOUT_MS,
    },
    blacklistedBackends: [...blacklisted],
    installedBackends: [...installed],
    advisoryBackends,
  };
}

/** 本机的后端偏好顺序（未剔除失败项）。UI 用它解释"为什么推荐这个包"。 */
export function backendPreference(hardware: HardwareInfo): Backend[] {
  return preferenceOrder(hardware.os, hardware.gpus[0]?.vendor ?? null);
}

/* ========================================================================== */
/* 自检                                                                        */
/* ========================================================================== */

/**
 * whisper.cpp 官方样例 `samples/jfk.wav`。
 *
 * 11.000s 是本机 ffprobe 实测值（不是从文件名猜的），参考文本取自 whisper.cpp 仓库。
 * RTF = 墙钟 / 音频时长，没有真实时长这个数就没有意义 —— 所以换成别的音频时必须
 * 由调用方显式给出时长与参考文本，否则本模块拒绝跑（见下）。
 */
const JFK_AUDIO_SECONDS = 11.0;
const JFK_TRANSCRIPT =
  'and so my fellow americans ask not what your country can do for you ' +
  'ask what you can do for your country';

/** 仓库内的开发期样例路径（apps/daemon/{src,dist}/runtime → 仓库根，4 层）。 */
function repoSampleAudio(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..', 'vendor', 'whisper.cpp', 'samples', 'jfk.wav');
}

async function firstExistingFile(...candidates: (string | undefined)[]): Promise<string | null> {
  for (const c of candidates) {
    if (c !== undefined && c.length > 0 && (await isFile(c))) return c;
  }
  return null;
}

/**
 * 自检用最小的已装模型（selfTest.ts 的建议）：按体积升序取第一个 .bin。
 *
 * ## ★ T-166：**必须排除 silero**，而且这条以前不排也没事、现在不排就会出事
 *
 * `by-name/asr/` 里在 T-149 之前躺着 VAD 权重（`ggml-silero-*.bin`）——
 * 而 VAD 权重恰恰是这个桶里**最小**的那个（约 1 MB，whisper base 是 140 MB）。
 * 于是"按体积升序取第一个"在老布局的机器上会稳定挑中 VAD 权重，
 * whisper 拿它去转写 → `invalid model data (bad magic)` → 自检 `passed:false`。
 *
 * 为什么以前没人撞上：**因为自检结果从来没有被记下来过**
 * （`InstalledBackendPack.selfTest` 全仓恒为 null）。用户点一次看到一句失败，
 * 刷新就没了，没人追。T-166 把回写接通之后，同一个错误会变成卡片上一条
 * **持续的**"自检失败"红字，钉在一个完全好用的包上 —— 比原来坏得多。
 *
 * > 「把一个东西从『没有』变成『有』，会让所有拿它的缺席当前提的地方失去意义 ——
 * >  而其中只有一部分会自己红出来。」
 *
 * 排除规则与 `pipeline/setup.ts` 里 ASR 权重那条**逐字相同**
 * （`scanByName(..., { ext: '.bin', excludes: 'silero' })`）：同一个问题不许有两个答案。
 * 它同时覆盖了 `findWhisperVadWeights()` 会选中的那一份 —— 那个函数要求文件名含
 * `silero`，所以按 `silero` 排除必然把它排掉。
 */
async function smallestInstalledModel(modelsRoot: string): Promise<string | null> {
  const dir = path.join(modelsRoot, 'by-name', 'asr');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const sized: { file: string; size: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith('.bin')) continue;
    if (name.toLowerCase().includes('silero')) continue;
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (st.isFile()) sized.push({ file: full, size: st.size });
    } catch {
      /* 读不到就跳过 */
    }
  }
  sized.sort((a, b) => a.size - b.size);
  return sized[0]?.file ?? null;
}

export interface SelfTestBlocked {
  readonly status: 'blocked';
  /** 缺了哪些前提。空数组不可能出现 —— blocked 必然有原因。 */
  readonly missing: string[];
  readonly message: string;
  readonly messageZh: string;
  readonly remediation: Remediation;
  readonly resolved: { whisperCli: string | null; model: string | null; audio: string | null };
  /** 请求方点名要测的包（`{id}`）。没点名时 `null`。 */
  readonly requestedPackId: string | null;
}

export interface SelfTestRan {
  readonly status: 'ran';
  readonly outcome: SelfTestOutcome;
  /** 人话摘要，绝不编造没测到的数字（`formatSelfTest` 保证）。 */
  readonly summary: string;
  readonly audioSeconds: number;
  readonly timeoutMs: number;
  readonly resolved: { whisperCli: string; model: string; audio: string };
  readonly requestedPackId: string | null;
  /**
   * **这次跑的 whisper-cli 是哪个已安装包提供的**（T-166 ①）。
   *
   * 这是"结果该记到谁头上"的**唯一**合法证据，而且它是**结构性**的：
   * 由 `resolveBackendTool()` 按安装记录反查目录得出，与任何日志文字无关。
   *
   * ⚠️ 不要拿 `outcome.backendUsed` 当这个用 —— 那是从 whisper 的 stderr 里
   * 解析出来的**日志文字**（`'CPU'` / `'CPU (ggml-cpu-zen4)'` / GPU 设备名 / `null`），
   * 与 `Backend` 那个小写枚举（`'cpu'`）**永不相等**。T-164 的认领规则正是这样
   * 写成了一条恒假的比较：`asked.backend !== used` 在真机上恒真 →
   * **`selfTest` 在任何真实机器上都写不进去**，三条 UI 分支照旧不亮。
   * 见 `packages/runtime/src/selfTest.ts` 的 `parseBackendUsed()`。
   *
   * `null` 的含义是"这个二进制不属于任何已安装的包"（`OPENMEMO_WHISPER_CLI`
   * 覆盖、`bin/runtime` 里的手工布局、装到一半没写 manifest）——
   * 那种情况下**不认领**，而不是随便挑一个包按上去。
   */
  readonly packId: string | null;
  /** 上面那个包声明的后端。`packId` 为 null 时也是 null。 */
  readonly packBackend: Backend | null;
}

export type BackendSelfTestResult = SelfTestBlocked | SelfTestRan;

export interface RunBackendSelfTestOptions extends RuntimePathsInput {
  readonly threads?: number | undefined;
  /**
   * **只自测这一个已安装包**（T-166 ①）。不传 = 按统一的选择规则挑一个。
   *
   * 装了 CPU 与 Vulkan 两个包的用户，此前只能测到"当前被选中的那个"——
   * 在另一张卡片上点自测，跑的还是同一个二进制。钉住之后：
   *   · 找得到 → 跑的确实是那个包里的 whisper-cli（ggml 只从二进制自身目录
   *     dlopen 后端库，所以"哪个包的二进制"就等于"哪套后端库"）；
   *   · 找不到 → `blocked`，**绝不回退到别的包再把结果记到这张卡片上**。
   */
  readonly packId?: string | undefined;
}

/**
 * 真实自检：`@openmemo/runtime` 的 `runSelfTest()`，跑一次真推理并量 RTF。
 *
 * 三个前提任缺其一就返回 blocked + remediation：
 *   引擎二进制 / ASR 模型 / 测试音频（含其真实时长与参考文本）。
 * **绝不返回伪造的 passed** —— ADR-003 决策 3 + ADR-004 决策 3。
 */
export async function runBackendSelfTest(
  options: RunBackendSelfTestOptions,
): Promise<BackendSelfTestResult> {
  const layout = await resolveRuntimeLayout(options);
  const env = process.env;
  const requestedPackId =
    options.packId !== undefined && options.packId.length > 0 ? options.packId : null;

  /*
   * ★ T-160：这里原来**只搜 `bin/runtime`**，而安装器把后端包解到
   * `<modelsRoot>/by-name/backend/<archive>/`。用户点「自测」拿到的
   * `409 SELF_TEST_BLOCKED missing:["whisper-cli"]` 就是这一行，
   * 而**同一台实例**上 `/api/daemon/status` 报 `missing: []`、`/api/selfcheck` 报
   * `tool.whisperCli ok` 并给出了完整路径、文件也确实在盘上（976,312 B）。
   * 后果：`selfTest` 永远是 null →「自检结果」「anyFailed 横幅」三条 UI 分支永不亮。
   *
   * 修法**不是**给它补一条搜索路径，是让它去问 `findInBackendPacks()` —— 见文件头。
   *
   * ★ T-166 ①：改用 `resolveBackendTool()`（同一个解析器的完整视角），
   * 因为自检还要回答"**这次跑的是哪个包**"。只回路径的 `findInBackendPacks()`
   * 天然说不出这一点，而说不出这一点就只能去猜 —— 猜法就是 T-164 那条恒假的
   * 字符串比较（`'CPU' !== 'cpu'`）。
   */
  const resolved = await resolveBackendTool(
    layout.modelsRoot,
    whisperCliName(),
    requestedPackId === null ? undefined : { packId: requestedPackId },
  );

  /*
   * 钉住某个包时，**只**认那个包给的二进制：环境变量覆盖与 `bin/runtime` 里的
   * 手工布局都不属于任何包，拿它们去跑再把结果记到用户点的那张卡片上，
   * 就是在为另一个二进制作证（`scripts/selfcheck.mjs` 的同一条判据）。
   */
  const whisperCli =
    requestedPackId !== null
      ? (resolved?.path ?? null)
      : await firstExistingFile(
          env['OPENMEMO_WHISPER_CLI'],
          (await findUnder(layout.runtimesRoot, named(whisperCliName()))) ?? undefined,
          resolved?.path ?? undefined,
        );

  /*
   * 认领证据：**只有当真正要跑的那个路径就是解析器给的那个**，才能说
   * "这次跑的是 X 包"。环境变量赢了的时候 `whisperCli !== resolved.path`，
   * 于是 packId 为 null —— 不认领。与 `scripts/selfcheck.mjs:244` 同一条判据。
   */
  const ranFrom =
    resolved !== null && whisperCli !== null && whisperCli === resolved.path ? resolved : null;

  const model = await firstExistingFile(
    env['OPENMEMO_ASR_MODEL'],
    (await smallestInstalledModel(layout.modelsRoot)) ?? undefined,
    path.join(layout.modelsRoot, 'ggml-tiny.en.bin'),
    path.join(layout.modelsRoot, 'ggml-base.en.bin'),
    path.join(layout.modelsRoot, 'ggml-base.bin'),
  );

  const customAudio = env['OPENMEMO_SELFTEST_AUDIO'];
  const audio = await firstExistingFile(
    customAudio,
    path.join(options.dataDir, 'selftest', 'jfk.wav'),
    repoSampleAudio(),
  );

  /*
   * 自带音频必须自带时长与参考文本。
   * 没有真实时长就算不出 RTF，没有参考文本就分不清"跑通了"和"跑出了垃圾"
   * （半坏的 GPU kernel 会 exit 0 并吐重复 token）。这两个都不能猜。
   */
  // 认得出是 jfk.wav 才用内置的时长/参考文本；别的音频一律要求调用方自己给。
  const isKnownSample = audio !== null && path.basename(audio).toLowerCase() === 'jfk.wav';
  const secondsEnv = Number(env['OPENMEMO_SELFTEST_AUDIO_SECONDS'] ?? '');
  const audioSeconds = isKnownSample
    ? JFK_AUDIO_SECONDS
    : Number.isFinite(secondsEnv) && secondsEnv > 0
      ? secondsEnv
      : 0;
  const transcript = isKnownSample
    ? JFK_TRANSCRIPT
    : (env['OPENMEMO_SELFTEST_TRANSCRIPT'] ?? '').toLowerCase();

  const missing: string[] = [];
  if (whisperCli === null) missing.push('whisper-cli');
  if (model === null) missing.push('asr-model');
  if (audio === null) missing.push('test-audio');
  if (audio !== null && (audioSeconds <= 0 || transcript.length === 0)) {
    missing.push('audio-duration-and-reference-transcript');
  }

  if (missing.length > 0 || whisperCli === null || model === null || audio === null) {
    return {
      status: 'blocked',
      missing,
      message: `self-test cannot run: missing ${missing.join(', ')}`,
      messageZh:
        `自检无法运行，缺少：${missing.join('、')}。` +
        (requestedPackId !== null && whisperCli === null
          ? `已安装的 ${requestedPackId} 包里没有 ${whisperCliName()} —— ` +
            '不会拿别的包的二进制去跑再把结果记到它头上（那是发明证据）。'
          : '') +
        '自检必须跑一次真实推理（ADR-003 决策 3），缺前提时只报 blocked，不会返回伪造的"通过"。',
      remediation: {
        action: missing.includes('asr-model') ? 'install_model' : 'install_backend',
        params: {
          missing: missing.join(','),
          runtimesRoot: layout.runtimesRoot,
          modelsRoot: layout.modelsRoot,
        },
        labelZh: missing.includes('asr-model') ? '去安装 ASR 模型' : '去安装后端包',
        label: missing.includes('asr-model') ? 'Install an ASR model' : 'Install a backend pack',
      },
      resolved: { whisperCli, model, audio },
      requestedPackId,
    };
  }

  const outcome = await runSelfTest({
    whisperCliPath: whisperCli,
    modelPath: model,
    audioPath: audio,
    audioDurationSeconds: audioSeconds,
    expectedTranscript: transcript,
    ...(options.threads === undefined ? {} : { threads: options.threads }),
  });

  return {
    status: 'ran',
    outcome,
    summary: formatSelfTest(outcome, audioSeconds),
    audioSeconds,
    timeoutMs: SELF_TEST_TIMEOUT_MS,
    resolved: { whisperCli, model, audio },
    requestedPackId,
    packId: ranFrom?.packId ?? null,
    packBackend: ranFrom?.backend ?? null,
  };
}
