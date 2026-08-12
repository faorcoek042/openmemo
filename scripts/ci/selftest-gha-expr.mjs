#!/usr/bin/env node
/**
 * `gha-expr.mjs` 的自检 —— 一条一条把 GitHub Actions 的表达式语义钉住。
 *
 * ## 这份自检为什么值得存在
 *
 * `gha-expr.mjs` 是被拿来**下判断**的（「这个 `if:` 在这种输入下到底跑不跑」）。
 * 一个算错的求值器比没有求值器更糟：它会给出一个**看起来有依据**的错误结论，
 * 而且没有任何东西会提示你它错了。所以下面每一组都不是「跑通就行」，
 * 而是钉住一条**反直觉、且真的能写坏门禁**的性质：
 *
 *   A 组 真假值 —— `'false'` 是**真**、`''` 是假。
 *   B 组 `==` 的类型转换 —— `'' == false` 为真，`'' == 'false'` 为假。
 *   C 组 `&&` / `||` 返回操作数 —— `X && '--flag' || ''` 靠的就是这条。
 *   D 组 `format()` 的字符串化。
 *   E 组 ★ 本仓正要采用的那个惯用法，以及**两个天真写法为什么是错的**。
 *   F 组 ★ 隐式 `success()` —— 「一条红静默关掉后面 7 道守卫」的语义根源。
 *   G 组 job 图模拟 —— skip 的传播。
 *   H 组 该抛错的地方真的抛错（环、不存在的 needs、通配符、打错的函数名）。
 *
 * 断言数会在结尾打出来，并且**低于下限就当红处理** —— 一个断言数掉到 0 还报绿的
 * 守卫，正是本仓一直在清的那一族（见 `lint-workflows.mjs` 的第一条断言）。
 *
 * 跑法：node scripts/ci/selftest-gha-expr.mjs
 */
import {
  evaluateExpression,
  evaluateIf,
  ghaString,
  ghaTruthy,
  interpolate,
  simulateJobs,
  usesStatusFunction,
} from './gha-expr.mjs';

let checked = 0;
let failed = 0;
const ok = (msg) => {
  checked += 1;
  console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
};
const bad = (msg) => {
  checked += 1;
  failed += 1;
  console.log(`  \x1b[31m✘\x1b[0m ${msg}`);
};

/**
 * 稳定序列化 —— 既当比较依据，也当打印形态。
 * · 对象按键名排序：「结论一样、只是键序不同」不该被判成红。
 * · NaN / -0 / undefined 单独处理：JSON 会把它们统统写成 `null` / `0`，
 *   而 A 组要查的恰恰就是这几个值，打印成 null 等于把证据抹掉。
 */
function stable(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (Object.is(v, -0)) return '-0';
    return String(v);
  }
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(',')}}`;
}

const show = stable;
const eq = (a, b) => stable(a) === stable(b);

function is(actual, expected, label) {
  if (eq(actual, expected)) ok(`${label} → ${show(expected)}`);
  else bad(`${label}：期望 ${show(expected)}，实得 ${show(actual)}`);
}

/** 表达式求值断言：把表达式原文写进消息里，红的时候不用再去翻代码。 */
function expr(src, ctx, expected, note = '') {
  let actual;
  try {
    actual = evaluateExpression(src, ctx);
  } catch (err) {
    bad(`\`${src}\` 抛了异常：${String(err)}`);
    return;
  }
  is(actual, expected, `\`${src}\`${note ? `  —— ${note}` : ''}`);
}

function throws(fn, label, re) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (err === null) {
    bad(`${label}：期望抛错，结果一声不吭地过去了`);
    return;
  }
  if (re && !re.test(String(err.message))) {
    bad(`${label}：抛了错，但消息对不上 ${re}，实得「${err.message}」`);
    return;
  }
  ok(`${label} → 抛错（${err.message.slice(0, 60)}…）`);
}

console.log('\n\x1b[1mgha-expr 自检\x1b[0m');

/* ═══ A 组：真假值 ═══════════════════════════════════════════════════════════════ */
console.log('\n\x1b[1mA 组：真假值口径（`false` 这个词有两种，一真一假）\x1b[0m');

const TRUTHINESS = [
  [false, false, '布尔假'],
  [0, false, '数字 0'],
  [-0, false, '数字 -0'],
  ['', false, '空字符串'],
  [null, false, 'null'],
  [undefined, false, 'undefined（属性不存在）'],
  [Number.NaN, false, 'NaN'],
  ['false', true, "★ 字符串 'false' —— **真**。boolean 输入被字符串化后就长这样"],
  ['0', true, "★ 字符串 '0' —— **真**"],
  [' ', true, '只有一个空格的字符串 —— 真'],
  [[], true, '空数组 —— 真'],
  [{}, true, '空对象 —— 真'],
  [true, true, '布尔真'],
  [1, true, '数字 1'],
];
// ★ 空表 = 永远绿。这条断言就是防这个的（与 lint-workflows.mjs 的第一条同一个理由）。
if (TRUTHINESS.length > 0) ok(`真假值表里有 ${TRUTHINESS.length} 条待查项（空表会让这一组永远绿）`);
else bad('真假值表是空的 —— 这一组会因为「没东西可查」而永远绿');

for (const [value, expected, note] of TRUTHINESS) {
  is(ghaTruthy(value), expected, `ghaTruthy(${show(value)}) —— ${note}`);
}

/* ═══ B 组：`==` 的类型转换陷阱 ══════════════════════════════════════════════════ */
console.log('\n\x1b[1mB 组：`==` 两边类型不同就一起转数字（这一组能写坏门禁）\x1b[0m');

expr("'' == false", {}, true, '★ 空串与布尔假：string vs boolean → 0 vs 0 → **相等**');
expr("'' == 'false'", {}, false, "★ 空串与字符串 'false'：都是字符串，按字符串比 → **不等**");
expr("'' == 'all'", {}, false, '空串与另一个非空串');
expr("true == 'true'", {}, false, '★ 布尔真与字符串 true：1 vs NaN → **不等**');
expr("'1' == 1", {}, true, "字符串 '1' 与数字 1：转数字后相等");
expr("'ALL' == 'all'", {}, true, '字符串比较大小写不敏感');
expr('null == 0', {}, true, 'null 转数字是 0');
expr("'abc' == 0", {}, false, '转不动的字符串是 NaN，与谁都不等');
expr("'abc' == 'abc'", {}, true, '同一个字符串');
expr("2 > '10'", {}, false, "关系运算也转数字：2 > 10 为假（不是按字符串比 '2' > '1'）");
expr("'b' > 'A'", {}, true, '两边都是字符串 → 按字符串比，且大小写不敏感');

/* ═══ C 组：`&&` / `||` 返回的是操作数 ═══════════════════════════════════════════ */
console.log('\n\x1b[1mC 组：`&&` / `||` 返回操作数，不是布尔\x1b[0m');

is(interpolate("${{ false && '--x' || '' }}", {}), '', "false && '--x' || '' → 空串");
is(interpolate("${{ true && '--x' || '' }}", {}), '--x', "true && '--x' || '' → '--x'");
is(interpolate("${{ '' && '--x' || '' }}", {}), '', "'' && '--x' || '' → 空串（'' 是假）");
is(
  interpolate("${{ 'false' && '--x' || '' }}", {}),
  '--x',
  "★ 'false' && '--x' || '' → '--x'（字符串 'false' 是**真**）",
);
expr("true && 'kept'", {}, 'kept', '真 && X 得到 X 本身');
expr("false && 'kept'", {}, false, '假 && X 得到那个假操作数本身（false，不是布尔运算结果）');
expr("'first' || 'second'", {}, 'first', '真 || X 得到左边那个真操作数');
expr("'' || 'second'", {}, 'second', '假 || X 得到右边');
is(interpolate('pre-${{ 1 == 1 }}-post', {}), 'pre-true-post', '插值：`${{ }}` 之外的字符原样抄');
is(
  interpolate("${{ contains('a}}b', '}}') }}", {}),
  'true',
  "扫描 `}}` 时认字符串字面量（'}}' 不是结束符）",
);

/* ═══ D 组：format() 的字符串化 ══════════════════════════════════════════════════ */
console.log('\n\x1b[1mD 组：format() 的参数字符串化\x1b[0m');

const FORMAT_CASES = [
  ["''", '', '空串还是空串'],
  ['true', 'true', '布尔真 → "true"'],
  ['false', 'false', '★ 布尔假 → 字符串 "false"（于是它变成了一个**真**值）'],
  ['null', '', 'null → 空串'],
  ["'false'", 'false', "字符串 'false' → 原样"],
  ['1', '1', '数字'],
];
for (const [literal, expected, note] of FORMAT_CASES) {
  expr(`format('{0}', ${literal})`, {}, expected, note);
}
is(
  evaluateExpression("format('{0}-{1}', 'a', 'b')", {}),
  'a-b',
  "format('{0}-{1}', 'a', 'b') → 'a-b'",
);
is(
  evaluateExpression("format('{{{0}}}', 'x')", {}),
  '{x}',
  "format 的 `{{` / `}}` 是字面量花括号 → '{x}'",
);
is(evaluateExpression("join(fromJSON('[1,2,3]'), '-')", {}), '1-2-3', 'join + fromJSON');
is(evaluateExpression('toJSON(fromJSON(\'{"a":1}\'))', {}), '{\n  "a": 1\n}', 'toJSON 是缩进过的');
is(ghaString(undefined), '', 'ghaString(undefined) 是空串（属性不存在时的形态）');

/* ═══ E 组：★ 本仓正要采用的那个惯用法 ════════════════════════════════════════════ */
console.log(
  "\n\x1b[1mE 组：★ `format('{0}', inputs.m) != 'false'` —— 以及两个天真写法为什么是错的\x1b[0m",
);

const IDIOM = "format('{0}', inputs.m) != 'false'";
expr(IDIOM, { inputs: { m: '' } }, true, 'm 是空串（没填）→ **true**（默认开）');
expr(IDIOM, { inputs: { m: true } }, true, 'm 是布尔真 → true');
expr(IDIOM, { inputs: { m: false } }, false, '★ m 是布尔假 → **false**（这才是要的）');
expr(IDIOM, { inputs: {} }, true, 'm 压根没传 → true（undefined → format 给空串）');
expr(IDIOM, { inputs: { m: 'false' } }, false, "m 是字符串 'false'（YAML 里常见的形态）→ false");
expr(IDIOM, { inputs: { m: 'true' } }, true, "m 是字符串 'true' → true");

/* 天真写法之一：`inputs.m || true`。它在 m 为**显式 false** 时给出 true —— 也就是
 * 「用户明确关掉了，它照跑」。`||` 根本没法表达「默认为真的布尔」。 */
expr(
  'inputs.m || true',
  { inputs: { m: false } },
  true,
  '✘ 天真写法一：m 显式为 false 时**照样 true** —— `||` 表达不了「默认真」',
);
expr('inputs.m || true', { inputs: { m: '' } }, true, '（同一个写法在 m 为空串时也是 true）');

/* 天真写法之二：`inputs.m != 'false'`。boolean 与 string 比会走「两边转数字」，
 * 0 vs NaN 永远不等，于是它对布尔假也给 true。 */
expr(
  "inputs.m != 'false'",
  { inputs: { m: false } },
  true,
  "✘ 天真写法二：布尔 false != 字符串 'false' → **true**（0 vs NaN），漏判",
);
expr(
  "inputs.m != 'false'",
  { inputs: { m: 'false' } },
  false,
  '（同一个写法在 m 已经是字符串时**碰巧**是对的 —— 这正是它难被发现的原因）',
);

/* ═══ F 组：★ 隐式 success() ═════════════════════════════════════════════════════ */
console.log('\n\x1b[1mF 组：★ 隐式 success()（skipped 不是 passed）\x1b[0m');

is(
  evaluateIf("inputs.a == 'b'", { inputs: { a: 'b' }, __status: false }),
  false,
  "★ `if: inputs.a == 'b'` 在依赖没全成功时 → **false**（被隐式 success() 关掉了）",
);
is(
  evaluateIf("inputs.a == 'b'", { inputs: { a: 'b' }, __status: true }),
  true,
  '同一条 if，依赖都成功时 → true',
);
is(
  evaluateIf("!cancelled() && inputs.a == 'b'", {
    inputs: { a: 'b' },
    __status: false,
    __cancelled: false,
  }),
  true,
  '★ 自带状态函数 ⇒ 隐式 success() 不再叠加 → **true**（前面挂了也照常出结论）',
);
is(
  evaluateIf('!cancelled()', { __status: false, __cancelled: true }),
  false,
  '真被取消时 `!cancelled()` 老实停下',
);
is(evaluateIf('always()', { __status: false }), true, 'always() 连依赖全挂时也跑');
is(evaluateIf('failure()', { __status: false, __failure: true }), true, 'failure() 在有失败时为真');
is(evaluateIf(undefined, { __status: false }), false, '没有 if: ⇒ 就是一个裸的 success()');
is(evaluateIf(undefined, {}), true, '没有 if:、也没给 __status ⇒ 默认成功 ⇒ true');
is(evaluateIf(null, { __status: true }), true, 'if 是 null 同上');
/* YAML 里 `if: false` 解析出来是**布尔**，不是字符串 —— 关掉一个 job 的常见写法。 */
is(evaluateIf(false, { __status: true }), false, '`if: false`（YAML 布尔）⇒ 永远不跑');
is(
  evaluateIf(true, { __status: false }),
  false,
  '`if: true`（YAML 布尔）**挡不住**隐式 success()：依赖没成功照样跳',
);

is(
  usesStatusFunction("!cancelled() && inputs.a == 'b'"),
  true,
  'usesStatusFunction 认出 cancelled()',
);
is(usesStatusFunction("inputs.a == 'b'"), false, 'usesStatusFunction：没有状态函数');
is(
  usesStatusFunction("contains(inputs.x, 'always()')"),
  false,
  "★ 字符串字面量里的 'always()' 是数据不是调用 —— 不算",
);
is(
  evaluateIf("contains(inputs.x, 'always()')", { inputs: { x: 'always()' }, __status: false }),
  false,
  '（承上）所以它照样吃隐式 success()，依赖没成功就不跑',
);

/* 三种写法必须给出同一个答案 */
const BARE = "inputs.a == 'b' && inputs.c != 'd'";
const WRAPPED = `\${{ ${BARE} }}`;
const FOLDED = "inputs.a == 'b'\n  && inputs.c != 'd'"; // YAML `>-` 折叠后的样子
for (const [ctx, expected, note] of [
  [{ inputs: { a: 'b', c: 'x' }, __status: true }, true, '都满足'],
  [{ inputs: { a: 'b', c: 'd' }, __status: true }, false, '第二个条件不满足'],
  [{ inputs: { a: 'b', c: 'x' }, __status: false }, false, '依赖没成功（隐式 success()）'],
]) {
  const answers = [evaluateIf(BARE, ctx), evaluateIf(WRAPPED, ctx), evaluateIf(FOLDED, ctx)];
  if (answers.every((v) => v === expected)) {
    ok(`裸 / \${{ }} / 折叠多行 三种写法答案一致（${note}）→ ${expected}`);
  } else {
    bad(
      `三种 if: 写法答案不一致（${note}）：实得 ${JSON.stringify(answers)}，期望全是 ${expected}`,
    );
  }
}
is(
  evaluateIf("contains('a b', ' ')", { __status: true }),
  true,
  '折叠空白时不碰字符串字面量里的空格',
);

/* ═══ G 组：job 图模拟 —— skip 的传播 ═════════════════════════════════════════════ */
console.log('\n\x1b[1mG 组：job 图模拟（B 被跳过之后 C 还跑不跑）\x1b[0m');

const GUARDED_IF =
  "!cancelled() && needs.A.result == 'success' && " +
  "(needs.B.result == 'success' || needs.B.result == 'skipped')";

{
  // B 靠 if 被跳过；C 没有 if: ⇒ 隐式 success() ⇒ 被 B 的 skipped 带着一起跳。
  const jobs = {
    A: {},
    B: { needs: 'A', if: "inputs.want_b == 'yes'" },
    C: { needs: ['A', 'B'] },
  };
  const got = simulateJobs({ jobs, results: {}, ctx: { inputs: { want_b: 'no' } } });
  is(
    got,
    { A: 'success', B: 'skipped', C: 'skipped' },
    '★ B 被跳过 + C 没写 if: ⇒ C 也被跳过（skipped 不算 success）',
  );
}

{
  // 同一张图，C 带上那条被认可的守卫写法 ⇒ C 照常跑出结论。
  const jobs = {
    A: {},
    B: { needs: 'A', if: "inputs.want_b == 'yes'" },
    C: { needs: ['A', 'B'], if: GUARDED_IF },
  };
  const got = simulateJobs({ jobs, results: {}, ctx: { inputs: { want_b: 'no' } } });
  is(
    got,
    { A: 'success', B: 'skipped', C: 'success' },
    '★ C 写成 `!cancelled() && needs.A==success && (needs.B==success || needs.B==skipped)` ⇒ C 跑',
  );
}

{
  // B 真的跑了并且失败 ⇒ 同一条守卫把 C 挡在外面（它挡的是失败，不是跳过）。
  const jobs = {
    A: {},
    B: { needs: 'A', if: "inputs.want_b == 'yes'" },
    C: { needs: ['A', 'B'], if: GUARDED_IF },
  };
  const got = simulateJobs({
    jobs,
    results: { B: 'failure' },
    ctx: { inputs: { want_b: 'yes' } },
  });
  is(
    got,
    { A: 'success', B: 'failure', C: 'skipped' },
    '★ 同一条 if 在 B **失败**时给 skipped（这条守卫只放过 skipped，不放过 failure）',
  );
}

{
  // A 失败 ⇒ B 的隐式 success() 关掉 B，C 的守卫也判假。
  const jobs = { A: {}, B: { needs: 'A' }, C: { needs: ['A', 'B'], if: GUARDED_IF } };
  const got = simulateJobs({ jobs, results: { A: 'failure' } });
  is(got, { A: 'failure', B: 'skipped', C: 'skipped' }, 'A 失败 ⇒ 下游全跳（隐式 success()）');
}

{
  // 整个 run 被取消 ⇒ 带 `!cancelled()` 的 job 老实停下。
  const jobs = { A: {}, B: { needs: 'A' }, C: { needs: ['A', 'B'], if: GUARDED_IF } };
  const got = simulateJobs({ jobs, results: {}, ctx: { __workflowCancelled: true } });
  is(got, { A: 'success', B: 'success', C: 'skipped' }, 'run 被取消 ⇒ `!cancelled()` 把 C 停掉');
}

{
  // always() 会连取消时也跑 —— 这正是 lint-workflows 里禁它的理由，这里把差别算出来。
  const jobs = { A: {}, B: { needs: 'A', if: 'always()' } };
  const got = simulateJobs({ jobs, results: { A: 'failure' }, ctx: { __workflowCancelled: true } });
  is(got, { A: 'failure', B: 'success' }, 'always() 连「A 失败 + 整个 run 被取消」时也照跑');
}

{
  // 拓扑序：声明顺序与依赖顺序相反也要算对。
  const jobs = { C: { needs: 'B' }, B: { needs: 'A' }, A: {} };
  const got = simulateJobs({ jobs, results: { A: 'failure' } });
  is(got, { C: 'skipped', B: 'skipped', A: 'failure' }, '声明顺序倒着写也按拓扑序算');
}

/* ═══ H 组：该抛错的地方真的抛错 ═════════════════════════════════════════════════ */
console.log('\n\x1b[1mH 组：该抛错的地方真的抛错（静默给个答案比报错糟得多）\x1b[0m');

throws(() => simulateJobs({ jobs: { A: { needs: 'B' }, B: { needs: 'A' } } }), 'needs 成环', /环/);
throws(
  () => simulateJobs({ jobs: { A: { needs: 'nope' } } }),
  'needs 指向不存在的 job',
  /不存在的 job/,
);
throws(
  () => simulateJobs({ jobs: { A: {} }, results: { B: 'success' } }),
  'results 里有不存在的 job',
  /不存在的 job/,
);
throws(
  () => simulateJobs({ jobs: { A: {} }, results: { A: 'green' } }),
  'results 里有不合法的结果值',
  /不是合法结果/,
);
throws(() => evaluateExpression('needs.*.result', {}), '通配符 `*`', /通配符/);
throws(() => evaluateExpression('nosuchfn()', {}), '不认识的函数', /不认识的函数/);
throws(() => evaluateExpression('bogus.field', {}), '不认识的 context', /不认识的 context/);
throws(() => evaluateExpression("'unterminated", {}), '没闭合的字符串字面量', /没闭合/);
throws(() => interpolate('${{ 1 == 1 ', {}), '没闭合的 `${{`', /没闭合/);
throws(() => evaluateExpression("format('{1}', 'a')", {}), 'format 占位符越界', /只传了/);
throws(() => evaluateExpression('inputs.a == ', {}), '表达式在该有值的地方结束', /结束/);

/* ═══ 结算 ═══════════════════════════════════════════════════════════════════════ */

/*
 * 下限 = 现在这一版的实际条数。**少一条就红** —— 整组被注释掉/import 崩了一半时，
 * 剩下的部分照样会「全部通过」，那种绿正是本仓在清的东西。加了新断言就把这个数一起改，
 * 那是一次显式决定，不是一次没人看见的缩水。
 */
const FLOOR = 94;

console.log('');
if (checked === 0) {
  console.log(
    '\x1b[31m✘ 一条断言都没跑 —— 这个自检本身瞎了（空集合上「全部通过」是最坏的一种绿）\x1b[0m',
  );
  process.exit(1);
}
if (checked < FLOOR) {
  console.log(
    `\x1b[31m✘ 只跑了 ${checked} 条断言，少于下限 ${FLOOR} —— 先怀疑有一整组没跑到\x1b[0m`,
  );
  process.exit(1);
}
if (failed > 0) {
  console.log(`\x1b[31m✘ ${checked - failed} passed, ${failed} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✔ ${checked} passed, 0 failed\x1b[0m`);
process.exit(0);
