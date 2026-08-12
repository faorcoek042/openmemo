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
 *   Windows — PARTLY VERIFIED. `[CI 实测 2026-08-10, windows-2025, run 31389910051]`
 *             `Get-CimInstance Win32_VideoController` **exit=0 且返回合法 JSON** —— 这条命令
 *             在 win32 上是活的（此前整段标 UNVERIFIED，那是"没查过"，不是"不行"）。
 *             真实返回（该 runner 只有一块虚拟适配器）：
 *               {"Name":"Microsoft Hyper-V Video","AdapterRAM":null,
 *                "DriverVersion":"10.0.26100.1150","PNPDeviceID":"VMBUS\\{DA0A7802-…}\\{5620E0C7-…}"}
 *             两条由此**从推测变成事实**：
 *               · 只有一块适配器时顶层是 **object 而不是 array** —— 下面
 *                 `Array.isArray(raw) ? raw : [raw]` 那条兜底是**必经之路**，不是保险；
 *               · `nvidia-smi` 不存在时是 `spawnSync … ENOENT`（`run()` 收成 ok:false）。
 *
 *             🔴 **同一次实测暴露出一个缺陷**（v0.7.1 已知边界第 7 条公开承认、当时未修）：
 *             `"Microsoft Hyper-V Video"` **匹配不上** `SOFTWARE_ADAPTER_NAMES`
 *             （那条正则里是 `microsoft basic`，不是 `hyper-v`），而它的 `PNPDeviceID` 是
 *             `VMBUS\\…`、**没有 `VEN_xxxx`** ⇒ vendor 落到 `'other'`，然后照样被塞进
 *             `gpus` 并带上 `['vulkan']`。
 *             也就是说：**任何虚拟机里的客户机，都会被我们判成"可能支持 Vulkan"**。
 *             ⚠️ 修法不能简单粗暴 —— 把"虚拟适配器"筛得太狠会误杀真实核显
 *             （用户那台的 Radeon 780M 就是核显）。
 *
 *             ✅ **2026-08-12 修（#86）：上第三态，而不是把"可能支持"翻成"不支持"。**
 *             完整论证在 `@openmemo/shared` 的 `AdvisoryGpuVerdict` 上，一句话版本是两条：
 *               · 「看到虚拟适配器 ⇒ 没有 GPU 加速」**被本仓自己的实测证伪** ——
 *                 两台 macOS runner 的 GPU 都是 `Apple Paravirtual device`，
 *                 而 Metal 在它们上面真的能跑（`warmup.ts` / ADR-003 的 123 ms 热跑）；
 *               · 判成"不支持"会让 Vulkan 包在 `applicability` 里变成"不适用"，
 *                 而 probe 要先装包才能跑 ——
 *                 **等于同时断掉用户唯一能拿到答案的那条路**。
 *             所以虚拟适配器落 `undetermined`：候选后端**照旧进并集**（包仍然可安装），
 *             但界面不再替它说"可能支持"，而是说"我们判断不了"。
 *
 *             ⚠️ 这个缺陷**从来不是 Windows 专属**：下面 Linux 那条路
 *             连软件适配器过滤都没有，`/sys/class/drm` 下每张 card 都直接拿 `['vulkan']`，
 *             而虚拟机里那张 card 的 PCI 厂商号（virtio / QXL / VMware / VirtualBox …）
 *             一个都不在 `PCI_VENDORS` 里 ⇒ 一律 `'other'` ⇒ 同一句假话。
 */

import { readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';

import type { AdvisoryGpuVerdict, Backend, GpuDevice } from '@openmemo/shared';

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

/**
 * **虚拟机/半虚拟化提供的显示适配器**的名字（#86）。
 *
 * `[CI 实测 run 31389910051]` `Microsoft Hyper-V Video` 是这里唯一一条**量到过**的；
 * 其余几条是同族的已知产品名，**没有一台机器实测过**（`vmware svga`、`virtualbox`、
 * `virtio`、`qxl`、`parallels`、`bochs`、`red hat`）。它们判错的代价是有界的：
 * 落到 `undetermined` 只是**少说一句"可能支持"**，候选后端照旧进并集、包照旧可装。
 *
 * ⚠️ 与 {@link SOFTWARE_ADAPTER_NAMES} **不是一回事，不许合并**：
 * 那一条是"软件光栅器，永远不是加速目标"（llvmpipe 会枚举出一个 CPU 设备，
 * 比 CPU 后端还慢），可以直接扔掉；这一条是"**我们不知道它背后有没有真显卡**"
 * —— 扔掉它就是在替一个我们没验过的否定背书。
 */
const VIRTUAL_ADAPTER_NAMES =
  /hyper-v|vmware|virtualbox|virtio|qxl|parallels|bochs|red hat|virtual (display|video|graphics)/i;

/**
 * 虚拟显示设备的 **PCI 厂商号**（Linux 那条路唯一拿得到的身份证）。
 *
 * 这些号码**一个都不在** {@link PCI_VENDORS} 里，所以在这次改动之前它们全部落成
 * `vendor: 'other'` 然后照样带上 `['vulkan']` —— Windows 那句假话在 Linux 上一字不差。
 *
 * `[未实测]` 号码来自公开的 PCI ID 库；本仓那台 T-012 机器上 `/sys/class/drm` 是空的
 * （QEMU 的 VGA 适配器没绑 DRM 驱动），所以**这条路上一个真实样本都没有**。
 * 判错的代价同上：只少说一句"可能支持"。
 */
const VIRTUAL_PCI_VENDORS: Record<string, string> = {
  '0x1af4': 'virtio (QEMU/KVM)',
  '0x1b36': 'Red Hat QXL',
  '0x15ad': 'VMware SVGA',
  '0x80ee': 'VirtualBox',
  '0x1414': 'Microsoft Hyper-V',
  '0x1234': 'QEMU stdvga (Bochs)',
};

/** 一块显示适配器的身份：软件光栅器 / 虚拟机适配器 / 真的一块卡。 */
export type AdapterClass = 'software' | 'virtual' | 'real';

/**
 * **纯函数**，因为它是这次改动里唯一需要被逐条钉死的判断。
 *
 * 三条判据按可信度排序：
 *   ① 名字命中软件光栅器 → `software`（今天就有，行为不变：直接扔掉）
 *   ② `PNPDeviceID` 以 `VMBUS\` 开头 → `virtual`。**这一条是最硬的**：
 *      VMBUS 是 Hyper-V 的虚拟总线，挂在上面的设备不是一块 PCI 显卡。
 *      `[CI 实测]` runner 上那块正是 `VMBUS\{DA0A7802-…}\{5620E0C7-…}`。
 *   ③ 名字或 PCI 厂商号命中虚拟适配器 → `virtual`
 *
 * ⚠️ **顺序不能反**：`Microsoft Basic Render Driver` 同时像 ① 和 ③，
 * 而它是软件光栅器（宿主机上没装驱动时也会出现），不是"虚拟机适配器"。
 *
 * ⚠️ **真核显不许落进 `virtual`**：用户那台的 `AMD Radeon(TM) 780M Graphics`
 * 三条判据一条都不命中（`PCI\VEN_1002&…`），这是这个函数的头号回归风险，
 * `gpu.test.ts` 里为它单独钉了一条。
 */
export function classifyDisplayAdapter(input: {
  name: string;
  /** Windows：`Win32_VideoController.PNPDeviceID`。 */
  pnpDeviceId?: string | undefined;
  /** Linux：`/sys/class/drm/cardN/device/vendor`（小写 `0x` 前缀）。 */
  pciVendorId?: string | undefined;
}): AdapterClass {
  if (SOFTWARE_ADAPTER_NAMES.test(input.name)) return 'software';
  if (/^vmbus\\/i.test(input.pnpDeviceId ?? '')) return 'virtual';
  if (input.pciVendorId !== undefined && input.pciVendorId in VIRTUAL_PCI_VENDORS) return 'virtual';
  if (VIRTUAL_ADAPTER_NAMES.test(input.name)) return 'virtual';
  return 'real';
}

/**
 * 虚拟适配器的三态结论。
 *
 * 它要回答的是用户真正问的那个问题：**这台机器上到底能不能用 GPU 加速？**
 * 诚实的答案是"我们还没回答"，而不是"不能"。
 *
 * ⚠️ **这里不再拼那句中文。** 上一版返回的是一整句 daemon 写好的中文，
 * 硬件卡原样渲染 —— 后果是**它没法翻译**：英文界面上会冒出一整句中文，
 * 而"往 `en.json` 里塞中文占位"正是本版在治的那个形状
 * （v0.7.1 已知边界里那颗写死中文的「检查更新」按钮）。
 * 所以 daemon 只说**是什么原因**（`'virtual_adapter'`）
 * 与**要装什么才问得出答案**（`probeWith`），措辞归 `apps/web` 的两份 locale，
 * 那边有一张总 `Record` 逼着每种原因都得有话说。
 *
 * 适配器**叫什么**不在这里拼进句子：`AdvisoryGpu.name` 本来就一起发出去了，
 * 界面拿它填模板 —— 同一个事实不写两遍。
 */
export function virtualAdapterVerdict(probeWith: Backend[]): AdvisoryGpuVerdict {
  return { kind: 'undetermined', reason: 'virtual_adapter', probeWith };
}

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
        /*
         * nvidia-smi 回话 = 驱动装着、卡在那儿。这是本文件里**最强的一条证据**，
         * 直通到虚拟机里的 N 卡走的也是这一支（客户机里装的是真驱动）——
         * 所以它是 `candidate`，不是 `undetermined`。
         */
        verdict: { kind: 'candidate', backends: ['cuda', 'vulkan'] },
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

    const name = (await readPciName(base)) ?? `${vendor} GPU (${card})`;
    /*
     * ★ #86：Linux 这条路**此前没有任何过滤** —— 虚拟机里那张 card
     * （virtio / QXL / VMware / VirtualBox …）的厂商号一个都不在 `PCI_VENDORS` 里，
     * 于是 `'other'` + `['vulkan']`，与 Windows 上那句"可能支持 Vulkan"一字不差。
     * 名字还是 `readPciName()` 拼出来的 `PCI 0x1af4:0x1050`，用户更无从判断。
     */
    /*
     * 这里**只喂 PCI 厂商号**，刻意不喂名字：`readPciName()` 拼出来的是
     * `PCI 0x1af4:0x1050` 这种纯数字串（无 udev/hwdb 依赖，见那个函数的注释），
     * 拿它去匹配产品名正则是演戏 —— 永远不会命中，还会让人以为这条路有名字过滤。
     * 于是这条路上 `classifyDisplayAdapter` 只可能回 `virtual` / `real`。
     */
    const isVirtual = classifyDisplayAdapter({ pciVendorId: vendorId, name: '' }) === 'virtual';
    const verdict: AdvisoryGpuVerdict = isVirtual
      ? virtualAdapterVerdict(candidateBackends)
      : { kind: 'candidate', backends: candidateBackends };

    gpus.push({
      vendor,
      /*
       * 虚拟适配器**报出它是哪种虚拟化**，而不是 `PCI 0x1af4:0x1050`。
       * 界面那句「「{adapter}」是虚拟机提供的显示适配器」要把这个名字填进去，
       * 而一串裸 PCI 号对用户等于没说 —— 原始号码没丢，仍在 `capabilities.pciVendorId`。
       */
      name: (isVirtual ? VIRTUAL_PCI_VENDORS[vendorId] : undefined) ?? name,
      vramTotalMB: Number.isFinite(vramBytes) && vramBytes > 0 ? Math.round(vramBytes / 1e6) : null,
      driverVersion: null,
      verdict,
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
          /*
           * ★ #86：macOS 这条路**刻意不判 `virtual`**，而这正是这次改动的关键反例。
           *
           * 两台 CI runner 的 `sppci_model` 就是 `Apple Paravirtual device` ——
           * 一块不折不扣的虚拟适配器。`[实测]` 探针在它上面**真的枚举到了 Metal 设备**
           * 并跑出 123 ms / 90 ms 的热样本（`warmup.ts`、ADR-003）。
           * 也就是说：**半虚拟化 ≠ 没有加速**，把它判成 `undetermined`
           * 会把一个我们量过、确实能跑的配置降级成"我们不知道"。
           *
           * 而且这里的证据本来就比名字硬：`spdisplays_mtlgpufamilysupport` 是
           * 系统报出来的**能力**，不是一个产品名。有能力就是 `candidate`。
           */
          verdict: { kind: 'candidate', backends: candidateBackends },
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
      verdict: { kind: 'candidate', backends: ['metal'] },
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
        /* 同 Linux 那一支：nvidia-smi 回话 = 真驱动 + 真卡（直通进虚拟机的也走这里）。 */
        verdict: { kind: 'candidate', backends: ['cuda', 'vulkan'] },
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

        const klass = classifyDisplayAdapter({ name, pnpDeviceId: entry.PNPDeviceID });

        // Microsoft Basic Render Driver / WARP is a software adapter, never a target.
        if (klass === 'software') {
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
          /*
           * ADR-003 decision 3: Vulkan is the default for AMD and Intel on Windows.
           * DirectML is NOT offered — ggml has no DirectML backend, so choosing it would
           * mean swapping the whole inference stack (see R-02 §B.5).
           *
           * ★ #86：**虚拟机适配器落 `undetermined`，但候选后端一个不少**
           * （`probeWith` 照旧进 `advisoryBackends` 并集 ⇒ Vulkan 包仍然可安装）。
           * 变的只有界面那句话：从"可能支持 Vulkan"变成"判断不了，装上探一次才知道"。
           */
          verdict:
            klass === 'virtual'
              ? virtualAdapterVerdict(['vulkan'])
              : { kind: 'candidate', backends: ['vulkan'] },
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
