#!/usr/bin/env node
/**
 * count-verdict-sites.mjs —— 数「判据处」，并且**把口径写成可执行的**。
 *
 * ## 为什么要有这个脚本
 *
 * `coordination/inbox/ci-guard-ablation.md` 的普查表里有一列叫「内联断言」。
 * 那一列**不是同一个口径数出来的**，于是：
 *
 *   🔴 `proxy-coverage-audit.mjs` 被记成「**873 行 1 条断言**」—— 那个 1 是
 *      `assert` 关键词数，而它根本不用 `assert`：它是**布尔账本**
 *      （`record()` 收集 → 末尾按 `bypass`/`untested` 置退出码），真实判据处是 **11**。
 *      「行数大 / 断言少」读起来像一条空转的守卫，于是有人据此去查它是不是仪表；
 *      查完确认**它是守卫**（#97）。**那一轮返工是被计数口径带偏的。**
 *
 * ## ⚠️ 这个脚本自己犯过同一个错（2026-09-06 第二轮修）
 *
 * 第一版（#99）用的是一份**手写的 11 条登记册**：写法逐条抄在这里，表里有谁就数谁。
 * 那正是本仓已经栽过三次的那个形状 —— `lint-workflows` 的「手抄 7 条 selftest」（T-163）、
 * `selftest-launcher-path` 的「手写 4 条 LEGS」，都是**手抄名单错了两次**之后才改成扫描的。
 * 一份写死的名单，第二天就是新的手抄名单。而这一版正是因为只盯着那 11 个，
 * **漏掉了第四种写法（收集器）整整一族**。
 *
 * 现在改成**扫全量 + 自动识别写法**；名单只用来记**例外**，例外必须带理由。
 *
 * ## 口径：一条「判据处」= 一个会影响退出码的判断点
 *
 * `[我核过]` 扫全量之后，本仓至少有 **六种**写法。按 `assert` 关键词数，
 * 后四种全都被压到 0~1：
 *
 *   ① `assert()` 抛出       —— 不显式退出，靠未捕获异常让 Node 非零退出
 *   ② 显式助手             —— `ok()` / `fail()` / `judge()` / `must()`
 *   ③ **布尔账本**         —— `rec()`/`record()` 收 `PASS`/`FAIL`，末尾 `exit(fail>0?1:0)`
 *   ④ **收集器**           —— `problems/violations.push(...)`，末尾按 `.length` 退出
 *   ⑤ **`main()` 返回退出码** —— 判据是 `return 1`，末尾 `.then((code) => process.exit(code))`
 *                            （`probe-warmup-verify.mjs`：产品声明被证伪 ⇒ `return 1`）
 *   ⑥ **聚合谓词**         —— 判断是一个作用在整张表上的布尔式（`exit(allPass ? 0 : 1)`），
 *                            没有逐条判据处可数（`summarize-gate.mjs`）
 *
 * ③④⑤⑥ 都是「**多处判断 → 一个出口**」或「**一条判断管一整张表**」，
 * 所以**"退出点只有一个"不等于"判据只有一条"**。这是这个脚本存在的全部理由。
 *
 * ## ⚠️ 为什么不用 grep
 *
 * `[我核过]` 本机的 `grep` 是 **ugrep 7.8.4**，而 `grep -E '(^|[^a-z])rec\('`
 * 在它上面**静默返回 0** —— 组内锚点 + 交替不按预期匹配。而 `0` 看起来就像
 * "这个脚本一条判据都没有"，正是最坏的那种错。与 `530d8f6` 那条
 * 「macOS 上 `\b` 退化成字面 `b`」同族：
 * **一个会因工具而异地返回 0 的计数器，比没有计数器更坏。**
 *
 * ## 它会判红的条件
 *
 * · 一个**守卫**被数出 **0 处判据** ⇒ 要么写法变了没被认出来，要么扫描器坏了。
 *   两种都得有人当场看一眼 —— **不许悄悄记成 0**。
 * · **仪表登记册**（`check-workflow-expiry.mjs::INSTRUMENTS`，唯一事实来源）里的某一条
 *   长出了真判据 ⇒ 它可能已经不是仪表了，那条登记要重读。
 *   （一个被当成仪表的守卫，它的绿会被所有人忽略 —— 那比没有它更坏。）
 * · 登记册指向的文件不存在。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS } from './check-workflow-expiry.mjs';
import { isDirectRun } from '../lib/entrypoint.mjs';

const CI = dirname(fileURLToPath(import.meta.url));

/** 注释里的 `rec(` 不是判据处 —— 本仓注释极长，不剥会把数字抬高一大截。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

const calls = (code, name) =>
  (code.match(new RegExp(`(^|[^A-Za-z0-9_.$])${name}\\s*\\(`, 'gm')) ?? []).length;

/** 显式助手的名字表。**只用于识别写法**，不是白名单：没命中会往下走 ③④。 */
const HELPERS = ['assert', 'must', 'judge', 'ok', 'fail', 'rec', 'record', 'expect'];

/**
 * 认出这个脚本用的是哪一种写法，并数出判据处。
 *
 * ⚠️⚠️ **这个数是下界，只用来发现「0」。不许拿去比较脚本之间的判据密度。**
 *
 * 为什么把话说这么死：④ 收集器那一类要从退出决策倒着猜哪个数组是判据容器，
 * 而它**会猜错**。第一版在 `check-elf-glibc.mjs` 上挑中了 `stack.push()`
 * —— 深度优先遍历用的栈，跟判据毫无关系 —— 于是给出"1 处判据"；
 * 换了个窗口之后又在 `check-comment-facts.mjs` 上挑中 `narrated`（那是"跳过不判"的那一类）。
 *
 * **一个错的小数字，和当初那个「1 条断言」是同一种伤：它看起来像结论。**
 * 所以这里刻意**不再追求精确计数** —— 追求精确计数就是在重造那个坑。
 * 这个脚本可靠地做三件事，都不依赖数得准：
 *   ① 把脚本分成 守卫 / 自检 / 仪表 / 判据库
 *   ② 说出它用的是哪一种写法
 *   ③ **让「一个守卫被数出 0」变成一件必须有人看的事**
 */
export function detect(code, helpers = HELPERS) {
  // ① assert 抛出
  if (/from ['"]node:assert/.test(code)) {
    const n = calls(code, 'assert') + (code.match(/assert\.[a-zA-Z]+\(/g) ?? []).length;
    if (n > 0) return { idiom: 'assert 抛出', sites: n };
  }
  // ② 显式助手：取命中最多的那个
  let best = { idiom: '', sites: 0 };
  for (const h of helpers) {
    const n = calls(code, h);
    if (n > best.sites) best = { idiom: `${h}()`, sites: n };
  }
  /*
   * ④ 收集器：`problems/violations/findings.push(...)`，末尾按 `.length` 退出。
   *
   * ⚠️ **必须从「退出决策」倒着找那个数组，不能见 `X.push(` 就算。**
   *    第一版是后者，于是在 `check-elf-glibc.mjs` 上挑中了 `stack.push()`
   *    —— 那是深度优先遍历用的栈，跟判据毫无关系 —— 数出个"1 处判据"。
   *    **一个错的小数字和「1 条断言」那个错的小数字是同一种伤**：它看起来像结论。
   */
  const redSpots = [
    ...code.matchAll(/process\.exit\(\s*1\s*\)|exitCode\s*=\s*[1-9]|return\s+[1-9]\s*;/g),
  ];
  const gates = new Set();
  for (const m of redSpots) {
    const before = code.slice(Math.max(0, m.index - 600), m.index);
    for (const g of before.matchAll(/([A-Za-z_$][\w$]*)\s*(?:\.length|\.size)/g)) gates.add(g[1]);
  }
  let coll = { idiom: '', sites: 0 };
  for (const name of gates) {
    const n = calls(code, `${name}\\.push`) + calls(code, `${name}\\.add`);
    if (n > coll.sites) coll = { idiom: `收集器 ${name}.push()`, sites: n };
  }
  if (coll.sites > best.sites) best = coll;
  if (best.sites > 0) return best;
  // ⑤ `main()` 返回退出码，末尾 `.then((code) => process.exit(code))`
  //    —— 判据是函数体里的 `return 1`，不是任何一处 `process.exit(1)`。
  //    `probe-warmup-verify.mjs` 就是这种：`warm.ok && !after.ok` ⇒ `return 1`（产品声明被证伪）。
  //
  // ⚠️ **必须排在下面 exit(1) 那一条之前。** 这种脚本结尾一定有个 rejection handler
  //    `(e) => process.exit(1)`；先数 exit(1) 就会把"脚本自己崩了"当成它唯一的判据，
  //    从而把一个有 N 处 `return 1` 的守卫记成"1 处"。顺序本身是判据的一部分。
  if (/process\.exit\(\s*code\s*\)/.test(code)) {
    const n = (code.match(/return\s+[1-9]\s*;/g) ?? []).length;
    if (n > 0) return { idiom: 'main() 返回退出码', sites: n };
  }
  // ⑥ 直接置 exitCode / exit(1)
  //
  // ⚠️ **「脚本自身出错」那一发不算判据处。** 仪表的定义就是"唯一的 exit(1) 是
  //    脚本自己崩了，不是产品坏了"（`probe-cold-timing.mjs` 结尾那个 rejection
  //    handler 正是这种）。把它算成判据，仪表就会被误报成守卫 —— 而那条误报
  //    每轮都红、每轮都没人要做，最后训练所有人忽略这道门。
  const setsRed = (code.match(/exitCode\s*=\s*[1-9]/g) ?? []).length;
  const e1 = [...code.matchAll(/process\.exit\(\s*1\s*\)/g)].filter((m) => {
    const before = code.slice(Math.max(0, m.index - 400), m.index);
    return !/catch\s*[({]|脚本自身出错|\.stack|Unhandled/.test(before);
  }).length;
  if (setsRed >= e1 && setsRed > 0) return { idiom: '直接置 exitCode', sites: setsRed };
  if (e1 > 0) return { idiom: 'exit(1)', sites: e1 };
  // ⑦ 聚合谓词：判断是**一个作用在整张表上的布尔式**（`exit(allPass ? 0 : 1)`），
  //    没有逐条判据处可数。`summarize-gate.mjs` 就是这种：
  //    `allPass = classify(gate)==='通过' && 失败===0 && 未验证===0`。
  //    它**是守卫、判据也正常**，只是"判据处"这个量纲对它不适用 —— 如实记 1 条聚合判据。
  if (/process\.exit\(\s*[A-Za-z_$][\w$]*\s*\?/.test(code)) {
    return { idiom: '聚合谓词（整表一条）', sites: 1 };
  }
  return { idiom: '(认不出)', sites: 0 };
}

/** 扫全量，返回 { rows, problems }。导出是为了让自检能喂它输入。 */
export function scan({ dir = CI, instruments = INSTRUMENTS, helpers = HELPERS } = {}) {
  const instrumentFiles = new Set(instruments.map((i) => basename(i.script)));
  const problems = [];
  const rows = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.mjs'))
    .sort()) {
    const raw = readFileSync(join(dir, f), 'utf8');
    const code = strip(raw);
    const lines = raw.split('\n').length - 1;
    const isLib = !/process\.exit\(/.test(code) && !/exitCode/.test(code);
    const isInstrument = instrumentFiles.has(f);
    /*
     * ⚠️ 顺序要紧：`selftest-` 要在 `isLib` **之前**判。
     *    用 `assert` 抛出的自检**没有任何 `process.exit`**（靠未捕获异常非零退出），
     *    先判 `isLib` 会把它们记成"判据库" —— `selftest-summarize-gate.mjs` 就被这么记过。
     */
    const kind = isInstrument
      ? '仪表'
      : f.startsWith('selftest-')
        ? '自检'
        : isLib
          ? '判据库'
          : '守卫';
    const { idiom, sites } = detect(code, helpers);

    if (kind === '守卫' && sites === 0) {
      problems.push(
        `${f} 是守卫（有退出码路径）却被数出 **0 处判据** —— ` +
          `要么它的写法这个脚本不认识（请加进 HELPERS 或收集器识别），要么扫描器坏了。` +
          `两种都得有人当场看一眼，**不许悄悄记成 0**。`,
      );
    }
    if (kind === '仪表' && sites > 0) {
      problems.push(
        `${f} 登记在 INSTRUMENTS（"永远 exit 0，是仪表不是门禁"）里，` +
          `却被认出 ${sites} 处判据（${idiom}）—— 它可能已经不是仪表了，请重读那条登记。` +
          `**一个被当成仪表的守卫，它的绿会被所有人忽略。**`,
      );
    }
    rows.push({ f, lines, kind, idiom, sites });
  }
  for (const i of instruments) {
    if (!existsSync(join(dir, basename(i.script))))
      problems.push(`INSTRUMENTS 指向的 ${i.script} 不存在 —— 删掉那条登记，或者它被改名了。`);
  }
  return { rows, problems };
}

// 被 selftest import 时不自动跑。
// ⚠️ 只许用 `isDirectRun()`（判据见 scripts/lib/entrypoint.mjs 文件头）。
if (isDirectRun(import.meta.url, process.argv[1])) {
  const { rows, problems } = scan();
  const order = { 守卫: 0, 自检: 1, 仪表: 2, 判据库: 3 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || b.lines - a.lines);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('脚本', 34)}${pad('类别', 8)}${pad('行数', 7)}${pad('≥判据处', 9)}写法`);
  console.log('-'.repeat(104));
  for (const r of rows) {
    console.log(
      `${pad(r.f, 34)}${pad(r.kind, 8)}${pad(r.lines, 7)}${pad(r.sites ? '≥' + r.sites : '-', 9)}${r.idiom}`,
    );
  }
  const by = (k) => rows.filter((r) => r.kind === k).length;
  console.log(
    `\n合计 ${rows.length}：守卫 ${by('守卫')} · 自检 ${by('自检')} · 仪表 ${by('仪表')} · 判据库 ${by('判据库')}`,
  );
  console.log('口径：一条「判据处」= 一个会影响退出码的判断点；已认出的六种写法见本文件头。');
  console.log('⚠️ 「≥判据处」是**下界，只用来发现 0**  —— 不许拿它比较脚本之间的判据密度，');
  console.log('   也别抄进文档（收集器那一类会挑错数组；详见本文件 detect() 上面那段）。');

  if (problems.length > 0) {
    console.error(`\n✘ ${problems.length} 条要有人看：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('\n✔ count-verdict-sites: 没有守卫被数出 0，仪表登记册与实际一致。');
}
