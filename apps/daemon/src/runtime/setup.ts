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
import {
  CIRCUIT_BREAKER_THRESHOLD,
  PROBE_TIMEOUT_MS,
  SELF_TEST_TIMEOUT_MS,
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
  isBlacklisted,
  nextCandidates,
  preferenceOrder,
  recordProbeOutcome,
  runProbe,
  runSelfTest,
  type BreakerState,
  type ProbeFailureKind,
  type ProbeResult,
  type SelfTestOutcome,
} from '@openmemo/runtime';
import type {
  Backend,
  HardwareInfo,
  InstalledBackendPack,
  Remediation,
} from '@openmemo/shared';

/**
 * 除 cpu 外的全部后端。
 *
 * 断路器跳闸时把它们一起拉黑，但**永远不拉黑 cpu**：L1 内置 CPU 后端是降级链的地板，
 * ggml 在完全没有 CPU 后端时会 `ggml_abort()` 直接 SIGABRT（manager.ts 已实测），
 * 所以它必须始终可选。
 */
const ACCELERATOR_BACKENDS: readonly Backend[] = ['cuda', 'vulkan', 'rocm', 'metal', 'coreml'];

/** probe 由 `gpu-runtime` 的构建从 `packages/runtime/src/native/probe.c` 产出。 */
function probeBinaryName(): string {
  return process.platform === 'win32' ? 'probe.exe' : 'probe';
}

function whisperCliName(): string {
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
 * 在 runtimes 根下按层级找一个文件名。
 *
 * 后端包按 `installPath`（如 `llamacpp/b10223/vulkan`）展开，所以深度到 4 足够，
 * 又不至于把整个数据目录翻一遍。BFS 保证浅层（也就是更"正式"的安装位置）优先命中。
 */
async function findUnder(root: string, fileName: string, maxDepth = 4): Promise<string | null> {
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
        if (entry.isFile() && entry.name === fileName) return full;
        if (entry.isDirectory()) next.push(full);
      }
    }
    level = next;
  }
  return null;
}

/**
 * 解析 runtime 需要的四个路径。
 *
 * runtimes 根与 `pipeline/setup.ts` 的 `runtimesDir` 保持一致（`<dataDir>/bin/runtime`），
 * 两处指向同一个目录，不能各写各的。
 */
export async function resolveRuntimeLayout(input: RuntimePathsInput): Promise<RuntimeLayout> {
  const runtimesRoot = path.join(input.dataDir, 'bin', 'runtime');
  // 与 downloader 的 `resolveModelsRoot` 同序：OPENMEMO_MODELS > AppPaths.modelsDir
  const modelsRoot =
    process.env['OPENMEMO_MODELS'] ?? input.modelsDir ?? path.join(input.dataDir, 'models');

  // 显式环境变量优先（开发/自检用），与 pipeline/setup.ts 的工具解析约定一致
  const envProbe = process.env['OPENMEMO_PROBE'];
  const envBackendDir = process.env['OPENMEMO_BACKEND_DIR'];

  const found = envProbe ?? (await findUnder(runtimesRoot, probeBinaryName()));
  const probePath = found ?? path.join(runtimesRoot, probeBinaryName());
  const backendDir = envBackendDir ?? (found !== null ? path.dirname(found) : runtimesRoot);

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

/** 用户显式"重试"时调用：清掉裁决，让后端重新自证。 */
export function resetBreaker(backendDir?: string): void {
  if (backendDir === undefined) breakers.clear();
  else breakers.delete(backendDir);
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
  readonly open: boolean;
  readonly blacklistedAt: string | null;
  readonly lastError: string | null;
  readonly driverFingerprint: string | null;
}

export interface RuntimeDetection {
  readonly hardware: HardwareInfo;
  readonly layout: RuntimeLayout;
  readonly probe: ProbeDiagnostics;
  readonly breaker: BreakerDiagnostics;
  /** 断路器拉黑的后端（cpu 永不入列）。 */
  readonly blacklistedBackends: Backend[];
  /** 降级链（ADR-003 决策 3）：还值得一试的后端，cpu 恒为最后一环。 */
  readonly degradationChain: Backend[];
  readonly installedBackends: Backend[];
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
  installedBackends: Set<Backend>,
  blacklistedBackends: Set<Backend>,
): Promise<HardwareInfo> {
  const [cpu, advisory, disks] = await Promise.all([
    detectCpu(),
    detectGpus(),
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
  });
}

export interface DetectRuntimeHardwareOptions extends RuntimePathsInput {
  /** 已安装后端包；不传就从 store 的 backend manifest 里读（daemon 的真实状态）。 */
  readonly installedBackends?: ReadonlySet<Backend> | undefined;
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

  let breaker = breakers.get(layout.backendDir) ?? emptyBreaker();
  let ran = true;
  let probe: ProbeResult;

  if (isBlacklisted(breaker, fingerprint)) {
    ran = false;
    probe = {
      ok: false,
      kind: 'exec_error',
      message:
        `probe skipped: circuit breaker open after ${String(breaker.consecutiveFailures)} ` +
        `consecutive failures (last: ${breaker.lastError ?? 'no detail'})`,
      durationMs: 0,
      stderr: '',
    };
  } else {
    probe = await runProbe({ probePath: layout.probePath, backendDir: layout.backendDir });
    breaker = recordProbeOutcome(breaker, probe, fingerprint);
    breakers.set(layout.backendDir, breaker);
  }

  const open = isBlacklisted(breaker, fingerprint);
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
      })
    : await composeHardware(layout, probe, installed, blacklisted);

  const primaryVendor = hardware.gpus[0]?.vendor ?? null;

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
    },
    blacklistedBackends: [...blacklisted],
    degradationChain: nextCandidates(hardware.os, primaryVendor, blacklisted),
    installedBackends: [...installed],
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

/** 自检用最小的已装模型（selfTest.ts 的建议）：按体积升序取第一个 .bin。 */
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
}

export interface SelfTestRan {
  readonly status: 'ran';
  readonly outcome: SelfTestOutcome;
  /** 人话摘要，绝不编造没测到的数字（`formatSelfTest` 保证）。 */
  readonly summary: string;
  readonly audioSeconds: number;
  readonly timeoutMs: number;
  readonly resolved: { whisperCli: string; model: string; audio: string };
}

export type BackendSelfTestResult = SelfTestBlocked | SelfTestRan;

export interface RunBackendSelfTestOptions extends RuntimePathsInput {
  readonly threads?: number | undefined;
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

  const whisperCli = await firstExistingFile(
    env['OPENMEMO_WHISPER_CLI'],
    (await findUnder(layout.runtimesRoot, whisperCliName())) ?? undefined,
  );

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
  };
}
