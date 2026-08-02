/**
 * WhisperServerEngine — whisper.cpp in resident-server mode. D-01 §6.1.
 *
 * WHY THIS IS A FUNCTIONAL FIX, NOT AN OPTIMISATION:
 * the CLI engine spawns `whisper-cli` per chunk, which reloads the model every time. For
 * `large-v3-turbo-q5_0` (547 MB) that is several seconds of no output, no progress and no
 * log line, repeated for every chunk. The user cannot distinguish that from a hang, so
 * they conclude the app is broken. Keeping the model resident removes the stall entirely.
 *
 * Measured on this machine (base.en, 11 s clip): a warm request returns in ~0.37 s, and
 * the second request is the same — no reload cost between chunks.
 *
 * SECURITY (ADR-003, and R-01's note that memo.ac got this wrong):
 * the server binds 127.0.0.1 ONLY. It is spawned on an ephemeral port we pick, and it is
 * killed with the process group on dispose. It is never exposed beyond loopback.
 *
 * The HTTP API accepts `offset_t` / `duration` per request, so chunking needs no audio
 * slicing — the same windowing the CLI does with `--offset-t`, verified to return
 * timestamps ABSOLUTE to the file (offset_t=60000 -> first segment start = 60.0).
 */

import { once } from 'node:events';
import { createServer } from 'node:net';
import { openAsBlob } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

import type { Backend } from '@openmemo/shared';

import { safePrompt } from '../subprocess/argGuard.js';
import { buildChildEnv } from '../subprocess/runner.js';
import type { ToolPaths } from '../tools.js';
import { fileExists, isExecutable } from '../tools.js';
import type {
  AsrAvailability,
  AsrCapabilities,
  AsrEngine,
  TranscribeChunkRequest,
  TranscriptSegment,
} from './types.js';
import { SEGMENT_FLAG, detectRepetition } from './types.js';

export interface WhisperServerEngineOptions {
  tools: ToolPaths;
  cwd: string;
  availableBackends?: Backend[];
  defaultThreads?: number;
  /** Seconds to wait for the server to come up and load the model. */
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  nice?: boolean;
}

export class WhisperServerEngine implements AsrEngine {
  readonly id = 'whisper.cpp-server';
  readonly kind = 'asr' as const;

  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  /** Model the resident server was started with; a change forces a restart. */
  private loadedModelPath: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: WhisperServerEngineOptions) {}

  async capabilities(): Promise<AsrCapabilities> {
    return {
      modes: ['batch'],
      backends: this.opts.availableBackends ?? ['cpu'],
      languages: 'auto',
      wordTimestamps: true,
      diarization: false,
    };
  }

  async isAvailable(): Promise<AsrAvailability> {
    const bin = this.serverBin();
    if (!(await isExecutable(bin))) {
      return {
        ok: false,
        reason: 'the speech recognition server is not installed',
        remediation: 'Install the CPU backend from Settings → Runtime.',
      };
    }
    return { ok: true };
  }

  async transcribeChunk(req: TranscribeChunkRequest): Promise<TranscriptSegment[]> {
    if (!(await fileExists(req.modelPath))) {
      throw new Error(`model not found: ${req.modelPath}`);
    }
    await this.ensureServer(req.modelPath, req.threads);
    const base = this.baseUrl;
    if (base === null) throw new Error('speech recognition server is not running');

    const form = new FormData();
    form.append('file', await openAsBlob(req.audioPath), 'audio.wav');
    // Windowing, exactly as the CLI does with --offset-t / --duration.
    form.append('offset_t', String(Math.round(req.offsetMs)));
    form.append('duration', String(Math.round(req.durationMs)));
    // verbose_json is the only format carrying per-segment times and word probabilities.
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.0');

    /*
     * Language must always be sent. whisper's default is `en`, and when told the audio is
     * English but given Mandarin it TRANSLATES instead of transcribing — a Chinese user
     * who never opened the language setting would silently receive English versions of
     * their own notes. Same reasoning as the CLI engine.
     */
    form.append(
      'language',
      req.language !== undefined && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/.test(req.language)
        ? req.language
        : 'auto',
    );

    const prompt = safePrompt(req.prompt);
    if (prompt !== null) form.append('prompt', prompt);

    const timeout = AbortSignal.timeout(this.opts.requestTimeoutMs ?? 30 * 60_000);
    const response = await fetch(`${base}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.any([req.signal, timeout]),
    });
    if (!response.ok) {
      throw new Error(`speech recognition server returned HTTP ${String(response.status)}`);
    }

    req.onProgress?.(1);
    return parseServerResponse(await response.text(), req.chunkIndex, {
      windowStartMs: req.offsetMs,
      windowEndMs: req.offsetMs + req.durationMs,
    });
  }

  /** Start (or restart) the resident server for `modelPath`. */
  private async ensureServer(modelPath: string, threads?: number): Promise<void> {
    if (this.child !== null && this.loadedModelPath === modelPath && this.baseUrl !== null) return;
    if (this.starting !== null) {
      await this.starting;
      if (this.loadedModelPath === modelPath) return;
    }

    this.starting = (async () => {
      // A different model means a different resident process; restart rather than serve
      // the wrong weights (the failure mode would be silent and hard to spot).
      if (this.child !== null) await this.dispose();

      const bin = this.serverBin();
      const port = await freePort();

      const argv = [
        '-m', modelPath,
        // Loopback only. Never 0.0.0.0 — ADR-003, and the mistake R-01 found in memo.ac.
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(threads ?? this.opts.defaultThreads ?? 4),
      ];

      const child = spawn(bin, argv, {
        cwd: this.opts.cwd,
        env: buildChildEnv({
          LD_LIBRARY_PATH: dirOf(bin),
          DYLD_LIBRARY_PATH: dirOf(bin),
        }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });

      this.child = child;
      const url = `http://127.0.0.1:${String(port)}`;

      // The model load happens at startup, so readiness must be polled rather than
      // assumed — for a 547 MB model this is seconds, not milliseconds.
      const deadline = Date.now() + (this.opts.startupTimeoutMs ?? 120_000);
      let ready = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`speech recognition server exited during startup (code ${String(child.exitCode)})`);
        }
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
          if (r.ok || r.status === 404) {
            ready = true;
            break;
          }
        } catch {
          // not up yet
        }
        await delay(250);
      }
      if (!ready) {
        await this.dispose();
        throw new Error('speech recognition server did not become ready in time');
      }

      this.baseUrl = url;
      this.loadedModelPath = modelPath;
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Stop the resident server. Callers MUST invoke this; the model holds real memory. */
  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    this.loadedModelPath = null;
    if (child === null || child.pid === undefined) return;

    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      return;
    }
    // Give it a moment, then make sure.
    const exited = await Promise.race([once(child, 'exit').then(() => true), delay(5000).then(() => false)]);
    if (!exited) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  private serverBin(): string {
    const cli = this.opts.tools.whisperCli;
    if (cli === null) return '';
    // The server ships beside the CLI in the same L1 core pack.
    return cli.replace(/whisper-cli(\.exe)?$/, (m) => m.replace('whisper-cli', 'whisper-server'));
  }
}

interface ServerSegment {
  start?: number;
  end?: number;
  text?: string;
  words?: { word?: string; start?: number; end?: number; probability?: number }[];
}

/**
 * Parse `verbose_json`.
 *
 * Times are SECONDS and are ABSOLUTE to the file even when `offset_t` was used —
 * verified directly (offset_t=60000 -> first segment start = 60.0). So nothing is added;
 * doing so would repeat the double-counting bug the CLI parser already had.
 */
export function parseServerResponse(
  raw: string,
  chunkIndex: number,
  window: { windowStartMs?: number; windowEndMs?: number } = {},
): TranscriptSegment[] {
  let parsed: { segments?: ServerSegment[]; text?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error('speech recognition server returned unparseable JSON');
  }

  const out: TranscriptSegment[] = [];
  for (const seg of parsed.segments ?? []) {
    const text = (seg.text ?? '').trim();
    if (text.length === 0) continue;

    const startMs = Math.round((seg.start ?? 0) * 1000);
    const endMs = Math.round((seg.end ?? seg.start ?? 0) * 1000);

    // Drop over-run into the next chunk's territory, as the CLI parser does.
    if (window.windowEndMs !== undefined && startMs >= window.windowEndMs) continue;
    if (window.windowStartMs !== undefined && endMs <= window.windowStartMs) continue;

    const words = (seg.words ?? [])
      .filter((w) => (w.word ?? '').trim().length > 0)
      .map((w) => ({
        w: w.word ?? '',
        s: Math.round((w.start ?? seg.start ?? 0) * 1000),
        e: Math.round((w.end ?? seg.end ?? 0) * 1000),
        ...(w.probability !== undefined ? { p: w.probability } : {}),
      }));

    const confidence =
      words.length > 0
        ? words.reduce((sum, w) => sum + (w.p ?? 0), 0) / words.length
        : null;

    let flags = 0;
    if (detectRepetition(text)) flags |= SEGMENT_FLAG.SUSPECT_REPETITION;
    if (confidence !== null && confidence < 0.4) flags |= SEGMENT_FLAG.LOW_CONFIDENCE;

    out.push({
      startMs,
      endMs,
      text,
      confidence,
      noSpeechProb: null,
      words: words.length > 0 ? words : null,
      chunkIdx: chunkIndex,
      flags,
      speakerLabel: null,
    });
  }
  return out;
}

/** Ask the OS for a free port by binding :0 and reading it back. */
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  if (port === 0) throw new Error('could not allocate a port');
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}
