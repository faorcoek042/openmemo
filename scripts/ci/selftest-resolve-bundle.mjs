#!/usr/bin/env node
/**
 * `resolve-bundle.mjs` 的反向验证 —— 挂在 `pnpm test:ci-scripts` 上。
 *
 * ## 为什么这个文件必须存在
 *
 * 被提取的这段脚手架，三次事故的**共同点**是「它只在 CI 上跑过，所以错误一直藏着」。
 * 把三段重复代码合成一段共享代码，如果**它自己仍然只有推上去才知道对不对**，
 * 那只是把三个坑集中成一个更深的坑 —— 从"三条腿各红一次"变成"四条腿一起红"。
 *
 * 所以判据是：**这段脚手架能在本机被逐个坏输入量一遍。**
 *
 * ## 两组，别混着看
 *
 * **A 组「必须绿」——三次真实事故的输入形状。**
 *   那三次都是**假红**：包好好地打出来了，是脚手架自己把步骤带走了。
 *   所以对这三种输入，新脚手架必须**成功**。这是回归测试。
 *
 * **B 组「必须红，且理由要对」——真正的坏输入。**
 *   不只要求它红，还要求**红出正确的那个代码** ——
 *   一个"反正失败了"的错误信息，和没有错误信息差不多。
 *   其中 `MULTIPLE_ARCHIVES` / `MULTIPLE_TOP_DIRS` 是**这次新加的护栏**：
 *   四条腿此前都是 `head -1` / `[0]`，会安静地挑一个然后照常报绿。
 *
 * 跑法：`node scripts/ci/selftest-resolve-bundle.mjs`（无网络、无端口、纯临时目录）
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'resolve-bundle.mjs');

let checked = 0;
let failed = 0;
const ok = (msg) => {
  checked += 1;
  console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
};
const bad = (msg) => {
  checked += 1;
  failed += 1;
  console.log(`  \x1b[31m✘\x1b[0m ${msg}`);
};

/** 造一个「解开之后长得像预编译包」的 tar.gz。 */
function makeBundleArchive(dir, name, { withNode = true, topDirs = 1 } = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'om-rb-stage-'));
  for (let i = 0; i < topDirs; i++) {
    const root = join(stage, `openmemo-0.2.0-linux-x64${i === 0 ? '' : `-extra${i}`}`);
    mkdirSync(join(root, 'app', 'daemon', 'dist'), { recursive: true });
    writeFileSync(join(root, 'app', 'daemon', 'dist', 'main.js'), '// daemon\n');
    if (withNode) {
      mkdirSync(join(root, 'runtime'), { recursive: true });
      writeFileSync(join(root, 'runtime', 'node'), '#!/bin/sh\n');
    }
  }
  const out = join(dir, name);
  const r = spawnSync('tar', ['-czf', out, '-C', stage, '.'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`造归档失败：${r.stderr}`);
  rmSync(stage, { recursive: true, force: true });
  return out;
}

function run(fromDir, outDir, extra = []) {
  const ghOut = join(mkdtempSync(join(tmpdir(), 'om-rb-gh-')), 'out.txt');
  writeFileSync(ghOut, '');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--from', fromDir, '--out', outDir, '--github-output', ghOut, ...extra],
    { encoding: 'utf8', timeout: 120_000 },
  );
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    ghOut: existsSync(ghOut) ? readFileSync(ghOut, 'utf8') : '',
  };
}

const scratch = mkdtempSync(join(tmpdir(), 'om-resolve-bundle-selftest-'));
const fresh = (n) => {
  const d = join(scratch, n);
  mkdirSync(d, { recursive: true });
  return d;
};

console.log('\n\x1b[1mresolve-bundle 反向验证\x1b[0m');

/* ═══ A 组：三次真实事故的输入形状 —— 必须绿 ═══════════════════════════════════ */

console.log('\n\x1b[1mA 组「必须绿」：三次真实事故的输入形状（那三次都是假红）\x1b[0m');

{
  // A1 —— 事故 ①②：三个 glob 里只有一个匹配得到。
  //       旧写法 `ls a b c 2>/dev/null | head -1` 在 set -e 下当场把整步带走。
  const from = fresh('a1-from');
  makeBundleArchive(from, 'openmemo-0.2.0-linux-x64.tar.gz');
  const r = run(from, fresh('a1-out'));
  if (r.status === 0 && /bundle_dir=/.test(r.ghOut)) {
    ok('A1 只有一种扩展名匹配得到（旧写法必炸）→ 成功，且写出了 bundle_dir');
  } else {
    bad(`A1 应当成功，实得 exit ${r.status}\n${r.out.slice(0, 600)}`);
  }
}

{
  // A2 —— 事故 ③：归档旁边还躺着组装用的**暂存目录**。
  //       旧写法 `cp dist/bundles/*` 碰到目录就 exit 1。
  const from = fresh('a2-from');
  makeBundleArchive(from, 'openmemo-0.2.0-linux-x64.tar.gz');
  mkdirSync(join(from, 'openmemo-0.2.0-linux-x64'), { recursive: true }); // 暂存目录
  writeFileSync(join(from, 'openmemo-0.2.0-linux-x64.json'), '{}'); // 清单，不是归档
  const r = run(from, fresh('a2-out'));
  if (r.status === 0) {
    ok('A2 归档旁有暂存目录 + .json 清单（旧写法必炸）→ 成功，只认文件、只认归档扩展名');
  } else {
    bad(`A2 应当成功，实得 exit ${r.status}\n${r.out.slice(0, 600)}`);
  }
}

{
  /*
   * A4 —— **--out 目录还不存在**。
   *
   * 这条是补上来的，因为脚手架第一版就漏了 `mkdirSync(outDir)`：
   * `tar -C <dir>` / `unzip -d <dir>` 都不会替你建目录，只回
   * `Cannot open: No such file or directory` 然后 exit 2。
   * 三条 e2e 腿一起红成 EXTRACT_FAILED（e2e-record run 31250861440、
   * e2e-notes run 31251083538）——正是"把三个坑合成一个更深的坑"那个风险。
   *
   * ⚠️ 而**旧 selftest 抓不住它**：`fresh()` 自己 mkdir 了 out 目录，
   * 夹具比真实调用方宽容，于是那个分支从来没被走到。
   * （与"断言的字段在夹具里恒为假"同一族：**夹具比现实友善**。）
   */
  const from = fresh('a4-from');
  makeBundleArchive(from, 'openmemo-0.2.0-linux-x64.tar.gz');
  const notYet = join(scratch, 'a4-out-does-not-exist', 'nested');
  const r = run(from, notYet);
  if (r.status === 0) ok('A4 --out 目录不存在 → 自己建出来并成功（第一版就是漏了这行）');
  else bad(`A4 应当成功，实得 exit ${r.status}\n${r.out.slice(0, 600)}`);
}

{
  // A3 —— 各腿自己声明"我需要包里有什么"（差异保留在参数里，不是写死）。
  const from = fresh('a3-from');
  makeBundleArchive(from, 'openmemo-0.2.0-linux-x64.tar.gz', { withNode: true });
  const r = run(from, fresh('a3-out'), ['--require', 'app/daemon/dist/main.js,runtime/node']);
  if (r.status === 0) ok('A3 --require 多项齐全 → 成功');
  else bad(`A3 应当成功，实得 exit ${r.status}\n${r.out.slice(0, 600)}`);
}

/* ═══ B 组：真正的坏输入 —— 必须红，且代码要对 ════════════════════════════════ */

console.log('\n\x1b[1mB 组「必须红，且理由要对」：真正的坏输入\x1b[0m');

const mustFail = (name, code, fromDir, outDir, extra = []) => {
  const r = run(fromDir, outDir, extra);
  if (r.status === 0) {
    bad(`${name} 居然成功了 —— 这条护栏是假的`);
    return;
  }
  if (!r.out.includes(code)) {
    bad(`${name} red 了但代码不对：期望 ${code}\n${r.out.slice(0, 400)}`);
    return;
  }
  ok(`${name} → 红，且代码是 ${code}`);
};

{
  const from = fresh('b1-from'); // 空目录
  mustFail('B1 目录里一个归档都没有', 'NO_ARCHIVE', from, fresh('b1-out'));
}

{
  // ★ 新护栏：以前 head -1 会安静地挑一个，绿灯追溯不到验的是谁。
  const from = fresh('b2-from');
  makeBundleArchive(from, 'openmemo-0.2.0-linux-x64.tar.gz');
  makeBundleArchive(from, 'openmemo-0.2.0-win-x64.zip');
  mustFail('B2 两个归档并存（旧写法会随便挑一个）', 'MULTIPLE_ARCHIVES', from, fresh('b2-out'));
}

{
  const from = fresh('b3-from');
  writeFileSync(join(from, 'openmemo-0.2.0-linux-x64.tar.gz'), 'this is not a tarball');
  mustFail('B3 归档是坏的（解不开）', 'EXTRACT_FAILED', from, fresh('b3-out'));
}

{
  // ★ 新护栏：解出两个顶层目录还继续跑，等于拿一个没在验的东西报绿。
  const from = fresh('b4-from');
  makeBundleArchive(from, 'openmemo-0.2.0-linux-x64.tar.gz', { topDirs: 2 });
  mustFail('B4 解出多个顶层目录（旧写法会挑第一个）', 'MULTIPLE_TOP_DIRS', from, fresh('b4-out'));
}

{
  const from = fresh('b5-from');
  makeBundleArchive(from, 'openmemo-0.2.0-linux-x64.tar.gz', { withNode: false });
  mustFail('B5 包里缺 runtime/node（结构不对）', 'MISSING_ENTRIES', from, fresh('b5-out'), [
    '--require',
    'app/daemon/dist/main.js,runtime/node',
  ]);
}

{
  // 归档里没有顶层壳目录：解出来直接是文件。
  const from = fresh('b6-from');
  const stage = mkdtempSync(join(tmpdir(), 'om-rb-flat-'));
  writeFileSync(join(stage, 'loose.txt'), 'x');
  spawnSync('tar', ['-czf', join(from, 'flat.tar.gz'), '-C', stage, 'loose.txt'], {
    timeout: 60_000,
  });
  rmSync(stage, { recursive: true, force: true });
  mustFail('B6 归档里没有顶层目录', 'NO_TOP_DIR', from, fresh('b6-out'));
}

{
  // PROTOCOL §11：「跳过」不许渲染成「成功」——目录压根不存在也必须红。
  mustFail(
    'B7 --from 指向的目录不存在（§11：跳过不许渲染成成功）',
    'NO_ARCHIVE',
    join(scratch, 'b7-does-not-exist'),
    fresh('b7-out'),
  );
}

/* ═══ 收尾 ═══════════════════════════════════════════════════════════════════ */

rmSync(scratch, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.log(`\x1b[31m✘ ${checked - failed} passed, ${failed} failed\x1b[0m`);
  process.exit(1);
}
// 判据用"数到 0 条就红"（build-backends C5 的教训：`for f in <不匹配的 glob>` 检查了零个文件然后报绿）
if (checked < 11) {
  console.log(`\x1b[31m✘ 只跑了 ${checked} 条断言 —— 少于预期，先怀疑这个自检本身瞎了\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✔ ${checked} passed, 0 failed\x1b[0m`);
