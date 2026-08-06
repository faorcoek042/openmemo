#!/usr/bin/env node
/**
 * 防线：**写好了、但从来没被接上**的导出。
 *
 * ## 为什么值得一条门禁
 *
 * `backlog-sweep`（T-155）把 35 份 inbox 扫了一遍，15 条"用户能撞上"的缺陷里
 * **有 6 条是这个扫描直接查出来的，而这 6 条在 35 份回执的文本里一个字都没提**。
 * 原因很朴素：**没人认为自己写的东西没被接上**。
 * 这类缺陷不会有人主动报告，只能靠机器扫 —— 与 `check-tracked-sources.mjs` 同一条理由。
 *
 * 它的典型形态不是"死代码"，是**功能只做了一半**：
 *   · `ERROR_MESSAGES_ZH` 零调用方 → 中文界面显示英文错误（T-155 修）
 *   · `useDeleteNoteMutation` 零调用方 → 笔记建出来就永远删不掉（T-155 修）
 *   · `useModelsSourcesQuery` 零调用方 → 下载源界面整块不存在（T-157 ④ 修）
 *   · `stashForRollback` 零调用方 → 回滚按钮恒不渲染，而 UI 承诺了它（T-157 ② 修）
 *
 * ## 判据：**只准变少**
 *
 * 全仓现存的零引用导出有几十个，其中一部分是有意留的（契约类型、公开 API 形状、
 * 刻意保留的兜底）。所以门禁不是"必须为 0"，而是一条棘轮：
 *
 *   · 出现**基线之外**的新条目 → 红。要么接上它，要么删掉它，要么登记进基线并写清理由。
 *   · 基线里的条目**已经有人用了** → 也红。基线只准变短，不许留过期条目 ——
 *     一份不会缩水的豁免名单，几轮之后就没人相信它了。
 *
 * ## 三个"我可能自己瞎掉"的自检（写在检查之前，不是之后）
 *
 * 第一版这个扫描用 `git ls-files` 配一条 `apps/<包>/src/[两个星]/[星].ts` 形状的 glob 取文件，
 * **漏掉了 `src/` 第一层**（`main.ts` 就在那儿），于是报出 251 个假阳性，
 * 连 `createNoteRoutes` 都成了"零调用方"。它没有报错，只是安静地少看了一批文件。
 * → **工具返回空集/残缺集 ≠ 没有。先证明探针能看见你已知存在的东西。**
 *
 * 所以每次运行先过三关，任何一关不过就当场退出：
 *   ① 文件清单非空，且**包含 `src/` 第一层的文件**（就是当年漏掉的那一类）；
 *   ② 扫出的导出总数不能少得离谱（结构变了/正则失效会表现为"突然很干净"）；
 *   ③ 一个**已知一定有调用方**的名字（`createNoteRoutes`）必须**不**出现在结果里。
 *
 * ## 其它两个踩过的坑
 *
 * · **不用 `grep`**：它对含裸控制字节的文件会**整文件静默跳过**（无输出、exit 1，
 *   长得和"0 命中"一模一样，`path-guard` T-143 §4.1 实测过）。这里一律用 Node 读。
 * · **先剥注释再统计引用**：否则一句「`stashForRollback` 见下」的注释就足以让它
 *   看起来"有调用方"。
 *
 * ## 刻意不管的一类
 *
 * "只有测试引用"的导出**只打印、不判红**。测试专用出口（`stubApi`、`__testing`、
 * `pinAuthMode`）本来就该只有测试引用，把它们卷进棘轮只会逼人往基线里灌水。
 * 它们仍然打出来 —— 里面确实藏着真缺陷（导图的三个 `from*` 解析器没有产品入口），
 * 但那是**人看**的清单，不是机器判据。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASELINE_PATH = join(REPO, 'scripts', 'orphan-exports-baseline.json');

/** 一定要能看见的文件 —— 当年那个残缺 glob 恰好漏掉的就是它。 */
const PROBE_FILE = 'apps/daemon/src/main.ts';
/** 一定有调用方的导出 —— 它出现在结果里就说明扫描本身瞎了。 */
const PROBE_EXPORT = 'createNoteRoutes';
/** 导出总数的下限。远低于现状（约 1000+），只用来抓"突然什么都扫不到"。 */
const MIN_EXPORTS = 200;

/**
 * 源文件清单。
 *
 * `git ls-files -z` + 在 Node 里过滤：
 * 不用 shell 管道（Windows 上没有 `grep`，`check-tracked-sources.mjs` 的 T-147
 * 记着 `find` 在 windows-2025 上解析到 `C:\Windows\System32\find.exe` 那次），
 * 也不用花哨的 pathspec（`**` 的层级语义正是第一版出错的地方）。
 */
function sourceFiles() {
  const out = execFileSync('git', ['ls-files', '-z', 'apps', 'packages'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => /\.tsx?$/.test(p))
    .filter((p) => /^(apps|packages)\/[^/]+\/src\//.test(p))
    .filter((p) => !/\/(dist|dist-types|node_modules|\.test-out)\//.test(p));
}

/** 剥掉块注释与行注释。粗糙但足够：目的是不让注释里的名字算作引用。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/[^\n]*$/gm, ' ')
    .replace(/([^:"'`])\/\/[^\n]*/g, '$1 ');
}

const DECL_RE =
  /export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

const isTestFile = (p) => p.includes('.test.') || p.includes('/__tests__/') || p.includes('/test/');

function scan() {
  const files = sourceFiles();
  const bodies = new Map();
  for (const f of files) {
    try {
      bodies.set(f, stripComments(readFileSync(join(REPO, f), 'utf8')));
    } catch {
      /* 读不了就跳过；非空守卫会兜住"全都读不了"这种情况 */
    }
  }

  const orphans = [];
  const testOnly = [];
  let declCount = 0;

  for (const [f, body] of bodies) {
    if (isTestFile(f)) continue;
    const names = new Set();
    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(body))) names.add(m[1]);
    declCount += names.size;

    for (const n of names) {
      const re = new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`, 'g');
      let prod = 0;
      let test = 0;
      let self = 0;
      for (const [g, gb] of bodies) {
        const hits = (gb.match(re) || []).length;
        if (!hits) continue;
        if (g === f) self += hits - 1; // 减掉声明本身
        else if (isTestFile(g)) test += hits;
        else prod += hits;
      }
      if (prod === 0 && self === 0) {
        (test === 0 ? orphans : testOnly).push({ file: f, name: n, test });
      }
    }
  }

  const cmp = (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  return { files, orphans: orphans.sort(cmp), testOnly: testOnly.sort(cmp), declCount };
}

/* ────────────────────────────── 自检（先跑） ────────────────────────────── */

const { files, orphans, testOnly, declCount } = scan();
const selfCheckFailures = [];
if (files.length === 0) selfCheckFailures.push('文件清单是空的');
if (!files.includes(PROBE_FILE)) {
  selfCheckFailures.push(
    `文件清单里没有 ${PROBE_FILE} —— 这正是当年那个残缺 glob 漏掉的那一类（src/ 第一层）`,
  );
}
if (declCount < MIN_EXPORTS) {
  selfCheckFailures.push(`只扫到 ${declCount} 个导出（下限 ${MIN_EXPORTS}）—— 声明正则可能失效了`);
}
if (orphans.some((o) => o.name === PROBE_EXPORT)) {
  selfCheckFailures.push(`${PROBE_EXPORT} 被报成零调用方 —— 它一定有调用方，说明扫描本身瞎了`);
}
if (selfCheckFailures.length) {
  console.error('\n✘ 扫描器自检未通过 —— **在报告任何结论之前**先停下：\n');
  for (const f of selfCheckFailures) console.error(`   · ${f}`);
  console.error(
    '\n判据：工具静默返回空集/残缺集，和"真的没有"长得一模一样。\n' +
      '先证明探针能看见你已知存在的东西，再相信它说"没有"。\n',
  );
  process.exit(1);
}

/* ────────────────────────────── 与基线比对 ────────────────────────────── */

const key = (o) => `${o.file} :: ${o.name}`;
let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch (e) {
  console.error(`✘ 读不到基线 ${BASELINE_PATH}：${String(e)}`);
  process.exit(1);
}
const allowed = new Map((baseline.accepted ?? []).map((e) => [`${e.file} :: ${e.name}`, e]));
if (allowed.size === 0) {
  console.error('✘ 基线是空的 —— 那样下面的比对会把全部现存条目当成"新增"，等于一条永远红的门禁');
  process.exit(1);
}

const current = new Set(orphans.map(key));
const added = orphans.filter((o) => !allowed.has(key(o)));
const stale = [...allowed.keys()].filter((k) => !current.has(k));

console.log(`ℹ 扫描 ${files.length} 个源文件 / ${declCount} 个导出`);
console.log(`ℹ 零引用导出 ${orphans.length} 个（基线 ${allowed.size} 个）· 只有测试引用 ${testOnly.length} 个`);

if (testOnly.length) {
  console.log('\nℹ 只有测试引用（不判红，供人看 —— 里面确实藏过真缺陷）：');
  for (const o of testOnly) console.log(`   ${o.file} :: ${o.name}  (test=${o.test})`);
}

let failed = false;

if (added.length) {
  failed = true;
  console.error(`\n✘ ${added.length} 个**新的**零引用导出（基线里没有）：\n`);
  for (const o of added) console.error(`   ${o.file} :: ${o.name}`);
  console.error(
    '\n它多半不是"死代码"，是**功能只做了一半** —— 写好了、没有人调用它。\n' +
      '三条出路，选一条：\n' +
      '  1. **接上它**（大多数时候这才是本意，也是这条门禁真正想要的结果）；\n' +
      '  2. **删掉它**（确认这个功能不做了）；\n' +
      `  3. 确实该留（契约类型 / 公开 API 形状 / 刻意的兜底）→ 登记进\n` +
      `     ${BASELINE_PATH} 的 accepted 里，并在 note 里写清**为什么它没有调用方**。\n` +
      '     ⚠️ 别只为了让门禁变绿而登记：这份名单是给下一个人看的地图。\n',
  );
}

if (stale.length) {
  failed = true;
  console.error(`\n✘ 基线里有 ${stale.length} 个条目已经**不再是**零引用导出：\n`);
  for (const k of stale) console.error(`   ${k}`);
  console.error(
    '\n有人把它接上了（或者把它删了）—— 这是好事，但基线必须跟着变短。\n' +
      `请从 ${BASELINE_PATH} 里删掉这几行。\n` +
      '判据：**豁免名单只准变短。** 一份不会缩水的名单，几轮之后就没人相信它了。\n',
  );
}

if (failed) process.exit(1);
console.log('\n✔ 没有新的零引用导出，基线也没有过期条目');
