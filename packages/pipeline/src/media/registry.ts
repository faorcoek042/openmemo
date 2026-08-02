/**
 * MediaSourceRegistry. D-01 §6.4.
 *
 * Business code calls `registry.resolve(input)` and NOTHING ELSE. The string "yt-dlp"
 * appears nowhere outside `media/sources/ytdlp.ts` — D-06 §8 specifies the CI grep that
 * enforces this.
 *
 * Resolution order (D-01 §6.4): try the cheap, licence-clean adapters first. A single
 * HEAD request tells us whether a URL is already a direct media link, and most podcast
 * and lecture URLs are. Only when everything else declines do we fall through to the
 * GPL fallback — so the common path genuinely does not touch it.
 */

import type { Availability, MediaInfo, MediaSource, MediaSourceId } from './types.js';
import { NoMediaSourceError } from './types.js';

export interface RegistryEntry {
  source: MediaSource;
  /**
   * Flip to false and the adapter disappears from resolution.
   *
   * TD-002's rollback path: setting `enabled: false` on the yt-dlp entry is a
   * ZERO-CODE-CHANGE way to ship without the GPL component.
   */
  enabled: boolean;
}

export class MediaSourceRegistry {
  private readonly entries = new Map<MediaSourceId, RegistryEntry>();

  register(source: MediaSource, enabled = true): this {
    this.entries.set(source.id, { source, enabled });
    return this;
  }

  setEnabled(id: MediaSourceId, enabled: boolean): this {
    const entry = this.entries.get(id);
    if (entry !== undefined) entry.enabled = enabled;
    return this;
  }

  isEnabled(id: MediaSourceId): boolean {
    return this.entries.get(id)?.enabled ?? false;
  }

  /** Only what is registered AND enabled. */
  list(): MediaSource[] {
    return [...this.entries.values()].filter((e) => e.enabled).map((e) => e.source);
  }

  /** Candidates that accept this input, best first. */
  candidates(input: string): MediaSource[] {
    return this.list()
      .map((source) => ({ source, score: safeMatch(source, input) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((c) => c.source);
  }

  /**
   * Pick the best AVAILABLE adapter.
   *
   * "Available" is checked at resolve time, not registration time: yt-dlp is a
   * runtime-downloaded binary (ADR-001 class C) that may simply not be installed, and a
   * registered-but-missing adapter must not shadow a working one.
   */
  async resolve(input: string): Promise<MediaSource> {
    const candidates = this.candidates(input);
    if (candidates.length === 0) {
      throw new NoMediaSourceError(
        input,
        'This link is not recognised. Try pasting a direct audio/video file URL, a podcast ' +
          'RSS feed, or import the file from your computer.',
      );
    }

    const unavailable: string[] = [];
    for (const source of candidates) {
      const availability = await safeAvailability(source);
      if (availability.ok) return source;
      unavailable.push(`${source.id}: ${availability.reason}`);
    }

    throw new NoMediaSourceError(
      input,
      `No usable handler. ${unavailable.join('; ')}. ` +
        'You can also import the file directly from your computer.',
    );
  }

  /** Probe with the best adapter, falling back down the list on failure. */
  async probe(input: string, signal: AbortSignal): Promise<MediaInfo> {
    const source = await this.resolve(input);
    return source.probe(input, signal);
  }
}

/** A buggy adapter must not take the registry down with it. */
function safeMatch(source: MediaSource, input: string): number {
  try {
    const score = source.match(input);
    return Number.isFinite(score) && score > 0 ? score : 0;
  } catch {
    return 0;
  }
}

async function safeAvailability(source: MediaSource): Promise<Availability> {
  try {
    return await source.isAvailable();
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      remediation: 'Check the installation of this component.',
    };
  }
}
