/**
 * Probe subprocess runner — watchdogged, crash-isolated, circuit-broken.
 *
 * ADR-003 decision 3: "probe runs in a separate subprocess + 10s timeout + failure
 * circuit breaker". This file is that requirement.
 *
 * WHY A SUBPROCESS IS NOT OPTIONAL — measured on the T-012 Linux box:
 *   With every libggml-cpu-*.so removed, whisper.cpp does not return an error. It calls
 *   ggml_abort() inside ggml_backend_dev_backend_reg() and the process dies of SIGABRT
 *   (exit 134, with a gdb backtrace dumped to stderr). GPU driver faults are worse.
 *   Loading ggml in-process would make a broken backend pack fatal to the daemon.
 *
 * WHY A TIMEOUT IS NOT OPTIONAL:
 *   Ollama documents that an out-of-date ROCm kernel driver makes GPU initialisation
 *   "hang during device discovery and eventually time out". A hung probe must never
 *   become a hung daemon.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { CHILD_KILL_SIGNAL, libraryPathEnv } from '../childEnv.js';
import type { ProbeFailureKind, ProbeOutput, ProbeResult } from '../types.js';
import { isProbeOutput } from '../types.js';

/** ADR-003 decision 3 fixes this at 10 seconds. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Consecutive failures after which a backend is blacklisted until explicitly retried. */
export const CIRCUIT_BREAKER_THRESHOLD = 2;

export interface RunProbeOptions {
  /** Path to the `openmemo-probe` executable. */
  probePath: string;
  /** Directory of ggml backend shared libraries to scan. */
  backendDir: string;
  timeoutMs?: number;
  /** Extra environment for the child (e.g. GGML_VK_VISIBLE_DEVICES). */
  env?: Record<string, string>;
}

/**
 * Spawns the probe and parses its JSON. Never throws and never rejects — a probe
 * failure is an expected, routine outcome that the degradation chain consumes as data.
 */
export async function runProbe(options: RunProbeOptions): Promise<ProbeResult> {
  const { probePath, backendDir, timeoutMs = PROBE_TIMEOUT_MS } = options;
  const startedAt = Date.now();

  if (!existsSync(probePath)) {
    return failure(`probe executable not found: ${probePath}`, 'missing_probe', startedAt);
  }
  if (!existsSync(backendDir)) {
    return failure(`backend directory not found: ${backendDir}`, 'missing_backend_dir', startedAt);
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const child = execFile(
      probePath,
      [backendDir],
      {
        timeout: timeoutMs,
        // The probe prints one small JSON object; anything larger means something is wrong.
        maxBuffer: 4 * 1024 * 1024,
        killSignal: CHILD_KILL_SIGNAL,
        windowsHide: true,
        env: {
          ...process.env,
          // Resolve co-located ggml libraries without polluting the daemon's own env.
          ...libraryPathEnv(process.env, backendDir),
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;

        if (error) {
          // execFile sets `killed` when the timeout fired.
          const err = error as Error & {
            killed?: boolean;
            signal?: string | null;
            // Node types this as `string` on Error, but execFile sets the numeric
            // child exit status here — hence the widened annotation.
            code?: string | number | null;
          };
          const killed = err.killed === true;
          const signal = err.signal ?? null;
          const code: string | number | null = err.code ?? null;

          if (killed || signal === 'SIGKILL') {
            return done(
              failure(
                `probe timed out after ${timeoutMs}ms (killed). This usually means a GPU driver ` +
                  `hung during device discovery.`,
                'timeout',
                startedAt,
                { stderr: tail(stderr), durationMs },
              ),
            );
          }

          // SIGABRT / SIGSEGV: the exact class of fault that would have killed the daemon.
          if (signal === 'SIGABRT' || signal === 'SIGSEGV' || code === 134 || code === 139) {
            return done(
              failure(
                `probe crashed (${signal ?? `exit ${String(code)}`}). The backend directory is ` +
                  `incomplete or the driver faulted.`,
                'crash',
                startedAt,
                { stderr: tail(stderr), durationMs },
              ),
            );
          }

          return done(
            failure(`probe failed: ${error.message}`, 'exec_error', startedAt, {
              stderr: tail(stderr),
              durationMs,
            }),
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return done(
            failure('probe produced unparseable output', 'bad_output', startedAt, {
              stderr: tail(stderr),
              durationMs,
            }),
          );
        }

        if (!isProbeOutput(parsed)) {
          return done(
            failure('probe output failed schema validation', 'bad_output', startedAt, {
              stderr: tail(stderr),
              durationMs,
            }),
          );
        }

        done({
          ok: true,
          output: parsed satisfies ProbeOutput,
          durationMs,
          // ggml logs backend load/skip decisions here; keep it for the UI's "why" panel.
          stderr: tail(stderr),
        });
      },
    );

    child.on('error', (err) => {
      done(
        failure(`could not spawn probe: ${err.message}`, 'exec_error', startedAt, {
          durationMs: Date.now() - startedAt,
        }),
      );
    });
  });
}

function failure(
  message: string,
  kind: ProbeFailureKind,
  startedAt: number,
  extra: { stderr?: string; durationMs?: number } = {},
): ProbeResult {
  return {
    ok: false,
    kind,
    message,
    stderr: extra.stderr ?? '',
    durationMs: extra.durationMs ?? Date.now() - startedAt,
  };
}

/** Keep the last N characters of a stream; ggml's backtrace dumps can be long. */
function tail(s: string | undefined, max = 4000): string {
  if (!s) return '';
  return s.length <= max ? s : `…${s.slice(s.length - max)}`;
}

/**
 * Circuit breaker.
 *
 * Without this, a machine whose CUDA driver hangs pays the full 10s probe timeout on
 * every single daemon start. After two consecutive failures a backend is parked until
 * the user explicitly re-tests or the driver version changes.
 */
export interface BreakerState {
  consecutiveFailures: number;
  blacklistedAt: string | null;
  lastError: string | null;
  /** Re-probing is allowed again when this changes (driver upgrade invalidates the verdict). */
  driverFingerprint: string | null;
}

export function emptyBreaker(): BreakerState {
  return {
    consecutiveFailures: 0,
    blacklistedAt: null,
    lastError: null,
    driverFingerprint: null,
  };
}

export function recordProbeOutcome(
  state: BreakerState,
  result: ProbeResult,
  driverFingerprint: string | null,
): BreakerState {
  if (result.ok) {
    return { ...emptyBreaker(), driverFingerprint };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    blacklistedAt:
      consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD
        ? (state.blacklistedAt ?? new Date().toISOString())
        : null,
    lastError: result.message,
    driverFingerprint,
  };
}

export function isBlacklisted(state: BreakerState, currentDriverFingerprint: string | null): boolean {
  if (state.blacklistedAt === null) return false;
  // A driver change is new evidence: clear the verdict and let it prove itself again.
  if (state.driverFingerprint !== currentDriverFingerprint) return false;
  return true;
}
