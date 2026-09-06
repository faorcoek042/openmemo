#!/usr/bin/env node
/**
 * 「**这条自检的每一格，都有一个只有它会响的坏输入吗**」—— 手动跑的工具，不是门禁。
 *
 * ## 它治的病
 *
 * `selftest-e2e-notes.mjs` 里那 30+ 条判据，每条都配了「好输入判绿 / 坏输入判红」。
 * 那证明的是**判据整体**有牙齿。它证不了**判据里的每一格**都有牙齿 ——
 * 一条判据里 5 个 `must()`，只喂一个坏输入，只能证明其中一格在响，
 * **另外四格可以全是空转，而自检一片绿。**
 *
 * `[实测 #90]` 第一次扫：`e2e-notes-assertions.mjs` 的 **94 格里 22 格删掉之后
 * 自检仍然绿**。也就是说那 22 格当天没有任何东西在证明它们有用。
 * 补了 15 条 `☑ 独占` 用例之后降到 7 格（见 `SUBSUMED_LEGS`）。
 *
 * ⚠️ **那 22 格不是靠人读出来的，是靠这个工具跑出来的。**
 * #90 里它是一个跑完就删的临时脚本，只在自检文件头留了一句"复现命令"——
 * Manager 2026-09-06 裁决**入库**，理由逐字如下：
 *
 * > 它是这一轮唯一一个能回答「这条自检有没有专属坏输入」的东西，而那正是我们反复
 * > 栽的那个问题的通用解。留一句复现命令等于把它交给"下一个人记得读文件头"——
 * > 这个仓已经证明过那不成立（**那 22 格就是这么长出来的**）。
 *
 * ## ⚠️ 为什么它**不是**门禁（刻意的）
 *
 *   · **贵**：94 格 × 一次 node 冷启动，几十秒。门禁要的是快速判决。
 *   · **有合法的 7 格会一直"绿"**：它们被相邻那格**数学上**吞掉（见 `SUBSUMED_LEGS`），
 *     删了照样有格子响。把它做成门禁 = 一盏为合法情况常亮的灯，
 *     两周内所有人都学会无视它 —— 那正是本仓反复吃的亏。
 *
 * ⇒ 它的**门禁那一半**在 `selftest-e2e-notes.mjs` 里，只有一条、而且是秒级的：
 *   `SUBSUMED_LEGS` 里每条 `needle` 必须在判据源码里**恰好出现一次**。
 *   有人动了这 7 格里的任何一格，自检当场红，把人领到这份记录跟前。
 *   **这份记录因此不会烂** —— 它不靠谁记得回来重跑。
 *
 * ## 用法
 *
 *   node scripts/ci/leg-coverage.mjs             # notes 腿（默认），列出「删了也绿」的格子
 *   node scripts/ci/leg-coverage.mjs --leg import  # import 腿
 *   node scripts/ci/leg-coverage.mjs --json out.json
 *
 * 退出码：0 = 扫完了（**不代表全覆盖**，看输出）；2 = 工具自己没跑起来。
 * ⚠️ 退出码刻意**不因为"有格子删了也绿"而变 1** —— 见上面"不是门禁"。
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/entrypoint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/**
 * 被扫的那一对：判据模块 + 证明它的自检。**按腿选**（`--leg notes|import`）。
 *
 * ⚠️ 默认仍是 `notes`：这个工具入库时只有那一对，改默认值等于让所有既有的
 * 复现命令（`node scripts/ci/leg-coverage.mjs`）悄悄换了对象 —— 而"换了对象"
 * 与"结论变了"在输出里长得一模一样。
 */
const LEGS = {
  notes: { target: 'e2e-notes-assertions.mjs', prover: 'selftest-e2e-notes.mjs' },
  import: { target: 'e2e-import-assertions.mjs', prover: 'selftest-e2e-import.mjs' },
};
const legAt = process.argv.indexOf('--leg');
const LEG = legAt >= 0 ? process.argv[legAt + 1] : 'notes';
if (!LEGS[LEG]) {
  console.error(`✘ leg-coverage: 不认识的 --leg ${LEG}（有：${Object.keys(LEGS).join(' / ')}）`);
  process.exit(2);
}
const TARGET = LEGS[LEG].target;
const PROVER = LEGS[LEG].prover;

/**
 * 判据模块里**被相邻那一格数学上吞掉**的那些格子。
 *
 * 「吞掉」= ②表里那些坏输入**每一个都会被相邻那格先判红**，于是把这一格删掉
 * 自检**照样绿** —— 没有任何一个用例专门盯着它。
 * 所以它拿不到"专属坏输入"，**但它不是空转**（缺陷仍然会被相邻那格抓住）：
 * 它守的是**那句报错说得清不清楚**。一条
 * `starred total=NaN 不小于全量 total=NaN` 的报错，读日志的人查不出方向。
 *
 * ⚠️ **这不是豁免名单。** 一份「这几格可以不管」的例外表，第二天就会变成
 * 下一个手抄名单（本仓在 `check-orphan-exports` 的裸名匹配、
 * `selftest-launcher-path` 的 LEGS 手写 4/8 上各栽过一次）。
 * 所以这里存的是**可核对的事实**：`needle` 必须在判据源码里恰好出现一次，
 * 由 `selftest-e2e-notes.mjs` 每轮验一遍。动了那一格 ⇒ 当场红 ⇒
 * 有人必须回来重跑这个工具，并更新这份记录。
 *
 * `[实测 2026-09-06]` **99 格 → 91 格有专属坏输入**、这 7 格被吞掉、
 * 另有 1 格（`checkExportEnvelope` 的 `!!expect`）删掉就抛类型错误 ⇒ 判不了，单独一栏。
 * ⚠️ 那 8 格加起来才是 99 —— 报覆盖率时**三栏都要念**，只念 91/99 会把
 * "判不了"混进"没覆盖"，把"没覆盖"混进"有覆盖"，两个方向都失真。
 * ⚠️ `findLegs` 从"只认 `all([`"改成按结构判之后**这三个数一个没变**（同日复测）——
 * 那次改动的目的是让 import 腿那 11 格 `collect` 别再隐形，不是重新定义 notes 腿的格子。
 */
export const SUBSUMED_LEGS = Object.freeze([
  {
    needle: "must(ps.length > 0, '一页都没翻到 —— 分页判据无从谈起')",
    why: 'pages 为空 ⇒ page1 是 undefined ⇒ total 是 NaN ⇒ 下一格 `total > pageSize` 必响',
  },
  {
    needle: 'must(ps.length >= 2,',
    why:
      '只有一页时两条路都堵死：满 50 而 total>50 ⇒ `seen.size ≠ total` 必响；' +
      'total ≤ 50 ⇒ `total > pageSize` 必响',
  },
  {
    needle: 'Number.isFinite(a) && Number.isFinite(s),',
    why: '非数字 ⇒ `s < a` 恒假 ⇒ 下一格必响',
  },
  {
    needle: 'must(s < a,',
    why: '`s ≥ a` ⇒ `a - s ≤ 0 < 3` ⇒ 下一格必响',
  },
  {
    needle: '`/api/selfcheck 里没有 ${CHINESE_SEARCH_CHECK_ID} 这一项 —— **判据本身不见了**`',
    why: "探针缺席 ⇒ `cn?.status` 是 undefined ≠ 'ok' ⇒ 下一格必响",
  },
  {
    needle: 'must(!!hit, `没有拿到 source=segment 的命中：${brief((hits ?? []).slice(0, 3))}`)',
    why: 'hit 缺席 ⇒ `Number.isInteger(undefined)` 为假 ⇒ 下一格必响',
  },
  {
    needle: "must(!!hit, '没有 segment 命中，这条无从谈起')",
    why: 'hit 缺席 ⇒ `Number(undefined) <= dur` 为假（NaN 比较恒假）⇒ 下一格必响',
  },
]);

/**
 * 同一份记录，**import 腿的那一份**（`e2e-import-assertions.mjs`）。
 *
 * 与上面那份的规则逐字相同：存的不是"这几格可以不管"，是**可核对的事实** ——
 * `needle` 必须在判据源码里恰好出现一次，由 `selftest-e2e-import.mjs` 的 ②-bis 每轮验一遍。
 *
 * `[实测 2026-09-06，四条空转全修那一轮]` **20 格 → 17 格有专属坏输入**、这 3 格被吞掉、
 * **0 格判不了**。
 *
 * ⚠️ **两份刻意不合并成一个 map**：`SUBSUMED_LEGS` 这个名字已经被
 * `selftest-e2e-notes.mjs` import 着，改它的形状会让那条腿的记录守卫在
 * 一次无关的重构里静默失效 —— 而它失效的样子（needle 匹配不到 ⇒ 红）
 * 与"有人动了那一格"完全一样，会把人领去查一个不存在的改动。
 */
export const SUBSUMED_LEGS_IMPORT = Object.freeze([
  {
    needle: 'must(!!found, `storeRoot 里找不到 ${name} —— ${whyNeeded}。storeRoot=${storeRoot}`)',
    why:
      '`found` 为 null ⇒ 下一格 `isUnderRoot(storeRoot, null, …)` 把它 resolve 成 ' +
      '`<cwd>/null`，相对路径以 `..` 开头 ⇒ 必响。给不出专属坏输入' +
      '（"找不到"必然连带"不在 storeRoot 底下"也成立），' +
      '它守的是**那句报错说得清不清楚**：「找不到」和「找到了但在别处」要分得开 ——' +
      '后者今天真的会响（storeRoot 里一个指向宿主的软链），两句话指向完全不同的排查方向。',
  },
  {
    needle: "`没有 role='${ASSET_ROLES.original}' 的资产 —— 媒体没落库。note.status=${noteStatus}`",
    why:
      "`asset` 缺席 ⇒ 下一格 `asset?.state === 'ready'` 为假 ⇒ 必响。" +
      '⚠️ 那个可选链是**刻意**的：写成 `asset.state` 的话删掉这一格会当场抛类型错误，' +
      '于是这一格在扫描器里变成"判不了"，而判不了会被误读成没覆盖。' +
      '（历史：这句 `why` 里原本写着一个 `Type` + `Error` 拼起来的词，' +
      '而当时 `runWith()` 判「删了会不会崩」靠的是对整段输出做正则、这句话会被②-bis ' +
      '原样打印出来 ⇒ 工具把这一格从"没覆盖"错记成"判不了"。' +
      '**守卫自己在读散文。** 分档已于 2026-09-06 改成读 `--verdict-out` 那份 JSON，' +
      '现在这段话写什么都不影响判决 —— 留着这条记录，是因为下一个写散文的人需要知道为什么。)',
  },
  {
    needle: "must(f.kind !== 'none', '★ fixture 服务器一个请求都没收到 —— 产品根本没去取这个链接')",
    why:
      "`hits` 为空 ⇒ `classifyFetcher` 回 `kind: 'none'` ⇒ 下一格 `f.kind === 'ytdlp'` " +
      '恒假 ⇒ 必响。给不出专属坏输入（"没人来取"必然连带"取的不是 yt-dlp"也成立）。' +
      '⚠️ 它**不是**冗余：两句报错指向完全不同的排查方向 ——' +
      '「产品根本没出去」查的是 registry / SSRF 防线，' +
      '「取的不是站点解析器」查的是 fallback 链的顺序。' +
      '而且它正是 ⑤-d 那条空转的**弱版本**（此前 §11 里唯一会红的就是它），' +
      '留在第一格是为了让那句更精确的报错排在它后面、而不是替掉它。',
  },
]);

/**
 * 「一格」的判据 —— **按结构，不按名字**。
 *
 * ## ⚠️ 为什么不是一份 `['all([', 'collect([']` 的清单（2026-09-06 裁决）
 *
 * 第一版就是那样：只认 `all([`。import 腿引入 `collect([` 之后，那几格**在这个工具
 * 眼里整个不存在** —— 而"少扫一半"与"全都覆盖了"在输出里长得一模一样
 * （下面 `main()` 那道 `legs.length === 0` 的闸只挡得住一格都扫不到）。
 * 补一个名字进清单就是**又一份会漏的手抄名单**，本仓已经在
 * `check-orphan-exports` 的裸名匹配、T-163 手抄 7/29、`selftest-launcher-path`
 * 的 LEGS 手写 4/8 上各栽过一次。
 *
 * 所以判据换成一句与名字无关的结构话：
 *
 *   > **一个调用，它的第一个实参是数组字面量，而那个数组的每一项都是零参箭头函数。**
 *
 * 那正是这两个判据模块里"一格"的形状（`() => must(…)` / `() => same(…)`），
 * 而它不需要知道外面那个函数叫 `all` 还是 `collect` 还是别的什么。
 *
 * ## ⚠️ 它**已知**漏的形态（写在这里，因为漏了不会有任何东西说话）
 *
 *   · **数组不是字面量**：`collect(xs.map((x) => () => must(…)))` —— 格子数由数据决定，
 *     静态切不出来。`checkRequiredPacksInstalled()` 今天就是这个形状，
 *     它在这个工具里算**一格都没有**（它的三条腿由自检的 ②「每个前缀一个坏输入」覆盖）。
 *   · **有一项不是 `() =>` 箭头**：整块被跳过（宁可少算，也不要把一个切错的区间
 *     报成"这一格没覆盖"—— 那会让人去补一个不存在的用例）。
 *   · **嵌套在别的表达式里的数组字面量**：只要满足上面两条就会被算进来，
 *     哪怕它压根不是判据组合子。今天没有这种误报；真出现了，它会表现成
 *     一格恒"删了也绿"，而不是悄悄消失 —— **方向是对的那一边**。
 */
export function findLegs(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    // 结构：`<标识符或 )> ( [` —— 一个调用，第一个实参是数组字面量
    if (text[i] !== '(' || text[i + 1] !== '[') continue;
    if (!/[A-Za-z0-9_$)\]]/.test(text[i - 1] ?? '')) continue;
    const block = sliceEntries(text, i + 2);
    if (block === null) continue;
    // 每一项都必须是零参箭头函数，否则这不是"一格一格"的那种数组
    if (block.length === 0) continue;
    if (!block.every(([a, b]) => isThunk(text.slice(a, b)))) continue;
    out.push(...block);
    i = block[block.length - 1][1];
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * 这一项是不是一个**零参箭头函数**（判据模块里"一格"的形状）。
 *
 * ⚠️ 必须先剥掉前导的逗号、空白**和注释**。`[实测]` 少了剥注释那一步，
 * `e2e-notes-assertions.mjs` 从 99 格掉到 94 —— 因为有两块的某一项前面挂着一段
 * 一段**块注释**（那两段恰恰是「这一格必须排在前面」「非空虚前提」这类最该被盯住的说明）。
 * **整块被跳过、5 格无声消失**，而输出看起来只是"格子少了点"。
 */
function isThunk(entry) {
  let s = String(entry).replace(/^\s*,/, '');
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end === -1) return false;
      s = s.slice(end + 2);
    } else if (s.startsWith('//')) {
      const nl = s.indexOf('\n');
      if (nl === -1) return false;
      s = s.slice(nl + 1);
    }
    if (s === before) break;
  }
  return /^\(\s*\)\s*=>/.test(s);
}

/**
 * 从数组字面量内部（`open` = `[` 之后一位）切出**深度为 1** 的那些条目。
 *
 * 刻意用最笨的括号计数，不引 parser：这个工具的判决是"删掉之后自检红不红"，
 * 切错了会表现成**语法坏掉**，而那一档被单独报出来（`broke`），
 * 不会被悄悄读成"这一格有覆盖"。
 *
 * @returns {Array<[number, number]>|null} `null` = 括号没配平（不是一个完整的数组）
 */
function sliceEntries(text, open) {
  let depth = 1;
  let j = open;
  let entryStart = open;
  const entries = [];
  while (j < text.length && depth > 0) {
    const c = text[j];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) break;
    } else if (c === ',' && depth === 1) {
      entries.push([entryStart, j + 1]);
      entryStart = j + 1;
    }
    j++;
  }
  if (depth !== 0) return null;
  if (entryStart < j && text.slice(entryStart, j).trim()) entries.push([entryStart, j]);
  return entries;
}

/** 一行能读的摘要（判据源码那一格压成一行）。 */
const snippet = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 96);

/**
 * 在一个隔离目录里跑一次「判据 = mutated，自检 = 原样」。
 *
 * ⚠️ 自检会**读 REPO 里的 TS 源码**做契约漂移守卫。临时目录里那些路径不存在时，
 * 每一次变异都会因为"读不到文件"而红 —— 于是这个工具会把**全部 94 格**报成
 * "有覆盖"，一个彻底的假绿。所以这里把 `apps/` 与 `packages/` 软链过去，
 * 并且下面 `main()` 会**先跑一次没有变异的**，要求它绿（`assertBaselineGreen`）。
 */
function runWith(mutatedSource) {
  const dir = mkdtempSync(join(tmpdir(), 'om-leg-cov-'));
  try {
    mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'ci', TARGET), mutatedSource);
    // 判据模块与自检都可能 import 同目录的别的脚本，整目录复制最省事也最不容易漏。
    // ⚠️ `leg-coverage.mjs` 自己也要复制过去：自检 import 它取 `SUBSUMED_LEGS`。
    //    漏了它 ⇒ 基线那一次就 ERR_MODULE_NOT_FOUND ⇒ 下面那道基线闸会拦住，
    //    而不是让每一格都"红"、把 99/99 报成全覆盖（`[实测]` 第一次跑就撞了这个）。
    /*
     * ⚠️ `e2e-notes-assertions.mjs` 在这份名单里，**即使扫的是 import 腿**：
     *    `e2e-import-assertions.mjs` 从它 re-export `classifyToolChecks`
     *    （跨腿共用的同一条判据，不抄第二份）。漏了它 ⇒ 基线那一次就
     *    `ERR_MODULE_NOT_FOUND` ⇒ 下面那道基线闸拦住，而不是把每一格都报成"有覆盖"。
     */
    for (const f of [
      PROVER,
      'leg-coverage.mjs',
      'mutation-verdict.mjs',
      'platform-scope.mjs',
      'e2e-notes-assertions.mjs',
      /*
       * ⚠️ 审计本体也要：`selftest-e2e-import.mjs` 的④「接线守卫」与⑤「空转的桩」
       *    都**读它的源码**（判据模块有没有被真的接上、那四个缺口还在不在）。
       *    缺了它，基线那一次就红 ⇒ 下面那道闸拦住，而不是把每一格都报成"有覆盖"。
       */
      'e2e-import-audit.mjs',
    ]) {
      /*
       * ★★ **绝不把 TARGET 原样拷回去**：扫 notes 腿时 TARGET 就是
       *    `e2e-notes-assertions.mjs`，拷贝会把上面刚写进去的**变异体覆盖掉** ⇒
       *    每一次变异都变成空操作 ⇒ 每一格都"删了也绿" ⇒ 工具报「0/99 有覆盖」。
       *    那是一个比没有工具更坏的结论，而它看起来只是"覆盖率很低"。
       */
      if (f === TARGET) continue;
      try {
        cpSync(join(HERE, f), join(dir, 'scripts', 'ci', f));
      } catch {
        /* 没有就算了，缺了会在下面表现成跑不起来 */
      }
    }
    for (const d of ['apps', 'packages', 'docs', '.github']) {
      try {
        symlinkSync(join(REPO, d), join(dir, d));
      } catch {
        /* 有些树上没有这一层 */
      }
    }
    /*
     * ⚠️ `scripts/lib/` 也要接过来：`scripts/ci/*.mjs` 里有 `from '../lib/x.mjs'`
     * （入口守卫收敛到 `scripts/lib/entrypoint.mjs` 之后本文件自己就是其中一个）。
     * 缺了它，沙箱里的副本会 ERR_MODULE_NOT_FOUND —— 而"崩在 import 上"和
     * "变异被抓到了"在这个工具里长得一样，那正是下面那道基线闸要防的假绿。
     */
    try {
      symlinkSync(join(REPO, 'scripts', 'lib'), join(dir, 'scripts', 'lib'));
    } catch {
      /* 同上 */
    }
    try {
      symlinkSync(join(REPO, 'package.json'), join(dir, 'package.json'));
    } catch {
      /* 同上 */
    }
    /*
     * ★★ 「红了」有三种，**必须分开**，否则这个工具会把自己骗过去。
     *
     * `[实测]` 接上 ②-bis 之后第一次跑，它报 **98/99 有专属坏输入** —— 假的。
     * 真相是：②-bis 那一段会核对 `SUBSUMED_LEGS` 的 needle 在判据源码里恰好一处，
     * 而这个工具正是**把那一格删掉**再跑 ⇒ ②-bis 当场红 ⇒ 工具读成"这一格有覆盖"。
     * **那 7 格的红来自记录守卫，不是来自任何一个坏输入。**
     * 一个把自己的记录守卫读成覆盖率的工具，比没有工具更坏。
     *
     * ## ⚠️ 分档**按结构**，不读一个字的散文（2026-09-06 裁决）
     *
     * 这三档此前是这么分的：`broke` 靠 `/SyntaxError|ReferenceError|TypeError|…/`
     * 打在**整段输出**上，`recordOnly` 靠匹配一句中文。
     * `[实测]` 我在 `SUBSUMED_LEGS_IMPORT` 的一条 `why` 里写了一次 `Type` + `Error`
     * 拼起来的词（那句 `why` 会被 ②-bis 原样打印出来），它当场把那一格
     * 从「没覆盖」错记成「判不了」。**守卫自己在读散文** —— 与这一整轮在猎的同一个病，
     * 而且长在刚入库的工具上。
     *
     * 现在自检把 `{ cases, failures, failed[{name, kind}] }` 落盘（`--verdict-out`），
     * 这里只读那份 JSON：
     *
     *   · 文件读不出来          ⇒ 它压根没跑到写文件那一行 ⇒ **崩了**，什么都没证明
     *   · `failures` 与退出码对不上 ⇒ 账不自洽（自检自己以别的方式挂了）⇒ 同样算崩
     *   · 全部失败的 `kind` 都是 `subsumed-record` ⇒ 红的只有记录守卫 ⇒ **不算覆盖**
     *
     * 三条判据都只看字段，不看措辞。自检那边的报错文案随便改，这里不受影响。
     */
    const verdictFile = join(dir, 'verdict.json');
    const r = spawnSync(
      'node',
      [join(dir, 'scripts', 'ci', PROVER), '--verdict-out', verdictFile],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    let verdict = null;
    try {
      verdict = JSON.parse(readFileSync(verdictFile, 'utf8'));
    } catch {
      /* 没写出来 = 没跑到那一行 */
    }
    if (verdict === null || !Array.isArray(verdict.failed)) {
      return { green: false, broke: true, recordOnly: false, out };
    }
    const failures = Number(verdict.failures);
    // 账不自洽：自检说 0 条失败却非 0 退出（或反过来）—— 它以别的方式挂了。
    if ((failures === 0) !== (r.status === 0)) {
      return { green: false, broke: true, recordOnly: false, out };
    }
    return {
      green: failures === 0,
      broke: false,
      recordOnly: failures > 0 && verdict.failed.every((f) => f?.kind === 'subsumed-record'),
      out,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * ★ **工具自己的空转防线**：不做任何变异时，那一对必须是**绿的**。
 *
 * 红了说明隔离目录没搭对（最常见：契约守卫读不到 TS 源码）——
 * 那时每一格变异都会"红"，工具会报「94/94 全覆盖」，一个比没有工具更坏的结论。
 */
function assertBaselineGreen(source) {
  const base = runWith(source);
  if (!base.green) {
    console.error('✘ leg-coverage: **没有变异的那一次就红了** —— 隔离目录没搭对，本次结果无效。');
    console.error('  （最常见的原因：自检的契约漂移守卫在临时目录里读不到 apps/ 与 packages/。）');
    console.error(base.out.split('\n').slice(-25).join('\n'));
    process.exit(2);
  }
}

function main() {
  const src = readFileSync(join(HERE, TARGET), 'utf8');
  const legs = findLegs(src);

  console.log(`══ leg-coverage ══ [--leg ${LEG}] ${TARGET} × ${PROVER}`);
  console.log(`   扫到 ${legs.length} 格；每格删掉一次、跑一遍自检（几十秒）\n`);
  if (legs.length === 0) {
    console.error('✘ 一格都没扫到 —— 切法过期了（判据不再用 `all([…])` 的形状？）。');
    console.error('  这条当场退出：一个扫不到东西的工具，失效的样子和"全都覆盖了"一模一样。');
    process.exit(2);
  }

  console.log('   先跑一次**不变异**的，确认隔离目录搭对了…');
  assertBaselineGreen(src);
  console.log('   ✔ 基线绿，结果可信。\n');

  const uncovered = [];
  const brokeAt = [];
  for (const [a, b] of legs) {
    const mutated = src.slice(0, a) + src.slice(b).replace(/^\s*,/, '');
    const r = runWith(mutated);
    if (r.broke) brokeAt.push(snippet(src.slice(a, b)));
    // ★ 只有 ②-bis 的记录守卫在响 = **没有**专属坏输入（见 runWith 里那段）
    else if (r.green || r.recordOnly) uncovered.push(snippet(src.slice(a, b)));
  }

  const covered = legs.length - uncovered.length - brokeAt.length;
  console.log(`── 有专属坏输入（删掉它自检当场红）：${covered} / ${legs.length}`);

  const subsumed = LEG === 'import' ? SUBSUMED_LEGS_IMPORT : SUBSUMED_LEGS;
  const known = subsumed.map((s) => s.needle);
  const isKnown = (s) => known.some((n) => s.includes(snippet(n).slice(0, 40)));

  if (uncovered.length > 0) {
    console.log('');
    console.log(`── 删了也绿（没有专属坏输入）：${uncovered.length} 格`);
    for (const s of uncovered) {
      const k = subsumed.find((x) => s.includes(snippet(x.needle).slice(0, 40)));
      console.log(`   · ${s}`);
      console.log(
        `     ${k ? `已登记：${k.why}` : '🔴 **没有登记** —— 要么补一条专属坏输入，要么想清楚它为什么被吞掉再登记'}`,
      );
    }
    const novel = uncovered.filter((s) => !isKnown(s));
    console.log('');
    console.log(
      novel.length === 0
        ? '   （全部在 SUBSUMED_LEGS 里，与登记一致。）'
        : `   🔴 其中 ${novel.length} 格**不在** SUBSUMED_LEGS 里 —— 那是今天新长出来的空转。`,
    );
  }
  if (brokeAt.length > 0) {
    console.log('');
    console.log(`── 删掉之后语法就坏了（这一格判不了，不算覆盖也不算空转）：${brokeAt.length} 格`);
    for (const s of brokeAt) console.log(`   · ${s}`);
  }

  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt >= 0) {
    const out = process.argv[jsonAt + 1];
    if (!out) {
      console.error('✘ leg-coverage: --json 后面没给路径');
      process.exit(2);
    }
    writeFileSync(
      out,
      `${JSON.stringify({ target: TARGET, total: legs.length, covered, uncovered, broke: brokeAt }, null, 2)}\n`,
    );
    console.log(`\n   （结果已写入 ${out}）`);
  }

  console.log('');
  console.log(`⚠️ 这个工具**不判红绿**（退出码恒 0）：那 ${subsumed.length} 格合法地被吞掉，`);
  console.log(`   做成门禁就是一盏常亮的灯。判决那一半在 ${PROVER} 的 ②-bis 里 ——`);
  console.log('   那份记录的每条 needle 必须在判据源码里恰好出现一次。');
}

// 被 selftest import 时不自动跑。
// ⚠️ 只许用 `isDirectRun()`（判据见 scripts/lib/entrypoint.mjs 文件头）。
if (isDirectRun(import.meta.url, process.argv[1])) main();
