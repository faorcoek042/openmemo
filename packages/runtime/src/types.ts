/**
 * Internal types for @openmemo/runtime.
 *
 * The PUBLIC contract lives in `@openmemo/shared` (hardware.ts / backends.ts) and is
 * owned jointly with `model-mgmt` (ADR-003 decision 6). This file holds only the shapes
 * that never leave this package: the probe's wire format and detection intermediates.
 */

import type { Backend, GpuDevice } from '@openmemo/shared';

// ---------------------------------------------------------------------------------------
// Probe wire format — must stay in lockstep with packages/runtime/src/native/probe.c
// ---------------------------------------------------------------------------------------

/** ggml device classes, mirroring `enum ggml_backend_dev_type`. */
export type ProbeDeviceType = 'cpu' | 'gpu' | 'igpu' | 'accel' | 'meta' | 'unknown';

export interface ProbeDevice {
  index: number;
  /** Backend-assigned device name, e.g. "CPU", "Vulkan0", "CUDA0". */
  name: string;
  /** Human-readable model string, e.g. "NVIDIA GeForce RTX 4070". */
  description: string;
  /** Registry name of the owning backend, e.g. "CPU", "Vulkan", "CUDA". */
  backendReg: string;
  type: ProbeDeviceType;
  memFreeBytes: number;
  memTotalBytes: number;
  /**
   * True when the device looks like a software rasteriser (llvmpipe/lavapipe/
   * SwiftShader/WARP).
   *
   * MEASURED on the T-012 box: after `apt-get install vulkan-tools` pulled in Mesa's
   * lavapipe ICD, a machine with NO GPU began reporting one Vulkan physical device
   * (deviceType CPU). ggml-vulkan already rejects it upstream — it only accepts
   * eDiscreteGpu / eIntegratedGpu — but we surface the flag anyway so the UI can say
   * "Vulkan is present but there is no usable GPU" instead of silently doing nothing.
   */
  softwareRenderer: boolean;
}

export interface ProbeOutput {
  schemaVersion: 1;
  /** ggml library version, e.g. "0.15.1". Gates cross-engine backend pack reuse. */
  ggmlVersion: string;
  ggmlCommit: string;
  searchPath: string;
  deviceCount: number;
  devices: ProbeDevice[];
}

export type ProbeFailureKind =
  | 'missing_probe'
  | 'missing_backend_dir'
  | 'timeout'
  | 'crash'
  | 'exec_error'
  | 'bad_output';

export type ProbeResult =
  | { ok: true; output: ProbeOutput; durationMs: number; stderr: string }
  | { ok: false; kind: ProbeFailureKind; message: string; durationMs: number; stderr: string };

// ---------------------------------------------------------------------------------------
// Runtime type guards.
//
// The probe is a native binary we spawn; treating its stdout as trusted would be
// careless. Validate before it reaches the contract types.
// ---------------------------------------------------------------------------------------

const DEVICE_TYPES: readonly ProbeDeviceType[] = ['cpu', 'gpu', 'igpu', 'accel', 'meta', 'unknown'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isProbeDevice(v: unknown): v is ProbeDevice {
  if (!isRecord(v)) return false;
  return (
    typeof v.index === 'number' &&
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    typeof v.backendReg === 'string' &&
    typeof v.type === 'string' &&
    DEVICE_TYPES.includes(v.type as ProbeDeviceType) &&
    typeof v.memFreeBytes === 'number' &&
    typeof v.memTotalBytes === 'number' &&
    typeof v.softwareRenderer === 'boolean'
  );
}

export function isProbeOutput(v: unknown): v is ProbeOutput {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.ggmlVersion !== 'string') return false;
  if (typeof v.ggmlCommit !== 'string') return false;
  if (typeof v.searchPath !== 'string') return false;
  if (typeof v.deviceCount !== 'number') return false;
  if (!Array.isArray(v.devices)) return false;
  return v.devices.every(isProbeDevice);
}

// ---------------------------------------------------------------------------------------
// Detection intermediates
// ---------------------------------------------------------------------------------------

/**
 * A GPU seen by an *advisory* platform query (DXGI / system_profiler / lspci / nvidia-smi).
 *
 * ADVISORY IS THE OPERATIVE WORD. R-02 §A.0 found `libvulkan.so.1` and `libOpenCL.so.1`
 * installed on a machine with no GPU, no /dev/dri and an empty /sys/class/drm. These
 * queries exist only to answer "which backend pack should we download first?" — the
 * verdict on whether a backend actually works comes from the probe, never from here.
 */
export interface AdvisoryGpu {
  vendor: GpuDevice['vendor'];
  name: string;
  vramTotalMB: number | null;
  driverVersion: string | null;
  /** Backends this device plausibly supports, pending probe confirmation. */
  candidateBackends: Backend[];
  capabilities: Record<string, string>;
  /** Where this came from, so the UI and logs can attribute it. */
  source: string;
}

export interface AdvisoryDetection {
  gpus: AdvisoryGpu[];
  /** Non-fatal problems worth surfacing (tool missing, permission denied, parse failure). */
  warnings: string[];
}

/** Result of the post-install self-test (real inference, not a file check). */
export interface SelfTestOutcome {
  passed: boolean;
  ranAt: string;
  devicesFound: number;
  /** wall-clock seconds / audio seconds. Lower is faster. */
  rtf: number | null;
  /** 1 / rtf — what we actually show the user ("about 35x real time"). */
  speedup: number | null;
  backendUsed: string | null;
  transcriptSimilarity: number | null;
  errorMessage: string | null;
}
