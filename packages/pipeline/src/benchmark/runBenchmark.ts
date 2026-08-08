/**
 * In-product benchmark. ADR-004 decision 3 — the endpoint behind `POST /models/benchmark`.
 *
 * The whole point: the user clicks once and gets a real number measured on THEIR machine
 * with THEIR backend. That is more useful than any figure from a paper, and it is the
 * only kind of number this project is willing to display.
 *
 * The result maps exactly onto `BenchmarkResult` in @openmemo/shared:
 *     { rtf, measuredAt, backend, deviceName, sampleDurationSec }
 * Note what is NOT in there: accuracy. We measure speed because speed is measurable in
 * five seconds on a clip we ship; measuring accuracy would need reference transcripts
 * per language and is not something to fake with a WER number copied from a README.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Backend } from '@openmemo/shared';

import { buildArgv } from '../subprocess/argGuard.js';
import { runOrThrow } from '../subprocess/runner.js';
import type { AsrEngine } from '../asr/types.js';
import type { ToolPaths } from '../tools.js';
import type { BenchmarkClip } from './clips.js';
import { clipForLanguage } from './clips.js';

/** Mirrors `BenchmarkResult` from @openmemo/shared. */
export interface BenchmarkOutcome {
  rtf: number;
  measuredAt: string;
  backend: Backend;
  deviceName: string;
  sampleDurationSec: number;
}

export interface BenchmarkReport extends BenchmarkOutcome {
  engineId: string;
  modelPath: string;
  clipId: string;
  clipLicense: string;
  /** Wall-clock seconds for the transcription itself. */
  wallSeconds: number;
  /** What the engine produced — lets the caller sanity-check rather than trust blindly. */
  transcript: string;
  /** 1 / rtf, precomputed because it is what the UI displays. */
  speedup: number;
  /** Runs performed; the reported rtf is the best of these. */
  runs: number;
  /** Per-run RTF, so an unstable machine is visible instead of averaged away. */
  rtfPerRun: number[];
}

export interface RunBenchmarkOptions {
  engine: AsrEngine;
  modelPath: string;
  tools: ToolPaths;
  /** Backend the engine is actually using, from @openmemo/runtime's probe. */
  backend: Backend;
  /** Human-readable device, e.g. "AMD Ryzen AI MAX+ 395" or "NVIDIA RTX 4070". */
  deviceName: string;
  language?: string;
  threads?: number;
  /**
   * Repeat count. Default 2: the first run pays model load and page-cache misses, so a
   * single run systematically understates the machine. We report the BEST run, which is
   * the closest thing to "what this machine can do" — and we also return every run so
   * the spread is visible.
   */
  runs?: number;
  signal?: AbortSignal;
  /** Override the clip (tests). */
  clip?: BenchmarkClip;
  /**
   * Scratch directory root. **Pass the managed temp dir (`<dataDir>/tmp`).**
   *
   * 用户要求"数据存放是独立文件夹、删除不影响程序本体"。默认落在 OS 临时目录会让
   * 产物散到 dataDir 外面 —— 删了数据目录也清不掉，且在只读 /tmp 的环境里直接失败。
   * 只有在调用方确实不知道 dataDir 时（独立 CLI）才退回 OS 临时目录。
   */
  workRoot?: string;
}

/**
 * Decode an embedded Opus clip to the 16 kHz mono WAV every engine expects.
 *
 * ffmpeg reads from a file, not stdin, so the base64 is written out first — into a
 * managed temp dir with a name we generate (D-01 §8.5: user input never names a file).
 */
export async function decodeClip(
  tools: ToolPaths,
  clip: BenchmarkClip,
  destDir: string,
): Promise<string> {
  const opusPath = join(destDir, `bench-${clip.id}.opus`);
  const wavPath = join(destDir, `bench-${clip.id}.wav`);

  await writeFile(opusPath, Buffer.from(clip.opusBase64, 'base64'));

  const argv = buildArgv({
    flags: [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      // Local decode only; no network protocol has any business here.
      '-protocol_whitelist',
      'file',
      '-i',
      opusPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      wavPath,
    ],
    operands: [],
    useDoubleDash: false,
  });
  if (!argv.ok) throw new Error(`benchmark decode rejected: ${argv.message}`);

  await runOrThrow({ bin: tools.ffmpeg, argv: argv.value, cwd: destDir, timeoutMs: 30_000 });
  return wavPath;
}

/**
 * Measure real-time factor on the user's machine.
 *
 * Works through the `AsrEngine` interface, so it measures whisper, Paraformer or any
 * engine added later without modification — the same adapter boundary that keeps engine
 * internals out of business code also makes them uniformly measurable.
 */
export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkReport> {
  const {
    engine,
    modelPath,
    tools,
    backend,
    deviceName,
    language,
    threads,
    runs = 2,
    signal,
    clip: clipOverride,
    workRoot,
  } = options;

  const availability = await engine.isAvailable();
  if (!availability.ok) {
    throw new Error(`cannot benchmark: ${availability.reason}`);
  }

  const clip = clipOverride ?? clipForLanguage(language);
  const root = workRoot ?? tmpdir();
  await mkdir(root, { recursive: true }).catch(() => undefined);
  const workDir = await mkdtemp(join(root, 'openmemo-bench-'));

  try {
    const wavPath = await decodeClip(tools, clip, workDir);

    const rtfPerRun: number[] = [];
    let transcript = '';

    for (let i = 0; i < Math.max(1, runs); i++) {
      signal?.throwIfAborted();
      const startedAt = Date.now();
      const segments = await engine.transcribeChunk({
        audioPath: wavPath,
        chunkIndex: 0,
        offsetMs: 0,
        durationMs: Math.round(clip.durationSec * 1000),
        modelPath,
        language: language ?? clip.language,
        threads,
        signal: signal ?? new AbortController().signal,
      });
      const wall = (Date.now() - startedAt) / 1000;
      rtfPerRun.push(wall / clip.durationSec);
      transcript = segments
        .map((s) => s.text)
        .join(' ')
        .trim();
    }

    // Best run: the first is polluted by model load and cold cache. Reporting the mean
    // would bake a one-off startup cost into a steady-state figure.
    const rtf = Math.min(...rtfPerRun);

    return {
      rtf,
      measuredAt: new Date().toISOString(),
      backend,
      deviceName,
      sampleDurationSec: clip.durationSec,
      engineId: engine.id,
      modelPath,
      clipId: clip.id,
      clipLicense: clip.license,
      wallSeconds: rtf * clip.durationSec,
      transcript,
      speedup: rtf > 0 ? 1 / rtf : 0,
      runs: rtfPerRun.length,
      rtfPerRun,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Strip the report down to the shared `BenchmarkResult` shape for persistence. */
export function toBenchmarkResult(report: BenchmarkReport): BenchmarkOutcome {
  return {
    rtf: report.rtf,
    measuredAt: report.measuredAt,
    backend: report.backend,
    deviceName: report.deviceName,
    sampleDurationSec: report.sampleDurationSec,
  };
}

/**
 * Human-readable summary.
 *
 * Reports the projected time for an hour of audio, because "RTF 0.012" means nothing to
 * a user while "43 seconds per hour of recording" is immediately actionable. The
 * projection is linear extrapolation of a measured number, not a new claim.
 */
export function formatBenchmark(report: BenchmarkReport): string {
  const perHourSec = report.rtf * 3600;
  const perHour =
    perHourSec < 90 ? `${perHourSec.toFixed(0)} 秒` : `${(perHourSec / 60).toFixed(1)} 分钟`;
  return (
    `${report.engineId} @ ${report.backend}：${report.speedup.toFixed(0)} 倍速` +
    `（1 小时录音约需 ${perHour}）`
  );
}
