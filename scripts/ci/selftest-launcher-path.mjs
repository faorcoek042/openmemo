#!/usr/bin/env node
/**
 * 守卫：**每一个起 daemon 的脚本都必须登记在册，走启动器的那些不许绕回去直起入口。**
 *
 * ## 它挡的是什么
 *
 * 完成度审计查出第四类「CI 结构上看不见」，而它是用户三条真机故障的共同根因：
 *
 * > CI 直接起 `app/daemon/dist/main.js`，而用户双击的是启动器脚本。
 * > **凡是只有启动器才做的事，CI 结构上都看不见。**
 *
 * `[grep 实测]` `OPENMEMO_BUNDLED_PROBE_DIR` 此前**四条腿一条都没引用过** ——
 * 于是探针进包那条修复在启动器路径上是 `[未验证]`，而"三平台全绿"
 * 在启动器那一段上**没有效力**。这是同一形状的第四次，而且它把前三次的修复
 * 也一起架空了。
 *
 * ## 🔴 #85：这道守卫自己的覆盖面有一个洞，而洞比它守住的还大
 *
 * 上一版有一份**手写的**「四条 e2e 腿」名单：
 *
 * ```js
 * const LEGS = ['e2e-import-audit.mjs','e2e-notes-audit.mjs','e2e-record.mjs','e2e-runtime-audit.mjs'];
 * ```
 *
 * `[扫描实测]` 仓里真正起 daemon 的脚本是 **11 个**，名单认得 4 个。
 * 而它的 ⑤「前提自检」只检查*登记的腿存在*，**从不检查*所有腿都被登记***。于是：
 *
 *   · `measure-install-phases.mjs` 走了启动器，却没人知道（漏登记的**好**例子）；
 *   · `e2e-allcomponents` / `e2e-browser-audit` / `cold-start-audit` /
 *     `proxy-coverage-audit` / `verify-bundle-upgrade` **五个直接起入口**，
 *     这道门一个字都没说；
 *   · `e2e-coldstart` 两条路都走（§7 用 `spawnViaLauncher()`，别处刻意直起），
 *     而名单里连它的名字都没有 —— 更糟的是上一版判据②只认 `spawnDaemon(` 一个名字，
 *     就算把它加进名单，它也会被判成"没走启动器"。**手写的名单错了两次。**
 *
 * 一份手抄名单与它要覆盖的集合各自演化，漂掉的那一半失效时看起来和从没有过
 * 一模一样 —— 这正是这道门自己要防的病。（同族第三次：`check-orphan-exports`
 * 按裸名匹配 #83、`lint-workflows` 的 T-163 手抄 7 条 #85。）
 *
 * ## 判据：**登记册与扫描结果必须两个方向都相等**
 *
 *   · **⑤a 漏登记 ⇒ 红**：扫到一个起 daemon 的脚本不在册 —— 新盲区就是这么长出来的。
 *   · **⑤b 登记陈了 ⇒ 红**：在册的不再起 daemon（改名/删了/改了写法）。
 *     没有这一半，登记册只会越来越长，而长出来的那些没有任何东西对着核。
 *   · **① `kind:'launcher'` 的不许在代码里出现 daemon 入口路径。**
 *   · **② `kind:'launcher'|'mixed'` 必须真的调用共享模块的入口** ——
 *     入口名从模块的**导出**里取，不手写（手写就又是一份会漂的名单，见上）。
 *   · **③ `kind:'direct'|'mixed'` 必须写明理由**：豁免可以有，**沉默不行**。
 *   · **③反向 `kind:'direct'` 的哪天开始走启动器了 ⇒ 也红**（豁免必须会过期）。
 *
 * ## ⚠️ 豁免不等于"这样做是对的"
 *
 * `kind:'direct'` 只声明一件事实：**这个脚本不走启动器**。它**不**声明那是对的。
 * `evidence: 'unexamined'` 的那几条是**待裁的**，不是已裁的 —— 登记它们正是为了让
 * "没人判过"这件事有一个地方能被看见，而不是继续散落在 11 个文件里。
 * 所以下面每一轮都会把它们打出来，**绿的时候也打**。
 *
 * ## 🔴 ③④ 从「文本存在」换成「真的执行」（#85）
 *
 * 上一版的 ③④ 是这样写的：
 *
 * ```js
 * for (const name of ['start.cmd','OpenMemo.command','start.sh']) must(code.includes(name), …)
 * must(/OPENMEMO_BUNDLED_PROBE_DIR/.test(code), …)
 * ```
 *
 * 而文件头当时写的是「共享模块必须**真的执行**启动器文件」。**两句话不是一件事。**
 * 把 `launcher-spawn.mjs` 改成不执行启动器、只留一个没人用的常量数组
 * （`const NAMES = ['start.cmd','OpenMemo.command','start.sh']`），③④ 照绿。
 * 那是「判据只证明文本存在」那一档，出现在一道**专门治这个病**的守卫自己身上。
 *
 * 现在 ③ 是**真的跑一次**：造一个临时"包"，里面放一个会写脚印的启动器，
 * 调 `spawnViaLauncher()`，再看脚印在不在、参数有没有透传过去。
 * ④ 直接断言模块**导出的值**（`LAUNCHER_OWNED_ENV`）与
 * `assertNoLauncherOverrides()` 的**行为**，不再 grep 源码。
 *
 * 用法：`node scripts/ci/selftest-launcher-path.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as LAUNCHER from './launcher-spawn.mjs';
import {
  LAUNCHER_OWNED_ENV,
  assertNoLauncherOverrides,
  launcherName,
  launcherPath,
  spawnViaLauncher,
  killTree,
} from './launcher-spawn.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI = join(REPO, 'scripts', 'ci');
const HELPER = 'launcher-spawn.mjs';

/**
 * 这两个文件**自己**满足下面的扫描特征，但它们不是"起 daemon 的腿"：
 * 一个是共享模块本体，一个是这道守卫（它的正则里写着那几个函数名）。
 * 排除是显式的、只有两条、并且写明了理由 —— 不是一个可以往里塞东西的口子。
 */
const NOT_A_LEG = new Set([HELPER, 'selftest-launcher-path.mjs']);

/**
 * **登记册：每一个起 daemon 的脚本，以及它走的是哪条路。**
 *
 * `kind`：
 *   · `launcher` —— 只经共享模块起（用户双击走的那条路）。
 *   · `mixed`    —— 既经共享模块起，也**刻意**在别处直起。必须写清哪一节、为什么。
 *   · `direct`   —— 完全不经启动器。必须写清启动器那一段**归谁覆盖**。
 *
 * `evidence`：这条判断的依据。`'unexamined'` = **还没有人裁过**。
 */
const DAEMON_STARTERS = [
  {
    file: 'e2e-runtime-audit.mjs',
    kind: 'launcher',
    why: '章程 2.1/2.2 的端到端验收，走用户那条路。',
    evidence: 'coordination/inbox/completion-audit.md:174（五条在用共享模块之一）',
  },
  {
    file: 'e2e-import-audit.mjs',
    kind: 'launcher',
    why: 'F1/F2 导入验收，走用户那条路。',
    evidence: 'coordination/inbox/completion-audit.md:174',
  },
  {
    file: 'e2e-record.mjs',
    kind: 'launcher',
    why: 'F3 录音→转写→时间轴，走用户那条路。',
    evidence: 'coordination/inbox/completion-audit.md:174',
  },
  {
    file: 'e2e-notes-audit.mjs',
    kind: 'launcher',
    why: 'F4/F5 笔记与检索，走用户那条路。',
    evidence: 'coordination/inbox/completion-audit.md:174',
  },
  {
    file: 'measure-install-phases.mjs',
    kind: 'launcher',
    why: '量装包的事件序列，起法与 e2e 腿一致。',
    evidence:
      '#85 扫描发现：它一直走共享模块，只是**上一版名单里没有它** —— 漏登记的一个好例子（做对了却没人知道）。',
  },
  {
    file: 'e2e-coldstart.mjs',
    kind: 'mixed',
    why:
      '§7「通过启动器起一次」用 `spawnViaLauncher()`（判据是组件目录里真的有包）；' +
      '其余小节**刻意**直起入口，验的是「不传 --data-dir 时产品自己算得出数据目录」那条路。',
    evidence:
      'scripts/ci/e2e-coldstart.mjs §7（换成 spawnViaLauncher 的原因写在那一节）' +
      ' + launcher-spawn.mjs 文件头「不传参数的那条路由 e2e-coldstart 覆盖」',
  },
  {
    file: 'e2e-browser-audit.mjs',
    kind: 'direct',
    why: '真浏览器点按钮那一格；启动器那一段**不归它**。',
    evidence:
      'coordination/inbox/e2e-browser.md:100 —— 「双击启动器 / Gatekeeper / SmartScreen 已归 bundle-launch-sim + 人工」',
  },
  {
    file: 'e2e-allcomponents.mjs',
    kind: 'direct',
    why: '目录里每条「安装」都有人真点；它验的是组件目录，不是启动路径。',
    evidence: 'unexamined',
  },
  {
    file: 'cold-start-audit.mjs',
    kind: 'direct',
    why: '干净 runner 上的冷启动测量。',
    evidence: 'unexamined',
  },
  {
    file: 'proxy-coverage-audit.mjs',
    kind: 'direct',
    why: '「设置页说代理已生效」覆盖了哪几条出网路径。',
    evidence: 'unexamined',
  },
  {
    file: 'verify-bundle-upgrade.mjs',
    kind: 'direct',
    why: '装新版包不能弄坏已有的数据目录。',
    evidence: 'unexamined',
  },
];

/* ══════════════════════════════════════════════════════════════════════════════════ */

const problems = [];
let checks = 0;
const must = (cond, msg) => {
  checks += 1;
  if (!cond) problems.push(msg);
};

/**
 * 剥掉注释。
 *
 * ⚠️ **必须先剥**：这几个文件的注释里**大量**出现 `main.js`，因为它们正是在解释
 *    "为什么不再直接起它"。一条会把解释文字当成违规的守卫，会逼着人把解释删掉 ——
 *    那是在惩罚说清楚的人。（同一处置见 `lint-workflows.mjs` 的 stripComments。）
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * 共享模块的**起 daemon 入口名**，从它自己的导出里取。
 *
 * ⚠️ 不手写。上一版手写了 `spawnDaemon` 一个名字，于是只用 `spawnViaLauncher()` 的
 *    `e2e-coldstart` 会被判成"没走启动器"—— 一份手抄名单，两处都错。
 */
const SPAWN_ENTRIES = Object.keys(LAUNCHER).filter(
  (k) => /^spawn/.test(k) && typeof LAUNCHER[k] === 'function',
);
const callsShared = (code) => SPAWN_ENTRIES.filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(code));

/**
 * 代码里出现 daemon 入口路径的行。
 *
 * ⚠️ 同一行还要有 `dist` —— 否则 `platform-facts.mjs` 里那句
 *    `join(ROOT, 'my dir', 'main.js')`（验带空格路径的临时夹具）会被误判成一条腿。
 */
const entryLines = (code) => code.split('\n').filter((l) => /main\.js/.test(l) && /dist/.test(l));

/** 这个脚本**起 daemon** 吗。三个特征取并集，各自对应一种真实写法。 */
function startsDaemon(code) {
  return (
    /\bstartDaemon\b/.test(code) ||
    callsShared(code).length > 0 ||
    /\bdaemon\s*=\s*spawn\(/i.test(code)
  );
}

console.log('─'.repeat(88));
console.log('── 守卫：起 daemon 的脚本必须登记在册；走启动器的不许绕回去直起入口');
console.log('─'.repeat(88));

/* ── 前提：共享模块与它的入口 ─────────────────────────────────────────────── */
must(existsSync(join(CI, HELPER)), `共享模块不存在：scripts/ci/${HELPER}`);
must(
  SPAWN_ENTRIES.length >= 2,
  `${HELPER} 只导出了 ${SPAWN_ENTRIES.length} 个 spawn* 入口（应有 spawnDaemon / spawnViaLauncher）——` +
    ` 少一个就会让只用另一个的腿被误判成"没走启动器"（上一版就是这么错的）`,
);

/* ── 扫描：谁在起 daemon ───────────────────────────────────────────────────── */
const scanned = [];
for (const f of readdirSync(CI).sort()) {
  if (!f.endsWith('.mjs') || NOT_A_LEG.has(f)) continue;
  const code = stripComments(readFileSync(join(CI, f), 'utf8'));
  if (startsDaemon(code)) scanned.push({ file: f, code });
}

/*
 * ★ 扫描地板。一个扫不到东西的扫描器会让下面每条断言"因为没主语"而恒真 ——
 *   那时这道门永远绿，而它失效的样子和"全都合规"一模一样。
 */
must(
  scanned.length >= 8,
  `只扫到 ${scanned.length} 个起 daemon 的脚本（地板 8）—— 几乎一定是**扫描器坏了**` +
    `（改了写法 / 正则漂了），而不是"腿真的少了这么多"。`,
);

/* ── ⑤a 漏登记 ⇒ 红 ──────────────────────────────────────────────────────── */
const registered = new Map(DAEMON_STARTERS.map((e) => [e.file, e]));
const unregistered = scanned.filter((s) => !registered.has(s.file)).map((s) => s.file);
must(
  unregistered.length === 0,
  `这些脚本会起 daemon，却**不在登记册里**：\n` +
    unregistered.map((f) => `        scripts/ci/${f}`).join('\n') +
    `\n      新盲区就是这么长出来的：上一版名单手写 4 条，而实际有 ${scanned.length} 个。\n` +
    `      去 DAEMON_STARTERS 里加一行，写清 kind 与理由 —— 不许留着不说话。`,
);

/* ── ⑤b 登记陈了 ⇒ 红（没有这一半，登记册只会越来越长） ─────────────────── */
const scannedFiles = new Set(scanned.map((s) => s.file));
const staleRows = DAEMON_STARTERS.filter((e) => !scannedFiles.has(e.file)).map((e) => e.file);
must(
  staleRows.length === 0,
  `这些条目在登记册里，但**扫描已经认不出它们起 daemon 了**：\n` +
    staleRows.map((f) => `        scripts/ci/${f}`).join('\n') +
    `\n      要么文件改名/删了（那就划掉这一行），要么它改了起法而扫描漏了（那更要紧）。\n` +
    `      **登记册只能靠这一半保持诚实** —— 只增不减的名单第二天就没人对着核了。`,
);

/* ── 逐条：①②③ ──────────────────────────────────────────────────────────── */
for (const { file, code } of scanned) {
  const entry = registered.get(file);
  if (!entry) continue; // ⑤a 已经报过了

  const hits = entryLines(code);
  const viaShared = callsShared(code);

  if (entry.kind === 'launcher') {
    must(
      hits.length === 0,
      `${file}（登记为 launcher）: 代码里出现了 daemon 入口（${hits.length} 处）——\n` +
        `      这条腿绕过启动器直接起 daemon 了。用户双击的是启动器，\n` +
        `      直接起入口就看不到 WEB_DIST / EXT_DIR / BUNDLED_PROBE_DIR / 工作目录。\n` +
        `      改法：走 scripts/ci/${HELPER}；真是刻意的就把 kind 改成 mixed 并写清理由。\n` +
        hits.map((l) => `        > ${l.trim().slice(0, 100)}`).join('\n'),
    );
  }

  if (entry.kind === 'launcher' || entry.kind === 'mixed') {
    must(
      new RegExp(`from\\s+['"]\\./${HELPER.replace('.', '\\.')}['"]`).test(code),
      `${file}（登记为 ${entry.kind}）: 没有 import ./${HELPER} —— 它是起 daemon 的唯一入口`,
    );
    must(
      viaShared.length > 0,
      `${file}（登记为 ${entry.kind}）: 一个共享入口都没调用（${SPAWN_ENTRIES.join(' / ')}）——` +
        ` 那它是怎么起的 daemon？`,
    );
  }

  if (entry.kind === 'direct') {
    /*
     * ★ 反方向：登记成"不走启动器"的，哪天开始走了，这条登记就成了假话。
     *   与 ⑤b 同一个道理 —— **豁免必须会过期**。
     */
    must(
      viaShared.length === 0,
      `${file} 登记为 direct（不走启动器），但它现在调用了 ${viaShared.join(' / ')} ——\n` +
        `      **好消息，但登记陈了**：把 kind 改成 launcher 或 mixed。`,
    );
  }

  if (entry.kind === 'direct' || entry.kind === 'mixed') {
    must(
      Boolean(entry.why) && Boolean(entry.evidence),
      `${file}: kind='${entry.kind}' 是一次豁免，必须同时写 why 与 evidence —— ` +
        `一条说不出理由的豁免与"忘了"分不开`,
    );
  }
}

/* ── ③' ★ 真的执行：造一个临时包，看启动器脚印在不在 ────────────────────── */
{
  const box = mkdtempSync(join(tmpdir(), 'om-launcher-'));
  try {
    const marker = join(box, 'ran.txt');
    const name = launcherName();
    const lp = launcherPath(box);
    const isWin = process.platform === 'win32';
    /*
     * 启动器夹具：把"我被执行了 + 收到的参数"写进脚印文件。
     * 三个平台的形状不一样 —— 这正是 `launcherName()` 存在的理由，
     * 所以这里也照它给的名字写，而不是自己拼一个。
     */
    writeFileSync(
      lp,
      isWin
        ? `@echo off\r\n> "${marker}" echo ARGS=%*\r\n`
        : `#!/bin/sh\nprintf 'ARGS=%s\\n' "$*" > "${marker}"\n`,
      'utf8',
    );
    if (!isWin) chmodSync(lp, 0o755);

    const { proc, launcher } = spawnViaLauncher({ bundleDir: box, args: ['--port', '19999'] });
    must(launcher === lp, `spawnViaLauncher 执行的应该是 ${name}，实得 ${launcher}`);

    const exitCode = await new Promise((done) => {
      const t = setTimeout(() => {
        killTree(proc.pid);
        done('timeout');
      }, 20_000);
      proc.on('exit', (c) => {
        clearTimeout(t);
        done(c);
      });
      proc.on('error', (e) => {
        clearTimeout(t);
        done(`spawn 失败：${e.message}`);
      });
    });

    must(
      existsSync(marker),
      `★★ 共享模块**没有真的执行启动器文件**（${name} 跑完 exit=${exitCode}，脚印不存在）。\n` +
        `      这一条是 #85 换掉的那个判据：上一版只查源码里有没有出现 "${name}" 这几个字，\n` +
        `      而"字在文件里"和"文件被执行了"不是一件事。`,
    );
    const body = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
    must(
      /--port/.test(body) && /19999/.test(body),
      `★ 参数没有透传给启动器（脚印里是 ${JSON.stringify(body.trim())}）——` +
        ` e2e 腿靠 --port / --data-dir 才能端口可控、数据目录隔离（PROTOCOL §9）`,
    );
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

/* ── ④' 断言导出的值与行为，不再 grep 源码 ──────────────────────────────── */
{
  for (const v of ['OPENMEMO_WEB_DIST', 'OPENMEMO_EXT_DIR', 'OPENMEMO_BUNDLED_PROBE_DIR']) {
    must(
      LAUNCHER_OWNED_ENV.includes(v),
      `${HELPER}: LAUNCHER_OWNED_ENV 里没有 ${v} —— 少一个，调用方预设它就不会被拦下，` +
        `那条腿于是"看起来"在走启动器（${v} 正是本轮盲区的现场）`,
    );
    /* ★ 不只是"在名单里"，还要**真的会拦**。 */
    let threw = null;
    try {
      assertNoLauncherOverrides({ [v]: '/tmp/x' });
    } catch (e) {
      threw = e;
    }
    must(threw !== null, `${HELPER}: 预设 ${v} 竟然没被 assertNoLauncherOverrides() 拦下`);
    must(
      threw === null || String(threw.message).includes(v),
      `${HELPER}: 拦下 ${v} 时没有点名是哪个变量`,
    );
  }
  /* 阴性对照：没预设时不许乱抛，否则上面那三条"会抛"证明不了任何事。 */
  let clean = null;
  try {
    assertNoLauncherOverrides({ OPENMEMO_OPEN_BROWSER: '0' });
  } catch (e) {
    clean = e;
  }
  must(
    clean === null,
    `${HELPER}: 没预设任何 LAUNCHER_OWNED_ENV 时不该抛（实得：${clean?.message}）`,
  );

  /* ★ 变异口子必须仍然是**显式传参**才打开 —— 它是 e2e-notes 那条最值钱变异的依据。 */
  let waived = null;
  try {
    assertNoLauncherOverrides({ OPENMEMO_EXT_DIR: '/tmp/empty' }, true);
  } catch (e) {
    waived = e;
  }
  must(waived === null, `${HELPER}: allow=true 时应当放行（e2e-notes 的 EXT_DIR 变异靠它）`);

  must(
    ['start.cmd', 'OpenMemo.command', 'start.sh'].includes(launcherName()),
    `${HELPER}: launcherName() 在 ${process.platform} 上给出了 ${launcherName()} —— ` +
      `三个平台的启动器名字不一样，认错一个就等于那个平台没走启动器`,
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════ */

const byKind = (k) => DAEMON_STARTERS.filter((e) => e.kind === k).length;
console.log(
  `   扫到 ${scanned.length} 个起 daemon 的脚本 · 登记 ${DAEMON_STARTERS.length} 条` +
    `（launcher ${byKind('launcher')} · mixed ${byKind('mixed')} · direct ${byKind('direct')}）`,
);
console.log(`   共享模块入口（从导出里取）：${SPAWN_ENTRIES.join(', ')}`);
/*
 * ★ 绿的时候也要把**待裁的豁免**打出来。
 *   一条 `evidence: 'unexamined'` 的豁免，安静下来就和"已经裁过了"一模一样。
 *   （同一处置见 `check-usefulness.mjs`：绿的时候也打抓不到的那几条。）
 */
const unexamined = DAEMON_STARTERS.filter((e) => e.evidence === 'unexamined');
if (unexamined.length > 0) {
  console.log('');
  console.log(`   ⚠️ 其中 ${unexamined.length} 条豁免**还没有人裁过**（登记 ≠ 认可）：`);
  for (const e of unexamined) console.log(`      · ${e.file}（${e.kind}）—— ${e.why}`);
  console.log(
    '      它们不走启动器这件事是**事实**；那样对不对**没人判过**。\n' +
      '      要么给出一条 evidence（谁覆盖了启动器那一段），要么把它改成 launcher。',
  );
}
console.log('');
if (problems.length === 0) {
  console.log(`✔ selftest-launcher-path: ${checks} 条断言全部通过`);
  process.exit(0);
}
console.log(`✘ selftest-launcher-path: ${problems.length}/${checks} 条不通过：`);
for (const p of problems) console.log(`   · ${p}`);
process.exit(1);
