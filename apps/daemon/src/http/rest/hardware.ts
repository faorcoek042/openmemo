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

import type { Arch, Backend, GetHardwareResponse, HardwareInfo } from '@openmemo/shared';

import type { AppPaths } from '../../config/paths.js';
import {
  breakerSnapshot,
  detectRuntimeHardware,
  resetBreaker,
  runBackendSelfTest,
  type BreakerDiagnostics,
  type ProbeDiagnostics,
  type RuntimeDetection,
} from '../../runtime/setup.js';
import { sendError, sendJson } from '../respond.js';

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
 * @param modelsRoot 模型根目录 —— 调用方（state.ts）手里只有这一个路径。
 * @param dataDir    数据目录。不传时按 `<dataDir>/models` 的约定从 modelsRoot 反推：
 *   runtime 包需要 `<dataDir>/bin/runtime` 才能找到 probe 与 ggml 后端库，
 *   反推不出来（例如 `OPENMEMO_MODELS` 指到了别处）就退回 modelsRoot 的父目录 ——
 *   **宁可 probe 报 missing_probe，也不硬编码一个假路径**。
 */
export async function detectLocalHardware(
  modelsRoot: string,
  dataDir?: string,
): Promise<HardwareInfo> {
  const detection = await detectRuntimeHardware({
    dataDir: dataDir ?? inferDataDir(modelsRoot),
    modelsDir: modelsRoot,
  });
  return detection.hardware;
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
    async handle(_req, res, url, method): Promise<boolean> {
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
        const result = await runBackendSelfTest({
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

        // 跑过了就如实回报：passed 可能是 false（真实失败），那也是真结果。
        sendJson(res, 200, {
          status: 'ran',
          passed: result.outcome.passed,
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
