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

import { prepare, sourceFiles } from '../lib/ts-lexer.mjs';

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

/**
 * 数一个正则在**全仓真代码**里命中几次（剥掉注释与字符串内容）。
 *
 * ⚠️ 必须剥注释：「零调用方」这一类谓词的头号假阳性就是**注释里提到了那个名字** ——
 * 而讲究的代码里到处都是这种提及（这条挂起项自己的说明就写着 `toApiError`）。
 * 剥字符串同理（错误信息里写自己的名字是好习惯，见 `check-orphan-exports.mjs` 的记载）。
 * 用 `scripts/lib/ts-lexer.mjs` 那一份共用扫描器，不另抄一个残缺版。
 */
const countRepo = (re) =>
  sourceFiles().reduce((n, f) => {
    const code = prepare(readFileSync(resolve(REPO, f), 'utf8'));
    return n + (code.match(re) ?? []).length;
  }, 0);

export const PENDING = [
  {
    id: '`LlmError.toApiError()` 零调用方，且它承诺的形状自己不满足',
    where:
      'packages/llm/src/errors.ts（`Remediation` 与 `toApiError()`）· ' +
      'scripts/duplicate-declarations-baseline.json 的 `name:Remediation` 一条',
    since: '2026-09-06 立项（#89 复核跨包重复时查出），**本轮刻意不修**',
    /*
     * ## 为什么这条要挂起，而不是顺手改掉
     *
     * 全仓有两个 `Remediation`：`packages/shared/src/events.ts` 的契约把
     * `label`/`labelZh` 定为**必填**（UI 要把它渲染成一颗按钮，没有文案就没有按钮），
     * 而 `packages/llm/src/errors.ts` 那个只有 `{action, params?}`。
     *
     * 怎么收敛是**产品判断，两条路后果不同**：让 llm 侧补上 label（那意味着
     * 每个 LLM 错误都得配一句可点的中英文案），还是让契约承认「有一档可以没有 label」
     * （那意味着前端要为无文案的 remediation 定一个兜底渲染）。**没人拍板时不替它选。**
     *
     * ## ⚠️ 这条真正的看点：**两件事同时成立**
     *
     * ① `toApiError()` **全仓零调用方**（本谓词第一格，今天 = 0）；
     * ② 它**按签名承诺 `ApiErrorBody` 形状**（返回类型逐字写着 `code`/`message`/
     *    `messageZh`/`retryable`/`remediation`，注释也写着「转成 `packages/shared` 的
     *    `ApiErrorBody` 形状」），**而它产出的东西不满足那个契约** ——
     *    它塞进去的是本文件那个没有 label 的 `Remediation`。
     *
     * ⇒ **它是错的，而且正因为没人调用它，所以没人发现它是错的。**
     * 这正是 `check-orphan-exports.mjs` 那一族缺陷的另一种形态：孤儿门禁看的是
     * `export` 声明，**看不见类方法**，所以这一个从它眼皮底下走过去了。
     *
     * ⚠️ 顺带纠一条**转述失实**的线索：立项时收到的说法是「`toApiError()` 把无 label
     * 的那份塞进 API 错误信封」。**那件事今天没有在发生** —— 它没有调用方。
     * llm 的 remediation 实际只走到 `apps/daemon/src/http/rest/notes.ts` 的
     * `details: { hint: err.remediation }`，那不是 `ApiErrorBody.remediation` 那一格。
     * 差别很要紧：前者是"线上正在发错数据"，后者是"一段没通电的错代码"。
     *
     * ## 谓词
     *
     * 复合值，两格任意一格变了都会红 —— 因为这条挂起项的前提正是"两件事同时成立"：
     *
     * · `callers`   —— 有人接上它了。**那一刻这条 bug 从"没通电"变成"正在发错数据"**，
     *                  必须当场做那个产品判断，而不是让它安静地上线。
     * · `llmHasLabel` —— 有人给 llm 侧的 `Remediation` 补了 label，
     *                  也就是选了第一条路 ⇒ 这条挂起项闭合了，该销项。
     */
    predicate: () =>
      [
        `callers=${countRepo(/\.toApiError\s*\(/g)}`,
        `llmHasLabel=${/export interface Remediation \{[^}]*\blabel\b/.test(
          prepare(read('packages/llm/src/errors.ts') ?? ''),
        )}`,
      ].join(','),
    expected: 'callers=0,llmHasLabel=false',
    holds:
      '仍是「零调用方 + 承诺的形状自己不满足」两件事同时成立 —— 没通电的错代码，本轮不修是刻意的',
    onChange: [
      'callers 变了 ⇒ **有人把 `toApiError()` 接上了**。它产出的 remediation 没有',
      '  `label`/`labelZh`，而 `ApiErrorBody` 的契约要求必填 —— 前端拿到的按钮没有文案。',
      '  要做的：当场做那个被挂起的产品判断（llm 侧补 label / 契约承认这一档可以没有），',
      '  **别让它就这么上线**。',
      'llmHasLabel 变了 ⇒ 有人选了「补 label」那条路，这条挂起项闭合 —— 从这里销项，',
      '  并把 `scripts/duplicate-declarations-baseline.json` 里 `name:Remediation` 那条的',
      '  note 一起更新（两份是不是还该分开，那时才有答案）。',
    ],
  },
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
    id: '破坏性按钮（删除/卸载/下载/重置…）点了有没有反应',
    where: 'scripts/ci/e2e-browser-audit.mjs 的 SKIP_WORDS 跳过清单',
    since: '这条腿建起来就一直跳过它们',
    predicate: null,
    whyNoPredicate: [
      '按钮横扫**刻意跳过**破坏性/重量级的（删除、卸载、下载 574 MB…）——',
      '一条会真的删东西或下几百 MB 的审计腿，不会有人愿意跑它，那个取舍是对的。',
      '脚本自己把跳过的条数**明确记在案、不算进通过**，那个标注也是对的。',
      '',
      '但由此得到一个如实的现状：**这些按钮"点了有没有反应"永远没有人验过。**',
      '写不出谓词是因为判据本身要求"真的执行一次破坏性动作然后看反应" ——',
      '在一次性的审计环境里可以做，但需要先给每个动作准备可丢弃的对象，',
      '那是一条新腿的工作量，不是一个谓词。',
      '→ 目前只能靠人：真机上手点一次删除/卸载，确认它有反应。',
    ],
  },
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
