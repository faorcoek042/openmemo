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
      // Full JSON: the only mode that emits per-token probabilities (measured on
      // v1.9.1 it does NOT emit avg_logprob/no_speech_prob — see parseWhisperJson).
      '--output-json-full',
      '--output-file', outputBase,
      // Keep stdout clean; we read the JSON file, not the console.
      '--no-prints',
    ];

    /*
     * Language MUST always be passed.
     *
     * whisper-cli's default is `-l en` (see `--help`: "[en] spoken language"), and when
     * it is told the audio is English but hears Mandarin it does not transcribe — it
     * TRANSLATES. Measured on Chinese audio with no `-l` flag:
     *     "The main point is to talk about the three questions. First of all, …"
     * instead of 重点呢想谈三个问题…. For a Chinese-first product, a user who never opened
     * the language setting would silently get English translations of their own notes.
     *
     * So an unset language becomes `auto` (whisper's own detection), never the default.
     */
    const language =
      req.language !== undefined && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/.test(req.language)
        ? req.language
        : 'auto';
    flags.push('-l', language);

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
      /*
       * baseOffsetMs is 0 — NOT req.offsetMs.
       *
       * MEASURED on whisper.cpp v1.9.1: when `--offset-t` is used, the offsets in the
       * JSON are already ABSOLUTE to the source file, not relative to the requested
       * window. Verified directly:
       *     whisper-cli --offset-t 60000 --duration 20000 …
       *     -> first segment reports offsets.from = 60000
       * Adding req.offsetMs on top double-counted, which is how a 220 s recording ended
       * up with segments at 419 s. Caught by the multi-chunk end-to-end run in D-06 §6.
       */
      return parseWhisperJson(raw, req.chunkIndex, {
        baseOffsetMs: 0,
        windowStartMs: req.offsetMs,
        windowEndMs: req.offsetMs + req.durationMs,
      });
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

export interface ParseWhisperOptions {
  /**
   * Milliseconds to ADD to every reported offset.
   *
   * For whisper.cpp driven with `--offset-t` this MUST be 0: measured on v1.9.1, its
   * reported offsets are already absolute to the source file. The parameter exists for
   * engines (or future versions) that report chunk-relative times.
   */
  baseOffsetMs?: number;
  /** Drop segments falling wholly outside the requested window. */
  windowStartMs?: number;
  windowEndMs?: number;
}

/**
 * Map whisper.cpp's `--output-json-full` output onto our TranscriptSegment.
 *
 * Two behaviours here come from observing the real binary rather than from its docs:
 *   1. offsets are absolute (see ParseWhisperOptions.baseOffsetMs);
 *   2. whisper decodes in 30 s windows and will happily emit a segment that runs past
 *      the `--duration` we asked for, so segments outside the window are dropped —
 *      otherwise adjacent chunks both claim the same speech.
 */
export function parseWhisperJson(
  raw: string,
  chunkIndex: number,
  opts: ParseWhisperOptions = {},
): TranscriptSegment[] {
  const { baseOffsetMs = 0, windowStartMs, windowEndMs } = opts;
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

    const fromMs = baseOffsetMs + (seg.offsets?.from ?? 0);
    const toMs = baseOffsetMs + (seg.offsets?.to ?? (seg.offsets?.from ?? 0));

    // Outside the window we asked for: whisper over-ran into the next chunk's territory.
    if (windowEndMs !== undefined && fromMs >= windowEndMs) continue;
    if (windowStartMs !== undefined && toMs <= windowStartMs) continue;

    /*
     * Confidence.
     *
     * MEASURED against whisper.cpp v1.9.1: `--output-json-full` does NOT emit
     * `avg_logprob` or `no_speech_prob` at the segment level. The real segment keys are
     * exactly ['timestamps', 'offsets', 'text', 'tokens']. Only the per-token `p`
     * probability is available.
     *
     * So we prefer avg_logprob when a build does provide it (older/newer versions and
     * other ggml front-ends do), and otherwise derive confidence as the mean token
     * probability over real tokens — special markers like [_BEG_] are excluded because
     * they are always near-certain and would inflate the score.
     */
    const realTokens = (seg.tokens ?? []).filter(
      (t) => typeof t.p === 'number' && !(t.text ?? '').startsWith('['),
    );
    const meanTokenProb =
      realTokens.length > 0
        ? realTokens.reduce((sum, t) => sum + (t.p ?? 0), 0) / realTokens.length
        : null;

    const confidence = logprobToConfidence(seg.avg_logprob ?? null) ?? meanTokenProb;
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
              s: baseOffsetMs + (t.offsets?.from ?? fromMs),
              e: baseOffsetMs + (t.offsets?.to ?? toMs),
              ...(t.p !== undefined ? { p: t.p } : {}),
            }));

    out.push({
      startMs: fromMs,
      endMs: toMs,
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
