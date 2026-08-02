/**
 * Hardware description contract.
 *
 * STATUS: FORMAL CONTRACT (ADR-003 / BOARD T-012+T-013).
 * Producer: `packages/runtime` (`gpu-runtime`).
 * Consumer: `packages/shared/fitness.ts`, `packages/downloader`, daemon, web UI.
 *
 * Originally proposed in R-04 §7.1 as a placeholder; the Manager promoted it to a
 * formal contract. `gpu-runtime` implements the producer side against this file.
 *
 * DESIGN NOTE (R-02 §A.0, verified on the Linux box): the presence of a loader
 * library is NOT evidence of a usable device. `libvulkan.so.1` existed on a machine
 * with no GPU at all. Therefore `GpuDevice[]` MUST be populated by actually
 * enumerating devices (running the probe subprocess), never by file-existence checks.
 * `BackendStatus.available` carries that distinction explicitly.
 */

/** Accelerator backends. Extended per ADR-004 decision 4 (memo.ac only had cuda/metal/coreml). */
export const BACKENDS = ['cuda', 'vulkan', 'rocm', 'metal', 'coreml', 'cpu'] as const;
export type Backend = (typeof BACKENDS)[number];

export const OS_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type OsPlatform = (typeof OS_PLATFORMS)[number];

export const ARCHS = ['x64', 'arm64'] as const;
export type Arch = (typeof ARCHS)[number];

export interface OsInfo {
  platform: OsPlatform;
  arch: Arch;
  /** Raw OS version string, e.g. "10.0.22631", "14.5", "6.8.0-40-generic". */
  version: string;
}

export interface CpuInfo {
  brand: string;
  physicalCores: number;
  logicalCores: number;
  /**
   * Lowercase ISA feature flags. MUST include "avx2" when supported —
   * prebuilt CPU backends for llama.cpp/whisper.cpp generally require it,
   * and LM Studio's published system requirements state it outright.
   */
  features: string[];
}

export interface MemoryInfo {
  totalMB: number;
  /** Best-effort currently-available memory. `null` if the platform cannot report it. */
  availableMB: number | null;
}

export interface GpuDevice {
  index: number;
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
  name: string;
  /** Total VRAM. `null` on unified-memory systems where the concept does not apply. */
  vramTotalMB: number | null;
  /**
   * Free VRAM at detection time. `null` if unavailable.
   * Consumers MUST degrade to `vramTotalMB * 0.85` when null — never assume total is free.
   * (LM Studio shows total rather than free and mis-badges models as a result.)
   */
  vramFreeMB: number | null;
  driverVersion: string | null;
  /** e.g. { cudaComputeCapability: "8.9" } or { vulkanApiVersion: "1.3" }. */
  capabilities: Record<string, string>;
  /** Backends this specific device can serve, as proven by real enumeration. */
  backends: Backend[];
}

export interface BackendStatus {
  id: Backend;
  /** Device enumeration succeeded and returned >= 1 device. NOT a file-existence check. */
  available: boolean;
  /** The backend package is present on disk and loadable. */
  installed: boolean;
  version: string | null;
  /** Index into HardwareInfo.gpus, when this backend is bound to a specific device. */
  deviceIndex: number | null;
  /** For the CPU backend: which ISA build is active, e.g. "avx2". */
  isa?: string | null;
  /** Populated when available=false so the UI can explain why. */
  unavailableReason?: string | null;
}

export interface DiskInfo {
  /** Mount point or drive root. */
  mount: string;
  /** Which logical role this volume serves; the downloader cares about "models_root". */
  pathFor: 'models_root' | 'runtimes_root' | 'other';
  path: string;
  freeMB: number;
  totalMB: number;
}

export interface HardwareInfo {
  schemaVersion: 1;
  detectedAt: string;
  os: OsInfo;
  cpu: CpuInfo;
  ram: MemoryInfo;
  /**
   * True on Apple Silicon (and other UMA systems). When true, `gpus[].vramTotalMB`
   * is meaningless and the VRAM budget is derived from system RAM instead.
   * Omitting this field silently breaks every fit calculation on Macs.
   */
  unifiedMemory: boolean;
  gpus: GpuDevice[];
  backends: BackendStatus[];
  /** Currently selected inference backend. "cpu" is always a valid fallback. */
  selectedBackend: Backend;
  /** Index into `gpus` for the selected device; null for CPU-only. */
  selectedGpuIndex: number | null;
  disks: DiskInfo[];
}

/** Minimal hardware shape the fitness calculator depends on. Documented so `gpu-runtime`
 *  knows exactly which fields are load-bearing versus merely informational. */
export const FITNESS_REQUIRED_FIELDS = [
  'cpu.features',
  'ram.totalMB',
  'unifiedMemory',
  'gpus[].vramTotalMB',
  'gpus[].vramFreeMB',
  'selectedBackend',
  'selectedGpuIndex',
  'disks[pathFor=models_root].freeMB',
] as const;
