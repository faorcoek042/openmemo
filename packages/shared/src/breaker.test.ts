/**
 * 断路器措辞（T-174）—— 分档边界与"不许编时间"两件事。
 *
 * ## 为什么这些句子值得一个测试文件
 *
 * 它们是**跳闸时用户唯一能看到的东西**。断路器一开，GPU 加速就没了，
 * 而产品层面除了这几句话没有任何别的解释 —— 说错一个数字，用户就会去等一个
 * 永远不会到的时刻，或者以为机器坏了。
 *
 * `packages/runtime/src/selfcheck.test.ts` 已经钉了**整句**的样子（`将在约 4 分钟后自动重试`），
 * 那是集成侧。这里钉的是它够不着的两个面：
 *   1. **分档边界**（秒/分钟/小时的切换点）—— 集成测试只喂了一个 4 分钟的样本；
 *   2. **`now` 可注入**，所以"还剩多久"这件事是可判定的，不靠跑得快不快。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  breakerAdvice,
  breakerDetail,
  breakerManualRetryHint,
  breakerRemediation,
  breakerRetryPhrase,
  breakerTripped,
  type BreakerCopyInput,
} from './breaker.js';

const NOW = Date.parse('2026-08-08T00:00:00.000Z');

function input(over: Partial<BreakerCopyInput> = {}): BreakerCopyInput {
  return {
    blacklistedBackends: ['cuda', 'metal'],
    consecutiveFailures: 2,
    lastError: 'probe timed out after 10000ms (killed).',
    retryAt: new Date(NOW + 60_000).toISOString(),
    recovering: false,
    ...over,
  };
}

/** `now + ms` 的 ISO 串。 */
const at = (ms: number): string => new Date(NOW + ms).toISOString();

describe('breakerTripped —— 两个出口共用的那个判据', () => {
  it('只有"裁决 closed 且没有被停用的后端"才算没事', () => {
    assert.equal(breakerTripped('closed', []), false);
    assert.equal(breakerTripped('open', []), true);
    assert.equal(breakerTripped('recover', []), true);
    // closed 但还挂着停用列表 —— 状态自相矛盾，**不许静默放行**
    assert.equal(breakerTripped('closed', ['cuda']), true);
  });

  it('★ 认不出来的 verdict 一律当"停用中"，不许当成没事', () => {
    // 静默放行正是本次要消灭的东西：新增一个裁决值就让提示消失，是最坏的失败方式
    for (const v of ['', 'CLOSED', 'half-open', 'unknown']) {
      assert.equal(breakerTripped(v, []), true, `verdict=${JSON.stringify(v)} 被静默放行了`);
    }
  });
});

describe('breakerRetryPhrase —— 分档边界', () => {
  it('秒档：< 90 秒说秒', () => {
    assert.equal(
      breakerRetryPhrase(input({ retryAt: at(58_000) }), NOW).zh,
      '将在约 58 秒后自动重试。',
    );
    assert.equal(
      breakerRetryPhrase(input({ retryAt: at(58_000) }), NOW).en,
      'Automatic retry in about 58s.',
    );
  });

  it('★ 89 秒还是秒，90 秒就该进分钟档（边界不许漂）', () => {
    assert.match(breakerRetryPhrase(input({ retryAt: at(89_000) }), NOW).zh, /89 秒/);
    assert.match(breakerRetryPhrase(input({ retryAt: at(90_000) }), NOW).zh, /分钟/);
  });

  it('分钟档四舍五入到整分钟', () => {
    assert.equal(
      breakerRetryPhrase(input({ retryAt: at(240_000) }), NOW).zh,
      '将在约 4 分钟后自动重试。',
    );
    assert.equal(
      breakerRetryPhrase(input({ retryAt: at(240_000) }), NOW).en,
      'Automatic retry in about 4 min.',
    );
  });

  it('★ 退避到 1 小时封顶那一档说的是小时（89 分钟 vs 90 分钟）', () => {
    assert.match(breakerRetryPhrase(input({ retryAt: at(89 * 60_000) }), NOW).zh, /89 分钟/);
    assert.match(breakerRetryPhrase(input({ retryAt: at(90 * 60_000) }), NOW).zh, /小时/);
    assert.match(breakerRetryPhrase(input({ retryAt: at(60 * 60_000) }), NOW).en, /about 60 min/);
  });

  it('正在重试时说"正在重试"，不是一个假的倒计时', () => {
    const p = breakerRetryPhrase(input({ recovering: true, retryAt: at(240_000) }), NOW);
    assert.match(p.zh, /正在重试/);
    assert.match(p.en, /Retrying now/);
    // recovering 优先于 retryAt：后台那一发已经在跑了，再报"还有 4 分钟"就是错的
    assert.equal(/\d/.test(p.zh), false, '正在重试时不该出现任何倒计时数字');
  });

  it('★ retryAt 缺失或坏掉时如实说"没记录"，绝不编一个时间出来', () => {
    for (const bad of [null, 'not-a-date', '']) {
      const p = breakerRetryPhrase(input({ retryAt: bad }), NOW);
      assert.match(p.zh, /重试时刻未记录/, `retryAt=${JSON.stringify(bad)}`);
      assert.match(p.en, /No retry time recorded/);
    }
  });

  it('冷却已到期（retryAt 在过去）说的是"就会重试"，不是负数倒计时', () => {
    const p = breakerRetryPhrase(input({ retryAt: at(-5_000) }), NOW);
    assert.match(p.zh, /冷却已到期/);
    assert.match(p.en, /Cooldown has elapsed/);
  });
});

describe('breakerDetail —— 三件事必须凑齐', () => {
  it('说得出停用了什么、为什么、多久之后重试', () => {
    const d = breakerDetail(input(), NOW);
    assert.match(d.zh, /cuda、metal/);
    assert.match(d.en, /cuda, metal/);
    assert.match(d.zh, /连续 2 次探测失败/);
    assert.match(d.en, /2 consecutive probe failures/);
    // 60 s 仍在"秒"档（分档阈值是 90 s，不是 60 s）—— 这条曾经写成"1 分钟"，被对照组抓到
    assert.match(d.zh, /将在约 60 秒后自动重试/);
  });

  it('拿不到后端列表/原因时说"未列出"，不是渲染出一个空括号', () => {
    const d = breakerDetail(input({ blacklistedBackends: [], lastError: null }), NOW);
    assert.match(d.zh, /（未列出）/);
    assert.match(d.zh, /未记录原因/);
    assert.match(d.en, /\(not listed\)/);
    assert.match(d.en, /no reason recorded/);
  });

  it('★ 英文版里不许混中文（探针原文那段英文除外，它本来就是英文）', () => {
    const d = breakerDetail(input(), NOW);
    assert.equal(
      /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/.test(d.en),
      false,
      `英文版混入中文：${d.en}`,
    );
    assert.equal(/[一-鿿]/.test(d.zh), true, '中文版反而没有中文？');
  });
});

describe('remediation 的拆分 —— 界面用建议，CLI 用建议 + URL', () => {
  it('★ 拼起来必须逐字等于自检那一整句（拼接规则只有一份）', () => {
    const full = breakerRemediation();
    assert.equal(full.zh, `${breakerAdvice().zh}${breakerManualRetryHint().zh}`);
    assert.equal(full.en, `${breakerAdvice().en} ${breakerManualRetryHint().en}`);
  });

  it('建议那一支不含 URL —— 界面上那条 URL 的位置是一个真的按钮', () => {
    assert.equal(breakerAdvice().zh.includes('/api/'), false);
    assert.equal(breakerAdvice().en.includes('/api/'), false);
    assert.match(breakerManualRetryHint().zh, /\?reset=1/);
  });

  it('两种语言都告诉用户"不用你动手"', () => {
    assert.match(breakerRemediation().zh, /自动重试/);
    assert.match(breakerRemediation().en, /automatically/);
    assert.equal(/[一-鿿]/.test(breakerRemediation().en), false);
  });
});
