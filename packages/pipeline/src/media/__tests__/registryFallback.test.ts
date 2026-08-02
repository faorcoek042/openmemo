/**
 * Regression test: the pipeline must use the probe-FALLBACK path, not resolve()+probe().
 *
 * BUG THIS GUARDS (found during the T-025 long-audio run): TranscribePipeline called
 * `registry.resolve()` and then `source.probe()` separately. That silently bypassed the
 * candidate walk, with two consequences:
 *   1. the GPL fallback could never actually engage during a real import — the whole
 *      TD-002 resolution order was decorative in the one code path that mattered;
 *   2. a transient network error on the first candidate failed the entire job instead of
 *      trying the next adapter. That is exactly how it surfaced: a connect timeout to
 *      one CDN aborted a run that had a perfectly good fallback available.
 *
 * Run: node --test packages/pipeline/dist/media/__tests__/registryFallback.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaSourceRegistry } from '../registry.js';
import type { MediaSource, MediaSourceId } from '../types.js';

function stub(
  id: MediaSourceId,
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
        sourceKey: id, title: null, durationMs: null, description: null,
        thumbnailUrl: null, uploader: null, publishedAt: null, tracks: [],
        isCollection: false, producedBy: id,
      };
    },
    fetch: async () => {
      throw new Error('not used');
    },
  };
}

describe('probeWithSource — fallback walk', () => {
  it('returns the adapter that actually succeeded, not the highest-scoring one', async () => {
    const tried: string[] = [];
    const r = new MediaSourceRegistry();
    r.register(stub('direct-http', 80, tried, new Error('connect timeout')));
    r.register(stub('yt-dlp', 10, tried, null));

    const { source, info } = await r.probeWithSource('https://x.example/watch', AbortSignal.timeout(5000));
    assert.equal(source.id, 'yt-dlp', 'must hand back the adapter that worked');
    assert.equal(info.producedBy, 'yt-dlp');
    assert.deepEqual(tried, ['direct-http', 'yt-dlp']);
  });

  it('survives a transient network failure on the first candidate', async () => {
    const tried: string[] = [];
    const r = new MediaSourceRegistry();
    // The exact shape of the failure that broke a real run.
    const timeout = new Error('fetch failed');
    (timeout as Error & { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    r.register(stub('direct-http', 80, tried, timeout));
    r.register(stub('rss', 20, tried, null));

    const { source } = await r.probeWithSource('https://x.example/a.mp3', AbortSignal.timeout(5000));
    assert.equal(source.id, 'rss', 'a transient error must not fail the whole job');
  });

  it('propagates abort instead of walking the rest of the list', async () => {
    const tried: string[] = [];
    const ac = new AbortController();
    const r = new MediaSourceRegistry();
    r.register({
      ...stub('direct-http', 80, tried, null),
      probe: async () => {
        tried.push('direct-http');
        ac.abort();
        throw new Error('aborted');
      },
    });
    r.register(stub('yt-dlp', 10, tried, null));

    await assert.rejects(() => r.probeWithSource('https://x.example/a', ac.signal));
    assert.deepEqual(tried, ['direct-http'], 'a cancelled job must stop, not try everything else');
  });
});
