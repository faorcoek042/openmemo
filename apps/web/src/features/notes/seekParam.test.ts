import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseSeekParam } from './seekParam';

/**
 * `?t=` 的解析与夹取。
 *
 * ## 为什么这一族要单测而不是只靠组件测试
 *
 * `?t=` 的三个边界里只有"超出时长"是纯计算，而它恰恰是**最容易被"能跳就收工"漏掉**的一个：
 * 正常链接怎么点都对，越界链接只有在录音被重新转写、或者有人手改 URL 时才出现，
 * 而那时的表现是「跳到一个说不清的位置」——没有任何东西会报错。
 *
 * 判据统一是：**"跳错地方"必须和"没跳"区分得开**。
 * 所以越界返回的是 `clamped`（调用方据此说话），不是悄悄给一个 0。
 */
describe('parseSeekParam —— ?t= 的解析', () => {
  test('没有参数 → absent，不许产出一个"跳到 0"的动作', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const r = parseSeekParam(raw, 600_000);
      assert.equal(r.reason, 'absent', `${JSON.stringify(raw)} 应当被判成"没有这个参数"`);
      assert.equal(r.ms, null, '没有参数时绝不能动播放器 —— 跳到 0 会覆盖用户已有的播放位置');
    }
  });

  test('正常值 → ok，原样透传（搜索页发的就是整数毫秒）', () => {
    const r = parseSeekParam('754000', 3_600_000);
    assert.equal(r.reason, 'ok');
    assert.equal(r.ms, 754_000);
  });

  test('★ 坏参数一律 malformed 且不跳 —— 不许把 "12abc" 当成 12', () => {
    /*
     * 这条钉的是 `parseInt` 与 `Number` 的差别。
     * `parseInt('12abc')` 给 12，也就是把一个明显坏掉的参数**当成有效值**用：
     * 用户会被送到 0:00.012，而界面上看不出这是参数坏了还是功能没接。
     */
    for (const raw of ['abc', '12abc', 'NaN', '1e', '--5', ' ']) {
      const r = parseSeekParam(raw, 600_000);
      assert.equal(r.ms, null, `${JSON.stringify(raw)} 不该产生任何跳转`);
    }
    assert.equal(parseSeekParam('12abc', 600_000).reason, 'malformed');
  });

  test('★ 负数是"参数坏了"，不是"想跳到开头"', () => {
    const r = parseSeekParam('-1', 600_000);
    assert.equal(r.reason, 'malformed');
    assert.equal(r.ms, null);
  });

  test('★ Infinity 挡得住（它是有限性判定最常见的漏网之鱼）', () => {
    assert.equal(parseSeekParam('Infinity', 600_000).ms, null);
    assert.equal(parseSeekParam('-Infinity', 600_000).ms, null);
  });

  test('小数四舍五入，不因为手写链接带小数就整条失败', () => {
    assert.equal(parseSeekParam('1500.7', 600_000).ms, 1501);
  });

  test('★ 超出时长 → 夹到末尾，并且**说得出**用户原本要的是多少', () => {
    const r = parseSeekParam('9999000', 600_000);
    assert.equal(r.reason, 'clamped', '越界必须能被调用方识别出来，否则界面只能沉默');
    assert.equal(r.ms, 600_000, '夹到时长本身');
    assert.equal(r.askedMs, 9_999_000, '原始请求值要留下 —— 提示文案要把两个数都说出来');
  });

  test('恰好等于时长不算越界', () => {
    const r = parseSeekParam('600000', 600_000);
    assert.equal(r.reason, 'ok');
    assert.equal(r.ms, 600_000);
  });

  test('★ 时长未知（转写中的笔记 durationMs 为 0）→ 不夹取', () => {
    /*
     * 拿一个未知的上界去夹，只会把**对的值**夹坏：durationMs=0 时若照夹，
     * 每一条搜索结果都会被夹成 0，正好复现"点了从头开始播"这个原始缺陷。
     */
    for (const duration of [0, -1]) {
      const r = parseSeekParam('754000', duration);
      assert.equal(r.reason, 'ok', `duration=${duration} 时不该夹取`);
      assert.equal(r.ms, 754_000);
    }
  });
});
