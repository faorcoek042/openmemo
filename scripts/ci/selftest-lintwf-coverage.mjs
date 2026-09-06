#!/usr/bin/env node
/**
 * `lintwf-coverage.mjs` 的**门禁那一半** —— 秒级，`pnpm test:ci-scripts` 会跑。
 *
 * ## 分工
 *
 * `lintwf-coverage.mjs` 本体是**手动工具**：7082 个变异、2.5 分钟，回答
 * 「`lint-workflows.mjs` 的每一条规则有没有专属坏输入」。它太贵，而且有 47 条
 * **合法地**不会被它的通用扫描独红（被相邻断言吞掉 / 加法型 / 需要定点坏输入 /
 * 主语是自身常量 —— ⚠️ 其中 39 条**判决仍然是甲**，只是通用族造不出那个坏输入），
 * 做成门禁就是一盏常亮的灯 —— 两周内所有人学会无视它。
 *
 * ⇒ 判决那一半在这里，只有一条、而且不依赖跑任何变异：
 *
 * > **四张登记表里每条 `needle` 必须在 `lint-workflows.mjs` 源码里恰好出现 `count` 次。**
 *
 * 有人动了那 47 条里的任何一条，这里当场红，把他领到那份记录跟前 ——
 * 记录因此不会烂，它不靠谁记得回来重跑那 2.5 分钟。
 *
 * ⚠️ 登记锚在 **needle（源码文本）** 上，不是行号 —— 行号会漂，needle 不会。
 *
 * ## ⚠️ 这份自检**自己**必须先证明会红
 *
 * 一个只在真源码上跑过一次的审计函数，和一个永远返回 `ok: true` 的审计函数，
 * 在输出上分不开（本仓这一周抓到的四道假守卫里有两道正是这个形状）。
 * 所以 B 组拿夹具反向验证 `auditRuleRegistry()` 本身：**少一条要红、多一条也要红、
 * 空源码要红**。
 *
 * ## 它**查不了**什么
 *
 * · 它**不重跑变异**。登记里那些「⇒ 独红」是 `[实测 2026-09-06]` 的结论，
 *   这里只保证**那条规则的源码没被动过**。规则改了 ⇒ needle 对不上 ⇒ 红 ⇒ 人回去重跑。
 * · 新**加**一条规则，如果它恰好也是"扫描抓不到"的那一类，这里不会说话 ——
 *   只有重跑 `lintwf-coverage.mjs` 才看得见（它会把它列进「未登记的空转」）。
 *   ⚠️ 这是这套方法的已知边界，别把这份自检读成"登记表一定是全的"。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADDITIVE_ONLY_RULES,
  REGISTERED_RULES,
  PRECISE_PROBE_RULES,
  SELF_SUBJECT_RULES,
  SUBSUMED_RULES,
  auditRuleRegistry,
  instrument,
} from './lintwf-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT_SRC = readFileSync(join(HERE, 'lint-workflows.mjs'), 'utf8');

let checked = 0;
let failed = 0;
const ok = (m) => {
  checked += 1;
  console.log(`  \x1b[32m✔\x1b[0m ${m}`);
};
const bad = (m) => {
  checked += 1;
  failed += 1;
  console.log(`  \x1b[31m✘\x1b[0m ${m}`);
};
const is = (actual, expected, label) =>
  actual === expected
    ? ok(`${label} → ${actual}`)
    : bad(`${label}：期望 ${expected}，实得 ${actual}`);

console.log('\n\x1b[1mlintwf-coverage 自检\x1b[0m');

/* ═══ A 组：登记表对得上今天的判据源码 ══════════════════════════════════════════ */
console.log('\n\x1b[1mA 组：四张登记表 × 真源码\x1b[0m');

const real = auditRuleRegistry({ source: LINT_SRC });
if (real.ok) ok(`登记表 ${real.checked} 条 needle 全部对得上 lint-workflows.mjs`);
else {
  bad('登记表与判据源码对不上：');
  for (const p of real.problems) console.log(`      ${p}`);
}

/*
 * ⚠️ **登记条数 ≠ 规则条数**：`must(!!s, ` 那一条用 `count: 2` 同时锚住两处
 *   逐字相同的断言（假依赖组与真依赖组各一处，源码上分不开）。
 *   于是 6 条登记 = **7 条规则**。三栏一起念时用的是规则数，别把 6 抄成 7。
 */
is(SUBSUMED_RULES.length, 6, '乙栏登记条数');
is(
  SUBSUMED_RULES.reduce((n, r) => n + (r.count ?? 1), 0),
  7,
  '乙栏覆盖的**规则**数（count 之和）',
);
is(ADDITIVE_ONLY_RULES.length, 29, '丙栏（加法型，删/改族够不着）条数');
is(PRECISE_PROBE_RULES.length, 10, '甲栏·定点坏输入 条数');
is(SELF_SUBJECT_RULES.length, 1, '自身常量栏条数');

/*
 * ★ 空集防线。三张表被谁"顺手清空"时，`auditRuleRegistry` 会**一条不查地报 ok** ——
 *   那种绿和"全部对得上"长得一模一样，正是本仓在清的假绿家族。
 */
is(REGISTERED_RULES.length > 40, true, '登记总数没有被清空（> 40）');
for (const r of REGISTERED_RULES) {
  if (typeof r.needle !== 'string' || r.needle.trim().length < 6) {
    bad(`登记里有一条 needle 太短、锚不住：${JSON.stringify(r.needle)}`);
  }
}
ok('每条 needle 都够长（≥ 6 字符），不会误配到别处');

/* 乙栏每条都要写清**被谁吞掉**与**为什么** —— 一份没有理由的例外表就是下一个手抄名单。 */
for (const r of SUBSUMED_RULES) {
  if (!r.implies || !r.why || r.why.length < 15) bad(`乙栏 \`${r.needle}\` 缺 implies/why`);
}
ok('乙栏每条都写明了「被哪条吞掉」和「为什么必然跟着红」');
for (const r of [...ADDITIVE_ONLY_RULES, ...PRECISE_PROBE_RULES]) {
  if (!r.probe || r.probe.length < 8) bad(`\`${r.needle}\` 没写实测过的坏输入`);
}
ok('丙栏与定点栏每条都写明了 2026-09-06 实测过的那个坏输入');

/* ═══ B 组：★ 反向验证 —— 证明这个审计函数真的会红 ═════════════════════════════ */
console.log('\n\x1b[1mB 组：★ 反向验证（少一条要红、多一条也要红）\x1b[0m');

const ONE = Object.freeze([{ needle: 'needs.<name>.result', bucket: '夹具' }]);
const TWO = Object.freeze([{ needle: 'must(!!s, ', count: 2, bucket: '夹具' }]);

is(auditRuleRegistry({ source: 'x needs.<name>.result y', rules: ONE }).ok, true, '恰好一次 ⇒ 绿');
is(
  auditRuleRegistry({ source: 'nothing here at all', rules: ONE }).ok,
  false,
  '★ 规则被删掉（0 次）⇒ 红',
);
is(
  auditRuleRegistry({ source: 'needs.<name>.result needs.<name>.result', rules: ONE }).ok,
  false,
  '★ 规则被复制成两处（2 次）⇒ 也红（登记就不再指得准了）',
);
is(
  auditRuleRegistry({ source: 'must(!!s, a must(!!s, b', rules: TWO }).ok,
  true,
  'count:2 恰好两次 ⇒ 绿',
);
is(
  auditRuleRegistry({ source: 'must(!!s, a', rules: TWO }).ok,
  false,
  '★ count:2 只剩一次 ⇒ 红（两处相同断言被删了一处）',
);
is(
  auditRuleRegistry({ source: '', rules: ONE }).ok,
  false,
  '★ 空源码 ⇒ 红（不许在空串上"全部通过"）',
);
is(auditRuleRegistry({ source: LINT_SRC, rules: [] }).ok, true, '空规则表本身不红…');
is(
  auditRuleRegistry({ source: LINT_SRC, rules: [] }).checked,
  0,
  '…但 checked=0 会被 A 组那条「登记没被清空」接住',
);

/*
 * ★ 报错必须指得回那一条。一句"登记表对不上"而不说是哪条 needle，
 *   下一个人要重跑 2.5 分钟才知道从哪查起。
 */
const oneProblem = auditRuleRegistry({ source: 'nothing', rules: ONE }).problems.join('\n');
is(oneProblem.includes('needs.<name>.result'), true, '报错里点名了对不上的那条 needle');
is(oneProblem.includes('lintwf-coverage.mjs'), true, '报错里写明了修法是回去重跑那个工具');

/* ═══ C 组：插桩不许改动行号 ═════════════════════════════════════════════════════ */
console.log('\n\x1b[1mC 组：插桩的行号不变式（整个工具的归并键就是行号）\x1b[0m');

/*
 * `lintwf-coverage` 把每一次 `must()` 归到**调用方行号**上。插桩要是多插了一行，
 * 后面所有规则的行号一起漂 ⇒ 结论错位，而且**看起来完全正常**。
 * 所以插桩自己带一条不变式，这里替它验一遍。
 */
const instr = instrument(LINT_SRC);
is(instr.split('\n').length, LINT_SRC.split('\n').length, '插桩前后总行数相同');
is(instr.includes('LWCOV_OUT'), true, '插桩确实接上了记录出口');
is(
  LINT_SRC.split('\n').findIndex((l) => l.startsWith('function must(cond, msg)')),
  instr.split('\n').findIndex((l) => l.startsWith('function must(cond, msg)')),
  '`must()` 自身的行号没漂',
);
let threw = false;
try {
  instrument('const problems = [];\nlet checks = 0;\n// 没有 must() 的源码\n');
} catch {
  threw = true;
}
is(threw, true, '★ `must()` 形状变了 ⇒ 插桩当场抛错（不许静默产出错位的结果）');

/* ═══ 结算 ═══════════════════════════════════════════════════════════════════════ */

/*
 * 下限 = 现在这一版的实际条数。**少一条就红** —— 整组被注释掉/import 崩了一半时，
 * 剩下的部分照样会「全部通过」。加了新断言就把这个数一起改，那是一次显式决定。
 */
const FLOOR = 24;

console.log('');
if (checked === 0) {
  console.log('\x1b[31m✘ 一条断言都没跑 —— 这个自检本身瞎了\x1b[0m');
  process.exit(1);
}
if (checked < FLOOR) {
  console.log(`\x1b[31m✘ 只跑了 ${checked} 条，少于下限 ${FLOOR} —— 先怀疑有一整组没跑到\x1b[0m`);
  process.exit(1);
}
if (failed > 0) {
  console.log(`\x1b[31m✘ ${checked - failed} passed, ${failed} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✔ selftest-lintwf-coverage: ${checked} passed, 0 failed\x1b[0m`);
process.exit(0);
