/**
 * Post-install self-test — a REAL inference run, not a file-existence check.
 *
 * ADR-003 decision 3 (copying the one good idea from memo.ac): after installing a
 * backend, transcribe a short embedded clip, measure the real-time factor, and show the
 * user an honest number for THEIR machine.
 *
 * ADR-004 decision 3 makes this project policy: we would rather display "not measured"
 * than a number we did not measure.
 *
 * MEASURED REFERENCE (T-012 Linux box, AMD Ryzen AI MAX+ 395, 8 threads, 11.0 s of
 * 16 kHz mono audio, whisper.cpp v1.9.1 CPU backend auto-selected as zen4):
 *     ggml-tiny.en   wall 0.295–0.323 s   RTF 0.027–0.029   ≈ 35x real time
 *     ggml-base.en   wall 0.439–0.450 s   RTF 0.040         ≈ 25x real time
 * Forcing the worst-case sse42 fallback on the same box: 1.03–1.14 s, ≈ 10x. The 3.4x
 * spread between best and worst CPU variant is why GGML_CPU_ALL_VARIANTS is mandatory.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { CHILD_KILL_SIGNAL, libraryPathEnv } from './childEnv.js';
import type { SelfTestOutcome } from './types.js';

/** Generous: a first run on a cold cache with a large model on a slow CPU is slow. */
export const SELF_TEST_TIMEOUT_MS = 180_000;

export interface SelfTestOptions {
  /** Path to `whisper-cli` inside the runtime directory. */
  whisperCliPath: string;
  /** Path to the ggml model to test with — use the smallest installed one. */
  modelPath: string;
  /** Path to the bundled test clip. */
  audioPath: string;
  /** Exact duration of the clip, in seconds. RTF is meaningless without it. */
  audioDurationSeconds: number;
  /** Lowercased reference transcript, for the garbage-output check. */
  expectedTranscript: string;
  threads?: number;
  timeoutMs?: number;
}

/**
 * A backend can "succeed" and still produce garbage — a half-broken GPU kernel returns
 * NaNs and whisper happily emits repeated tokens with exit code 0. Comparing against a
 * known transcript is what turns "it ran" into "it worked".
 */
export function transcriptSimilarity(actual: string, expected: string): number {
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const a = norm(actual);
  const b = norm(expected);
  if (b.length === 0) return a.length === 0 ? 1 : 0;

  // Token-level recall against the reference. Tolerant of punctuation and casing drift
  // between model sizes, but collapses to ~0 for repetition loops and empty output.
  const bag = new Map<string, number>();
  for (const w of a) bag.set(w, (bag.get(w) ?? 0) + 1);

  let hits = 0;
  for (const w of b) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      hits += 1;
      bag.set(w, n - 1);
    }
  }
  return hits / b.length;
}

/** Below this, we treat the run as failed even if the process exited 0. */
export const SIMILARITY_THRESHOLD = 0.6;

export async function runSelfTest(options: SelfTestOptions): Promise<SelfTestOutcome> {
  const {
    whisperCliPath,
    modelPath,
    audioPath,
    audioDurationSeconds,
    expectedTranscript,
    threads = Math.min(8, Math.max(1, (await import('node:os')).cpus().length)),
    timeoutMs = SELF_TEST_TIMEOUT_MS,
  } = options;

  const ranAt = new Date().toISOString();

  for (const [label, p] of [
    ['whisper-cli', whisperCliPath],
    ['model', modelPath],
    ['test audio', audioPath],
  ] as const) {
    if (!existsSync(p)) {
      return fail(ranAt, `${label} not found: ${p}`);
    }
  }
  if (!(audioDurationSeconds > 0)) {
    return fail(ranAt, 'audioDurationSeconds must be > 0 for RTF to mean anything');
  }

  const startedAt = Date.now();

  return new Promise<SelfTestOutcome>((resolve) => {
    execFile(
      whisperCliPath,
      ['-m', modelPath, '-f', audioPath, '-t', String(threads), '-nt'],
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        killSignal: CHILD_KILL_SIGNAL,
        windowsHide: true,
        /*
         * Resolve the co-located ggml backends **without throwing away what the user
         * already had**. This used to be `LD_LIBRARY_PATH: dirOf(whisperCliPath)` — a
         * plain overwrite. On a machine that sets LD_LIBRARY_PATH itself (conda, nix,
         * HPC modules) that silently drops every other search path, so the self-test
         * and the real transcribe path resolve libraries differently — and the
         * self-test is exactly the thing that is supposed to predict the real path.
         */
        env: { ...process.env, ...libraryPathEnv(process.env, dirOf(whisperCliPath)) },
      },
      (error, stdout, stderr) => {
        const wallSeconds = (Date.now() - startedAt) / 1000;

        const backendUsed = parseBackendUsed(stderr);
        const devicesFound = (stderr.match(/whisper_backend_init_gpu: device \d+:/g) ?? []).length;

        if (error) {
          const signal = (error as NodeJS.ErrnoException & { signal?: string }).signal ?? null;
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          return resolve(
            fail(
              ranAt,
              killed
                ? `self-test timed out after ${timeoutMs}ms`
                : `whisper-cli failed (${signal ?? error.message})`,
              { backendUsed, devicesFound },
            ),
          );
        }

        const similarity = transcriptSimilarity(stdout, expectedTranscript);
        const rtf = wallSeconds / audioDurationSeconds;

        if (similarity < SIMILARITY_THRESHOLD) {
          return resolve(
            fail(
              ranAt,
              `transcript did not match the reference (similarity ${similarity.toFixed(2)} < ` +
                `${SIMILARITY_THRESHOLD}). The backend ran but produced wrong output — this is ` +
                `the signature of a broken GPU kernel.`,
              { backendUsed, devicesFound, rtf, similarity },
            ),
          );
        }

        resolve({
          passed: true,
          ranAt,
          devicesFound,
          rtf,
          speedup: rtf > 0 ? 1 / rtf : null,
          backendUsed,
          transcriptSimilarity: similarity,
          errorMessage: null,
        });
      },
    );
  });
}

function fail(
  ranAt: string,
  errorMessage: string,
  extra: {
    backendUsed?: string | null;
    devicesFound?: number;
    rtf?: number;
    similarity?: number;
  } = {},
): SelfTestOutcome {
  return {
    passed: false,
    ranAt,
    devicesFound: extra.devicesFound ?? 0,
    rtf: extra.rtf ?? null,
    speedup: extra.rtf !== undefined && extra.rtf > 0 ? 1 / extra.rtf : null,
    backendUsed: extra.backendUsed ?? null,
    transcriptSimilarity: extra.similarity ?? null,
    errorMessage,
  };
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}

/**
 * Which backend did the compute ACTUALLY run on?
 *
 * BUG THIS FIXES (caught by running the real thing on the T-012 box): the obvious
 * implementation greps the first `load_backend: loaded <X> backend from ...` line. That
 * is wrong. ggml loads every backend it finds, in its own order, before deciding which
 * to use. With a Vulkan pack installed on a GPU-less machine the log reads:
 *
 *     ggml_vulkan: No devices found.
 *     load_backend: loaded Vulkan backend from .../libggml-vulkan.so
 *     load_backend: loaded CPU backend from .../libggml-cpu-zen4.so
 *     whisper_backend_init_gpu: no GPU found
 *
 * The naive regex reported "Vulkan" for a run that was 100% CPU — exactly the kind of
 * confidently-wrong number ADR-004 decision 3 forbids. `load_backend` lines mean
 * "loaded", never "used".
 *
 * whisper.cpp's `whisper_backend_init_gpu` lines are the authoritative signal.
 */
export function parseBackendUsed(stderr: string): string | null {
  // Explicit and unambiguous: whisper fell back to CPU.
  if (/whisper_backend_init_gpu:\s*no GPU found/.test(stderr)) return 'CPU';

  // Otherwise whisper names the GPU device it selected.
  const selected = /whisper_backend_init_gpu:\s*using\s+(\S+)/i.exec(stderr)?.[1];
  if (selected !== undefined) return selected;

  // A non-CPU device line (type != 0) means an accelerator was chosen.
  // UNVERIFIED shape — no GPU machine was available to confirm the exact wording.
  const deviceLine = /whisper_backend_init_gpu: device \d+:\s*(.+?)\s*\(type:\s*(\d+)\)/.exec(stderr);
  if (deviceLine !== null && deviceLine[2] !== '0') return deviceLine[1] ?? null;

  // Last resort: the CPU variant ggml settled on, e.g. "ggml-cpu-zen4".
  const cpuVariant = /load_backend: loaded CPU backend from .*?(ggml-cpu-[a-z0-9]+)/i.exec(stderr)?.[1];
  if (cpuVariant !== undefined) return `CPU (${cpuVariant})`;

  return null;
}

/** Human-facing summary. Never invents a number it does not have. */
export function formatSelfTest(outcome: SelfTestOutcome, audioSeconds: number): string {
  if (!outcome.passed) return `Self-test failed: ${outcome.errorMessage ?? 'unknown error'}`;
  if (outcome.rtf === null || outcome.speedup === null) return 'Self-test passed (speed not measured)';
  const wall = (outcome.rtf * audioSeconds).toFixed(2);
  return (
    `Self-test passed on ${outcome.backendUsed ?? 'unknown'} backend: ` +
    `${audioSeconds.toFixed(1)}s of audio in ${wall}s — about ${outcome.speedup.toFixed(0)}x real time`
  );
}

/** Projected wall-clock for a longer recording. Only ever called with a measured RTF. */
export function estimateDuration(rtf: number, mediaSeconds: number): number {
  return rtf * mediaSeconds;
}
