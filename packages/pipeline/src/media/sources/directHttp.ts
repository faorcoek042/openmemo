/**
 * DirectHttpSource — plain HTTP(S) media links and HLS playlists.
 *
 * TD-002 significance: together with RssSource this is what makes the product work with
 * `YtDlpSource` disabled. Podcasts, lecture recordings, CDN-hosted MP3s and HLS streams
 * all land here, and none of them need a GPL component.
 *
 * Every URL passes through `validateHttpUrl` (D-01 §8.4 L3): scheme allowlist, no
 * credentials, no private/loopback/metadata addresses, no leading dash, no control
 * characters, length cap.
 */

import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeToPcm16k, probeMedia } from '../../audio/ffmpeg.js';
import type { ProxyResolver } from '../../subprocess/proxy.js';
import {
  assertHostNotPrivate,
  hasAllowedMediaExtension,
  validateHttpUrl,
} from '../../subprocess/argGuard.js';
import { resumableFetch } from '../resumableFetch.js';
import type { ToolPaths } from '../../tools.js';
import type { Availability, FetchRequest, FetchedMedia, MediaInfo, MediaSource } from '../types.js';

const MEDIA_CONTENT_TYPES = /^(audio|video)\//i;
const HLS_CONTENT_TYPES = /(application\/(vnd\.apple\.)?mpegurl|application\/x-mpegurl)/i;

export interface DirectHttpSourceOptions {
  tools: ToolPaths;
  cwd: string;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /**
   * Outbound proxy, resolved per target URL.
   *
   * This adapter reaches the network two different ways, and only ONE of them was
   * covered before:
   *   · `fetch` (HEAD probe, `resumableFetch`) — in-process, so `setGlobalDispatcher`
   *     already routes it. Nothing to do here.
   *   · **ffprobe / ffmpeg reading the URL directly** (`remote: true`) — a SUBPROCESS.
   *     The global dispatcher cannot reach it; it only obeys `http_proxy` in its own
   *     environment, which `ffmpegProxySupport()` supplies from this value.
   * `[实测]` before this was wired, ffprobe went direct while the settings page said the
   * proxy was applied.
   */
  proxy?: ProxyResolver | null;
}

export class DirectHttpSource implements MediaSource {
  readonly id = 'direct-http' as const;
  readonly kind = 'media-source' as const;
  readonly license = 'NOASSERTION';

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DirectHttpSourceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Cheap syntactic guess; `probe` does the authoritative HEAD.
   *
   * Scores above yt-dlp (D-01 §6.4 resolution order) but below LocalFileSource.
   */
  match(input: string): number {
    const validated = validateHttpUrl(input);
    if (!validated.ok) return 0;

    const path = new URL(validated.value.href).pathname;
    if (/\.m3u8$/i.test(path)) return 80;
    if (hasAllowedMediaExtension(path)) return 80;
    // Might still be a media link with no extension — worth a HEAD, but rank it below
    // anything that looks unambiguous.
    return 30;
  }

  async isAvailable(): Promise<Availability> {
    return { ok: true };
  }

  async probe(input: string, signal: AbortSignal): Promise<MediaInfo> {
    const url = this.requireSafeUrl(input);
    await this.requirePublicHost(url);

    const head = await this.head(url, signal);
    const contentType = head.headers.get('content-type');

    const isHls = contentType !== null && HLS_CONTENT_TYPES.test(contentType);
    const looksMedia =
      isHls ||
      (contentType !== null && MEDIA_CONTENT_TYPES.test(contentType)) ||
      hasAllowedMediaExtension(new URL(url).pathname);

    if (!looksMedia) {
      throw new Error(
        `this URL does not look like a media file (Content-Type: ${contentType ?? 'unknown'})`,
      );
    }

    // For HLS we must let ffprobe walk the playlist; for a plain file we can probe the
    // URL directly and ffmpeg will range-read only the header it needs.
    let durationMs: number | null = null;
    let tracks: MediaInfo['tracks'] = [];
    try {
      const probed = await probeMedia(this.opts.tools, url, {
        cwd: this.opts.cwd,
        remote: true,
        signal,
        timeoutMs: 30_000,
        proxy: this.opts.proxy?.(url) ?? null,
      });
      durationMs = probed.durationMs;
      tracks = probed.streams
        .filter((s) => s.type === 'audio' || s.type === 'video')
        .map((s) => ({
          id: `${s.type === 'audio' ? 'a' : 'v'}${String(s.index)}`,
          kind: s.type === 'audio' ? ('audio' as const) : ('video' as const),
          codec: s.codec,
          bitrateKbps: s.bitrateKbps,
          sampleRateHz: s.sampleRateHz,
          channels: s.channels,
          sizeBytes: null,
        }));
    } catch {
      // Some CDNs refuse ffprobe's range requests. Not fatal: we can still download.
    }

    return {
      sourceKey: url,
      title: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || null,
      durationMs,
      description: null,
      thumbnailUrl: null,
      uploader: new URL(url).hostname,
      publishedAt: null,
      tracks,
      isCollection: false,
      producedBy: this.id,
    };
  }

  async fetch(req: FetchRequest): Promise<FetchedMedia> {
    const url = this.requireSafeUrl(req.input);
    await this.requirePublicHost(url);

    // HLS is not a file — hand it to ffmpeg, which understands the playlist. The
    // protocol whitelist inside normalizeToPcm16k excludes `file`, so a hostile playlist
    // cannot splice in local disk content.
    if (/\.m3u8$/i.test(new URL(url).pathname)) {
      const out = await normalizeToPcm16k(this.opts.tools, url, {
        destDir: req.destDir,
        destBasename: req.destBasename,
        cwd: this.opts.cwd,
        remote: true,
        signal: req.signal,
        onProgress: req.onProgress,
        proxy: this.opts.proxy?.(url) ?? null,
      });
      return {
        path: out.path,
        sizeBytes: out.sizeBytes,
        contentType: 'audio/wav',
        audioOnly: true,
        producedBy: this.id,
      };
    }

    /*
     * Resumable transfer (T-031). Previously this was a single `fetch()` + pipe: any
     * dropped connection meant starting the whole file again, which on a 300 MB podcast
     * over a flaky link can mean never finishing. Reuses `@openmemo/downloader`'s
     * Range primitives rather than reimplementing them — see resumableFetch.ts for why
     * `downloadFile()` itself is not reusable here (it mandates a known SHA-256, which
     * an arbitrary media URL does not have).
     */
    const ext = extensionFor(url, null);
    const outPath = join(req.destDir, `${req.destBasename}${ext}`);

    const fetched = await resumableFetch({
      url,
      destPath: outPath,
      maxBytes: req.maxBytes,
      signal: req.signal,
      onProgress: (fraction) => req.onProgress?.(fraction),
    });

    const contentType = fetched.contentType;

    const st = await stat(outPath);
    // D-01 §8.5: trust ffprobe, not the extension or the server's Content-Type.
    const probed = await probeMedia(this.opts.tools, outPath, { cwd: this.opts.cwd });
    if (probed.streams.every((s) => s.type !== 'audio')) {
      await unlink(outPath).catch(() => undefined);
      throw new Error('downloaded file contains no audio track');
    }

    req.onProgress?.(1);
    return {
      path: outPath,
      sizeBytes: st.size,
      contentType,
      audioOnly: probed.streams.every((s) => s.type !== 'video'),
      producedBy: this.id,
    };
  }

  private requireSafeUrl(input: string): string {
    const validated = validateHttpUrl(input);
    if (!validated.ok) throw new Error(`URL rejected (${validated.code}): ${validated.message}`);
    return validated.value.href;
  }

  private async requirePublicHost(url: string): Promise<void> {
    const check = await assertHostNotPrivate(new URL(url).hostname);
    if (!check.ok) throw new Error(`URL rejected (${check.code}): ${check.message}`);
  }

  /** HEAD, falling back to a ranged GET for servers that reject HEAD. */
  private async head(url: string, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.opts.requestTimeoutMs ?? 15_000);
    const combined = AbortSignal.any([signal, timeout]);

    const headResponse = await this.fetchImpl(url, {
      method: 'HEAD',
      signal: combined,
      redirect: 'follow',
      headers: { 'user-agent': 'OpenMemo/0.1 (+local)' },
    }).catch(() => null);

    if (headResponse !== null && headResponse.ok) return headResponse;

    const ranged = await this.fetchImpl(url, {
      method: 'GET',
      signal: combined,
      redirect: 'follow',
      headers: { range: 'bytes=0-0', 'user-agent': 'OpenMemo/0.1 (+local)' },
    });
    if (!ranged.ok && ranged.status !== 206) {
      throw new Error(`could not reach URL: HTTP ${String(ranged.status)}`);
    }
    await ranged.body?.cancel();
    return ranged;
  }
}

/** Extension for the downloaded file. Derived from OUR data, never from a user string. */
function extensionFor(url: string, contentType: string | null): string {
  const pathExt = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  if (pathExt !== undefined && hasAllowedMediaExtension(`.${pathExt}`)) return `.${pathExt}`;

  const byType: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'application/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/flac': '.flac',
    'audio/webm': '.webm',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/x-matroska': '.mkv',
  };
  const base = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return byType[base] ?? '.bin';
}
