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
  | 'borderline_vram';

export interface FitResult {
  tier: FitTier;
  reasonCode: FitReasonCode;
  reasonZh: string;
  reasonEn: string;
  /** Estimated layers offloadable to GPU (LLM partial offload only). */
  estGpuLayers: number | null;
  /** Minutes to transcribe one hour of audio. Null until a real benchmark exists. */
  estMinutesPerAudioHour: number | null;
  /** Diagnostic numbers, surfaced in the detail panel so users can sanity-check us. */
  detail: {
    needMB: number;
    vramBudgetMB: number;
    ramBudgetMB: number;
    diskFreeMB: number;
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
  const kv =
    (gguf.kvBytesPerToken * contextLength * KV_QUANT_FACTOR[kvCacheType]) / 1e6;
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
  const base =
    gpu.vramFreeMB ?? (gpu.vramTotalMB ?? 0) * VRAM_TOTAL_FALLBACK_RATIO;
  return Math.round(base * VRAM_HEADROOM_RATIO);
}

export function ramBudgetMB(hw: HardwareInfo): number {
  return Math.round(hw.ram.totalMB * RAM_BUDGET_RATIO);
}

export function modelsRootFreeMB(hw: HardwareInfo): number {
  const d =
    hw.disks.find((x) => x.pathFor === 'models_root') ?? hw.disks[0] ?? null;
  return d ? d.freeMB : 0;
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
  /** Existing benchmark, if the user has run one. */
  benchmarkRtf?: number | null;
}

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

  const estMinutes = input.benchmarkRtf != null ? round1(input.benchmarkRtf * 60) : null;

  const gb = (mb: number) => (mb / 1000).toFixed(1);

  // Rule 1 — disk. The only deterministic failure; everything else is an estimate.
  if (diskFree < diskNeeded) {
    const shortMB = diskNeeded - diskFree;
    return {
      tier: 'blocked_disk',
      reasonCode: 'insufficient_disk',
      reasonZh: `磁盘空间不足，还需 ${gb(shortMB)} GB`,
      reasonEn: `Not enough disk space (need ${gb(shortMB)} GB more)`,
      estGpuLayers: null,
      estMinutesPerAudioHour: estMinutes,
      detail,
    };
  }

  // Rule 2 — required CPU features.
  const missing = input.requirements.cpuFeatures.filter(
    (f) => !hw.cpu.features.includes(f.toLowerCase()),
  );
  if (missing.length > 0) {
    return {
      tier: 'unsupported',
      reasonCode: 'missing_cpu_feature',
      reasonZh: `CPU 不支持所需指令集（${missing.join(', ')}）`,
      reasonEn: `CPU lacks required feature(s): ${missing.join(', ')}`,
      estGpuLayers: null,
      estMinutesPerAudioHour: estMinutes,
      detail,
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
      estMinutesPerAudioHour: estMinutes,
      detail,
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
        reasonZh: `可全部载入显存（需 ${gb(needMB)} GB / 可用 ${gb(vram)} GB）`,
        reasonEn: `Full GPU offload (needs ${gb(needMB)} GB of ${gb(vram)} GB available)`,
        estGpuLayers: input.blockCount ?? null,
        estMinutesPerAudioHour: estMinutes,
        detail,
      };
    }
    return {
      tier: 'slow_partial',
      reasonCode: 'borderline_vram',
      reasonZh: `显存刚好卡在临界（需 ${gb(needMB)} GB / 可用 ${gb(vram)} GB），建议选低一档量化`,
      reasonEn: `Borderline VRAM fit (${gb(needMB)} GB of ${gb(vram)} GB) — consider a smaller quantization`,
      estGpuLayers: input.blockCount ?? null,
      estMinutesPerAudioHour: estMinutes,
      detail,
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
        reasonZh: `可在 CPU 上运行（需 ${gb(needMB)} GB / 可用 ${gb(ram)} GB）`,
        reasonEn: `Runs on CPU (needs ${gb(needMB)} GB of ${gb(ram)} GB)`,
        estGpuLayers: 0,
        estMinutesPerAudioHour: estMinutes,
        detail,
      };
    }
  }

  // Rule 7 — partial GPU offload.
  if (vram > 0 && needMB <= vram + ram) {
    const layers = estimateGpuLayers(input, vram);
    const layerNote =
      layers != null && input.blockCount
        ? `（约 ${layers}/${input.blockCount} 层在显存）`
        : '';
    return {
      tier: 'slow_partial',
      reasonCode: 'partial_gpu_offload',
      reasonZh: `显存不足，部分层将在 CPU 运行，速度较慢${layerNote}`,
      reasonEn: `Partial GPU offload — some layers run on CPU, slower${
        layers != null && input.blockCount ? ` (~${layers}/${input.blockCount} layers on GPU)` : ''
      }`,
      estGpuLayers: layers,
      estMinutesPerAudioHour: estMinutes,
      detail,
    };
  }

  // Rule 8 — fits in RAM, CPU only, slow.
  return {
    tier: 'slow_cpu',
    reasonCode: 'cpu_only_slow',
    reasonZh: `可以运行但很慢（纯 CPU，需 ${gb(needMB)} GB / 可用 ${gb(ram)} GB）`,
    reasonEn: `Runs on CPU only, slow (needs ${gb(needMB)} GB of ${gb(ram)} GB)`,
    estGpuLayers: 0,
    estMinutesPerAudioHour: estMinutes,
    detail,
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
