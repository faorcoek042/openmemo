/**
 * 「移动数据目录」这条路上，**界面说的必须和实际发生的一致**。
 *
 * ## 守的是一次真实的、带密钥泄漏后果的假话
 *
 * `[CI 实测 2026-08-08 run 31250730491，windows-2025]`：
 * 数据目录移动走了复制路径（跨卷 rename 会 EXDEV，`copy` 是必要退路），
 * 复制 + 逐文件校验都成功，然后 `fs.rm(from)` **失败** ——
 * Windows 删不掉仍被 daemon 打开的 `openmemo.db`。
 *
 * 而当时返回给界面的是：
 *
 *     {"ok":true,"moved":true,"strategy":"copy","files":54,
 *      "messageZh":"已移动 54 个文件到新位置，正在重启以生效。"}
 *
 * **那句"已移动"是假的**：旧目录原封不动留在原地，其中包含明文的
 * `secrets.json`（用户的 API Key）。用户据此以为旧位置已经空了 ——
 * 这比"移动失败"糟得多，因为失败会被查，而这句假话不会。
 *
 * Manager 2026-08-08 裁定：判据**不是**"让 Windows 也用 rename"，
 * 是**"界面说的和实际发生的必须一致"**。
 *
 * ## 为什么这条判据值得一个独立的测试文件
 *
 * 它跨了三层（`move.ts` 的 `sourceRemoved` → `storage.ts` 的文案 → 前端渲染），
 * 而中间任何一层"顺手简化"掉，症状都是**一句读起来很正常的中文** ——
 * 没有报错、没有红灯，只有用户三个月后发现旧目录还在。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { moveMessageZh } from './storage.js';

describe('搬完数据目录之后，那句话必须是真的', () => {
  it('★ 源真的删掉了 —— 才允许说"已移动"', () => {
    const msg = moveMessageZh({ files: 54, links: 0, sourceRemoved: true }, '/old');
    assert.equal(msg.includes('已移动'), true);
    assert.equal(msg.includes('已复制'), false);
  });

  it('★★ 源没删掉时，**不许**出现"已移动"', () => {
    const msg = moveMessageZh({ files: 54, links: 0, sourceRemoved: false }, '/old');
    assert.equal(
      msg.includes('已移动'),
      false,
      '这正是 Windows 那次的原文：数据被复制了一份留在原地，界面却说"已移动"',
    );
  });

  it('★ 源没删掉时，必须说清楚"旧目录还在"以及它在哪', () => {
    const msg = moveMessageZh({ files: 54, links: 0, sourceRemoved: false }, '/old/data');
    assert.equal(msg.includes('已复制'), true);
    assert.equal(msg.includes('/old/data'), true, '不给路径，用户不知道该去删哪');
    assert.equal(msg.includes('仍留在原地'), true);
  });

  /*
   * ★★ 这条 2026-08-09 收紧了一次，方向是**更准**而不是更松。
   *
   * 原来它断言的是「文案必须无条件出现 secrets.json」。
   * `[CI 实测 run 31296921806, windows-2025]` 发现删源是**删到一半**失败的：
   * 旧目录里实际剩下的是 `models` 与 `openmemo.db`，
   * **`secrets.json` 其实已经被删掉了** —— 而文案照旧说"其中包含 secrets.json"。
   *
   * 方向虽然保守（让用户去看一个更干净的地方），**但保守的假话仍然是假话**：
   * 用户会去找一个不在那里的文件，然后开始怀疑别的提示是不是也在瞎说。
   * 判据没变，还是那条「界面说的和实际发生的必须一致」——
   * 所以现在是**在场就点名、不在场就绝不声称**。
   */
  it('★ 密钥在旧目录里时必须点名 —— 它决定了用户会不会去处理', () => {
    const msg = moveMessageZh(
      {
        files: 54,
        links: 0,
        sourceRemoved: false,
        sourceResidue: ['models', 'openmemo.db', 'secrets.json'],
      },
      '/old',
    );
    assert.equal(
      msg.includes('secrets.json'),
      true,
      '「有个目录没删掉」听起来像洁癖问题；「里面有你的 API Key」才会让人真的去删',
    );
    assert.equal(msg.includes('API Key'), true, '要说清楚它为什么要紧');
  });

  it('★★ 密钥**已经被删掉**时，绝不许再声称它还在', () => {
    const msg = moveMessageZh(
      { files: 54, links: 0, sourceRemoved: false, sourceResidue: ['models', 'openmemo.db'] },
      '/old',
    );
    assert.equal(
      msg.includes('secrets.json'),
      false,
      '★ 这正是 run 31296921806 里的实际残留 —— 声称一个不在那里的文件，是保守方向的假话',
    );
    assert.equal(msg.includes('models'), true, '该说的是真正剩下的东西');
    assert.equal(msg.includes('openmemo.db'), true);
  });

  it('★ 旧目录已经空了（只剩目录本身）→ 不许列出任何文件名', () => {
    const msg = moveMessageZh(
      { files: 54, links: 0, sourceRemoved: false, sourceResidue: [] },
      '/old',
    );
    assert.equal(msg.includes('secrets.json'), false);
    assert.equal(msg.includes('已经空了'), true, '如实说"目录还在但里面空了"');
  });

  it('★ 符号链接数只在非零时出现（别对着 0 说"与 0 个符号链接"）', () => {
    assert.equal(
      moveMessageZh({ files: 3, links: 0, sourceRemoved: true }, '/old').includes('符号链接'),
      false,
    );
    assert.equal(
      moveMessageZh({ files: 3, links: 2, sourceRemoved: true }, '/old').includes('2 个符号链接'),
      true,
    );
  });
});
