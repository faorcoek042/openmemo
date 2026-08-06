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
 *
 * ## ★ 第三档：**只被再导出**（T-160 补回）
 *
 * 这个扫描固化进 `scripts/` 时**丢了一档**。`backlog-sweep §7` 的 `/tmp` 原型区分三档：
 * 「零引用」/「只有测试引用」/**「只有 index 再导出」**，第三档没跟过来。
 *
 * 后果是**门禁绿着，而它该抓的东西从名单里消失**：下面统计 `prod` 命中时，
 * barrel `index.ts` 里的一句 `export { X } from './api'` 也算一次真引用，
 * 于是任何被 barrel 转出去的导出，哪怕真实消费方为 0，也**永远进不了红名单**。
 * `progress-audit` 按同口径重扫的量化结果：**28 个导出只被再导出、零真实产品调用方，
 * 其中 18 个连测试都没有** —— 里面就有 `useMoveNoteMutation`（笔记移动到文件夹）
 * 与 `useRenameFolderMutation`（文件夹改名），形状与门禁修好过的
 * `useDeleteNoteMutation` **一模一样**。
 *
 * ### 判据钉的是**语句**，不是文件名
 *
 * 原型说的是"只有 index 再导出"，但"叫不叫 index.ts"是**命名约定**，不是事实。
 * 这里改成：把每个文件里的 `export … from '…'` / `export * from '…'` 语句**整段挖掉**，
 * 再数一次命中。命中归零 = 这个文件对它的引用**只是一次转发**。
 * 于是放在任何文件里的再导出都算数，改名 barrel 也骗不过它。
 *
 * ### 为什么只打印不判红
 *
 * 28 条一次性判红会逼人往基线里灌水，而灌过水的名单没人再信。
 * 更要紧的是：**这一档与 `orphans` 的口径必须彼此独立** —— `orphans` 仍然按
 * 「含再导出在内的 `prod === 0`」算，所以本次改动**不会挪动棘轮基线一个字**
 * （两档在定义上不相交：`orphans` 要求 `prod === 0`，本档要求 `prod > 0`）。
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

/**
 * 再导出语句 —— `export { … } from '…'`、`export type { … } from '…'`、
 * `export * from '…'`、`export * as ns from '…'`。
 *
 * **不含**本地 `export { X }`（没有 `from`）：那是"把本文件里的东西导出去"，
 * 不是转发别人的，且它出现在声明所在文件里，本来就会被算进 `self`。
 */
const REEXPORT_RE =
  /export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?)\s+from\s*(['"])[^'"]*\1\s*;?/g;

/** 把再导出语句整段挖成空白，保留其余代码。用于区分"真引用"与"只是转发"。 */
function stripReexports(body) {
  REEXPORT_RE.lastIndex = 0;
  return body.replace(REEXPORT_RE, ' ');
}

const isTestFile = (p) => p.includes('.test.') || p.includes('/__tests__/') || p.includes('/test/');

/**
 * 分档。**参数是文件内容表**，不是从磁盘读 —— 这样自检可以拿一段写死的样本
 * 跑**同一段代码**，而不是复述一遍它的逻辑（复述出来的对照组只能证明复述本身）。
 */
function classify(bodies) {
  /** 同一份 body，但再导出语句被挖空 —— 用来分辨"真引用"与"只是转发"。 */
  const bodiesNoReexport = new Map();
  let reexportStatements = 0;
  for (const [f, body] of bodies) {
    REEXPORT_RE.lastIndex = 0;
    reexportStatements += (body.match(REEXPORT_RE) || []).length;
    bodiesNoReexport.set(f, stripReexports(body));
  }

  /**
   * 有几个文件的"挖空版"**真的和原文不同**。
   *
   * ⚠️ 判据必须读**存进 map 的那个值**，不能读 `stripReexports()` 的返回值 ——
   * 两者看起来等价，但要抓的回归恰恰是"算对了、存错了"：
   * `[实测]` 反向验证时把 `bodiesNoReexport.set(f, stripReexports(body))` 改成
   * `set(f, body)`，这一档从 21 条变成 0 条，而按返回值计数的那版自检**一格都没响** ——
   * 它证明的是"剥离函数还活着"，不是"剥离结果被用上了"。
   */
  let strippedFiles = 0;
  for (const [f, body] of bodies) {
    if (bodiesNoReexport.get(f) !== body) strippedFiles += 1;
  }

  const orphans = [];
  const testOnly = [];
  const reexportOnly = [];
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
      /** 剔掉再导出语句之后，产品代码里还剩几次命中。 */
      let prodReal = 0;
      /** 哪些文件只是把它转发出去。 */
      const forwarders = [];
      for (const [g, gb] of bodies) {
        const hits = (gb.match(re) || []).length;
        if (!hits) continue;
        if (g === f) {
          self += hits - 1; // 减掉声明本身
          continue;
        }
        if (isTestFile(g)) {
          test += hits;
          continue;
        }
        prod += hits;
        const real = ((bodiesNoReexport.get(g) ?? gb).match(re) || []).length;
        prodReal += real;
        if (real === 0) forwarders.push(g);
      }
      if (prod === 0 && self === 0) {
        (test === 0 ? orphans : testOnly).push({ file: f, name: n, test });
      } else if (prod > 0 && prodReal === 0 && self === 0) {
        /*
         * 产品代码里对它的**每一次**命中都发生在再导出语句里 —— 也就是说
         * 「有人把它转出去了，但没有任何人接」。`orphans` 看不到这一档，
         * 因为它的 `prod` 把转发也算成了引用（这正是丢掉的那一档）。
         */
        reexportOnly.push({ file: f, name: n, test, forwarders: forwarders.sort() });
      }
    }
  }

  const cmp = (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  return {
    orphans: orphans.sort(cmp),
    testOnly: testOnly.sort(cmp),
    reexportOnly: reexportOnly.sort(cmp),
    declCount,
    reexportStatements,
    strippedFiles,
  };
}

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
  return { files, ...classify(bodies) };
}

/**
 * 探针的探针：拿一段**写死的**样本跑一遍 `classify()`，证明"只被再导出"这一档真的看得见。
 *
 * 两条设计上的讲究：
 *
 * · **跑的是 `classify()` 本身**，不是复述一遍它的规则。复述出来的对照组只能证明复述
 *   自己是对的 —— `[实测]` 第一版就是复述的，于是"把分档那个 else-if 整段删掉"这条变异
 *   照样全绿。
 * · **阳性对照是写死的样本，不是仓库里某个真实条目。** 真实条目随时会被人接上
 *   （那正是我们想要的结果），到那天自检会红在一件好事上，然后被顺手删掉。
 *   阳性对照必须是不会腐烂的。
 */
function selfTestReexportTier() {
  const sample = new Map([
    [
      'pkg/src/api.ts',
      'export function useThing() { return 1 }\nexport function useUsed() { return 2 }',
    ],
    ['pkg/src/index.ts', "export { useThing, useUsed } from './api';"],
    ['pkg/src/Page.tsx', "import { useUsed } from './index';\nuseUsed();"],
  ]);
  const r = classify(sample);
  const problems = [];
  const tier = r.reexportOnly.map((o) => o.name);
  if (!tier.includes('useThing')) {
    problems.push(
      `阳性对照失败：只被 index 再导出的 useThing 没有落进"只被再导出"这一档（实际 ${JSON.stringify(tier)}）` +
        ' —— 这一档已经丢过一次（固化进 scripts/ 时），所以它必须有人守',
    );
  }
  if (tier.includes('useUsed')) {
    problems.push('阴性对照失败：真的有人 import 的 useUsed 被误判成"只被再导出"');
  }
  if (r.orphans.length !== 0) {
    problems.push(`阴性对照失败：样本里不该有零引用导出，实际 ${JSON.stringify(r.orphans)}`);
  }
  return problems;
}

/* ────────────────────────────── 自检（先跑） ────────────────────────────── */

const { files, orphans, testOnly, reexportOnly, declCount, reexportStatements, strippedFiles } =
  scan();
const selfCheckFailures = [];
if (files.length === 0) selfCheckFailures.push('文件清单是空的');
if (reexportStatements === 0) {
  selfCheckFailures.push(
    '全仓一条 `export … from …` 都没扫到 —— 这个仓库满是 barrel，' +
      '所以只可能是再导出正则失效了（那样"只被再导出"这一档会永远是空的，' +
      '和"真的没有"长得一模一样）',
  );
}
if (reexportStatements > 0 && strippedFiles === 0) {
  selfCheckFailures.push(
    '扫到了再导出语句，却没有任何一个文件在"挖掉再导出"之后发生变化 —— ' +
      '说明这一步没有真的接上（`bodiesNoReexport` 被简化掉了？）。' +
      '这条变异实测会让"只被再导出"从 21 条变成 0 条，而其它每一格都照常绿。',
  );
}
if (reexportOnly.some((o) => o.name === PROBE_EXPORT)) {
  selfCheckFailures.push(`${PROBE_EXPORT} 被报成"只被再导出" —— 它有真实调用方，说明分档瞎了`);
}
selfCheckFailures.push(...selfTestReexportTier());
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

console.log(`ℹ 扫描 ${files.length} 个源文件 / ${declCount} 个导出 / ${reexportStatements} 条再导出语句`);
console.log(
  `ℹ 零引用导出 ${orphans.length} 个（基线 ${allowed.size} 个）· 只有测试引用 ${testOnly.length} 个` +
    ` · 只被再导出 ${reexportOnly.length} 个`,
);

if (testOnly.length) {
  console.log('\nℹ 只有测试引用（不判红，供人看 —— 里面确实藏过真缺陷）：');
  for (const o of testOnly) console.log(`   ${o.file} :: ${o.name}  (test=${o.test})`);
}

if (reexportOnly.length) {
  const noTest = reexportOnly.filter((o) => o.test === 0);
  console.log(
    `\nℹ 只被再导出、零真实产品调用方（不判红，供人看）：${reexportOnly.length} 个，` +
      `其中 ${noTest.length} 个**连测试都没有**`,
  );
  console.log(
    '   这一档是 T-160 补回来的。上面那份"零引用"名单看不见它们 —— barrel 的一句\n' +
      '   `export { X } from …` 被算成了一次真引用。形状与门禁修好过的\n' +
      '   `useDeleteNoteMutation`（笔记建出来就删不掉）完全相同：**功能只做了一半，\n' +
      '   出口开好了、没有人走进去**。带 ⚠ 的是连测试都没有的那些，优先看。',
  );
  for (const o of reexportOnly) {
    const mark = o.test === 0 ? '⚠ ' : '  ';
    console.log(`   ${mark}${o.file} :: ${o.name}  (test=${o.test}, 转发方: ${o.forwarders.join(', ')})`);
  }
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
