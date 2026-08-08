/**
 * 上游下限的判定逻辑 —— **在 Linux 上把 macOS 的三档验掉**。
 *
 * ## 为什么这个文件必须存在
 *
 * 真机那一格（"一台 13.3 的 Mac 上自检确实这么说"）在托管 runner 上**结构性验不了**，
 * 而这正是最容易被拿来当借口的地方：验不了 → 没人写测试 → 判定逻辑写错了也没人知道，
 * 直到某个用户在 13.3 上看到一句错话。
 *
 * 所以判定被做成**纯函数**：喂版本号进去、拿判定出来。真机那一格标
 * `[未验证:需真 Mac]`，但"喂 13.3 应该得到什么"这件事有人守。
 *
 * ## 判据来源
 *
 * `[CI 实测 2026-08-08 run 31204790920]`：`vec0.dylib` minos **14.0.0**、
 * `libonnxruntime*.dylib` minos **15.5.0**。README 承诺 macOS arm64 ≥ **13.3**。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MACOS_FLOORS,
  compareVersions,
  evaluateOsFloors,
  macosFromDarwinRelease,
} from './osFloors.js';

const verdictOf = (version: string | null, id: string): string => {
  const r = evaluateOsFloors(MACOS_FLOORS, version).find((x) => x.floor.id === id);
  assert.ok(r, `没有 ${id} 这一条`);
  return r.verdict;
};

describe('macOS 分层下限：三档各自该说什么', () => {
  it('★ 13.3（我们承诺的下限）—— 两样都不可用，但这是事实不是故障', () => {
    assert.equal(verdictOf('13.3', 'os.macos.semanticSearch'), 'below-floor');
    assert.equal(verdictOf('13.3', 'os.macos.streamingAsr'), 'below-floor');
  });

  it('★ 14.x —— 语义检索回来了，流式 ASR 还差（14.0 ≤ x < 15.5）', () => {
    assert.equal(verdictOf('14.0', 'os.macos.semanticSearch'), 'ok');
    assert.equal(verdictOf('14.6', 'os.macos.semanticSearch'), 'ok');
    assert.equal(verdictOf('14.6', 'os.macos.streamingAsr'), 'below-floor');
  });

  it('★ 15.5+ —— 两样都可用', () => {
    assert.equal(verdictOf('15.5', 'os.macos.semanticSearch'), 'ok');
    assert.equal(verdictOf('15.5', 'os.macos.streamingAsr'), 'ok');
    assert.equal(verdictOf('26.0', 'os.macos.streamingAsr'), 'ok');
  });

  it('★★ 边界必须是「等于下限就算达标」，不是「大于」', () => {
    // 15.5.0 的二进制在 15.5 上跑得起来；写成 > 会把一台完全正常的机器报成不可用
    assert.equal(verdictOf('15.5.0', 'os.macos.streamingAsr'), 'ok');
    assert.equal(verdictOf('15.4.9', 'os.macos.streamingAsr'), 'below-floor');
  });

  it('★★ 取不到版本 → `unknown`，**不许**假设它够新（那会把洞盖回去）', () => {
    assert.equal(verdictOf(null, 'os.macos.semanticSearch'), 'unknown');
    assert.equal(verdictOf('', 'os.macos.semanticSearch'), 'unknown');
    assert.equal(verdictOf('sonoma', 'os.macos.semanticSearch'), 'unknown');
  });

  it('★ 两条下限不是同一个数 —— 别把它们合并成一条', () => {
    const ids = MACOS_FLOORS.map((f) => f.floor);
    assert.deepEqual([...new Set(ids)].sort(), ['14.0', '15.5']);
  });

  it('★ 每条都要说清「丢什么」，且中英都有 —— 少一句用户就得猜', () => {
    for (const f of MACOS_FLOORS) {
      assert.ok(f.losesZh.length > 8, `${f.id} 缺中文说明`);
      assert.ok(f.loses.length > 8, `${f.id} 缺英文说明`);
      assert.ok(f.sourceZh.includes('minos'), `${f.id} 没写下限是谁抬上去的`);
      assert.ok(f.source.includes('minos'), `${f.id} 缺英文来源`);
      // ★ 英文文案里不许嵌中文 —— 本仓栽过（"英文外壳 + 全中文正文"）
      assert.equal(/[\u4e00-\u9fff]/.test(f.source), false, `${f.id} 的英文来源里混了中文`);
      assert.equal(/[\u4e00-\u9fff]/.test(f.loses), false, `${f.id} 的英文说明里混了中文`);
    }
  });
});

describe('版本比较', () => {
  it('逐段比数字，段数不等也要对', () => {
    assert.equal(compareVersions('14', '14.0'), 0);
    assert.equal(compareVersions('14.0.1', '14.0'), 1);
    assert.equal(compareVersions('9.9', '10.0'), -1, '按数字比，不是按字典序');
  });
});

describe('Darwin → macOS 映射', () => {
  it('已知的几代对得上', () => {
    assert.equal(macosFromDarwinRelease('22.6.0'), '13');
    assert.equal(macosFromDarwinRelease('23.6.0'), '14');
    assert.equal(macosFromDarwinRelease('24.0.0'), '15');
  });

  it('★★ Apple 从 16 跳到 26 那一代 —— 证明这里不能用公式', () => {
    assert.equal(macosFromDarwinRelease('25.0.0'), '26', '任何"加 11"的算法都会在这里算错');
  });

  it('★ 未知的一律 null —— 宁可说取不到，也不要猜一个看起来很确定的错版本号', () => {
    assert.equal(macosFromDarwinRelease('99.0.0'), null);
    assert.equal(macosFromDarwinRelease('乱写'), null);
  });
});
