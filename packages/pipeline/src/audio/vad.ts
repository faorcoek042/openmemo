/**
 * Voice Activity Detection and chunk planning.
 *
 * D-01 §4.1 — this is the layer that makes the whole queue design work:
 *
 *   "one chunk done = one DB transaction = one preemption point = one resume point
 *    = one real progress tick"
 *
 * Four properties for the price of one, plus the user watching text appear a few
 * seconds in instead of staring at a spinner for forty minutes.
 *
 * IMPLEMENTATION NOTE (verified on the T-012 box): we do not need a separate VAD
 * dependency. whisper.cpp v1.9.1 ships `whisper-vad-speech-segments`, which runs Silero
 * VAD through ggml, and it is already inside the L1 core pack built by
 * scripts/build-whisper.sh. Measured output on samples/jfk.wav:
 *
 *     Detected 5 speech segments:
 *     Speech segment 0: start = 29.00, end = 221.00
 *     ...
 *     Speech segment 4: start = 816.00, end = 1059.00
 *
 * Note the units: those are CENTISECONDS, not seconds (jfk.wav is 11.0 s = 1100 cs).
 * Reading them as seconds yields chunks 100x too long and is the obvious way to get
 * this wrong.
 */

import { buildArgv } from '../subprocess/argGuard.js';
import { runOrThrow } from '../subprocess/runner.js';
import type { ToolPaths } from '../tools.js';

export interface SpeechSegment {
  startMs: number;
  endMs: number;
}

export interface AsrChunk {
  index: number;
  startMs: number;
  endMs: number;
  /** Speech segments merged into this chunk; useful for diagnostics. */
  segmentCount: number;
}

export interface VadOptions {
  threshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
  maxSpeechDurationSec?: number;
  speechPadMs?: number;
  threads?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run Silero VAD over a normalized WAV.
 *
 * Returns [] when the file contains no speech at all — a legitimate result (silence, a
 * music-only track), not an error. The caller decides what to do.
 */
export async function detectSpeechSegments(
  tools: ToolPaths,
  wavPath: string,
  opts: VadOptions & { cwd: string },
): Promise<SpeechSegment[]> {
  if (tools.whisperVad === null || tools.vadModel === null) {
    throw new Error('VAD component or model is not installed');
  }

  const flags = [
    '-f', wavPath,
    '-vm', tools.vadModel,
    '-np', // machine-readable: suppress everything except the results
    '-t', String(opts.threads ?? 4),
  ];
  if (opts.threshold !== undefined) flags.push('-vt', String(opts.threshold));
  if (opts.minSpeechDurationMs !== undefined) flags.push('-vspd', String(opts.minSpeechDurationMs));
  if (opts.minSilenceDurationMs !== undefined) flags.push('-vsd', String(opts.minSilenceDurationMs));
  if (opts.maxSpeechDurationSec !== undefined) flags.push('-vmsd', String(opts.maxSpeechDurationSec));
  if (opts.speechPadMs !== undefined) flags.push('-vp', String(opts.speechPadMs));

  const argv = buildArgv({ flags, operands: [], useDoubleDash: false });
  if (!argv.ok) throw new Error(`VAD argument rejected: ${argv.message}`);

  const result = await runOrThrow({
    bin: tools.whisperVad,
    argv: argv.value,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    signal: opts.signal,
  });

  return parseVadOutput(result.stdout);
}

/**
 * Parse `whisper-vad-speech-segments` output.
 *
 * Format (v1.9.1, measured):
 *   Detected 5 speech segments:
 *   Speech segment 0: start = 29.00, end = 221.00
 *
 * Values are centiseconds. Exported so the parser is unit-testable without the binary.
 */
export function parseVadOutput(stdout: string): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  const re = /Speech segment\s+(\d+):\s*start\s*=\s*([\d.]+)\s*,\s*end\s*=\s*([\d.]+)/gi;

  for (const m of stdout.matchAll(re)) {
    const startCs = Number(m[2]);
    const endCs = Number(m[3]);
    if (!Number.isFinite(startCs) || !Number.isFinite(endCs)) continue;
    const startMs = Math.round(startCs * 10);
    const endMs = Math.round(endCs * 10);
    if (endMs <= startMs) continue;
    segments.push({ startMs, endMs });
  }
  return segments;
}

export interface ChunkPlanOptions {
  /**
   * Target chunk length. 30 s matches Whisper's native window, so a chunk maps onto one
   * encoder pass with no wasted padding.
   */
  targetChunkMs?: number;
  /** Hard ceiling. Longer chunks mean coarser progress and slower cancellation. */
  maxChunkMs?: number;
  /** Below this, merge forward — a 200 ms chunk costs more in model overhead than audio. */
  minChunkMs?: number;
  /**
   * Silence longer than this is dropped rather than sent to the model.
   *
   * Whisper hallucinates confidently on silence — it is the single most reported quality
   * problem with it. Not feeding it silence is the cheapest available mitigation.
   */
  maxGapToBridgeMs?: number;
  /** Padding around each chunk so words at the boundary are not clipped. */
  padMs?: number;
  /** Total duration, used to clamp the final chunk. */
  totalDurationMs: number;
}

/**
 * Merge speech segments into ASR chunks.
 *
 * Greedy accumulation up to `targetChunkMs`, breaking at silence. Breaking at silence
 * rather than at a fixed clock interval is what keeps words from being cut in half, and
 * it is free because VAD already told us where the silence is.
 */
export function planChunks(segments: SpeechSegment[], opts: ChunkPlanOptions): AsrChunk[] {
  const {
    targetChunkMs = 30_000,
    maxChunkMs = 45_000,
    minChunkMs = 1_000,
    maxGapToBridgeMs = 2_000,
    padMs = 200,
    totalDurationMs,
  } = opts;

  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const chunks: AsrChunk[] = [];

  let curStart = sorted[0]!.startMs;
  let curEnd = sorted[0]!.endMs;
  let curCount = 1;

  const flush = (): void => {
    const start = Math.max(0, curStart - padMs);
    const end = Math.min(totalDurationMs, curEnd + padMs);
    if (end - start < minChunkMs && chunks.length > 0) {
      // Too short to stand alone: fold it into the previous chunk.
      const prev = chunks[chunks.length - 1]!;
      prev.endMs = end;
      prev.segmentCount += curCount;
      return;
    }
    chunks.push({ index: chunks.length, startMs: start, endMs: end, segmentCount: curCount });
  };

  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const gap = seg.startMs - curEnd;
    const wouldBe = seg.endMs - curStart;

    const gapTooBig = gap > maxGapToBridgeMs;
    const tooLong = wouldBe > maxChunkMs;
    const longEnoughAndAtSilence = wouldBe > targetChunkMs && gap > 0;

    if (gapTooBig || tooLong || longEnoughAndAtSilence) {
      flush();
      curStart = seg.startMs;
      curEnd = seg.endMs;
      curCount = 1;
      continue;
    }

    curEnd = seg.endMs;
    curCount += 1;
  }
  flush();

  // Re-index after any folding so `index` stays dense and matches DB `chunk_idx`.
  return chunks.map((c, i) => ({ ...c, index: i }));
}

/**
 * Fallback when VAD is unavailable or finds nothing but the file clearly has audio:
 * fixed-size windows with a small overlap so a word spanning a boundary survives.
 */
export function planFixedChunks(totalDurationMs: number, chunkMs = 30_000, overlapMs = 500): AsrChunk[] {
  const chunks: AsrChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < totalDurationMs) {
    const end = Math.min(totalDurationMs, start + chunkMs);
    chunks.push({ index: index++, startMs: start, endMs: end, segmentCount: 0 });
    if (end >= totalDurationMs) break;
    start = end - overlapMs;
  }
  return chunks;
}

/** Total speech time, for "this file is 3 hours but only 40 minutes of talking". */
export function totalSpeechMs(segments: SpeechSegment[]): number {
  return segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
}
