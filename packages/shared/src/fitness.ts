/**
 * "Can this machine run it?" — the three-tier fit calculation.
 *
 * Ported from R-04 §7.2/§7.3 into executable form. This module is the SINGLE
 * implementation: the daemon calls it and ships the result in the catalog response.
 * The web UI renders `tier` + `reasonZh` and MUST NOT re-implement these rules —
 * two implementations always drift.
 *
 * Pure functions only, no I/O, so this is directly unit-testable.
 */

import type { GgufMetadata, ResourceRequirements } from './artifacts.js';
import type { HardwareInfo } from './hardware.js';

export const FIT_TIERS = [
  'recommended',
  'slow_partial',
  'slow_cpu',
  'unsupported',
  'blocked_disk',
  /**
   * 磁盘余量**没测到**（不是"不够"）。
   *
   * 与 `blocked_disk` 是两件事：那个是"确定装不下"，这个是"我们不知道"。
   * 压成一个的话，要么谎报能装（旧行为：借隔壁卷的数），要么谎报装不下。
   */
  'unknown_disk',
] as const;
export type FitTier = (typeof FIT_TIERS)[number];

export type FitReasonCode =
  | 'full_gpu_offload'
  | 'cpu_ok'
  | 'partial_gpu_offload'
  | 'cpu_only_slow'
  | 'insufficient_ram'
  | 'missing_cpu_feature'
  | 'insufficient_disk'
  | 'borderline_vram'
  | 'not_recommended_for_language'
  | 'disk_unknown';

/**
 * How fast this will feel, independently of whether it fits in memory.
 *
 * ADR-011 decision 2 made this necessary: Chinese requires `large-v3-turbo`, which on CPU
 * runs at 2.7x realtime — one hour of audio takes 22 minutes. "Fits in memory" and
 * "usable" are different questions, and answering only the first misleads the user.
 */
export const SPEED_TIERS = ['fast', 'moderate', 'slow', 'very_slow', 'unknown'] as const;
export type SpeedTier = (typeof SPEED_TIERS)[number];

/** Where the speed estimate came from. The UI must not present these identically. */
export type SpeedSource = 'measured_here' | 'reference_machine' | 'none';

export interface FitResult {
  tier: FitTier;
  reasonCode: FitReasonCode;
  reasonZh: string;
  reasonEn: string;
  /** Estimated layers offloadable to GPU (LLM partial offload only). */
  estGpuLayers: number | null;
  /** Minutes to transcribe one hour of audio. Null when no measurement exists at all. */
  estMinutesPerAudioHour: number | null;
  /** Speed bucket, for a warning independent of the memory verdict. */
  speedTier: SpeedTier;
  /** Provenance of `estMinutesPerAudioHour` — never show a reference figure as if local. */
  speedSource: SpeedSource;
  /**
   * Required CPU features we could **not verify**, because we never detected any.
   *
   * ⚠️ This is deliberately NOT the same thing as `missing_cpu_feature`, and the UI must
   * never render it as such. "Your CPU lacks AVX2" and "we could not check whether your
   * CPU has AVX2" are different sentences, and only one of them is ever true on Windows
   * today: `detectCpuWin32()` returns an empty feature set unconditionally — it has never
   * queried any instruction-set flag at all.
   *
   * Empty when there is nothing to caveat (either we detected features, or none were
   * required). Non-empty means: verdict computed **as if** the requirement were met, and
   * the user should be told we could not confirm it.
   */
  cpuFeaturesUnverified: string[];
  /** True when the model is measured-unsuitable for the requested language (ADR-011). */
  notRecommendedForLanguage: boolean;
  /** Diagnostic numbers, surfaced in the detail panel so users can sanity-check us. */
  detail: {
    needMB: number;
    vramBudgetMB: number;
    ramBudgetMB: number;
    /** `null` = 没测到这个卷（**不是 0**）。见 `modelsRootFreeMB()`。 */
    diskFreeMB: number | null;
    diskNeededMB: number;
  };
}

/* ------------------------------------------------------------------------- */
/* Memory requirement formulas                                               */
/* ------------------------------------------------------------------------- */

/**
 * Per-architecture Whisper runtime overhead in MB (decimal, bytes/1e6).
 *
 * Derived by back-solving whisper.cpp's published "Memory usage" table (Mem - Disk):
 *   tiny 194, base 239, small 363, medium 489, large 786.
 * Rounded UP so every published row is reproduced conservatively.
 *
 * CRITICAL: this is an ADDITIVE constant, not a multiplier. Whisper's compute buffers
 * are sized by model dimensions and do NOT shrink with quantization. A multiplicative
 * model would estimate large-v3-q5_0 (1081 MB file) at ~1.2 GB when it actually needs
 * ~1.9 GB — a systematic underestimate for exactly the quantized models we recommend.
 */
export const WHISPER_OVERHEAD_MB: Record<string, number> = {
  tiny: 200,
  base: 250,
  small: 380,
  medium: 520,
  large: 820,
};

/** Map a Whisper model id/family to its overhead bucket. */
export function whisperOverheadMB(modelId: string): number {
  const s = modelId.toLowerCase();
  if (s.includes('large') || s.includes('turbo')) return WHISPER_OVERHEAD_MB.large;
  if (s.includes('medium')) return WHISPER_OVERHEAD_MB.medium;
  if (s.includes('small')) return WHISPER_OVERHEAD_MB.small;
  if (s.includes('base')) return WHISPER_OVERHEAD_MB.base;
  if (s.includes('tiny')) return WHISPER_OVERHEAD_MB.tiny;
  // Unknown Whisper variant: assume the largest bucket rather than under-promising.
  return WHISPER_OVERHEAD_MB.large;
}

/** Whisper memory need, in decimal MB. */
export function whisperMemoryMB(weightsBytes: number, modelId: string): number {
  return Math.round(weightsBytes / 1e6 + whisperOverheadMB(modelId));
}

/** Bytes-per-element for a KV cache quantization setting. */
export const KV_QUANT_FACTOR = { f16: 1.0, q8_0: 0.5, q4_0: 0.25 } as const;
export type KvCacheType = keyof typeof KV_QUANT_FACTOR;

/** Fixed llama.cpp allocator/compute-graph headroom, in MB. */
export const LLM_GRAPH_OVERHEAD_MB = 300;

/**
 * LLM memory need, in decimal MB, INCLUDING the KV cache.
 *
 * The KV term is the whole point. Verified from real GGUF headers, KV at f16 is
 * ~144 KiB/token for Qwen3-4B/8B, so an 8K context adds ~1.1 GB on top of the weights.
 * LM Studio's estimator under-counts this and mis-badges models as loadable
 * (their own docs flag the beta estimator as not fully accounting for KV growth).
 */
export function llmMemoryMB(
  weightsBytes: number,
  gguf: Pick<GgufMetadata, 'kvBytesPerToken'>,
  contextLength: number,
  kvCacheType: KvCacheType = 'f16',
): number {
  const weights = (weightsBytes / 1e6) * 1.05;
  const kv = (gguf.kvBytesPerToken * contextLength * KV_QUANT_FACTOR[kvCacheType]) / 1e6;
  return Math.round(weights + kv + LLM_GRAPH_OVERHEAD_MB);
}

/** KV cache bytes/token from GGUF header fields. */
export function kvBytesPerToken(
  m: Pick<GgufMetadata, 'blockCount' | 'headCountKv' | 'keyLength' | 'valueLength'>,
): number {
  return m.blockCount * m.headCountKv * (m.keyLength + m.valueLength) * 2;
}

/* ------------------------------------------------------------------------- */
/* Budgets                                                                    */
/* ------------------------------------------------------------------------- */

/** Fraction of unified memory usable as a GPU budget on Apple Silicon. */
export const UNIFIED_MEMORY_BUDGET_RATIO = 0.65;
/** Fallback ratio when free VRAM is unknown. */
export const VRAM_TOTAL_FALLBACK_RATIO = 0.85;
/** Headroom left for the display/driver on a discrete GPU. */
export const VRAM_HEADROOM_RATIO = 0.92;
/** Fraction of system RAM we allow a model to use. */
export const RAM_BUDGET_RATIO = 0.75;
/** Download peak multiplier (partial + final file coexist briefly). */
export const DISK_HEADROOM_RATIO = 1.1;
/** Within this fraction of the VRAM budget we refuse to promise "recommended". */
export const BORDERLINE_BAND = 0.08;

export function vramBudgetMB(hw: HardwareInfo): number {
  if (hw.unifiedMemory) {
    return Math.round(hw.ram.totalMB * UNIFIED_MEMORY_BUDGET_RATIO);
  }
  if (hw.selectedBackend === 'cpu' || hw.selectedGpuIndex === null) return 0;
  const gpu = hw.gpus[hw.selectedGpuIndex];
  if (!gpu) return 0;
  // Never sum across GPUs: LM Studio issue #67 badges dual-3090 setups as
  // "Full GPU Offload Possible" and then OOMs on load.
  const base = gpu.vramFreeMB ?? (gpu.vramTotalMB ?? 0) * VRAM_TOTAL_FALLBACK_RATIO;
  return Math.round(base * VRAM_HEADROOM_RATIO);
}

export function ramBudgetMB(hw: HardwareInfo): number {
  return Math.round(hw.ram.totalMB * RAM_BUDGET_RATIO);
}

/**
 * 模型卷的可用空间；**`null` = 没测到**。
 *
 * ⚠️ 这里原本是 `?? hw.disks[0] ?? null`，也就是**模型卷读不到时借第一块盘的数**。
 * 而 `detectDisks()` 在 `statfs` 抛异常时会把那一项**整条省略**（首次运行目录还没建、
 * 移动硬盘没插、网络盘没挂 —— 都是合法情况），于是 `disks[0]` 剩下的往往是
 * `runtimes_root`，**可能是另一个卷**。
 *
 * 后果是同一个卷出现两个数，而且其中一个根本不是它的：
 * fit 判定拿系统盘的 400 GB 说"可安装"，存储页同时显示"剩余 0 B"。
 * **「我没拿到」被说成了「隔壁那个就是它」** —— 这比报错更难查，因为它给的是个
 * 看起来很合理的数字。
 *
 * 现在：找不到 `models_root` 就如实返回 `null`，由调用方走"未知"那一档。
 * **不许再用任何别的卷的数字冒充它。**
 */
export function modelsRootFreeMB(hw: HardwareInfo): number | null {
  const d = hw.disks.find((x) => x.pathFor === 'models_root');
  return d ? d.freeMB : null;
}

/* ------------------------------------------------------------------------- */
/* The decision table                                                         */
/* ------------------------------------------------------------------------- */

export interface FitInput {
  /** Total download size in bytes. */
  totalSizeBytes: number;
  requirements: ResourceRequirements;
  /** "asr" or "llm" — CPU recommendation rules differ. */
  role: 'asr' | 'llm';
  /** Model id, used for the Whisper size bucket in CPU rules. */
  modelId: string;
  /** Parameter count in billions, when known (LLM CPU rule). */
  paramsB?: number;
  /** Transformer layer count, for the partial-offload estimate. */
  blockCount?: number;
  /** RTF measured on THIS machine. Highest-trust source. */
  benchmarkRtf?: number | null;
  /** RTF we measured on a reference machine, shipped in the catalog. */
  referenceRtf?: number | null;
  /** Backend the reference figure was measured on — only comparable to a like backend. */
  referenceBackend?: string | null;
  /** Languages this model is measured-unsuitable for (ADR-011). */
  notRecommendedFor?: string[];
  /** Language the user actually wants to transcribe, e.g. "zh". */
  targetLanguage?: string | null;
}

/**
 * Minutes per audio-hour → speed bucket.
 *
 * Thresholds chosen against the real measurements in ADR-011:
 *   base            RTF 0.055 →  3.3 min/hour → fast
 *   large-v3-turbo  RTF 0.377 → 22.6 min/hour → slow
 * 22 minutes for a one-hour recording is usable but demands a warning; an hour or more
 * is where people abandon the task.
 */
export function speedTierFor(minutesPerHour: number | null): SpeedTier {
  if (minutesPerHour == null) return 'unknown';
  if (minutesPerHour <= 6) return 'fast';
  if (minutesPerHour <= 15) return 'moderate';
  if (minutesPerHour <= 40) return 'slow';
  return 'very_slow';
}

const SPEED_NOTE_ZH: Record<SpeedTier, string> = {
  fast: '速度快',
  moderate: '速度中等',
  slow: '较慢',
  very_slow: '很慢',
  unknown: '速度未测量',
};

export function computeFit(input: FitInput, hw: HardwareInfo): FitResult {
  const needMB = input.requirements.ramRequiredMB;
  const vram = vramBudgetMB(hw);
  const ram = ramBudgetMB(hw);
  const diskFree = modelsRootFreeMB(hw);
  const diskNeeded = Math.round((input.totalSizeBytes / 1e6) * DISK_HEADROOM_RATIO);

  const detail = {
    needMB,
    vramBudgetMB: vram,
    ramBudgetMB: ram,
    diskFreeMB: diskFree,
    diskNeededMB: diskNeeded,
  };

  // Speed. Locally measured always wins; a reference figure is used only as a fallback
  // and is tagged so the UI can say where it came from.
  let estMinutes: number | null = null;
  let speedSource: SpeedSource = 'none';
  if (input.benchmarkRtf != null) {
    estMinutes = round1(input.benchmarkRtf * 60);
    speedSource = 'measured_here';
  } else if (
    input.referenceRtf != null &&
    // Only comparable when the backend matches; a CUDA figure says nothing about CPU.
    (input.referenceBackend == null || input.referenceBackend === hw.selectedBackend)
  ) {
    estMinutes = round1(input.referenceRtf * 60);
    speedSource = 'reference_machine';
  }
  const speedTier = speedTierFor(estMinutes);

  const lang = input.targetLanguage ?? null;
  const notRecommendedForLanguage = lang != null && (input.notRecommendedFor ?? []).includes(lang);

  /* 三态判定要在 `base` 之前算出来 —— `base` 要把 unverified 带给每一个返回分支。 */
  const required = input.requirements.cpuFeatures;
  const featuresKnown = hw.cpu.features.length > 0;
  const cpuFeaturesUnverified = featuresKnown ? [] : [...required];
  const missing = featuresKnown
    ? required.filter((f) => !hw.cpu.features.includes(f.toLowerCase()))
    : [];

  const base = {
    estMinutesPerAudioHour: estMinutes,
    speedTier,
    speedSource,
    notRecommendedForLanguage,
    detail,
    cpuFeaturesUnverified,
  };

  const gb = (mb: number) => (mb / 1000).toFixed(1);
  /** Append the speed caveat so "fits" never reads as "will be pleasant". */
  const withSpeed = (zh: string) =>
    estMinutes != null && (speedTier === 'slow' || speedTier === 'very_slow')
      ? `${zh} · ${SPEED_NOTE_ZH[speedTier]}（1 小时音频约 ${Math.round(estMinutes)} 分钟）`
      : zh;

  /*
   * Rule 0 — 磁盘余量**没测到**。
   *
   * 必须排在 Rule 1 前面，而且必须是独立一档：`diskFree` 为 null 时既不能说"装得下"
   * （那是旧行为借隔壁卷的数得出的结论），也不能说"装不下"（我们并不知道）。
   *
   * 这一档**不硬禁用安装**（`ModelCard` 只对 `blocked_disk` 禁用）：真正的把关在
   * 装的时候 —— `rest/models.ts` 的磁盘预检会用当时现算的读数拦下来并给可点的补救。
   * 这里只负责**不假装我们检查过**。
   */
  if (diskFree === null) {
    return {
      tier: 'unknown_disk',
      reasonCode: 'disk_unknown',
      reasonZh: '没能读到模型目录所在卷的可用空间，装之前会再查一次',
      reasonEn: "Couldn't read free space on the models volume; it is re-checked at install time",
      estGpuLayers: null,
      ...base,
    };
  }

  // Rule 1 — disk. The only deterministic failure; everything else is an estimate.
  if (diskFree < diskNeeded) {
    const shortMB = diskNeeded - diskFree;
    return {
      tier: 'blocked_disk',
      reasonCode: 'insufficient_disk',
      reasonZh: `磁盘空间不足，还需 ${gb(shortMB)} GB`,
      reasonEn: `Not enough disk space (need ${gb(shortMB)} GB more)`,
      estGpuLayers: null,
      ...base,
    };
  }

  // Rule 1b — measured-unsuitable for the requested language (ADR-011 decision 1).
  //
  // Placed before the memory rules deliberately: a model that fits perfectly but produces
  // 危机摆科 for 维基百科 is not "recommended" by any useful definition. It is still
  // downloadable — the UI filters it by default and lets the user unhide it, because the
  // same model remains a fine choice for another language.
  if (notRecommendedForLanguage) {
    return {
      tier: 'slow_cpu',
      reasonCode: 'not_recommended_for_language',
      reasonZh: `实测在该语言下识别质量不可接受，不建议使用（换用更大的模型）`,
      reasonEn: `Measured output quality is unacceptable for this language — pick a larger model`,
      estGpuLayers: null,
      ...base,
    };
  }

  /*
   * Rule 2 — required CPU features. **Three states, not two.**
   *
   * ⚠️ An EMPTY detected feature set means "we never looked", not "the CPU has nothing".
   *   `detectCpuWin32()` (packages/runtime/src/detect/system.ts) returns `features: []`
   *   unconditionally — it only ever asked PowerShell for the physical core count and has
   *   never queried a single instruction-set flag. Treating that empty set as evidence of
   *   absence made **every Windows machine** report
   *       「CPU 不支持所需指令集（avx2）」
   *   for the 5 models that declare `cpuFeatures: ['avx2']`
   *   (llm/qwen3-{1.7b-q8_0,4b-q4_k_m,4b-q5_k_m,8b-q4_k_m}, llm/gemma-3-4b-it-q4_k_m)
   *   — including on a Ryzen 7 7840HS (Zen 4), which supports AVX2 and AVX-512.
   *
   *   **The user read "my CPU is inadequate" when the truth was "we never checked."**
   *   An unsupported verdict built on an unasked question is worse than no verdict: it is
   *   confidently wrong, and it silently removed working models from their choices.
   *
   * So: only conclude "missing" when we actually have evidence to compare against.
   * With no evidence we do NOT flip to "supported" either — we proceed with the rest of
   * the verdict (RAM/GPU are independent and still meaningful) and hand the caller an
   * explicit `cpuFeaturesUnverified` list so the UI can say the honest third sentence.
   */
  if (missing.length > 0) {
    return {
      tier: 'unsupported',
      reasonCode: 'missing_cpu_feature',
      reasonZh: `CPU 不支持所需指令集（${missing.join(', ')}）`,
      reasonEn: `CPU lacks required feature(s): ${missing.join(', ')}`,
      estGpuLayers: null,
      ...base,
    };
  }

  // Rule 3 — cannot fit in RAM at all.
  if (needMB > ram) {
    return {
      tier: 'unsupported',
      reasonCode: 'insufficient_ram',
      reasonZh: `内存不足，无法运行（需 ${gb(needMB)} GB / 可用 ${gb(ram)} GB）`,
      reasonEn: `Not enough memory (needs ${gb(needMB)} GB, ${gb(ram)} GB available)`,
      estGpuLayers: null,
      ...base,
    };
  }

  // Rule 4 — full GPU offload. Borderline band demoted (rule 4b) to avoid a hard
  // threshold flipping between "recommended" and "too big" on a rounding error.
  if (vram > 0 && needMB <= vram) {
    const margin = (vram - needMB) / vram;
    if (margin >= BORDERLINE_BAND) {
      return {
        tier: 'recommended',
        reasonCode: 'full_gpu_offload',
        reasonZh: withSpeed(`可全部载入显存（需 ${gb(needMB)} GB / 可用 ${gb(vram)} GB）`),
        reasonEn: `Full GPU offload (needs ${gb(needMB)} GB of ${gb(vram)} GB available)`,
        estGpuLayers: input.blockCount ?? null,
        ...base,
      };
    }
    return {
      tier: 'slow_partial',
      reasonCode: 'borderline_vram',
      reasonZh: `显存刚好卡在临界（需 ${gb(needMB)} GB / 可用 ${gb(vram)} GB），建议选低一档量化`,
      reasonEn: `Borderline VRAM fit (${gb(needMB)} GB of ${gb(vram)} GB) — consider a smaller quantization`,
      estGpuLayers: input.blockCount ?? null,
      ...base,
    };
  }

  // Rules 5/6 — CPU-only but comfortably small.
  if (vram === 0 && needMB <= ram * 0.5) {
    const asrOk = input.role === 'asr' && isSmallWhisper(input.modelId);
    const llmOk = input.role === 'llm' && (input.paramsB ?? 99) <= 4;
    if (asrOk || llmOk) {
      return {
        tier: 'recommended',
        reasonCode: 'cpu_ok',
        reasonZh: withSpeed(`可在 CPU 上运行（需 ${gb(needMB)} GB / 可用 ${gb(ram)} GB）`),
        reasonEn: `Runs on CPU (needs ${gb(needMB)} GB of ${gb(ram)} GB)`,
        estGpuLayers: 0,
        ...base,
      };
    }
  }

  // Rule 7 — partial GPU offload.
  if (vram > 0 && needMB <= vram + ram) {
    const layers = estimateGpuLayers(input, vram);
    const layerNote =
      layers != null && input.blockCount ? `（约 ${layers}/${input.blockCount} 层在显存）` : '';
    return {
      tier: 'slow_partial',
      reasonCode: 'partial_gpu_offload',
      reasonZh: `显存不足，部分层将在 CPU 运行，速度较慢${layerNote}`,
      reasonEn: `Partial GPU offload — some layers run on CPU, slower${
        layers != null && input.blockCount ? ` (~${layers}/${input.blockCount} layers on GPU)` : ''
      }`,
      estGpuLayers: layers,
      ...base,
    };
  }

  // Rule 8 — fits in RAM, CPU only, slow.
  return {
    tier: 'slow_cpu',
    reasonCode: 'cpu_only_slow',
    reasonZh: withSpeed(`可以运行但很慢（纯 CPU，需 ${gb(needMB)} GB / 可用 ${gb(ram)} GB）`),
    reasonEn: `Runs on CPU only, slow (needs ${gb(needMB)} GB of ${gb(ram)} GB)`,
    estGpuLayers: 0,
    ...base,
  };
}

function isSmallWhisper(modelId: string): boolean {
  const s = modelId.toLowerCase();
  return s.includes('tiny') || s.includes('base') || s.includes('small');
}

/**
 * Approximate offloadable layer count.
 *
 * Assumes all transformer blocks are equally sized, which they are not — embedding and
 * output tensors are larger — so this OVERESTIMATES. The UI must hedge it ("about N").
 * UNVERIFIED: needs calibration against real llama.cpp `-ngl` behaviour.
 */
function estimateGpuLayers(input: FitInput, vramMB: number): number | null {
  const blocks = input.blockCount;
  if (!blocks) return null;
  const weightsMB = (input.totalSizeBytes / 1e6) * 1.05;
  const kvMB = Math.max(0, input.requirements.ramRequiredMB - weightsMB - LLM_GRAPH_OVERHEAD_MB);
  const usable = vramMB - kvMB - LLM_GRAPH_OVERHEAD_MB;
  if (usable <= 0) return 0;
  const n = Math.floor((blocks * usable) / weightsMB);
  return Math.max(0, Math.min(blocks, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
