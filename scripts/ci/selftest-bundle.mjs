#!/usr/bin/env node
/**
 * `scripts/ci/verify-bundle.sh` 的**本机自检 + 反向验证**。全程离线。
 *
 * ## 为什么必须有这个文件
 *
 * `verify-bundle.sh` 是预编译包的出厂检查 —— 它只在 `build-bundle` 那条流水线上跑，
 * 而那条流水线**一次要跑三个平台、每次都要几十分钟**。也就是说：它自己写错了，
 * 最早也要等到一次真打包才知道，而那时候它的错法多半是**报绿**（少检查了几条），
 * 不是报红。本仓已经为这个形状付过两次账：
 *   · `build-backends.yml` 的 C5：`for f in <不匹配的 glob>` → 检查了零个文件然后报绿；
 *   · `build-backends.yml` 第一次真跑时带着 11 条错误 —— 因为在那之前它**从来没被执行过**。
 *
 * 所以判据和 `selftest-release-upload.mjs` 一样：
 *
 * > **每一条"必须红"的性质，都用一个坏输入证明它真的会红，并且断言在真实输出上。**
 *
 * ## 为什么用合成夹具，而不是拿一个真包来验
 *
 * 三个原因，都不是洁癖：
 *   1. **真包造不出来。** 一个真包要 `pnpm -r build`（会覆盖 :10000 正在托管的
 *      `apps/web/dist`，PROTOCOL §7 明令禁止）、要下载三平台的 Node 运行时、
 *      要编 libsimple/vec0。这些东西没有一件能进一条"每次 push 都跑"的门禁。
 *   2. **反向验证根本没法在真包上做。** "把 sherpa-onnx 整个目录删掉"这种输入，
 *      只有合成夹具给得出来 —— 而那恰恰是最该验的一条（见 ④）。
 *   3. 夹具里的 `runtime/node` 是一个 `#!/bin/sh` 桩，不是真 Node。这不削弱任何东西：
 *      被测对象是 `verify-bundle.sh` 的**判定逻辑**，不是 Node 本身。
 *      `[实测]` 桩带 0o755 且 tar 保模式，所以脚本里那条「存在 ≠ 能跑」的断言在
 *      linux-x64 上是**真的执行到了**的 —— ① 的输出里有
 *      `自带 Node 真的能执行：v22.20.0`，那正是桩打出来的。
 *
 * ## 覆盖到哪儿（`[实测]` 数字来自本文件跑出来的真实输出）
 *
 *   ①  正向 · linux-x64（`.tar.xz` 那条解压分支）→ exit 0，`检查了 26 条，失败 0 条`
 *   ②  删 `app/apps/web/dist/index.html` → 红。**白页包**：用户打开是白页，
 *       而从 daemon 到浏览器控制台没有任何一处会报错。
 *   ③  删 `ext/libsimple.<ext>` → 红（缺了中文两字词搜索静默返回 0 条）。
 *   ④  ★ 删整个 `sherpa-onnx-<平台>/` → 红。**这是最重要的一条**：sherpa-onnx 是
 *       os/cpu 门控的 optional dep，pnpm 在每台机器上**只装宿主那一个**，
 *       所以"漏了"在打包机上完全看不出来 —— 它只在**别的平台**的用户机器上显形。
 *   ④b 目录在、但只剩 1 个原生件 → 也要红（`.node` 缺了兄弟 `.so` 一样 dlopen 不起来）。
 *   ⑤  塞一个叫 `ffmpeg` 的文件 → 红（GPL）；**同时反过来断言** `ffmpeg.js` 不许触发。
 *       后者是一个**真的发生过并已修复**的假阳性：第一版写 `-iname 'ffmpeg*'`，
 *       当场命中 `@openmemo/pipeline/dist/audio/ffmpeg.js` —— 那是我们自己去 spawn
 *       ffmpeg 的模块，不是 GPL 的字节。这条用例把那次修复钉住。
 *   ⑥  `prebuilds/` 里留 2 个 → 红（必须裁到本平台那一个）。
 *   ⑦  删 `THIRD-PARTY-NOTICES` → 红；文件在但缺 "elects the MIT option" → 也红
 *       （libsimple 是 MIT-OR-GPL 双许可，不声明我们选了哪边就可能被读成 GPL-3.0）。
 *   ⑧⑨ win-x64 参数化：`node.exe` / `start.cmd` / `win32-x64.node` / `.dll` 这条命名
 *       支路走一遍正向 + 一条反向。跨平台那格还顺带钉住「宿主≠目标时跳过执行检查」——
 *       `[实测]` 该用例只数到 25 条（比 linux 少了「真的执行一次」那条），仍 ≥ 20。
 *
 * ## 它自己不是空转 —— 变异验证（`[实测 2026-08-08]`）
 *
 * 一个"怎么改被测者都还是绿"的自检比没有更糟。所以把 `scripts/ci/` 整个复制到
 * `/tmp`（仓库里那份一个字节都没动），在副本上改坏 `verify-bundle.sh` 再跑本文件：
 *
 *   · 变异 A：整段删掉「GPL 组件不许在包里」那道反向断言（944 字节）
 *     → ⑤a、⑤b **两条当场红**，本自检 exit 1。
 *     ⚠️ 值得记的是变异后的 `verify-bundle.sh` 自己**照样报绿**：
 *     `检查了 25 条，失败 0 条 / ✔ 全部通过` —— 25 仍然 ≥ 20，那道 `CHECKED < 20`
 *     的底线接不住"少了一条"。**它接得住的只有断言集被整体掏空。**
 *   · 变异 B：把匹配模式退回第一版 `-iname 'ffmpeg*'`
 *     → ⑤a 仍绿（有 ffmpeg 照样能查出来），**只有 ⑤b 红**。
 *     这正是那次假阳性的形状：守卫看起来完全正常，直到它把我们自己的
 *     `ffmpeg.js` 判成 GPL 组件、把整个包卡在出厂线上。
 *
 * ## §10：全部跑在 `/tmp` 的隔离副本上
 *
 * 一个 `mkdtemp` 根，退出时整个删掉。共享工作树一个字节都不动 ——
 * 反向验证的中间态（比如"包里有一个 ffmpeg"）不许被别人看见。
 *
 * 跑：`node scripts/ci/selftest-bundle.mjs`（`pnpm test:ci-scripts` 会调）
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * ⚠️ 被测脚本的路径**只能**从本文件自己的位置推出来，不许走环境变量覆盖。
 * 这样"用一个改坏的 verify-bundle.sh 证明本自检不是空转"的做法就是
 * 「把 scripts/ci/ 整个复制到 /tmp 再改那份副本」—— 仓库里的那份永远动不了，
 * 而自检里也不会留下一个"喂个别的路径进来"的旁路。
 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(REPO_ROOT, 'scripts', 'ci', 'verify-bundle.sh');
const VERSION = '0.2.0';

const WORK = mkdtempSync(join(tmpdir(), 'om-selftest-bundle-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
  } catch (e) {
    failures.push(
      `${name}\n      ${e instanceof Error ? e.message.split('\n').join('\n      ') : String(e)}`,
    );
    console.log(`  \x1b[31m✘\x1b[0m ${name}`);
  }
}

/* ── 夹具 ─────────────────────────────────────────────────────────────────────────── */

/**
 * 每个 target 的命名支路。**逐项抄自 `verify-bundle.sh:33-38` 的那张 case 表** ——
 * 夹具与被测者共用同一份事实，所以那张表被改坏时这里会红，而不是"夹具跟着一起错"。
 */
const LAYOUT = {
  'linux-x64': {
    nodeExe: 'node',
    probeExe: 'openmemo-probe',
    whisperCliExe: 'whisper-cli',
    libext: 'so',
    launcher: 'start.sh',
    prebuild: 'linux-x64.node',
    sherpa: 'sherpa-onnx-linux-x64',
    /* ★ 必须 ≥ 2 个原生件：sherpa 的 .node 需要兄弟 .so 同目录才 dlopen 得起来。 */
    natives: ['sherpa-onnx.linux-x64.node', 'libsherpa-onnx-c-api.so'],
  },
  'win-x64': {
    nodeExe: 'node.exe',
    probeExe: 'openmemo-probe.exe',
    whisperCliExe: 'whisper-cli.exe',
    libext: 'dll',
    launcher: 'start.cmd',
    prebuild: 'win32-x64.node',
    sherpa: 'sherpa-onnx-win-x64',
    /*
     * ⚠️ 这两个名字不能随手编：GPL 反向断言里有一条 `-name 'avcodec*.dll'`。
     * 夹具里若出现 `avcodec*.dll`，正向用例会以"包里有 GPL"红掉 ——
     * 那会是一条查不出成因的假红。
     */
    natives: ['sherpa-onnx.win32-x64-msvc.node', 'sherpa-onnx-c-api.dll'],
  },
};

/** 完整（应当通过）的夹具包。返回 `Map<相对路径, {content, mode}>`，用例在上面做减法。 */
function fixtureFiles(target) {
  const L = LAYOUT[target];
  const f = new Map();
  const put = (p, content = `stub:${p}\n`, mode = 0o644) => f.set(p, { content, mode });

  /*
   * 自带 Node。`verify-bundle.sh` 不只看它在不在，还会 `--version` 真的跑一次
   * （存在 ≠ 能跑：架构不符、权限位丢失、Mach-O 签名坏掉都只在那一步显形）。
   * 所以这里放一个可执行的 sh 桩 —— 目的是让那条断言**真的被执行到**，
   * 而不是让它在自检里静默跳过。
   */
  put(`runtime/${L.nodeExe}`, '#!/bin/sh\necho v22.20.0\n', 0o755);

  put('app/apps/web/dist/index.html', '<!doctype html><div id="root"></div>\n');
  put('app/apps/web/dist/assets/index-deadbeef.js', 'console.log(1)\n');

  put('app/daemon/dist/main.js', 'export {}\n');
  put('app/daemon/dist/build-info.json', `{"version":"${VERSION}"}\n`);
  for (const p of ['db', 'downloader', 'llm', 'mindmap', 'pipeline', 'runtime', 'shared']) {
    put(`app/node_modules/@openmemo/${p}/package.json`, `{"name":"@openmemo/${p}"}\n`);
  }
  put('app/node_modules/@openmemo/db/migrations/0001_init.sql', 'CREATE TABLE t(id);\n');

  put(`app/node_modules/better-sqlite3/prebuilds/${L.prebuild}`, 'NAPI-STUB\n');
  for (const n of L.natives) put(`app/node_modules/${L.sherpa}/${n}`, 'NATIVE-STUB\n');
  put('app/node_modules/sherpa-onnx-node/package.json', '{"name":"sherpa-onnx-node"}\n');

  put(`ext/libsimple.${L.libext}`, 'SQLITE-EXT-STUB\n');
  put(`ext/vec0.${L.libext}`, 'SQLITE-EXT-STUB\n');
  put('ext/dict/jieba.dict.utf8', '词典\n');

  /*
   * 最小探针运行时（鸡生蛋那一环，ADR-015 §7.5）。
   * 与 node 桩同理：`verify-bundle.sh` 在**同平台**时会**真的跑一次探针**并要求
   * `deviceCount >= 1` —— `[CI 实测 run 31261013823]` macOS 上正是这条抓到了
   * "文件都在、但 dyld 加载不了 libggml.0.dylib"。所以这里的探针必须是可执行的桩，
   * 否则那条断言会在自检里静默跳过，而它恰恰是最有价值的一条。
   */
  put(
    `runtime/probe/${L.probeExe}`,
    '#!/bin/sh\necho \'{"schemaVersion":1,"deviceCount":1,"devices":[{"name":"CPU"}]}\'\n',
    0o755,
  );
  put(`runtime/probe/libggml-base.${L.libext}`, 'GGML-CORE-STUB\n');
  put(`runtime/probe/libggml.${L.libext}`, 'GGML-CORE-STUB\n');
  put(`runtime/probe/libggml-cpu-x64.${L.libext}`, 'GGML-CPU-STUB\n');
  /*
   * CPU 基线转写链（Manager 2026-08-08 裁决）。`whisper-cli` 同样必须是**可执行的桩** ——
   * `verify-bundle.sh` 会真的跑一次 `--help` 并要求打出 `usage:`，
   * 桩不可执行的话那条最有价值的断言会静默跳过（与探针那条同一个道理）。
   */
  put(
    `runtime/probe/${L.whisperCliExe}`,
    "#!/bin/sh\necho 'usage: whisper-cli [options] file0 file1 ...'\n",
    0o755,
  );
  put(`runtime/probe/libwhisper.${L.libext}`, 'WHISPER-LIB-STUB\n');
  /* 组件目录：缺了它用户的组件页是空的（用户 2026-08-08 报的第一条的真因）。 */
  put('vendor/manifests/backends.json', JSON.stringify({ packs: [{ id: 'stub' }] }) + '\n');
  put('vendor/manifests/models-whisper.json', JSON.stringify({ models: [] }) + '\n');
  put('vendor/manifests/models-llm.json', JSON.stringify({ models: [] }) + '\n');

  put(L.launcher, '#!/bin/sh\n', 0o755);
  put('LICENSE', 'UNLICENSED\n');
  put(
    'THIRD-PARTY-NOTICES',
    'libsimple — MIT OR GPL-3.0\nOpenMemo elects the MIT option for libsimple.\n',
  );
  return f;
}

/** 摆好目录树 → 打成归档。归档是 `name/` 的兄弟，不会把自己打进去。 */
function buildArchive(target, { mutate, ext = 'tar.gz' } = {}) {
  const files = fixtureFiles(target);
  mutate?.(files, LAYOUT[target]);
  const root = mkdtempSync(join(WORK, 'fx-'));
  const name = `openmemo-${VERSION}-${target}`;
  for (const [rel, { content, mode }] of files) {
    const abs = join(root, name, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    chmodSync(abs, mode);
  }
  const archive = join(root, `${name}.${ext}`);
  execFileSync('tar', [ext === 'tar.xz' ? '-cJf' : '-czf', archive, '-C', root, name]);
  return archive;
}

function run(target, opts) {
  const archive = buildArchive(target, opts);
  const r = spawnSync('bash', [VERIFY, '--archive', archive, '--target', target], {
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 把 `检查了 N 条，失败 M 条` 那行解出来。解不出来本身就是失败 —— 那意味着脚本半路死了。 */
function tally(out) {
  const m = /检查了 (\d+) 条，失败 (\d+) 条/.exec(out);
  assert.ok(m, `输出里没有计数行（脚本可能中途退出了）：\n${out}`);
  return { checked: Number(m[1]), failed: Number(m[2]) };
}

/** 只为把实测数字写进用例名 —— 让"到底数到了几条"出现在输出里，而不是只活在注释里。 */
function peekChecked(out) {
  const m = /检查了 (\d+) 条/.exec(out);
  return m ? m[1] : '?';
}

/** 删掉某个前缀下的所有文件 —— 用来模拟"整个目录不在包里"。返回删掉的条数。 */
function dropPrefix(files, prefix) {
  let n = 0;
  for (const k of [...files.keys()]) {
    if (k.startsWith(prefix)) {
      files.delete(k);
      n += 1;
    }
  }
  assert.ok(n > 0, `夹具里没有前缀 ${prefix} 的文件 —— 这条反向用例会因为"没东西可删"而空转`);
  return n;
}

/* ── 用例 ─────────────────────────────────────────────────────────────────────────── */

console.log('');
console.log('══ selftest-bundle ══════════════════════════════════════════════════════════');
console.log('   合成夹具包，全程离线；全部跑在 /tmp 的隔离副本上（PROTOCOL §10）');
console.log('');
console.log('① 正向 —— 完整的包必须绿，且断言集不许缩水');

{
  /* `.tar.xz` 是 linux/macOS 包的真实格式，顺带走一遍那条解压分支。 */
  const r = run('linux-x64', { ext: 'tar.xz' });
  check(
    `① linux-x64 完整包 → exit 0，实测「检查了 ${peekChecked(r.out)} 条、失败 0 条」（下限 20）`,
    () => {
      assert.equal(r.status, 0, r.out);
      const t = tally(r.out);
      assert.equal(t.failed, 0, `完整包不该有失败项：\n${r.out}`);
      assert.ok(
        t.checked >= 20,
        `只检查了 ${t.checked} 条 —— 断言集被缩小了（C5：什么都没检查的检查器是最坏的那种绿）\n${r.out}`,
      );
      assert.match(r.out, /✔ 全部通过/);
    },
  );
  check('① 自带 Node 的「真的执行一次」在同平台上真的执行到了（不是静默跳过）', () => {
    assert.match(r.out, /自带 Node 真的能执行：v22\.20\.0/, r.out);
  });
}

console.log('');
console.log('② ～ ⑦ 反向验证 —— 每一条都必须红');

/* ② 白页包。缺了它用户打开是白页，而从 daemon 到浏览器控制台没有任何一处会报错。 */
{
  const r = run('linux-x64', { mutate: (f) => f.delete('app/apps/web/dist/index.html') });
  check('② 缺 app/apps/web/dist/index.html → 红，并点名网页 bundle（白页包不许出厂）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /缺文件：app\/apps\/web\/dist\/index\.html/);
    assert.match(r.out, /只有 pnpm -r build 会产出/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}

/* ③ libsimple。缺了它中文两字词搜索**静默返回 0 条** —— 不报错，只是查不到东西。 */
{
  const r = run('linux-x64', { mutate: (f, L) => f.delete(`ext/libsimple.${L.libext}`) });
  check('③ 缺 ext/libsimple.so → 红（中文两字词搜索会静默返回 0 条）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /缺文件：ext\/libsimple\.so/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}

/*
 * ④ ★★ sherpa-onnx —— 本文件里最重要的一条。
 *
 * 它是 os/cpu 门控的 optional npm dep：**pnpm 在每台机器上只装宿主那一个**。
 * 于是"给别的平台打包时忘了带"这件事，在打包机上从头到尾看不出任何异常 ——
 * 包能打出来、能装上、daemon 能起来，只有那个平台的用户在按下录音键时
 * 发现流式 ASR / VAD 整条不可用。这正是"只在别的平台显形"的定义。
 */
{
  const r = run('linux-x64', { mutate: (f, L) => dropPrefix(f, `app/node_modules/${L.sherpa}/`) });
  check('④ 整个 sherpa-onnx-linux-x64/ 不在包里 → 红，且说明该平台流式 ASR/VAD 整条不可用', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /sherpa-onnx-linux-x64 不在包里/);
    assert.match(r.out, /流式 ASR \/ VAD 整条不可用/);
    assert.match(r.out, /只在那个平台显形/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}

/* ④b 目录在、但只有一个原生件 —— .node 没有兄弟 .so 时 dlopen 一样起不来。 */
{
  const r = run('linux-x64', {
    mutate: (f, L) => f.delete(`app/node_modules/${L.sherpa}/libsherpa-onnx-c-api.so`),
  });
  check('④b sherpa 目录在但只剩 1 个原生件 → 红（.node 需要兄弟 .so 同目录）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /只有 1 个原生件/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}

/*
 * ⑤ GPL 反向断言 —— **两个方向都要断言**。
 *
 * 只验"有 ffmpeg 会红"是不够的：第一版守卫写的是 `-iname 'ffmpeg*'`，它当然会红，
 * 但它同时把 `@openmemo/pipeline/dist/audio/ffmpeg.js`（**我们自己的代码**，
 * 那个去 spawn ffmpeg 的模块）也判成了 GPL 组件。那次假阳性已经修成"basename 必须
 * 恰好是工具名"，下面这两条把修复钉住 —— 少任何一条，模式被改回 `ffmpeg*` 都不会红。
 */
{
  const r = run('linux-x64', {
    mutate: (f) => f.set('app/bin/ffmpeg', { content: 'ELF\n', mode: 0o755 }),
  });
  check('⑤a 包里有一个名为 ffmpeg 的二进制 → 红，并点名 GPL / ADR-002 分发阻断', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /包里发现 GPL 组件/);
    assert.match(r.out, /ADR-002/);
    assert.match(r.out, /app\/bin\/ffmpeg/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}
{
  const r = run('linux-x64', {
    mutate: (f) =>
      f.set('app/node_modules/@openmemo/pipeline/dist/audio/ffmpeg.js', {
        content: "export const FFMPEG = 'ffmpeg';\n",
        mode: 0o644,
      }),
  });
  check('⑤b 反过来：我们自己的 ffmpeg.js **不许**被判成 GPL（这条假阳性真的发生过）', () => {
    assert.equal(r.status, 0, `ffmpeg.js 把守卫触发了 —— 模式又被写回 'ffmpeg*' 了：\n${r.out}`);
    assert.match(r.out, /包里没有 ffmpeg \/ ffprobe \/ yt-dlp/);
    assert.equal(tally(r.out).failed, 0, r.out);
  });
}

/*
 * ⑥ prebuilds 必须恰好 1 个。多留的 7 个不只是 16 MB 死重 ——
 * 它们会**掩盖"平台判断写错了"**：错的那个也在包里，于是跑起来看着还是对的。
 */
{
  const r = run('linux-x64', {
    mutate: (f) =>
      f.set('app/node_modules/better-sqlite3/prebuilds/darwin-arm64.node', {
        content: 'NAPI-STUB\n',
        mode: 0o644,
      }),
  });
  check('⑥ prebuilds/ 里有 2 个文件 → 红（必须裁到本平台那一个）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /prebuilds\/ 里有 2 个文件，应当只有 1 个/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}

/* ⑦a 声明文件整个不在 —— MIT/Apache-2.0 都要求保留版权声明，这是公开分发的硬条件。 */
{
  const r = run('linux-x64', { mutate: (f) => f.delete('THIRD-PARTY-NOTICES') });
  check('⑦a 缺 THIRD-PARTY-NOTICES → 红（文件缺失与 election 缺失各红一条）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /缺文件：THIRD-PARTY-NOTICES/);
    /* 文件不在 ⇒ grep 也查不到 election，两条独立断言各红一次。 */
    assert.equal(tally(r.out).failed, 2, r.out);
  });
}

/*
 * ⑦b 文件在、但没写 MIT election。这一条比 ⑦a 更该有：**它看起来是合规的**。
 * libsimple 是 MIT-OR-GPL 双许可 —— 不声明我们选了哪一边，就可能被读成 GPL-3.0，
 * 而那会当场推翻 D-17 §1 的整套结论。
 */
{
  const r = run('linux-x64', {
    mutate: (f) =>
      f.set('THIRD-PARTY-NOTICES', {
        content: 'libsimple — dual licensed.\n',
        mode: 0o644,
      }),
  });
  check('⑦b THIRD-PARTY-NOTICES 在但没写 "elects the MIT option" → 红', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /没有 libsimple 的 MIT election/);
    assert.match(r.out, /可能被读成 GPL-3\.0/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}

console.log('');
console.log('⑧ ⑨ win-x64 参数化 —— .dll / node.exe / start.cmd / win32-x64.node 那条命名支路');

/*
 * 这一格顺带钉住**跨平台跳过**：宿主是 linux 时那条「真的执行一次」跑不动，
 * 脚本必须**跳过并明说**，而不是判失败（否则 Linux runner 上验 Windows 包永远红）。
 * 同时它也不许因为跳过而把总数掉到 20 以下 —— 那是另一头的失败方式。
 */
{
  const r = run('win-x64');
  check(
    `⑧ win-x64 完整包 → exit 0；跨平台跳过「真的执行一次」，实测仍有 ${peekChecked(r.out)} 条（≥ 20）`,
    () => {
      assert.equal(r.status, 0, r.out);
      const t = tally(r.out);
      assert.equal(t.failed, 0, r.out);
      assert.ok(t.checked >= 20, `跳过之后只剩 ${t.checked} 条：\n${r.out}`);
      assert.match(r.out, /跳过「真的执行一次」/);
    },
  );
}
{
  const r = run('win-x64', { mutate: (f, L) => f.delete(`ext/libsimple.${L.libext}`) });
  check('⑨ win-x64 缺 ext/libsimple.dll → 红（.dll 这条命名支路真的被检查了）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /缺文件：ext\/libsimple\.dll/);
    assert.equal(tally(r.out).failed, 1, r.out);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * ⑰–⑲ 最小探针运行时（鸡生蛋那一环）
 *
 * `[用户真机 2026-08-08, Windows v0.3.0]` 解压即运行，本机组件页**六个后端全部**报
 * `probe did not complete: probe executable not found`。包里根本没有探针。
 * 这三条把「包里没有探针」钉成**打包时当场红**，而不是等用户报。
 * ═══════════════════════════════════════════════════════════════════════════════════ */
{
  const L = LAYOUT['linux-x64'];

  {
    const r = run('linux-x64', { mutate: (f) => f.delete(`runtime/probe/${L.probeExe}`) });
    check('⑰ ★ 包里没有探针 → 红（复现用户 v0.3.0 那一屏的成因）', () => {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /缺文件：runtime\/probe\/openmemo-probe/);
    });
  }

  /*
   * ★ 这条是三条里最有价值的：ggml 核心缺了之后，**文件存在性检查全绿**
   *   （探针在、CPU 模块在），只有「真的跑一次」那条会红。
   *   `[CI 实测 run 31261013823]` macOS 上真的这么发生过：
   *   `dyld: Library not loaded: @rpath/libggml.0.dylib`。
   */
  {
    const r = run('linux-x64', {
      mutate: (f) => f.delete(`runtime/probe/libggml-base.${L.libext}`),
    });
    check('⑱ ★ 缺 ggml 核心 → 红（存在性检查会放行，只有"真的跑一次"抓得到）', () => {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /ggml-base/);
    });
  }

  {
    const r = run('linux-x64', {
      mutate: (f) => f.delete(`runtime/probe/libggml-cpu-x64.${L.libext}`),
    });
    check('⑲ 缺 CPU 后端模块 → 红（探针会枚举出 0 个设备 = 等于没有答案）', () => {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /ggml-cpu/);
    });
  }

  /* ── CPU 基线转写链的反向验证（Manager 2026-08-08 要求：抽掉 → 当场红）── */

  {
    const r = run('linux-x64', {
      mutate: (f) => f.delete(`runtime/probe/${L.whisperCliExe}`),
    });
    check('⑳ ★ 包里没有 whisper-cli → 红（用户就得先下一个引擎包才能转写第一段）', () => {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /缺文件：runtime\/probe\/whisper-cli/);
    });
  }

  {
    /*
     * ★ 与 ⑱ 同一类、也同样值钱：libwhisper 缺了之后**文件存在性检查会放行**
     *   （whisper-cli 在、ggml 在），只有「真的跑一次 --help」那条抓得到。
     *   `[本机实测 2026-08-08 linux-x64]` 只搬 exe 不搬 libwhisper：
     *   `error while loading shared libraries: libwhisper.so.1`。
     */
    const r = run('linux-x64', {
      mutate: (f) => f.delete(`runtime/probe/libwhisper.${L.libext}`),
    });
    check('㉑ ★ 缺 libwhisper → 红（存在性检查会放行，只有"真的跑一次"抓得到）', () => {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /libwhisper/);
    });
  }

  {
    const r = run('linux-x64', { mutate: (f) => f.delete('vendor/manifests/backends.json') });
    check('㉒ ★ 包里没有 backends.json → 红（用户的组件页会是空的：packs=0）', () => {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /manifests/);
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * ⑩–⑫ `build-bundle.mjs --out` 的路径解析
 *
 * 病灶：`makeArchive()` 里 `execFileAsync('tar', [flag, out, …], { cwd: OUT_ROOT })`
 * —— 归档路径**跨了一次 `cwd` 边界**。`--out` 给相对路径时 `out` 也是相对的，
 * tar 会把它**再相对 OUT_ROOT 解析一次**，产物落到
 * `dist/bundles/dist/bundles/…tar.xz`，**而脚本照样 exit 0**。
 * 下游 upload-artifact 的 glob 匹配不到，表现成"这次构建没有产物" ——
 * 与"构建失败"长得完全不一样（本仓招牌形状：成功地什么都没做）。
 *
 * 这三条用 `--print-paths` 验（那个 flag 只打印解析结果、不碰网络也不写盘），
 * 因为真跑一次要下 ~180 MB —— 而"路径算得对不对"正是因为跑不起而漏掉的那一格。
 * ═══════════════════════════════════════════════════════════════════════════════════ */
{
  const BUILDER = join(REPO_ROOT, 'scripts', 'build-bundle.mjs');
  const paths = (out, cwd) => {
    const r = spawnSync(
      process.execPath,
      [BUILDER, '--target', 'linux-x64', '--out', out, '--print-paths'],
      {
        encoding: 'utf8',
        cwd,
      },
    );
    if (r.status !== 0) throw new Error(`--print-paths 退出码 ${r.status}: ${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  // 建在 WORK 底下，收尾时随 WORK 一起删（不另开一个要自己记得清的目录）
  const tmpCwd = mkdtempSync(join(WORK, 'outpath-'));

  check('⑩ 相对 --out 必须解析成绝对路径（相对 cwd，不是相对仓库根）', () => {
    const p = paths('rel/out', tmpCwd);
    assert.equal(isAbsolute(p.outRoot), true, `outRoot 不是绝对路径：${p.outRoot}`);
    assert.equal(p.outRoot, join(tmpCwd, 'rel', 'out'));
    // 归档必须**正好**在 outRoot 底下一层，不许出现 outRoot 套 outRoot
    assert.equal(p.archive, join(p.outRoot, `openmemo-${p.version}-linux-x64.tar.xz`));
    assert.equal(/rel\/out\/.*rel\/out/.test(p.archive), false, `路径套娃了：${p.archive}`);
  });

  check('⑪ 绝对 --out 原样保留', () => {
    const abs = join(tmpCwd, 'abs-out');
    const p = paths(abs, tmpCwd);
    assert.equal(p.outRoot, abs);
    assert.equal(p.stage, join(abs, `openmemo-${p.version}-linux-x64`));
  });

  check('⑫ 含 `..` 的 --out 必须被规范化掉（`..` 留在路径里会跨 cwd 时再解析一次）', () => {
    const p = paths(join('a', 'b', '..', 'c'), tmpCwd);
    assert.equal(p.outRoot, join(tmpCwd, 'a', 'c'));
    assert.equal(p.outRoot.includes('..'), false, `没规范化：${p.outRoot}`);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * ⑬–⑯ `emit-bundles-complete.mjs` —— 「三平台齐全」的正面凭证
 *
 * 它存在的理由：`legs` 允许只跑一条腿，而**被跳过的 job 既不算成功也不算失败，
 * 整个 run 的 `conclusion` 仍然是 `success`**。`[实测 run 31249135458]`
 * 三条腿里两条 skipped，conclusion 照样 success，于是"取最近一次成功的 run"
 * 会取到一个只有 darwin 产物的 run —— 而 Manager 发 release 正是从这里取包的。
 *
 * 判据落在 artifact 上而不是 conclusion 上（PROTOCOL §11：绿灯必须能追溯到
 * 这次 run 真的产出的东西）。这几条钉的是「缺件时**不许**写出凭证」。
 * ═══════════════════════════════════════════════════════════════════════════════════ */
{
  const EMIT = join(REPO_ROOT, 'scripts', 'ci', 'emit-bundles-complete.mjs');
  const meta = (target, version = '0.2.0') => ({
    name: `openmemo-${version}-${target}`,
    version,
    target,
    rawBytes: 123,
    archive: { file: `openmemo-${version}-${target}.tar.xz`, bytes: 45, sha256: 'a'.repeat(64) },
  });
  const emit = (targets, { versions = {} } = {}) => {
    const dir = mkdtempSync(join(WORK, 'complete-'));
    for (const t of targets) {
      const m = meta(t, versions[t] ?? '0.2.0');
      writeFileSync(join(dir, `${m.name}.json`), JSON.stringify(m));
    }
    const out = join(dir, 'out', 'bundles-complete.json');
    const r = spawnSync(process.execPath, [EMIT, '--from', dir, '--out', out], {
      encoding: 'utf8',
    });
    return { ...r, out, combined: `${r.stdout}${r.stderr}` };
  };
  const ALL = ['linux-x64', 'win-x64', 'darwin-arm64'];

  check('⑬ 三平台齐全 → exit 0 并写出凭证（含 sha256）', () => {
    const r = emit(ALL);
    assert.equal(r.status, 0, r.combined);
    const doc = JSON.parse(readFileSync(r.out, 'utf8'));
    assert.equal(doc.version, '0.2.0');
    assert.deepEqual(Object.keys(doc.targets).sort(), [...ALL].sort());
    assert.equal(doc.targets['linux-x64'].sha256.length, 64);
  });

  /*
   * ★ 这一条就是那次事故的形状：只有 macOS 跑了。
   *   判据是**既要红、又要不留下文件** —— 留下一个"部分"的凭证比没有更糟，
   *   因为下游会把它当成"完整"。
   */
  check('⑭ ★ 只有 darwin（复现 run 31249135458）→ exit 1，且**一个字节都不写**', () => {
    const r = emit(['darwin-arm64']);
    assert.equal(r.status, 1, r.combined);
    assert.match(r.combined, /缺 linux-x64, win-x64/);
    assert.match(r.combined, /§11/);
    assert.equal(existsSync(r.out), false, '缺件却写出了凭证');
  });

  check('⑮ 缺一个平台（win 没跑）→ exit 1，且点名缺的是谁', () => {
    const r = emit(['linux-x64', 'darwin-arm64']);
    assert.equal(r.status, 1, r.combined);
    assert.match(r.combined, /缺 win-x64/);
    assert.equal(existsSync(r.out), false);
  });

  /*
   * ★ 版本不一致 = 这些 artifact 不是同一次构建的产物。
   *   拼在一起发出去会得到"版本号相同但内容不同源"的 release —— 事后无法追溯。
   */
  check('⑯ 三平台齐全但版本号不一致 → exit 1（不是同一次构建的产物）', () => {
    const r = emit(ALL, { versions: { 'win-x64': '0.3.0' } });
    assert.equal(r.status, 1, r.combined);
    assert.match(r.combined, /版本号不一致/);
    assert.equal(existsSync(r.out), false);
  });
}

/* ── 收尾 ─────────────────────────────────────────────────────────────────────────── */

console.log('');
if (failures.length > 0) {
  console.log(
    `\x1b[31m✘\x1b[0m selftest-bundle: ${failures.length} 个用例失败（共 ${passed + failures.length} 个）`,
  );
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(
  `\x1b[32m✔\x1b[0m selftest-bundle: ${passed} 个用例全部通过（5 条正向 + 15 条反向 + 3 条 --out 路径）`,
);
