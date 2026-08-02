/**
 * ffmpeg / ffprobe adapter. D-01 §8.4 layer 4 (disarming the tool itself).
 *
 * ffmpeg is not just a transcoder — it is a protocol client with a large attack surface.
 * The flags below are not stylistic:
 *
 *   -nostdin      without it ffmpeg competes for the parent's stdin and can hang forever
 *   -protocol_whitelist   ffmpeg understands `concat:`, `subfile:`, `file:` and friends.
 *                 A crafted playlist can make it read arbitrary local files and splice
 *                 them into the output. We pass the minimum set per call site.
 *   never -filter_complex/-vf/-metadata with user strings — filter syntax has its own
 *                 escaping rules (`:` `,` `[` `]` `'` `\`), i.e. a second injection
 *                 grammar layered inside a single argv element.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildArgv } from '../subprocess/argGuard.js';
import { run, runOrThrow } from '../subprocess/runner.js';
import { ffmpegProxySupport, type ProxyConfig } from '../subprocess/proxy.js';
import type { ToolPaths } from '../tools.js';

/** ASR input format: whisper.cpp and sherpa-onnx both want 16 kHz mono PCM. */
export const ASR_SAMPLE_RATE = 16_000;
export const ASR_CHANNELS = 1;

export interface ProbeResult {
  durationMs: number | null;
  formatName: string | null;
  sizeBytes: number | null;
  streams: {
    index: number;
    type: 'audio' | 'video' | 'subtitle' | 'other';
    codec: string | null;
    sampleRateHz: number | null;
    channels: number | null;
    bitrateKbps: number | null;
  }[];
}

/** Protocols ffmpeg may use for a LOCAL file. Deliberately excludes every network one. */
const LOCAL_PROTOCOLS = 'file';
/** Protocols for a REMOTE input (HLS). No `file`, so a playlist cannot read local disk. */
const REMOTE_PROTOCOLS = 'https,tls,tcp,crypto,httpproxy';

/**
 * Probe a media file.
 *
 * This is the authority on "what is this file", not the extension and not the
 * Content-Type the server claimed (D-01 §8.5).
 */
export async function probeMedia(
  tools: ToolPaths,
  filePath: string,
  opts: {
    cwd: string;
    timeoutMs?: number;
    remote?: boolean;
    signal?: AbortSignal;
    /** Only meaningful for remote inputs; ffmpeg has no SOCKS support (see proxy.ts). */
    proxy?: ProxyConfig | null;
  },
): Promise<ProbeResult> {
  const argv = buildArgv({
    flags: [
      '-v', 'error',
      '-hide_banner',
      '-protocol_whitelist', opts.remote === true ? REMOTE_PROTOCOLS : LOCAL_PROTOCOLS,
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-i',
    ],
    operands: [filePath],
    // ffprobe's `-i` takes the very next argv element, so a `--` between them would be
    // consumed as the filename. The leading-dash rejection inside buildArgv still runs,
    // which is the protection that actually matters here.
    useDoubleDash: false,
  });
  if (!argv.ok) throw new Error(`ffprobe argument rejected: ${argv.message}`);

  const result = await runOrThrow({
    bin: tools.ffprobe,
    argv: argv.value,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal,
    // Env-based: ffprobe reads http_proxy the same way ffmpeg does.
    env: opts.remote === true ? ffmpegProxySupport(opts.proxy ?? null).env : {},
  });

  return parseFfprobeJson(result.stdout);
}

export function parseFfprobeJson(json: string): ProbeResult {
  let parsed: {
    format?: { duration?: string; format_name?: string; size?: string };
    streams?: {
      index?: number;
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      bit_rate?: string;
    }[];
  };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new Error('ffprobe returned unparseable JSON');
  }

  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const durationSec = num(parsed.format?.duration);

  return {
    durationMs: durationSec === null ? null : Math.round(durationSec * 1000),
    formatName: parsed.format?.format_name ?? null,
    sizeBytes: num(parsed.format?.size),
    streams: (parsed.streams ?? []).map((s) => ({
      index: s.index ?? 0,
      type:
        s.codec_type === 'audio'
          ? 'audio'
          : s.codec_type === 'video'
            ? 'video'
            : s.codec_type === 'subtitle'
              ? 'subtitle'
              : 'other',
      codec: s.codec_name ?? null,
      sampleRateHz: num(s.sample_rate),
      channels: s.channels ?? null,
      bitrateKbps: (() => {
        const b = num(s.bit_rate);
        return b === null ? null : Math.round(b / 1000);
      })(),
    })),
  };
}

export interface NormalizeResult {
  path: string;
  sampleRateHz: number;
  channels: number;
  durationMs: number | null;
  sizeBytes: number;
}

/**
 * Transcode anything into the one format the ASR engines accept: 16 kHz mono 16-bit WAV.
 *
 * Output filename is OURS (D-01 §8.5 — the user never supplies a filename), so no
 * traversal, no Windows reserved names, no ADS, no trailing-dot tricks.
 */
export async function normalizeToPcm16k(
  tools: ToolPaths,
  inputPath: string,
  opts: {
    destDir: string;
    /** Basename without extension. Caller generates it; never user-supplied. */
    destBasename: string;
    cwd: string;
    remote?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
    /** Total duration, if known, so progress can be a fraction rather than a spinner. */
    totalDurationMs?: number | null;
    proxy?: ProxyConfig | null;
  },
): Promise<NormalizeResult> {
  const outPath = join(opts.destDir, `${opts.destBasename}.wav`);

  const argv = buildArgv({
    flags: [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-protocol_whitelist', opts.remote === true ? REMOTE_PROTOCOLS : LOCAL_PROTOCOLS,
      // Machine-readable progress on stdout; avoids scraping the human log format.
      '-progress', 'pipe:1',
      '-i', inputPath,
      '-vn', // drop video
      '-map', '0:a:0', // first audio stream only
      '-ac', String(ASR_CHANNELS),
      '-ar', String(ASR_SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      outPath,
    ],
    // Both paths are ours (managed temp dir), so there is no user-controlled operand.
    // They still pass through buildArgv's leading-dash and control-char checks.
    operands: [],
    useDoubleDash: false,
  });
  if (!argv.ok) throw new Error(`ffmpeg argument rejected: ${argv.message}`);

  const total = opts.totalDurationMs ?? null;
  await runOrThrow({
    bin: tools.ffmpeg,
    argv: argv.value,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    signal: opts.signal,
    env: opts.remote === true ? ffmpegProxySupport(opts.proxy ?? null).env : {},
    onStdoutLine: (line) => {
      if (opts.onProgress === undefined || total === null || total <= 0) return;
      // `-progress` emits `out_time_us=123456` lines.
      const m = /^out_time_us=(\d+)$/.exec(line.trim());
      if (m?.[1] === undefined) return;
      const doneMs = Number(m[1]) / 1000;
      opts.onProgress(Math.max(0, Math.min(1, doneMs / total)));
    },
  });

  const st = await stat(outPath);
  const probe = await probeMedia(tools, outPath, { cwd: opts.cwd, signal: opts.signal });

  return {
    path: outPath,
    sampleRateHz: ASR_SAMPLE_RATE,
    channels: ASR_CHANNELS,
    durationMs: probe.durationMs,
    sizeBytes: st.size,
  };
}

/** Slice a chunk out of a normalized WAV. Stream-copies, so it is fast and lossless. */
export async function sliceWav(
  tools: ToolPaths,
  inputPath: string,
  opts: {
    startMs: number;
    endMs: number;
    destDir: string;
    destBasename: string;
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const outPath = join(opts.destDir, `${opts.destBasename}.wav`);
  const startSec = (opts.startMs / 1000).toFixed(3);
  const durSec = ((opts.endMs - opts.startMs) / 1000).toFixed(3);

  const argv = buildArgv({
    flags: [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', LOCAL_PROTOCOLS,
      // -ss BEFORE -i is the fast seek; on PCM it is also exact.
      '-ss', startSec,
      '-t', durSec,
      '-i', inputPath,
      '-c:a', 'pcm_s16le',
      '-ar', String(ASR_SAMPLE_RATE),
      '-ac', String(ASR_CHANNELS),
      '-f', 'wav',
      outPath,
    ],
    operands: [],
    useDoubleDash: false,
  });
  if (!argv.ok) throw new Error(`ffmpeg argument rejected: ${argv.message}`);

  await runOrThrow({
    bin: tools.ffmpeg,
    argv: argv.value,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    signal: opts.signal,
  });
  return outPath;
}

/** Is ffmpeg/ffprobe actually usable? Checked at startup so failures are explainable. */
export async function checkFfmpeg(tools: ToolPaths, cwd: string): Promise<{ ok: boolean; version: string | null }> {
  try {
    const r = await run({
      bin: tools.ffmpeg,
      argv: ['-version'],
      cwd,
      timeoutMs: 10_000,
    });
    if (r.code !== 0) return { ok: false, version: null };
    return { ok: true, version: /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? null };
  } catch {
    return { ok: false, version: null };
  }
}
