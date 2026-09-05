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

  {
    id: '🔴 tool.* 的"借宿主的"靠**散文**认 —— daemon 那句中文改一个词就静默变 0',
    where: 'scripts/ci/e2e-notes-assertions.mjs 的 classifyToolChecks()（`/PATH/i.test(detail)`）',
    since: '2026-09-06 由 #90 的逐格扫描查出（⑤-c），Manager 当天裁决"最严重，但不在那一路修"',
    /*
     * ★ 这条谓词的方向**和它上面那些相反**，值得说清楚，别读混。
     *
     * 缺陷是：判据从 daemon 写给人看的一句中文里**推导语义** ——
     *   `status === 'warn' && /PATH/i.test(detail)` ⇒「这个工具是借宿主 PATH 的」。
     * 那句话（`packages/runtime/src/selfcheck.ts`：「…来自系统 PATH，非本产品安装…」）
     * 改一个词、或者被翻译，`borrowed` 就**恒为 0**，而 e2e-notes 审计末尾那句
     * 「本轮结论：借了宿主 N 个」会**朝着"更干净"的方向**说假话，没有任何东西会红。
     * `selftest-e2e-notes.mjs` 里印过现场：同一台机器、同样借 1 个 ⇒ 报「借了宿主 0 个」。
     *
     * ⚠️ 这是「**从散文里推导语义**」那一族，与产品侧靠正则嗅探文案算警告色同一个病；
     * 只不过这次是**守卫**在嗅散文。本仓在这上面已经栽过三次
     * （`unavailableReason` 两处、`先安装 CPU` 那条正则一处）。
     *
     * 正解：daemon 给这一档一个**结构字段**（`origin: 'store' | 'bundled' | 'system-path'`），
     * 判据改读结构、把那个正则删掉。要动 `apps/daemon` 的契约，等排期。
     *
     * 所以谓词盯的是「**那个结构字段来了没有**」：
     *   · 还没来 ⇒ 0 ⇒ 绿（"还没做"是事实，不是故障 —— 本文件的规矩）；
     *   · 来了   ⇒ 非 0 ⇒ **红给落地那个人看**：他是唯一一个此刻知道
     *     "现在可以改读结构了"的人，而那个正则不会自己消失。
     *
     * ⚠️ 另一个方向（那句中文被改写）由 `selftest-e2e-notes.mjs` 的契约漂移守卫盯着，
     *   **不在这里重复**：两条守卫盯同一个字面量会一起红，读的人分不清该做哪件事。
     */
    predicate: () => countIn('packages/runtime/src/selfcheck.ts', /'system-path'/g),
    expected: 0,
    holds: 'daemon 还没有给这一档结构字段 —— 守卫只能继续嗅那句中文，缺口如实存在',
    onChange: [
      'daemon 那侧出现了 `system-path` —— **结构字段落地了。**',
      '要做的：把 `classifyToolChecks()` 里的 `/PATH/i.test(detail)` 换成读那个字段，',
      '删掉判据旁边那段 🔴 注释，并把 `selftest-e2e-notes.mjs` 的 ⑤-c 登记桩拆掉',
      '（那个桩钉的是"缺口存在"，缺口没了它会自己红）。',
      '⚠️ 别只加字段不改判据：那样两套并存，而散文那套仍然是唯一在跑的。',
    ],
  },
  {
    id: 'e2e-notes 假端点：转写稿一长，多个窗口会造出**同名**主题节点',
    where: 'scripts/ci/e2e-notes-audit.mjs 的 outlineFor() 与 F4-a5 的 nodeList.find()',
    since: '2026-09-06 抽判据时看出来的；jfk.wav 只转出 1 段，所以今天碰不到',
    /*
     * `outlineFor()` 对**每一个** map-reduce 窗口都回同一个标题 `会议主题 <nonce>`，
     * 而 F4-a5 用 `nodeList.find(n => n.text === '会议主题 <nonce>')` 取**第一个**、
     * 期望值却取 `llmState.returnedSegs[0]`（**第一次**调用回的编号）。
     *
     * 导图节点的顺序由产品的合并逻辑决定，不保证与调用顺序一致 ⇒
     * **转写稿一变长（多于一个窗口），这条断言可能开始随机变红。**
     * ⚠️ 那是最难查的一种：红的那句话会指着时间戳说"产品算错了"，
     * 而真正错的是夹具挑错了节点。
     *
     * 今天不发生，因为 `[实测]` jfk.wav 用 whisper-tiny 只转出 **1 段** ⇒ 只有一个窗口。
     * 谓词盯的就是这个前提：**窗口划分那段代码还在不在、还是不是按字符预算切**。
     * `planWindows` 一改（或夹具换了更长的音频），这一条就该被重新看一眼。
     */
    predicate: () =>
      countIn('packages/mindmap/src/generate.ts', /export function planWindows\(/g) +
      countIn(
        'scripts/ci/e2e-notes-audit.mjs',
        /const pick = idx\.length > 1 \? \[idx\[1\]\] : \[idx\[0\]\];/g,
      ),
    expected: 2,
    holds: '分窗逻辑与假端点的挑段逻辑都没动 —— 单窗口那个前提仍然是今天的实况',
    onChange: [
      '`planWindows` 或假端点的挑段逻辑被动过了 —— 多窗口这条路可能真的会走到。',
      '要做的：让 `outlineFor()` 给**每个窗口**回一个可区分的标题（比如带上窗口序号），',
      '并让 F4-a5 按那个标题去找对应的节点，而不是 `find()` 取第一个。',
      '⚠️ 不改的后果不是"漏检"，是**随机变红**，而红的那句话会指错方向（说产品算错了时间戳）。',
    ],
  },

  /* ── 以下是**写不出谓词**的，按规矩登记而不是默默跳过 ───────────────────── */
  {
    id: '🔴 F5-a3 那个 id 说了它没做的事（`PUT /folder` 那一半）',
    where: 'scripts/ci/e2e-notes-audit.mjs 的 `F5-a3 PUT /star 与 PUT /folder 各自生效`',
    since: '2026-09-06 由 #90 查出；Manager 当天裁决"这一轮别改 id，但必须注明"',
    predicate: null,
    whyNoPredicate: [
      'id 写着「PUT /star **与 PUT /folder** 各自生效」，而函数体里一个字都没提 folder ——',
      '`PUT /folder` 真正被验到是在第 8 节的 F5-b1。把 folder 那条路由弄坏，这一格照样绿。',
      '本仓四种守卫失效形态里的第④种：**注释型断言 —— 声称一件从没发生的事**。',
      '',
      '⚠️ **写不出谓词，是因为要判的那件事是「这个名字和这段代码说的是不是同一件事」**——',
      '那是语义比对，不是 grep。这一族的通用解是 `check-comment-facts.mjs`，',
      '但它的判据方向定死在"只会漏检、不会误伤"那一侧（三种可核形态），够不着这一条。',
      '',
      '这一轮做的**不是**修，是**止损**：那半话写进了这一格的 `detail`，',
      '而 `detail` 与 id 一起进 `results[]`、一起被打印 —— 读总表的人看得见"folder 那一半没断"。',
      '**理由是 id 会进凭证**，而凭证是这个仓最值钱的记号（#102 那次就是凭证造假）。',
      '→ 真修法二选一，都要跟 attest 那侧对一遍：把 folder 那一半真的加上，或把 id 改窄。',
    ],
  },
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
