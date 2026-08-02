/**
 * RssSource — podcast feeds.
 *
 * Expands a feed into N enclosure URLs and hands each to DirectHttpSource. Together they
 * are the TD-002 answer: podcasts are the single biggest legitimate use case for URL
 * import, and they need no GPL component at all.
 *
 * The parser is deliberately a small regex/tag scanner rather than a dependency:
 *   - We need four fields (title, enclosure url, pubDate, duration), not a DOM.
 *   - XML parsers are a classic XXE vector. We never resolve entities, never fetch a
 *     DTD, and never follow an external reference, because we do not implement any of
 *     that. Feeds carrying a DOCTYPE are rejected outright below.
 */

import { assertHostNotPrivate, validateHttpUrl } from '../../subprocess/argGuard.js';
import type {
  Availability,
  FetchRequest,
  FetchedMedia,
  MediaInfo,
  MediaSource,
} from '../types.js';

/** Cap on downloaded feed bytes; some feeds are enormous. */
const MAX_FEED_BYTES = 8 * 1024 * 1024;
/** Cap on expanded episodes, so one paste cannot enqueue thousands of jobs. */
export const MAX_FEED_ITEMS = 500;

export interface RssSourceOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface FeedItem {
  title: string | null;
  enclosureUrl: string;
  publishedAt: string | null;
  durationMs: number | null;
}

export class RssSource implements MediaSource {
  readonly id = 'rss' as const;
  readonly kind = 'media-source' as const;
  readonly license = 'NOASSERTION';

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RssSourceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  match(input: string): number {
    const validated = validateHttpUrl(input);
    if (!validated.ok) return 0;
    const path = new URL(validated.value.href).pathname.toLowerCase();
    if (/(\.rss|\.xml|\/rss\/?$|\/feed\/?$|\/podcast\/?$)/.test(path)) return 85;
    // Unknown paths still get a low positive score so `resolve` can try a content sniff
    // if nothing better matched.
    return 20;
  }

  async isAvailable(): Promise<Availability> {
    return { ok: true };
  }

  /** Returns a collection; the caller enqueues one job per child. */
  async probe(input: string, signal: AbortSignal): Promise<MediaInfo> {
    const url = this.requireSafeUrl(input);
    await this.requirePublicHost(url);

    const xml = await this.fetchFeed(url, signal);
    const items = parseFeed(xml);

    if (items.length === 0) throw new Error('this feed contains no downloadable episodes');

    return {
      sourceKey: url,
      title: parseChannelTitle(xml),
      durationMs: null,
      description: null,
      thumbnailUrl: null,
      uploader: new URL(url).hostname,
      publishedAt: null,
      tracks: [],
      isCollection: true,
      children: items.slice(0, MAX_FEED_ITEMS).map((i) => ({
        input: i.enclosureUrl,
        title: i.title,
      })),
      producedBy: this.id,
    };
  }

  /**
   * A feed has no bytes of its own to fetch.
   *
   * Callers must expand via `probe` and route each child to DirectHttpSource. Throwing
   * here is deliberate — silently downloading "the first episode" would be a surprising
   * interpretation of "import this feed".
   */
  async fetch(_req: FetchRequest): Promise<FetchedMedia> {
    throw new Error(
      'an RSS feed cannot be fetched directly; expand it with probe() and import an episode',
    );
  }

  private async fetchFeed(url: string, signal: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.opts.requestTimeoutMs ?? 20_000);
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.any([signal, timeout]),
      redirect: 'follow',
      headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!response.ok) throw new Error(`feed fetch failed: HTTP ${String(response.status)}`);

    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_FEED_BYTES) throw new Error('feed is too large');
    return new TextDecoder('utf-8').decode(buf);
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
}

/** Does this body look like a feed? Used to sniff URLs with uninformative paths. */
export function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 4096);
  return /<rss[\s>]/i.test(head) || /<feed[\s>][^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(head);
}

export function parseChannelTitle(xml: string): string | null {
  const channel = /<channel[^>]*>([\s\S]*?)(?:<item[\s>]|<\/channel>)/i.exec(xml)?.[1] ?? xml;
  return decodeXmlText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(channel)?.[1] ?? '') || null;
}

/**
 * Extract episodes from RSS 2.0 `<item>` or Atom `<entry>`.
 *
 * XXE defence: reject anything carrying a DOCTYPE or an ENTITY declaration before we
 * look at content. We never expand entities, so this is belt-and-braces, but a feed with
 * a DOCTYPE is not something we want to process regardless.
 */
export function parseFeed(xml: string): FeedItem[] {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new Error('feed contains a DOCTYPE or ENTITY declaration and was rejected');
  }

  const items: FeedItem[] = [];
  const blockRe = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;

  for (const match of xml.matchAll(blockRe)) {
    const block = match[0];

    // RSS: <enclosure url="..."/>  |  Atom: <link rel="enclosure" href="..."/>
    const enclosure =
      /<enclosure[^>]*\burl\s*=\s*["']([^"']+)["']/i.exec(block)?.[1] ??
      /<link[^>]*\brel\s*=\s*["']enclosure["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(block)?.[1] ??
      null;
    if (enclosure === null) continue;

    const href = decodeXmlText(enclosure);
    // Every child URL goes through the same guard as a pasted one — a hostile feed is
    // just another way of supplying `file:///etc/passwd`.
    const validated = validateHttpUrl(href);
    if (!validated.ok) continue;

    items.push({
      title: decodeXmlText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? '') || null,
      enclosureUrl: validated.value.href,
      publishedAt:
        /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block)?.[1]?.trim() ??
        /<published[^>]*>([\s\S]*?)<\/published>/i.exec(block)?.[1]?.trim() ??
        null,
      durationMs: parseItunesDuration(
        /<itunes:duration[^>]*>([\s\S]*?)<\/itunes:duration>/i.exec(block)?.[1]?.trim() ?? null,
      ),
    });
  }

  return items;
}

/** `<itunes:duration>` is either seconds, `MM:SS` or `HH:MM:SS`. */
export function parseItunesDuration(raw: string | null): number | null {
  if (raw === null || raw.length === 0) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const parts = raw.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return (parts[0]! * 60 + parts[1]!) * 1000;
  if (parts.length === 3) return (parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1000;
  return null;
}

function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    // Only the five predefined XML entities plus numeric refs. No external entities.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}
