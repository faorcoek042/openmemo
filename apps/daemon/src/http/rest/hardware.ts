/**
 * 本机硬件快照 —— `GET /api/runtime/hardware` 的数据源。
 *
 * ★ 本文件曾经是一份只依赖 `node:os` 的手写兜底（`gpus: []` 写死、后端可用性靠猜）。
 * 现在它**只是转接层**：权威实现是 `@openmemo/runtime` 的 `detectHardware()`，
 * 由 `../../runtime/setup.js` 负责解析路径、持有 probe 断路器并调用它。
 *
 * 保留的本地实现只剩两个纯工具（`currentArch` / `volumeBytes`），因为 models.ts 与
 * backends.ts 在用；硬件事实一律来自 runtime 包，daemon 不再自己判断。
 *
 * 诚实边界不变（ADR-004 决策 3）：
 *   - probe 子进程没构建出来时，`runProbe` 报 `missing_probe`，`buildHardwareInfo` 于是
 *     给出 `gpus: []` 且每个后端都带 `unavailableReason: "probe did not complete: …"`。
 *     **不会编造任何一块 GPU** —— 本机（Linux x86_64 无 GPU）就是这个结果。
 *   - 自检跑不了就报 blocked + remediation，绝不返回伪造的 passed。
 */
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ArtifactStore } from '@openmemo/downloader';
import { detectDisks, detectMemory } from '@openmemo/runtime';
import type {
  Arch,
  Backend,
  BackendSelfTest,
  GetBreakerResponse,
  GetHardwareResponse,
  InstalledBackendPack,
} from '@openmemo/shared';

import type { AppPaths } from '../../config/paths.js';
import {
  breakerSnapshot,
  breakerStatus,
  detectRuntimeHardware,
  requestBreakerRecovery,
  runBackendSelfTest,
  type BreakerDiagnostics,
  type RunBackendSelfTestOptions,
  type ProbeDiagnostics,
  type RuntimeDetection,
} from '../../runtime/setup.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';
/*
 * ⚠️ 与 `state.ts` 之间是一个**调用期**的循环引用（它 import 本文件的
 * `detectLocalHardware`）。两边都只在函数体里用对方，模块初始化期零依赖，ESM 下成立。
 * 之所以接受这个环而不是抄一份：**抄一份就是两条失效规则**，而"同一件事在两处
 * 各算一次、只修了一处"正是本次要修的病。真要解环，正解是把指纹提到一个共同的
 * 下层模块（那要动 state.ts —— 它此刻在别人手里，见回执 §纪律）。
 */
import { canonicalPackFingerprint } from './state.js';

/** 硬件快照 id。fit 判定是针对某一份快照算出来的，UI 用它判断缓存是否失效。 */
export const HARDWARE_SNAPSHOT_ID = 'hw-local';

export function currentArch(): Arch {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/** 卷容量。取不到时返回 0/0 而不是编一个数。 */
async function volumeBytes(dir: string): Promise<{ freeBytes: number; totalBytes: number }> {
  try {
    const st = await fs.statfs(dir);
    return {
      freeBytes: Number(st.bavail) * Number(st.bsize),
      totalBytes: Number(st.blocks) * Number(st.bsize),
    };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

export { volumeBytes };

/**
 * 一次性探测（`RestState.create` 在启动时调一次并缓存）。
 *
 * ★ 返回**整份 `RuntimeDetection`** 而不只是 `HardwareInfo`：L2 适用性判定还需要
 * `advisoryBackends`（那是解开"要先装才能被发现"那个环的唯一独立证据，
 * 见 `packages/runtime/src/backends/applicability.ts`）。只回 `HardwareInfo`
 * 就等于在这一层把它丢掉，而丢掉它正是死锁至今没解开的原因之一。
 *
 * @param modelsRoot 模型根目录 —— 调用方（state.ts）手里只有这一个路径。
 * @param dataDir    数据目录。不传时按 `<dataDir>/models` 的约定从 modelsRoot 反推：
 *   runtime 包需要 `<dataDir>/bin/runtime` 才能找到 probe 与 ggml 后端库，
 *   反推不出来（例如 `OPENMEMO_MODELS` 指到了别处）就退回 modelsRoot 的父目录 ——
 *   **宁可 probe 报 missing_probe，也不硬编码一个假路径**。
 */
export async function detectLocalHardware(
  modelsRoot: string,
  dataDir?: string,
): Promise<RuntimeDetection> {
  return detectRuntimeHardware({
    dataDir: dataDir ?? inferDataDir(modelsRoot),
    modelsDir: modelsRoot,
  });
}

/**
 * `<dataDir>/models` 的约定反推 dataDir。
 *
 * **导出**：`startPackInstall` 的捂热步骤要的是同一个 `RuntimePathsInput`，
 * 而 `RestState` 手里只有 `modelsRoot`（它不存 dataDir）。两边各写一份反推
 * 正是本仓「装了却找不到」那一族缺陷的成因（见 state.ts:170、setup.ts:190 的 T-160 段），
 * 所以这里只有这一份。
 */
export function inferDataDir(modelsRoot: string): string {
  const parent = modelsRoot.replace(/[/\\]+$/, '');
  const cut = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\'));
  return cut > 0 ? parent.slice(0, cut) : parent;
}

/* ========================================================================== */
/* 路由                                                                        */
/* ========================================================================== */

export interface RuntimeRoutesDeps {
  /**
   * 路径全部从 `AppPaths` 取，本模块不硬编码任何一个。
   * runtime 包需要的 `runtimesRoot` = `<dataDir>/bin/runtime`（与 pipeline/setup.ts 同源）。
   */
  readonly paths: Pick<AppPaths, 'dataDir' | 'modelsDir'>;
  /**
   * 已安装后端包的真实来源（daemon 状态）。不传时 setup.ts 直接读 store 的
   * `manifests/backend/*.json` —— 同一份事实，只是少绕一层。
   */
  readonly installedBackends?: () => Promise<readonly Backend[]>;
  /**
   * 自检执行器。**默认就是真的那个**（`runBackendSelfTest`），可注入是为了让
   * 「跑完之后结果有没有被记回安装记录」这条接线**能在没有 whisper-cli 的机器上被验到**。
   *
   * 为什么必须验接线而不是只验 `recordSelfTest()` 本身：这个仓库反复吃亏的形状
   * 就是「函数写好了、没有人调它」——`useDeleteNoteMutation`（笔记删不掉）、
   * `ERROR_MESSAGES_ZH`（中文错误不显示）、`stashForRollback`（回滚永远不可用）
   * 全是这一族。单测 `recordSelfTest` 在那种情况下照样全绿。
   *
   * 与 `RecorderDeps.openStream` / `TranscribeRunnerDeps.pipelineFor` 同一条边界：
   * **被顶替的只有引擎**，路由、认领规则、落盘全是产品自己的路径。
   */
  readonly runSelfTest?: (
    options: RunBackendSelfTestOptions,
  ) => Promise<Awaited<ReturnType<typeof runBackendSelfTest>>>;
}

/** 契约的 `GetHardwareResponse` 之外附加的可观测字段（只增不改，前端可忽略）。 */
export interface RuntimeDiagnostics {
  readonly probe: ProbeDiagnostics;
  readonly breaker: BreakerDiagnostics;
  readonly blacklistedBackends: Backend[];
  readonly installedBackends: Backend[];
  /**
   * ★ T-195：**advisory 认为本机可能支持的后端。**
   *
   * 此前 `RuntimeDetection` 一直算着它（`setup.ts` 的 `advisoryBackends`），
   * 而这里**没有把它转出去** —— 于是前端拿不到任何"不依赖已装包"的 GPU 证据，
   * 硬件卡只好拿 `hardware.gpus`（**纯粹由 probe 枚举结果构造**）去回答
   * "这台机器有没有显卡"。两个问题，一个答案。
   */
  readonly advisoryBackends: Backend[];
  /**
   * ★ T-195：advisory **逐块看见的**显示适配器 + 探测过程中的问题。
   * 面板要说的是"我们知道什么"，而 `hardware.gpus` 只说得出"探针枚举到什么"。
   */
  readonly advisoryGpus: RuntimeDetection['advisoryGpus'];
  readonly advisoryWarnings: readonly string[];
  readonly paths: {
    readonly probePath: string;
    readonly backendDir: string;
    readonly modelsRoot: string;
    readonly runtimesRoot: string;
  };
}

export interface HardwareResponseWithDiagnostics extends GetHardwareResponse {
  readonly runtime: RuntimeDiagnostics;
}

function toDiagnostics(d: RuntimeDetection): RuntimeDiagnostics {
  return {
    probe: d.probe,
    breaker: d.breaker,
    blacklistedBackends: d.blacklistedBackends,
    installedBackends: d.installedBackends,
    advisoryBackends: d.advisoryBackends,
    advisoryGpus: d.advisoryGpus,
    advisoryWarnings: d.advisoryWarnings,
    paths: {
      probePath: d.layout.probePath,
      backendDir: d.layout.backendDir,
      modelsRoot: d.layout.modelsRoot,
      runtimesRoot: d.layout.runtimesRoot,
    },
  };
}

/**
 * runtime 子域路由（`createXRoutes(deps)` + `handle()` 约定，见 notes.ts）。
 *
 * 接进 `main.ts` 的 `routers` 后会**先于** models.ts 的同名路由命中，于是：
 *   - `/api/runtime/hardware` 拿到完整的 `AppPaths`（不必从 modelsRoot 反推 dataDir），
 *     并额外回传断路器/probe 诊断，让降级链**可观测**而不是隐形；
 *   - `/api/backends/selftest` 从 501 桩变成真实的 `runSelfTest()`。
 */
export function createRuntimeRoutes(deps: RuntimeRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  // 探测会 spawn（nvidia-smi / probe），不该每个请求都跑一遍；`?refresh=1` 显式绕过缓存。
  let cached: RuntimeDetection | null = null;
  /** 上一次结构探测时"机器上装了什么"。见 `structuralFingerprint()`。 */
  let cachedFingerprint: string | null = null;

  /**
   * ★ T-193 ②：这份缓存**此前唯一的失效方式是 `?refresh=1`**，
   * 而 `?refresh=1` 在整个网页里**只有一个调用点** —— 断路器 open→closed 的那一刻
   * （`features/runtime/api.ts` 的 `useHardwareRefresh`）。
   *
   * 也就是说：**只要断路器不跳，这份快照可以停在 daemon 第一次探测的那一刻，永远。**
   * `state.ts` 那份同源快照早就有结构化失效（`machineFingerprint()`，T-191 改成按内容算），
   * 而这一份漏了 —— 又是"同一件事在两处各算一次，只修了一处"。
   *
   * 判据与那边**逐字同一条**：装了什么变了 ⇒ 快照必须重算。
   * 复用的是 `state.ts` 导出的那个 `canonicalPackFingerprint`（**不是抄一份**）——
   * 抄一份就等于两条规则，那正是这次要修的病。
   *
   * ⚠️ 不 spawn、不探测：只是一次 `listManifests` 的 readdir + 序列化。
   */
  const structuralFingerprint = async (): Promise<string> => {
    try {
      const packs = await new ArtifactStore(
        deps.paths.modelsDir,
      ).listManifests<InstalledBackendPack>('backend');
      return packs
        .map((p) => canonicalPackFingerprint(p))
        .sort()
        .join('|');
    } catch {
      /*
       * 读不到安装记录时返回一个**固定**的哨兵，而不是 `Date.now()` 之类。
       * 返回一个每次都不同的值会让缓存彻底失效 ⇒ 每个请求都 spawn 一次 probe，
       * 那是把"缓存永不失效"换成"缓存永远无效"—— 同一枚硬币的另一面。
       */
      return '<unreadable>';
    }
  };

  /**
   * ★ T-193 ①：**便宜且一直在变的那几格，根本不进缓存。**
   *
   * ── 判断依据（这一条才是本次修法的核心）──────────────────────────────────────
   *
   * `HardwareInfo` 把两类**寿命完全不同**的事实装进了同一个 blob：
   *
   * | 类 | 字段 | 取一次的代价 | 什么时候变 |
   * |---|---|---|---|
   * | **结构事实** | cpu / gpus / backends / unifiedMemory / os | **spawn**：`runProbe`(≤10 s) + `detectGpus`(nvidia-smi / system_profiler，秒级) | 换机器、装卸后端包、驱动升级 |
   * | **环境读数** | `disks[].freeMB`、`ram.availableMB` | `statfs` ×2 + `os.freemem()`，**零 spawn** | **一直在变**（任何一次下载，甚至别的程序） |
   *
   * 缓存的存在理由（"探测要 spawn"）**只对第一类成立**。
   * 缓存第二类不省任何东西，代价却是**界面上那个数是假的**：
   * `[实测 2026-08-10，本机 19500 端口的一次性 daemon]`
   * 写进 500 MB 之后连查两次 `GET /api/runtime/hardware` ⇒ `36147 MB` 纹丝不动；
   * 手工 `?refresh=1` ⇒ `35623 MB`。差 524 MB，是真的。
   *
   * 所以这几格改成**每次请求现算**。这让"下了 112 MB 之后那一格必须变"
   * **由构造成立** —— 与任何失效规则是否触发无关，哪怕断路器一辈子不跳。
   *
   * ── `detectedAt` 为什么**不**跟着刷新 ────────────────────────────────────────
   *
   * 卡片上那句「探测于 X」说的是**结构探测**（我们什么时候去问过你的 GPU），
   * 把它刷成"现在"就是在声称刚跑过一次 probe —— 而我们恰恰**没有**跑，
   * 那才是这次省下来的东西。所以它保持结构快照的时刻。
   * 界面那一侧把这两类分开标注（见 `HardwareCard`），不让实时读数
   * 被"探测于 X"这句话罩住。
   */
  const withLiveReadings = async (d: RuntimeDetection): Promise<RuntimeDetection> => ({
    ...d,
    hardware: {
      ...d.hardware,
      disks: await detectDisks({
        modelsRoot: d.layout.modelsRoot,
        runtimesRoot: d.layout.runtimesRoot,
      }),
      ram: detectMemory(),
    },
  });

  const detect = async (refresh: boolean): Promise<RuntimeDetection> => {
    const fp = await structuralFingerprint();
    if (cached !== null && !refresh && fp === cachedFingerprint) return withLiveReadings(cached);
    const installed = deps.installedBackends ? await deps.installedBackends() : undefined;
    cached = await detectRuntimeHardware({
      dataDir: deps.paths.dataDir,
      modelsDir: deps.paths.modelsDir,
      ...(installed === undefined ? {} : { installedBackends: new Set<Backend>(installed) }),
    });
    cachedFingerprint = fp;
    return withLiveReadings(cached);
  };

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;

      // ---- GET /api/runtime/hardware ----
      if (p === '/api/runtime/hardware') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        /*
         * `refresh=1` 重新探测但**保留**断路器计数（否则连续失败永远累计不到阈值）。
         *
         * ★ T-175：`reset=1` = **用户显式重试**，现在走的是恢复那条路
         * （后台 + `PROBE_RECOVERY_TIMEOUT_MS` 90 s + 单飞），**不再**就地跑一发。
         *
         * 以前是 `resetBreaker()` + `detect(true)`：清掉裁决 ⇒ 裁决变 `closed` ⇒
         * 就地探一发，用的是**交互预算 10 s**。而冷 Mac 上 Metal 首次初始化要 12–21 s
         * ⇒ **用户手点的那一发几乎必然超时，反而是后台自动那发能成** ——
         * 按钮点了跟没点一样，只是多记一次失败。
         *
         * Manager 判据（T-175）：那 10 秒是保护"顺带发生"的请求的，不是保护一次显式用户动作的；
         * 用户按下「立刻重试」就是在说"我愿意等"。
         *
         * 当次请求**立刻返回**（不 await 那一发），界面据此显示"正在重新探测 + 已等多久"。
         * 注意这里不再强制 `detect(true)`：那会白跑一次探测，而恢复那发才是要看的。
         */
        if (url.searchParams.get('reset') === '1') {
          await requestBreakerRecovery({
            dataDir: deps.paths.dataDir,
            modelsDir: deps.paths.modelsDir,
          });
        }
        const detection = await detect(url.searchParams.get('refresh') === '1');
        const body: HardwareResponseWithDiagnostics = {
          hardware: detection.hardware,
          snapshotId: HARDWARE_SNAPSHOT_ID,
          runtime: toDiagnostics(detection),
        };
        sendJson(res, 200, body);
        return true;
      }

      // ---- GET /api/runtime/breaker ----（断路器单独可查，便于排障）
      if (p === '/api/runtime/breaker') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        /*
         * ★ T-173：这里以前是 `await detect(false)` —— 缓存空的时候，**查一眼断路器
         * 会真的跑一发探测**，在冷机器上要 10 s，而且那一发失败还会把计数往上加一。
         * 一个"看一眼就改变被观测对象"的排障入口，测出来的是它自己造成的状态。
         * 现在走纯观测的 `breakerStatus()`：只解析路径 + 读进程内 state。
         */
        const status = await breakerStatus({
          dataDir: deps.paths.dataDir,
          modelsDir: deps.paths.modelsDir,
        });
        /*
         * T-174：显式标注成契约类型。这个端点此前**零调用方**，形状漂了也没人会知道；
         * 现在运行时页的断路器提示读的就是它（`/api/runtime/hardware` 带 daemon 侧缓存，
         * `retryAt` / `recovering` 会是快照那一刻的值，拿它做倒计时会一路数到负数）。
         */
        const body: GetBreakerResponse = {
          backendDir: status.backendDir,
          breaker: breakerSnapshot(status.backendDir),
          open: status.verdict !== 'closed',
          threshold: status.threshold,
          blacklistedBackends: status.blacklistedBackends,
          verdict: status.verdict,
          retryAt: status.retryAt,
          recovering: status.recovering,
          recoveryStartedAt: status.recoveryStartedAt,
          recoveryTimeoutMs: status.recoveryTimeoutMs,
        };
        sendJson(res, 200, body);
        return true;
      }

      // ---- POST /api/backends/selftest ----
      if (p === '/api/backends/selftest') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        /*
         * 前端发的是 `{id}`（`features/runtime/api.ts` —— 每张后端包卡片上的
         * 「自测」按钮都带自己的包 id）。
         *
         * ★ T-166 ①：这个 id 从**被忽略的候选**变成**真的钉住那个包**。
         * 此前无论在哪张卡片上点，跑的都是"按统一规则选出来的那一个"——
         * 装了 CPU 与 Vulkan 两个包的用户，永远只能测到其中一个，
         * 另一张卡片上的按钮点了等于测了别人。
         *
         * 没带 id 就照旧按统一规则挑（`GET /api/selfcheck` 与 CLI 出口都走这条）。
         */
        const body = (await readJsonBody(req)) as { id?: unknown } | undefined;
        const bodyId = typeof body?.id === 'string' && body.id.length > 0 ? body.id : null;
        const result = await (deps.runSelfTest ?? runBackendSelfTest)({
          dataDir: deps.paths.dataDir,
          modelsDir: deps.paths.modelsDir,
          ...(bodyId === null ? {} : { packId: bodyId }),
        });

        if (result.status === 'blocked') {
          // 409 而不是 501：这不是"没实现"，是"前提不满足"，且给得出补救动作。
          sendError(res, 409, 'SELF_TEST_BLOCKED', result.message, result.messageZh, {
            retryable: true,
            /*
             * `null` → **不下发这个字段**，前端就不会渲染一个按钮。
             * 这不是丢信息：`null` 的含义正是"没有任何页面能解决它"
             * （whisper 已装、只是用户点错了卡片），去处已经写在 messageZh 里。
             * 硬凑一个「去安装后端包」才是丢信息 —— 照做会发现无事可做。
             */
            remediation: result.remediation ?? undefined,
            details: { missing: result.missing, resolved: result.resolved },
          });
          return true;
        }

        /*
         * ★ 结果**必须回写到安装记录**（T-164 / gates-fix §5.3）。
         *
         * 在这之前：自检真的跑了、真的返回了 `passed:true, 18.6x`，
         * 而 `InstalledBackendPack.selfTest` 全仓**只有 `backends.ts` 那一句 `selfTest: null`**
         * 在写。于是 `/api/backends/installed` 里每个包的 `selfTest` 恒为 null，
         * `BackendPackCard` 的三条分支（通过徽章 / 失败徽章 / anyFailed 横幅）
         * **永远不会亮**。用户点了自测、看到一次性的返回，刷新一下就什么都没有了 ——
         * 而 D-05 明说 `passed:false` 要有一条**持续**的警告。
         *
         * 写的是 manifest 文件本身，不是某个内存副本：`RestState.listInstalledBackends()`
         * 每次都从 `manifests/backend/*.json` 现读，所以这里写完，
         * 前端 `invalidateQueries(qk.backends.installed)` 一刷就能看见。
         *
         * ★ T-166：认领依据换成了「这个二进制是哪个包给的」（结构），
         * 不再是「`pack.backend === outcome.backendUsed`」（字符串，且恒假）——
         * 见 `recordSelfTest()` 的注释。
         */
        const recorded = await recordSelfTest(
          deps.paths.modelsDir,
          { packId: result.packId, requestedId: bodyId },
          result.outcome,
        );

        // 跑过了就如实回报：passed 可能是 false（真实失败），那也是真结果。
        sendJson(res, 200, {
          status: 'ran',
          passed: result.outcome.passed,
          /** 这次结果有没有被记进安装记录（没有就说清楚为什么，不静默丢掉）。 */
          recorded: recorded.ok,
          recordedTo: recorded.packId,
          recordedReason: recorded.reason,
          /** **跑的到底是哪个包**（钉住时 = 请求里的 id；没钉住时 = 统一规则选中的那个）。 */
          packId: result.packId,
          packBackend: result.packBackend,
          requestedPackId: result.requestedPackId,
          ranAt: result.outcome.ranAt,
          devicesFound: result.outcome.devicesFound,
          rtf: result.outcome.rtf,
          speedup: result.outcome.speedup,
          backendUsed: result.outcome.backendUsed,
          transcriptSimilarity: result.outcome.transcriptSimilarity,
          errorMessage: result.outcome.errorMessage,
          summary: result.summary,
          audioSeconds: result.audioSeconds,
          timeoutMs: result.timeoutMs,
          resolved: result.resolved,
        });
        return true;
      }

      return false;
    },
  };
}

function methodNotAllowed(res: ServerResponse, expected: string): boolean {
  sendError(res, 405, 'METHOD_NOT_ALLOWED', `use ${expected}`, '方法不允许');
  return true;
}

/** 一次自检跑出来的东西，收成安装记录上那个字段的形状。 */
export interface SelfTestOutcomeLike {
  readonly passed: boolean;
  readonly ranAt: string;
  readonly devicesFound: number;
  readonly rtf: number | null;
  /**
   * whisper 日志里那句"实际用上的后端"。**是自由文本，不是 `Backend` 枚举** ——
   * 见 {@link recordSelfTest} 里那段说明它为什么不能拿来做认领依据。
   */
  readonly backendUsed: string | null;
  readonly errorMessage: string | null;
}

/** 认领依据：这次跑的二进制**是哪个已安装包提供的**，以及用户点的是哪张卡片。 */
export interface SelfTestClaim {
  /**
   * 提供这次跑的 whisper-cli 的那个已安装包（`SelfTestRan.packId`）。
   * `null` = 这个二进制不属于任何已安装包（环境变量覆盖 / 手工布局 / 装到一半）。
   */
  readonly packId: string | null;
  /** 用户在哪张卡片上点的自测（前端发的 `{id}`）。没带时 `null`。 */
  readonly requestedId: string | null;
}

export interface RecordSelfTestResult {
  readonly ok: boolean;
  readonly packId: string | null;
  /** 没写成时**说清楚为什么**（会原样出现在响应里）。 */
  readonly reason: string | null;
}

/**
 * 把一次自检结果写进 `manifests/backend/<id>.json` 的 `selfTest`。
 *
 * ## 认领规则：**结果只能记到真正提供了那个二进制的包头上**
 *
 * 判据是**结构**：`resolveBackendTool()` 按安装记录把二进制所在目录反查回包
 * （`runBackendSelfTest()` 把它作为 `SelfTestRan.packId` 交出来）。
 * 认领与任何日志文字、任何目录名关键词都无关。
 *
 * ### ★ T-166：为什么不能用 `outcome.backendUsed` 认领（T-164 的规则是恒假的）
 *
 * T-164 立的规则是「只有 `pack.backend === outcome.backendUsed` 才写」。
 * 它的用例全绿，因为用例喂的是 `backendUsed: 'cpu'`。
 * 而真正产出这个字段的 `parseBackendUsed()`（`packages/runtime/src/selfTest.ts`）
 * 解析的是 whisper 的 stderr，返回的是**日志文字**：
 *
 * ```
 * 'CPU'                     ← whisper_backend_init_gpu: no GPU found
 * 'CPU (ggml-cpu-zen4)'     ← 最后兜底那一档
 * 'NVIDIA GeForce RTX 4090' ← 真选中 GPU 时
 * null                      ← 什么都没匹配上
 * ```
 *
 * 与 `Backend` 枚举（`'cpu' | 'cuda' | 'vulkan' | …`）**没有一条会相等**：
 * 无 GPU 的机器上必是 `'CPU'` 或 `'CPU (…)'`（本机可复现，用例钉住了）；
 * GPU 分支给的是设备名，上游文字 `[未验证]`（`parseBackendUsed()` 自己也这么标着）——
 * 但那不重要，**现在的认领规则一个字符串都不比**。
 * 于是那条比较在拿得到证据的每一台机器上恒真 → 恒拒绝写 →
 * `InstalledBackendPack.selfTest` 照旧永远是 null，
 * 「通过徽章 / 失败徽章 / anyFailed 横幅」三条 UI 分支照旧不亮 ——
 * 修复交付了、用例绿了，而用户看到的东西一个字没变。
 *
 * 这正是本仓最贵的那类：**断言钉的是测试自己造的形状，不是产出方的真实形状。**
 * 所以现在认领不再比对任何字符串，`backendUsed` 只作为**记录内容**落库
 * （它要回答的是另一个问题：跑是跑通了，但加速到底有没有用上）。
 *
 * ### 用户点的那张卡片必须与实际跑的那个包一致
 *
 * `requestedId` 与 `packId` 不一致时**不写**：用户在 CUDA 卡片上点自测、
 * 实际跑的是 CPU 包的二进制，把结果记上去就是发明一条不成立的证据。
 * 钉住自测（`RunBackendSelfTestOptions.packId`）之后这种情况本不该发生 ——
 * 这条是**防线**，不是主路径；它红了说明钉住那一层被绕开了。
 */
export async function recordSelfTest(
  modelsDir: string,
  claim: SelfTestClaim,
  outcome: SelfTestOutcomeLike,
): Promise<RecordSelfTestResult> {
  const { packId, requestedId } = claim;
  if (packId === null) {
    return {
      ok: false,
      packId: null,
      reason:
        '这次跑的 whisper-cli 不属于任何已安装的后端包（环境变量覆盖 / 手工布局 / ' +
        '安装记录缺失），无法认领 —— 不会随便挑一个包记上去',
    };
  }

  const store = new ArtifactStore(modelsDir);
  const installed = await store.listManifests<InstalledBackendPack>('backend');
  const target = installed.find((p) => p.id === packId);
  if (!target) {
    return { ok: false, packId: null, reason: `没有已安装的后端包叫 ${packId}` };
  }
  if (requestedId !== null && requestedId !== packId) {
    return {
      ok: false,
      packId: null,
      reason:
        `你点的是 ${requestedId}，而这次实际跑的是 ${packId} 包里的 whisper-cli —— ` +
        `不把结果记到 ${requestedId} 头上（那会变成一条不成立的证据）`,
    };
  }

  const selfTest: BackendSelfTest = {
    passed: outcome.passed,
    ranAt: outcome.ranAt,
    devicesFound: outcome.devicesFound,
    rtf: outcome.rtf,
    errorMessage: outcome.errorMessage,
    // 「跑通了」与「加速用上了」是两件事，记录必须能分开说（见 BackendSelfTest 注释）
    backendUsed: outcome.backendUsed,
  };
  await store.writeManifest('backend', target.id, { ...target, selfTest });
  return { ok: true, packId: target.id, reason: null };
}
