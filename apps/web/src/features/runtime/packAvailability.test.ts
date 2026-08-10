/**
 * T-196 腿：**同一张卡上不许有两句互相打脸的话。**
 *
 * ── 事故本体 ────────────────────────────────────────────────────────────────
 *
 * `[用户真机 Windows v0.7.0]`「whisper.cpp Vulkan 后端没得下载安装使用」。
 * 真相不是下载失败，是**按钮恒灰、点不动、永远不发请求**：
 * `whispercpp-vulkan-win-x64` 在清单里带着 `availability: "pending-ci"`，
 * `BackendPackCard.tsx:255` 据此 `disabled={installing || !pack.applicable || pendingCi}`，
 * 按钮文案换成「尚未发布，暂不可安装」。
 *
 * 而**同一张卡顶上的芯片写着「可安装」** —— 因为 `packStatus()` 压根不看
 * `availability`（它只看 `installed → applicable → installable`）。
 *
 * > **芯片说"可安装"，按钮说"暂不可安装"，两句话在同一张卡上。**
 *
 * 这不是排版问题：两句话来自**两个各自独立的判断**，所以它们必然会各说各的。
 * 与本仓反复修的那一族同形 —— 只要一个事实有两处判断，两处就一定会漂移。
 *
 * ── 这个文件钉什么 ──────────────────────────────────────────────────────────
 *
 * 不钉"函数返回了哪个字符串"，钉**后果**：
 * **`packStatus()` 说"可安装"的那一档，必须与按钮真的点得动是同一件事。**
 * 按钮的可点性判据在这里被复刻成一个纯函数（`buttonEnabled`），
 * 两边喂同一份输入 —— 一致就是一致，不一致当场红。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { packStatus, type PackStatusInput } from './packStatus';

/**
 * 复刻 `BackendPackCard.tsx` 那个按钮的**可点性**判据。
 *
 * ⚠️ 刻意复刻而不是 import 组件：这条用例要问的是
 * 「两个**独立**做出的判断一不一致」，把它们合成一处再断言就等于什么都没问。
 * 组件那边改了判据而这里没改 → 下面的用例会红，那正是我们要的信号。
 */
function buttonEnabled(p: {
  applicable: boolean;
  pendingCi: boolean;
  installing: boolean;
}): boolean {
  return !(p.installing || !p.applicable || p.pendingCi);
}

const base: PackStatusInput = {
  installed: false,
  applicable: true,
  isActive: false,
  selfTestFailed: false,
};

describe('T-196 芯片与按钮必须出自同一个判断', () => {
  it('★ 已发布、适用、没装 → 芯片"可安装"，按钮点得动（对照组：这一档本来就是对的）', () => {
    const status = packStatus({ ...base, availability: 'published' });
    assert.equal(status, 'installable');
    assert.equal(buttonEnabled({ applicable: true, pendingCi: false, installing: false }), true);
  });

  it('★★ pending-ci、适用、没装 → 芯片**不许**说"可安装"，因为按钮点不动', () => {
    const status = packStatus({ ...base, availability: 'pending-ci' });
    assert.equal(
      buttonEnabled({ applicable: true, pendingCi: true, installing: false }),
      false,
      '前提：这一档按钮确实是灰的',
    );
    assert.notEqual(
      status,
      'installable',
      '芯片说"可安装"、按钮说"暂不可安装" —— 同一张卡上两句互相打脸的话',
    );
    assert.equal(status, 'not-published', '要有自己的一档，而不是被塞进别的档里含混过去');
  });

  it('★ 逐档对齐：凡是 packStatus 说 installable 的，按钮必须点得动', () => {
    const availabilities: (string | undefined)[] = ['published', 'pending-ci', undefined];
    const applicables = [true, false];
    let checked = 0;
    for (const availability of availabilities) {
      for (const applicable of applicables) {
        const status = packStatus({ ...base, applicable, availability });
        const enabled = buttonEnabled({
          applicable,
          pendingCi: availability === 'pending-ci',
          installing: false,
        });
        checked += 1;
        if (status === 'installable') {
          assert.equal(
            enabled,
            true,
            `availability=${String(availability)} applicable=${applicable}：芯片说可安装，按钮却是灰的`,
          );
        }
      }
    }
    // 数了几个就说几个 —— 零个也能"全部通过"。
    assert.equal(checked, 6, `只核对了 ${checked} 种组合`);
  });

  it('★ 字段缺失（老清单没有 availability）按"已发布"处理，不许倒过来', () => {
    /*
     * 判据与 `isUsableAsset`「字段缺失 ≠ 不可用」同一条：**哪个默认值会让界面说一句不成立的话。**
     * 目录里 14 个包里有 12 个根本没写这个字段，它们全都在架上 ——
     * 默认成"未发布"会把 12 个能装的包一次性变成灰按钮，那才是灾难。
     */
    assert.equal(packStatus({ ...base, availability: undefined }), 'installable');
  });

  it('★ 已装的包即使标着 pending-ci，也仍然是"已安装"（别把已有的事实盖掉）', () => {
    // 用户可能在标记翻回去之前就装上了；这时说"尚未发布"是对一个既成事实撒谎。
    assert.equal(packStatus({ ...base, installed: true, availability: 'pending-ci' }), 'installed');
    assert.equal(
      packStatus({ ...base, installed: true, isActive: true, availability: 'pending-ci' }),
      'active',
    );
  });

  it('★ 不适用的包不许被 pending-ci 盖掉平台解释（那对用户更有用）', () => {
    // 「这是别的平台的包」比「尚未发布」更能回答用户此刻的疑问，且前者是确定的事实。
    assert.equal(
      packStatus({
        ...base,
        applicable: false,
        inapplicableKind: 'platform',
        availability: 'pending-ci',
      }),
      'other-platform',
    );
  });
});
