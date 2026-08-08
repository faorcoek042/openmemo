#!/usr/bin/env node
/**
 * **「用户解压完、第一次打开「本机组件」页，到底看到什么」** —— 三平台各答一次。
 *
 * ## 为什么这一步要永久存在
 *
 * `[用户真机 2026-08-08, Windows, v0.3.0]` 解压即运行，「本机组件」页**六个后端全部**报：
 * ```
 * probe did not complete: probe executable not found:
 *   C:\Users\...\AppData\Roaming\OpenMemo\bin\runtime\openmemo-probe.exe
 * ```
 * **CI 从来没撞到过这个环** —— 因为 `e2e-runtime` 那条腿自己调
 * `POST /api/backends/install` 直接指定包 id 去装，**跳过了"探测→推荐"这一步**。
 * 也就是说：产品最常见的第一屏，此前没有任何一条 CI 腿走过。
 *
 * 所以这个脚本刻意**什么都不装**：全新空数据目录 + 刚解压的包 + 直接读
 * 「本机组件」页的数据源 `GET /api/runtime/hardware`，把每个后端的
 * `available / probed / unavailableReason` 原样打出来。
 *
 * ## 判据（会红的那条）
 *
 * **任何后端的 `unavailableReason` 里出现 `probe did not complete`，即失败。**
 * 那句话意味着探针没跑起来 —— 而在一个**自带最小探针运行时**的包里，
 * 它只可能来自"探针没打进去 / 打进去了但跑不起来"，正是用户撞到的那个 bug。
 *
 * 未安装的后端**应该**说 `backend package not installed` —— 那是真话，
 * 而且不吓人。两者的区别就是这次修复的全部内容。
 *
 * ⚠️ 它**不断言"必须探测到 GPU"**：CI runner 通常没有 GPU，那样断言只会训练人忽略它。
 *    判据是"探针跑起来了、答了话"，不是"答案是我想要的"。
 *
 * 用法：node scripts/ci/diagnose-probe-bootstrap.mjs --bundle <包目录> [--port 19795]
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const BUNDLE = arg('--bundle');
const PORT = Number(arg('--port', '19795'));
if (!BUNDLE || !existsSync(BUNDLE)) {
  console.error(`✘ --bundle 必填且必须存在（收到：${BUNDLE ?? '(空)'}）`);
  process.exit(2);
}

const IS_WIN = process.platform === 'win32';
const NODE = join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node');
const MAIN = join(BUNDLE, 'app', 'daemon', 'dist', 'main.js');
const BASE = `http://127.0.0.1:${PORT}`;

const ROOT = await mkdtemp(join(tmpdir(), 'om-probe-boot-'));
const DATA = join(ROOT, 'data');

console.log('\n\x1b[1m用户视角：全新空数据目录 + 刚解压的包，「本机组件」页看到什么\x1b[0m');
console.log(`  包       ${BUNDLE}`);
console.log(`  数据目录 ${DATA}（全新，什么都没装）`);
console.log(`  平台     ${process.platform}/${process.arch}`);

const logs = [];
const proc = spawn(NODE, [MAIN, '--data-dir', DATA, '--port', String(PORT)], {
  cwd: join(BUNDLE, 'app', 'daemon'),
  env: {
    ...process.env,
    OPENMEMO_AUTH: 'none',
    OPENMEMO_DATA_DIR: DATA,
    // PROTOCOL §9：绝不碰机器级指针。模块顶层设定，窗口为零。
    OPENMEMO_POINTER_FILE: join(ROOT, 'pointer.json'),
    OPENMEMO_WEB_DIST: join(BUNDLE, 'app', 'apps', 'web', 'dist'),
    OPENMEMO_EXT_DIR: join(BUNDLE, 'ext'),
    /*
     * ★★ 刻意**既不设 `OPENMEMO_PROBE`、也不设 `OPENMEMO_BUNDLED_PROBE_DIR`**。
     *
     * 这一步是**直接起 daemon**（不经启动器）。此前它预设了后者，于是它验的其实是
     * "环境变量给对了会怎样" —— 而**只有启动器会设那个变量**，
     * 所以"直接起的 daemon 找不到包内探针"这个真实缺陷，它一次都没测到。
     *
     * 现在什么都不设：走的就是 `resolveBundledWhisperDir()` 那条**模块相对**的路。
     * 三个平台每轮都在这个形态下跑一遍 —— 那条规则的覆盖从此靠测试，不靠"应该没问题"。
     */
    OPENMEMO_OPEN_BROWSER: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', (d) => logs.push(String(d)));
proc.stderr.on('data', (d) => logs.push(String(d)));

let ready = false;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  if (proc.exitCode !== null) break;
}
if (!ready) {
  console.error(`✘ daemon 没起来：\n${logs.join('')}`);
  proc.kill('SIGKILL');
  await rm(ROOT, { recursive: true, force: true });
  process.exit(1);
}

const hw = (await (await fetch(`${BASE}/api/runtime/hardware`)).json()).hardware;

console.log('');
console.log(`  CPU  ${hw.cpu?.brand ?? '?'}（${hw.cpu?.logicalCores ?? '?'} 线程）`);
console.log(
  `  GPU  ${hw.gpus?.length ? hw.gpus.map((g) => `${g.vendor ?? '?'} ${g.name ?? ''}`).join(' · ') : '(未检出，runner 上通常如此)'}`,
);
console.log('');
console.log('  后端           available  probed   unavailableReason');
console.log('  ' + '─'.repeat(88));
let broken = 0;
for (const b of hw.backends ?? []) {
  const reason = b.unavailableReason ?? '(无 —— 可用)';
  console.log(
    `  ${String(b.id).padEnd(14)} ${String(b.available).padEnd(10)} ${String(b.probed).padEnd(8)} ${reason}`,
  );
  if (/probe did not complete/i.test(reason)) broken += 1;
}

proc.kill('SIGTERM');
for (let i = 0; i < 40 && proc.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
if (proc.exitCode === null) proc.kill('SIGKILL');
await rm(ROOT, { recursive: true, force: true });

console.log('');
if ((hw.backends ?? []).length === 0) {
  console.error('::error::一个后端都没报 —— 这不是"通过"，是没测到东西');
  process.exit(1);
}
if (broken > 0) {
  console.error(`::error::${broken} 个后端仍然是 "probe did not complete" —— 探针没跑起来。`);
  console.error('::error::这正是用户 2026-08-08 在 Windows v0.3.0 上撞到的那一屏。');
  console.error('::error::包里应当自带 runtime/probe/（探针 + ggml 核心 + 一个 CPU 后端模块）。');
  process.exit(1);
}
console.log('✔ 没有任何后端报 "probe did not complete" —— 探针在包里且真的跑起来了');
console.log('  （未装的后端报 "backend package not installed"，那是真话，也是应有的第一屏）');
