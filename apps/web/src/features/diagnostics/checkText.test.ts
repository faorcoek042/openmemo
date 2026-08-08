/**
 * T-173：自检文案的语言选择 —— 守的是**回退方向**。
 *
 * 英文界面拿不到英文版时必须回退到中文原文，**不许回退到空**。
 * 回退成空会让一条真实的告警在英文界面上消失，而中文界面上永远看不出来 ——
 * 那正是本次修复要消灭的形状（"坏了不吭声"），只是换了个地方发生。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickCheckRemediation, pickCheckText } from './checkText';

const ZH = '已暂时停用：metal（连续 3 次探测失败）。将在约 4 分钟后自动重试。';
const EN =
  'Temporarily disabled: metal (3 consecutive probe failures). Automatic retry in about 4 min.';

describe('T-173 自检文案的语言选择', () => {
  it('中文界面永远拿中文原文', () => {
    assert.equal(pickCheckText(true, ZH, EN), ZH);
    assert.equal(pickCheckText(true, ZH, undefined), ZH);
  });

  it('英文界面有英文版就用英文版', () => {
    assert.equal(pickCheckText(false, ZH, EN), EN);
  });

  it('★ 英文界面没有英文版时回退到中文原文，绝不回退到空', () => {
    // 旧的 24 条检查项就是这一支。难看，但告警还在。
    assert.equal(pickCheckText(false, ZH, undefined), ZH);
    assert.equal(pickCheckText(false, ZH, ''), ZH);
  });

  it('remediation 为 null 时保持 null（没什么要做的，不该渲染那一行）', () => {
    assert.equal(pickCheckRemediation(true, null, null), null);
    assert.equal(pickCheckRemediation(false, null, undefined), null);
  });

  it('remediation 的回退方向与 detail 一致', () => {
    assert.equal(
      pickCheckRemediation(false, '去装后端包', 'Install a backend pack'),
      'Install a backend pack',
    );
    assert.equal(pickCheckRemediation(false, '去装后端包', null), '去装后端包');
    assert.equal(pickCheckRemediation(false, '去装后端包', undefined), '去装后端包');
    assert.equal(pickCheckRemediation(true, '去装后端包', 'Install a backend pack'), '去装后端包');
  });
});
