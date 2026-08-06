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
  /**
   * Sent as the LONG form `--vad-min-speech-duration-ms`. Neither short flag is safe.
   *
   * Upstream `speech.cpp` disagrees with itself about the two duration knobs:
   *
   * ```
   * :37  usage says   -vspd  = min SPEECH duration      ← parser has NO branch for -vspd
   * :38  usage says   -vsd   = min SILENCE duration
   * :67  parser says  -vsd | --vad-min-speech-duration-ms   → vad_min_speech_duration_ms
   * :68  parser says  -vsd | --vad-min-silence-duration-ms  → vad_min_speech_duration_ms (!)
   * ```
   *
   * Two consequences, both measured on the upstream v1.9.1 binary CI installs:
   *
   * 1. `-vspd 250` → `error: unknown argument` then **`exit(0)` with empty stdout**.
   *    Downstream that reads as "VAD ran and found no speech" → zero chunks → an EMPTY
   *    TRANSCRIPT under a green job. We shipped `-vspd` until T-148; the only reason it
   *    never fired is that nothing ever set this option.
   * 2. `-vsd` currently means min-SPEECH (line 67 wins) while the usage text says it
   *    means min-SILENCE. Whichever way upstream reconciles that, the short flag can
   *    change meaning — and it would do so **silently**, since both values are plausible
   *    integers. The long form is unambiguous under the current code AND under the
   *    obvious fix, so it is the only spelling that cannot flip under us.
   *
   * `[本机实测]` all four long forms accepted by the pinned binary (result header present,
   * no `unknown argument`).
   */
  minSpeechDurationMs?: number;
  /*
   * ⚠️ There is deliberately no `minSilenceDurationMs`.
   *
   * Both branches at `speech.cpp:67-68` assign to `vad_min_speech_duration_ms`, so
   * `--vad-min-silence-duration-ms` sets the WRONG knob and `min_silence_duration_ms` is
   * unreachable from the command line entirely. A field that silently does nothing — or
   * worse, moves a different knob — is worse than no field.
   */
  maxSpeechDurationSec?: number;
  speechPadMs?: number;
  threads?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Build the argv flags for `whisper-vad-speech-segments`.
 *
 * Exported so the two properties below are testable without a binary, a model file or a
 * subprocess — the whole point of T-148 is that those properties were unobservable.
 *
 * ★ `-np` is deliberately NOT passed. T-148.
 *
 * It used to be here with the comment "machine-readable: suppress everything except the
 * results". That comment described something that is not true: the segment list goes to
 * STDOUT via printf (`speech.cpp:136-143`) and `parseVadOutput` only ever reads stdout,
 * while `-np` calls `whisper_log_set(cb_log_disable)` (`speech.cpp:95-97`) which only
 * silences the DIAGNOSTIC channel. So it bought us nothing and cost us this:
 *
 * whisper.cpp has five distinct ways to fail to load a VAD model — file will not
 * open, bad magic, unknown tensor, wrong tensor shape, backend init — and every one
 * of them logs its real reason through `WHISPER_LOG_ERROR` and then returns nullptr.
 * The example turns all five into one sentence on stderr:
 * `error: failed to initialize whisper context`, exit 2.
 *
 * `[本机实测]` with the same upstream binary CI uses: empty `-vm`, a nonexistent path
 * and an ONNX file produce BYTE-IDENTICAL output under `-np`. That is why a real
 * product bug survived until someone ran a transcription on a clean machine.
 *
 * Keeping the log on costs a few dozen stderr lines that nobody reads on success
 * (`runOrThrow` discards stderr when the exit code is 0) and gives the failure path its
 * reason back — which is the trade this repo has got wrong most expensively.
 * Same family as `--no-prints` hiding the CoreML fallback (T-146 §3.2).
 */
export function buildVadFlags(
  vadModel: string,
  wavPath: string,
  opts: VadOptions = {},
): string[] {
  const flags = [
    '-f', wavPath,
    '-vm', vadModel,
    '-t', String(opts.threads ?? 4),
  ];
  /*
   * Tuning knobs go out in LONG form. The short aliases are where upstream's usage text
   * and its parser contradict each other (see `minSpeechDurationMs`), and a short flag
   * that changes meaning is indistinguishable from one that does not — both take an
   * integer and both exit 0.
   */
  if (opts.threshold !== undefined) flags.push('--vad-threshold', String(opts.threshold));
  if (opts.minSpeechDurationMs !== undefined) {
    flags.push('--vad-min-speech-duration-ms', String(opts.minSpeechDurationMs));
  }
  if (opts.maxSpeechDurationSec !== undefined) {
    flags.push('--vad-max-speech-duration-s', String(opts.maxSpeechDurationSec));
  }
  if (opts.speechPadMs !== undefined) flags.push('--vad-speech-pad-ms', String(opts.speechPadMs));
  return flags;
}

/**
 * Turn one finished VAD run into segments — **or refuse to pretend it answered**.
 *
 * ★ "exit 0" is NOT proof that the VAD ran. T-148.
 *
 * `vad_params_parse` responds to any argument it does not recognise with
 * `vad_print_usage(); exit(0);` (`speech.cpp:73-77`) — **zero exit code, empty stdout**.
 * `parseVadOutput` then returns `[]`, which the caller cannot distinguish from a
 * legitimate "this file contains no speech", and the pipeline goes on to produce an EMPTY
 * TRANSCRIPT under a green job. `[本机实测]` on the upstream v1.9.1 binary: `-vspd 250`
 * (a flag the example's own `--help` advertises but its parser does not implement) does
 * exactly this.
 *
 * So require the header the example always prints on the success path
 * (`printf("Detected %d speech segments:\n", …)`, `speech.cpp:137`). Zero segments WITH
 * the header is a real answer; no header means it never got that far.
 *
 * This pins the CONSEQUENCE — "did we get an answer" — instead of enumerating arguments,
 * so it keeps working when upstream renames a flag.
 */
export function interpretVadRun(run: {
  stdout: string;
  stderr: string;
  code: number | null;
}): SpeechSegment[] {
  if (!/Detected\s+\d+\s+speech segments/i.test(run.stdout)) {
    throw new Error(
      `VAD produced no result header — it exited ${String(run.code)} without answering. ` +
        `stdout=${JSON.stringify(run.stdout.slice(0, 200))} stderr=${run.stderr.slice(-500)}`,
    );
  }
  return parseVadOutput(run.stdout);
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
  /*
   * `!tools.vadModel`, not `=== null`. An EMPTY STRING is not "installed" either, and it
   * is the exact value a `??` chain produces when an upstream default is `''`. Letting it
   * through means spawning `-vm ""`, which whisper reports as the same one-line
   * `failed to initialize whisper context` as every other load failure — `[本机实测]`
   * empty path, missing path and wrong-format file are byte-identical there.
   */
  if (tools.whisperVad === null || !tools.vadModel) {
    throw new Error('VAD component or model is not installed');
  }

  const argv = buildArgv({
    flags: buildVadFlags(tools.vadModel, wavPath, opts),
    operands: [],
    useDoubleDash: false,
  });
  if (!argv.ok) throw new Error(`VAD argument rejected: ${argv.message}`);

  const result = await runOrThrow({
    bin: tools.whisperVad,
    argv: argv.value,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    signal: opts.signal,
  });

  // The header check lives inside `interpretVadRun` on purpose: a caller cannot get the
  // segments without also getting the "did it actually answer" check.
  return interpretVadRun(result);
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

// =========================================================================================
// The VAD step of the pipeline, as one function
// =========================================================================================

export interface ChunkPlan {
  chunks: AsrChunk[];
  speechMs: number;
  /** Which planner actually ran. `'fixed'` is the degraded path. */
  chunking: 'vad' | 'fixed';
  /** Non-fatal problems worth showing a human. Empty on the happy path. */
  warningsZh: string[];
}

export interface PlanAudioChunksArgs {
  tools: ToolPaths;
  /**
   * The VAD runner. Injected rather than imported so the failure branch is testable
   * WITHOUT a whisper binary, a model file, or a subprocess — the branch that was missing
   * until T-148 is precisely the one that is expensive to reach through the real thing.
   */
  detect: typeof detectSpeechSegments;
  wavPath: string;
  cwd: string;
  signal: AbortSignal;
  durationMs: number;
  threads?: number;
  targetChunkMs?: number;
  maxChunkMs?: number;
  onProgress?: (p: { step: 'vad'; fraction: number; message?: string }) => void;
}

/**
 * Decide how to cut the audio, and be honest about which way it got cut.
 *
 * ## Why the failure branch exists (T-148)
 *
 * The degradation used to cover only "VAD is not installed". It did NOT cover "VAD is
 * installed but will not run" — so a VAD model whisper.cpp could not load killed the
 * ENTIRE transcription instead of falling back. `[CI 实测]` run 31039460495: linux-x64 and
 * win32-x64 both died here with `whisper-vad-speech-segments exited with code 2`, and the
 * user got nothing.
 *
 * That made **installing VAD strictly worse than not installing it**, which is how the
 * bug survived: the demo machine had no VAD model, so it took the fallback and worked.
 *
 * ## Why falling back is not enough on its own
 *
 * Turning a loud failure into a quiet degradation is the move this repo most needs to
 * avoid. So the fallback is paired with `chunking` + `warningsZh` in the RESULT: the
 * caller is handed the fact and cannot fail to receive it. Producing a transcript while
 * silently using the worse splitter is its own kind of lie.
 */
export async function planAudioChunks(args: PlanAudioChunksArgs): Promise<ChunkPlan> {
  const { tools, detect, wavPath, cwd, signal, durationMs, targetChunkMs, maxChunkMs } = args;
  const warningsZh: string[] = [];
  args.onProgress?.({ step: 'vad', fraction: 0 });

  const fixed = (why: string): ChunkPlan => {
    // Degradation, not failure: fixed windows still produce a usable transcript.
    const chunks = planFixedChunks(durationMs, targetChunkMs ?? 30_000);
    args.onProgress?.({ step: 'vad', fraction: 1, message: `${String(chunks.length)} chunks · ${why}` });
    return { chunks, speechMs: durationMs, chunking: 'fixed', warningsZh };
  };

  if (tools.whisperVad === null || !tools.vadModel) {
    return fixed('VAD 未安装 → 固定窗口切分');
  }

  let segments: SpeechSegment[];
  try {
    segments = await detect(tools, wavPath, {
      cwd,
      signal,
      ...(args.threads === undefined ? {} : { threads: args.threads }),
    });
  } catch (err) {
    /*
     * Cancellation is NOT a degradation — an aborted job must stay aborted, otherwise
     * "stop" silently turns into "carry on with worse settings".
     */
    if (signal.aborted) throw err;
    const why = err instanceof Error ? err.message : String(err);
    warningsZh.push(
      `VAD 未能运行，本次已退回固定窗口切分（断句会变差，转写内容仍完整）：${firstLine(why)}`,
    );
    return fixed('VAD 运行失败 → 固定窗口切分');
  }

  const speechMs = totalSpeechMs(segments);
  const chunks =
    segments.length > 0
      ? planChunks(segments, {
          totalDurationMs: durationMs,
          ...(targetChunkMs === undefined ? {} : { targetChunkMs }),
          ...(maxChunkMs === undefined ? {} : { maxChunkMs }),
        })
      : // VAD ran and found no speech. Do not silently transcribe silence — whisper
        // hallucinates on it. Zero chunks is the honest answer.
        [];

  args.onProgress?.({ step: 'vad', fraction: 1, message: `${String(chunks.length)} chunks` });
  return { chunks, speechMs, chunking: 'vad', warningsZh };
}

/**
 * First non-empty line, trimmed and length-capped.
 *
 * A VAD failure message carries up to 2000 bytes of captured stderr — invaluable in the
 * job error and the logs, far too long for a UI banner. Keep the headline for humans.
 */
function firstLine(message: string, max = 200): string {
  const line = message.split('\n').find((l) => l.trim().length > 0)?.trim() ?? message.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
