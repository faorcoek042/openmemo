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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AssertionFailed,
  Undecided,
  absenceAnnotation,
  absentMutations,
  assertOk,
  classifyMutationThrow,
  extractMutationIds,
  markUndecided,
  mutationAnnotation,
} from './mutation-verdict.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
say('── ⑥ 缺席：声明了 N 条、这一轮只出现 M 行 ────────────────────────────────');

/** 一份**假的**审计脚本源码，形状照真的来（含两个必须被忽略的干扰项）。 */
const FAKE_SOURCE = [
  "/** 注释里提到 mutation() 和 await mutation('注释里的假 id') 都不算数。 */",
  'async function mutation(id, fn) { /* 定义本身不算一个调用点 */ }',
  "  await mutation('A 的证伪能力', () => {",
  "    await mutation('B 的证伪能力（带（中文括号）和 —— 破折号）', async () => {",
  "await mutation(\n  'C 的证伪能力', () => {",
].join('\n');

expect('从源码里数出调用点（定义与注释都不算）', () => {
  const ids = extractMutationIds(FAKE_SOURCE);
  assert.deepEqual(ids, [
    'A 的证伪能力',
    'B 的证伪能力（带（中文括号）和 —— 破折号）',
    'C 的证伪能力',
  ]);
});
expect('🔴 块注释里的 `await mutation(...)` 不许被数进来（行首是 `/`，不是 `await`）', () => {
  assert.ok(!extractMutationIds(FAKE_SOURCE).includes('注释里的假 id'));
});
expect('🔴 整行 `//` 注释里的也不许（行首是 `/`）', () => {
  const src = [
    "// await mutation('行注释里的假 id', () => {}); ",
    "await mutation('真的', () => {",
  ].join('\n');
  assert.deepEqual(extractMutationIds(src), ['真的']);
});
/*
 * ★★ **真事故的存档**（PR #66 第一版，被这份文件自己的地板抓住）。
 *
 * 第一版是"先剥块注释再找调用点"。`e2e-notes-audit.mjs:1473` 有这么一行**字符串**：
 *   accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,* / *;q=0.8'
 * （HTTP 的 Accept 头，此处斜杠间加了空格，免得这段注释自己再触发一次同样的事故）
 * 那个 `* / *` 里含着一个「斜杠+星号」—— 剥注释的正则把它当成块注释**开始**，
 * 一路吃到下一个真正的注释结束符，**连着吞掉了 F5-e4 那条真变异**，
 * 于是 notes 只数到 9 条（地板 10）当场红。
 * ⇒ 改成**行首锚定**（语句位置），不再需要理解字符串。
 */
expect('★ 字符串里的 Accept 头 `*/*` 不许吞掉它后面的调用点（PR #66 第一版的真事故）', () => {
  const src = [
    '  const h = {',
    "    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',",
    '  };',
    "  await mutation('它后面的那条真变异', async () => {",
  ].join('\n');
  assert.deepEqual(extractMutationIds(src), ['它后面的那条真变异']);
});
expect('行尾的 `http://` 不许被当成注释而误伤后面的调用点', () => {
  const src = ["const u = 'http://127.0.0.1:19980/api';", "await mutation('真的', () => {"].join(
    '\n',
  );
  assert.deepEqual(extractMutationIds(src), ['真的']);
});

/*
 * ★★ **真数据**的幽灵用例。两个审计脚本的注释里都写着一句
 *   「N 从这个脚本自己的源码里数（`await mutation('<id>'` 的调用点就是注册表…」
 *   —— 那句话**自己就长得像一个调用点**。不剥注释的话，两条腿会各自多出一条
 *   永远不出现在总表里的幽灵 id `<id>`，于是这道门**每一跑都报一条假缺席**。
 *   这不是假想：写这道门的时候就踩到了，这两条用例是那次踩坑的存档。
 */
for (const rel of ['scripts/ci/e2e-browser-audit.mjs', 'scripts/ci/e2e-notes-audit.mjs']) {
  expect(`${rel}：注释里那句说明不许被数成一条变异（幽灵 id）`, () => {
    const src = readFileSync(join(REPO, rel), 'utf8');
    assert.ok(
      /await mutation\('<id>'/.test(src),
      '真文件里那句说明不在了 —— 这条用例失去了它的靶子，请换一个真实的幽灵来源或删掉它',
    );
    // 靶子必须真的长在注释里（行首是 `*`），否则这条用例证明的不是同一件事
    assert.ok(
      /^\s*\*.*await mutation\('<id>'/m.test(src),
      '那句说明不在注释行里了 —— 行首锚定挡不住它，这条用例的前提变了',
    );
    const ids = extractMutationIds(src);
    assert.ok(!ids.includes('<id>'), `扫出了幽灵 id：${JSON.stringify(ids.slice(0, 20))}`);
    assert.ok(!ids.includes('…'), '扫出了另一处注释示例里的省略号 id');
  });
}

const DECLARED = ['A 的证伪能力', 'B 的证伪能力', 'C 的证伪能力', 'D 的证伪能力'];
const rows = (pairs) => pairs.map(([id, status]) => ({ id, status }));

expect('正常轮：四条都留了行 ⇒ 一条都不缺（**不许因此变红**）', () => {
  const r = rows([
    ['A 的证伪能力', 'MUT-OK'],
    ['B 的证伪能力', 'MUT-OK'],
    ['C 的证伪能力', 'MUT-UNKNOWN'],
    ['D 的证伪能力', 'MUT-BAD'],
  ]);
  assert.deepEqual(absentMutations(DECLARED, r), []);
  assert.equal(absenceAnnotation([], DECLARED.length), null);
});
expect('★ 整轮被掐断（run 31484205254 win32 的形状）：一行都没有 ⇒ 四条全缺', () => {
  // 那一轮总表里只有一条 `✘ 审计中断`，四条变异**零行**。
  const r = rows([['B4 正常路径上没有未捕获的前端异常', 'PASS']]);
  assert.deepEqual(absentMutations(DECLARED, r), DECLARED);
});
expect('跑了一半就断（10 条里只留下 6 行的那种）⇒ 只报没留行的那几条', () => {
  const r = rows([
    ['A 的证伪能力', 'MUT-OK'],
    ['B 的证伪能力', 'MUT-OK'],
  ]);
  assert.deepEqual(absentMutations(DECLARED, r), ['C 的证伪能力', 'D 的证伪能力']);
});
expect('PASS/FAIL 行不算"这条变异跑过了"（只有 MUT- 开头的才算）', () => {
  const r = rows([['A 的证伪能力', 'PASS']]);
  assert.ok(absentMutations(DECLARED, r).includes('A 的证伪能力'));
});
expect('缺席必须打 ::warning，且是一行', () => {
  const a = absenceAnnotation(['A 的证伪能力', 'B 的证伪能力'], 4);
  assert.match(a, /^::warning title=有 2 条变异这一轮根本没跑到::/);
  assert.ok(!/[\r\n]/.test(a));
});

say('');
say('── ⑦ 缺席检测抽掉修法会绿吗 + 对着真脚本的非空地板 ────────────────────────');

const degenerateNeverAbsent = () => [];
const degenerateAlwaysAbsent = (declared) => declared;
expect('「永远说没缺席」过不了掐断那一格', () => {
  const r = rows([['B4', 'PASS']]);
  assert.deepEqual(degenerateNeverAbsent(DECLARED, r), []);
  assert.deepEqual(absentMutations(DECLARED, r), DECLARED, '新实现也说没缺席的话，这道门是空的');
});
expect('「永远说全缺席」过不了正常轮那一格（否则就是一盏常亮的灯）', () => {
  const r = rows([
    ['A 的证伪能力', 'MUT-OK'],
    ['B 的证伪能力', 'MUT-OK'],
    ['C 的证伪能力', 'MUT-OK'],
    ['D 的证伪能力', 'MUT-OK'],
  ]);
  assert.deepEqual(degenerateAlwaysAbsent(DECLARED, r), DECLARED);
  assert.deepEqual(absentMutations(DECLARED, r), []);
});

/*
 * ★ 对着**真脚本**的非空地板（棘轮式，只增不减）。
 *   提取器一旦漂了（有人改了调用写法、regex 失效），它坏掉的表现是
 *   "从此永远没有缺席" —— 一个恒不触发的检查。这里正面钉住它还数得到东西。
 *   数字是**下限**不是等号：加变异不该让这条红，删变异才该。
 */
for (const [rel, floor] of [
  ['scripts/ci/e2e-browser-audit.mjs', 4],
  ['scripts/ci/e2e-notes-audit.mjs', 10],
]) {
  expect(`${rel} 至少还数得到 ${floor} 条变异调用点（棘轮，只增不减）`, () => {
    const ids = extractMutationIds(readFileSync(join(REPO, rel), 'utf8'));
    assert.ok(
      ids.length >= floor,
      `只数到 ${ids.length} 条（地板 ${floor}）：要么提取器漂了，要么真的少了变异 —— 两种都要人看一眼`,
    );
    assert.equal(new Set(ids).size, ids.length, '有重名的变异 id —— 缺席检测会把它们混成一条');
    assert.ok(
      ids.every((s) => s.trim().length > 0),
      '有空的变异 id',
    );
  });
}

say('');
say(`── ${cases} 条，失败 ${failures} 条 ──`);
if (failures > 0) {
  say('');
  say('✘ 变异判决的证伪能力**没有过关**。');
  process.exit(1);
}
say('✔ 变异判决：真变异仍 MUT-OK、腿炸了变 UNKNOWN、前提与炸了分得开、两种退化都拦得住。');
