/**
 * GPU backend / engine package registry.
 *
 * ADR-003 decision 6: the backend-pack downloader and the model downloader are ONE
 * component. This file converges `gpu-runtime`'s R-02 §C.3 `backends.json` sketch with
 * R-04's model schema so both feed the same downloader.
 *
 * Convergence notes vs R-02 §C.3 (differences are intentional; `gpu-runtime` to review):
 *   - `sizeBytes`/`sha256` move onto `ArtifactFile` instead of living on the pack, so a
 *     pack can legitimately contain several files (CUDA packs ship cudart DLLs alongside
 *     `ggml-cuda.dll`) and so packs and models share one verify/resume code path.
 *   - `url` becomes `mirrors[]`, matching ADR-004 decision 1 (probe sources at runtime).
 *   - R-02's `{os, arch}` become the shared `PlatformSelector`.
 *   - Added `cudaArchitectures` to support R-02 §C.4's single-architecture CUDA slimming
 *     (the fat `ggml-cuda.dll` measured 564.59 MB unpacked).
 *   - Kept R-02's `ggmlAbi` — R-02 flagged cross-reuse of ggml backends between
 *     whisper.cpp and llama.cpp as ABI-risky and unverified, so the ABI must be explicit.
 */

import type { ArtifactFile, LicenseInfo } from './artifacts.js';
import type { Arch, Backend, OsPlatform } from './hardware.js';

/** Which native engine a pack belongs to. */
export const ENGINES = [
  'whisper.cpp',
  'llama.cpp',
  'sherpa-onnx',
  'ffmpeg',
  'yt-dlp',
  /**
   * Loadable SQLite extensions (libsimple FTS5 tokenizer, sqlite-vec).
   *
   * Structurally identical to a GPU backend pack — a native archive with a digest that
   * gets unpacked into a runtime directory — so it reuses the same downloader and the
   * same "install it from the web page" flow. Without libsimple, Chinese FTS falls back
   * to trigram and every query shorter than 3 characters returns zero hits, which makes
   * Chinese search not "worse" but broken.
   */
  'sqlite-ext',
] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * ASR 引擎标识符 —— **语音识别运行时**，与上面的 `ENGINES` 不是一回事。
 *
 * `ENGINES` 是"**组件包**"枚举（下载什么原生包，含 ffmpeg / yt-dlp / sqlite 扩展）；
 * 这里是"**哪个引擎在跑这段音频**"。两者恰好共享 `whisper.cpp` / `sherpa-onnx` 两个字面量，
 * 但 `paraformer` 只存在于这里（它跑在 sherpa-onnx 包里，却是独立的引擎选择），
 * 而 `ffmpeg` / `yt-dlp` 永远不会出现在这里。混用会让前端过滤出一堆不是引擎的东西。
 *
 * ## 为什么必须放在 shared
 *
 * 权威定义原本只在 `packages/pipeline/src/asr/selectEngine.ts` 的 `EngineId` 里，
 * 而 pipeline 是 Node 侧包，前端引不动。结果前端**自己编了字符串**：
 * `RecorderPage` 写死 `'paraformer' | 'turbo'` —— `'turbo'` 在后端全仓不存在
 * （它是模型名 `whisper-large-v3-turbo` 的片段，不是引擎），
 * 于是这个选择器既选不中真引擎，选中的值也从不发给后端。
 *
 * 类型层面消灭这类字面量的唯一办法，就是让**两端引用同一个联合**。
 *
 * ⚠️ 待办（`gpu-runtime` 域）：`selectEngine.ts:22` 的 `EngineId` 应改为
 * `import type { AsrEngineId } from '@openmemo/shared'`，否则仍是两份真相。
 * 在那之前，这里的取值必须与该文件逐字一致 —— 已核对（2026-08，三值相同）。
 */
export const ASR_ENGINE_IDS = ['whisper.cpp', 'paraformer', 'sherpa-onnx'] as const;
export type AsrEngineId = (typeof ASR_ENGINE_IDS)[number];

/** Package tier, per ADR-003 decision 3's L0/L1/L2 degradation chain. */
export const PACK_TIERS = ['builtin', 'downloadable'] as const;
export type PackTier = (typeof PACK_TIERS)[number];

export interface DriverRequirement {
  /** e.g. "550" for NVIDIA. Ollama documents 550+ for compute capability 5.0+. */
  nvidiaDriver?: string;
  /** e.g. "1.2". */
  vulkanApi?: string;
  /** e.g. "7.0". */
  rocmVersion?: string;
  /** Minimum macOS version, e.g. "13.0". */
  macosVersion?: string;
}

export interface BackendPack {
  schemaVersion: 1;
  /** e.g. "whispercpp-vulkan-win-x64". */
  id: string;
  engine: Engine;
  /**
   * The engine build's OWN self-reported version string — whatever identifier scheme
   * that upstream project uses, taken as-is (may be a semver tag, or for autobuild-style
   * artifacts like BtbN's FFmpeg-Builds, a git-describe string such as
   * `n8.1.2-34-g9b6c8969e0`).
   *
   * ⚠️ NOT guaranteed to equal `ComponentStatus.pinnedVersion` for the same logical
   * component, even though the two names sound like synonyms. Checked programmatically
   * across all 23 overlapping ids between backends.json/sqlite-ext.json and
   * components.json (2026-08-09): 3 differ, all `media-tools-*` — because
   * `pinnedVersion` there is sourced from the release/tag we actually pinned when
   * downloading (for BtbN autobuilds, a date-stamped tag like
   * `autobuild-2026-07-31-14-10`), which is a *different identifier scheme* than what
   * the binary reports about itself via `engineVersion`. There is no derivable rule
   * that converts one into the other for that case, so no consistency guard was built —
   * see `ffmpegStableOnly.test.ts` for the one case (`media-tools-macos-arm64`) where
   * they happen to carry the same underlying version and a guard was worth pinning.
   * Do not assume the two fields agree; they answer different questions ("what does the
   * engine call itself" vs "what did we pin when we fetched it").
   */
  engineVersion: string;
  /**
   * ggml ABI version this pack was built against. R-02 verified the soname as 0.15.1
   * but flagged cross-engine reuse as UNVERIFIED — so we gate on an explicit match
   * rather than assuming compatibility.
   */
  ggmlAbi: string | null;
  backend: Backend;
  tier: PackTier;
  os: OsPlatform;
  arch: Arch;

  displayName: string;
  displayNameZh: string;

  files: ArtifactFile[];
  totalSizeBytes: number;

  /**
   * CUDA compute capabilities this pack was compiled for, e.g. ["86"].
   * Empty/absent means a fat multi-architecture binary. Used to pick the smallest
   * pack matching the detected device (R-02 §C.4 slimming route).
   */
  cudaArchitectures?: string[];

  requiresDriver: DriverRequirement | null;
  license: LicenseInfo;

  /** Files that must exist after install for the pack to be considered functional. */
  providesFiles: string[];

  /**
   * Directory that this pack's loadable files must be LINKED INTO after unpacking,
   * relative to the data directory. Only SQLite-extension packs set it (`bin/ext`).
   *
   * ## Why this is `linkInto` and not `installPath`
   *
   * The old name described a place to *install to*, and the obvious reading of that is
   * "unpack the archive here". Acting on that reading is actively destructive: all
   * eleven sqlite-ext packs share the single directory `bin/ext`, and unpacking is
   * atomic-by-replacement (`rm -rf` the target, then rename into place). Installing
   * libsimple and then sqlite-vec would therefore delete the first one — silently, with
   * a successful job and a green checksum.
   *
   * `linkInto` names what actually has to happen: `materializeSqliteExtensions` ADDS
   * links into the directory and never replaces it, which is what lets several
   * extensions coexist there (verified on the demo: `libsimple.so` + `vec0.so` both
   * present, `tokenizer=simple`).
   *
   * ## Why backend packs no longer carry it
   *
   * They used to, with values like `llamacpp/b10223/vulkan` — an *engine runtime
   * layout*, a different concept wearing the same name, and one that nothing ever
   * executed. Renaming those to `linkInto` would have replaced one lie with another,
   * and honouring them would have moved binaries out of `by-name/` where
   * `findInBackendPacks` looks for them. So the field is simply absent there: backend
   * packs land in the content-addressed `by-name/` layout and are located by scanning.
   */
  linkInto?: string;

  /** Higher wins when several packs match the same hardware. */
  priority: number;

  /**
   * Whether this pack can actually be downloaded right now.
   *
   * `pending-ci` means the artifact has been built and its digests verified locally, but
   * it is NOT published anywhere yet (this repo has no git remote, so CI has never run).
   * Such entries carry real hashes for auditability — ADR-001 requires the manifest be in
   * git — but MUST NOT be offered as a download, and MUST NOT carry an invented URL.
   * Publishing a URL that 404s is worse than admitting the gap: the failure surfaces at
   * click time instead of at review time.
   */
  availability: 'published' | 'pending-ci';

  /**
   * DELIBERATELY ABSENT: any relative-performance number.
   * R-02: "CUDA relative to Vulkan on whisper inference — UNKNOWN. Do not fabricate."
   * ADR-003 decision 3 makes Vulkan the provisional NVIDIA default precisely because
   * the performance delta is unmeasured. A real spike may overturn that.
   */
  benchmark: null;

  catalogVersion: string;
}

export interface InstalledBackendPack {
  schemaVersion: 1;
  id: string;
  engine: Engine;
  /** See {@link BackendPack.engineVersion} — same field, same caveat about `pinnedVersion`. */
  engineVersion: string;
  backend: Backend;
  installedAt: string;
  verifiedAt: string | null;
  integrity: 'ok' | 'unverified' | 'corrupt' | 'missing_files';
  /**
   * Copy of {@link BackendPack.priority} taken at install time. OPTIONAL because records
   * written before T-162 do not have it.
   *
   * ── Why it has to be copied here (T-162) ────────────────────────────────────────────
   * `priority` documents itself as "higher wins when several packs match the same
   * hardware", and that decision is made by `findInBackendPacks()` in `@openmemo/pipeline`
   * — which only ever sees the STORE, not `vendor/manifests/backends.json`. Leaving the
   * number in the catalog meant it had eleven declarations and zero readers, while the
   * function that was supposed to obey it picked whatever `readdir` returned first.
   *
   * A record without it sorts as 0. That only matters when the user has never chosen a
   * backend (an explicit choice outranks priority), and reinstalling the pack fills it in.
   */
  priority?: number;
  /** Mirrors {@link BackendPack.linkInto}; absent for packs that are not linked anywhere. */
  linkInto?: string;
  files: { name: string; sha256: string; sizeBytes: number; path: string }[];
  /** Result of the post-install self-test (ADR-003 decision 3). */
  selfTest: BackendSelfTest | null;
}

/**
 * Post-install verification. ADR-003 decision 3 requires a REAL inference run on an
 * embedded audio sample, not a "files exist" check — copying memo.ac's good idea.
 */
export interface BackendSelfTest {
  passed: boolean;
  ranAt: string;
  /** Devices actually enumerated by the probe. R-02 §A.0: loaders lie, enumeration doesn't. */
  devicesFound: number;
  /** Measured real-time factor on the embedded sample; null if the run failed. */
  rtf: number | null;
  errorMessage: string | null;
  /**
   * 这次跑**实际用上的后端**，取自 whisper 自己的 `whisper_backend_init_gpu:` 日志
   * （`parseBackendUsed()`）。是**日志文字**，例如 `"CPU"`、`"CPU (ggml-cpu-zen4)"`、
   * 或 GPU 设备名 —— **不是** `Backend` 那个小写枚举，两者永不相等。
   *
   * OPTIONAL：T-166 之前写下的记录没有这个字段。
   *
   * ## 为什么必须记下来（T-166 ①）
   *
   * 自检现在可以**钉住某一个包**跑（用户在哪张卡片上点就测哪个包）。于是出现了一种
   * 以前不存在的状态：跑的**确实**是 Vulkan 包里的 whisper-cli，而 ggml 在这台机器上
   * 没枚举到设备、优雅退回 CPU 算完了 —— `passed` 为真，**但加速没有生效**。
   * 只记 `passed:true` 的话，卡片上那句"自检通过"就变成了一条不成立的证据；
   * 而这正是 D-05 与 ADR-004 决策 3 反复要求区分的两件事：
   * **「这个包能跑」≠「这个包的加速在你机器上真的用上了」。**
   *
   * `devicesFound: 0` 是同一件事的另一半证据（枚举不会撒谎），两个一起看才完整。
   */
  backendUsed?: string | null;
}
