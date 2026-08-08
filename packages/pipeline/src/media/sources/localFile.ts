/**
 * LocalFileSource — F2 (drag a file in from disk).
 *
 * The only adapter that accepts a filesystem path, so it is the only one that has to
 * defend against path traversal (D-01 §8.5). It does so by confining every input to a
 * managed root via `assertWithinRoot`, which realpaths first so a symlink pointing out
 * of the root is caught.
 */

import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';

import { probeMedia } from '../../audio/ffmpeg.js';
import {
  assertWithinRoot,
  isLocalImportSafeExtension,
  isPlaylistExtension,
} from '../../subprocess/argGuard.js';
import type { ToolPaths } from '../../tools.js';
import { isExecutable } from '../../tools.js';
import type { Availability, FetchRequest, FetchedMedia, MediaInfo, MediaSource } from '../types.js';

export interface LocalFileSourceOptions {
  tools: ToolPaths;
  /** Managed root. Nothing outside it may be read. */
  allowedRoot: string;
  cwd: string;
}

export class LocalFileSource implements MediaSource {
  readonly id = 'local-file' as const;
  readonly kind = 'media-source' as const;
  /** ffmpeg's licence is tracked separately (ADR-002); this adapter itself adds none. */
  readonly license = 'NOASSERTION';

  constructor(private readonly opts: LocalFileSourceOptions) {}

  /**
   * Absolute-looking path with a known media extension.
   *
   * Scores highest: if the user handed us a real file there is nothing to negotiate.
   */
  match(input: string): number {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return 0; // it is a URL
    if (!isAbsolute(input)) return 0;
    // Playlists are refused outright — see resolveSafe for the measured attack.
    if (isPlaylistExtension(input)) return 0;
    return isLocalImportSafeExtension(input) ? 100 : 60;
  }

  async isAvailable(): Promise<Availability> {
    if (!(await isExecutable(this.opts.tools.ffprobe))) {
      return {
        ok: false,
        reason: 'ffprobe not found',
        remediation: 'Install the media tools component from Settings → Runtime.',
      };
    }
    return { ok: true };
  }

  async probe(input: string): Promise<MediaInfo> {
    const path = await this.resolveSafe(input);
    const probed = await probeMedia(this.opts.tools, path, { cwd: this.opts.cwd });

    const audio = probed.streams.filter((s) => s.type === 'audio');
    const video = probed.streams.filter((s) => s.type === 'video');

    if (audio.length === 0) {
      throw new Error('this file contains no audio track');
    }

    return {
      sourceKey: `file:${path}`,
      // The on-disk name is display-only and is never used to build a path.
      title: basename(path, extname(path)),
      durationMs: probed.durationMs,
      description: null,
      thumbnailUrl: null,
      uploader: null,
      publishedAt: null,
      tracks: [
        ...audio.map((s) => ({
          id: `a${String(s.index)}`,
          kind: 'audio' as const,
          codec: s.codec,
          bitrateKbps: s.bitrateKbps,
          sampleRateHz: s.sampleRateHz,
          channels: s.channels,
          sizeBytes: null,
        })),
        ...video.map((s) => ({
          id: `v${String(s.index)}`,
          kind: 'video' as const,
          codec: s.codec,
          bitrateKbps: s.bitrateKbps,
          sampleRateHz: null,
          channels: null,
          sizeBytes: null,
        })),
      ],
      isCollection: false,
      producedBy: this.id,
    };
  }

  /** Nothing to download — the bytes are already local. We only validate and measure. */
  async fetch(req: FetchRequest): Promise<FetchedMedia> {
    const path = await this.resolveSafe(req.input);
    const st = await stat(path);

    if (st.size > req.maxBytes) {
      throw new Error(
        `file is ${String(st.size)} bytes, over the ${String(req.maxBytes)} byte limit`,
      );
    }

    const probed = await probeMedia(this.opts.tools, path, { cwd: this.opts.cwd });
    req.onProgress?.(1);

    return {
      path,
      sizeBytes: st.size,
      contentType: null,
      audioOnly: probed.streams.every((s) => s.type !== 'video'),
      producedBy: this.id,
    };
  }

  /**
   * D-01 §8.5 — realpath-based confinement, a regular-file assertion, and a playlist ban.
   *
   * THE PLAYLIST BAN IS NOT REDUNDANT (measured, T-026). Importing a local `.m3u8`
   * containing `file:///tmp/secret.ts` made ffmpeg log
   * `Opening 'file:///tmp/attack/secret.ts' for reading`. The local branch must allow
   * the `file` protocol for normal media to decode, so the protocol whitelist cannot
   * catch this — the playlist reads local files through a protocol we deliberately
   * enabled, and walks straight out of the managed root.
   *
   * Refusing local playlist imports closes it. Remote HLS is untouched: that path uses
   * a whitelist with no `file` in it, which was verified to block the same attack.
   */
  private async resolveSafe(input: string): Promise<string> {
    if (isPlaylistExtension(input)) {
      throw new Error(
        'playlist files (.m3u8/.pls/…) cannot be imported from disk: they can reference ' +
          'arbitrary local paths. Paste the stream URL instead.',
      );
    }
    const guarded = await assertWithinRoot(this.opts.allowedRoot, input);
    if (!guarded.ok) {
      throw new Error(`path rejected (${guarded.code}): ${guarded.message}`);
    }
    const st = await stat(guarded.value);
    if (!st.isFile()) throw new Error('not a regular file');

    // Belt and braces: trust ffprobe's verdict, not the extension. A playlist renamed to
    // .mp3 still demuxes as hls/applehttp.
    const probed = await probeMedia(this.opts.tools, guarded.value, { cwd: this.opts.cwd });
    if (probed.formatName !== null && /hls|applehttp|m3u/i.test(probed.formatName)) {
      throw new Error(
        `this file is a streaming playlist (${probed.formatName}), not a media file; ` +
          'it cannot be imported from disk.',
      );
    }
    return guarded.value;
  }
}
