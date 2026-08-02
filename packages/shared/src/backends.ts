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

  /** Install target, relative to the engine's runtime directory. */
  installPath: string;

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
  engineVersion: string;
  backend: Backend;
  installedAt: string;
  verifiedAt: string | null;
  integrity: 'ok' | 'unverified' | 'corrupt' | 'missing_files';
  installPath: string;
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
}
