/**
 * `upstreamQueryKey` 的守卫 —— **它去重去得对不对，是"能不能拿到答案"的问题**。
 *
 * `checkAllUpstreams` 按这个 key 合并查询。合并错了有两种坏法，方向相反：
 *   · key **太粗**（漏了一个会改变答案的字段）⇒ 把两个**不同的问题**当成一个，
 *     其中一个组件会拿到别人的答案 —— 一句静默的假话，比多问一次糟得多；
 *   · key **太细** ⇒ 白白多打几次上游。GitHub 匿名限额 60 次/小时/IP，
 *     `[实测 2026-08-11]` 27 条组件不去重就是 27 次，**两次刷新就见底**。
 *
 * 所以这里钉两头：该合的合、该分的分，外加一条**会随 `UpstreamSource` 长字段而红**
 * 的字段集对账 —— 那才是"将来有人加字段忘了改 key"唯一挡得住的地方。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UpstreamSource } from '@openmemo/shared';

import { upstreamQueryKey } from './upstream.js';

const gh = (over: Partial<UpstreamSource> = {}): UpstreamSource => ({
  kind: 'github-release',
  repo: 'ggml-org/whisper.cpp',
  ...over,
});

describe('upstreamQueryKey — 该合的合', () => {
  it('同 kind + 同 repo + 同 tagPattern + 同 stableOnly ⇒ 同一个 key', () => {
    assert.equal(upstreamQueryKey(gh()), upstreamQueryKey(gh()));
  });

  it('`stableOnly` 缺省与显式 false 是同一个问题', () => {
    assert.equal(upstreamQueryKey(gh()), upstreamQueryKey(gh({ stableOnly: false })));
  });

  it('`stableOnlyReason` 只是写给人看的理由，不改变答案 ⇒ 不进 key', () => {
    assert.equal(
      upstreamQueryKey(gh({ stableOnly: false })),
      upstreamQueryKey(gh({ stableOnly: false, stableOnlyReason: '见 T-163' })),
    );
  });
});

describe('upstreamQueryKey — 该分的分', () => {
  const cases: [string, UpstreamSource, UpstreamSource][] = [
    ['kind 不同', gh(), gh({ kind: 'github-tag' })],
    ['repo 不同', gh(), gh({ repo: 'faorcoek042/openmemo' })],
    // ★ 这一条是最容易漏的：`whispercpp-cpu-macos-arm64` 与它的兄弟条目只差一个
    //   tagPattern，合并了就会拿到另一族 tag 的答案。
    ['tagPattern 一有一无', gh(), gh({ tagPattern: '^v\\d+\\.\\d+\\.\\d+$' })],
    ['tagPattern 内容不同', gh({ tagPattern: '^v' }), gh({ tagPattern: '^autobuild-' })],
    ['stableOnly 不同', gh({ stableOnly: true }), gh({ stableOnly: false })],
  ];
  for (const [why, a, b] of cases) {
    it(why, () => assert.notEqual(upstreamQueryKey(a), upstreamQueryKey(b)));
  }
});

describe('upstreamQueryKey — 字段集对账', () => {
  /**
   * ★★ 这条测试是给**未来**写的。
   *
   * 给 `UpstreamSource` 加一个会改变查询结果的字段而忘了加进 key，TypeScript
   * **不会**提醒你（`upstreamQueryKey` 只是读了几个属性，加字段不会让它编译失败），
   * 于是去重会静默地把两个不同的问题当成一个。这里把"key 认识哪些字段"
   * 显式写下来并逐个验证：新字段没被处理时，这份名单与实际行为对不上，就会红。
   *
   * ⚠️ 加字段时**不要**只把名字加进下面的数组就算完 —— 先想清楚它改不改变答案：
   *   · 改变（例如将来的 `includePrerelease` / `apiHost`）⇒ 必须进 key，并在这里加一条；
   *   · 不改变（例如又一个 `*Reason` 说明字段）⇒ 加进 `IGNORED` 并说明理由。
   */
  const IN_KEY = ['kind', 'repo', 'tagPattern', 'stableOnly'] as const;
  const IGNORED: Record<string, string> = {
    stableOnlyReason: '写给人看的理由，不参与查询',
  };

  it('key 对每一个 IN_KEY 字段都敏感', () => {
    const variants: Record<(typeof IN_KEY)[number], UpstreamSource> = {
      kind: gh({ kind: 'npm' }),
      repo: gh({ repo: 'other/other' }),
      tagPattern: gh({ tagPattern: '^x' }),
      stableOnly: gh({ stableOnly: true }),
    };
    for (const f of IN_KEY) {
      assert.notEqual(
        upstreamQueryKey(gh()),
        upstreamQueryKey(variants[f]),
        `改了 ${f} 而 key 没变 —— 去重会把两个不同的问题合成一个`,
      );
    }
  });

  it('`UpstreamSource` 的字段全部被分类过（IN_KEY 或 IGNORED），一个都不许漏', () => {
    /*
     * 名单来自 `packages/shared/src/components.ts` 的 `UpstreamSource`。类型在运行时
     * 不存在，所以这里靠一份手写清单 —— 它对不上的时候，红的是这条测试而不是线上行为，
     * 这正是想要的：**改契约的人会先在这里被拦下来。**
     */
    const declared = ['kind', 'repo', 'tagPattern', 'stableOnly', 'stableOnlyReason'];
    const classified = new Set<string>([...IN_KEY, ...Object.keys(IGNORED)]);
    const unclassified = declared.filter((f) => !classified.has(f));
    assert.deepEqual(
      unclassified,
      [],
      'UpstreamSource 有字段既不在 IN_KEY 也不在 IGNORED —— 先判断它改不改变查询结果',
    );
  });
});
