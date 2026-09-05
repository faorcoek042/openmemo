/**
 * 守卫：**`x.` 本地扩展事件不许给 shared 里已经有的事件做影子。**
 *
 * ── 它替谁站岗（这是一个真实发生过、活了很久的缺陷）──────────────────────────
 *
 * `lib/events/types.ts` 的约定是：shared 还没覆盖的事件，前端用 `x.` 前缀本地扩展，
 * **等 shared 补齐后删掉本地定义**。约定本身没问题，问题是"等补齐后删掉"这一步
 * **没有任何东西在盯**，而它的失败是完全静默的：
 *
 *   · `packages/shared` 早就有了 `media.asset.ready`（`SSE_EVENT_TYPES` 里的一等事件）；
 *   · daemon 的 `media/peaksAsset.ts` 发的是 `media.asset.ready`
 *     （`SseHub.publish(event: SseEvent)` 在**类型上**就发不出 `x.*`）；
 *   · 而 `features/notes/sse.ts` 订的一直是 `x.media.asset.ready`。
 *
 * 差一个前缀，两个字符串永远碰不上 ⇒ **波形（peaks）就绪的那条 invalidate 从没触发过，
 * 用户必须手动刷新才看得到波形**。三处代码各自都编译得过、测得绿。
 *
 * 更贵的是它**污染了生产端的注释**：`peaksAsset.ts` 里写着「前端 notesSse 也早就订阅着」，
 * 那句话在写下的那一刻就是假的，于是这条线被当成"已经接通"，没有人再回来查。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 *
 * 对每个 `x.<name>`：如果 `<name>` 出现在 shared 的 `SSE_EVENT_TYPES` 里，判红。
 *
 * **把修法退回去它会红吗**：会。把 `'x.media.asset.ready'` 加回
 * `EXTENSION_SSE_EVENT_TYPES`（不加它，`bus.on('x.media.asset.ready')` 连类型都过不了），
 * 这条当场红。
 *
 * ⚠️ **覆盖面**：它只管"影子"这一种形态。它**不能**回答
 * 「这个订阅有没有生产方」——`x.summary.delta` / `x.daemon.shutdown` / `x.index.progress`
 * 今天都零生产方，而它们是绿的（shared 确实没有对应物，那是另一笔账，见
 * `coordination/inbox/debt-audit.md` C9）。绿灯**不能**读成"事件都通了"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SSE_EVENT_TYPES } from '@openmemo/shared';

import { ALL_SSE_EVENT_TYPES, EXTENSION_SSE_EVENT_TYPES } from './types';

describe('SSE 事件命名：本地扩展不许给 shared 已有的事件做影子', () => {
  test('前提：两张表都不是空的（空集会让下面那条假绿）', () => {
    assert.ok(
      SSE_EVENT_TYPES.length >= 25,
      `shared 只报了 ${SSE_EVENT_TYPES.length} 个事件类型 —— 导入坏了，下面全是空转`,
    );
    assert.ok(
      EXTENSION_SSE_EVENT_TYPES.length > 0,
      '本地扩展表空了 —— 那这条守卫今天什么都没在守，请确认是真的清空了',
    );
    // 定点校准：这个名字必须在 shared 里，否则说明扫的不是那张表
    assert.ok(
      (SSE_EVENT_TYPES as readonly string[]).includes('media.asset.ready'),
      'shared 的 SSE_EVENT_TYPES 里找不到 media.asset.ready —— 契约变了，这条守卫要重写',
    );
  });

  test('★ 每个 `x.<name>`，`<name>` 都不许已经在 shared 的 SSE_EVENT_TYPES 里', () => {
    const shared = new Set<string>(SSE_EVENT_TYPES as readonly string[]);
    const shadows = EXTENSION_SSE_EVENT_TYPES.filter((t) => shared.has(t.slice('x.'.length)));
    assert.deepEqual(
      shadows,
      [],
      '这些本地扩展事件在 `packages/shared` 里已经转正了，本地那份是它的影子：\n' +
        shadows.map((t) => `  ${t}  ←→  ${t.slice(2)}`).join('\n') +
        '\n影子的后果不是"多一行类型"：订阅端等 `x.…`，服务端发不带前缀的那个，' +
        '**两个字符串永远碰不上**，而 tsc / eslint / 现有测试一个字都不会说。' +
        '\n修法：删掉本地定义，直接订阅 shared 的那个名字。',
    );
  });

  test('★ 反面：ALL_SSE_EVENT_TYPES 里不许有重复项（去重失败会让 addEventListener 挂两遍）', () => {
    const dup = ALL_SSE_EVENT_TYPES.filter((t, i) => ALL_SSE_EVENT_TYPES.indexOf(t) !== i);
    assert.deepEqual(dup, [], `重复的事件类型：${dup.join(', ')}`);
  });
});
