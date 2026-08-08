/**
 * ADVISORY GPU detection.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────┐
 * │ READ THIS BEFORE CHANGING ANYTHING IN THIS FILE.                                   │
 * │                                                                                    │
 * │ Nothing here is authoritative. Its ONLY job is to answer "which backend pack       │
 * │ should we download first?" — because we must choose a pack before we own any       │
 * │ backend to enumerate with. The verdict on whether a backend actually works comes   │
 * │ from the probe (probe/runProbe.ts), always.                                        │
 * │                                                                                    │
 * │ Two reverse-examples, both MEASURED on the T-012 Linux box:                        │
 * │                                                                                    │
 * │  1. `libvulkan.so.1` AND `libOpenCL.so.1` were both present via ldconfig on a      │
 * │     machine with no GPU whatsoever — no /dev/dri, empty /sys/class/drm, lspci      │
 * │     showing only a QEMU virtual VGA adapter. Library presence proves nothing.      │
 * │                                                                                    │
 * │  2. After `apt-get install vulkan-tools` pulled in Mesa's lavapipe ICD, Vulkan     │
 * │     began reporting ONE physical device: `llvmpipe (LLVM 21.1.8, 256 bits)`,       │
 * │     deviceType = PHYSICAL_DEVICE_TYPE_CPU. So even "device count > 0" is not       │
 * │     sufficient — a software rasteriser will happily enumerate and then             │
 * │     software-rasterise every matmul, which is far slower than the CPU backend.     │
 * │                                                                                    │
 * │ Hence: no function in this file may return "backend X is available". They return   │
 * │ CANDIDATES.                                                                        │
 * └───────────────────────────────────────────────────────────────────────────────────┘
 *
 * VERIFICATION STATUS
 *   Linux   — VERIFIED on the T-012 box (all commands executed; the no-GPU paths are
 *             exactly what produced the reverse-examples above).
 *   macOS   — UNVERIFIED. No Mac available. Commands from Apple documentation.
 *   Windows — UNVERIFIED. No Windows machine available. APIs from Microsoft docs.
 */

import { readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';

import type { Backend, GpuDevice } from '@openmemo/shared';

import type { AdvisoryDetection, AdvisoryGpu } from '../types.js';
import { run } from './system.js';

/** PCI vendor IDs. 0x1414 is Microsoft's WARP software adapter and must be excluded. */
const PCI_VENDORS: Record<string, GpuDevice['vendor']> = {
  '0x10de': 'nvidia',
  '0x1002': 'amd',
  '0x1022': 'amd',
  '0x8086': 'intel',
  '0x106b': 'apple',
};

const SOFTWARE_ADAPTER_NAMES =
  /llvmpipe|lavapipe|swiftshader|softpipe|basic render|microsoft basic|warp/i;

export async function detectGpus(): Promise<AdvisoryDetection> {
  switch (os.platform()) {
    case 'linux':
      return detectGpusLinux();
    case 'darwin':
      return detectGpusDarwin();
    case 'win32':
      return detectGpusWin32();
    default:
      return { gpus: [], warnings: [`unsupported platform: ${os.platform()}`] };
  }
}

// =======================================================================================
// Linux — VERIFIED on the T-012 box
// =======================================================================================

async function detectGpusLinux(): Promise<AdvisoryDetection> {
  const warnings: string[] = [];
  const gpus: AdvisoryGpu[] = [];

  // --- NVIDIA: nvidia-smi is the richest source when the driver is installed. ---------
  // VERIFIED absent on the T-012 box, which is the clean negative signal we want:
  // no driver => no nvidia-smi => no CUDA candidate. Never infer CUDA from file paths.
  const smi = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,driver_version,compute_cap',
    '--format=csv,noheader,nounits',
  ]);
  if (smi.ok) {
    for (const line of smi.stdout.trim().split('\n').filter(Boolean)) {
      const [name, memTotal, driver, cc] = line.split(',').map((s) => s.trim());
      gpus.push({
        vendor: 'nvidia',
        name: name ?? 'NVIDIA GPU',
        // nvidia-smi reports MiB; the contract is decimal MB.
        vramTotalMB: toDecimalMB(Number(memTotal)),
        driverVersion: driver ?? null,
        candidateBackends: ['cuda', 'vulkan'],
        capabilities: cc ? { cudaComputeCapability: cc } : {},
        source: 'nvidia-smi',
      });
    }
  }

  // --- Everything else: sysfs DRM is the authoritative kernel view. -------------------
  // VERIFIED on the T-012 box: /sys/class/drm was EMPTY and /dev/dri did not exist.
  // Absence handling is the common case on headless servers, VMs and containers.
  let cards: string[] = [];
  try {
    cards = (await readdir('/sys/class/drm')).filter((d) => /^card\d+$/.test(d));
  } catch {
    warnings.push('/sys/class/drm not readable (headless VM, container, or no DRM driver)');
  }

  for (const card of cards) {
    const base = `/sys/class/drm/${card}/device`;
    const vendorId = (await readTextOrNull(`${base}/vendor`))?.trim().toLowerCase();
    if (vendorId === undefined) continue;

    const vendor = PCI_VENDORS[vendorId] ?? 'other';
    // NVIDIA is already covered by nvidia-smi with far better data.
    if (vendor === 'nvidia' && gpus.some((g) => g.vendor === 'nvidia')) continue;

    // amdgpu exposes VRAM here; other drivers do not, and null is the honest answer.
    const vramBytes = Number((await readTextOrNull(`${base}/mem_info_vram_total`))?.trim() ?? '');

    const candidateBackends: Backend[] = ['vulkan'];
    // ROCm is deliberately NOT a default candidate: ADR-003 decision 3 makes Vulkan the
    // default for AMD, and ROCm requires a kernel driver the user must install manually.
    if (vendor === 'amd' && (await pathExists('/opt/rocm/.info/version'))) {
      candidateBackends.push('rocm');
    }

    gpus.push({
      vendor,
      name: (await readPciName(base)) ?? `${vendor} GPU (${card})`,
      vramTotalMB: Number.isFinite(vramBytes) && vramBytes > 0 ? Math.round(vramBytes / 1e6) : null,
      driverVersion: null,
      candidateBackends,
      capabilities: { pciVendorId: vendorId },
      source: `sysfs:${card}`,
    });
  }

  // --- WSL2: NVIDIA there is a D3D12 shim, not a normal driver. -----------------------
  if (gpus.length === 0) {
    const procVersion = (await readTextOrNull('/proc/version')) ?? '';
    if (/microsoft/i.test(procVersion)) {
      warnings.push(
        'running under WSL2: GPU access goes through /dev/dxg and /usr/lib/wsl/lib. ' +
          'Detection is unreliable here; the probe decides.',
      );
    }
  }

  if (gpus.length === 0) warnings.push('no GPU detected; CPU backend only');
  return { gpus, warnings };
}

async function readPciName(base: string): Promise<string | null> {
  // No udev/hwdb dependency: report the raw IDs and let the probe supply the real name.
  const device = (await readTextOrNull(`${base}/device`))?.trim();
  const vendor = (await readTextOrNull(`${base}/vendor`))?.trim();
  if (vendor === undefined || device === undefined) return null;
  return `PCI ${vendor}:${device}`;
}

// =======================================================================================
// macOS — UNVERIFIED (no Mac available)
// =======================================================================================

async function detectGpusDarwin(): Promise<AdvisoryDetection> {
  const warnings: string[] = ['macOS GPU detection is UNVERIFIED — written from Apple docs only'];
  const gpus: AdvisoryGpu[] = [];

  const isAppleSilicon = os.arch() === 'arm64';

  // system_profiler can take seconds; callers must cache. -detailLevel mini trims it.
  const sp = await run(
    'system_profiler',
    ['-json', '-detailLevel', 'mini', 'SPDisplaysDataType'],
    8_000,
  );

  if (sp.ok) {
    try {
      const parsed = JSON.parse(sp.stdout) as {
        SPDisplaysDataType?: {
          sppci_model?: string;
          spdisplays_vendor?: string;
          spdisplays_vram?: string;
          spdisplays_mtlgpufamilysupport?: string;
        }[];
      };
      for (const d of parsed.SPDisplaysDataType ?? []) {
        const name = d.sppci_model ?? 'Apple GPU';
        const vendor: GpuDevice['vendor'] = isAppleSilicon
          ? 'apple'
          : /amd|radeon/i.test(name)
            ? 'amd'
            : /intel/i.test(name)
              ? 'intel'
              : /nvidia|geforce/i.test(name)
                ? 'nvidia'
                : 'other';

        const candidateBackends: Backend[] = [];
        // Metal is guaranteed on every Mac since 10.13 — there is no driver to check,
        // and GGML_METAL_EMBED_LIBRARY means the shaders live inside the binary. This is
        // why the Metal "pack" is a zero-byte download: it is already in the core pack.
        if (d.spdisplays_mtlgpufamilysupport !== undefined || isAppleSilicon) {
          candidateBackends.push('metal');
        }

        gpus.push({
          vendor,
          name,
          // Apple silicon is unified memory: VRAM is a category error. The contract says
          // report null and let the fitness calculator use system RAM instead.
          vramTotalMB: isAppleSilicon ? null : parseVramString(d.spdisplays_vram),
          driverVersion: null,
          candidateBackends,
          capabilities: d.spdisplays_mtlgpufamilysupport
            ? { metalFamily: d.spdisplays_mtlgpufamilysupport }
            : {},
          source: 'system_profiler SPDisplaysDataType',
        });
      }
    } catch {
      warnings.push('could not parse system_profiler JSON output');
    }
  } else {
    warnings.push(`system_profiler failed: ${sp.error}`);
  }

  if (gpus.length === 0 && isAppleSilicon) {
    // Belt and braces: every Apple silicon Mac has a Metal-capable GPU by construction.
    gpus.push({
      vendor: 'apple',
      name: 'Apple Silicon GPU',
      vramTotalMB: null,
      driverVersion: null,
      candidateBackends: ['metal'],
      capabilities: {},
      source: 'assumed (arm64 Darwin)',
    });
  }

  return { gpus, warnings };
}

function parseVramString(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /([\d.]+)\s*(MB|GB)/i.exec(v);
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2]?.toUpperCase() === 'GB' ? n * 1000 : n);
}

// =======================================================================================
// Windows — UNVERIFIED (no Windows machine available)
// =======================================================================================

async function detectGpusWin32(): Promise<AdvisoryDetection> {
  const warnings: string[] = [
    'Windows GPU detection is UNVERIFIED — written from Microsoft docs only',
  ];
  const gpus: AdvisoryGpu[] = [];

  // NVIDIA first: nvidia-smi.exe lands in System32 with the driver.
  const smi = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,driver_version,compute_cap',
    '--format=csv,noheader,nounits',
  ]);
  if (smi.ok) {
    for (const line of smi.stdout.trim().split('\n').filter(Boolean)) {
      const [name, memTotal, driver, cc] = line.split(',').map((s) => s.trim());
      gpus.push({
        vendor: 'nvidia',
        name: name ?? 'NVIDIA GPU',
        vramTotalMB: toDecimalMB(Number(memTotal)),
        driverVersion: driver ?? null,
        candidateBackends: ['cuda', 'vulkan'],
        capabilities: cc ? { cudaComputeCapability: cc } : {},
        source: 'nvidia-smi',
      });
    }
  }

  /*
   * Everything else via CIM.
   *
   * DELIBERATELY NOT `wmic`: it is deprecated and was removed from the Windows 11 24H2
   * default image, so a wmic-based detector would simply fail on current Windows.
   *
   * KNOWN DEFECT of Win32_VideoController.AdapterRAM: it is a **uint32**, so any GPU
   * with more than 4 GB of VRAM wraps around and reports garbage. We therefore read it
   * but treat >= 4095 MB as "unknown" rather than lying to the fitness calculator.
   * The correct fix is DXGI's DXGI_ADAPTER_DESC1.DedicatedVideoMemory (a SIZE_T), which
   * needs a native addon; the probe already reports real VRAM per device, so we take
   * the accurate number from there instead of adding an addon just for this.
   */
  const ps = await run(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID | ConvertTo-Json -Compress',
    ],
    8_000,
  );

  if (ps.ok) {
    try {
      const raw: unknown = JSON.parse(ps.stdout);
      const list = Array.isArray(raw) ? raw : [raw];
      for (const entry of list as {
        Name?: string;
        AdapterRAM?: number;
        DriverVersion?: string;
        PNPDeviceID?: string;
      }[]) {
        const name = entry.Name ?? 'Unknown display adapter';

        // Microsoft Basic Render Driver / WARP is a software adapter, never a target.
        if (SOFTWARE_ADAPTER_NAMES.test(name)) {
          warnings.push(`ignoring software adapter: ${name}`);
          continue;
        }

        const vendorId = /VEN_([0-9A-F]{4})/i.exec(entry.PNPDeviceID ?? '')?.[1]?.toLowerCase();
        const vendor: GpuDevice['vendor'] =
          vendorId !== undefined ? (PCI_VENDORS[`0x${vendorId}`] ?? 'other') : 'other';

        if (vendor === 'nvidia' && gpus.some((g) => g.vendor === 'nvidia')) continue;

        const ramMB =
          typeof entry.AdapterRAM === 'number' ? Math.round(entry.AdapterRAM / 1e6) : null;
        const trustworthy = ramMB !== null && ramMB > 0 && ramMB < 4095;

        gpus.push({
          vendor,
          name,
          vramTotalMB: trustworthy ? ramMB : null,
          driverVersion: entry.DriverVersion ?? null,
          // ADR-003 decision 3: Vulkan is the default for AMD and Intel on Windows.
          // DirectML is NOT offered — ggml has no DirectML backend, so choosing it would
          // mean swapping the whole inference stack (see R-02 §B.5).
          candidateBackends: ['vulkan'],
          capabilities: vendorId !== undefined ? { pciVendorId: `0x${vendorId}` } : {},
          source: 'Get-CimInstance Win32_VideoController',
        });
      }
    } catch {
      warnings.push('could not parse Get-CimInstance JSON output');
    }
  } else {
    warnings.push(`Get-CimInstance failed: ${ps.error}`);
  }

  if (gpus.length === 0) warnings.push('no GPU detected; CPU backend only');
  return { gpus, warnings };
}

// =======================================================================================
// helpers
// =======================================================================================

/** nvidia-smi and Win32 report MiB; the shared contract is decimal MB. */
function toDecimalMB(mib: number): number | null {
  if (!Number.isFinite(mib) || mib <= 0) return null;
  return Math.round((mib * 1024 * 1024) / 1e6);
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await readTextOrNull(path)) !== null;
}

export { SOFTWARE_ADAPTER_NAMES };
