/**
 * TD-002 proof: the product works without the GPL component.
 *
 * ADR-002 says yt-dlp must be "architecturally replaceable". `oss-scout` correctly
 * objected that this was only asserted in comments. These tests are the enforcement:
 * they disable the adapter and assert that real-world inputs still resolve.
 *
 * If someone makes yt-dlp load-bearing, these tests fail.
 *
 * Run: node --test packages/pipeline/dist/media/__tests__/ytdlpRemoval.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaSourceRegistry } from '../registry.js';
import { DirectHttpSource } from '../sources/directHttp.js';
import { RssSource } from '../sources/rss.js';
import { YtDlpSource } from '../sources/ytdlp.js';
import { LocalFileSource } from '../sources/localFile.js';
import { NoMediaSourceError } from '../types.js';
import type { MediaSource } from '../types.js';
import type { ToolPaths } from '../../tools.js';

/** yt-dlp present and executable (/bin/sh always is, and we never run it here). */
const TOOLS_WITH_EXTRACTOR: ToolPaths = {
  ffmpeg: '/bin/sh',
  ffprobe: '/bin/sh',
  whisperCli: null,
  whisperVad: null,
  vadModel: null,
  ytDlp: '/bin/sh',
};

/** The shipping-without-GPL configuration. */
const TOOLS_WITHOUT_EXTRACTOR: ToolPaths = { ...TOOLS_WITH_EXTRACTOR, ytDlp: null };

function buildRegistry(tools: ToolPaths, enableExtractor: boolean): MediaSourceRegistry {
  const r = new MediaSourceRegistry();
  r.register(new LocalFileSource({ tools, allowedRoot: '/tmp', cwd: '/tmp' }));
  r.register(new DirectHttpSource({ tools, cwd: '/tmp' }));
  r.register(new RssSource());
  r.register(new YtDlpSource({ tools, cwd: '/tmp' }), enableExtractor);
  return r;
}

/** The inputs that must keep working. Podcasts are the dominant real use case. */
const INPUTS_THAT_MUST_WORK = [
  { label: 'podcast MP3 direct link', input: 'https://example.com/episodes/ep42.mp3', expect: 'direct-http' },
  { label: 'CDN m4a', input: 'https://cdn.example.org/audio/lecture.m4a', expect: 'direct-http' },
  { label: 'public-domain OGG', input: 'https://upload.wikimedia.org/wikipedia/commons/7/7c/x.ogg', expect: 'direct-http' },
  { label: 'HLS playlist', input: 'https://stream.example.com/live/index.m3u8', expect: 'direct-http' },
  { label: 'podcast RSS feed', input: 'https://example.com/feed.rss', expect: 'rss' },
  { label: 'podcast feed (path form)', input: 'https://example.com/podcast/feed', expect: 'rss' },
  { label: 'local file', input: '/tmp/recording.wav', expect: 'local-file' },
];

describe('TD-002 — the product survives removal of the GPL adapter', () => {
  it('resolves every core input WITHOUT the site extractor', async () => {
    const registry = buildRegistry(TOOLS_WITHOUT_EXTRACTOR, false);

    assert.equal(registry.isEnabled('yt-dlp'), false, 'precondition: extractor disabled');
    assert.equal(
      registry.list().some((s) => s.id === 'yt-dlp'),
      false,
      'a disabled adapter must not appear in the active list',
    );

    for (const { label, input, expect } of INPUTS_THAT_MUST_WORK) {
      const resolved = await registry.resolve(input);
      assert.equal(resolved.id, expect, `${label} should resolve to ${expect}`);
    }
  });

  it('resolves the same inputs identically WITH the extractor enabled', async () => {
    // The licence-clean adapters must win on score, so enabling the GPL fallback changes
    // nothing for ordinary inputs. If this fails, the resolution order regressed and we
    // would be routing podcasts through a GPL component for no reason.
    const registry = buildRegistry(TOOLS_WITH_EXTRACTOR, true);
    for (const { label, input, expect } of INPUTS_THAT_MUST_WORK) {
      const resolved = await registry.resolve(input);
      assert.equal(resolved.id, expect, `${label} should STILL resolve to ${expect}`);
    }
  });

  it('scores the GPL adapter strictly below every licence-clean adapter', () => {
    const tools = TOOLS_WITH_EXTRACTOR;
    const ytdlp = new YtDlpSource({ tools, cwd: '/tmp' });
    const direct = new DirectHttpSource({ tools, cwd: '/tmp' });
    const rss = new RssSource();

    const url = 'https://example.com/ep.mp3';
    assert.ok(
      ytdlp.match(url) < direct.match(url),
      'the GPL fallback must never outrank the direct HTTP adapter',
    );
    const feed = 'https://example.com/feed.rss';
    assert.ok(ytdlp.match(feed) < rss.match(feed), 'the GPL fallback must never outrank RSS');
  });

  it('falls through to the extractor only AFTER the clean adapters actually decline', async () => {
    // D-01 §6.4: the decision is made by probing, not by URL shape. A watch-page URL
    // looks exactly like a direct link until the server answers, so DirectHttpSource is
    // tried first and only its failure hands over to the GPL adapter.
    const registry = buildRegistry(TOOLS_WITH_EXTRACTOR, true);
    const tried: string[] = [];

    registry.register(stubSource('direct-http', 80, tried, new Error('not a media file (text/html)')));
    registry.register(stubSource('rss', 20, tried, new Error('not a feed')));
    registry.register(stubSource('yt-dlp', 10, tried, null), true);

    const info = await registry.probe('https://video.example.com/watch?v=abc123', AbortSignal.timeout(5000));
    assert.equal(info.producedBy, 'yt-dlp');
    assert.deepEqual(tried, ['direct-http', 'rss', 'yt-dlp'], 'clean adapters must be tried first');
  });

  it('never reaches the extractor when a clean adapter succeeds', async () => {
    const registry = buildRegistry(TOOLS_WITH_EXTRACTOR, true);
    const tried: string[] = [];
    registry.register(stubSource('direct-http', 80, tried, null));
    registry.register(stubSource('yt-dlp', 10, tried, null), true);

    const info = await registry.probe('https://example.com/ep.mp3', AbortSignal.timeout(5000));
    assert.equal(info.producedBy, 'direct-http');
    assert.deepEqual(tried, ['direct-http'], 'the GPL adapter must not even be consulted');
  });

  it('gives actionable remediation instead of a crash when the extractor is gone', async () => {
    const registry = buildRegistry(TOOLS_WITHOUT_EXTRACTOR, false);
    const tried: string[] = [];
    registry.register(stubSource('direct-http', 80, tried, new Error('not a media file')));
    registry.register(stubSource('rss', 20, tried, new Error('not a feed')));

    await assert.rejects(
      () => registry.probe('https://video.example.com/watch?v=abc123', AbortSignal.timeout(5000)),
      (err: unknown) => {
        assert.ok(err instanceof NoMediaSourceError, 'should be a typed error');
        // D-01 §4.1: a blocked state must be actionable, not a raw stack trace.
        assert.match(err.remediation, /direct audio\/video file URL|podcast|from your computer/i);
        return true;
      },
    );
  });

  it('can toggle the adapter at runtime with no re-registration', async () => {
    // The zero-code-change rollback path ADR-002 asks for.
    const registry = buildRegistry(TOOLS_WITH_EXTRACTOR, true);
    const tried: string[] = [];
    registry.register(stubSource('direct-http', 80, tried, new Error('not a media file')));
    registry.register(stubSource('rss', 20, tried, new Error('not a feed')));
    registry.register(stubSource('yt-dlp', 10, tried, null), true);

    const url = 'https://video.example.com/watch?v=x';
    assert.equal((await registry.probe(url, AbortSignal.timeout(5000))).producedBy, 'yt-dlp');

    registry.setEnabled('yt-dlp', false);
    await assert.rejects(() => registry.probe(url, AbortSignal.timeout(5000)));
  });
});


/** Minimal adapter double: records that it was consulted, then succeeds or declines. */
function stubSource(
  id: 'direct-http' | 'rss' | 'yt-dlp' | 'local-file',
  score: number,
  tried: string[],
  failWith: Error | null,
): MediaSource {
  return {
    id,
    kind: 'media-source',
    license: 'NOASSERTION',
    match: () => score,
    isAvailable: async () => ({ ok: true }),
    probe: async () => {
      tried.push(id);
      if (failWith !== null) throw failWith;
      return {
        sourceKey: 'stub',
        title: null,
        durationMs: null,
        description: null,
        thumbnailUrl: null,
        uploader: null,
        publishedAt: null,
        tracks: [],
        isCollection: false,
        producedBy: id,
      };
    },
    fetch: async () => {
      throw new Error('not used in this test');
    },
  };
}

describe('registry robustness', () => {
  it('a throwing adapter cannot take the registry down', async () => {
    const registry = buildRegistry(TOOLS_WITH_EXTRACTOR, true);
    registry.register({
      id: 'direct-http',
      kind: 'media-source',
      license: 'NOASSERTION',
      match: () => {
        throw new Error('boom');
      },
      isAvailable: async () => ({ ok: true }),
      probe: async () => {
        throw new Error('never');
      },
      fetch: async () => {
        throw new Error('never');
      },
    });
    // RSS still handles the feed even though another adapter is broken.
    assert.equal((await registry.resolve('https://example.com/feed.rss')).id, 'rss');
  });
});
