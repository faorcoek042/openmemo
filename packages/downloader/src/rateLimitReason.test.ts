/**
 * `httpFailureReason()` 的守卫 —— **一句「问不到上游」和一句「等 3 分钟再试」，
 * 对用户的价值差一个数量级**，而这里钉的就是那个差别。
 *
 * 背景（#100）：上游**每一次响应**都带 `x-ratelimit-remaining`，而我们原来只在
 * 403/429 时把它变成一句写死的 `rate limited by upstream (HTTP 403)` ——
 * 那句话既**不可执行**（不知道等多久），又在「有配额却 403」时**说了假话**。
 *
 * 这份用例分三组，对应本条的三条要求：
 *   ① 说得出等多久时，真的说出来；
 *   ② **配额与成败不许塌成一件事**（含反向鉴别：有配额的 403 不许被叫成限流）；
 *   ③ **算不出时间就不许编时间**。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { httpFailureReason, type RateLimitSnapshot } from './upstream.js';

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);

const snap = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({
  remaining: null,
  limit: null,
  resetAtMs: null,
  retryAfterMs: null,
  resource: null,
  ...over,
});

/**
 * `[实测 2026-08-12]` 一个**真的**被限流的 403 长这样（同机真请求抓下来的头）：
 *
 *   x-ratelimit-limit:10  x-ratelimit-remaining:0  x-ratelimit-reset:1786528992
 *   x-ratelimit-resource:search   （**没有** retry-after）
 *
 * 用真形状而不是我想象的形状 —— 两条会写错的细节都在这里面：
 * `limit` 不是常数 60（这个桶是 10），主配额限流**不带** `retry-after`。
 */
const REAL_403 = snap({
  remaining: 0,
  limit: 10,
  resetAtMs: NOW + 3 * 60_000,
  resource: 'search',
});

describe('① 说得出等多久，就真的说出来', () => {
  it('主配额用尽 + 有 reset ⇒ 给出可执行的等待时间', () => {
    const r = httpFailureReason(403, REAL_403, NOW);
    assert.match(r, /配额已用尽/, r);
    assert.match(r, /约 3 分钟后恢复/, r);
  });

  it('把上游读到的 limit 照说，**不写死 60**（这个桶实测是 10）', () => {
    const r = httpFailureReason(403, REAL_403, NOW);
    assert.match(r, /每小时 10 次/, r);
    assert.equal(/60/.test(r), false, `把文档里的 60 写死进来了：${r}`);
  });

  it('不足一分钟时说秒，不四舍五入成「0 分钟」', () => {
    const r = httpFailureReason(403, snap({ remaining: 0, resetAtMs: NOW + 40_000 }), NOW);
    assert.match(r, /约 40 秒后恢复/, r);
  });

  it('次级限流带 retry-after 时用它（主配额限流实测不带这个头）', () => {
    const r = httpFailureReason(429, snap({ retryAfterMs: 90_000 }), NOW);
    assert.match(r, /约 2 分钟后可再试/, r);
  });
});

describe('② 配额与成败是两件事，不许塌成一个', () => {
  /*
   * ★★ 本组的反向鉴别腿。403 **不等于**限流：上游对私有/改名仓库、滥用保护也回 403。
   * 原来那句写死的 "rate limited by upstream (HTTP 403)" 在这一格上是**假话** ——
   * 在没有证据的地方给了一个具体的错误原因。
   */
  it('有配额却 403 ⇒ 明说「不是配额问题」，不许叫它限流', () => {
    const r = httpFailureReason(403, snap({ remaining: 55, limit: 60, resource: 'core' }), NOW);
    assert.match(r, /不是配额问题/, r);
    assert.match(r, /还剩 55 次/, r);
    assert.equal(/配额已用尽/.test(r), false, `把一个有配额的 403 说成了配额用尽：${r}`);
  });

  it('配额充足的 403 也不许因为"还剩很多"就说成成功／可重试即好', () => {
    const r = httpFailureReason(403, snap({ remaining: 55 }), NOW);
    // 它仍然是一次失败，状态码必须留在话里，不能被配额那句盖过去
    assert.match(r, /403/, r);
  });

  it('remaining 为 0 但请求**成功**时压根不经过这里 —— 成功路径不调用本函数', () => {
    /*
     * 这一条钉的是形状而不是字符串：`httpFailureReason` 的第一个入参是 `status`，
     * 一次成功的请求没有"失败状态码"可传，所以它在类型上就进不来。
     * `remaining: 0` 的成功请求就是成功的 —— 那个 0 说的是**下一次**。
     * （构造点在 `getJson`：只有 `res.ok === false` 的分支才会抛。）
     */
    assert.equal(typeof httpFailureReason, 'function');
    assert.equal(httpFailureReason.length, 3, '入参少了一个 —— status 与配额必须各占一格');
  });
});

describe('③ 算不出时间就不许编时间', () => {
  it('配额用尽但没有 reset ⇒ 只说用尽，一个数字都不给', () => {
    const r = httpFailureReason(403, snap({ remaining: 0, limit: 60 }), NOW);
    assert.match(r, /配额已用尽/, r);
    assert.match(r, /没给出恢复时刻/, r);
    assert.equal(/分钟|秒/.test(r), false, `凭空编了一个等待时间：${r}`);
  });

  it('reset 已经是过去时 ⇒ 同样不给时间（不许出现「约 -3 分钟」）', () => {
    const r = httpFailureReason(403, snap({ remaining: 0, resetAtMs: NOW - 3 * 60_000 }), NOW);
    assert.equal(/-/.test(r), false, `算出了负数还照说：${r}`);
    assert.match(r, /没给出恢复时刻/, r);
  });

  it('上游一个配额头都没给（npm / HuggingFace 就是这样）⇒ 如实说判断不了', () => {
    const r = httpFailureReason(403, snap(), NOW);
    assert.match(r, /判断不了/, r);
    assert.equal(/配额已用尽/.test(r), false, `没有证据却宣布了配额用尽：${r}`);
  });
});
