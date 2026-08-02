/**
 * WhisperCppEngine — the primary ASR engine (D-01 §6.1).
 *
 * Drives the `whisper-cli` binary from the L1 core pack built by
 * scripts/build-whisper.sh (T-012). Runs as a SUBPROCESS, always — measured during
 * T-012, whisper.cpp calls ggml_abort() and dies of SIGABRT when its backend libraries
 * are missing, so an in-process binding would take the daemon down with it.
 *
 * Chunking strategy: rather than slicing the WAV into N temp files, we pass
 * `--offset-t` / `--duration` and let whisper read the window it needs out of the single
 * normalized WAV. Fewer files, no re-encode, and the chunk boundaries stay exact.
 */

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Backend } from '@openmemo/shared';

import { buildArgv, safePrompt } from '../subprocess/argGuard.js';
import { runOrThrow } from '../subprocess/runner.js';
import type { ToolPaths } from '../tools.js';
import { fileExists, isExecutable } from '../tools.js';
import type {
  AsrAvailability,
  AsrCapabilities,
  AsrEngine,
  TranscribeChunkRequest,
  TranscriptSegment,
} from './types.js';
import { SEGMENT_FLAG, detectRepetition, logprobToConfidence } from './types.js';

export interface WhisperCppEngineOptions {
  tools: ToolPaths;
  /** Managed scratch directory for whisper's JSON output. */
  cwd: string;
  /**
   * Backends reported as available by @openmemo/runtime's probe.
   *
   * Supplied by the caller rather than re-detected here: the runtime package already
   * owns that question and its probe is the authoritative source (T-012).
   */
  availableBackends?: Backend[];
  defaultThreads?: number;
  perChunkTimeoutMs?: number;
  /** Lower scheduling priority so CPU inference does not starve the daemon (D-01 §4.2). */
  nice?: boolean;
}

export class WhisperCppEngine implements AsrEngine {
  readonly id = 'whisper.cpp';
  readonly kind = 'asr' as const;

  constructor(private readonly opts: WhisperCppEngineOptions) {}

  async capabilities(): Promise<AsrCapabilities> {
    return {
      modes: ['batch'],
      backends: this.opts.availableBackends ?? ['cpu'],
      languages: 'auto',
      // whisper.cpp can emit word timestamps, but only via -ojf; see transcribeChunk.
      wordTimestamps: true,
      // whisper.cpp has no speaker diarization. sherpa-onnx covers that (D-01 §6.1).
      diarization: false,
    };
  }

  async isAvailable(): Promise<AsrAvailability> {
    if (!(await isExecutable(this.opts.tools.whisperCli))) {
      return {
        ok: false,
        reason: 'the speech recognition engine is not installed',
        remediation: 'Install the CPU backend from Settings → Runtime.',
      };
    }
    return { ok: true };
  }

  async transcribeChunk(req: TranscribeChunkRequest): Promise<TranscriptSegment[]> {
    const bin = this.opts.tools.whisperCli;
    if (bin === null) throw new Error('the speech recognition engine is not installed');
    if (!(await fileExists(req.modelPath))) {
      throw new Error(`model not found: ${req.modelPath}`);
    }

    // whisper writes `<outputBase>.json`; the basename is ours, never user-derived.
    const outputBase = join(this.opts.cwd, `chunk-${String(req.chunkIndex)}-${String(Date.now())}`);
    const jsonPath = `${outputBase}.json`;

    const flags: string[] = [
      '-m', req.modelPath,
      '-f', req.audioPath,
      // Window into the full WAV — no slicing needed.
      '--offset-t', String(Math.round(req.offsetMs)),
      '--duration', String(Math.round(req.durationMs)),
      '-t', String(req.threads ?? this.opts.defaultThreads ?? 4),
      // -ojf (full JSON) is what carries avg_logprob and no_speech_prob; plain -oj does not.
      '--output-json-full',
      '--output-file', outputBase,
      // Keep stdout clean; we read the JSON file, not the console.
      '--no-prints',
    ];

    if (req.language !== undefined && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/.test(req.language)) {
      flags.push('-l', req.language);
    }

    // D-01 §8.4 L4 — the prompt is user-controlled. It is safe as ONE argv element, but
    // must be length-capped: Linux MAX_ARG_STRLEN is 128 KB and a huge prompt also
    // silently evicts the model's context.
    const prompt = safePrompt(req.prompt);
    if (prompt !== null) flags.push('--prompt', prompt);

    const argv = buildArgv({ flags, operands: [], useDoubleDash: false });
    if (!argv.ok) throw new Error(`whisper argument rejected: ${argv.message}`);

    try {
      await runOrThrow({
        bin,
        argv: argv.value,
        cwd: this.opts.cwd,
        timeoutMs: this.opts.perChunkTimeoutMs ?? 30 * 60_000,
        signal: req.signal,
        nice: this.opts.nice ?? false,
        onStderrLine: (line) => {
          // "whisper_print_progress_callback: progress =  40%"
          const m = /progress\s*=\s*(\d+)%/.exec(line);
          if (m?.[1] !== undefined) req.onProgress?.(Number(m[1]) / 100);
        },
      });

      const raw = await readFile(jsonPath, 'utf8');
      return parseWhisperJson(raw, req.offsetMs, req.chunkIndex);
    } finally {
      await unlink(jsonPath).catch(() => undefined);
    }
  }
}

interface WhisperJsonSegment {
  timestamps?: { from?: string; to?: string };
  offsets?: { from?: number; to?: number };
  text?: string;
  tokens?: { text?: string; timestamps?: { from?: string; to?: string }; offsets?: { from?: number; to?: number }; p?: number }[];
  no_speech_prob?: number;
  avg_logprob?: number;
}

/**
 * Map whisper.cpp's `-ojf` output onto our TranscriptSegment.
 *
 * `offsets` are milliseconds RELATIVE TO THE CHUNK, so `chunkOffsetMs` must be added to
 * get media-absolute times. Forgetting that is how every segment ends up starting at
 * zero, and it is invisible in a single-chunk test — which is exactly why the end-to-end
 * run in D-06 uses a file long enough to produce several chunks.
 */
export function parseWhisperJson(
  raw: string,
  chunkOffsetMs: number,
  chunkIndex: number,
): TranscriptSegment[] {
  let parsed: { transcription?: WhisperJsonSegment[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error('whisper produced unparseable JSON');
  }

  const out: TranscriptSegment[] = [];

  for (const seg of parsed.transcription ?? []) {
    const text = (seg.text ?? '').trim();
    if (text.length === 0) continue;

    const fromMs = seg.offsets?.from ?? 0;
    const toMs = seg.offsets?.to ?? fromMs;

    const confidence = logprobToConfidence(seg.avg_logprob ?? null);
    const noSpeechProb = seg.no_speech_prob ?? null;

    let flags = 0;
    if (detectRepetition(text)) flags |= SEGMENT_FLAG.SUSPECT_REPETITION;
    if (confidence !== null && confidence < 0.4) flags |= SEGMENT_FLAG.LOW_CONFIDENCE;
    if (noSpeechProb !== null && noSpeechProb > 0.6) flags |= SEGMENT_FLAG.SILENCE_OR_MUSIC;

    const words =
      seg.tokens === undefined
        ? null
        : seg.tokens
            .filter((t) => (t.text ?? '').trim().length > 0 && !(t.text ?? '').startsWith('['))
            .map((t) => ({
              w: t.text ?? '',
              s: chunkOffsetMs + (t.offsets?.from ?? fromMs),
              e: chunkOffsetMs + (t.offsets?.to ?? toMs),
              ...(t.p !== undefined ? { p: t.p } : {}),
            }));

    out.push({
      startMs: chunkOffsetMs + fromMs,
      endMs: chunkOffsetMs + toMs,
      text,
      confidence,
      noSpeechProb,
      words: words !== null && words.length > 0 ? words : null,
      chunkIdx: chunkIndex,
      flags,
      speakerLabel: null,
    });
  }

  return out;
}
