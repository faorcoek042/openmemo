/**
 * ASR adapter contract. D-01 §6.1.
 *
 * ADR-001 mandate 2: `TranscriptSegment` is OUR type, shaped after D-02 §1.5's
 * `transcript_segments` table. No engine's native structure crosses this boundary —
 * whisper.cpp's JSON, sherpa-onnx's objects and any future engine all get mapped here.
 */

import type { Backend } from '@openmemo/shared';

/** Bit flags on `transcript_segments.flags` (D-02 §1.5). */
export const SEGMENT_FLAG = {
  /** Suspected repetition/hallucination — whisper's best-known failure mode. */
  SUSPECT_REPETITION: 1 << 0,
  LOW_CONFIDENCE: 1 << 1,
  HUMAN_CONFIRMED: 1 << 2,
  SILENCE_OR_MUSIC: 1 << 3,
} as const;

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

export type AsrAvailability =
  | { ok: true }
  | { ok: false; reason: string; remediation: string };

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
