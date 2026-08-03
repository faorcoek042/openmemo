/**
 * Model registry schema.
 *
 * Baseline: memo.ac's shipped registries (ADR-004 decision 4), plus our three additions
 * and one removal. See artifacts.ts for the full provenance note.
 */

import type { Engine } from './backends.js';
import type {
  ArtifactFile,
  BenchmarkResult,
  GgufMetadata,
  LicenseInfo,
  ProviderId,
  ReferenceBenchmark,
  ResourceRequirements,
} from './artifacts.js';

/**
 * What the model is for. Drives which "active model" slot it can occupy.
 *
 * Matches D-02 `model_installs.role` CHECK exactly — VAD and punctuation models are NOT
 * ASR models, and filing them under 'asr' would put a VAD net in the transcription slot.
 */
export const MODEL_ROLES = [
  'asr',
  'llm',
  'vad',
  'punctuation',
  'diarization',
  'embedding',
  'tts',
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const MODEL_FORMATS = ['ggml', 'gguf', 'onnx', 'nemo', 'coreml'] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

/**
 * Quantization level. ADR-004 gap ① — memo.ac has no quantization concept at all
 * (every Whisper model it ships is f16), which is why its Whisper large-v3 is a
 * 3.09 GB download where ours is 1.08 GB at q5_0.
 *
 * `f16`/`f32` are "no quantization" sentinels rather than a null, so the UI always
 * has something concrete to show in the quantization selector.
 */
export const QUANTIZATIONS = [
  'f32', 'f16', 'bf16',
  'q8_0', 'q6_k', 'q5_k_m', 'q5_1', 'q5_0', 'q4_k_m', 'q4_k_s', 'q4_0',
  'q3_k_m', 'q2_k', 'iq4_xs', 'iq3_m', 'iq2_m',
] as const;
export type Quantization = (typeof QUANTIZATIONS)[number];

/** Human-facing grouping for the quantization selector (borrowed from Jan's Small/Balanced/Large). */
export const QUANT_TIERS = ['small', 'balanced', 'large', 'full'] as const;
export type QuantTier = (typeof QUANT_TIERS)[number];

/**
 * Trade-off bucket: the axis a user actually picks along ("I want it fast" /
 * "I want it accurate"). Orthogonal to {@link QuantTier}, which is about file size.
 * See `ModelEntry.speedClass` for why this is not named `speedTier`.
 */
export const SPEED_CLASSES = ['fast', 'balance', 'quality'] as const;
export type SpeedClass = (typeof SPEED_CLASSES)[number];

/**
 * Bucket a Whisper-family model by size alone.
 *
 * Size is the only input on purpose: it is the one property we know without measuring
 * anything. Everything speed-related we could compute instead (RTF x model size) rests on
 * coefficients we have never calibrated, and dressing a guess up as arithmetic makes it
 * harder to challenge, not easier.
 */
export function speedClassForSize(idOrFamily: string): SpeedClass {
  const s = idOrFamily.toLowerCase();
  if (s.includes('large') || s.includes('turbo')) return 'quality';
  if (s.includes('medium') || s.includes('small')) return 'balance';
  if (s.includes('base') || s.includes('tiny')) return 'fast';
  return 'balance';
}

export interface ModelSource {
  provider: ProviderId;
  /** e.g. "ggerganov/whisper.cpp" or "Qwen/Qwen3-4B-GGUF". */
  repo: string;
  /** Pinned upstream revision. Pinning is what makes sha256 stable over time. */
  revision: string;
}

/**
 * One installable model variant. "Model" and "quantization" are two UI levels but one
 * registry entity: `whisper-large-v3-turbo` at `q5_0` is a distinct entry from the same
 * model at `q8_0`, because they have different digests, sizes and requirements.
 * The catalog groups them by `groupId` for display.
 */
export interface ModelEntry {
  schemaVersion: 1;
  /** Stable unique id, e.g. "asr/whisper-large-v3-turbo-q5_0". */
  id: string;
  /** Groups quantization variants of the same logical model, e.g. "asr/whisper-large-v3-turbo". */
  groupId: string;
  role: ModelRole;
  /** e.g. "whisper", "qwen3", "gemma3". */
  family: string;
  /** Model architecture as reported by the file format, e.g. "whisper", "qwen3". */
  arch: string;
  format: ModelFormat;
  /** ADR-004 gap ①. */
  quantization: Quantization;
  quantTier: QuantTier;

  /**
   * Which trade-off bucket this model sits in — the SECOND filter axis.
   *
   * ## Why `quantTier` could not be reused
   *
   * `quantTier` is a SIZE axis: it says how heavily the weights were quantised. It says
   * nothing about how long a transcription takes, because `tiny-f16` and `large-v3-f16`
   * both land in `full` while differing by more than an order of magnitude in speed.
   * Filtering a 25-entry catalog by size alone still leaves the user staring at a wall of
   * cards where the fast and the slow ones look interchangeable.
   *
   * ## Why this is NOT called `speedTier`
   *
   * `FitResult.speedTier` already exists and means something different: it is COMPUTED
   * per machine (`fast|moderate|slow|very_slow|unknown`) and carries a `speedSource`
   * saying whether it was measured here, taken from a reference machine, or unknown. A
   * `CatalogVariant` carries both objects, so `v.speedClass` and `v.fitness.speedTier`
   * would have been the same word for a catalog constant and a per-machine measurement —
   * the exact "one name, two concepts" failure that `installPath` just cost us a task to
   * unwind. Different concept, different name.
   *
   * ## What it is and is not
   *
   * A hand-assigned BUCKET, one per model group, derived from model size only
   * (tiny/base -> fast, small/medium -> balance, large* -> quality). It is deliberately
   * NOT extrapolated from RTF: our RTF coefficients are uncalibrated, and a number
   * derived from an uncalibrated coefficient would read as a measurement while being a
   * guess. Anything claiming to be a measurement belongs in `FitResult`, with its
   * `speedSource` attached.
   */
  speedClass: SpeedClass;

  displayName: string;
  displayNameZh: string;
  descriptionZh: string;
  descriptionEn: string;

  /** BCP-47-ish codes, or "multi" for multilingual. */
  languages: string[];
  /** Free-form catalog tags, e.g. ["recommended-default", "multilingual"]. */
  tags: string[];

  /**
   * Which inference engines can actually LOAD this file.
   *
   * Added after a cross-module bug: the VAD entry shipped `silero_vad.onnx` (sherpa-onnx
   * format) while whisper.cpp requires a ggml `ggml-silero-*.bin`. The manifest validated,
   * the SHA-256 matched, the download succeeded — and the engine still could not load it.
   * "Installs fine" is not "works", and nothing in the schema could express the difference.
   *
   * Same weights in a different container are DIFFERENT entries, because the consumer
   * differs. The pipeline must filter by engine before offering a model for a given role.
   */
  engines: Engine[];

  /**
   * Languages for which this model is NOT recommended (ADR-011 decision 1).
   *
   * Not a capability flag — the model still runs. It records that we have MEASURED the
   * output to be unacceptable for that language. For Whisper `base` on Chinese, the
   * errors are not "slightly worse", they are wrong words:
   *   维基百科 → 危机摆科, 华尔街日报 → 花耳街日报, 谷歌 → 古歌,
   *   迈克尔杰克逊逝世 → 麦克尔结克训试事
   * (`Zh-Twitter.ogg`, 337 s; `large-v3-turbo-q5_0` gets all of these right.)
   *
   * The UI filters these out BY DEFAULT when the audio/UI language matches, and says why.
   * It must remain possible to unhide them: `base` is still a sensible choice for English
   * on a weak machine, so removing the model outright would be an over-correction.
   * The problem is the default, not the capability.
   */
  notRecommendedFor?: string[];

  files: ArtifactFile[];
  /** Sum of non-optional file sizes, in bytes. */
  totalSizeBytes: number;

  /** ADR-004 gap ②. Generated by scripts/gen-manifest.mjs, never hand-typed. */
  requirements: ResourceRequirements;
  /** Present for GGUF models; the source of the KV-cache term in `requirements`. */
  gguf?: GgufMetadata;

  /**
   * Known capability trade-offs, shown verbatim in the UI (ADR-013 decision 1).
   *
   * Exists because "faster" is never free and the costs are invisible until they bite:
   * Paraformer has no word-level timestamps, writes numbers as Chinese characters, and
   * lower-cases English. A user who picks it for speed and later needs word-level
   * alignment must be able to learn that BEFORE downloading, not after.
   */
  capabilityCaveats?: string[];

  license: LicenseInfo;
  source: ModelSource;

  /**
   * DELIBERATELY ABSENT: `speed` and `quality` integers.
   * memo.ac hardcodes `speed: 6, quality: 2` etc. with no provenance. ADR-004 decision 3
   * bans fabricated numbers project-wide. Accuracy/speed start as null and are filled in
   * only by a real measurement on this machine.
   */
  benchmark: BenchmarkResult | null;

  /**
   * Speed measured by us on a reference machine. Distinct from `benchmark`
   * (= measured on the user's machine). Always labelled as a reference figure in the UI.
   */
  referenceBenchmark?: ReferenceBenchmark | null;

  /** Set by the catalog build, used for staleness display. */
  catalogVersion: string;
}

/** Installed-model record, persisted as `manifests/<role>/<id>.json`. */
export interface InstalledModel {
  schemaVersion: 1;
  id: string;
  groupId: string;
  role: ModelRole;

  /**
   * Which engines can load this model, and which family it belongs to.
   *
   * Carried on the INSTALL RECORD, not just the catalog entry, for the same reason
   * `role` is: the record must stay self-describing after the catalog moves on. A user
   * who installed a model six months ago still has the files; if the catalog entry was
   * renamed or dropped, re-deriving `engines` by id lookup silently yields nothing, and
   * "no engine can load this" is indistinguishable from "we forgot to write it down".
   *
   * `family` is what the engine dispatches on to build `modelConfig` — a sherpa-onnx
   * transducer, a SenseVoice CTC model and a Moonshine model need three different
   * config shapes from three different sets of files.
   *
   * Records written before this field existed have it `undefined`. Readers MUST treat
   * `undefined` as "unknown, do not filter out" and NOT as the empty set — an empty
   * `engines` array means "nothing can load this", which would hide the model instead
   * of showing it. Same failure mode as the VAD/ASR mix-up: a wrong default that reads
   * as a confident answer.
   */
  engines?: Engine[];
  family?: string;

  displayName: string;
  quantization: Quantization;
  totalSizeBytes: number;
  installedAt: string;
  /** Last time full content hashing succeeded. */
  verifiedAt: string | null;
  integrity: 'ok' | 'unverified' | 'corrupt' | 'missing_files';
  files: InstalledFile[];
  requirements: ResourceRequirements;
  gguf?: GgufMetadata;
  license: LicenseInfo;
  source: ModelSource;
  benchmark: BenchmarkResult | null;
  catalogVersion: string;
}

/** Root a stored path is relative to. Keeps records portable across machines. */
export const PATH_ROOTS = ['models', 'runtimes', 'data'] as const;
export type PathRoot = (typeof PATH_ROOTS)[number];

export interface InstalledFile {
  role: string;
  name: string;
  sha256: string;
  sizeBytes: number;

  /**
   * Which configured root `relPath` hangs off.
   *
   * D-02 §1.1 already requires relative paths for media assets, for exactly the reason
   * that applies here: an absolute path bakes in the current data directory, so moving
   * the data dir, changing a Windows drive letter, or copying a profile to another
   * machine silently invalidates every installed-model record. The blobs are still on
   * disk and still verified — the records just stop pointing at them.
   */
  root: PathRoot;

  /** Path relative to `root`, e.g. "by-name/asr/ggml-large-v3-turbo-q5_0.bin". */
  relPath: string;

  /**
   * @deprecated Absolute path — write-only for backward compatibility.
   *
   * Kept so records written before the relative-path change keep resolving for users who
   * already installed models: readers prefer `root`+`relPath` and fall back to this.
   * Do not read it in new code; it will be dropped once no installs predate the change.
   */
  path?: string;
}

export const CATALOG_SOURCES = ['remote', 'cache', 'bundled'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

/** A model plus its quantization variants, as served to the UI. */
export interface CatalogGroup {
  groupId: string;
  role: ModelRole;
  family: string;
  displayName: string;
  displayNameZh: string;
  descriptionZh: string;
  descriptionEn: string;
  languages: string[];
  tags: string[];
  license: LicenseInfo;
  variants: ModelEntry[];
}
