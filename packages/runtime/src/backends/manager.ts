/**
 * Backend selection and the degradation chain.
 *
 * Implements ADR-003 decision 3, as amended by ADR-006 decision 3: the chain is
 * L1 (built-in CPU) -> L2 (on-demand accelerator packs). The former L0 browser-WebGPU
 * tier was cut from v1 — the user must install the daemon before they can open the web
 * UI at all, and the daemon already ships L1, so L0 added nothing over it.
 *
 * The chain is:
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

import type { Backend, BackendStatus, GpuDevice, HardwareInfo, OsInfo } from '@openmemo/shared';

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
  /**
   * Backends this probe run could actually load — i.e. whose ggml library is in the ONE
   * directory the probe scanned (`probedBackendsInDir`).
   *
   * ⚠️ REQUIRED, deliberately. It would type-check as optional — there are only two
   * callers — but "not knowing which backends were loadable" is precisely the state that
   * produced T-168's false driver accusation. An optional field lets a future caller skip
   * it and get a plausible-looking answer built on no evidence; a required one makes the
   * compiler ask the question. Pass an empty set to mean "nothing was loadable"; there is
   * no way to spell "do not care", on purpose. See `BackendStatus.probed`.
   */
  probedBackends: ReadonlySet<Backend>;
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
    probedBackends,
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
    const usable = devices.filter((d) =>
      id === 'cpu' ? d.type === 'cpu' : isUsableAccelerator(d),
    );
    const installed = installedBackends.has(id);
    /*
     * Enumerating a device is itself proof the backend loaded, so it overrides the
     * directory listing. This keeps the field self-consistent — `available` implies
     * `probed` — even if the filename heuristic ever misses a library shape.
     */
    const probed = probe.ok && (probedBackends.has(id) || devices.length > 0);

    const gpuIdx = gpus.findIndex((g) => g.backends.includes(id));
    /** 与"可用不可用"无关的那几格，两条分支共用一份，避免写两遍写漂。 */
    const common = {
      id,
      installed,
      version: id === 'cpu' ? (probeOutput?.ggmlVersion ?? null) : null,
      deviceIndex: gpuIdx >= 0 ? gpuIdx : null,
      ...(id === 'cpu' ? { isa: cpu.features.includes('avx2') ? 'avx2' : null } : {}),
    };

    /*
     * ★★ T-194：**先分叉，再算理由** —— 判别联合的生产者侧。
     *
     * 枚举到可用设备 ⇒ `probed` 必然为真（设备只可能来自一次成功的探测，
     * 而 `probed = probe.ok && (probedBackends.has(id) || devices.length > 0)`
     * 在 `devices.length > 0` 时恒真）。此前这条"必然"只写在注释里，
     * 类型上 `available` 与 `probed` 是两个各自独立的 boolean，
     * `{available: true, probed: false}` 构造得出来、编译器不说话，
     * 唯一守它的是一条运行时断言。**现在它由类型保证。**
     */
    if (usable.length > 0) {
      return { ...common, available: true as const, probed: true as const };
    }

    /*
     * 到这里 `available` 必然是 false，而**七条分支每一条都返回一句理由** ——
     * 这正是类型里 `unavailableReason` 在这条分支上必填的依据：
     * 说了"不可用"就必须说得出为什么，不许留空。
     */
    const unavailableReason: string = ((): string => {
      if (!probe.ok) {
        return `probe did not complete: ${probe.message}`;
      } else if (blacklistedBackends.has(id)) {
        return 'disabled after repeated failures; re-test to try again';
      } else if (!installed) {
        return 'backend package not installed';
      } else if (!probed) {
        /*
         * ★ T-168. The pack IS installed, and this run never loaded it.
         *
         * `backendDir` is single-valued: one probe run scans one pack directory, so every
         * other installed pack is invisible to it. Before this branch existed, that
         * invisibility fell through to the "driver missing or too old" line below — a
         * specific, confident, WRONG diagnosis, measured on a box where the Vulkan pack
         * was installed and perfectly fine and the user had merely selected CPU.
         *
         * The rule this branch enforces: absence of evidence is reported as absence of
         * evidence. Nothing here may mention drivers, hardware, or support — we did not
         * look. The last sentence is load-bearing: without it users read any "unavailable"
         * line as a fault to go and fix.
         */
        return (
          'installed, but this detection run did not load it: only the backend directory ' +
          `currently in use is scanned${
            probeOutput !== null && probeOutput.searchPath.length > 0
              ? ` (${probeOutput.searchPath})`
              : ''
          }, and this backend's library is not in it. ` +
          'This is not a driver or hardware fault — nothing was measured about it. ' +
          'Select this backend, or run the self-test on that pack, to get a real answer.'
        );
      } else if (devices.length > 0) {
        // The pack loaded but every device it offered was rejected. This is the
        // lavapipe case and it deserves a specific, non-alarming explanation.
        return devices.some((d) => d.softwareRenderer)
          ? 'only a software renderer was found (no real GPU); falling back to CPU'
          : 'backend loaded but reported no usable devices';
      } else {
        /*
         * Now EARNED: the library was in the scanned directory (or failed to dlopen for a
         * missing driver library such as libcuda.so.1, which is the same conclusion), and
         * enumeration still came back empty.
         */
        return 'installed but enumerated no devices (driver missing or too old)';
      }
    })();

    return { ...common, available: false as const, probed, unavailableReason };
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

/*
 * ★ T-175 删掉了 `nextCandidates()`（"降级链"）。
 *
 * 它的唯一用途是算 `RuntimeDetection.degradationChain`，而那个字段**从来没有读者** ——
 * daemon 算出来、序列化进 `GET /api/runtime/hardware` 的响应、然后没有任何人读它
 * （逐个核过全仓，含 `.mjs` 脚本；本仓刚栽过一次"孤儿检查器只扫 .tsx? 看不见 .mjs"）。
 *
 * 判据（Manager T-175）：**不许留半个功能。有真实读者 → 补契约补测试；零读者 → 删。**
 * 零读者最坏的地方不是浪费空间，是**下一个人会以为它在起作用** ——
 * "降级链"听起来像是产品真的会顺着它退，而实际上退不退全由
 * `blacklistedBackends` + `buildHardwareInfo()` 决定，这个数组只是被一路传到线上然后丢掉。
 *
 * 它包的 `preferenceOrder()` 仍在用（`backendPreference()`），没有被一起删掉。
 */

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
