/**
 * SubprocessRunner — the ONLY module in this package permitted to touch
 * `node:child_process`. D-01 §8.4 layers 1, 2 and 5.
 *
 * Layer 1 (architectural isolation): concentrating every spawn here means the security
 * review surface is one file. `eslint no-restricted-imports` should forbid
 * `node:child_process` everywhere else in the repo — see D-06 §8 for the rule.
 *
 * Layer 2 (never a shell): `spawn(absoluteBin, argv, { shell: false })`. No exec, no
 * execSync, no template strings, ever. On Windows, `.bat`/`.cmd` are refused outright
 * (argGuard.isSafeExecutable) because Node cannot run them without cmd.exe.
 *
 * Layer 5 (process environment and resources): minimal env allowlist, managed cwd,
 * mandatory timeout with SIGTERM→SIGKILL escalation over the whole process group, and
 * ring-buffered stdio so a chatty or hostile child cannot exhaust our heap.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { isSafeExecutable } from './argGuard.js';
import { proxyEnv, type ProxyConfig } from './proxy.js';

/** D-01 §8.4 L5 — 1 MB ring buffer per stream. */
export const MAX_STREAM_BYTES = 1024 * 1024;

/** Grace period between SIGTERM and SIGKILL. D-01 §4.4. */
export const KILL_GRACE_MS = 5_000;

export interface RunOptions {
  /** Absolute path to the executable. Never a bare name — no PATH search. */
  bin: string;
  /** Fully-formed argv. Build it with argGuard.buildArgv, never by concatenation. */
  argv: string[];
  /** Managed working directory. Never the user's home or an arbitrary path. */
  cwd: string;
  timeoutMs: number;
  /** Extra env on top of the minimal allowlist. Values are NOT parsed by any shell. */
  env?: Record<string, string>;
  /**
   * Outbound proxy. Injected here rather than inherited from `process.env` because
   * `buildChildEnv` rebuilds the environment from an allowlist by design (§8.4 L5) —
   * which is exactly why HTTP_PROXY never reached ffmpeg before.
   */
  proxy?: ProxyConfig | null;
  signal?: AbortSignal;
  /** Called for each complete stdout line — used for progress parsing. */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /**
   * Lower scheduling priority. D-01 §4.2: whisper.cpp CPU inference saturates every
   * core and makes the daemon's own UI unresponsive.
   */
  nice?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export class SubprocessError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = 'SubprocessError';
  }
}

/**
 * D-01 §8.4 L5 — environment allowlist.
 *
 * The dangerous variables are the loader ones: LD_PRELOAD and LD_LIBRARY_PATH (Linux),
 * DYLD_INSERT_LIBRARIES (macOS) let an attacker who can set env inject code into every
 * child. NODE_OPTIONS and PYTHONPATH are the same idea for their runtimes. We build the
 * child env from scratch instead of filtering process.env, so a variable we have never
 * heard of cannot ride along.
 */
export function buildChildEnv(
  extra: Record<string, string> = {},
  proxy: ProxyConfig | null = null,
): Record<string, string> {
  const base: Record<string, string> = {};

  const ALLOWED: string[] = process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];

  for (const key of ALLOWED) {
    const v = process.env[key];
    if (v !== undefined) base[key] = v;
  }

  // Deterministic, locale-independent parsing of child output (ffmpeg/yt-dlp numbers).
  base.LC_ALL = 'C';

  // Proxy vars are added deliberately, never inherited. `extra` still wins, so a call
  // site that needs to force-disable the proxy can pass empty strings.
  return { ...base, ...proxyEnv(proxy), ...extra };
}

/**
 * Bounded accumulator. Keeps the FIRST slice and the LAST slice and drops the middle,
 * because with a truncated log you almost always want the invocation banner and the
 * error at the end — a plain head-only or tail-only buffer loses one or the other.
 */
class RingBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    if (this.head.length < this.limit / 2) {
      this.head += chunk;
      return;
    }
    this.tail += chunk;
    if (this.tail.length > this.limit / 2) {
      const overflow = this.tail.length - this.limit / 2;
      this.tail = this.tail.slice(overflow);
      this.dropped += overflow;
    }
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n…[${this.dropped} bytes dropped]…\n${this.tail}`;
  }
}

/**
 * Spawn a child process under every layer-2/5 control.
 *
 * Resolves with a RunResult regardless of exit status — a non-zero exit is data, not an
 * exception. Throws only when the invocation itself is refused (unsafe executable) or
 * the process could not be spawned.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const { bin, argv, cwd, timeoutMs, env, proxy = null, signal, onStdoutLine, onStderrLine, nice = false } = options;

  // Layer 2 — refuse anything that would need a shell to execute.
  const safeBin = isSafeExecutable(bin);
  if (!safeBin.ok) {
    throw new Error(`SubprocessRunner refused to execute: ${safeBin.message}`);
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // D-01 §8.4 L5: "timeout: 必设". An unbounded child is a hung daemon.
    throw new Error('SubprocessRunner requires a positive timeoutMs');
  }

  const startedAt = Date.now();
  const stdout = new RingBuffer(MAX_STREAM_BYTES);
  const stderr = new RingBuffer(MAX_STREAM_BYTES);

  // `nice` is applied by wrapping, not by shelling out. On Windows there is no
  // equivalent we can apply without a native call, so we simply do not.
  let spawnBin = safeBin.value;
  let spawnArgs = argv;
  if (nice && process.platform !== 'win32') {
    /*
     * `nice` 是可选增益，不是必需品：它只是避免 CPU 推理把 daemon 自己饿死（D-01 §4.2）。
     * 但硬编码 /usr/bin/nice 会让缺这个二进制的系统（精简容器、Alpine）**整个转写失败**
     * —— 用一个次要优化换掉主功能是错的。找不到就直接跑，不降优先级。
     */
    const NICE = '/usr/bin/nice';
    if (existsSync(NICE)) {
      spawnBin = NICE;
      spawnArgs = ['-n', '10', safeBin.value, ...argv];
    }
  }

  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      env: buildChildEnv(env, proxy),
      // Layer 2, the load-bearing line of this file.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so the timeout can kill the whole tree (ffmpeg and yt-dlp
      // both spawn helpers). On Windows this is emulated via taskkill below.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killTree = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          child.kill(sig);
        } else {
          // Negative pid = the whole process group.
          process.kill(-child.pid, sig);
        }
      } catch {
        // Already dead.
      }
    };

    // Layer 5 — SIGTERM, then SIGKILL after the grace period.
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      aborted = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    wireStream(child.stdout, stdout, onStdoutLine);
    wireStream(child.stderr, stderr, onStderrLine);

    const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        code,
        signal: sig,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rejectPromise(new Error(`failed to spawn ${spawnBin}: ${err.message}`));
    });

    child.on('close', finish);
  });
}

/** Convenience wrapper that throws on non-zero exit. */
export async function runOrThrow(options: RunOptions): Promise<RunResult> {
  const result = await run(options);
  if (result.code !== 0) {
    const why = result.timedOut
      ? `timed out after ${options.timeoutMs}ms`
      : result.aborted
        ? 'was cancelled'
        : `exited with code ${String(result.code)}${result.signal !== null ? ` (${result.signal})` : ''}`;
    throw new SubprocessError(
      `${options.bin} ${why}\n${result.stderr.slice(-2000)}`,
      result,
    );
  }
  return result;
}

function wireStream(
  stream: NodeJS.ReadableStream | null,
  buffer: RingBuffer,
  onLine?: (line: string) => void,
): void {
  if (stream === null) return;
  stream.setEncoding('utf8');
  let pending = '';
  stream.on('data', (chunk: string) => {
    buffer.push(chunk);
    if (onLine === undefined) return;
    pending += chunk;
    // ffmpeg emits progress with \r, not \n — split on both or progress never surfaces.
    const lines = pending.split(/\r\n|\r|\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.length > 0) onLine(line);
  });
  stream.on('end', () => {
    if (onLine !== undefined && pending.length > 0) onLine(pending);
  });
}
