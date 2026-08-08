#!/usr/bin/env node
/**
 * resolve-bundle.mjs —— 四条 e2e 腿共用的一段脚手架：
 * **从「一个装着归档的目录」走到「一个验过结构的包根目录」。**
 *
 * ## 为什么把它提出来（Manager 2026-08-08 裁决）
 *
 * 同一类 shell 坑**撞了三次**，三次都不是产品的问题，三次都是"包好好地打出来了、
 * 脚手架自己把步骤带红了"：
 *
 *   1. `e2e-notes`  `A="$(ls a.tar.xz b.tar.gz c.zip 2>/dev/null | head -1)"`
 *      —— 三个 glob 必然有两个匹配不到，`ls` 非零退出，`set -e` 在赋值那一行
 *      就把整步带走。`2>/dev/null` 吞掉的是**信息**，不是**退出码**。
 *   2. `e2e-import` **独立**踩了同一行（`[CI 实测 run 31247156655]` 三平台全死，
 *      退出码 2/1/2 正好对上 GNU `ls` 与 BSD `ls` 的差异）。
 *   3. `e2e-notes`  `cp dist/bundles/*` 被组装用的**暂存目录**噎住
 *      （`cp` 没 `-r` 碰到目录就 exit 1），`[CI 实测 run 31249161030]` 三平台全红，
 *      而包已经打好了（41.0 MiB，sha256 都算完了）。
 *
 * > **同一个形状撞第三次，说明修的一直是症状。**
 *
 * ## 为什么是 `scripts/ci/` 下的 **Node 脚本**，而不是 composite action
 *
 * 两条依据，第二条是决定性的：
 *
 * **① 病因就是 shell 语义本身。** 三次事故全部是「glob 匹配不到时的退出码」
 *    与「`cp`/`ls` 碰到目录/缺文件的行为」——**换一门不用 glob 退出码决定成败的语言，
 *    这一整类 bug 在结构上消失**。composite action 里装的还是 bash，
 *    等于把同一段危险代码换个地方放，下一次照样撞。
 *
 * **② composite action 的 bash **在本机永远跑不到**。**
 *    本仓 `package.json` 自己写着这条判据：
 *    「`.github/workflows/**` 里的关键步骤在本机跑一遍。**CI 从来没执行过，
 *    所以它里面装着从来没被执行过的错误**」——`lint-workflows.mjs` 与
 *    `test:ci-scripts` 就是为这件事存在的。
 *    放进 `scripts/ci/` 才能被 `selftest-resolve-bundle.mjs` 逐个反向验证，
 *    并挂进 `pnpm test:ci-scripts` 这道**已有**的门禁。
 *    一段"只有推上去才知道对不对"的共享脚手架，是把三次事故的成因**集中**了，不是修掉了。
 *
 * ## 这个脚本**不做**什么（选这个接缝是刻意的）
 *
 * **它不负责把归档弄下来。** 各腿取包的方式本来就不同，而且**差异是真的**：
 *   · `e2e-import` / `e2e-notes` 用 `gh run download`（能在 shell 里挑 run）
 *   · `e2e-record` 用 `actions/download-artifact@v6`（有 `run-id` 输入）
 *   · `e2e-notes` 还有一条「用本次 checkout 现场组装」的模式
 * 把取包也一并统一，就会把这些**有理由的**差异一起碾平。
 * 所以接缝定在**字节已经落盘之后**：给我一个目录，我负责
 * 「挑归档 → 解开 → 找到包根 → 验结构」。
 *
 * ## 失败必须响亮，而且要说清是**哪一种**
 *
 * 每一种失败都有自己的代码，**绝不含糊地"反正失败了"**：
 *   `NO_ARCHIVE` / `MULTIPLE_ARCHIVES` / `EXTRACT_FAILED` / `EXTRACT_TIMEOUT`
 *   / `NO_TOP_DIR` / `MULTIPLE_TOP_DIRS` / `MISSING_ENTRIES`
 *
 * 其中两种是**这次新增的护栏**，此前四条腿全都静悄悄地蒙混过去：
 *   · `MULTIPLE_ARCHIVES` —— 以前是 `head -1` / `[0]`，两个归档并存时**随便挑一个**；
 *   · `MULTIPLE_TOP_DIRS` —— 同上。解出两个顶层目录还继续跑，
 *     等于拿一个你没在验的东西去报绿。
 *
 * ## PROTOCOL §11
 *
 *   · **一切外部命令带超时**（`tar` / `unzip` 都走 `spawnSync` 的 `timeout`），
 *     超时单独报 `EXTRACT_TIMEOUT`，不混进 `EXTRACT_FAILED`；
 *   · **「跳过」不许渲染成「成功」**：这个脚本没有任何"没事可做就退 0"的路径 ——
 *     `--from` 不存在、里面是空的，都是 `NO_ARCHIVE` 红，不是安静通过；
 *   · 不起服务、不占端口，所以「先证明端口是空的」与「按 pid 收进程树」
 *     两条在这里不适用（适用的是各腿自己的 daemon 部分）。
 *
 * ## 用法
 *
 *   node scripts/ci/resolve-bundle.mjs --from <装着归档的目录> --out <解到哪>
 *        [--require app/daemon/dist/main.js,runtime/node]
 *        [--github-output "$GITHUB_OUTPUT"] [--timeout-ms 600000]
 *
 * 退出码：0 = 拿到并验过包根；1 = 上面任何一种失败。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

/** 归档扩展名 → 解压命令候选。**多条候选是刻意的**，见下方 note。 */
const EXTRACTORS = {
  '.tar.xz': [['tar', ['-xJf', '<archive>', '-C', '<out>']]],
  '.tar.gz': [['tar', ['-xzf', '<archive>', '-C', '<out>']]],
  /*
   * Windows 上 `unzip` 不一定在（Git Bash 大多带，但不保证），而 Windows 自带的
   * `tar` 是 bsdtar，**认 zip**。两条都试、都不行才红。
   *
   * ⚠️ 这是**统一是对的**那一类差异：`e2e-import` / `e2e-record` 有这条兜底，
   * `e2e-notes` / `e2e-runtime` 没有 —— 后两条只是**碰巧**没撞上
   * （runner 镜像里恰好有 unzip）。这不是"各腿有意为之的不同"，是漏。
   */
  '.zip': [
    ['unzip', ['-q', '<archive>', '-d', '<out>']],
    ['tar', ['-xf', '<archive>', '-C', '<out>']],
  ],
};
const ARCHIVE_EXTS = Object.keys(EXTRACTORS);

const FROM = arg('--from', null);
const OUT = arg('--out', null);
const TIMEOUT_MS = Number(arg('--timeout-ms', '600000'));
const GITHUB_OUTPUT = arg('--github-output', process.env.GITHUB_OUTPUT ?? '');
const REQUIRE = String(arg('--require', 'app/daemon/dist/main.js'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/*
 * ★ `--require-node-runtime`：**意图是共享的，拼写是平台的。**
 *
 * 包自带的 Node 在 posix 上叫 `runtime/node`，在 Windows 上叫 `runtime/node.exe`。
 * 各腿要问的问题是同一个（"这个包自带运行时吗"），而**文件名是包格式的知识**，
 * 不该让每条腿各自去拼 `${{ matrix.leg == 'windows' && '.exe' || '' }}`——
 * `[CI 实测 run 31251484499]` 我就是这么栽的：三条腿统一写了 `runtime/node`，
 * linux/macOS 绿、**Windows 报 MISSING_ENTRIES**。
 *
 * 这是"顺手统一"的另一面：**统一意图是对的，统一拼写是错的。**
 * 所以把拼写收进这里（懂包格式的地方），把意图留给各腿用一个开关表达。
 */
const REQUIRE_NODE = argv.includes('--require-node-runtime');
if (REQUIRE_NODE) REQUIRE.push(process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node');

const say = (s = '') => console.log(s);

/** 唯一的失败出口：代码 + 人话 + 现场。**不存在"安静地失败"这条路。** */
function die(code, message, extra = []) {
  say('');
  say(`::error::[resolve-bundle] ${code} —— ${message}`);
  say(`✘ ${code}：${message}`);
  for (const line of extra) say(`   ${line}`);
  process.exit(1);
}

if (!FROM || !OUT) {
  die('BAD_USAGE', '--from 与 --out 都是必填', [
    '用法：node scripts/ci/resolve-bundle.mjs --from <装着归档的目录> --out <解到哪>',
  ]);
}

const fromDir = resolve(FROM);
const outDir = resolve(OUT);

say('─'.repeat(88));
say(`── resolve-bundle：${fromDir} → ${outDir}`);
say('─'.repeat(88));

/* ── ① 挑归档 ──────────────────────────────────────────────────────────────────
 *
 * 只看**文件**，不看目录 —— 这正是第 3 次事故的现场：`dist/bundles/` 里除了归档
 * 还有组装用的暂存目录 `openmemo-<版本>-<target>/`。
 */
if (!existsSync(fromDir)) {
  die('NO_ARCHIVE', `--from 指向的目录不存在：${fromDir}`, [
    '（"目录不存在"也是红，不是"没事可做"—— PROTOCOL §11：跳过不许渲染成成功）',
  ]);
}

let entries;
try {
  entries = readdirSync(fromDir, { withFileTypes: true });
} catch (e) {
  die('NO_ARCHIVE', `--from 读不出来：${e.message}`);
}

const archives = entries
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .filter((n) => ARCHIVE_EXTS.some((ext) => n.endsWith(ext)))
  .sort()
  .map((n) => join(fromDir, n));

const listing = entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`);

if (archives.length === 0) {
  die('NO_ARCHIVE', `${fromDir} 里一个包归档都没有（找的是 ${ARCHIVE_EXTS.join(' / ')}）`, [
    '目录内容：',
    ...listing.map((l) => `  ${l}`),
  ]);
}
if (archives.length > 1) {
  /*
   * ★ 新护栏。四条腿此前都是 `head -1` / `[0]` —— 两个归档并存时**随便挑一个然后照常报绿**。
   *   那正是本仓最怕的形状：绿灯追溯不到"到底验的是哪个东西"。
   */
  die('MULTIPLE_ARCHIVES', `${fromDir} 里有 ${archives.length} 个归档，不知道该验哪一个`, [
    ...archives.map((a) => `  ${a}`),
    '此前的写法是"挑第一个然后接着跑"——那样的绿灯追溯不到它验的是谁。',
  ]);
}

const archive = archives[0];
const ext = ARCHIVE_EXTS.find((e) => archive.endsWith(e));
say(`   归档：${archive}（${statSync(archive).size} B）`);

/* ── ② 解开（外部命令一律带超时，PROTOCOL §11）──────────────────────────────
 *
 * ★ **先把 --out 建出来。** `tar -C <dir>` 与 `unzip -d <dir>` 都**不会**替你建目录，
 *   `tar` 只会回一句 `Cannot open: No such file or directory` 然后 exit 2。
 *
 *   `[CI 实测]` 这个脚手架第一版漏了这行，三条 e2e 腿一起红成 `EXTRACT_FAILED`
 *   （e2e-record run 31250861440、e2e-notes run 31251083538）——
 *   **正是我在文件头担心的那件事**：把三段重复代码合成一段，
 *   如果它自己有 bug，就从"三条腿各红一次"变成"四条腿一起红"。
 *
 *   ⚠️ 而我的 selftest **没抓住它**，原因值得记：`fresh()` 这个测试夹具
 *   自己 `mkdirSync` 了 out 目录，**比真实调用方更宽容** ——
 *   夹具替被测代码把前提凑齐了，于是那个前提缺失的分支从来没被走到。
 *   （与本仓"断言的字段在夹具里恒为假"是同一族：**夹具比现实友善**。）
 *   现在 selftest 里补了一条"out 目录不存在"的用例。
 */

mkdirSync(outDir, { recursive: true });

const attempts = [];
let extracted = false;
let timedOut = false;
for (const [cmd, template] of EXTRACTORS[ext]) {
  const args = template.map((a) => a.replace('<archive>', archive).replace('<out>', outDir));
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: TIMEOUT_MS });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    timedOut = true;
    attempts.push(`${cmd}: 超时（>${TIMEOUT_MS}ms）`);
    continue;
  }
  if (r.error) {
    attempts.push(`${cmd}: 起不来 —— ${r.error.message}`);
    continue;
  }
  if (r.status === 0) {
    say(`   解开：${cmd} ${args.join(' ')}`);
    extracted = true;
    break;
  }
  attempts.push(
    `${cmd}: exit ${r.status} —— ${String(r.stderr ?? '')
      .trim()
      .slice(0, 200)}`,
  );
}

if (!extracted) {
  // 超时**单独报**，不混进"解压失败"—— 两者的处置完全不同（一个是环境，一个是坏包）。
  if (timedOut) {
    die('EXTRACT_TIMEOUT', `解压 ${archive} 超过 ${TIMEOUT_MS}ms`, attempts);
  }
  die('EXTRACT_FAILED', `${ext} 的解压命令全都失败了`, attempts);
}

/* ── ③ 找包根 ────────────────────────────────────────────────────────────────
 *
 * 包解出来是 `openmemo-<版本>-<target>/` 一层壳。版本号会变，所以**不硬编码名字**。
 */
const tops = readdirSync(outDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

if (tops.length === 0) {
  die('NO_TOP_DIR', `${outDir} 里没有顶层目录 —— 这不像一个包归档`, [
    '解出来的东西：',
    ...readdirSync(outDir)
      .slice(0, 30)
      .map((n) => `  ${n}`),
  ]);
}
if (tops.length > 1) {
  // ★ 同样是新护栏：以前 `head -1` 会安静地挑一个。
  die('MULTIPLE_TOP_DIRS', `${outDir} 里有 ${tops.length} 个顶层目录，不知道哪个是包根`, [
    ...tops.map((t) => `  ${t}`),
    '（--out 指向了一个已经装着别的东西的目录？这一步以前是"挑第一个"，会验错对象。）',
  ]);
}

const bundleDir = join(outDir, tops[0]);
say(`   包根：${bundleDir}`);

/* ── ④ 验结构：这是不是一个**预编译包** ──────────────────────────────────────
 *
 * `--require` 让各腿自己说"我这条腿需要包里有什么"。默认只要 daemon 入口
 * （四条腿都要），要 `runtime/node` 的腿自己加 —— 我不替它们猜。
 */
const missing = REQUIRE.filter((rel) => !existsSync(join(bundleDir, rel)));
if (missing.length > 0) {
  const tree = [];
  const walk = (dir, prefix, depth) => {
    if (depth > 2) return;
    let es;
    try {
      es = readdirSync(dir, { withFileTypes: true }).slice(0, 12);
    } catch {
      return;
    }
    for (const e of es) {
      tree.push(`  ${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}  `, depth + 1);
    }
  };
  walk(bundleDir, '', 0);
  die('MISSING_ENTRIES', `包根里缺 ${missing.length} 项：${missing.join(', ')}`, [
    `包根：${bundleDir}`,
    '实际结构（前两层）：',
    ...tree.slice(0, 40),
  ]);
}
for (const rel of REQUIRE) say(`   ✔ 包里有 ${rel}`);

/* ── ⑤ 交出去 ───────────────────────────────────────────────────────────────── */

if (GITHUB_OUTPUT) {
  appendFileSync(GITHUB_OUTPUT, `bundle_dir=${bundleDir}\narchive=${archive}\n`);
  say(`   已写入 GITHUB_OUTPUT：bundle_dir / archive`);
}
say(`bundle_dir=${bundleDir}`);
process.exit(0);
