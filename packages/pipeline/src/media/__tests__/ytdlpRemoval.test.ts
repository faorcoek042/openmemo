/**
 * TD-002 proof: the product works without the GPL component.
 *
 * ADR-002 says yt-dlp must be "architecturally replaceable". `oss-scout` correctly
 * objected that this was only asserted in comments. These tests are the enforcement:
 * they disable the adapter and assert that real-world inputs still resolve.
 *
 * Run: `pnpm --filter @openmemo/pipeline test`（T-135 之前本包**没有 test 脚本**，
 * 见下面第 3 节 —— 这几条从写下来到 2026-08-03 为止，没有被任何人跑过一次）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 读这个文件的人请先读完这一段：**它覆盖什么、不覆盖什么**（T-135 补写）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## 1. 这 7 条**不足以**宣布「TD-002 已验证」—— 这句话是用事故换来的
 *
 * TD-002 曾经被**过早关闭过一次**：当时基于一条通过的测试就宣布
 * 「GPL 组件在架构上可替换」已验证，后来发现**产品的真实导入路径根本没走那条链**，
 * GPL 兜底在真实路径上从未触发过（HANDOFF ⑤A-11）。
 *
 * **下面这 7 条仍然带着同一个形状的缺口。** 具体是：
 *
 * 本文件的 `buildRegistry()`（就在下面几行）是把产品的
 * `buildDefaultRegistry()`（`packages/pipeline/src/index.ts`）**手抄了一份**，
 * 并且把 `enableExtractor` 作为参数由用例自己传。于是：
 *
 * - 产品那边把 `enableSiteExtractor` 的默认值改掉 → **这 7 条全不变色**；
 * - 产品那边改注册顺序、少注册一个适配器、换掉某个 `match()` 分数 → **同样不变色**；
 * - 产品那边（daemon）把整个站点提取器默认关掉 → **同样不变色**。
 *
 * 而最后那一条**真的发生过**：T-132 实测查明，F1「粘链接导入」当时断掉的那道闸门
 * 正是 daemon 侧的 `siteExtractorEnabled()` 默认关着 —— 自检报 `ok | tool.ytDlp`、
 * 磁盘上 yt-dlp 装得好好的，而 `POST /api/notes/probe` 回 422，
 * `tried:` 列表里**连 yt-dlp 都不出现**。**绿灯亮着，功能是死的。**
 *
 * ## 2. 所以这 7 条到底证明了什么（如实说清边界）
 *
 * ✅ 证明了：**`MediaSourceRegistry` 这一层**在没有 GPL 适配器时仍能解析全部核心输入，
 *    且 licence-clean 的适配器在评分上永远排在 GPL 适配器前面（这是有价值的，别删）。
 * ❌ **没有**证明：产品真实装配出来的那个 registry 是这么配的。
 * ❌ **没有**证明：daemon 真的会把站点提取器注册进去。
 *
 * 后两条今天由 `apps/daemon/src/pipeline/ytdlpInstall.test.ts` 从 daemon 那一层补上了
 * （T-132，**而且它真的会跑**）。**两边合起来才算验过；只看这一边就是重演当年那次事故。**
 *
 * ## 3. 顺带记一条同样重要的
 *
 * 这 7 条从写下来那天起**一次都没被跑过** —— `packages/pipeline` 当时没有 `test` 脚本，
 * `pnpm -r test` 自然扫不到它（`ytdlp-install` 在 T-132 里顺手发现，T-135 补上）。
 * **"为一次事故补了回归测试"和"那些回归测试真的在跑"是两件事。**
 *
 * → 最小改进（尚未做，需 `gpu-runtime` 裁决）：让下面的 `buildRegistry()` 改调
 *   `buildDefaultRegistry()`，把"产品怎么装配"这件事也纳进来。
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

/**
 * yt-dlp present and executable.
 *
 * ★ T-147: this used to be the literal `'/bin/sh'`, with the comment
 * "/bin/sh always is". That is a **host assumption**, not a fact: `registry.resolve()`
 * → `isAvailable()` → `isExecutable()` → `access(path, X_OK)`, and on Windows
 * `D:\bin\sh` does not exist, so every adapter reports unavailable and all four
 * resolution tests below die with `NoMediaSourceError` — i.e. on Windows this file
 * would not have been testing adapter selection at all.
 *
 * `process.execPath` is the node binary currently running this test: it exists and is
 * executable **by construction** on every platform, and we never spawn it here either.
 */
const ANY_REAL_EXECUTABLE = process.execPath;
const TOOLS_WITH_EXTRACTOR: ToolPaths = {
  ffmpeg: ANY_REAL_EXECUTABLE,
  ffprobe: ANY_REAL_EXECUTABLE,
  whisperCli: null,
  whisperVad: null,
  vadModel: null,
  ytDlp: ANY_REAL_EXECUTABLE,
};

/** The shipping-without-GPL configuration. */
const TOOLS_WITHOUT_EXTRACTOR: ToolPaths = { ...TOOLS_WITH_EXTRACTOR, ytDlp: null };

/**
 * ⚠️ **这是 `buildDefaultRegistry()`（`../../index.ts`）的手抄副本，不是它本身。**
 *
 * 文件头第 1 节讲的缺口就在这里：产品那边改了装配（默认值、注册顺序、少注册一个），
 * 这份副本**不会跟着变**，下面 7 条照样全绿。
 * 改动这个函数之前请先读文件头 —— 那段话是一次已经发生过的事故换来的。
 */
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
  {
    label: 'podcast MP3 direct link',
    input: 'https://example.com/episodes/ep42.mp3',
    expect: 'direct-http',
  },
  { label: 'CDN m4a', input: 'https://cdn.example.org/audio/lecture.m4a', expect: 'direct-http' },
  {
    label: 'public-domain OGG',
    input: 'https://upload.wikimedia.org/wikipedia/commons/7/7c/x.ogg',
    expect: 'direct-http',
  },
  {
    label: 'HLS playlist',
    input: 'https://stream.example.com/live/index.m3u8',
    expect: 'direct-http',
  },
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

    registry.register(
      stubSource('direct-http', 80, tried, new Error('not a media file (text/html)')),
    );
    registry.register(stubSource('rss', 20, tried, new Error('not a feed')));
    registry.register(stubSource('yt-dlp', 10, tried, null), true);

    const info = await registry.probe(
      'https://video.example.com/watch?v=abc123',
      AbortSignal.timeout(5000),
    );
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
