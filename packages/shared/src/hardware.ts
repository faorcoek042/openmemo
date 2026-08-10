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

/**
 * `available: false` 的**成因**，机器可判。
 *
 * ## 为什么必须是字段，不是把 `unavailableReason` 拿去做正则
 *
 * `unavailableReason` 是一句**英文自由文本**，给排障的人看的。界面要按成因分档
 * （「本平台不适用」vs「未安装」是两句永远不许合并的话），如果靠匹配那句英文，
 * 那么改一个标点、加一个括号、翻译一次，界面就静默地退回"全都一样"——
 * **本仓在正则匹配这类字符串上已经栽过两次。**
 *
 * 所以成因单列一格：`manager.ts` 的理由链每一条分支各对应一个值，
 * 前端 `switch` 这个字段，永远不读那句话。
 *
 * ⚠️ 它**只出现在 `available: false` 那条分支上** —— 一个"可用"的后端带着一个
 * "为什么不可用"的成因，和带着一句不可用理由一样，是自相矛盾的对象。
 */
export const BACKEND_UNAVAILABLE_KINDS = [
  /**
   * 这个后端在这个操作系统上**根本不可能存在**（Metal / Core ML 之于非 Apple 平台）。
   *
   * ★ 与其余各项的区别是**它不依赖任何测量**：探针跑没跑成、包装没装，都不改变结论。
   * 所以 `manager.ts` 把它排在理由链的最前面。
   */
  'platform_unsupported',
  /** 探针这一轮没跑成（超时/崩溃/找不到）—— 对这个后端什么都没测出来。 */
  'probe_failed',
  /** 断路器把它停用了（连续失败），不是它本身的结论。 */
  'disabled_after_failures',
  /** 平台上装得了，只是还没装。**这一档才该引导用户去装。** */
  'not_installed',
  /** 装了，但这一轮探测没有加载它（`backendDir` 单值，见 `probed`）—— 零信息，不是故障。 */
  'not_probed_this_run',
  /** 加载了、枚举到了设备，但没有一个能用（含只有软件渲染器那种）。 */
  'no_usable_devices',
  /** 加载了、一个设备都没枚举到（驱动缺失或过旧）。 */
  'enumerated_none',
] as const;
export type BackendUnavailableKind = (typeof BACKEND_UNAVAILABLE_KINDS)[number];

/**
 * `BackendStatus` 里**与"可用不可用"这条轴无关**的那几格。
 *
 * 拆出来只是为了让下面那个判别联合两条分支不必各写一遍；
 * **没有任何一格在这里改变含义**。
 */
interface BackendStatusCommon {
  id: Backend;
  /**
   * The backend pack is recorded as installed. **Set membership only.**
   *
   * ⚠️ This used to read "present on disk and loadable". That was a bigger claim than the
   * producer makes: `manager.ts` computes it as `installedBackends.has(id)` — nothing
   * anywhere checks that the library actually loads. A pack whose `.so` is corrupt, or
   * whose CUDA runtime deps are missing, still reports `installed: true`.
   *
   * Loadability is a genuinely separate axis and it is NOT this field, and NOT `probed`
   * either (see `probe/probedBackends.ts`: a library that is present but fails to dlopen
   * still counts as probed — the directory listing cannot tell the difference). The only
   * real load evidence in the system today is `BackendSelfTest`, and that hangs off
   * `InstalledBackendPack`, not off this type.
   *
   * Fixed per §13: the comment was corrected to match the code, the semantics were left
   * alone — changing what `installed` means would move a load-bearing wall.
   */
  installed: boolean;
  /**
   * 这条算路**不需要任何包就能用** —— 随产品出厂的那份二进制（包内 `runtime/probe/`）。
   *
   * ## 为什么它必须和 `installed` 分开两个名字（T-197）
   *
   * 「cpu 后端装了没有」此前被**三处各答一次，其中两处无条件写死 `true`**
   * （`models.ts` 的 `b.id === 'cpu' ? true : …`、`setup.ts` 的
   * `new Set(['cpu', ...])`），而第三处（`/api/backends/catalog` 的 `pack.installed`）
   * 是纯粹的清单存在性。干净机器上于是同一屏自相矛盾：
   * 顶部芯片「CPU ⚡使用中」，往下滚两百像素「CPU ⬇可安装 · 42 MB」。
   *
   * 两边**各有一半道理**，而且统一到任何一边都会造出一句假话：
   *   · 写死 `true` 想说的是「CPU 这条算路永远兜得住」（内置那份 whisper-cli 确实在）；
   *   · 清单侧想说的是「这个包的记录在不在」。
   *
   * **它们是两个问题共用了一个字段名。** 所以拆名字，不是统一取值：
   * `installed` 只回答「包装了没有」（cpu **不特殊**，没装包就是 false），
   * 这一格回答「不装包能不能用」。
   *
   * ⚠️ 它**不是**「能不能用」的结论，别拿它去合并 `available` / `probed`：
   * 包内那份只有 CPU 后端模块，`bundled: true` 只说明"有一份出厂二进制在"，
   * 设备枚举得到与否仍然由探测回答。
   *
   * ⚠️ 也**不是**常量：`bundledRuntimeDir()` 是真的去文件系统找那个目录，
   * **开发树上它恒为 `null`**（仓库根下没有 `runtime/`，那边本来就该装后端包）。
   * 写死成 `cpu → true` 会在开发树上继续说谎 —— 那正是本次要拆掉的东西。
   */
  bundled: boolean;
  version: string | null;
  /** Index into HardwareInfo.gpus, when this backend is bound to a specific device. */
  deviceIndex: number | null;
  /** For the CPU backend: which ISA build is active, e.g. "avx2". */
  isa?: string | null;
}

/**
 * 一个后端在本机的状态。
 *
 * ## ★★ T-194：为什么是判别联合，而不是四个并排的布尔
 *
 * 不变量 **`available: true` 蕴含 `probed: true`** 此前只写在两处**散文**里
 * （上面那段注释 + `openapi.yaml` 的 description），唯一在守它的是一条**运行时断言**
 * （`notProbedVsUnavailable.test.ts` 里的 `if (b.available) assert.equal(b.probed, true)`）。
 *
 * 也就是说：`{ available: true, probed: false }` **可以被构造出来**，
 * 编译器一个字都不会说，要等那一条测试跑到才会红 ——
 * 而它只覆盖生产者产出的那些对象，**任何一处 mock / 手写夹具都绕得过去**。
 * 这正是本仓在清的「用断言代替不可表达」那个形状。
 *
 * 现在它由类型保证：`available: true` 那条分支里 `probed` 的类型就是 `true`，
 * **写 `false` 通不过编译**。
 *
 * ## 顺带钉住的第二条：`available: false` 必须说明为什么
 *
 * `unavailableReason` 从「可选」变成**在 `available: false` 分支里必填**。
 * 生产者七条分支本来就每条都赋了值（`manager.ts`），所以这不是新要求，
 * 只是把一条已经成立的性质写进类型 —— 而它挡住的是
 * 「界面显示『不可用』却一个字的原因都没有」，那是本仓反复清过的一族。
 * 反过来在 `available: true` 分支里它只能是 `null`/缺省：
 * 一个"可用"的后端带着一句不可用理由，同样是非法状态。
 *
 * ## ⚠️ 刻意**没有**做的两件事
 *
 * 1. **没有新造一个 `state` 判别字段。** 那会把四条独立的轴
 *    （可用 / 已安装 / 本次探测有没有加载 / 为什么不可用）压进一个槽位 ——
 *    与 `BACKEND_IS_COMPUTE_AXIS` 拒绝和 `SELF_TEST_APPLIES` 合表是同一条克制。
 *    `installed` 与 `probed` 在这里仍然是各自独立的轴。
 * 2. **没有加"可加载性"这第四条轴。** `probe/probedBackends.ts` 已经读实：
 *    一个存在但 `dlopen` 失败的库**仍然算 probed**，目录列表分辨不了。
 *    今天系统里唯一真实的加载证据是 `BackendSelfTest`，而它挂在
 *    `InstalledBackendPack` 上、不在这个类型上。那是另一件事，不在本轮。
 */
export type BackendStatus =
  | (BackendStatusCommon & {
      /** Device enumeration succeeded and returned >= 1 device. NOT a file-existence check. */
      available: true;
      /**
       * 枚举到设备本身就是"这个后端加载过"的证据，所以这里**只能是 `true`**。
       * 类型上写死，而不是靠注释 + 一条运行时断言。
       */
      probed: true;
      /** 可用的后端不许带不可用理由 —— 那是个自相矛盾的对象。 */
      unavailableReason?: null;
      /** 同理：可用的后端没有"不可用成因"。 */
      unavailableKind?: null;
    })
  | (BackendStatusCommon & {
      available: false;
      /**
       * Did this detection run actually LOAD this backend's library?
       *
       * ── Why this is a separate field, and not prose in `unavailableReason` ──────────
       *
       * `available: false` has two causes that were indistinguishable before T-168,
       * because they shared one boolean and one free-text slot:
       *
       *   1. The probe loaded this backend's ggml library and enumerated no usable
       *      device. That is a REAL verdict about the driver/hardware. (`probed: true`)
       *   2. The probe never loaded it at all. `backendDir` is single-valued — one probe
       *      run scans exactly one pack directory (`ggml_backend_load_all_from_path`) —
       *      so every OTHER installed pack is simply absent from the result. That is ZERO
       *      information about the driver, and any sentence blaming the driver is
       *      invented. (`probed: false`)
       *
       * MEASURED (T-168, this box, real install of both Linux packs, probe stderr):
       *   backendDir = <cpu pack>     -> "loaded CPU backend from libggml-cpu-zen4.so"  (Vulkan never loaded)
       *   backendDir = <vulkan pack>  -> "ggml_vulkan: No devices found." + loaded Vulkan
       * Both produced the identical string "installed but enumerated no devices (driver
       * missing or too old)". In the first case it is FALSE — and it sends the user off
       * to reinstall a driver that was never the problem.
       *
       * The test is structural and cheap: is this backend's ggml library present in the
       * directory the probe scanned? Present + no devices = a real verdict.
       * Absent = it never had a chance.
       *
       * ⚠️ 它**只出现在这条分支上**：`available: true` 那条里 `probed` 的类型就是
       * `true`（T-194），所以「可用但没探测过」在类型层就写不出来了。
       */
      probed: boolean;
      /** **必填**：说了"不可用"就必须说得出为什么。 */
      unavailableReason: string;
      /**
       * **必填**：那句为什么的**机器可判版本**（T-196）。
       *
       * 界面按它分档，绝不去匹配 `unavailableReason` 那句英文自由文本。
       * 两格必须说同一件事：`manager.ts` 的理由链一条分支同时产出这两格。
       */
      unavailableKind: BackendUnavailableKind;
    });

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
