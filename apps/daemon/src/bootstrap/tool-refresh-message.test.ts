/**
 * 守卫：那一行**不可能再被读反**。
 *
 * 用户原话：「无 就是没有的意思啊，还是没有工具啊？」——
 * 他读的是 `missing [asr-model] → [无]`，而 `[无]` 其实是好消息（缺失列表空了）。
 *
 * 这组用例钉的是**措辞的性质**，不是某一句具体的话（措辞可以改，性质不能破）：
 * 状态词不许进列表位、三个方向都要说得出、数量为 0 不许进"缺 N 项"的句式。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toolRefreshMessage } from './tool-refresh-message.js';

describe('工具表热刷新那一行的措辞', () => {
  it('★ 装齐了：必须是一句完整的好消息，不能只甩一个状态词', () => {
    const s = toolRefreshMessage(['asr-model'], []);
    assert.equal(/装齐|不缺/.test(s), true, `没说清"装齐了"：${s}`);
    /*
     * ★★ 这条是本次事故的直接复现：`[无]` 这种"状态词占着名字的位置"的写法
     *    一旦回来，这里当场红。方括号里只允许出现名字。
     */
    assert.equal(
      /[[（(]\s*(无|空|none|N\/A)\s*[\])）]/.test(s),
      false,
      `状态词又被塞进列表位：${s}`,
    );
  });

  it('★ 装齐了：不许出现「缺 0 项」这种读法（0 是这一族里最危险的）', () => {
    const s = toolRefreshMessage(['a', 'b'], []);
    assert.equal(/缺\s*0\s*项/.test(s), false, `出现了"缺 0 项"：${s}`);
  });

  it('★ 从齐到缺：要说得出这是**变坏**了，并列出名字与数量', () => {
    const s = toolRefreshMessage([], ['whisper-cli', 'asr-model']);
    assert.equal(s.includes('whisper-cli'), true);
    assert.equal(s.includes('asr-model'), true);
    assert.equal(/缺\s*2\s*项/.test(s), true, `没给出数量：${s}`);
  });

  it('★ 中间态：仍然缺时，前后的数量与名字都要给全，不让读者比对两个括号', () => {
    const s = toolRefreshMessage(['whisper-cli', 'asr-model'], ['asr-model']);
    assert.equal(/仍缺\s*1\s*项/.test(s), true, `没说清还剩几项：${s}`);
    assert.equal(s.includes('asr-model'), true);
    assert.equal(/此前缺\s*2\s*项/.test(s), true, `没交代之前缺几项：${s}`);
  });

  it('★★ 通用性质：任何一支都不许把状态词渲染进方括号/圆括号的列表位', () => {
    const cases: Array<[string[], string[]]> = [
      [[], []],
      [['a'], []],
      [[], ['a']],
      [['a', 'b'], ['b']],
    ];
    for (const [b, a] of cases) {
      const s = toolRefreshMessage(b, a);
      assert.equal(
        /[[（(]\s*(无|空|none|N\/A|-)\s*[\])）]/.test(s),
        false,
        `before=${JSON.stringify(b)} after=${JSON.stringify(a)} 渲染出了状态词占位：${s}`,
      );
    }
  });
});
