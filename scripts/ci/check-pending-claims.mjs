#!/usr/bin/env node
/**
 * 挂起项的**过期谓词**：一条待办/待裁决，什么时候该被重新看一眼。
 *
 * ## 为什么要有这个东西
 *
 * 本仓反复吃同一种亏：`D-03` 挂了 3 个月、`ADR-003` 的 quarantine 烂了半个月、
 * `D-09 §6` 的条目写着「仍成立」而**代码早就改了**。
 *
 * Manager 2026-08-09 采纳的定性是：
 *
 * > **那些条目烂掉，不是因为缺提醒，是因为那里的"做完了"不是机器可判定的。**
 * > 一条你写不出这种谓词的待办，本身就还没准备好 —— 而那正是有用的信号。
 *
 * 这个思路是从 `e2e-browser-audit.mjs` 的 `KNOWN_DEAD` 推广来的：
 * 那份名单之所以不会烂，是因为「这个按钮还死着吗」**每一轮都被重新测量**，
 * 于是"有人修好了"不需要任何人来汇报 —— **断言自己会发现**。
 *
 * ## ⚠️ 它红的时机（这一条最容易做错）
 *
 * **「这条待办还没做完」在今天是事实，不是故障。** 一个为"还没做"而常态红的守卫，
 * 两周内会被所有人学会忽略，然后它连真正的回归也挡不住
 * （本仓在 `check-bundle-macos-floors` 上已经吃过这一课）。
 *
 * 所以它**只在谓词的取值发生变化时**红：
 *
 *   · 条目说"仍成立"，而谓词说前提已经没了  → **红**（做完了却没人更新名单）
 *   · 条目说"仍成立"，谓词也说仍成立        → 绿（还没做 = 事实，不是故障）
 *
 * 红是给**刚刚让它失效的那只手**看的，不是给下一个读者看的。
 * 与 `check-doc-freshness.mjs` 是同一族（那条盯的是"实测值的输入变了"），
 * 这条盯的是"**挂起项的前提变了**"。
 *
 * ## 写不出谓词的怎么办
 *
 * **不许默默跳过。** 填 `predicate: null` + `whyNoPredicate`，它会被单独列出来并计数。
 * 那一节就是"**这些挂起项目前没有任何机器能替你盯着**"的清单 ——
 * 它本身就是产出：要么补一个谓词，要么承认它得靠人定期看。
 *
 * ## 怎么加一条
 *
 *   { id, where, since, predicate: () => 可比较的值, expected: 记录当时的值,
 *     holds: '谓词等于 expected 时意味着什么', onChange: ['变了之后要做什么'] }
 *
 * `predicate` 只能依赖**机器可判定的输入**（文件内容、grep 命中数、清单条数）。
 * 需要真机 / 人的判断的，走 `predicate: null` 那一档。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 读文件；不存在返回 null（"文件没了"本身常常就是前提变了）。 */
const read = (rel) => {
  const p = resolve(REPO, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
/** 数一个正则在文件里命中几次。文件不存在记 -1，与"命中 0 次"区分开。 */
const countIn = (rel, re) => {
  const t = read(rel);
  if (t === null) return -1;
  return (t.match(re) ?? []).length;
};

export const PENDING = [
  {
    id: 'D-09 §6 #2  settings/:section 仍渲染同一页',
    where: 'docs/design/D-09-ui-gap.md（§6 表格第 2 行）',
    since: '2026-08-06 起记着「仍成立」',
    /*
     * 谓词：路由表里 `settings/:section` 仍然指向**同一个** `<SettingsPage />`。
     * 拆页之后这一行必然改（要么变成多条路由，要么 element 换掉），命中数就会变。
     */
    predicate: () =>
      countIn(
        'apps/web/src/features/settings/Settings.routes.tsx',
        /path:\s*'settings\/:section'\s*,\s*element:\s*<SettingsPage\s*\/>/g,
      ),
    expected: 1,
    holds: '五个 section 仍共用一页 —— 条目"仍成立"是对的',
    onChange: [
      '路由不再是「一条 :section 指向同一个 SettingsPage」了 —— 多半是有人把设置页拆开了。',
      '要做的：把 D-09 §6 表格第 2 行从「仍成立」改成「已闭合」，并写上是哪次改动闭合的。',
    ],
  },
  {
    id: 'D-09 §6 #3  主题下拉三行硬编码、未走 i18n',
    where: 'docs/design/D-09-ui-gap.md（§6 表格第 3 行）',
    since: '2026-08-06 起一直写着「仍成立」，2026-08-09 由本脚本查出其实早已闭合',
    /*
     * 谓词：三个 `<option>` 里还有几个是**硬编码字面量**（不走 `t()`）。
     * 条目成立时应当是 3；有人接上 i18n 之后就变 0。
     */
    predicate: () =>
      countIn(
        'apps/web/src/features/settings/SettingsPage.tsx',
        /<option value="(?:system|light|dark)">(?!\{)/g,
      ),
    expected: 0,
    holds: '三行都已经走 t() —— 条目其实**已经闭合**（本轮由这条谓词查出来并改正）',
    onChange: [
      '硬编码的 <option> 又出现了 —— 有人把 i18n 那一步退回去了。',
      '要做的：确认是不是回归；是的话修回 t()，不是的话更新 D-09 §6 第 3 行的措辞。',
    ],
  },
  {
    id: 'windows-2022 / cuda 的保留理由 = UNKNOWN',
    where: 'docs/design/D-11-ci-platform-facts.md（§ runner 取舍表）',
    since: '2026-08-02 首版架构提交起就是这个值，理由从未被写下',
    /*
     * ★ 这条的谓词形状**和上面两条不同**，值得单独说明。
     *
     * 上面两条问的是"前提还在吗"；这条问的是"**有没有人动过它**"。
     * 因为这一格的问题不是"理由错了"，是"**理由从来没有被记下来**"——
     * 我查过 git 全历史、docs、ADR、逐格取舍记录，都没有（见 D-11 里的考古表）。
     *
     * 所以盯的是**那一格本身**：只要没人动它，UNKNOWN 就是如实的现状，不该红；
     * 一旦有人改了它（比如 windows-2022 弃用后迁到 2025），
     * **那次改动的人是唯一有机会知道理由的人** —— 红给他看，要求他补上。
     */
    predicate: () =>
      countIn(
        '.github/workflows/build-backends.yml',
        /runner:\s*windows-2022,\s*arch:\s*x64,\s*backend:\s*cuda/g,
      ),
    expected: 1,
    holds: '那一格没被动过 —— 理由仍是 UNKNOWN，而"查不到"是如实的现状，不是故障',
    onChange: [
      '有人动了 windows-2022/cuda 这一格。**你是唯一有机会知道理由的人。**',
      '要做的：在 D-11 那张表里把这一格的理由补上（或写明"迁走了，原因仍 UNKNOWN"），',
      '并更新本文件里这一条的 expected。',
      '⚠️ windows-2022 已被 GitHub 标记弃用，所以这一天迟早会到。',
    ],
  },

  /* ── 以下是**写不出谓词**的，按规矩登记而不是默默跳过 ───────────────────── */
  {
    id: 'Windows VC++ 2015-2022 运行时：干净机器上到底缺不缺',
    where: 'docs/DEPLOYMENT.md §1.3 ③',
    since: '标着 `[未验证：需一台干净的 Windows]`',
    predicate: null,
    whyNoPredicate: [
      '判据是"**一台没装过 VC++ 运行时的真 Windows**上双击会不会报缺 DLL"。',
      'CI 的 windows runner 一定装了那套运行时，**在那儿测永远是绿的，而绿得没有意义**。',
      '也就是说：这条不是"还没人去测"，是**这个环境结构上测不了** ——',
      '与 D-11 里「Windows + NVIDIA CUDA 需要真硬件」是同一类。',
      '→ 只能靠人：拿一台干净 Windows 跑一次，或收集用户反馈。',
    ],
  },
];

/* ═══════════════════════════ 跑 ═══════════════════════════════════════════ */

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const items = only ? PENDING.filter((p) => p.id.includes(only)) : PENDING;

let changed = 0;
let held = 0;
const noPredicate = [];

console.log('挂起项 · 过期谓词对账\n');

for (const p of items) {
  if (p.predicate === null) {
    noPredicate.push(p);
    continue;
  }
  let actual;
  try {
    actual = p.predicate();
  } catch (e) {
    // 谓词自己炸了也要出声 —— 一个悄悄抛异常的守卫等于没有守卫
    console.log(`✘ ${p.id}`);
    console.log(`   谓词求值时抛了异常：${e.message}`);
    changed++;
    continue;
  }
  if (actual === p.expected) {
    held++;
    console.log(`✔ ${p.id}`);
    console.log(`   谓词 = ${JSON.stringify(actual)}（与登记值一致）—— ${p.holds}`);
  } else {
    changed++;
    console.log(`✘ ${p.id}`);
    console.log(`   登记时：${JSON.stringify(p.expected)}    现在：${JSON.stringify(actual)}`);
    console.log(`   位置：${p.where}`);
    console.log(`   ${p.since}`);
    console.log('');
    for (const line of p.onChange) console.log(`   ${line}`);
  }
  console.log('');
}

if (noPredicate.length > 0) {
  console.log('─'.repeat(88));
  console.log('⚠️ 以下挂起项**没有机器可判定的过期谓词** —— 没有任何东西在替你盯着它们：');
  console.log('');
  for (const p of noPredicate) {
    console.log(`   · ${p.id}`);
    console.log(`     位置：${p.where}   ${p.since}`);
    for (const line of p.whyNoPredicate) console.log(`     ${line}`);
    console.log('');
  }
  console.log('   这一节**不判红绿**：写不出谓词是事实，不是故障。');
  console.log('   但它必须**被看见** —— 要么有人补一个谓词，要么承认它得靠人定期看。');
  console.log('');
}

console.log('─'.repeat(88));
console.log(`谓词仍成立 ${held} 条 · 取值变了 ${changed} 条 · 没有谓词 ${noPredicate.length} 条`);

if (changed > 0) {
  console.log('');
  console.log('✘ 有挂起项的**前提变了**，而名单还没更新。');
  console.log('  注意：红的不是"这件事还没做完"（那是事实），而是"它的状态变了却没人改名单"。');
  process.exit(1);
}
console.log('✔ 没有过期的挂起项。');
