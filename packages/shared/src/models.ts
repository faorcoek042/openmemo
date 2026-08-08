/**
 * Model registry schema.
 *
 * Baseline: memo.ac's shipped registries (ADR-004 decision 4), plus our three additions
 * and one removal. See artifacts.ts for the full provenance note.
 */

import type { Engine } from './backends.js';
import type { Backend } from './hardware.js';
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
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q6_k',
  'q5_k_m',
  'q5_1',
  'q5_0',
  'q4_k_m',
  'q4_k_s',
  'q4_0',
  'q3_k_m',
  'q2_k',
  'iq4_xs',
  'iq3_m',
  'iq2_m',
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

/**
 * Display label and sort order per speed class.
 *
 * Typed as a total `Record`, not a lookup with a fallback, ON PURPOSE: adding a fourth
 * member to {@link SPEED_CLASSES} makes these object literals incomplete and the build
 * goes red. A `switch` with a `default`, or a `Partial` map with a `?? '未知'`, would
 * instead ship a new tier that silently renders as a fallback string. The same trick is
 * already load-bearing for `SPEED_NOTE_ZH` in fitness.ts.
 */
export const SPEED_CLASS_LABEL_ZH: Record<SpeedClass, string> = {
  fast: '快',
  balance: '均衡',
  quality: '高质量',
};

/** Ascending display order for the 档位 filter. Total map — see {@link SPEED_CLASS_LABEL_ZH}. */
export const SPEED_CLASS_ORDER: Record<SpeedClass, number> = {
  fast: 0,
  balance: 1,
  quality: 2,
};

/* ----------------------------- speed evidence ----------------------------- */

/**
 * How we know how fast a model is — **the provenance of the number, not the number**.
 *
 * ## Why this exists
 *
 * Before this field, a catalog entry could answer "how fast is it?" in exactly two ways:
 * carry a `referenceBenchmark`, or not carry one. "Not carrying one" is an ABSENCE, and an
 * absence cannot distinguish between:
 *   - we ran it and it is genuinely unmeasured,
 *   - we have a figure but the generator dropped it,
 *   - somebody has not gotten around to it.
 * Two of those three are bugs and one is a fact, and the reader could not tell which. That
 * is the same failure mode as `InstalledModel.engines` (an empty array reading as "nothing
 * can load this" instead of "we do not know"), which cost us a task to unwind.
 *
 * So the field is REQUIRED on every entry: a new model cannot enter the catalog without
 * someone answering the question, and "未测量" becomes a stated fact rather than a silence.
 *
 * ## The three states must never be conflated
 *
 * ADR-004 decision 3 bans fabricated numbers. The realistic way that ban gets violated is
 * not somebody inventing a figure out of nothing — it is an ESTIMATE getting rendered in
 * the same chip as a MEASUREMENT, at which point the user cannot tell that the "23 分钟"
 * on the card is a guess. The union below makes that structurally hard:
 *
 *   - {@link MeasuredSpeed}   carries an rtf AND mandatory full provenance.
 *   - {@link EstimatedSpeed}  carries an rtf, but ALSO the entry it was extrapolated from,
 *                             the method in words, and an uncertainty factor. You cannot
 *                             write an estimate without saying it is one.
 *   - {@link UnmeasuredSpeed} has **no rtf field at all**. It is not "rtf: null" — the
 *                             number is not expressible. There is no way to park a
 *                             plausible-looking figure on an unmeasured entry.
 *
 * As of this writing the catalog ships ZERO `estimated` entries. The variant exists so
 * that the first person who wants one is forced onto the honest path, not so that we can
 * fill the gaps cheaply. See D-03 §14 for the classification standard and its evidence.
 */
export const SPEED_EVIDENCE_KINDS = ['measured', 'estimated', 'unmeasured'] as const;
export type SpeedEvidenceKind = (typeof SPEED_EVIDENCE_KINDS)[number];

/** We put this exact file on a stopwatch. */
export interface MeasuredSpeed {
  kind: 'measured';
  /** Real-time factor: wallSeconds / audioSeconds. Lower is faster. */
  rtf: number;
  /**
   * Full provenance of the run: machine, backend, audio, duration, language.
   * Mandatory — a speed number without these is exactly what ADR-004 decision 3 bans.
   */
  benchmark: ReferenceBenchmark;
}

/**
 * We did NOT run this file; the number is extrapolated from one we did run.
 *
 * Every field is mandatory because each one is something a reviewer needs in order to
 * challenge the estimate. An estimate nobody can challenge is a fabricated number with
 * extra steps.
 */
export interface EstimatedSpeed {
  kind: 'estimated';
  rtf: number;
  /** Catalog id of the `measured` entry this was extrapolated from. */
  basedOn: string;
  /** How the extrapolation was done, in plain words. */
  method: string;
  /** rtf is believed to lie within [rtf / f, rtf * f]. Must be > 1 — a certain estimate is a measurement. */
  uncertaintyFactor: number;
}

/** Nobody has run this, and we are saying so out loud. */
export interface UnmeasuredSpeed {
  kind: 'unmeasured';
  reason: SpeedUnmeasuredReason;
}

/**
 * Why an entry is unmeasured. Not cosmetic: `artifact_differs` in particular is the case
 * where a figure DOES exist upstream but belongs to a different file, which is precisely
 * the mistake this field is meant to stop somebody making.
 */
export const SPEED_UNMEASURED_REASONS = [
  /** Simply never put on a stopwatch. The ordinary case. */
  'not_run',
  /**
   * A published figure exists for a DIFFERENT artifact (other quantization, other
   * precision, other packaging) and must not be borrowed. Same model name is not the
   * same file — cf. `ggml-silero-v5.1.2.bin` and `v6.2.0.bin`, identical byte size,
   * different sha256.
   */
  'artifact_differs',
  /** No engine we ship can load it on the reference machine, so there is nothing to time. */
  'engine_unavailable',
  /** Deliberately out of scope for measurement (e.g. a line ADR-016 cut). */
  'out_of_scope',
] as const;
export type SpeedUnmeasuredReason = (typeof SPEED_UNMEASURED_REASONS)[number];

export type SpeedEvidence = MeasuredSpeed | EstimatedSpeed | UnmeasuredSpeed;

/**
 * Compile-time guard for the `switch`es below.
 *
 * Adding a member to {@link SpeedEvidence} without handling it makes the `default` branch
 * receive a non-`never` value and the build goes red — instead of the new member silently
 * taking a runtime fallback path.
 */
function assertNeverSpeed(x: never, what: string): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(x)}`);
}

/** Wording per evidence kind. Total `Record` — widening the kinds list breaks the build. */
export const SPEED_EVIDENCE_LABEL_ZH: Record<SpeedEvidenceKind, string> = {
  measured: '实测',
  estimated: '估计',
  unmeasured: '未测量',
};

/** What the UI is allowed to render for a catalog speed figure. */
export interface SpeedDisplay {
  kind: SpeedEvidenceKind;
  /** Minutes to transcribe one audio-hour. `null` **only** when unmeasured. */
  minutesPerAudioHour: number | null;
  /** 实测 / 估计 / 未测量. Must be shown; the three may not share a chip style. */
  labelZh: string;
  /** One line the user can act on, already carrying its own provenance. */
  detailZh: string;
}

/**
 * Turn evidence into the one string the UI may show.
 *
 * Centralised so that the "measured vs estimated vs unmeasured" wording cannot drift
 * between the model card, the detail panel and the quantization selector. D-10 R-M1 bans
 * calling both this and `FitResult.speedTier` "速度" in the UI; this one is the catalog
 * figure ("参考机实测"), and it is what feeds the per-machine calculation.
 */
export function describeSpeed(e: SpeedEvidence): SpeedDisplay {
  switch (e.kind) {
    case 'measured': {
      const min = e.rtf * 60;
      return {
        kind: 'measured',
        minutesPerAudioHour: min,
        labelZh: SPEED_EVIDENCE_LABEL_ZH.measured,
        detailZh: `参考机实测：1 小时音频约 ${formatMinutes(min)}（${e.benchmark.deviceName}，${e.benchmark.backend}，素材 ${e.benchmark.sampleName}）`,
      };
    }
    case 'estimated': {
      const min = e.rtf * 60;
      return {
        kind: 'estimated',
        minutesPerAudioHour: min,
        labelZh: SPEED_EVIDENCE_LABEL_ZH.estimated,
        // The word 估计 and the source both appear, so this can never read as a measurement.
        detailZh: `估计值（未实测）：1 小时音频约 ${formatMinutes(min)}，由 ${e.basedOn} 推算，误差可能达 ${e.uncertaintyFactor}×`,
      };
    }
    case 'unmeasured':
      return {
        kind: 'unmeasured',
        minutesPerAudioHour: null,
        labelZh: SPEED_EVIDENCE_LABEL_ZH.unmeasured,
        detailZh: SPEED_UNMEASURED_DETAIL_ZH[e.reason],
      };
    default:
      return assertNeverSpeed(e, 'SpeedEvidence');
  }
}

/** Total `Record` — adding a reason without wording breaks the build. */
export const SPEED_UNMEASURED_DETAIL_ZH: Record<SpeedUnmeasuredReason, string> = {
  not_run: '速度未测量 —— 我们没有在参考机上跑过这个文件，因此不给数字。',
  artifact_differs: '速度未测量 —— 上游的速度数字来自另一个文件（不同量化/精度/打包），不能挪用。',
  engine_unavailable: '速度未测量 —— 参考机上没有能加载它的引擎，无从计时。',
  out_of_scope: '速度未测量 —— 该条目已不在本版范围内，不再投入测量。',
};

function formatMinutes(min: number): string {
  return min < 1 ? `${Math.round(min * 60)} 秒` : `${Math.round(min * 10) / 10} 分钟`;
}

/**
 * The reference figure the per-machine fit calculation is allowed to consume.
 *
 * Returns non-null **only** for `measured`. An estimate must never reach `computeFit`,
 * because `FitResult.speedSource` would then label it `reference_machine` — i.e. present
 * a guess as something we put on a stopwatch. Under-claiming ("速度未测量") is the safe
 * direction; over-claiming is the one that turns into a bad user decision.
 */
export function referenceSpeedOf(e: SpeedEvidence): { rtf: number; backend: Backend } | null {
  switch (e.kind) {
    case 'measured':
      return { rtf: e.rtf, backend: e.benchmark.backend };
    case 'estimated':
    case 'unmeasured':
      return null;
    default:
      return assertNeverSpeed(e, 'SpeedEvidence');
  }
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
   * What we know about this file's speed, and how we know it. REQUIRED.
   *
   * Replaces the old optional `referenceBenchmark`. That field could only be present or
   * absent, so "we measured nothing" and "somebody forgot" looked identical; and being
   * optional, a new catalog entry could be added without anyone answering the question.
   * The measurement itself now lives at `speedEvidence.benchmark` — ONE home, so the two
   * cannot drift (D-10 R3: 同一个问题只准有一个答案的出处).
   *
   * Consumers must not read `.rtf` off this union directly; go through
   * {@link referenceSpeedOf} (for the fit calculation) or {@link describeSpeed} (for UI),
   * both of which refuse to let an estimate pass as a measurement.
   */
  speedEvidence: SpeedEvidence;

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
