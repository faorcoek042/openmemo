#!/usr/bin/env node
/**
 * cold-start-audit.mjs — 在**干净 runner** 上真跑一次冷启动，回答
 * 「这些依赖到底是产品自己下的，还是白嫖了宿主机器上现成的？」
 *
 * ## 为什么必须在 CI 上跑
 *
 * 开发机上跑这个脚本没有意义：那台机器已经装好了一切，而它正是不该信的那台
 * （今天至少四次"能跑"靠的是它的历史沉积）。**只有干净 runner 的输出算证据。**
 *
 * ## 三分类，直接用产品自己的判据
 *
 * 好消息是这个分类**产品里已经有了**，不需要我另发明一套 ——
 * `packages/runtime/src/selfcheck.ts:390-434`：
 *
 *   · 找到了，且路径在 storeRoot 底下  → `ok`    = **产品自己下载并校验的**
 *   · 找到了，但不在 storeRoot 底下    → `warn`  = **借的宿主 PATH**
 *                                       detail 明写「来自系统 PATH，非本产品安装
 *                                       —— 用户机器上不一定有」
 *   · 没找到                            → `fail`（required 时）/ `warn`
 *
 * 所以本脚本不做判断，只做三件事：**把宿主的干扰摘干净、真跑一次、把结果摊开。**
 *
 * ## ★ 屏蔽宿主工具（这一步不能省）
 *
 * GitHub 的 ubuntu runner **自带 ffmpeg**。不屏蔽的话，产品会在 PATH 上找到它，
 * 于是「装上了」和「借到了」在最终效果上长得一模一样 —— 正是要查的那个形状。
 *
 * 屏蔽方式是**放一层同名的假二进制在 PATH 最前面**，而不是把目录从 PATH 里删掉：
 *   · 删目录会顺手把 node/pnpm 也删没
 *   · 假二进制能通过 `access(X_OK)`，所以「产品会不会去借」这个行为**照常发生**，
 *     只是借到的东西一执行就带着醒目标记失败 —— **借用变得可见，而不是被消除**
 *
 * ## 安全边界（PROTOCOL §9）
 *
 * `OPENMEMO_POINTER_FILE` 一定被重定向到临时目录：这个脚本**绝不写**
 * `~/.local/share/openmemo/datadir.json`。端口用 19700 段，避开 :10000 与 17650。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', '19700'));
const ROOT = arg('--root', join(tmpdir(), `openmemo-coldstart-${process.pid}`));
const MASK = !argv.includes('--no-mask');

const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
const MASK_BIN = join(ROOT, 'maskbin');
const BASE = `http://127.0.0.1:${PORT}`;

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

/* ─────────────────── 0. 宿主基线：这台 runner 上本来就有什么 ───────────────────── */

hdr('0. 宿主基线（屏蔽之前）—— 这些就是"不屏蔽就会被悄悄借走"的东西');
const HOST_TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp', 'youtube-dl', 'whisper-cli', 'sqlite3', 'python3'];
const hostBaseline = {};
for (const t of HOST_TOOLS) {
  const w = spawnSync('sh', ['-c', `command -v ${t} || true`], { encoding: 'utf8' });
  const p = (w.stdout || '').trim();
  hostBaseline[t] = p || null;
  say(`   ${t.padEnd(14)} ${p || '(不在 PATH 上)'}`);
}

/* ────────────────────────── 1. 屏蔽宿主同名工具 ────────────────────────────────── */

let PATH_FOR_DAEMON = process.env.PATH ?? '';
if (MASK) {
  hdr('1. 屏蔽宿主工具（在 PATH 最前面放同名假二进制）');
  mkdirSync(MASK_BIN, { recursive: true });
  for (const t of HOST_TOOLS) {
    const shim = join(MASK_BIN, t);
    writeFileSync(
      shim,
      `#!/bin/sh\necho "COLD-START-AUDIT: host '${t}' was invoked — this is a MASKED shim, not a real tool" >&2\nexit 127\n`,
    );
    chmodSync(shim, 0o755);
  }
  PATH_FOR_DAEMON = `${MASK_BIN}:${PATH_FOR_DAEMON}`;
  say(`   已屏蔽 ${HOST_TOOLS.length} 个名字，shim 目录：${MASK_BIN}`);
  say('   ⚠️ shim 能通过 access(X_OK)，所以"产品会不会去借"这个行为照常发生 ——');
  say('      借到的东西一执行就带 COLD-START-AUDIT 标记失败。**借用变可见，不是被消除。**');
} else {
  hdr('1. 未屏蔽宿主工具（--no-mask）—— 这一轮的"能用"不能当证据');
}

/* ─────────────────────────── 2. 启动 daemon（冷） ──────────────────────────────── */

const DAEMON = join(REPO, 'apps', 'daemon', 'dist', 'main.js');
if (!existsSync(DAEMON)) {
  console.error(`✘ 找不到 ${DAEMON} —— 先跑 pnpm build:safe`);
  process.exit(2);
}

const childEnv = {
  ...process.env,
  PATH: PATH_FOR_DAEMON,
  OPENMEMO_AUTH: 'none',
  OPENMEMO_DATA_DIR: DATA_DIR,
  // ★ PROTOCOL §9：绝不碰全局指针。模块级设定，窗口为零。
  OPENMEMO_POINTER_FILE: POINTER,
};

let proc = null;
async function startDaemon(label) {
  const logs = [];
  proc = spawn(process.execPath, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        say(`   [${label}] daemon 起来了（${(i + 1) * 0.5}s）`);
        return logs;
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  say(`   [${label}] ✘ daemon 没起来。它的输出：`);
  say(logs.join('').split('\n').map((l) => `      ${l}`).join('\n'));
  throw new Error('daemon did not start');
}
async function stopDaemon() {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  if (proc.exitCode === null) proc.kill('SIGKILL');
  proc = null;
}

const j = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};

function extLine(tag, health) {
  const e = health?.db?.extensions ?? {};
  say(`   [${tag}] tokenizer=${e.tokenizer}  libsimple=${e.libsimple}  sqliteVec=${e.sqliteVec}`);
  const f = e.failures ?? {};
  for (const [k, v] of Object.entries(f)) say(`        failures.${k}: ${String(v).slice(0, 150)}`);
}

let exitCode = 0;
try {
  hdr('2. 冷启动（全新数据目录，什么都没装）');
  const bootLogs = await startDaemon('cold');
  const h0 = await j('/api/health');
  extLine('cold', h0.body);
  const bootLine = bootLogs.join('').split('\n').find((l) => l.includes('tokenizer='));
  if (bootLine) say(`   启动日志里的那一行：${bootLine.trim()}`);

  /* ──────────────────── 3. 目录里"适用于本机"的包，逐个装 ─────────────────────── */

  hdr('3. 逐个安装目录里判定为「适用于本机」的包（真下载、真校验）');
  const cat = await j('/api/backends/catalog');
  const packs = cat.body?.packs ?? cat.body?.items ?? [];
  const applicable = packs.filter((p) => p.applicable === true);
  say(`   目录共 ${packs.length} 个包，适用于本机 ${applicable.length} 个：`);
  for (const p of applicable) say(`     - ${p.id}`);
  say();

  const installResults = [];
  for (const p of applicable) {
    const t0 = Date.now();
    const r = await j('/api/backends/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    let status = `HTTP ${r.status}`;
    const jobId = r.body?.jobId ?? r.body?.id;
    if (jobId) {
      for (let i = 0; i < 600; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const jr = await j(`/api/jobs?id=${encodeURIComponent(jobId)}`);
        const arr = Array.isArray(jr.body) ? jr.body : (jr.body?.jobs ?? []);
        const job = arr.find?.((x) => x.id === jobId) ?? arr[0];
        if (job && ['succeeded', 'failed', 'cancelled', 'error'].includes(job.state ?? job.status)) {
          status = `${job.state ?? job.status}${job.error ? ` — ${JSON.stringify(job.error).slice(0, 200)}` : ''}`;
          break;
        }
      }
    }
    installResults.push({ id: p.id, status, secs: ((Date.now() - t0) / 1000).toFixed(1) });
    say(`   ${p.id.padEnd(32)} ${status}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  /* ─────────── 4. 重启（materializeSqliteExtensions 只在启动时跑）─────────────── */

  hdr('4. 重启 daemon —— 必须的一步，不是保险起见');
  say('   apps/daemon/src/main.ts:466 的 materializeSqliteExtensions() 只在**启动时**跑。');
  say('   装完不重启，扩展不会被链进 bin/ext，tokenizer 仍然是 trigram。');
  await stopDaemon();
  await startDaemon('warm');
  const h1 = await j('/api/health');
  extLine('warm', h1.body);

  /* ───────────────── 5. selfcheck：问"功能好不好使"而不是"文件在不在" ─────────── */

  hdr('5. selfcheck —— 判据是「中文双字词真的搜得到」，不是「文件下下来了」');
  const sc = spawnSync(
    process.execPath,
    [join(REPO, 'scripts', 'selfcheck.mjs'), '--data-dir', DATA_DIR, '--daemon', BASE, '--json'],
    { env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  let report = null;
  try {
    report = JSON.parse(sc.stdout);
  } catch {
    say('   ✘ selfcheck 的 JSON 解析不了，原样输出：');
    say((sc.stdout || '').slice(0, 4000));
    say((sc.stderr || '').slice(0, 4000));
  }

  if (report) {
    const checks = report.checks ?? report.results ?? [];
    say(`   selfcheck exit=${sc.status}  共 ${checks.length} 项`);
    say();
    say('   id                                 status  required  detail');
    say('   ' + '-'.repeat(88));
    for (const c of checks) {
      say(
        `   ${String(c.id).padEnd(34)} ${String(c.status).padEnd(7)} ${String(c.required ?? '').padEnd(9)} ${String(c.detail ?? c.message ?? '').replace(/\s+/g, ' ').slice(0, 100)}`,
      );
    }

    /* ── 6. 三分类表 —— 用产品自己的判据，不另发明 ── */
    hdr('6. ★ 三分类：产品自己下的 / 借宿主的 / 装不上');
    const tools = checks.filter((c) => String(c.id).startsWith('tool.'));
    const own = tools.filter((c) => c.status === 'ok');
    const borrowed = tools.filter((c) => c.status === 'warn' && /PATH/i.test(String(c.detail ?? '')));
    const missing = tools.filter((c) => c.status === 'fail' || (c.status === 'warn' && !/PATH/i.test(String(c.detail ?? ''))));
    say(`   ✅ 产品自己下载并校验的 (${own.length})：      ${own.map((c) => c.id).join(', ') || '(无)'}`);
    say(`   ⚠️ 借宿主 PATH 的       (${borrowed.length})：      ${borrowed.map((c) => c.id).join(', ') || '(无)'}`);
    say(`   ❌ 装不上/不可用        (${missing.length})：      ${missing.map((c) => c.id).join(', ') || '(无)'}`);
    say();
    const cn = checks.find((c) => c.id === 'ext.chineseSearch');
    if (cn) {
      say(`   ★ ext.chineseSearch = ${cn.status}（required=${cn.required}）`);
      say(`     ${String(cn.detail ?? cn.message ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      say('     ← 这一条才是「libsimple 真的装上了」的判据。');
      say('       T-093 的事故形态是：7 个包全 succeeded、sha256 全过，而这里是 fail。');
    } else {
      say('   ⚠️ 报告里没有 ext.chineseSearch 这一项 —— 判据本身不见了，这比它红更值得查。');
    }
    if (sc.status !== 0) exitCode = 1;
  } else {
    exitCode = 1;
  }
} catch (e) {
  say('');
  say(`✘ 冷启动审计中断：${e.message}`);
  exitCode = 1;
} finally {
  await stopDaemon();
  hdr('清理');
  say(`   指针文件用的是 ${POINTER}（不是全局的那个）—— 按 PROTOCOL §9。`);
  say(`   数据目录 ${DATA_DIR} 留在 runner 上，随 runner 一起销毁。`);
}

process.exit(exitCode);
