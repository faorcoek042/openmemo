#!/usr/bin/env node
/**
 * `mutation-verdict.mjs` 的**变异证明** —— 本机能跑，不需要浏览器 / 包 / GitHub。
 *
 * ## 它守的那条性质
 *
 * > **「断言按设计判红」和「这条腿自己炸了」必须在结果里分得开。**
 *
 * 此前 `mutation()` 只问"抛没抛"。`[CI 实测 run 31629900327, win32-x64]` 原话：
 *
 * ```
 * ✔ [变异] B10 的证伪能力（把「移动到文件夹」弄成死按钮，必须红）
 *   —— 如期变红：locator.click: Timeout 8000ms exceeded.
 *      waiting for locator('[data-testid="note-actions"]')
 * ```
 *
 * 变异体一次都没装上、函数体根本没跑到，被记成了"这条断言有牙齿"。
 *
 * ## ⚠️ 单向的守卫两种退化都拦不住
 *
 * 这份文件的核心是**两条一起**，所以下面把**两种退化实现**都写进用例里，
 * 各自必须在**不同**的那几条上失败：
 *
 * | 退化实现 | 它能骗过 | 被哪一节抓住 |
 * |---|---|---|
 * | `legacyAnyThrowIsOk`（老实现：抛了就 MUT-OK） | "真变异 ⇒ MUT-OK" | ② 腿炸了必须 UNKNOWN |
 * | `degenerateAllUnknown`（一刀切成 UNKNOWN） | "腿炸了 ⇒ UNKNOWN" | ① 真变异必须 MUT-OK |
 *
 * 只写其中一节，另一种退化就能全绿通过 —— 那正是「把所有 MUT-OK 都改成 UNKNOWN」
 * 也能过的那个洞。
 *
 * 用法：`node scripts/ci/selftest-mutation-verdict.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';

import {
  AssertionFailed,
  Undecided,
  assertOk,
  classifyMutationThrow,
  markUndecided,
  mutationAnnotation,
} from './mutation-verdict.mjs';

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
function expect(name, fn) {
  cases += 1;
  try {
    fn();
    say(`  ✔ ${name}`);
  } catch (e) {
    failures += 1;
    say(`  ✘ ${name}\n      ${String(e.message ?? e)}`);
  }
}

/** 跑一段会抛的代码，把抛出来的东西交给判据 —— 和 `mutation()` 里那几行同构。 */
function verdictOf(fn) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  return classifyMutationThrow(threw);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 真形状：这四种抛出在真实 CI 日志里都出现过                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ★ 真的 Playwright 超时，**逐字照抄** `[CI 实测 run 31629900327, win32-x64]`
 * 那一行 MUT-OK 的 detail。它是这份文件存在的理由。
 */
const REAL_PLAYWRIGHT_TIMEOUT =
  'locator.click: Timeout 8000ms exceeded.\n' +
  '=========================== logs ===========================\n' +
  'waiting for locator(\'[data-testid="note-actions"]\')\n' +
  '============================================================';

/** 别的"腿炸了"形态 —— 都不是任何人打算让它抛的东西。 */
const CRASH_SHAPES = [
  ['Playwright 超时（run 31629900327 原文）', () => new Error(REAL_PLAYWRIGHT_TIMEOUT)],
  [
    'page.goto 连不上',
    () => new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:19980/models'),
  ],
  [
    '选择器写错 → TypeError',
    () => new TypeError("Cannot read properties of null (reading 'click')"),
  ],
  ['daemon 没起来 → fetch failed', () => new Error('fetch failed')],
  [
    '取消/超时信号',
    () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
  ],
  ['抛了个字符串（某些原生抛法）', () => 'boom'],
];

say('── ① 真变异必须仍然 MUT-OK（挡「一刀切成 UNKNOWN」）────────────────────────');

expect('ok() 判红 ⇒ MUT-OK', () => {
  const v = verdictOf(() => assertOk(false, '点了「移动到文件夹」，面板没出现 —— 入口是死的'));
  assert.equal(v.status, 'MUT-OK');
  assert.equal(v.kind, 'assertion');
  assert.equal(v.mark, '✔');
  assert.match(v.text, /如期变红/);
  assert.match(v.detail, /入口是死的/);
});
expect('ok() 判红且带「实得」⇒ MUT-OK，实得值进 detail', () => {
  const v = verdictOf(() => assertOk(false, '界面一个字都没说', '（空）', (x) => String(x)));
  assert.equal(v.status, 'MUT-OK');
  assert.match(v.detail, /实得：（空）/);
});
expect('ok(true) 什么都不抛 ⇒ 这一条不该被判 MUT-OK', () => {
  const v = verdictOf(() => assertOk(true, '不该抛'));
  assert.equal(v.status, 'MUT-BAD');
});
expect('直接抛 AssertionFailed ⇒ MUT-OK（类型才是判据，不是消息措辞）', () => {
  // 措辞故意长得**像 Playwright 报错** —— 判据不许因此改变主意。
  const v = verdictOf(() => {
    throw new AssertionFailed('locator.click: Timeout 8000ms exceeded');
  });
  assert.equal(v.status, 'MUT-OK', '按消息匹配的实现会在这里把它误判成"腿炸了"');
});

say('');
say('── ② 腿自己炸了必须 MUT-UNKNOWN（挡老实现「抛了就 MUT-OK」）──────────────');

for (const [label, make] of CRASH_SHAPES) {
  expect(`${label} ⇒ MUT-UNKNOWN(crash)`, () => {
    const v = verdictOf(() => {
      throw make();
    });
    assert.equal(v.status, 'MUT-UNKNOWN', `判成了 ${v.status}`);
    assert.equal(v.kind, 'crash');
    assert.equal(v.mark, '？');
    assert.match(v.detail, /腿炸了，不是断言判红/);
  });
}

expect('crash 必须打 ::warning 注解（不判红，但不许安静）', () => {
  const v = verdictOf(() => {
    throw new Error(REAL_PLAYWRIGHT_TIMEOUT);
  });
  const a = mutationAnnotation('B10 的证伪能力', v);
  assert.ok(a, 'crash 那一档没有注解 —— 它会安静地消失在日志里');
  assert.match(a, /^::warning title=变异 B10 的证伪能力 什么都没证明::/);
  assert.ok(!/[\r\n]/.test(a), 'GitHub 的注解必须是**一行**，多行会被截断成半句');
});

say('');
say('── ③ 前提没构造出来 ⇒ MUT-UNKNOWN(premise)，且与 crash 分得开 ─────────────');

expect('undecided() ⇒ MUT-UNKNOWN(premise)', () => {
  const v = verdictOf(() => markUndecided('这一轮没建出笔记，变异体无处可装'));
  assert.equal(v.status, 'MUT-UNKNOWN');
  assert.equal(v.kind, 'premise');
  assert.match(v.text, /前提没构造出来/);
  assert.ok(!/腿炸了/.test(v.detail), 'premise 不许被写成"腿炸了" —— 两者的下一步不同');
});
expect('premise 不打注解（平台差异是常态，为它天天喊会训练人无视注解）', () => {
  const v = verdictOf(() => markUndecided('这台 runner 上构造不出来'));
  assert.equal(mutationAnnotation('X', v), null);
});
expect('Undecided 与 AssertionFailed 是两个类型，互不 instanceof', () => {
  assert.ok(new Undecided('x') instanceof Undecided);
  assert.ok(!(new Undecided('x') instanceof AssertionFailed));
  assert.ok(!(new AssertionFailed('x') instanceof Undecided));
});

say('');
say('── ④ 什么都没抛 ⇒ MUT-BAD（变异体存活），且只有这一档计入失败 ──────────────');

expect('没抛 ⇒ MUT-BAD', () => {
  const v = classifyMutationThrow(null);
  assert.equal(v.status, 'MUT-BAD');
  assert.equal(v.kind, 'survived');
  assert.equal(v.mark, '✘');
});
expect('undefined 与 null 同解（`let threw = null` 与 `let threw` 两种写法都在仓里）', () => {
  assert.equal(classifyMutationThrow(undefined).status, 'MUT-BAD');
});
expect('四档的 status 只能取这三个名字（多一个就会绕过下游的三态汇总）', () => {
  const seen = new Set([
    classifyMutationThrow(null).status,
    verdictOf(() => assertOk(false, 'x')).status,
    verdictOf(() => markUndecided('x')).status,
    verdictOf(() => {
      throw new Error('x');
    }).status,
  ]);
  assert.deepEqual([...seen].sort(), ['MUT-BAD', 'MUT-OK', 'MUT-UNKNOWN']);
});

say('');
say('── ⑤ 抽掉修法它会绿吗（两种退化，各自必须在不同的那几条上失败）──────────');

/** 老实现：抛了就是 MUT-OK。**它是这一版要拆掉的那个东西。** */
const legacyAnyThrowIsOk = (threw) => (threw ? { status: 'MUT-OK' } : { status: 'MUT-BAD' });
/** 退化二：一刀切成 UNKNOWN。**它能过②但过不了①** —— 「让所有变异都不作数」。 */
const degenerateAllUnknown = (threw) => (threw ? { status: 'MUT-UNKNOWN' } : { status: 'MUT-BAD' });

expect('老实现把 run 31629900327 那条 Playwright 超时判成 MUT-OK（复现当年那个假绿）', () => {
  const t = new Error(REAL_PLAYWRIGHT_TIMEOUT);
  assert.equal(legacyAnyThrowIsOk(t).status, 'MUT-OK', '没能复现出老实现的假绿 —— 那我抄错了');
  assert.equal(classifyMutationThrow(t).status, 'MUT-UNKNOWN', '新实现没堵住它');
});
expect('六种"腿炸了"的形态，老实现全判 MUT-OK；新实现一条都不给', () => {
  for (const [, make] of CRASH_SHAPES) {
    const t = make();
    assert.equal(legacyAnyThrowIsOk(t).status, 'MUT-OK');
    assert.equal(classifyMutationThrow(t).status, 'MUT-UNKNOWN');
  }
});
expect('「一刀切成 UNKNOWN」过不了①：真断言判红时它给不出 MUT-OK', () => {
  const t = new AssertionFailed('入口是死的');
  assert.equal(degenerateAllUnknown(t).status, 'MUT-UNKNOWN');
  assert.equal(
    classifyMutationThrow(t).status,
    'MUT-OK',
    '新实现也给不出 MUT-OK 的话，这道门就等于把所有变异证明一起废掉了',
  );
});

say('');
say(`── ${cases} 条，失败 ${failures} 条 ──`);
if (failures > 0) {
  say('');
  say('✘ 变异判决的证伪能力**没有过关**。');
  process.exit(1);
}
say('✔ 变异判决：真变异仍 MUT-OK、腿炸了变 UNKNOWN、前提与炸了分得开、两种退化都拦得住。');
