/**
 * Unified downloadable-artifact contract.
 *
 * ADR-003 decision 6 merges the "backend pack downloader" and the "model downloader"
 * into one component. This file is the shared vocabulary that makes that merge real:
 * a Whisper `.bin`, a GGUF, and a `ggml-vulkan.dll` pack are all just `ArtifactFile`s
 * with a digest and a list of mirrors.
 *
 * SCHEMA BASELINE (ADR-004 decision 4): memo.ac's own registries, obtained by
 * unpacking the shipped app (see /root/memo-forensics). Two schemas were found there:
 *
 *   1. `presets/whisper-models.js`  — the OLD one. 15 entries. Flaws we deliberately do NOT copy:
 *        - `size: "77.7 MB"`         → a STRING. Unparseable, drifts from reality.
 *        - `sha: "bd577a11…"`        → 40-hex SHA-1, copied from whisper.cpp's README table.
 *        - `speed: 6, quality: 2`    → hardcoded 1-6 integers with no provenance.
 *        - no quantization field, no vram/ram field.
 *   2. `plugins/extra-transcription-plugins.json` — the NEWER one, and much better:
 *        `platforms: [{platform, arch, sourceUrl, sizeBytes, sha256}]`
 *        → integer bytes AND sha256. We baseline on THIS shape.
 *
 * Our three mandated additions over memo.ac (ADR-004 decision 4):
 *   ① `quantization`                      (memo.ac ships f16 only, no choice)
 *   ② `requirements.{vram,ram}RequiredMB` (memo.ac has no fit pre-check at all)
 *   ③ `Backend` enum widened to 6 values  (memo.ac had cuda/metal/coreml only)
 *
 * And one deliberate REMOVAL: no `speed`/`quality` integers. ADR-004 decision 3 makes
 * "never display a fabricated number" a project-wide standard. Those fields are replaced
 * by `benchmark`, which is null until measured on the user's own machine.
 */

import type { Arch, Backend, OsPlatform } from './hardware.js';

/** Download source identifiers. `custom` is a user-supplied base URL. */
export const PROVIDERS = ['hf', 'hf-mirror', 'modelscope', 'github', 'custom'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface Mirror {
  provider: ProviderId;
  url: string;
  /**
   * True when published by the upstream author (e.g. Qwen's own ModelScope repo,
   * verified byte-identical to HF). False for community re-uploads.
   * Non-official mirrors are still safe to use because `sha256` is enforced,
   * but they are ranked lower during source probing.
   */
  official: boolean;
}

/** Roles a file can play inside one logical artifact. */
export const FILE_ROLES = [
  'weights',
  'coreml-encoder',
  'mmproj',
  'library',
  'binary',
  'archive',
] as const;
export type FileRole = (typeof FILE_ROLES)[number];

/** Platform/arch/backend applicability filter for a file or pack. */
export interface PlatformSelector {
  os: OsPlatform;
  arch: Arch;
  backend?: Backend;
}

export interface ArtifactFile {
  role: FileRole;
  /** Filename as it should land on disk (basename only, no path separators). */
  name: string;
  /**
   * Integer bytes. NEVER a formatted string.
   * Display formatting happens in the UI; the wire format stays exact.
   */
  sizeBytes: number;
  /**
   * Lowercase 64-hex SHA-256 of the file content. REQUIRED — this is the trust anchor.
   *
   * It is also the ONLY dedup key. ADR-004 decision 4: do not dedup on size.
   * `ggml-tiny.bin` (77,691,713 B) and `ggml-tiny.en.bin` (77,704,715 B) differ by
   * 13,002 bytes — close enough that a size/name heuristic conflates them, which is
   * exactly what happened during R-04 research.
   */
  sha256: string;
  /**
   * Optional SHA-1, purely as a cross-check against upstream-published tables.
   * whisper.cpp's models/README.md publishes SHA-1; HF publishes SHA-256.
   * Never used for integrity gating — SHA-256 is.
   */
  sha1?: string;
  mirrors: Mirror[];
  /** If true, absence does not block install (e.g. the macOS CoreML encoder). */
  optional?: boolean;
  /** Restricts this file to matching platforms. Absent = applies everywhere. */
  platforms?: PlatformSelector[];
  /** Archive to expand after verification. */
  /**
   * Archive format. `tar.xz` is supported so manifests can point at upstream release
   * artifacts directly (several projects ship xz only) instead of us repackaging them.
   */
  unpack?: 'zip' | 'tar.gz' | 'tar.xz' | null;
}

export interface LicenseInfo {
  /** SPDX id where possible, else a short label. */
  id: string;
  /** Upstream requires login + license acceptance (HF "gated" repos). */
  gated: boolean;
  url: string;
  /**
   * When true the UI must send the user to `url` to accept upstream terms before
   * downloading. ADR-004 decision 2: we do NOT re-host restricted weights (e.g. Gemma);
   * the user accepts upstream terms and downloads from upstream.
   */
  requiresAcceptance?: boolean;
}

export interface ResourceRequirements {
  /** Peak system RAM needed to run. Computed, never hand-typed. See fitness.ts. */
  ramRequiredMB: number;
  /** Peak VRAM needed for full GPU offload, INCLUDING KV cache. */
  vramRequiredMB: number;
  /** Disk needed to install, including download headroom. */
  diskRequiredMB: number;
  /** Required CPU ISA features, e.g. ["avx2"]. */
  cpuFeatures: string[];
  /**
   * Context length these numbers were computed at. Displaying a VRAM figure without the
   * context length it assumes is meaningless — KV cache scales linearly with it.
   *
   * `null` when the requirement does not depend on context at all (Whisper: its compute
   * buffers are fixed by model dimensions). Deliberately null rather than 0, because 0
   * would read as "computed at zero context", which is false.
   */
  computedAtContext: number | null;
}

/** GGUF header metadata, extracted by an 8 MB Range request (no full download). */
export interface GgufMetadata {
  architecture: string;
  blockCount: number;
  embeddingLength: number;
  headCount: number;
  headCountKv: number;
  keyLength: number;
  valueLength: number;
  contextLength: number;
  /**
   * KV cache bytes per token at f16:
   *   blockCount * headCountKv * (keyLength + valueLength) * 2
   * Verified against real headers: Qwen3-4B/8B = 147456, Gemma-3-4B = 139264,
   * Llama-3.1-8B = 131072 bytes/token. At 8K context that is ~1.1 GB —
   * omitting it is why LM Studio's estimator mis-badges models.
   */
  kvBytesPerToken: number;
}

/** Locally measured benchmark. Null until the user runs it. ADR-004 decision 3. */
export interface BenchmarkResult {
  /** Real-time factor: wallSeconds / audioSeconds. Lower is faster. */
  rtf: number;
  measuredAt: string;
  backend: Backend;
  deviceName: string;
  sampleDurationSec: number;
}

/**
 * A benchmark WE measured on a known reference machine, shipped in the catalog.
 *
 * Deliberately a separate type from `BenchmarkResult` so the two can never be confused:
 * `benchmark` means "measured on the user's machine", this means "measured on ours".
 * ADR-004 decision 3 bans fabricated numbers — it does not ban real measurements with
 * honest provenance, and having *some* speed signal before the user downloads 2 GB is
 * genuinely useful. The UI must always label it as a reference figure.
 *
 * Every field here exists to make the provenance auditable: which machine, which backend,
 * which audio, how long. A number without those is exactly the kind of thing we refuse.
 */
export interface ReferenceBenchmark {
  rtf: number;
  backend: Backend;
  /** Reference machine description, e.g. "AMD RYZEN AI MAX+ 395, 32 threads, CPU only". */
  deviceName: string;
  measuredAt: string;
  /** Audio used, e.g. "Zh-Twitter.ogg (CC BY 3.0)". */
  sampleName: string;
  sampleDurationSec: number;
  /** Language of the sample — RTF and accuracy both vary by language. */
  sampleLanguage: string;
  /** Mean model confidence over the sample, when the engine reports it. */
  meanConfidence?: number;
}
