#!/usr/bin/env node
/**
 * 升级安全性：**装新版包不能弄坏已有的数据目录。**
 *
 * ## 为什么这条需要一个测试，而不是一句声明
 *
 * D-17 §6 的论证是「包里根本没有数据目录，所以天然安全」。论证是对的，
 * 但它是**结构性论断** —— 而本仓吃过的亏恰恰是"结构上应该没问题"的东西
 * （`%APPDATA%` vs `%LOCALAPPDATA%`、`libsimple.dll` vs `simple.dll`、
 * `'CPU' !== 'cpu'`）。Manager 2026-08-08 的要求是「要有测试或实测证据，不是声明」。
 *
 * ## 它验的性质
 *
 * > **由一个「已经不存在了」的安装写下的数据，必须能被另一个装在别的路径上的安装读出来。**
 *
 * 这个说法比"升级不丢数据"更严：它同时排除了
 *   · 数据库/配置被写进了安装目录（那样删掉旧目录就没了）
 *   · 数据目录里存了指向旧安装目录的绝对路径（那样旧目录一删就断）
 *   · 新安装启动时"重建一个空的"而不是复用（那种情况下**用户界面上看不出区别** ——
 *     笔记全没了，但程序一切正常，这正是本仓最贵的那类失败）
 *
 * ## 做法
 *
 *   ① 把包复制成 `install-v1`（旧版），用它启动、写一条真数据、停掉
 *   ② **删掉整个 `install-v1`** —— 真的模拟"用户把旧目录删了"
 *   ③ 用**原始包目录**（另一个路径）当"新版"，指向**同一个数据目录**启动
 *   ④ 断言：那条数据还在、dataDir 没变、扩展仍然加载、数据库没被重建
 *
 * 全程用 `OPENMEMO_POINTER_FILE` + `OPENMEMO_DATA_DIR` 指向临时目录 ——
 * PROTOCOL §9：机器级指针一个字节都不许碰，而且是**模块顶层设定，窗口为零**，
 * 不是"跑完记得还原"（§9-bis：被 kill -9 也不能留下坏状态）。
 *
 * 用法：node scripts/ci/verify-bundle-upgrade.mjs --bundle <包目录> [--port 19790]
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const BUNDLE = arg('--bundle');
const PORT = Number(arg('--port', '19790'));
if (!BUNDLE || !existsSync(BUNDLE)) {
  console.error(`✘ --bundle 必填且必须存在（收到：${BUNDLE ?? '(空)'}）`);
  process.exit(2);
}

const IS_WIN = process.platform === 'win32';
const BASE = `http://127.0.0.1:${PORT}`;

let checked = 0;
let failed = 0;
function ok(msg) {
  checked++;
  console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
}
function bad(msg) {
  checked++;
  failed++;
  console.log(`  \x1b[31m✘\x1b[0m ${msg}`);
}
function hdr(msg) {
  console.log(`\n\x1b[1m── ${msg}\x1b[0m`);
}

const ROOT = await mkdtemp(join(tmpdir(), 'om-upgrade-'));
const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
/** 默认位置的机器级指针 —— 全程必须**一个字节都不被写**。 */
const FORBIDDEN_POINTER = join(
  process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/nonexistent',
  '.local',
  'share',
  'openmemo',
  'datadir.json',
);
const forbiddenBefore = existsSync(FORBIDDEN_POINTER)
  ? await stat(FORBIDDEN_POINTER).then((s) => `${s.size}@${s.mtimeMs}`)
  : '(不存在)';

async function startDaemon(installDir, label) {
  const main = join(installDir, 'app', 'daemon', 'dist', 'main.js');
  const node = join(installDir, 'runtime', IS_WIN ? 'node.exe' : 'node');
  const logs = [];
  const proc = spawn(node, [main, '--data-dir', DATA_DIR, '--port', String(PORT)], {
    cwd: join(installDir, 'app', 'daemon'),
    env: {
      ...process.env,
      OPENMEMO_AUTH: 'none',
      OPENMEMO_DATA_DIR: DATA_DIR,
      OPENMEMO_POINTER_FILE: POINTER,
      OPENMEMO_WEB_DIST: join(installDir, 'app', 'apps', 'web', 'dist'),
      OPENMEMO_EXT_DIR: join(installDir, 'ext'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  /*
   * ★★ 就绪判据是 `GET /api/folders` 能应答，**不是** `/api/health`。
   *
   * `[CI 实测 2026-08-08 run 31205369931, windows-2025]` 第一版等的是 `/api/health`，
   * 结果 Windows 腿红在：
   *     ✘ 建文件夹失败 HTTP 404：{"code":"NOT_FOUND","message":"no route for POST /api/folders"}
   * 而**同一份代码在 Linux 上是绿的**。
   *
   * 成因不是 Windows 特有的 bug，是一个**真实存在的窗口**被慢一点的机器撞上了：
   *   · `/api/health` 由 `apps/daemon/src/http/server.ts:122` **直接**应答，
   *     不经过路由表；
   *   · 而业务路由是 `main.ts:844` 的 `routers.push(...)`，发生在 server 建好**之后**。
   * 于是「health 说 ok」与「路由表装完了」之间有一段真空。
   * （`server.ts:39` 的注释里已经记着单实例探测撞过同一个窗口 —— 它一直在那儿。）
   *
   * 对本脚本而言正确的修法是**把就绪判据换成一个真业务路由**：
   * 等到 `/api/folders` 不再是 404，路由表就一定装完了。
   * 靠 sleep 猜一个更长的时间是不行的 —— 那只是把同一个竞态推给更慢的机器。
   *
   * ⚠️ 这个窗口本身**没有被修**（那是 daemon 的事，不在本脚本职权内），已升级给 Manager。
   */
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/folders`);
      if (res.ok) {
        console.log(`   ${label} 已就绪（/api/folders 可应答 —— 路由表装完了，不只是 health）`);
        return { proc, logs };
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  console.error(`✘ ${label} 启动失败：\n${logs.join('')}`);
  process.exit(1);
}

async function stopDaemon(h, label) {
  h.proc.kill('SIGTERM');
  for (let i = 0; i < 40 && h.proc.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (h.proc.exitCode === null) h.proc.kill('SIGKILL');
  console.log(`   ${label} 已停止`);
}

try {
  console.log(`\n\x1b[1m预编译包升级安全性验证\x1b[0m`);
  console.log(`  包       ${BUNDLE}`);
  console.log(`  数据目录 ${DATA_DIR}`);
  console.log(`  指针     ${POINTER}（**不是**机器级的那个）`);

  /* ───────────────── ① 旧版安装，写一条真数据 ───────────────── */
  hdr('① 旧版安装（install-v1）写入真数据');
  const V1 = join(ROOT, 'install-v1');
  await cp(BUNDLE, V1, { recursive: true });
  const h1 = await startDaemon(V1, 'install-v1');

  const folderName = `升级前建的文件夹-${Date.now()}`;
  const mk = await fetch(`${BASE}/api/folders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: folderName }),
  });
  if (!mk.ok) {
    console.error(`✘ 建文件夹失败 HTTP ${mk.status}：${await mk.text()}`);
    process.exit(1);
  }
  ok(`旧版写入了一条真数据：「${folderName}」`);

  const dd1 = await (await fetch(`${BASE}/api/settings/data-dir`)).json();
  const health1 = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`   旧版报告 dataDir = ${health1.dataDir}`);

  // 数据库文件必须落在**数据目录**里，不在安装目录里 —— 这是整条性质的地基
  const dbPath = join(DATA_DIR, 'openmemo.db');
  if (existsSync(dbPath)) {
    ok(`数据库在数据目录里：${dbPath}（${(await stat(dbPath)).size} B）`);
  } else {
    const inData = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.db'));
    if (inData.length > 0) ok(`数据库在数据目录里：${inData.join(', ')}`);
    else bad(`数据目录里找不到 .db 文件 —— 它被写到哪去了？`);
  }
  await stopDaemon(h1, 'install-v1');

  /* ───────────────── ② 真的删掉旧安装 ───────────────── */
  hdr('② 删掉整个 install-v1（模拟"用户把旧目录删了"）');
  await rm(V1, { recursive: true, force: true });
  if (existsSync(V1)) bad('install-v1 没删掉，后面的结论不成立');
  else ok('install-v1 已彻底删除');

  /* ───────────────── ③ 新版安装（另一个路径）指向同一数据目录 ───────────────── */
  hdr('③ 新版安装（不同路径）指向同一个数据目录');
  const h2 = await startDaemon(BUNDLE, 'install-v2');

  const health2 = await (await fetch(`${BASE}/api/health`)).json();
  const dd2 = await (await fetch(`${BASE}/api/settings/data-dir`)).json();
  const folders = await (await fetch(`${BASE}/api/folders`)).json();

  const list = Array.isArray(folders) ? folders : (folders.folders ?? folders.items ?? []);
  const found = JSON.stringify(list).includes(folderName);

  if (found) ok(`★ 旧版写的数据被新版读到了：「${folderName}」`);
  else bad(`★ 旧版写的数据不见了 —— 升级弄坏了数据目录。新版读到：${JSON.stringify(list).slice(0, 300)}`);

  if (health2.dataDir === health1.dataDir) ok(`dataDir 没变：${health2.dataDir}`);
  else bad(`dataDir 变了：${health1.dataDir} → ${health2.dataDir}`);

  /*
   * ★ 只比 `dataDir` 这一个字段，**不要整个 payload 对比**。
   *
   *   第一版比的是整个响应，于是它红了 —— 而红的原因是
   *   `usage.bytes` 与 `entries[].bytes` 从 4096 变成了 430080：
   *   **数据库在第一次启动时把 schema 建起来了，本来就该变大。**
   *   那不是"数据目录被弄坏了"，恰恰是它在正常工作。
   *
   *   把一个会合法变化的量写进恒等断言，得到的是一条**必然会红的守卫** ——
   *   而必然会红的守卫训练所有人忽略它（cold-start-audit 的对照组注释里
   *   有一模一样的教训）。要比的是**路径**，那才是"升级没把数据目录带偏"的判据。
   */
  if (dd1.dataDir === dd2.dataDir) {
    ok(`/api/settings/data-dir 的 dataDir 前后一致：${dd2.dataDir}`);
  } else {
    bad(`/api/settings/data-dir 的 dataDir 变了：${dd1.dataDir} → ${dd2.dataDir}`);
  }

  // 数据库只会长大或持平，绝不该"缩回初始大小"——那等于被重建了一个空的。
  const b1 = dd1.entries?.find((e) => e.name === 'openmemo.db')?.bytes ?? 0;
  const b2 = dd2.entries?.find((e) => e.name === 'openmemo.db')?.bytes ?? 0;
  if (b2 >= b1) ok(`数据库没有被重建：${b1} B → ${b2} B（只会长大或持平）`);
  else bad(`数据库缩小了：${b1} B → ${b2} B —— 极可能是被重建成空库了`);

  /*
   * 扩展必须仍然是**新包里的那份**在工作。
   * 这一条单独存在，是因为 `materializeSqliteExtensions` 会把下载来的扩展
   * 链进 extDir —— 如果它把旧安装目录里的路径写进了数据目录，
   * 旧目录一删就成了断链，而**断链的表现是中文搜索静默返回 0 条，不报错**。
   */
  const log2 = h2.logs.join('');
  const m = log2.match(/tokenizer=(\w+)\s+vec=(\w+)/);
  if (m && m[1] === 'simple') ok(`扩展仍然可用：tokenizer=${m[1]} vec=${m[2]}（旧安装已删除）`);
  else if (m) bad(`扩展降级了：tokenizer=${m[1]} vec=${m[2]} —— 中文两字词搜索会静默返回 0 条`);
  else bad(`启动日志里没有 tokenizer=… 那一行，无法判断扩展状态`);

  await stopDaemon(h2, 'install-v2');

  /* ───────────────── ④ 机器级指针全程未被触碰 ───────────────── */
  hdr('④ PROTOCOL §9：机器级指针全程未被写');
  const forbiddenAfter = existsSync(FORBIDDEN_POINTER)
    ? await stat(FORBIDDEN_POINTER).then((s) => `${s.size}@${s.mtimeMs}`)
    : '(不存在)';
  if (forbiddenBefore === forbiddenAfter) ok(`${FORBIDDEN_POINTER} 未被改动（${forbiddenAfter}）`);
  else bad(`机器级指针被改了：${forbiddenBefore} → ${forbiddenAfter}`);

  if (existsSync(POINTER)) ok(`本次用的是隔离指针 ${POINTER}`);
  else ok(`本次没有写任何指针（OPENMEMO_DATA_DIR 直接给定，指针根本没被用到）`);
} finally {
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n─────────────────────────────────────────────`);
console.log(`检查了 ${checked} 条，失败 ${failed} 条`);
if (checked < 7) {
  console.error(`::error::只检查了 ${checked} 条 —— 断言集被意外缩小了，这不是通过`);
  process.exit(1);
}
if (failed > 0) {
  console.error(`::error::${failed} 条失败 —— 升级会弄坏用户的数据目录`);
  process.exit(1);
}
console.log('✔ 升级不会弄坏已有数据目录');
