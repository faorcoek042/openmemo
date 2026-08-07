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
import type {
  Arch,
  Backend,
  BackendSelfTest,
  GetHardwareResponse,
  InstalledBackendPack,
} from '@openmemo/shared';

import type { AppPaths } from '../../config/paths.js';
import {
  breakerSnapshot,
  detectRuntimeHardware,
  resetBreaker,
  runBackendSelfTest,
  type BreakerDiagnostics,
  type RunBackendSelfTestOptions,
  type ProbeDiagnostics,
  type RuntimeDetection,
} from '../../runtime/setup.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

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

function inferDataDir(modelsRoot: string): string {
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
  readonly degradationChain: Backend[];
  readonly installedBackends: Backend[];
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
    degradationChain: d.degradationChain,
    installedBackends: d.installedBackends,
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

  const detect = async (refresh: boolean): Promise<RuntimeDetection> => {
    if (cached !== null && !refresh) return cached;
    const installed = deps.installedBackends ? await deps.installedBackends() : undefined;
    cached = await detectRuntimeHardware({
      dataDir: deps.paths.dataDir,
      modelsDir: deps.paths.modelsDir,
      ...(installed === undefined ? {} : { installedBackends: new Set<Backend>(installed) }),
    });
    return cached;
  };

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;

      // ---- GET /api/runtime/hardware ----
      if (p === '/api/runtime/hardware') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        // `refresh=1` 重新探测但**保留**断路器计数（否则连续失败永远累计不到阈值）；
        // `reset=1` 才是 ADR-003 说的"用户显式重试"，清掉裁决让后端重新自证。
        const reset = url.searchParams.get('reset') === '1';
        if (reset) resetBreaker();
        const detection = await detect(reset || url.searchParams.get('refresh') === '1');
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
        const detection = await detect(false);
        sendJson(res, 200, {
          backendDir: detection.layout.backendDir,
          breaker: breakerSnapshot(detection.layout.backendDir),
          open: detection.breaker.open,
          threshold: detection.breaker.threshold,
          blacklistedBackends: detection.blacklistedBackends,
        });
        return true;
      }

      // ---- POST /api/backends/selftest ----
      if (p === '/api/backends/selftest') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        // 前端发的是 `{id}`（`features/runtime/api.ts`）。没带也照跑 —— 结果按
        // `backendUsed` 认领；认不到就不写，而不是随便挑一个包按上去。
        const body = (await readJsonBody(req)) as { id?: unknown } | undefined;
        const bodyId = typeof body?.id === 'string' ? body.id : null;
        const result = await (deps.runSelfTest ?? runBackendSelfTest)({
          dataDir: deps.paths.dataDir,
          modelsDir: deps.paths.modelsDir,
        });

        if (result.status === 'blocked') {
          // 409 而不是 501：这不是"没实现"，是"前提不满足"，且给得出补救动作。
          sendError(res, 409, 'SELF_TEST_BLOCKED', result.message, result.messageZh, {
            retryable: true,
            remediation: result.remediation,
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
         */
        const recorded = await recordSelfTest(deps.paths.modelsDir, bodyId, result.outcome);

        // 跑过了就如实回报：passed 可能是 false（真实失败），那也是真结果。
        sendJson(res, 200, {
          status: 'ran',
          passed: result.outcome.passed,
          /** 这次结果有没有被记进安装记录（没有就说清楚为什么，不静默丢掉）。 */
          recorded: recorded.ok,
          recordedTo: recorded.packId,
          recordedReason: recorded.reason,
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
  readonly backendUsed: string | null;
  readonly errorMessage: string | null;
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
 * ## 认领规则：**结果只能记到它真的跑过的那个后端上**
 *
 * `runBackendSelfTest()` 跑的是"当前能找到的那套 whisper-cli + ggml 库"，
 * 它不是按包 id 分派的。所以请求里带的 `id` 只是**候选**：
 * 只有当那个包的 `backend` 与 `outcome.backendUsed` 相符时才写。
 *
 * 不这么设防的话，用户在 CUDA 包的卡片上点一次自测，
 * 而实际跑的是 CPU 后端 —— 结果会被写成"CUDA 包自检通过"。
 * 那不是少一个功能，那是**发明一条不成立的证据**，比 `selfTest: null` 坏得多。
 *
 * `id` 没带（或对不上）时按 `backendUsed` 去找唯一一个匹配的已装包；
 * 找不到或找到多个就**不写**，并把原因带回响应里。
 */
export async function recordSelfTest(
  modelsDir: string,
  requestedId: string | null,
  outcome: SelfTestOutcomeLike,
): Promise<RecordSelfTestResult> {
  const used = outcome.backendUsed;
  if (!used) {
    return { ok: false, packId: null, reason: '这次自检没有报出用的是哪个后端，无法认领' };
  }
  const store = new ArtifactStore(modelsDir);
  const installed = await store.listManifests<InstalledBackendPack>('backend');

  let target: InstalledBackendPack | undefined;
  if (requestedId) {
    const asked = installed.find((p) => p.id === requestedId);
    if (!asked) {
      return { ok: false, packId: null, reason: `没有已安装的后端包叫 ${requestedId}` };
    }
    if (asked.backend !== used) {
      return {
        ok: false,
        packId: null,
        reason:
          `实际跑的是 ${used} 后端，而 ${requestedId} 是 ${asked.backend} 包 —— ` +
          `不把结果记到它头上（那会变成一条不成立的证据）`,
      };
    }
    target = asked;
  } else {
    const matches = installed.filter((p) => p.backend === used);
    if (matches.length !== 1) {
      return {
        ok: false,
        packId: null,
        reason: `跑的是 ${used} 后端，已装的 ${used} 包有 ${String(matches.length)} 个，认不出是哪一个`,
      };
    }
    target = matches[0];
  }

  const selfTest: BackendSelfTest = {
    passed: outcome.passed,
    ranAt: outcome.ranAt,
    devicesFound: outcome.devicesFound,
    rtf: outcome.rtf,
    errorMessage: outcome.errorMessage,
  };
  await store.writeManifest('backend', target.id, { ...target, selfTest });
  return { ok: true, packId: target.id, reason: null };
}
