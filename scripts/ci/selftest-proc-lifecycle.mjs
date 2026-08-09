#!/usr/bin/env node
/**
 * `launcher-spawn.mjs` 里两个进程/端口生命周期助手的自检。
 *
 * ## 为什么这两条**必须**有测试
 *
 * 它们的失败方式都**长得像成功**：
 *
 * - `assertPortFree` 判错时，症状是"端口看起来是空的" —— 于是腿继续跑，
 *   daemon 起来一 bind 失败、悄悄漂到别的端口，后面的绿灯**追溯不到自己启动的进程**。
 * - `killTree` 少一个负号时，症状是**子进程存活** —— 而"父进程已经退出"在多数环境里
 *   看起来就是收干净了。残留进程要到**下一轮**才发作，那时已经归因不到这里。
 *
 * 两条都是 PROTOCOL §11 点名的那种假通过。**所以每条都配一个对照组**：
 * 先证明"坏实现"确实达不到断言，再证明共享实现达得到 ——
 * 否则断言可能只是恒真（本仓栽过：护栏没变红，因为它问错了问题）。
 *
 * 只操作本脚本自己起的进程与自己占的端口，**绝不 `pkill -f`**（含 `-0`）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertPortFree, killTree, killTreeHard } from './launcher-spawn.mjs';

const IS_WIN = process.platform === 'win32';
let failures = 0;
const ok = (name) => console.log(`  ✔ ${name}`);
const bad = (name, why) => {
  failures += 1;
  console.log(`  ✘ ${name}\n      ${why}`);
};

/** 一个**没人用**的端口：让内核挑，再立刻放掉。 */
async function freePort() {
  return await new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}

const alive = (pid) => {
  // 只对**自己起的** pid 做存在性判断；这是 process.kill(pid, 0)，不是 pkill。
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('① assertPortFree —— 判据是"能不能被我占住"，不是"有没有人答话"');

// ── 1.1 空端口必须放行 ───────────────────────────────────────────────────────
{
  const port = await freePort();
  try {
    await assertPortFree(port, { label: '自检' });
    ok('空端口 → 放行');
  } catch (e) {
    bad('空端口 → 放行', `不该抛却抛了：${e.message}`);
  }
}

// ── 1.2 ★核心★「bind 住但不答 HTTP」的占用者必须被判出 ──────────────────────
{
  const port = await freePort();
  /*
   * 纯 TCP 占用者：占着端口，但永远不回 HTTP。
   * ⚠️ 必须自己记住连接 —— `assertPortFree` 的 HTTP 探测会在这里留下一条
   *   连接池里的活连接，而 `net.Server#close()` 会等所有连接结束
   *   （`closeAllConnections()` 只有 http.Server 才有）。不断开就永远挂住。
   */
  const conns = new Set();
  const squatter = createServer((c) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
  });
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r));

  // 对照组：旧的"只问 HTTP"判据，证明这一格**确实**能骗过它（否则本测试是空的）
  let httpOnlySaysFree = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
  } catch {
    httpOnlySaysFree = true;
  }
  if (!httpOnlySaysFree) {
    bad('对照组：只问 HTTP 应当被骗过', '它没被骗过 —— 那这一格证明不了什么，测试需要重写');
  } else {
    ok('对照组：只问 HTTP 判成"空的"（这正是被收敛掉的那一类的行为）');
  }

  let caught = null;
  try {
    await assertPortFree(port, { label: '自检' });
  } catch (e) {
    caught = e;
  }
  if (caught === null) {
    bad(
      '★ 共享实现必须判出「bind 住但不答 HTTP」的占用者',
      '它放行了 —— 这正是残留进程正在关闭时的样子，放行 = §11 的假通过',
    );
  } else if (caught.code !== 'PORT_IN_USE') {
    bad('★ 判出占用者', `抛了但 code 不对：${caught.code}`);
  } else {
    ok('★ 共享实现判出占用者（EADDRINUSE），且 code=PORT_IN_USE');
  }
  /*
   * ⚠️ `assertPortFree` 的 HTTP 探测会在这个占用者上留下一条**连接池里的活连接**，
   *   而 `server.close()` 会等所有连接结束 —— 不显式断开就会永远挂在这里
   *   （第一版就是这么挂的：`unsettled top-level await`）。
   */
  for (const c of conns) c.destroy();
  await new Promise((r) => squatter.close(r));
}

console.log('② killTree —— 收的是整棵树，不是组长一个');

/** 起一棵"父 + 子"进程树，返回 {parentPid, kidPid, cleanup}。 */
async function spawnTree() {
  const dir = mkdtempSync(join(tmpdir(), 'proclife-'));
  const parentJs = join(dir, 'parent.mjs');
  writeFileSync(
    parentJs,
    `import { spawn } from 'node:child_process';\n` +
      `const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });\n` +
      `console.log('KID=' + kid.pid);\n` +
      `setInterval(() => {}, 1e9);\n`,
  );
  const proc = spawn(process.execPath, [parentJs], {
    stdio: ['ignore', 'pipe', 'ignore'],
    // 与 spawnViaLauncher / 各腿一致：POSIX 上单独成组，收尾按组收
    ...(IS_WIN ? {} : { detached: true }),
  });
  const kidPid = await new Promise((r) => {
    proc.stdout.on('data', (d) => {
      const m = /KID=(\d+)/.exec(String(d));
      if (m) r(Number(m[1]));
    });
  });
  await sleep(250);
  return {
    parentPid: proc.pid,
    kidPid,
    cleanup: () => {
      killTreeHard(proc.pid);
      try {
        process.kill(kidPid, 'SIGKILL');
      } catch {
        /* 已经没了 */
      }
    },
  };
}

// ── 2.1 对照组：少负号的那份**必须**留下子进程（否则 2.2 是恒真的）────────────
if (IS_WIN) {
  console.log('  · 对照组在 Windows 上跳过：那里靠 taskkill /T，没有"负号"这个自由度');
} else {
  const t = await spawnTree();
  // 这就是 e2e-runtime-audit.mjs 修复前的那一行：没有负号
  try {
    process.kill(t.parentPid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  await sleep(600);
  const kidStillAlive = alive(t.kidPid);
  if (kidStillAlive) {
    ok('对照组：少负号 → 子进程存活（症状看起来像"收干净了"，正是它难被发现的原因）');
  } else {
    bad('对照组：少负号应当留下子进程', '它没留下 —— 那 2.2 那条断言可能是恒真的，本测试需要重写');
  }
  t.cleanup();
}

// ── 2.2 ★核心★ 共享 killTree 必须把子进程一起带走 ───────────────────────────
{
  const t = await spawnTree();
  killTree(t.parentPid); // SIGTERM 档
  await sleep(600);
  if (alive(t.kidPid)) killTreeHard(t.parentPid); // 允许升级到 SIGKILL 档
  await sleep(600);

  const parentAlive = alive(t.parentPid);
  const kidAlive = alive(t.kidPid);
  if (kidAlive) {
    bad(
      '★ 共享 killTree 必须把整棵树带走',
      `子进程 ${t.kidPid} 仍然活着 —— 残留进程会让下一轮拿到追溯不到自己的绿灯（§11）`,
    );
  } else if (parentAlive) {
    bad('★ 共享 killTree 必须把整棵树带走', `父进程 ${t.parentPid} 仍然活着`);
  } else {
    ok('★ 共享 killTree：父与子都已收掉');
  }
  t.cleanup();
}

// ── 2.3 两档不许被压成一个：killTree 与 killTreeHard 必须都存在且可调用 ──────
{
  const two = typeof killTree === 'function' && typeof killTreeHard === 'function';
  if (two) ok('killTree(SIGTERM) 与 killTreeHard(SIGKILL) 两档并存（刻意的升级顺序，不许合并）');
  else bad('两档并存', '有一档不见了 —— "先温和后强硬"是刻意的，不是冗余');
}

console.log('');
if (failures > 0) {
  console.error(`✘ selftest-proc-lifecycle：${failures} 条不通过`);
  process.exit(1);
}
console.log('✔ selftest-proc-lifecycle 全部通过');
