/**
 * OS / CPU / RAM / disk detection.
 *
 * Produces the non-GPU half of `HardwareInfo` (@openmemo/shared/hardware.ts).
 *
 * VERIFICATION STATUS
 *   Linux  — VERIFIED on the T-012 box (Debian, x86_64, AMD Ryzen AI MAX+ 395, 32 vCPU).
 *            /proc/cpuinfo reported: avx avx2 avx512f f16c fma sse4_2.
 *   macOS  — UNVERIFIED. No Mac available. Commands taken from Apple documentation.
 *   Windows— UNVERIFIED. No Windows machine available. APIs from Microsoft documentation.
 */

import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import * as os from 'node:os';
import { promisify } from 'node:util';

import type { Arch, CpuInfo, DiskInfo, MemoryInfo, OsInfo, OsPlatform } from '@openmemo/shared';

import { CHILD_KILL_SIGNAL } from '../childEnv.js';

const execFileAsync = promisify(execFile);

/** Short-lived shell-outs only; anything slower than this is not worth blocking startup. */
const CMD_TIMEOUT_MS = 5_000;

export async function run(
  cmd: string,
  args: string[],
  timeoutMs = CMD_TIMEOUT_MS,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      /*
       * ★ 没有这一行，上面那个 `timeout` **不是一个上界**（T-153）。
       *
       * 默认信号是 SIGTERM，可被子进程忽略；忽略之后 `execFile` 的回调永不触发、
       * promise 永不 settle。这条 `run()` 上跑的是 `lspci` / `wmic` / `sw_vers`
       * 之类的**硬件探测**，而硬件探测在**启动时**跑 —— 于是 daemon 卡在启动上，
       * 而唯一本该救它的东西（超时）正是坏掉的那个。
       * 另两处（`probe/runProbe.ts`、`selfTest.ts`）一直都带着它，只有这里漏了。
       */
      killSignal: CHILD_KILL_SIGNAL,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------------------
// OS
// ---------------------------------------------------------------------------------------

export function detectOs(): OsInfo {
  const platform = os.platform();
  const arch = os.arch();

  const mappedPlatform: OsPlatform =
    platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux';

  // We only ship packs for x64 and arm64. Anything else is treated as x64 and will fail
  // loudly at pack-selection time rather than silently mis-installing.
  const mappedArch: Arch = arch === 'arm64' ? 'arm64' : 'x64';

  return { platform: mappedPlatform, arch: mappedArch, version: os.release() };
}

// ---------------------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------------------

/**
 * ISA feature flags, lowercased.
 *
 * NOTE ON SCOPE: we do NOT use these to choose a CPU backend. ggml's
 * GGML_CPU_ALL_VARIANTS ships ~12 micro-architecture builds and picks the best via
 * ggml_backend_score() at load time — measured on the T-012 box, it correctly chose
 * `zen4` out of 12 candidates with no help from us. These flags exist only for the
 * fitness calculator, which needs `avx2` to decide whether a model is runnable at all.
 */
export async function detectCpu(): Promise<CpuInfo> {
  const cpus = os.cpus();
  const brand = cpus[0]?.model?.trim() ?? 'unknown';
  const logicalCores = cpus.length || 1;

  switch (os.platform()) {
    case 'linux':
      return detectCpuLinux(brand, logicalCores);
    case 'darwin':
      return detectCpuDarwin(brand, logicalCores);
    case 'win32':
      return detectCpuWin32(brand, logicalCores);
    default:
      return { brand, physicalCores: logicalCores, logicalCores, features: [] };
  }
}

/** VERIFIED on the T-012 box. */
async function detectCpuLinux(brand: string, logicalCores: number): Promise<CpuInfo> {
  let features: string[] = [];
  let physicalCores = logicalCores;
  let brandOut = brand;

  try {
    const text = await readFile('/proc/cpuinfo', 'utf8');

    const flagLine = text
      .split('\n')
      .find((l) => l.startsWith('flags') || l.startsWith('Features'));
    if (flagLine) {
      const raw = flagLine.split(':')[1] ?? '';
      features = normaliseFeatures(raw.trim().split(/\s+/));
    }

    const modelLine = text.split('\n').find((l) => l.startsWith('model name'));
    if (modelLine) brandOut = (modelLine.split(':')[1] ?? brand).trim();

    // "cpu cores" is per-socket; multiply by the number of distinct physical ids.
    const coresPerSocket = Number(
      text
        .split('\n')
        .find((l) => l.startsWith('cpu cores'))
        ?.split(':')[1]
        ?.trim() ?? '0',
    );
    const sockets = new Set(
      text
        .split('\n')
        .filter((l) => l.startsWith('physical id'))
        .map((l) => l.split(':')[1]?.trim()),
    ).size;
    if (coresPerSocket > 0) physicalCores = coresPerSocket * Math.max(sockets, 1);
  } catch {
    // Containers can restrict /proc. Logical core count is still a usable answer.
  }

  return { brand: brandOut, physicalCores, logicalCores, features };
}

/** UNVERIFIED — no macOS machine available. */
async function detectCpuDarwin(brand: string, logicalCores: number): Promise<CpuInfo> {
  const features = new Set<string>();
  let physicalCores = logicalCores;
  let brandOut = brand;

  const brandRes = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
  if (brandRes.ok) brandOut = brandRes.stdout.trim() || brand;

  const physRes = await run('sysctl', ['-n', 'hw.physicalcpu']);
  if (physRes.ok) {
    const n = Number(physRes.stdout.trim());
    if (Number.isFinite(n) && n > 0) physicalCores = n;
  }

  const isArm = os.arch() === 'arm64';
  if (isArm) {
    // Apple silicon: NEON and friends are architectural, not optional. There is no AVX.
    ['neon', 'fp16', 'dotprod', 'asimd'].forEach((f) => features.add(f));
    // Apple exposes newer ISA extensions as hw.optional.* booleans.
    for (const key of ['hw.optional.arm.FEAT_I8MM', 'hw.optional.arm.FEAT_BF16']) {
      const r = await run('sysctl', ['-n', key]);
      if (r.ok && r.stdout.trim() === '1') features.add(key.split('.').pop()!.toLowerCase());
    }
  } else {
    // Intel Macs: AVX2 lives in leaf7, AVX/SSE in the base feature word.
    for (const key of ['machdep.cpu.features', 'machdep.cpu.leaf7_features']) {
      const r = await run('sysctl', ['-n', key]);
      if (r.ok) normaliseFeatures(r.stdout.trim().split(/\s+/)).forEach((f) => features.add(f));
    }
  }

  return { brand: brandOut, physicalCores, logicalCores, features: [...features].sort() };
}

/**
 * ⚠️ **We do not detect CPU instruction-set flags on Windows at all.** `features` is
 * always `[]` here — and that empty array means **"not measured"**, never "absent".
 *
 * Why there is no query: Windows has no /proc/cpuinfo reachable from pure Node; `wmic`
 * is deprecated (gone from the Windows 11 24H2 image); and `Get-CimInstance
 * Win32_Processor` does not report ISA flags at all.
 *
 * ── What this comment used to say, and why that was worse than saying nothing ──
 *
 * It used to claim we "therefore infer the ISA from the CPU backend ggml actually
 * selected — see `inferIsaFromBackendPath`". **That function had zero callers in the
 * entire repo.** The comment described an intention as if it were code, so every reader
 * — including the audit that first looked here — came away believing Windows had a
 * mitigation it did not have. The function has been deleted; describing a plan in the
 * present tense is how a plan gets mistaken for a guarantee.
 *
 * ── What the empty set is allowed to cause, and what it is not ──
 *
 * Downstream MUST treat `features.length === 0` as *unknown*:
 *   · `packages/shared/src/fitness.ts` only concludes `missing_cpu_feature` when it has
 *     features to compare against, and otherwise reports `cpuFeaturesUnverified`;
 *   · the UI renders a third state ("could not determine"), not a red "unsupported".
 * Before that, every Windows machine was told 「CPU 不支持所需指令集（avx2）」 for the 5
 * models requiring avx2 — on hardware that supports it.
 *
 * ── If someone implements this later ──
 *
 * The documented, reliable source is `IsProcessorFeaturePresent` (kernel32), e.g.
 * `PF_AVX2_INSTRUCTIONS_AVAILABLE = 40`, reachable via PowerShell `Add-Type` P/Invoke.
 * **Do not ship it unverified on a real Windows machine**: a half-built detector just
 * produces a different false sentence, and this field's whole problem has been that it
 * spoke with more confidence than it had earned.
 */
/**
 * Windows 上的指令集探测。**唯一可靠的来源是 `IsProcessorFeaturePresent`（kernel32）。**
 *
 * 为什么不是别的：
 *   · `/proc/cpuinfo` —— Windows 没有；
 *   · `wmic` —— 已废弃（Windows 11 24H2 起不在默认镜像里），且它也不报 ISA；
 *   · `Get-CimInstance Win32_Processor` —— **完全不报指令集标志**（只有型号/核数）。
 *
 * 所以走 PowerShell 的 `Add-Type` P/Invoke 调 Win32 API。常量取自微软文档
 * （winnt.h 的 `PF_*`），一次进程里把要问的都问完，避免起 8 个 PowerShell。
 *
 * ⚠️ **拿不到就返回空集合＝"未知"，绝不退回猜测。** 三态结构不变
 * （`fitness.ts` 只有在有证据时才判 `missing_cpu_feature`，UI 有独立的"未知"档）。
 * 这一版要让"未知"这一档**变少**，不是把它消灭 —— 消灭它只能靠编。
 */
const PF_QUERIES: ReadonlyArray<readonly [number, string]> = [
  // [PF_* 常量, 我们内部用的特性名]
  [13, 'sse3'],
  [36, 'ssse3'],
  [37, 'sse4_1'],
  [38, 'sse4_2'],
  [39, 'avx'],
  [40, 'avx2'],
  [41, 'avx512f'],
];

async function detectCpuWin32(brand: string, logicalCores: number): Promise<CpuInfo> {
  let physicalCores = logicalCores;

  const r = await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum',
  ]);
  if (r.ok) {
    const n = Number(r.stdout.trim());
    if (Number.isFinite(n) && n > 0) physicalCores = n;
  }

  /*
   * 一条 PowerShell 里定义 P/Invoke 并把所有 PF_* 问一遍，输出 `名字=0/1` 逐行。
   * `Add-Type` 是在内存里编译，不受脚本执行策略限制；失败时下面按"未知"处理。
   */
  /*
   * ⚠️ `Add-Type` 那一句**必须是数组里的一个元素**。
   *   第一版把 `-MemberDefinition '`、C# 正文、`'` 拆成三个元素再 `join('; ')`，
   *   于是分隔符被塞进了 C# 字符串里：`-MemberDefinition '; [DllImport…];; '`
   *   —— 编译当场失败、探测永远返回空、界面永远显示"无法确认"。
   *   **一个建到一半的探测器只会产出另一句假话**，这就是它的样子；
   *   本机把拼出来的脚本打出来看了一眼才发现。
   */
  const memberDef =
    '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);';
  const script = [
    '$ErrorActionPreference="Stop"',
    `Add-Type -Namespace OM -Name Cpu -MemberDefinition '${memberDef}'`,
    ...PF_QUERIES.map(
      ([pf, name]) => `Write-Output ("${name}=" + [int][OM.Cpu]::IsProcessorFeaturePresent(${pf}))`,
    ),
  ].join('; ');

  const q = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const features: string[] = [];
  if (q.ok) {
    for (const line of q.stdout.split(/\r?\n/)) {
      const m = /^([a-z0-9_]+)=([01])$/.exec(line.trim());
      if (m && m[2] === '1' && m[1] !== undefined) features.push(m[1]);
    }
  }

  /*
   * ⚠️ 查询整体失败（Add-Type 被策略挡、powershell 不在、超时）→ `features` 保持空。
   *   空集合在下游的含义是**"没测到"**，不是"没有"（`fitness.ts` / HardwareCard 都按三态处理）。
   *   ★ 一条也没解析出来时也保持空 —— **不许因为"命令跑通了"就把空当成结论**：
   *     跑通但输出对不上，说明我们读错了它，那同样是"未知"。
   */
  return { brand, physicalCores, logicalCores, features: normaliseFeatures(features) };
}

/** Lowercase, keep only flags anyone downstream cares about, de-duplicate. */
function normaliseFeatures(raw: string[]): string[] {
  const KEEP = new Set([
    'sse4_2',
    'sse4.2',
    'avx',
    'avx2',
    'avx512f',
    'avx512bw',
    'avx512vl',
    'avx512dq',
    'avx512vnni',
    'avx512_vnni',
    'avx512bf16',
    'avx512_bf16',
    'avx512vbmi',
    'avx512_vbmi',
    'avx_vnni',
    'avxvnni',
    'f16c',
    'fma',
    'bmi2',
    'amx_tile',
    'amx_int8',
    'neon',
    'asimd',
    'fp16',
    'dotprod',
    'i8mm',
    'sve',
    'sme',
  ]);
  const out = new Set<string>();
  for (const f of raw) {
    const k = f.toLowerCase().trim();
    if (k.length === 0) continue;
    if (KEEP.has(k)) out.add(k === 'sse4.2' ? 'sse4_2' : k);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------

/** MB throughout this package is decimal (bytes / 1e6), matching R-04 §7.2. */
const toMB = (bytes: number): number => Math.round(bytes / 1e6);

export function detectMemory(): MemoryInfo {
  return { totalMB: toMB(os.totalmem()), availableMB: toMB(os.freemem()) };
}

/**
 * True on Apple silicon (and other unified-memory systems).
 *
 * The shared contract calls this out explicitly: when true, `gpus[].vramTotalMB` is
 * meaningless and the VRAM budget derives from system RAM instead. Getting this wrong
 * breaks every fit calculation on Macs.
 */
export function detectUnifiedMemory(): boolean {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
}

// ---------------------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------------------

/**
 * Free space on the volumes that matter.
 *
 * The downloader needs the volume holding the MODEL directory, not the system drive —
 * a 3 GB model landing on a full data disk is a real failure mode even when C: is empty.
 * Uses fs.statfs (Node 18.15+/20+), which is cross-platform and needs no shell-out.
 */
export async function detectDisks(paths: {
  modelsRoot: string;
  runtimesRoot: string;
}): Promise<DiskInfo[]> {
  const targets: { path: string; pathFor: DiskInfo['pathFor'] }[] = [
    { path: paths.modelsRoot, pathFor: 'models_root' },
    { path: paths.runtimesRoot, pathFor: 'runtimes_root' },
  ];

  const out: DiskInfo[] = [];
  for (const t of targets) {
    try {
      const s = await statfs(t.path);
      // bavail = blocks available to an unprivileged process, which is the honest number.
      out.push({
        mount: t.path,
        path: t.path,
        pathFor: t.pathFor,
        freeMB: toMB(Number(s.bavail) * Number(s.bsize)),
        totalMB: toMB(Number(s.blocks) * Number(s.bsize)),
      });
    } catch {
      // Directory may not exist yet on first run; the caller creates it and re-detects.
    }
  }
  return out;
}
