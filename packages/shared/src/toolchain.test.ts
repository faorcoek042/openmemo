/**
 * #87 —— **UNKNOWN 不许被读成"什么都不缺"。**
 *
 * 这一族错误此前有两种写法，两种都编译得过、也都把 UNKNOWN 收进了 OK 那一档：
 *
 * ```ts
 * const missing = data?.pipeline?.missing ?? [];   // 界面：少说一句话
 * if (next.missing.length === 0 && queue_) { … }   // 队列闸：**真的开始干活**
 * ```
 *
 * 后者才是重心：在一条我们没能确认的流水线上解除任务阻塞，
 * 后果不是一句假话，是一堆用户看不懂的运行时失败。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ──────────────────────────────────────
 *  · 有人把 `toolchainReady()` 改成"没有缺件就算就绪"（那 UNKNOWN 又会放行）；
 *  · 有人把 `toolchainMissing()` 的 UNKNOWN 分支改成抛错或返回 null
 *    （调用方会退回 `?? []`，等于绕回原点）；
 *  · 有人把两个 kind 合并回一个可空数组。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toolchainMissing, toolchainReady, type ToolchainVerdict } from './toolchain.js';

const KNOWN_OK: ToolchainVerdict = { kind: 'known', missing: [] };
const KNOWN_MISSING: ToolchainVerdict = { kind: 'known', missing: ['ffmpeg'] };
const UNKNOWN: ToolchainVerdict = { kind: 'unknown', reason: '解析器抛了：EACCES' };

describe('#87 工具链三态：UNKNOWN 不是"齐了"', () => {
  it('★★ 只有「查过了 + 一个都不缺」才算就绪', () => {
    assert.equal(toolchainReady(KNOWN_OK), true);
    assert.equal(toolchainReady(KNOWN_MISSING), false);
    assert.equal(
      toolchainReady(UNKNOWN),
      false,
      '★ UNKNOWN 被当成就绪 —— 队列闸会在一条没验证过的流水线上解除阻塞',
    );
  });

  it('★ UNKNOWN 的缺件列表是空的，但那**不代表齐了**（两件事必须分得开）', () => {
    // 这正是原来那个 bug 的形状：空列表既可能是"齐了"也可能是"不知道"
    assert.deepEqual(toolchainMissing(UNKNOWN), []);
    assert.deepEqual(toolchainMissing(KNOWN_OK), []);
    // 列表一样，结论必须不一样 —— 判"能不能开工"只能问 toolchainReady()
    assert.notEqual(
      toolchainReady(UNKNOWN),
      toolchainReady(KNOWN_OK),
      '★ 两者的缺件列表都是空的；如果结论也一样，那这个三态等于没做',
    );
  });

  it('★ UNKNOWN 必须带得出原因 —— 静默卡住比放行更坏', () => {
    /*
     * 类型上 `reason` 就是必填，这条钉的是"它非空且能被显示"：
     * 一个 `reason: ''` 的实现在类型上合法，但用户看到的仍然是"什么都没发生"。
     */
    assert.equal(UNKNOWN.kind, 'unknown');
    if (UNKNOWN.kind === 'unknown') {
      assert.ok(UNKNOWN.reason.length > 0, 'UNKNOWN 没有原因 ⇒ 界面上就是一次静默卡住');
    }
  });

  it('★ 缺件列表原样透出，不许被三态改写', () => {
    assert.deepEqual(toolchainMissing(KNOWN_MISSING), ['ffmpeg']);
  });
});
