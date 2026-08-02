/**
 * 本机硬件快照 —— `GET /api/runtime/hardware` 的数据源。
 *
 * ⚠️ 权威实现归 `packages/runtime`（`gpu-runtime` 的 `detectHardware()`），它需要 native
 * probe 子进程**真正枚举设备**才能给出 GPU 列表。本文件是 daemon 侧只依赖 `node:os` 的
 * 诚实兜底：
 *
 *   - 能测的如实测：CPU 型号 / 物理核 / 逻辑核 / ISA flags（Linux 读 /proc/cpuinfo）、
 *     内存、models 根目录所在卷的可用与总容量（statfs）。
 *   - 测不到的一律留空：`gpus: []`。R-02 §A.0 在本机实测过 `libvulkan.so.1` 存在但**没有
 *     任何 GPU** —— 所以"loader 文件在" 绝不能当成"设备可用"，我们宁可报告没有。
 *   - 每个不可用后端都带 `unavailableReason`，让 UI 能解释原因而不是让用户猜。
 *
 * ADR-004 决策 3：绝不编造数字。这里没有任何一个字段是猜的。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Arch, BackendStatus, HardwareInfo, OsPlatform } from '@openmemo/shared';

/** 硬件快照 id。fit 判定是针对某一份快照算出来的，UI 用它判断缓存是否失效。 */
export const HARDWARE_SNAPSHOT_ID = 'hw-local';

function currentOsPlatform(): OsPlatform {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  // 契约只定义了三种平台；其余类 Unix 按 linux 上报（而不是伪造一个新枚举值）
  return 'linux';
}

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
 * 真实 ISA flags。
 *
 * `avx2` 是硬需求信号：llama.cpp / whisper.cpp 的预编译 CPU 后端普遍要求它，
 * fitness.ts 的 `missing_cpu_feature` 判定直接读这个数组。非 Linux 上我们读不到，
 * 就返回空数组 —— 空数组的语义是"未知"，比塞一个猜测值安全得多。
 */
async function cpuFeatures(): Promise<string[]> {
  try {
    const info = await fs.readFile('/proc/cpuinfo', 'utf8');
    const m = /^flags\s*:\s*(.+)$/m.exec(info);
    return m ? m[1].split(/\s+/).filter((f) => f.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * 物理核数。
 *
 * Linux 上按 (physical id, core id) 去重是**真实测量**；拿不到时才退回
 * "逻辑核 / 2" 的超线程假设，并且至少为 1。
 */
async function physicalCoreCount(logicalCores: number): Promise<number> {
  try {
    const info = await fs.readFile('/proc/cpuinfo', 'utf8');
    const pairs = new Set<string>();
    let pkg = '';
    for (const line of info.split('\n')) {
      const m = /^(physical id|core id)\s*:\s*(\d+)/.exec(line);
      if (!m) continue;
      if (m[1] === 'physical id') pkg = m[2];
      else pairs.add(`${pkg}/${m[2]}`);
    }
    if (pairs.size > 0) return pairs.size;
  } catch {
    /* 非 Linux 或无权限 */
  }
  return Math.max(1, Math.floor(logicalCores / 2));
}

/**
 * 除 cpu 外全部不可用的后端清单。
 *
 * 每一条 `unavailableReason` 都说明**判断依据**，因为"为什么我的 4090 用不上"是这个界面
 * 最常见的问题，而"不可用"三个字回答不了它。
 */
function unavailableBackends(features: string[]): BackendStatus[] {
  const platform = currentOsPlatform();
  const macOnly = platform === 'darwin' ? '未枚举到可用设备' : '仅 macOS 可用';
  return [
    {
      id: 'cpu',
      available: true,
      installed: true,
      version: null,
      deviceIndex: null,
      isa: features.includes('avx2') ? 'avx2' : 'baseline',
    },
    {
      id: 'cuda',
      available: false,
      installed: false,
      version: null,
      deviceIndex: null,
      unavailableReason: '未检测到 NVIDIA 设备（需要 packages/runtime 的 probe 子进程真实枚举，daemon 内置探测不做文件存在性判断）',
    },
    {
      id: 'vulkan',
      available: false,
      installed: false,
      version: null,
      deviceIndex: null,
      unavailableReason: '未枚举到 Vulkan 物理设备（libvulkan 存在不等于有设备，R-02 §A.0 已实测）',
    },
    {
      id: 'rocm',
      available: false,
      installed: false,
      version: null,
      deviceIndex: null,
      unavailableReason: '未检测到 AMD ROCm 设备',
    },
    {
      id: 'metal',
      available: false,
      installed: false,
      version: null,
      deviceIndex: null,
      unavailableReason: macOnly,
    },
    {
      id: 'coreml',
      available: false,
      installed: false,
      version: null,
      deviceIndex: null,
      unavailableReason: macOnly,
    },
  ];
}

/** 一次性探测。调用方负责缓存（探测本身不贵，但没必要每个请求都跑）。 */
export async function detectLocalHardware(modelsRoot: string): Promise<HardwareInfo> {
  const cpus = os.cpus();
  const features = await cpuFeatures();
  const vol = await volumeBytes(modelsRoot);

  return {
    schemaVersion: 1,
    detectedAt: new Date().toISOString(),
    os: { platform: currentOsPlatform(), arch: currentArch(), version: os.release() },
    cpu: {
      brand: cpus[0]?.model ?? 'unknown',
      physicalCores: await physicalCoreCount(cpus.length),
      logicalCores: Math.max(1, cpus.length),
      features,
    },
    ram: {
      totalMB: Math.round(os.totalmem() / 1e6),
      availableMB: Math.round(os.freemem() / 1e6),
    },
    // 统一内存只在 Apple Silicon 上成立；这里不做跨平台猜测。
    unifiedMemory: process.platform === 'darwin' && currentArch() === 'arm64',
    // ★ 诚实：daemon 内置探测**不枚举 GPU**，所以一律为空，而不是编一块出来。
    gpus: [],
    backends: unavailableBackends(features),
    selectedBackend: 'cpu',
    selectedGpuIndex: null,
    disks: [
      {
        mount: path.parse(modelsRoot).root,
        pathFor: 'models_root',
        path: modelsRoot,
        freeMB: Math.round(vol.freeBytes / 1e6),
        totalMB: Math.round(vol.totalBytes / 1e6),
      },
    ],
  };
}
