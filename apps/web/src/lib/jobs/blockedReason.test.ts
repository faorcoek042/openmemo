/**
 * 「这条任务在等什么」那张表 —— **认不出的码必须落到兜底，不许渲染成空白。**
 *
 * ## 为什么这条比映射本身更值钱
 *
 * `queue.block()` 的第二个参数是**自由字符串**，契约里没有闭集 ——
 * daemon 随时可以新增一个 `blockedCode`。而回落一旦漏掉，用户看到的是
 * 「任务停住了 + 一片空白」，那与"软件坏了"在他那里是同一件事。
 *
 * 更要命的是**空白不会让任何东西变红**：组件照常渲染、类型照常通过、
 * 没有异常、没有日志。这正是本仓一整周在清的那一族。
 *
 * 表提成公共的之后，兜底也只有一份（`blockedReasonKey()` 里那一句），
 * 所以这条用例同时守着**导图与转写两半** —— 而不是各写一遍再漏一边。
 *
 * ## 判据钉的是"回落发生了"，不是"某个 if 存在"
 *
 * 复现：把 `blockedReasonKey()` 的 `?? BLOCKED_REASON_FALLBACK_KEY` 删掉
 * （让它返回 `undefined`），本文件必须变红。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCKED_REASON_FALLBACK_KEY,
  BLOCKED_REASON_KEYS,
  KNOWN_BLOCKED_CODES,
  blockedReasonKey,
} from './blockedReason';

describe('blockedCode → 那句话（公共表）', () => {
  it('★ daemon 真的会发的每个码，都各自有自己的话', () => {
    /*
     * 遍历 `KNOWN_BLOCKED_CODES` 而**不是**在这里再抄一份码名单：
     * 抄一份的话，往那个数组里加一个码、这里忘了跟，新码就悄悄没人验。
     * （表本身的类型是全量 `Record<KnownBlockedCode, string>`，
     *   所以"加了码却没写话"在**构建期**就红了；这条守的是运行期的分派。）
     *
     * 那三个码是**核过的全集**（全仓 `queue.block(` 的调用点）：
     *   transcribe.ts → MISSING_ASR_MODEL
     *   mindmap.ts    → NO_TRANSCRIPT / LLM_NOT_CONFIGURED
     * 少一个就意味着某条真实的挂起态在界面上退化成一句通用话。
     */
    assert.ok(KNOWN_BLOCKED_CODES.length >= 3, '码表缩水了 —— 少的那个码会静默落进兜底');
    for (const code of KNOWN_BLOCKED_CODES) {
      const key = blockedReasonKey(code);
      assert.notEqual(
        key,
        BLOCKED_REASON_FALLBACK_KEY,
        `${code} 落到了兜底 —— 它是 daemon 真会发的码，用户本该看到具体原因`,
      );
      assert.equal(key, BLOCKED_REASON_KEYS[code]);
    }
  });

  it('★★ 转写那一半也在表里 —— 这正是把表提成公共的理由', () => {
    /*
     * 提之前这张表只长在 `GenerateMindmapButton` 里，键前缀是 `mindmap.blocked.*`。
     * 也就是说：转写因为没装 ASR 模型而挂起时，笔记页那条进度行
     * 只说得出「暂时无法继续」——**说不出在等什么**。
     */
    assert.notEqual(
      blockedReasonKey('MISSING_ASR_MODEL'),
      BLOCKED_REASON_FALLBACK_KEY,
      '表里没有转写那一档 = 「暂时无法继续」又变回一句说不出原因的话',
    );
  });

  it('★★ 新出现的 blockedCode 落到兜底，不许是 undefined / 空串', () => {
    for (const code of ['SOMETHING_NEW', 'MISSING_BACKEND', 'RESOURCE_DISK_FULL']) {
      assert.equal(
        blockedReasonKey(code),
        BLOCKED_REASON_FALLBACK_KEY,
        `${code} 没有回落 —— 用户会看到一块空白，而空白不会让任何东西变红`,
      );
    }
  });

  it('★ 没给码（只说 blocked）同样落兜底 —— 状态本身已经是事实', () => {
    for (const code of [null, undefined, '']) {
      assert.equal(
        blockedReasonKey(code),
        BLOCKED_REASON_FALLBACK_KEY,
        '缺一个码不该让整块提示消失',
      );
    }
  });

  it('★ 表里每个 value 都得是一条真的 i18n 路径（拼错 = 界面上一片空白）', () => {
    /*
     * 只做结构判：**词条真的存不存在**由组件测试那条断言守着
     * （那边 `zh-CN.json` / `en.json` 已经加载好了）。
     * 两条一起才完整：这里防"忘了写 key"，那里防"key 指向不存在的词条"。
     */
    const values = [...Object.values(BLOCKED_REASON_KEYS), BLOCKED_REASON_FALLBACK_KEY];
    assert.ok(values.length >= 4, '表空了 —— 那等于所有挂起态都退化成一句通用话');
    for (const key of values) {
      assert.match(key, /^[a-zA-Z][\w-]*(\.[\w-]+)+$/, `不像 i18n 路径：${JSON.stringify(key)}`);
    }
  });
});
