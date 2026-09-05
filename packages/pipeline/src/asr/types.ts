/**
 * ASR adapter contract. D-01 §6.1.
 *
 * ADR-001 mandate 2: `TranscriptSegment` is OUR type, shaped after D-02 §1.5's
 * `transcript_segments` table. No engine's native structure crosses this boundary —
 * whisper.cpp's JSON, sherpa-onnx's objects and any future engine all get mapped here.
 */

import type { Backend } from '@openmemo/shared';

/*
 * `transcript_segments.flags` 的位域（D-02 §1.5）—— **权威定义在 `@openmemo/shared`**，
 * 这里只是再导出（本包的写入点 `whisperCpp.ts` / `whisperServer.ts` / `merge.ts` 一个字不用改）。
 *
 * ★ 收敛方向是 pipeline → shared，**不是**反过来：位域要被浏览器读（段落上的标记要画出来），
 *   而 `@openmemo/pipeline` 依赖 `node:` 与子进程，前端打不进去。shared 是两边都够得着的
 *   唯一位置。⚠️ 名字用的是**本包这一套**（`SUSPECT_REPETITION` / `HUMAN_CONFIRMED` /
 *   `SILENCE_OR_MUSIC`）—— 判据是"哪个名字在它被写入时是可断言的"，逐位的对照表写在
 *   `packages/shared/src/notes.ts` 那份声明上面。
 */
export { SEGMENT_FLAG } from '@openmemo/shared';

export interface WordTimestamp {
  w: string;
  s: number;
  e: number;
  p?: number;
}

/** Maps 1:1 onto a `transcript_segments` row. */
export interface TranscriptSegment {
  /** Absolute ms from the start of the MEDIA, never relative to the chunk. */
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  noSpeechProb: number | null;
  words: WordTimestamp[] | null;
  /** Which ASR chunk produced this — drives resume and single-chunk re-runs. */
  chunkIdx: number;
  flags: number;
  speakerLabel: string | null;
}

export interface AsrCapabilities {
  modes: ('batch' | 'stream')[];
  backends: Backend[];
  languages: string[] | 'auto';
  wordTimestamps: boolean;
  diarization: boolean;
  maxAudioSeconds?: number;
  /**
   * Preferred ASR chunk length, in ms.
   *
   * Exists because chunk size is not only a scheduling knob — for an engine with no
   * word-level timestamps it IS the timeline resolution. Offline Paraformer returns one
   * block of text per call, so a 30 s chunk yields exactly one segment spanning 30 s,
   * and F5's Chinese highlighting (already degraded to segment level by ADR-013) ends up
   * with nothing to highlight. Such engines ask for shorter chunks; whisper, which
   * emits its own sentence timings, leaves this unset.
   */
  preferredChunkMs?: number;
}

export interface TranscribeChunkRequest {
  /** Normalized 16 kHz mono WAV covering the WHOLE media. */
  audioPath: string;
  chunkIndex: number;
  offsetMs: number;
  durationMs: number;
  modelPath: string;
  language?: string;
  /** User-controlled. Truncated by argGuard.safePrompt before it reaches any argv. */
  prompt?: string;
  threads?: number;
  wordTimestamps?: boolean;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface AsrStreamEvents {
  partial: (segment: TranscriptSegment) => void;
  final: (segment: TranscriptSegment) => void;
  error: (err: Error) => void;
}

export interface AsrStream {
  /** Feed 16 kHz mono int16 PCM. */
  write(pcm: Int16Array): void;
  on<K extends keyof AsrStreamEvents>(event: K, handler: AsrStreamEvents[K]): void;
  close(): Promise<void>;
}

export interface StreamRequest {
  modelPath: string;
  language?: string;
  signal: AbortSignal;
}

export type AsrAvailability = { ok: true } | { ok: false; reason: string; remediation: string };

export interface AsrEngine {
  readonly id: string;
  readonly kind: 'asr';
  capabilities(): Promise<AsrCapabilities>;
  isAvailable(): Promise<AsrAvailability>;
  transcribeChunk(req: TranscribeChunkRequest): Promise<TranscriptSegment[]>;
  openStream?(req: StreamRequest): AsrStream;
}

/**
 * Heuristic repetition detector for D-02 §1.5 `flags` bit 0.
 *
 * Whisper loops on silence and on music, emitting the same phrase dozens of times. We
 * cannot fix the model, but we can flag the output so the UI can highlight it and the
 * user can re-run just the affected chunk (D-01 §4.5 — the reason chunks are addressable).
 */
export function detectRepetition(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 16) return false;

  // Same token repeated many times in a row.
  const tokens = trimmed.split(/\s+/);
  if (tokens.length >= 6) {
    let run = 1;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === tokens[i - 1]) {
        run += 1;
        if (run >= 5) return true;
      } else {
        run = 1;
      }
    }
  }

  // A short phrase tiling the whole string (catches CJK, which has no spaces).
  for (let len = 2; len <= Math.min(20, Math.floor(trimmed.length / 3)); len++) {
    const unit = trimmed.slice(0, len);
    if (unit.trim().length === 0) continue;
    const repeats = Math.floor(trimmed.length / len);
    if (repeats < 4) continue;
    if (unit.repeat(repeats) === trimmed.slice(0, len * repeats)) return true;
  }
  return false;
}

/**
 * whisper.cpp reports `avg_logprob`. Map it to a 0..1 confidence for the UI.
 *
 * This is a presentation transform, not a calibrated probability — D-02 §1.5 stores it
 * in `confidence` purely to drive "low confidence" highlighting.
 */
export function logprobToConfidence(avgLogprob: number | null): number | null {
  if (avgLogprob === null || !Number.isFinite(avgLogprob)) return null;
  return Math.max(0, Math.min(1, Math.exp(avgLogprob)));
}
