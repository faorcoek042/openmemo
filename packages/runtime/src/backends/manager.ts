/**
 * Backend selection and the degradation chain.
 *
 * Implements ADR-003 decision 3. The chain is:
 *
 *   advisory detection  ->  candidate backend  ->  download pack  ->  probe (subprocess)
 *        -> self-test (real inference)  ->  READY
 *                 |                 |
 *                 +--- fail --------+---> blacklist, take the next candidate
 *                                          ... eventually CPU, which always works
 *
 * TWO MEASURED FACTS SHAPE THIS FILE:
 *
 *  1. ggml ALREADY degrades gracefully at the library level. Verified on the T-012 box:
 *     with a Vulkan pack installed on a machine with no usable GPU, ggml logged
 *     "ggml_vulkan: No devices found.", loaded the Vulkan backend anyway, then fell
 *     through to the CPU backend with no error and no measurable slowdown. Dropping a
 *     200 KB file of random bytes named libggml-cpu-evilcorp.so changed nothing either.
 *     => Installing an accelerator pack that turns out to be unusable is HARMLESS.
 *        Our job is not to prevent it; it is to explain it.
 *
 *  2. ggml does NOT degrade gracefully when there is no CPU backend at all. With every
 *     libggml-cpu-*.so removed it calls ggml_abort() and dies of SIGABRT (exit 134).
 *     => The L1 CPU pack is load-bearing and must never be evictable.
 */

import type {
  Backend,
  BackendStatus,
  GpuDevice,
  HardwareInfo,
  OsInfo,
} from '@openmemo/shared';

import type { AdvisoryDetection, ProbeDevice, ProbeOutput, ProbeResult } from '../types.js';

/**
 * Per-platform preference order.
 *
 * NVIDIA lists vulkan BEFORE cuda. That is ADR-003 decision 3 and it is deliberate: the
 * official CUDA pack measured 677.9 MB against roughly 30 MB for Vulkan — a 22x
 * difference — while the performance gap between them is UNKNOWN. R-02 refused to
 * invent a benchmark and the ADR records this as a provisional stance to be overturned
 * by measurement, not by assumption. When the spike lands, change this array.
 */
export const PREFERENCE_ORDER: Record<string, Backend[]> = {
  'darwin/arm64': ['metal', 'cpu'],
  'darwin/x64': ['cpu'],
  'win32/x64/nvidia': ['vulkan', 'cuda', 'cpu'],
  'win32/x64/amd': ['vulkan', 'cpu'],
  'win32/x64/intel': ['vulkan', 'cpu'],
  'win32/x64': ['cpu'],
  'win32/arm64': ['vulkan', 'cpu'],
  'linux/x64/nvidia': ['vulkan', 'cuda', 'cpu'],
  'linux/x64/amd': ['vulkan', 'rocm', 'cpu'],
  'linux/x64/intel': ['vulkan', 'cpu'],
  'linux/x64': ['cpu'],
  'linux/arm64': ['vulkan', 'cpu'],
};

export function preferenceOrder(os: OsInfo, primaryVendor: GpuDevice['vendor'] | null): Backend[] {
  const keys = [
    primaryVendor !== null ? `${os.platform}/${os.arch}/${primaryVendor}` : null,
    `${os.platform}/${os.arch}`,
  ].filter((k): k is string => k !== null);

  for (const k of keys) {
    const order = PREFERENCE_ORDER[k];
    if (order !== undefined) return order;
  }
  return ['cpu'];
}

/** Map a ggml backend registry name ("Vulkan", "CUDA", "Metal", "CPU") to our enum. */
export function backendFromRegName(regName: string): Backend | null {
  switch (regName.toLowerCase()) {
    case 'cpu':
      return 'cpu';
    case 'cuda':
      return 'cuda';
    case 'vulkan':
      return 'vulkan';
    case 'metal':
      return 'metal';
    case 'rocm':
    case 'hip':
      return 'rocm';
    case 'blas':
    case 'accel':
      return null; // helper backends, never a user-facing choice
    default:
      return null;
  }
}

/**
 * Is this probe device something we would actually want to run inference on?
 *
 * Rejects software rasterisers. MEASURED: Mesa's lavapipe presents as a real Vulkan
 * physical device (deviceType CPU, name "llvmpipe (LLVM 21.1.8, 256 bits)") on a
 * machine with no GPU. ggml-vulkan happens to reject it upstream — it only accepts
 * eDiscreteGpu/eIntegratedGpu — but we must not depend on every backend being that
 * careful, and we want to be able to tell the user WHY nothing was found.
 */
export function isUsableAccelerator(d: ProbeDevice): boolean {
  if (d.softwareRenderer) return false;
  return d.type === 'gpu' || d.type === 'igpu';
}

export interface BuildHardwareInfoInput {
  os: OsInfo;
  cpu: HardwareInfo['cpu'];
  ram: HardwareInfo['ram'];
  unifiedMemory: boolean;
  disks: HardwareInfo['disks'];
  advisory: AdvisoryDetection;
  probe: ProbeResult;
  /** Backends whose packs are present on disk. */
  installedBackends: Set<Backend>;
  /** Backends parked by the circuit breaker. */
  blacklistedBackends?: Set<Backend>;
}

/**
 * Fuse advisory detection with probe results into the shared `HardwareInfo` contract.
 *
 * Rule: the probe wins wherever the two disagree. Advisory data only fills in fields the
 * probe cannot know (driver version, PCI vendor, marketing name).
 */
export function buildHardwareInfo(input: BuildHardwareInfoInput): HardwareInfo {
  const {
    os,
    cpu,
    ram,
    unifiedMemory,
    disks,
    advisory,
    probe,
    installedBackends,
    blacklistedBackends = new Set<Backend>(),
  } = input;

  const probeOutput: ProbeOutput | null = probe.ok ? probe.output : null;
  const probeDevices = probeOutput?.devices ?? [];

  // ---- GPUs: one entry per usable accelerator the probe actually enumerated. ---------
  const gpus: GpuDevice[] = [];
  let gpuIndex = 0;

  for (const d of probeDevices) {
    if (!isUsableAccelerator(d)) continue;

    const backend = backendFromRegName(d.backendReg);
    // Match to advisory data by fuzzy name so we can borrow the driver version.
    const advisoryMatch = advisory.gpus.find(
      (a) =>
        d.description.toLowerCase().includes(a.name.toLowerCase()) ||
        a.name.toLowerCase().includes(d.description.toLowerCase()),
    );

    gpus.push({
      index: gpuIndex++,
      vendor: advisoryMatch?.vendor ?? inferVendorFromName(d.description),
      name: d.description || d.name,
      // Unified memory: VRAM is not a separate resource. The contract mandates null.
      vramTotalMB: unifiedMemory ? null : bytesToMB(d.memTotalBytes),
      vramFreeMB: unifiedMemory ? null : bytesToMB(d.memFreeBytes),
      driverVersion: advisoryMatch?.driverVersion ?? null,
      capabilities: advisoryMatch?.capabilities ?? {},
      backends: backend !== null ? [backend] : [],
    });
  }

  // ---- Backend statuses -------------------------------------------------------------
  const enumeratedBackends = new Map<Backend, ProbeDevice[]>();
  for (const d of probeDevices) {
    const b = backendFromRegName(d.backendReg);
    if (b === null) continue;
    const list = enumeratedBackends.get(b) ?? [];
    list.push(d);
    enumeratedBackends.set(b, list);
  }

  const allBackends: Backend[] = ['cuda', 'vulkan', 'rocm', 'metal', 'coreml', 'cpu'];
  const backends: BackendStatus[] = allBackends.map((id) => {
    const devices = enumeratedBackends.get(id) ?? [];
    const usable = devices.filter((d) => (id === 'cpu' ? d.type === 'cpu' : isUsableAccelerator(d)));
    const installed = installedBackends.has(id);

    let unavailableReason: string | null = null;
    if (usable.length === 0) {
      if (!probe.ok) {
        unavailableReason = `probe did not complete: ${probe.message}`;
      } else if (blacklistedBackends.has(id)) {
        unavailableReason = 'disabled after repeated failures; re-test to try again';
      } else if (!installed) {
        unavailableReason = 'backend package not installed';
      } else if (devices.length > 0) {
        // The pack loaded but every device it offered was rejected. This is the
        // lavapipe case and it deserves a specific, non-alarming explanation.
        unavailableReason = devices.some((d) => d.softwareRenderer)
          ? 'only a software renderer was found (no real GPU); falling back to CPU'
          : 'backend loaded but reported no usable devices';
      } else {
        unavailableReason = 'installed but enumerated no devices (driver missing or too old)';
      }
    }

    const gpuIdx = gpus.findIndex((g) => g.backends.includes(id));

    return {
      id,
      available: usable.length > 0,
      installed,
      version: id === 'cpu' ? (probeOutput?.ggmlVersion ?? null) : null,
      deviceIndex: gpuIdx >= 0 ? gpuIdx : null,
      ...(id === 'cpu' ? { isa: cpu.features.includes('avx2') ? 'avx2' : null } : {}),
      unavailableReason,
    };
  });

  // ---- Selection --------------------------------------------------------------------
  const primaryVendor = advisory.gpus[0]?.vendor ?? gpus[0]?.vendor ?? null;
  const order = preferenceOrder(os, primaryVendor);

  const selectedBackend =
    order.find((b) => {
      if (blacklistedBackends.has(b)) return false;
      return backends.find((s) => s.id === b)?.available === true;
    }) ?? 'cpu';

  const selectedGpuIndex =
    selectedBackend === 'cpu'
      ? null
      : (backends.find((s) => s.id === selectedBackend)?.deviceIndex ?? null);

  return {
    schemaVersion: 1,
    detectedAt: new Date().toISOString(),
    os,
    cpu,
    ram,
    unifiedMemory,
    gpus,
    backends,
    selectedBackend,
    selectedGpuIndex,
    disks,
  };
}

/**
 * The ordered list of backends still worth trying after `failed` has been ruled out.
 * `cpu` is always last and always present — it is the floor of the chain.
 */
export function nextCandidates(
  os: OsInfo,
  primaryVendor: GpuDevice['vendor'] | null,
  failed: Set<Backend>,
): Backend[] {
  const order = preferenceOrder(os, primaryVendor).filter((b) => !failed.has(b));
  return order.includes('cpu') ? order : [...order, 'cpu'];
}

/**
 * Gate cross-engine reuse of a backend pack on an exact ggml ABI match.
 *
 * R-02 flagged sharing one ggml-cuda.dll between whisper.cpp and llama.cpp as an
 * UNVERIFIED optimisation. ggml's registry checks the API version and refuses to load on
 * mismatch ("incompatible API version"), so the failure is safe — but silently losing
 * acceleration is a bad user experience, so we check before installing rather than
 * discovering it at inference time. Measured: whisper.cpp v1.9.1 => ggml ABI 0.15.1.
 */
export function isAbiCompatible(packAbi: string | null, runtimeAbi: string | null): boolean {
  if (packAbi === null || runtimeAbi === null) return false;
  return packAbi === runtimeAbi;
}

function bytesToMB(bytes: number): number | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round(bytes / 1e6);
}

function inferVendorFromName(name: string): GpuDevice['vendor'] {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|tesla|rtx|gtx/.test(n)) return 'nvidia';
  if (/amd|radeon|gfx\d/.test(n)) return 'amd';
  if (/intel|arc|iris|uhd graphics/.test(n)) return 'intel';
  if (/apple|m[1-9]\s|metal/.test(n)) return 'apple';
  return 'other';
}
