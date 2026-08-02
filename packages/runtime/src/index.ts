/**
 * @openmemo/runtime — hardware detection + GPU backend pack management.
 *
 * Implements charter requirement 2.1: the web UI detects hardware, recommends a backend,
 * downloads the matching prebuilt pack, installs it, self-tests, and shows status —
 * without the user ever touching a command line.
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
import { detectGpus } from './detect/gpu.js';
import {
  detectCpu,
  detectDisks,
  detectMemory,
  detectOs,
  detectUnifiedMemory,
} from './detect/system.js';
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
  inferIsaFromBackendPath,
} from './detect/system.js';
export { SOFTWARE_ADAPTER_NAMES, detectGpus } from './detect/gpu.js';

// -- probe --------------------------------------------------------------------------------
export {
  CIRCUIT_BREAKER_THRESHOLD,
  PROBE_TIMEOUT_MS,
  emptyBreaker,
  isBlacklisted,
  recordProbeOutcome,
  runProbe,
} from './probe/runProbe.js';
export type { BreakerState, RunProbeOptions } from './probe/runProbe.js';

// -- backend selection ---------------------------------------------------------------------
export {
  PREFERENCE_ORDER,
  backendFromRegName,
  buildHardwareInfo,
  isAbiCompatible,
  isUsableAccelerator,
  nextCandidates,
  preferenceOrder,
} from './backends/manager.js';
export type { BuildHardwareInfoInput } from './backends/manager.js';

// -- self-test -----------------------------------------------------------------------------
export {
  SELF_TEST_TIMEOUT_MS,
  SIMILARITY_THRESHOLD,
  estimateDuration,
  formatSelfTest,
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
    detectGpus(),
    runProbe({ probePath: options.probePath, backendDir: options.backendDir }),
    detectDisks({ modelsRoot: options.modelsRoot, runtimesRoot: options.runtimesRoot }),
  ]);

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
  });
}
