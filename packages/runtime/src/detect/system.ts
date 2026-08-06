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

    const flagLine = text.split('\n').find((l) => l.startsWith('flags') || l.startsWith('Features'));
    if (flagLine) {
      const raw = flagLine.split(':')[1] ?? '';
      features = normaliseFeatures(raw.trim().split(/\s+/));
    }

    const modelLine = text.split('\n').find((l) => l.startsWith('model name'));
    if (modelLine) brandOut = (modelLine.split(':')[1] ?? brand).trim();

    // "cpu cores" is per-socket; multiply by the number of distinct physical ids.
    const coresPerSocket = Number(
      text.split('\n').find((l) => l.startsWith('cpu cores'))?.split(':')[1]?.trim() ?? '0',
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
 * UNVERIFIED — no Windows machine available.
 *
 * Windows has no /proc/cpuinfo equivalent reachable from pure Node, and `wmic` is
 * deprecated (removed from the Windows 11 24H2 default image), so we do not use it.
 * `Get-CimInstance Win32_Processor` does not report ISA flags at all.
 *
 * We therefore infer the ISA from the CPU backend ggml ACTUALLY selected — see
 * `inferIsaFromBackendPath` — which is better evidence than any flag query, because it
 * is the same decision the inference engine made. Until the probe has run, we report a
 * conservative empty set rather than guessing.
 */
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

  return { brand, physicalCores, logicalCores, features: [] };
}

/**
 * Map a ggml CPU backend filename to the ISA level it implies.
 *
 * The probe's stderr contains a line like:
 *   load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
 * That is ground truth about which instruction sets are usable, so on platforms where
 * flag enumeration is awkward (Windows) we prefer it over any API.
 *
 * Variant names come from ggml/src/ggml-cpu/CMakeLists.txt and were confirmed against a
 * real build on the T-012 box.
 */
const ISA_BY_VARIANT: Record<string, string[]> = {
  sse42: ['sse4_2'],
  x64: ['sse4_2'],
  sandybridge: ['sse4_2', 'avx'],
  ivybridge: ['sse4_2', 'avx', 'f16c'],
  piledriver: ['sse4_2', 'avx', 'f16c', 'fma'],
  haswell: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2'],
  alderlake: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2', 'avx_vnni'],
  skylakex: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2', 'avx512f'],
  cannonlake: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2', 'avx512f', 'avx512_vbmi'],
  cascadelake: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2', 'avx512f', 'avx512_vnni'],
  icelake: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2', 'avx512f', 'avx512_vbmi', 'avx512_vnni'],
  cooperlake: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2', 'avx512f', 'avx512_vnni', 'avx512_bf16'],
  zen4: [
    'sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2',
    'avx512f', 'avx512_vbmi', 'avx512_vnni', 'avx512_bf16',
  ],
  sapphirerapids: [
    'sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'bmi2',
    'avx512f', 'avx512_vbmi', 'avx512_vnni', 'avx512_bf16', 'amx_tile', 'amx_int8',
  ],
};

export function inferIsaFromBackendPath(probeStderr: string): { variant: string | null; features: string[] } {
  const m = /ggml-cpu-([a-z0-9]+)\.(?:so|dll|dylib)/i.exec(probeStderr);
  const variant = m?.[1]?.toLowerCase() ?? null;
  if (variant === null) return { variant: null, features: [] };
  return { variant, features: ISA_BY_VARIANT[variant] ?? [] };
}

/** Lowercase, keep only flags anyone downstream cares about, de-duplicate. */
function normaliseFeatures(raw: string[]): string[] {
  const KEEP = new Set([
    'sse4_2', 'sse4.2', 'avx', 'avx2', 'avx512f', 'avx512bw', 'avx512vl', 'avx512dq',
    'avx512vnni', 'avx512_vnni', 'avx512bf16', 'avx512_bf16', 'avx512vbmi', 'avx512_vbmi',
    'avx_vnni', 'avxvnni', 'f16c', 'fma', 'bmi2', 'amx_tile', 'amx_int8',
    'neon', 'asimd', 'fp16', 'dotprod', 'i8mm', 'sve', 'sme',
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
