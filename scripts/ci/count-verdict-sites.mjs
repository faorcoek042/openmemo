#!/usr/bin/env node
/**
 * count-verdict-sites.mjs —— 数「判据处」，并且**把口径写成可执行的**。
 *
 * ## 为什么要有这个脚本
 *
 * `coordination/inbox/ci-guard-ablation.md` 的普查表里有一列叫「内联断言」。
 * 那一列**不是同一个口径数出来的**：有的行数的是 `assert` 关键词，有的数的是
 * `ok()` / `judge()` 调用点，有一行数的是运行时条数。于是：
 *
 *   🔴 `proxy-coverage-audit.mjs` 被记成「**873 行 1 条断言**」——
 *      那个 1 是 `assert` 关键词数，而它根本不用 `assert`：它是**布尔账本**
 *      （`record()` 收集 → 末尾按 `bypass`/`untested` 置退出码），真实判据处是 **11**。
 *      「行数大 / 断言少」这个比例读起来像一条空转的守卫，于是有人据此去查它
 *      是不是仪表 —— 查完确认它是守卫（#97）。**那一轮返工是被计数口径带偏的。**
 *
 * 所以口径不再写在注释里由人手抄，而是**写成这个脚本**：数字过期就重跑，
 * 不许再往文档里抄一个会变旧的数。
 *
 * ## ⚠️ 为什么不用 grep
 *
 * `[我核过]` 本机的 `grep` 是 **ugrep 7.8.4**，而
 * `grep -E '(^|[^a-z])rec\('` 在它上面**静默返回 0** —— 组内锚点 + 交替不按预期匹配。
 * 而 `0` 看起来就像"这个脚本一条判据都没有"，正是最坏的那种错。
 * 与 `530d8f6` 那条「macOS 上 `\b` 退化成字面 `b`」同族：
 * **一个会因工具而异地返回 0 的计数器，比没有计数器更坏。**
 * 这里用 Node 的 RegExp，没有这个坑。
 *
 * ## 口径
 *
 * 一条「判据处」= **一个会影响退出码的判断点**。各脚本写法不同，逐个登记在下表里
 * —— 登记是刻意的：**没登记的脚本会被明确报出来，而不是悄悄记成 0**。
 *
 * 用法：`node scripts/ci/count-verdict-sites.mjs`
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CI = dirname(fileURLToPath(import.meta.url));

/**
 * 每个脚本用哪种写法。`null` = 没有助手，直接置 `exitCode = 1`。
 * ⚠️ 加新脚本请连同写法一起登记；**不许**给一个"默认数 assert"的兜底 ——
 *    那正是把账本式脚本压成 0 的那条路。
 */
const REGISTRY = [
  ['e2e-runtime-audit.mjs', ['assert']],
  ['e2e-browser-audit.mjs', ['ok']],
  ['e2e-notes-audit.mjs', ['ok', 'judge']],
  ['e2e-import-audit.mjs', ['fail']],
  ['cold-start-audit.mjs', null],
  ['e2e-coldstart.mjs', ['judge']],
  ['lint-workflows.mjs', ['must']],
  ['simulate-user-launch.mjs', ['ok', 'fail']],
  ['proxy-coverage-audit.mjs', ['record']],
  ['datadir-migrate-audit.mjs', ['rec']],
  ['verify-bundle-upgrade.mjs', ['ok']],
];

/** 注释里的 `rec(` 不是判据处 —— 本仓注释极长，不剥会把数字抬高一大截。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

const countCalls = (code, name) =>
  (code.match(new RegExp(`(^|[^A-Za-z0-9_.$])${name}\\s*\\(`, 'gm')) ?? []).length;

const lines = (f) => readFileSync(f, 'utf8').split('\n').length - 1;

/** 哪个 `selftest-*` import 了它的判据模块 —— 「有自检喂输入」的**判据是 import，不是文件名**。 */
const selftestImporters = new Map();
for (const f of readdirSync(CI).filter((x) => x.startsWith('selftest-') && x.endsWith('.mjs'))) {
  const src = readFileSync(join(CI, f), 'utf8');
  for (const m of src.matchAll(/from '\.\/([a-z0-9-]+\.mjs)'/g)) {
    if (!selftestImporters.has(m[1])) selftestImporters.set(m[1], []);
    if (!selftestImporters.get(m[1]).includes(f)) selftestImporters.get(m[1]).push(f);
  }
}

const rows = [];
let problems = 0;
for (const [file, helpers] of REGISTRY) {
  const p = join(CI, file);
  if (!existsSync(p)) {
    console.error(`::error::登记册里有 ${file}，磁盘上没有 —— 要么改名了要么删了，请同步登记册`);
    problems++;
    continue;
  }
  const code = stripComments(readFileSync(p, 'utf8'));
  const sites =
    helpers === null
      ? (code.match(/exitCode\s*=\s*1/g) ?? []).length
      : helpers.reduce((a, h) => a + countCalls(code, h), 0);
  /*
   * ★ 数出 0 必须出声。一条判据处都没有，要么这个脚本真的是仪表
   *   （那它不该在这张表里），要么**计数器坏了** —— 后者正是这个脚本要防的事。
   */
  if (sites === 0) {
    console.error(`::error::${file} 数出 0 处判据 —— 要么写法变了没登记，要么计数器坏了`);
    problems++;
  }
  const stem = file.replace(/-audit\.mjs$|\.mjs$/, '');
  const mod = ['-assertions.mjs', '-assertions.mjs']
    .map(() => `${stem}-assertions.mjs`)
    .find((m) => existsSync(join(CI, m)));
  const st = mod ? (selftestImporters.get(mod) ?? []) : [];
  rows.push({
    file,
    lines: lines(p),
    sites,
    how: helpers === null ? '直接置 exitCode' : helpers.map((h) => `${h}()`).join('/'),
    mod: mod ? `${mod} (${lines(join(CI, mod))} 行)` : '无',
    selftest: st.length > 0 ? st.join(', ') : '无',
  });
}

rows.sort((a, b) => b.lines - a.lines);
const pad = (s, n) => String(s).padEnd(n);
console.log(
  `\n${pad('脚本', 30)}${pad('行数', 7)}${pad('判据处', 8)}${pad('写法', 18)}${pad('判据模块', 40)}自检`,
);
console.log('-'.repeat(130));
for (const r of rows) {
  console.log(
    `${pad(r.file, 30)}${pad(r.lines, 7)}${pad(r.sites, 8)}${pad(r.how, 18)}${pad(r.mod, 40)}${r.selftest}`,
  );
}
console.log(
  `\n口径：一条「判据处」= 一个会影响退出码的判断点。各脚本写法不同，见本文件的 REGISTRY。`,
);
console.log(`⚠️ 这些数字随每次提交变 —— **别抄进文档**，要现在的数就重跑本脚本。`);
process.exit(problems > 0 ? 1 : 0);
