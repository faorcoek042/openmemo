/**
 * YtDlpSource — the GPLv3+ fallback.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE IS THE ONLY PLACE IN THE REPOSITORY WHERE THE STRING "yt-dlp" MAY       │
 * │ APPEAR (outside manifests and docs). D-06 §8 specifies the CI grep that enforces  │
 * │ it. Business code talks to MediaSourceRegistry and never names this adapter.      │
 * │                                                                                    │
 * │ ADR-002 / TD-002: delete this file, or set `enabled: false` on its registry entry, │
 * │ and the product keeps working — DirectHttpSource + RssSource still cover podcasts, │
 * │ RSS, HLS and direct links. Proven by media/__tests__/ytdlpRemoval.test.ts.         │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * D-01 §8.4 layer 4 — disarming the tool. Every flag below was verified against the
 * upstream README:
 *
 *   --ignore-config      "Don't load any more configuration files…" Without this, anyone
 *                        who can write ~/.config/yt-dlp/config gets arbitrary code
 *                        execution via --exec. This is the single most important flag
 *                        here and the easiest to forget.
 *   --no-config-locations "Do not load any custom configuration files (default)."
 *   --no-exec            "Remove any previously defined --exec." Belt and braces: even
 *                        if a config somehow loaded, this cancels its --exec.
 *   --paths              Pins output under OUR temp dir.
 *   -o %(id)s.%(ext)s    Constant template. The id is sanitised by yt-dlp itself; no
 *                        user-controlled string reaches the output path.
 *   --no-playlist        "Download only the video, if the URL refers to a video and a
 *                        playlist" — stops one paste becoming 5000 downloads.
 *   --max-downloads / --max-filesize   hard caps.
 *
 * NEVER passed: --exec, --load-info-json, --batch-file, --cookies <user path>. Each is a
 * documented arbitrary-execution or arbitrary-read primitive.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildArgv, validateHttpUrl } from '../../subprocess/argGuard.js';
import { run, runOrThrow } from '../../subprocess/runner.js';
import { ytDlpProxyArgs, type ProxyConfig } from '../../subprocess/proxy.js';
import { SubprocessError } from '../../subprocess/runner.js';
import type { ToolPaths } from '../../tools.js';
import { isExecutable } from '../../tools.js';
import type { Availability, FetchRequest, FetchedMedia, MediaInfo, MediaSource } from '../types.js';

/** Flags applied to EVERY invocation. Order is irrelevant; presence is not. */
const HARDENING_FLAGS: string[] = [
  '--ignore-config',
  '--no-config-locations',
  '--no-exec',
  '--no-playlist',
  '--no-continue',
  '--no-cache-dir',
  '--no-color',
  '--no-progress',
];

export interface YtDlpSourceOptions {
  tools: ToolPaths;
  cwd: string;
  probeTimeoutMs?: number;
  fetchTimeoutMs?: number;
  /** Outbound proxy. yt-dlp honours both http(s) and SOCKS. */
  proxy?: ProxyConfig | null;
}

export class YtDlpSource implements MediaSource {
  readonly id = 'yt-dlp' as const;
  readonly kind = 'media-source' as const;
  /** Surfaced in the UI. ADR-002 permits bundling for personal use only. */
  readonly license = 'GPL-3.0-or-later';

  constructor(private readonly opts: YtDlpSourceOptions) {}

  /**
   * Lowest positive score, by design (D-01 §6.4).
   *
   * This adapter accepts any http(s) URL, but only wins when every licence-clean
   * adapter has declined. That ordering is what makes "we do not depend on a GPL
   * component by default" a property of the code rather than a claim in a document.
   */
  match(input: string): number {
    return validateHttpUrl(input).ok ? 10 : 0;
  }

  async isAvailable(): Promise<Availability> {
    if (!(await isExecutable(this.opts.tools.ytDlp))) {
      return {
        ok: false,
        reason: 'the site-extractor component is not installed',
        remediation:
          'Install it from Settings → Components, or paste a direct media link / podcast RSS feed instead.',
      };
    }
    return { ok: true };
  }

  async probe(input: string, signal: AbortSignal): Promise<MediaInfo> {
    const bin = this.requireBin();
    const url = this.requireSafeUrl(input);

    // -J = dump metadata as JSON, implies --simulate: nothing is written to disk.
    const argv = buildArgv({
      flags: [
        ...HARDENING_FLAGS,
        ...ytDlpProxyArgs(this.opts.proxy ?? null),
        '--dump-single-json',
        '--simulate',
      ],
      operands: [url],
    });
    if (!argv.ok) throw new Error(`URL rejected (${argv.code}): ${argv.message}`);

    const result = await runOrThrow({
      bin,
      argv: argv.value,
      cwd: this.opts.cwd,
      timeoutMs: this.opts.probeTimeoutMs ?? 60_000,
      signal,
    });

    return this.toMediaInfo(result.stdout, url);
  }

  async fetch(req: FetchRequest): Promise<FetchedMedia> {
    const bin = this.requireBin();
    const url = this.requireSafeUrl(req.input);

    const flags = [
      ...HARDENING_FLAGS,
      ...ytDlpProxyArgs(this.opts.proxy ?? null),
      // Output stays inside the directory WE chose.
      '--paths',
      req.destDir,
      // Constant template. yt-dlp sanitises %(id)s itself.
      '-o',
      '%(id)s.%(ext)s',
      '--max-downloads',
      '1',
      '--max-filesize',
      String(req.maxBytes),
      '--newline',
    ];

    if (req.preferAudioOnly) {
      // Format selection is a fixed developer-authored string, never user input.
      flags.push('-f', 'bestaudio/best');
    }

    const argv = buildArgv({ flags, operands: [url] });
    if (!argv.ok) throw new Error(`URL rejected (${argv.code}): ${argv.message}`);

    const before = new Set(await safeReaddir(req.destDir));
    const startedAt = Date.now();

    const result = await run({
      bin,
      argv: argv.value,
      cwd: this.opts.cwd,
      timeoutMs: req.signal.aborted ? 1 : (this.opts.fetchTimeoutMs ?? 60 * 60_000),
      signal: req.signal,
      onStdoutLine: (line) => {
        // "[download]  12.3% of ..." — the only line shape we parse.
        const m = /\[download\]\s+([\d.]+)%/.exec(line);
        if (m?.[1] !== undefined) req.onProgress?.(Number(m[1]) / 100);
      },
    });

    /*
     * EXIT CODE 101 IS SUCCESS HERE.
     *
     * yt-dlp returns 101 whenever `--max-downloads` is hit — including when it hit the
     * limit *because it finished the one file we asked for*:
     *     [download] Download completed
     *     [info] Maximum number of downloads reached, stopping due to --max-downloads
     *     Aborting remaining downloads
     *     -> exit 101
     * Treating non-zero as failure made the entire F1 import path fail on every video
     * even though the media was on disk. This went unnoticed because only `probe` had
     * ever been exercised end to end; `fetch` had not.
     *
     * We accept 0 and 101, then prove success the honest way — by checking that a new
     * file actually appeared below.
     */
    const MAX_DOWNLOADS_REACHED = 101;
    if (result.code !== 0 && result.code !== MAX_DOWNLOADS_REACHED) {
      const why = result.timedOut
        ? 'timed out'
        : result.aborted
          ? 'was cancelled'
          : `exited with code ${String(result.code)}`;
      throw new SubprocessError(`the site extractor ${why}\n${result.stderr.slice(-2000)}`, result);
    }

    /*
     * Find the media file yt-dlp wrote. It chooses the extension itself (we only fix the
     * basename template), so the file has to be discovered rather than assumed.
     *
     * "Files that were not there before" is the obvious rule and it is WRONG ON RETRY: a
     * previous failed attempt leaves its output behind, so on the second run nothing is
     * new and the import fails forever. Measured exactly that way — the F1 path failed on
     * retry even though the media was sitting in the directory.
     *
     * So the candidate set is: newly-created files, PLUS anything touched since this
     * invocation started, PLUS (as a last resort) whatever is already in the directory.
     * The directory is per-job and created by us, so nothing else can be in it.
     */
    const after = await safeReaddir(req.destDir);
    const withStats: { path: string; name: string; size: number; mtimeMs: number }[] = [];
    for (const name of after) {
      const path = join(req.destDir, name);
      const st = await stat(path).catch(() => null);
      if (st === null || !st.isFile()) continue;
      withStats.push({ path, name, size: st.size, mtimeMs: st.mtimeMs });
    }

    const isSidecar = (n: string): boolean =>
      /\.(info\.json|jpg|jpeg|png|webp|vtt|srt|part|ytdl)$/i.test(n);

    const tiers = [
      withStats.filter((f) => !before.has(f.name) && !isSidecar(f.name)),
      withStats.filter((f) => f.mtimeMs >= startedAt - 1000 && !isSidecar(f.name)),
      withStats.filter((f) => !isSidecar(f.name)),
    ];

    let best: { path: string; size: number } | null = null;
    for (const tier of tiers) {
      // Largest in the tier: sidecars are excluded above, so the biggest file is the media.
      for (const f of tier) {
        if (best === null || f.size > best.size) best = { path: f.path, size: f.size };
      }
      if (best !== null) break;
    }
    if (best === null) throw new Error('the extractor produced no usable file');

    req.onProgress?.(1);
    return {
      path: best.path,
      sizeBytes: best.size,
      contentType: null,
      audioOnly: req.preferAudioOnly,
      producedBy: this.id,
    };
  }

  /** Version string, for the "update this component" UI. */
  async version(): Promise<string | null> {
    const bin = this.opts.tools.ytDlp;
    if (bin === null) return null;
    try {
      const r = await run({ bin, argv: ['--version'], cwd: this.opts.cwd, timeoutMs: 15_000 });
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  private requireBin(): string {
    const bin = this.opts.tools.ytDlp;
    if (bin === null || bin.length === 0) {
      throw new Error('the site-extractor component is not installed');
    }
    return bin;
  }

  private requireSafeUrl(input: string): string {
    const validated = validateHttpUrl(input);
    if (!validated.ok) throw new Error(`URL rejected (${validated.code}): ${validated.message}`);
    return validated.value.href;
  }

  /**
   * Map upstream JSON onto OUR types (ADR-001 mandate 2).
   *
   * Only the handful of fields below ever cross this boundary. The upstream object has
   * hundreds of keys and no stability guarantee; letting it leak would couple business
   * code to a GPL tool's internals and undermine the whole replaceability story.
   */
  private toMediaInfo(stdout: string, url: string): MediaInfo {
    let raw: {
      id?: string;
      title?: string;
      description?: string;
      duration?: number;
      thumbnail?: string;
      uploader?: string;
      upload_date?: string;
      _type?: string;
      entries?: { url?: string; webpage_url?: string; title?: string }[];
      formats?: {
        format_id?: string;
        acodec?: string;
        vcodec?: string;
        abr?: number;
        asr?: number;
        filesize?: number;
      }[];
    };
    try {
      raw = JSON.parse(stdout) as typeof raw;
    } catch {
      throw new Error('the extractor returned unparseable metadata');
    }

    const isPlaylist = raw._type === 'playlist' && Array.isArray(raw.entries);

    return {
      sourceKey: raw.id !== undefined ? `ytdlp:${raw.id}` : url,
      title: raw.title ?? null,
      durationMs: typeof raw.duration === 'number' ? Math.round(raw.duration * 1000) : null,
      description: raw.description ?? null,
      thumbnailUrl: raw.thumbnail ?? null,
      uploader: raw.uploader ?? null,
      publishedAt: formatUploadDate(raw.upload_date),
      tracks: (raw.formats ?? [])
        .filter((f) => f.acodec !== undefined && f.acodec !== 'none')
        .slice(0, 20)
        .map((f) => ({
          id: f.format_id ?? 'unknown',
          kind:
            f.vcodec === undefined || f.vcodec === 'none' ? ('audio' as const) : ('muxed' as const),
          codec: f.acodec ?? null,
          bitrateKbps: typeof f.abr === 'number' ? Math.round(f.abr) : null,
          sampleRateHz: typeof f.asr === 'number' ? f.asr : null,
          channels: null,
          sizeBytes: typeof f.filesize === 'number' ? f.filesize : null,
        })),
      isCollection: isPlaylist,
      children: isPlaylist
        ? (raw.entries ?? [])
            .map((e) => ({ input: e.webpage_url ?? e.url ?? '', title: e.title ?? null }))
            .filter((e) => validateHttpUrl(e.input).ok)
        : undefined,
      producedBy: this.id,
    };
  }
}

/** yt-dlp emits `YYYYMMDD`. */
function formatUploadDate(v: string | undefined): string | null {
  if (v === undefined || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
