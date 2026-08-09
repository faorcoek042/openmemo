/**
 * @openmemo/runtime — hardware detection + GPU backend pack management.
 *
 * Implements charter requirement 2.1: the web UI detects hardware, recommends a backend,
 * downloads the matching prebuilt pack, installs it, self-tests, and shows status —
 * without the user ever touching a command line.
 *
 * Degradation chain (ADR-003 decision 3, amended by ADR-006 decision 3):
 *   L1 built-in CPU backend (ships in the installer, never fails)
 *     -> L2 on-demand accelerator pack (metal / cuda / vulkan / rocm)
 * The old L0 browser-WebGPU tier is out of v1.
 *
 * The whole thing rests on one verified property of ggml (see docs/design/D-04 §2):
 * with `GGML_BACKEND_DL=ON`, each backend is a standalone shared library that ggml
 * dlopen's from the binary's own directory at startup, scoring candidates and silently
 * skipping any that will not work here. Installing an accelerator is therefore
 * "drop one more file into the folder" — proven end-to-end on the T-012 Linux box.
 *
 * Architecture:
 *
 *   detect/system.ts  OS, CPU, RAM, disk               (Linux verified; mac/Win not)
 *   detect/gpu.ts     ADVISORY GPU hints only          (never authoritative)
 *   native/probe.c    the authoritative device enumerator
 *   probe/runProbe.ts spawns it: subprocess + 10s timeout + circuit breaker
 *   backends/manager  fuses everything into HardwareInfo, runs the degradation chain
 *   selfTest.ts       real inference on an embedded clip, reports measured RTF
 */

import type { Backend, HardwareInfo } from '@openmemo/shared';

import { buildHardwareInfo } from './backends/manager.js';
import type { AdvisoryDetection } from './types.js';
import { detectGpus } from './detect/gpu.js';
import {
  detectCpu,
  detectDisks,
  detectMemory,
  detectOs,
  detectUnifiedMemory,
} from './detect/system.js';
import { probedBackendsInDir } from './probe/probedBackends.js';
import { runProbe } from './probe/runProbe.js';

export const PACKAGE_NAME = '@openmemo/runtime' as const;

// -- contract types (re-exported so consumers need one import) --------------------------
export type {
  Arch,
  Backend,
  BackendStatus,
  CpuInfo,
  DiskInfo,
  GpuDevice,
  HardwareInfo,
  MemoryInfo,
  OsInfo,
  OsPlatform,
} from '@openmemo/shared';

// -- internal types ---------------------------------------------------------------------
export type {
  AdvisoryDetection,
  AdvisoryGpu,
  ProbeDevice,
  ProbeDeviceType,
  ProbeFailureKind,
  ProbeOutput,
  ProbeResult,
  SelfTestOutcome,
} from './types.js';
export { isProbeDevice, isProbeOutput } from './types.js';

// -- detection ---------------------------------------------------------------------------
export {
  detectCpu,
  detectDisks,
  detectMemory,
  detectOs,
  detectUnifiedMemory,
} from './detect/system.js';
export { SOFTWARE_ADAPTER_NAMES, detectGpus } from './detect/gpu.js';

// -- probe --------------------------------------------------------------------------------
export {
  BREAKER_COOLDOWN_MAX_MS,
  BREAKER_COOLDOWN_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  PROBE_RECOVERY_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  breakerCooldownMs,
  breakerVerdict,
  emptyBreaker,
  recordProbeOutcome,
  runProbe,
} from './probe/runProbe.js';
export type { BreakerState, BreakerVerdict, RunProbeOptions } from './probe/runProbe.js';
/*
 * Which backends a probe run could actually load (T-168). Exported because the daemon's
 * `composeHardware()` needs the SAME answer as `detectHardware()` below — two
 * implementations of "was this backend loadable" is exactly how `backendDir` drifted from
 * the installer's real layout in the first place (setup.ts T-160).
 */
export { ggmlRegNameFromFileName, probedBackendsInDir } from './probe/probedBackends.js';

// -- backend selection ---------------------------------------------------------------------
export {
  PREFERENCE_ORDER,
  backendFromRegName,
  buildHardwareInfo,
  isAbiCompatible,
  isUsableAccelerator,
  preferenceOrder,
} from './backends/manager.js';
export type { BuildHardwareInfoInput } from './backends/manager.js';

// Backend pack applicability policy (ADR-014 decision 2: L1 CPU is never probe-gated).
export {
  L1_BACKENDS,
  evaluateApplicability,
  isAlwaysApplicable,
  isPackApplicable,
} from './backends/applicability.js';
export type {
  ApplicabilityInput,
  ApplicabilityResult,
  PackDescriptor,
} from './backends/applicability.js';

// -- media asset path resolution (T-136: one rule, shared by playback and self-check) -------
export {
  assetCandidates,
  canonicalAssetRelPath,
  mediaAssetRoots,
  probeAssetFile,
} from './assetPaths.js';
export type { AssetProbe } from './assetPaths.js';

// -- functional self-check (ADR-014: verify the FEATURE, not the component) -----------------
export {
  CHINESE_PROBE_WORDS,
  coreMlEncoderNameFor,
  diffSelfCheckReports,
  extensionFileName,
  listByName,
  listInstalledNamesByRole,
  runSelfCheck,
} from './selfcheck.js';
export type {
  CheckResult,
  BackendSelectionInfo,
  BreakerStatusInfo,
  CheckStatus,
  DetectedLlmService,
  InstalledByRole,
  LlmKeyConfig,
  MediaAssetRef,
  ProxyConnectivity,
  ProxySummary,
  SelfCheckDiffEntry,
  SelfCheckInput,
  SelfCheckProbes,
  SelfCheckReport,
  SelfCheckToolPaths,
} from './selfcheck.js';

// -- self-test -----------------------------------------------------------------------------
export {
  SELF_TEST_TIMEOUT_MS,
  SIMILARITY_THRESHOLD,
  estimateDuration,
  formatSelfTest,
  parseBackendUsed,
  runSelfTest,
  transcriptSimilarity,
} from './selfTest.js';
export type { SelfTestOptions } from './selfTest.js';

export interface DetectHardwareOptions {
  probePath: string;
  backendDir: string;
  modelsRoot: string;
  runtimesRoot: string;
  installedBackends?: Set<Backend>;
  blacklistedBackends?: Set<Backend>;
  /**
   * Advisory GPU detection, if the caller already ran it. Omitted -> detected here.
   *
   * Exists because the caller needs the same result for L2 applicability
   * (`evaluateApplicability`'s `advisoryCandidates`), and running `system_profiler`
   * twice per detection is a real, measurable cost on macOS.
   */
  advisory?: AdvisoryDetection;
}

/**
 * One-shot full detection, producing the `HardwareInfo` the web UI and the fitness
 * calculator consume. Serves `GET /api/runtime/hardware`.
 *
 * Advisory queries and the probe run concurrently: they are independent, and
 * `system_profiler` on macOS is slow enough to be worth overlapping.
 */
export async function detectHardware(options: DetectHardwareOptions): Promise<HardwareInfo> {
  const [cpu, advisory, probe, disks] = await Promise.all([
    detectCpu(),
    /*
     * Reuse an already-computed advisory result when the caller has one. macOS pays
     * `system_profiler` (seconds, 8 s timeout) for this, and the daemon needs the same
     * data for L2 applicability — detecting twice per request was the alternative.
     */
    options.advisory ? Promise.resolve(options.advisory) : detectGpus(),
    runProbe({ probePath: options.probePath, backendDir: options.backendDir }),
    detectDisks({ modelsRoot: options.modelsRoot, runtimesRoot: options.runtimesRoot }),
  ]);

  /*
   * Which backends this run could even load. Read from the SAME directory the probe was
   * pointed at — anything else would answer a different question than the probe answered.
   * See `probedBackends.ts` and `BackendStatus.probed`.
   */
  const probedBackends = await probedBackendsInDir(options.backendDir);

  return buildHardwareInfo({
    os: detectOs(),
    cpu,
    ram: detectMemory(),
    unifiedMemory: detectUnifiedMemory(),
    disks,
    advisory,
    probe,
    installedBackends: options.installedBackends ?? new Set<Backend>(['cpu']),
    blacklistedBackends: options.blacklistedBackends ?? new Set<Backend>(),
    probedBackends,
  });
}
