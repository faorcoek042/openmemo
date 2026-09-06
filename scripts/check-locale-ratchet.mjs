#!/usr/bin/env node
/**
 * ★ 仓库级守卫：**翻译 key 不许被静默丢掉。**
 *
 * ## 事故（今天，正在发生）
 *
 * 跑测试时 daemon 红在 `Unexpected end of JSON input`。查下去：
 * `apps/web/src/app/i18n/locales/zh-CN.json` 当时是 **0 字节** —— 另一路
 * read-modify-write 的中间态。20 秒后恢复成 53 KB，**但刚加的
 * `search.tokenizerDegraded` 没了**：对方是从一个**早于它的版本**重写整个文件的。
 *
 * > **共享树上按整文件重写 JSON = 静默丢掉别人刚加的 key。
 * > 它不报错、不冲突、git 也不提示** —— 只有测试碰巧读到中间态才暴露。
 *
 * ## ⚠️ 判据不是"照抄测试文件棘轮"，理由是量出来的
 *
 * 本来要照 `check-test-ratchet.mjs` 做「在册 key 消失 → 红」。**我先量了历史，
 * 结论是那样做会造一盏几乎只为合法工作亮的灯**（`[实测]` 75 个改过 locale 的提交）：
 *
 *   会触发「key 消失」的提交：**8 个**（占 10.7%，约每天一次）
 *   其中 5 个是**改名**（key 搬家，remove+add 同时发生）、3 个是**清理**（功能整块下线）
 *   **真正的意外丢失：0 个**
 *
 * → 那条判据的历史精确率是 **0/8**：8 次全是误报，0 次真阳性。
 * 这和我今天已经推翻过一次的「新增未登记判红」是同一个形状，不再犯第二次。
 *
 * **而且它连这次的事故都抓不到** —— 丢掉的那个 key 从来没提交进 zh-CN，
 * 「在册」名单里根本没有它。
 *
 * ## 所以判据换成三条**量过、误报为 0** 的
 *
 * ① **两份 locale 的 key 集合必须一致**（parity）。
 *    `[实测]` 75 个提交里 **0 次**因它变红 —— 因为改名/清理**总是对两份同时做**，
 *    parity 全程是绿的。而**整文件重写恰恰是不对称的**（只重写一份），
 *    正好落在这条上。**它今天就是红的，抓到的是一个真·线上 bug**（见下）。
 * ② **源码里 `t('…')` 用到的 key，每份 locale 都必须有**（认 i18next 复数后缀）。
 *    `[实测]` 632 个字面量 key 里只判出 **1** 条，就是那个真 bug；
 *    误报 0（唯一一个像误报的 `app.tasksBadge` 是复数 key，已识别）。
 *    这条补上 parity 的盲区：**两份被同时重写**时 parity 看不出来，但代码还在用它。
 * ③ **文件必须是合法 JSON 且 key 数不低于地板**。这条直接对着事故里那个
 *    **0 字节中间态**：截断/清空/整块丢失当场红，而它便宜到几乎没有成本。
 *
 * ## 为什么这里**没有** `floor` 整数（和测试文件棘轮的真实差别）
 *
 * 那条棘轮的 `floor` 防的是「有人绕过 `removed` 直接把行从名单里删掉」。
 * 这里**不需要**：本文件的豁免名单 `asymmetric` **只会削弱**门禁 ——
 * 删掉一条豁免，门禁只会**更严**（当场红），藏不住任何东西。
 * `floor` 要防的那个方向在这个形状里不存在。**不为对称而对称。**
 *
 * 同理没有 `--update`：新增一个测试文件是天天发生的良性事件，
 * 而**一条不对称的 locale key 永远是可疑的** —— 它必须是一次**手写理由**的显式决定，
 * 不能被一条命令批量洗白。
 *
 * ## 用法
 *
 *   node scripts/check-locale-ratchet.mjs          # 门禁模式
 *   node scripts/check-locale-ratchet.mjs --json   # 机器可读
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const LOCALE_DIR = 'apps/web/src/app/i18n/locales';
const ALLOW_PATH = join(REPO, 'scripts', 'locale-allowlist.json');

/** 每份 locale 至少要有这么多 key。低于它 = 文件被截断/清空，不是"翻译变少了"。 */
const MIN_KEYS = 700;
/**
 * 探针：这个 key 必须在每份 locale 里，用来证明**扫描真的读到了嵌套内容**
 * （⑤A-2：守卫的第一条断言必须是"我真的看到东西了"，空集返回绿比没守卫更坏）。
 *
 * ⚠️ 刻意**不用**事故里那个 `search.tokenizerDegraded` 当探针，虽然那样更"应景"：
 * 探针缺失是 `exit 1` 的自检失败，会**抢在 parity 之前短路**，于是真正该说的那句
 * 「zh-CN 缺这个 key，用户会看到原始 key 串」就永远打不出来 ——
 * **自检的职责是证明扫描没坏，判案是 parity 的职责，两者不能互相顶替。**
 */
const PROBE_KEY = 'search.title';

/**
 * ⚠️ 路径不能用 `.` 拼：本仓有 6 个 key 的**名字里本身带点**
 * （`tasks.lane` 下的 `net.download` / `cpu.media` / `gpu.asr` …）。
 * 用 `.` 拼会把两种不同结构压成同一个字符串，parity 就可能对着错的东西比。
 * 所以内部一律用 NUL 拼；只有要和源码里的 `t('a.b')` 字面量比时才转成点式。
 */
const SEP = '\u0000';

function flatten(obj, prefix = [], out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = [...prefix, k];
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out.add(path.join(SEP));
  }
  return out;
}

const asDotted = (k) => k.split(SEP).join('.');

/** 读**已提交的那棵树**（不是索引）—— 共享树的索引里装着别人还没提交的东西。 */
function gitShow(path) {
  return execFileSync('git', ['show', `HEAD:${path}`], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function localeFiles() {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split(SEP)
    .filter((p) => p.startsWith(`${LOCALE_DIR}/`) && p.endsWith('.json'))
    .sort();
}

const wantJson = process.argv.includes('--json');
const problems = [];
const say = (s) => console.error(s);

/* ── ① 自检：文件在、是合法 JSON、没被截断 ─────────────────────────────────── */
const files = localeFiles();
if (files.length < 2) {
  say(`✘ 只找到 ${files.length} 份 locale（期望至少 2）—— 扫描范围坏了，不是"语言变少了"`);
  process.exit(1);
}

const keysOf = new Map();
for (const f of files) {
  let parsed;
  try {
    parsed = JSON.parse(gitShow(f));
  } catch (e) {
    // 这一条直接对着事故里那个 0 字节中间态
    say(`✘ ${f} 不是合法 JSON：${e.message}`);
    say('  整文件重写/截断会让它变成这样。这不是格式问题，是**内容没了**。');
    process.exit(1);
  }
  const keys = flatten(parsed);
  if (keys.size < MIN_KEYS) {
    say(`✘ ${f} 只有 ${keys.size} 个 key（地板 ${MIN_KEYS}）—— 文件被截断了，不是"翻译变少了"`);
    process.exit(1);
  }
  keysOf.set(f, keys);
}

const dottedOf = new Map([...keysOf].map(([f, ks]) => [f, new Set([...ks].map(asDotted))]));
for (const [f, dotted] of dottedOf) {
  if (!dotted.has(PROBE_KEY)) {
    say(`✘ 探针 key 不在 ${f} 里：${PROBE_KEY}`);
    say('  它就是这次被整文件重写丢掉的那一个。它不见了，说明这条守卫盯的东西又发生了。');
    process.exit(1);
  }
}

/* ── 豁免名单 ───────────────────────────────────────────────────────────────── */
let allow = { asymmetric: [], unreferenced: [] };
try {
  allow = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'));
} catch (e) {
  say(`✘ 读不到豁免名单 ${ALLOW_PATH}：${e.message}`);
  say('  读不到时**不能**当成"没有名单所以放行" —— 那就是一条被静默关掉的守卫。');
  process.exit(1);
}
const asym = allow.asymmetric ?? [];
const asymKey = (e) => `${e.file}${SEP}${e.key}`;
const asymSet = new Set(asym.map(asymKey));
const noReason = asym.filter((e) => !e.reason || String(e.reason).trim() === '');

/* ── ② parity：两份 locale 的 key 集合必须一致 ──────────────────────────────── */
const union = new Set([...keysOf.values()].flatMap((s) => [...s]));
const gaps = [];
for (const k of union) {
  for (const [f, ks] of keysOf) {
    if (!ks.has(k) && !asymSet.has(`${f}${SEP}${asDotted(k)}`)) {
      gaps.push({
        file: f,
        key: asDotted(k),
        presentIn: files.filter((g) => keysOf.get(g).has(k)),
      });
    }
  }
}

if (gaps.length > 0) {
  problems.push('parity');
  say(`\n✘ **两份 locale 的 key 对不上，有 ${gaps.length} 处**：\n`);
  for (const g of gaps) {
    say(`   − ${g.file}  缺 ${g.key}`);
    say(`     （它在 ${g.presentIn.map((p) => p.split('/').pop()).join(', ')} 里有）`);
  }
  say(
    [
      '',
      '  这不是"格式不一致"，是**用户看得见的 bug**：`fallbackLng` 是 zh-CN，所以',
      '  · zh-CN 缺 key → 回落目标就是它自己 → **界面上直接显示那串 key**；',
      '  · en 缺 key → 回落到 zh-CN → **英文界面冒出中文**。',
      '',
      '  最常见的成因就是这条守卫要防的那个：**按整文件重写 JSON**，',
      '  从一个早于对方的版本覆盖过去，于是只有一份丢了 key —— 不报错、不冲突。',
      '',
      '  两条出路：',
      '  ① 补上缺的那条翻译（**行级新增**，不要重排、不要整体重写）；',
      '  ② 确实要让它只存在于一份 → 写进 scripts/locale-allowlist.json 的 `asymmetric`，',
      '     每条**必须**写 `reason`。',
    ].join('\n'),
  );
}

/* ── 名单卫生：过期条目 / 没写理由 ─────────────────────────────────────────── */
const staleAsym = asym.filter((e) => {
  const ks = keysOf.get(e.file);
  return !ks || ks.has(e.key.split('.').join(SEP)) || !union.has(e.key.split('.').join(SEP));
});
if (noReason.length > 0) {
  problems.push('reasonless');
  say(`\n✘ **asymmetric 里有 ${noReason.length} 条没写 reason**：\n`);
  for (const e of noReason) say(`   ? ${e.file} :: ${e.key}`);
  say('\n  豁免必须带理由，否则它就是一个没人记得为什么存在的洞。');
}
if (staleAsym.length > 0) {
  problems.push('stale');
  say(`\n✘ **asymmetric 里有 ${staleAsym.length} 条已经过期**（不再不对称了）：\n`);
  for (const e of staleAsym) say(`   ↩ ${e.file} :: ${e.key}`);
  say('\n  豁免名单只准变短 —— 删掉这几行。');
}

/* ── ③ 源码用到的 key，每份 locale 都必须有 ─────────────────────────────────
 *
 * 这条补 parity 的盲区：两份**同时**被重写时 parity 是绿的，但代码还在 `t()` 它。
 * 认 i18next 的复数后缀（`_one` / `_other` …）—— `t('app.tasksBadge')` 在
 * locale 里是 `tasksBadge_one` / `tasksBadge_other`，不认后缀就会误报。
 */
const PLURAL = ['', '_zero', '_one', '_two', '_few', '_many', '_other'];
/**
 * ⚠️ 源码也必须从 **HEAD（已提交的那棵树）** 读，不能 `readFileSync` 工作区。
 *
 * 这条是踩出来的：第一版 locale 从 `git show HEAD:` 读、源码却读工作区，
 * 于是**另一路 agent 一个还没提交的改动就能让这道门禁变红** ——
 * 实测正是如此：`BackendPackCard.tsx` 在别人工作区里引用了
 * `runtime.pack.servedFromSystemPath`，翻译还没加，我这边当场红。
 *
 * 那是**别人在途工作**，不是缺陷。判据两边口径必须一致：
 * **同一个提交，在 CI 上和在任何人的机器上都给同一个答案。**
 * （和 `check-test-ratchet.mjs` 从 `ls-files` 改成 `ls-tree HEAD` 是同一条。）
 *
 * 用一次 `git grep` 直接搜**提交树**，不逐个 `git show`（几百次子进程太慢）。
 *
 * ⚠️ 这里**不许**用 `\b`（词边界）。它是 GNU 正则扩展，**POSIX ERE 里没有**，
 * 而 `git grep -E` 用的是**它链接的那个 C 库的**正则实现：
 *
 *   | 平台 | git 2.55.0 链的正则 | `\b` |
 *   |---|---|---|
 *   | linux | glibc | ✔ 词边界 |
 *   | win32 | Git for Windows 以 `NO_REGEX` 构建、用 git 自带 `compat/regex`（GNU 血统）| ✔ 词边界 |
 *   | **darwin** | Homebrew git 链**系统 BSD regex** | 🔴 **退化成字面量 `b`** |
 *
 * 上表最后一列的**证据是观测到的失败分布**，不是读源码推的：xplat 基线里
 * `selftest-locale-ratchet.mjs` 只在 `darwin-arm64` 那一格红，`win32-x64` 那格没有它。
 *
 * 后果不是报错，是**零命中**：本机实测 `[实测]`，同一棵 HEAD 上
 * 带 `\b` 命中 63 个文件，退化成字面 `b` 命中 **0 个** —— 与 macOS 上观测到的
 * 「只从提交树里扫到 0 个 t() 字面量 key」逐字吻合（xplat 基线里那条 `real-bug`）。
 *
 * ⚠️ 也**不能**改用 `-w`：`-w` 要求匹配两端都落在词边界上，而这个模式的**右端是
 * `['"]`，不是词字符** —— `-w` 在这里判据不同，不是等价替换。
 * 用 POSIX ERE 里普遍存在的 `(^|[^[:alnum:]_])` 显式写出左边界。
 * `[实测]` 三种写法在本机 glibc 上同为 63 个文件。
 */
const GREP_PATTERN = '(^|[^[:alnum:]_])t\\([[:space:]]*[\'"]';
const grepOut = spawnSync(
  'git',
  ['grep', '-n', '-I', '-E', GREP_PATTERN, 'HEAD', '--', 'apps/web/src'],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
/*
 * ⚠️ `git grep` 的退出码有三档：0=有命中，1=零命中，**≥2=出错**（正则不认、
 * 找不到 HEAD、参数不对…）。只读 `.stdout` 会把第三档折叠进第二档 ——
 * 「git 报错了」和「一个 key 都没有」在这里就长得一模一样。
 *
 * 下面那道 `refs.size < 100` 地板确实把两者都拦住了，但它说的是「扫描坏了」，
 * 而**它并不知道自己拦住的是哪一种**：诊断词句碰巧说对了，靠的是地板，不是查过退出码。
 * 出错这一档要单独判出来，并且要说**不同的话** —— 否则下一个人会照着
 * 「扫描坏了」去查扫描器，而真正的原因在 stderr 里躺着没人读。
 */
if (grepOut.error) {
  say(`✘ 起不了 git grep 子进程：${grepOut.error.message}`);
  process.exit(1);
}
if (typeof grepOut.status === 'number' && grepOut.status >= 2) {
  say(`✘ git grep 报错（退出码 ${grepOut.status}）—— 这**不是**"零命中"，是命令本身失败了：`);
  say(`    模式：${GREP_PATTERN}`);
  for (const l of String(grepOut.stderr ?? '')
    .split('\n')
    .filter(Boolean))
    say(`    ${l}`);
  say('  最可能的成因：这个平台的正则实现不认这个模式（见上面那张表）。');
  process.exit(1);
}
const refs = new Map();
for (const line of (grepOut.stdout ?? '').split('\n')) {
  const m = /^HEAD:([^:]+):\d+:(.*)$/.exec(line);
  if (!m) continue;
  const [, file, code] = m;
  if (!/\.tsx?$/.test(file)) continue;
  for (const re of [/\bt\(\s*'([^'\\]+)'/g, /\bt\(\s*"([^"\\]+)"/g]) {
    for (const mm of code.matchAll(re)) if (!refs.has(mm[1])) refs.set(mm[1], file);
  }
}
if (refs.size < 100) {
  say(`✘ 只从提交树里扫到 ${refs.size} 个 t() 字面量 key —— 扫描坏了，不是"界面没文案了"`);
  say('  （对空集返回绿的守卫比没有守卫更坏：它看起来像在守着。）');
  say(`  git grep 退出码 ${grepOut.status}（0=有命中 / 1=零命中）——`);
  say('  它没报错，所以这是**真的一条都没匹配上**：模式与源码的实际写法对不上了。');
  process.exit(1);
}

const unrefAllow = new Set(allow.unreferenced ?? []);
const dangling = [];
for (const [key, where] of refs) {
  if (unrefAllow.has(key)) continue;
  for (const [f, dotted] of dottedOf) {
    if (!PLURAL.some((suf) => dotted.has(key + suf))) dangling.push({ key, where, file: f });
  }
}

if (dangling.length > 0) {
  problems.push('dangling');
  say(`\n✘ **源码用到、但 locale 里没有的 key 有 ${dangling.length} 处**：\n`);
  for (const d of dangling) say(`   − ${d.key}   （${d.file} 里没有；用在 ${d.where}）`);
  say(
    [
      '',
      '  用户会**直接在界面上看到这串 key**（i18next 找不到就原样返回）。',
      '  补翻译；如果这个 key 是动态拼出来的、静态扫描误判了，',
      '  写进 scripts/locale-allowlist.json 的 `unreferenced`。',
    ].join('\n'),
  );
}

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        files,
        keys: Object.fromEntries([...keysOf].map(([f, s]) => [f, s.size])),
        gaps,
        dangling,
        asymmetric: asym.length,
      },
      null,
      2,
    ),
  );
}

if (problems.length > 0) process.exit(1);

const sizes = files.map((f) => `${f.split('/').pop()} ${keysOf.get(f).size}`).join(' / ');
console.log(`✔ locale 守卫：${sizes}，两份 key 集合一致`);
console.log(`  源码里 ${refs.size} 个 t() 字面量 key 全都有翻译；豁免 ${asym.length} 条`);
