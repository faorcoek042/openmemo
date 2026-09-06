#!/usr/bin/env node
/**
 * ★ **入口守卫的行为判据** —— 「经一条软链调用时，这个脚本还出不出活？」
 *
 * ## 为什么需要它：这个坑已经发生四次
 *
 * | 次 | 地点 | 当时的写法 |
 * |---|---|---|
 * | 1 | T-143 `apps/daemon/src/main.ts` | 手拼 `` `file://${argv[1]}` `` |
 * | 2 | T-145 `scripts/selfcheck.mjs` | 同上 |
 * | 3 | #95 `scripts/ci/check-duplicate-declarations.mjs` | 同上 |
 * | 4 | 8 个脚本（本轮） | `pathToFileURL(argv[1]).href === import.meta.url`、
 *      `fileURLToPath(import.meta.url) === argv[1]`、`resolve(a) === resolve(b)` |
 *
 * 前三次的收尾都是「修掉这一处 + 把成因写进注释」。第四次证明了**那不够**：
 * 第 4 次的三种变体全都是**读过前三次结论之后写的** —— 它们都修掉了百分号编码那一半，
 * 都漏掉了 realpath 那一半。所以这一次收尾必须是一道**会红的门**，不是又一段注释。
 *
 * ## 失效形态：这是「空转」，不是「报错」
 *
 * 入口守卫失配的后果不是崩溃，是 **CLI 主体一行不执行 → 零行输出 → exit 0 → CI 记 ✔**。
 * `[实测]` 这 8 个脚本经软链路径调用时全部 exit 0、零行输出；真实路径下各打 16–24 行。
 * 其中 `xplat-ratchet.mjs` 是整条跨平台探针在 mac / win 上的**唯一判决** ——
 * 它一空转，那个 workflow 就是零输出全绿。
 *
 * ## ⚠️ 为什么判据是**行为**，不是「禁止某种写法」的文本模式
 *
 * 修 #95 的人已经判过一次：文本模式的门必须配一份豁免名单才立得住 ——
 * `scripts/ci/platform-facts.mjs` 里那条**故意的**手拼 `file://`（它是在**测量**这个坑，
 * 见 §5 的 fact）和 `apps/daemon/src/bootstrap/entrypoint.test.ts` 里故意的坏例子，
 * 两者都会被文本模式误伤。而这个仓对「把该修的写成豁免」有前科（本轮已抓到三道守卫
 * 栽在手抄清单上）。
 *
 * 换成行为判据之后，那两个对照组**自然地落在射程之外**，一行豁免都不需要：
 * 它们不是「有条件决定要不要跑」的 CLI 入口，所以下面那个 `scope()` 根本不会选中它们。
 *
 * ## 射程是**现算**的，而且**对危险封闭**
 *
 * `scope()` 选的是：`scripts/` 下、有一个 `if (… process.argv …)` 的 `.mjs`。
 * 也就是「**自己决定要不要跑**」的那些脚本。
 *
 * > 这**不是**豁免名单。想躲开这条射程，只有一个办法：把那个 `if` 去掉。
 * > 而去掉之后脚本就**无条件跑**了 —— 那正是软链安全的形态，它不可能再踩这个坑。
 * > **没有任何一种写法能同时「有危险」和「在射程外」。**
 *
 * 所以这里没有名单文件、没有 `allow`、没有 `skip`。射程每轮从源码重算，
 * 而且**打印出来**（绿的时候也打）：射程变大变小都看得见。
 *
 * ## 判据（每个在册脚本两次 spawn，各在第一个字节处就杀掉，所以很便宜）
 *
 *   ① 从**真实路径**跑 → 必须出活。不出活 = 这条腿量不到它（空转防线，先修它）。
 *   ② 从**一条软链**跑 → 必须**照样**出活。零输出 = 入口守卫失配。
 *
 * ⚠️ 已知的射程边界，写在这里免得下一个人以为它管得更宽：
 * 判据只看「出没出声」。一个在守卫**之前**就打印的脚本能骗过它。
 * 今天在册的 10 个都不是那样（§2 的反向腿逐条量过），但这不是结构性保证。
 *
 * ## 它会踩响吗
 *
 * 会。macOS 的 `mkdtemp()` 落在 `/var/folders/…`，而 `/var → /private/var` 是软链 ——
 * #95 踩的正是这一枚。此外：`git worktree`、包管理器装的启动软链、任何别名调用。
 *
 * ## 反向验证（判据的判据）
 *
 * §2 拿真脚本做夹具：把入口守卫**逐字退回**成修之前那一句，这条腿必须当场红。
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isDirectRun } from '../lib/entrypoint.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * 射程下界。低于它 = 扫描器瞎了，**不是**「大家都不写入口守卫了」。
 * 今天现算是 10 个；取 8 只防塌方，不防增删。
 */
const MIN_SCOPE = 8;

/**
 * **真正被验到**（真实路径与软链路径两头都出声）的下界。
 * 今天现算是 9/10（`dirty-tree-notice.mjs` 在干净树上按设计不出声，见 §1）。
 * 取 6 只防塌方 —— 例如依赖没装、所有脚本都崩在 import 上，那时候"全绿"什么都不代表。
 */
const MIN_COVERED = 6;

/**
 * 探针：这两个必须在射程里。
 * · `xplat-ratchet.mjs` —— 本轮代价最高的那一个（整条跨平台探针的唯一判决）。
 * · `check-duplicate-declarations.mjs` —— #95 修过的那一个，本仓入口守卫的样板。
 * 它们掉出射程 = 选择器坏了，那时候「全绿」什么都不代表。
 */
const PROBE_SCRIPTS = [
  'scripts/ci/xplat-ratchet.mjs',
  'scripts/ci/check-duplicate-declarations.mjs',
];

/** 单个脚本等首字节的上限。今天在册的 10 个实测都在 300ms 以内。 */
const PER_SCRIPT_TIMEOUT_MS = 60_000;

/**
 * 「这个脚本自己决定要不要跑吗？」
 *
 * ESM 里做这个决定只有一种材料：把 `import.meta.url`（我是谁）跟 `process.argv`
 * （谁被执行了）比一比。所以一个 `if (… process.argv …)` 就是这个决定的形状 ——
 * 不管右边写的是 `isDirectRun`、`fileURLToPath`、`resolve`、还是 `endsWith`。
 * 判据**不看它写成什么样**（那就是文本模式了），只用它来圈出「有决定要做」的那些。
 */
const DECIDES_ITS_OWN_ENTRY = /^[ \t]*if[ \t]*\(.*process\.argv/m;

function scope() {
  const tracked = execFileSync('git', ['ls-files', '-z', 'scripts'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((p) => p.endsWith('.mjs'));
  return tracked.filter((p) => DECIDES_ITS_OWN_ENTRY.test(readFileSync(join(REPO, p), 'utf8')));
}

/**
 * 跑一个脚本，**在第一个字节处就把它杀掉**，只回答「它出声了没有」。
 *
 * ⚠️ 首字节就杀是这条腿便宜且安全的全部原因：
 * `run-selftests-all.mjs` 也在射程里，而它一跑就是整条 41 环的链 ——
 * 它在 spawn 第一环**之前**先打表头（`[实测]` 34ms），所以我们在那一刻就收工，
 * 链条一环都不会真的跑起来（否则这条自检自己会无限递归）。
 */
function probe(entry) {
  /*
   * ⚠️ 每次探测给一个**私有 tmpdir**。
   * `dirty-tree-notice.mjs` 会在 `tmpdir()` 里放一个按 ppid 命名的去重标记，
   * 而两次探测的 ppid 是同一个（都是本进程）—— 不隔离的话第二次会被它自己的去重
   * 挡成"零输出"，然后这条腿把它报成入口守卫坏了。**那是一条会冤枉人的红灯。**
   */
  const box = mkdtempSync(join(tmpdir(), 'entry-probe-box-'));
  return new Promise((res) => {
    const child = spawn(process.execPath, [entry], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: box, TMP: box, TEMP: box },
    });
    let first = '';
    let settled = false;
    const finish = (why, exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
      try {
        rmSync(box, { recursive: true, force: true });
      } catch {
        /* 刚被 SIGKILL 的进程可能还占着句柄（Windows 上是 EBUSY）。
           扫不掉一个临时目录不值得让这条腿红 —— 它是 tmpdir，系统会收。 */
      }
      res({ spoke: first.length > 0, first, why, exit });
    };
    const timer = setTimeout(() => finish('timeout', null), PER_SCRIPT_TIMEOUT_MS);
    const onData = (d) => {
      first ||= String(d).slice(0, 160);
      finish('spoke', null);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish(`spawn 失败：${e.message}`, null));
    child.on('close', (code) => finish(first ? 'spoke' : 'silent', code));
  });
}

/* ── 沙箱：一条**指向真仓库**的软链 ─────────────────────────────────────────────
 *
 * 软链指的是仓库根，不是单个脚本：这样脚本里的 `../lib/x.mjs`、`./y.mjs`
 * 以及 `node_modules` 全都照常解析得到，唯一的差别就是**入口那条路径经过了软链**。
 * 这正是 macOS `/var/folders/…` 与 `git worktree` 的形状。
 *
 * 'junction' 让这条腿在 Windows 上**也**造得出来（普通目录软链要提权，junction 不要）。
 */
function linkedRepo(dir) {
  const link = join(dir, 'repo-via-symlink');
  symlinkSync(REPO, link, 'junction');
  return link;
}

/**
 * 先把软链本身摘掉，再删临时目录。
 *
 * ⚠️ 这一步不是洁癖。`rmSync(dir, {recursive:true})` 会遇到一条**指向真仓库**的软链，
 * 而"递归删除时到底跟不跟软链走"是各平台/各实现最经典的分歧点之一。
 * Node 今天的实现是 `lstat` 之后 `unlink`（不跟），但**这条腿的下行风险是删掉整个仓库** ——
 * 这种赌注不值得押在"当前实现恰好是对的"上面。先显式摘链，再删目录。
 */
function dropSandbox(dir, link) {
  for (const fn of [unlinkSync, rmdirSync]) {
    try {
      fn(link);
      break;
    } catch {
      /* POSIX 软链走 unlink，Windows junction 走 rmdir —— 试两次 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✘ ${name}`);
    console.log(`      ${e && e.message ? e.message : e}`);
    failures.push(name);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ══════════════════════════════════════════════════════════════════
   §0 扫描器自检：先证明「我真的看到东西了」
   ══════════════════════════════════════════════════════════════════ */
console.log('§0 扫描器自检（对空集返回绿的守卫比没有守卫更坏）');

const SCRIPTS = scope();
console.log(`\n  射程（现算，不是名单）：${SCRIPTS.length} 个自己决定要不要跑的脚本`);
for (const s of SCRIPTS) console.log(`     · ${s}`);
console.log('');

await check(`射程不低于下界 ${MIN_SCOPE}`, () => {
  assert(
    SCRIPTS.length >= MIN_SCOPE,
    `只圈到 ${SCRIPTS.length} 个（下界 ${MIN_SCOPE}）—— 选择器坏了，` +
      `不是"大家都不写入口守卫了"。这时候的全绿什么都不代表。`,
  );
});

for (const p of PROBE_SCRIPTS) {
  await check(`探针在射程里：${p}`, () => {
    assert(SCRIPTS.includes(p), `${p} 掉出射程了 —— 选择器认不出它的入口守卫，先修选择器`);
  });
}

/* ══════════════════════════════════════════════════════════════════
   §1 行为腿：每个在册脚本，经软链跑一遍必须**仍然出活**
   ══════════════════════════════════════════════════════════════════ */
console.log('\n§1 行为腿：经一条软链调用，每个脚本都必须仍然出活');

/**
 * ⚠️ 判据是**差分**，不是「软链那头必须出声」。
 *
 * 因为有的脚本本来就可能一个字都不说（`dirty-tree-notice.mjs` 在干净树上
 * **按设计**一个字都不说 —— 那是它能被长期容忍的前提）。把「不出声」直接判红，
 * 这条腿在 CI 的干净 checkout 上就是一盏常亮的灯，两周内会被所有人学会绕过去。
 *
 * 所以两头都量，只判**不对称**：真实路径出声、软链路径不出声 ⇒ 入口守卫失配。
 *
 * ⚠️ 而两头**都不出声**的那些，判据对它们**没有区分力** —— 那不是"通过"。
 * 它们下面会被单独列出来（绿的时候也列），不许折叠进"全绿"里。
 */
const mute = [];
let covered = 0;
{
  const dir = mkdtempSync(join(tmpdir(), 'entry-guards-'));
  let link = null;
  try {
    link = linkedRepo(dir);
    for (const rel of SCRIPTS) {
      await check(`${rel} —— 经软链调用仍然出活`, async () => {
        const real = await probe(join(REPO, rel));
        const viaLink = await probe(join(link, rel));
        if (!real.spoke && !viaLink.spoke) {
          mute.push({ rel, exit: real.exit });
          return;
        }
        assert(
          !(!real.spoke && viaLink.spoke),
          `反过来了：真实路径下零输出、软链下反而出声了（${viaLink.first.trim().split('\n')[0].slice(0, 100)}）。\n` +
            `      这条腿量的不是这个形状，先查这个脚本自己。`,
        );
        assert(
          viaLink.spoke,
          `经软链调用时**零行输出**（${viaLink.why}，exit ${viaLink.exit}），` +
            `而真实路径下它会打：\n` +
            `        ${real.first.trim().split('\n')[0].slice(0, 100)}\n` +
            `      这就是入口守卫失配的样子 —— 它**不报错**，它 exit 0，于是 CI 记 ✔。\n` +
            `      改成 \`isDirectRun(import.meta.url, process.argv[1])\`` +
            `（scripts/lib/entrypoint.mjs）。\n` +
            `      注意 \`pathToFileURL\` / \`fileURLToPath\` / \`resolve\` 三种写法**都不行**：` +
            `前两种只修了百分号编码那一半，\`resolve()\` 不解符号链接。`,
        );
        covered++;
      });
    }
  } finally {
    dropSandbox(dir, link ?? join(dir, 'repo-via-symlink'));
  }
}

/*
 * ★ 「今天判不了的那些」必须**每轮都印出来，绿的时候也印**。
 *   #103 那道门正是栽在「有欠账才打印」上：欠账变成 0 的那天，
 *   输出里就再也没有任何东西提醒人「这里有一块是判不了的」。
 */
console.log('');
if (mute.length === 0) {
  console.log('  ℹ 本轮没有"两头都不出声"的脚本 —— 判据对在册的每一个都有区分力。');
} else {
  console.log(`  ⚠️ 本轮有 ${mute.length} 个脚本**两头都不出声**，这条腿对它们没有区分力：`);
  for (const m of mute) console.log(`     ◐ ${m.rel}（真实路径下也是零输出，exit ${m.exit}）`);
  console.log('     它们上面的 ✔ **不代表**入口守卫被验过了 —— 只代表没量到不对称。');
  console.log('     （`dirty-tree-notice.mjs` 在干净树上按设计一个字都不说，属于这一类。）');
}
console.log(`  ℹ 真正被验到的：${covered}/${SCRIPTS.length}`);

await check(`有区分力的脚本不少于下界 ${MIN_COVERED}`, () => {
  assert(
    covered >= MIN_COVERED,
    `只有 ${covered} 个脚本被真的验到（下界 ${MIN_COVERED}）—— ` +
      `多半是探测环境坏了（例如依赖没装、脚本全都崩在 import 上），` +
      `这时候的"全绿"什么都不代表。`,
  );
});

for (const p of PROBE_SCRIPTS) {
  await check(`探针有区分力：${p}`, () => {
    assert(
      !mute.some((m) => m.rel === p),
      `${p} 落进了"两头都不出声"—— 探针本身都量不到了，这一轮的结论不可信`,
    );
  });
}

/* ══════════════════════════════════════════════════════════════════
   §2 ★反向：把修法逐字退回去，§1 必须当场红
   ══════════════════════════════════════════════════════════════════ */

/**
 * 拿**真脚本**当夹具（不是我自己写的样本）：复制一份、把入口守卫换成修之前那一句。
 *
 * 副本落在临时目录里，所以相对 import 全部改写成绝对 `file:` URL。
 * ⚠️ 必须走 `pathToFileURL().href`，不许把裸路径塞进 import ——
 * Windows 上 `D:\a\…` 会被 ESM loader 当成 URL scheme（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。
 */
function fixtureCopy(dir, rel, guard) {
  const srcDir = dirname(join(REPO, rel));
  let src = readFileSync(join(REPO, rel), 'utf8');

  const GOOD = 'if (isDirectRun(import.meta.url, process.argv[1])) {';
  assert(
    src.includes(GOOD),
    `夹具锚点找不到了（${rel} 里没有那一行入口守卫）—— 这条腿量不到东西，先修它`,
  );
  src = src.replace(GOOD, guard);

  const rel2abs = /from '(\.[^']*)'/g;
  const rewrites = [...src.matchAll(rel2abs)];
  assert(rewrites.length > 0, `${rel} 里一个相对 import 都没有？改写规则和被测脚本漂了`);
  for (const [whole, spec] of rewrites) {
    src = src.replace(whole, `from ${JSON.stringify(pathToFileURL(resolve(srcDir, spec)).href)}`);
  }

  const real = join(dir, 'real');
  mkdirSync(real, { recursive: true });
  const p = join(real, basename(rel));
  writeFileSync(p, src);
  const link = join(dir, 'link');
  symlinkSync(real, link, 'junction');
  return join(link, basename(rel));
}

console.log('\n§2 ★反向：把入口守卫退回成修之前那一句，§1 的判据必须报得出来');
{
  // 拿这一个当夹具：它是整条跨平台探针在 mac / win 上的唯一判决，也是本轮代价最高的那个。
  const FIXTURE = 'scripts/ci/xplat-ratchet.mjs';

  await check('前提：夹具**保持修法**时，经软链跑得起来（证明夹具本身没崩）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'entry-fixture-ok-'));
    try {
      const r = await probe(
        fixtureCopy(dir, FIXTURE, 'if (isDirectRun(import.meta.url, process.argv[1])) {'),
      );
      assert(
        r.spoke,
        `夹具自己就跑不起来（${r.why}，exit ${r.exit}）—— ` +
          `那下面那条腿红了也说明不了任何事（"没打印"和"根本没跑起来"长得一样）`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [what, guard] of [
    [
      'fileURLToPath(import.meta.url) === argv[1]（本轮 5 个脚本的写法）',
      'if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {',
    ],
    [
      'pathToFileURL(argv[1]).href === import.meta.url（dirty-tree-notice 的写法）',
      'if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {',
    ],
    [
      'resolve(argv[1]) === resolve(fileURLToPath(...))（check-comment-facts / usefulness 的写法）',
      'if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {',
    ],
    [
      '手拼 `file://` + 路径（T-143 / T-145 / #95 那三次）',
      'if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {',
    ],
  ]) {
    await check(`★ 退回成「${what}」→ 经软链调用零输出，必须被抓到`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'entry-fixture-bad-'));
      try {
        const imports =
          "import { fileURLToPath, pathToFileURL } from 'node:url';\n" +
          "import { resolve } from 'node:path';\n";
        const entry = fixtureCopy(dir, FIXTURE, imports + guard);
        const r = await probe(entry);
        assert(
          !r.spoke,
          `这个已知坏的写法居然**出活了** —— §1 的判据对它没有区分力。\n` +
            `      它打的是：${r.first.split('\n')[0].slice(0, 120)}\n` +
            `      判据坏了（或者这个坏写法其实是对的），两种都必须有人看一眼。`,
        );
        assert(
          r.exit === 0,
          `零输出，但退出码是 ${r.exit}（期望 0）—— 空转的特征正是"安静地成功"。` +
            `退出码不是 0 说明它是崩了，不是空转，这条腿量的不是同一件事。`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

/* ══════════════════════════════════════════════════════════════════
   §3 共用实现本身：`scripts/lib/entrypoint.mjs` 的单元腿
   ══════════════════════════════════════════════════════════════════
   §1/§2 证明的是"各个脚本都接上了那份实现"。这一节证明**那份实现自己是对的** ——
   两者可以分开坏。判据与逐条实测在 apps/daemon/src/bootstrap/entrypoint.ts 的文件头，
   这里跑的是它的 .mjs 孪生（那一份有 entrypoint.test.ts，这一份此前没有任何测试）。 */
console.log('\n§3 共用实现：scripts/lib/entrypoint.mjs 自己必须是对的');
{
  await check('路径里有空格 / 中文 / `#` / `?` / `%` → 仍然认得出"这是直接执行"', () => {
    for (const odd of ['plain', 'my dir', '笔记', 'a#b', 'a?b', 'a%b']) {
      const p = join(resolve('/opt'), odd, 'main.mjs');
      assert(
        isDirectRun(pathToFileURL(p).href, p),
        `目录名 ${odd} 下失配了 —— 手拼 \`file://\`+路径的那个坑（URL 要百分号编码，路径不要）`,
      );
    }
  });

  await check('★ 经软链调用 → 必须再比一次 realpath', () => {
    const realFile = join(resolve('/real'), 'main.mjs');
    const linkFile = join(resolve('/link'), 'main.mjs');
    const fakeRealpath = (p) => (p === linkFile ? realFile : p);
    assert(
      isDirectRun(pathToFileURL(realFile).href, linkFile, fakeRealpath),
      'argv[1] 是软链、import.meta.url 已 realpath —— 这一半没接上就是 #95 那一枚',
    );
  });

  await check('★ 反向：被 import 时不许为真（守卫不能被改成永远真）', () => {
    const me = pathToFileURL(join(resolve('/opt'), 'main.mjs')).href;
    assert(!isDirectRun(me, undefined), 'argv[1] 缺席时必须是 false');
    assert(!isDirectRun(me, join(resolve('/opt'), 'other.mjs')), '跑的是别的脚本时必须是 false');
  });

  await check('realpath 抛异常（文件不在了）→ false，不许抛出去', () => {
    const boom = () => {
      throw new Error('ENOENT');
    };
    assert(
      !isDirectRun('file:///whatever.mjs', join(resolve('/gone'), 'x.mjs'), boom),
      '应当是 false',
    );
  });
}

console.log(`\n${failures.length === 0 ? '✔' : '✘'} ${passed} 条通过，${failures.length} 条失败`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
