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
 * ⚠️ **更正一条我自己写错的前提**：我原本断言「GitHub 的 ubuntu runner 自带 ffmpeg」。
 *    第一次真跑的宿主基线把它证伪了 —— ubuntu-24.04 上
 *    `ffmpeg / ffprobe / yt-dlp / whisper-cli` **全部不在 PATH 上**，
 *    自带的只有 `sqlite3` / `python3` / `cmake`。
 *    （这条本身也是个好消息：ubuntu runner 上的"能用"不会被宿主 ffmpeg 冒名顶替。）
 *
 * 屏蔽这一步**仍然要做**，理由变了但没消失：
 *   · 结论不能建立在"这一款 runner 镜像今天恰好没装 ffmpeg"上 —— 那又是一次
 *     "靠机器状态成立的正确"，正是本任务在查的东西；
 *   · macOS runner 自带的东西和 ubuntu 不一样，将来矩阵铺开就会碰上；
 *   · 用户的机器上很可能**是有** ffmpeg 的，屏蔽这一轮才对得上"干净机器"这个问题。
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
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, accessSync, copyFileSync, statSync, constants as fsConstants } from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
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
/*
 * ★ T-146 `--transcribe`：**可行性证明**，不是性能测试。
 *
 * 用户 2026-08-06 的指示：「实测速度不重要，对于 CI 来说重要的是验证可行性」。
 * 但"可行性"的下限**不能是"文件下下来了"** —— 这个项目已经栽过：
 *   · macOS 打出过 1.4 MB、零个 ggml 后端模块、**却报告成功**的包；
 *   · 7 个包全 `succeeded`、sha256 全过，而 daemon 起来是 `tokenizer=trigram vec=off`。
 * 所以这一步走**产品真实路径**（`POST /api/notes/import` → transcribe job →
 * `GET /api/notes/:uid/transcript`），判据是**拿到非空文本**。这是存在性证明。
 *
 * 默认关闭：它要多下一个 ASR 模型并真跑一次推理，而这个脚本在同一个 job 里跑两遍
 * （屏蔽组 + 对照组）。workflow 只在屏蔽组那一遍打开它。
 */
const TRANSCRIBE = argv.includes('--transcribe');

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

/*
 * ★ T-145：自己实现 which，**不要 shell 出去**。
 *   第一版写的是 `spawnSync('sh', ['-c', 'command -v X'])` —— 在 ubuntu 上没问题，
 *   但这个脚本现在要跑在 Windows runner 上，而那里 `sh` 是 Git Bash 的、
 *   `command -v` 看到的 PATH 与 Node 看到的不完全是一回事。
 *   纯 Node 实现顺便把 PATHEXT（Windows 上 .exe/.cmd/.bat）也处理对。
 */
const IS_WIN = process.platform === 'win32';
const PATHEXT = IS_WIN ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
function which(tool, pathStr = process.env.PATH ?? '') {
  for (const dir of pathStr.split(delimiter).filter(Boolean)) {
    for (const ext of PATHEXT) {
      const full = join(dir, tool + ext);
      try {
        accessSync(full, fsConstants.X_OK);
        return full;
      } catch {
        /* 下一个 */
      }
    }
  }
  return null;
}

const hostBaseline = {};
for (const t of HOST_TOOLS) {
  const p = which(t);
  hostBaseline[t] = p;
  say(`   ${t.padEnd(14)} ${p || '(不在 PATH 上)'}`);
}

/* ────────────────────────── 1. 屏蔽宿主同名工具 ────────────────────────────────── */

let PATH_FOR_DAEMON = process.env.PATH ?? '';
if (MASK) {
  hdr('1. 屏蔽宿主工具（在 PATH 最前面放同名假二进制）');
  mkdirSync(MASK_BIN, { recursive: true });
  for (const t of HOST_TOOLS) {
    if (IS_WIN) {
      /*
       * ★ Windows 上一个 `#!/bin/sh` 的无扩展名文件**不是可执行文件** ——
       *   加载器按 PATHEXT 找 .COM/.EXE/.BAT/.CMD。写 .cmd 才真的挡得住。
       *   两个名字都写：`.cmd` 用于 PATH 查找，无扩展名那个用于
       *   任何走 Git Bash 的路径。
       */
      writeFileSync(
        join(MASK_BIN, `${t}.cmd`),
        `@echo off\r\necho COLD-START-AUDIT: host '${t}' was invoked - MASKED shim, not a real tool 1>&2\r\nexit /b 127\r\n`,
      );
    }
    const shim = join(MASK_BIN, t);
    writeFileSync(
      shim,
      `#!/bin/sh\necho "COLD-START-AUDIT: host '${t}' was invoked — this is a MASKED shim, not a real tool" >&2\nexit 127\n`,
    );
    try {
      chmodSync(shim, 0o755);
    } catch {
      /* Windows 上 chmod 是空操作，失败也无所谓 */
    }
  }
  PATH_FOR_DAEMON = `${MASK_BIN}${delimiter}${PATH_FOR_DAEMON}`;
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
let daemonLogs = [];
async function startDaemon(label) {
  const logs = [];
  daemonLogs = logs;
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

/*
 * ★ T-145：带重试。第二轮真跑里出现过 `fetch failed`，而 daemon **是活着的**
 *   （exitCode=null，日志停在「就绪 http://127.0.0.1:19700/」）——
 *   典型的 Node 全局 fetch keep-alive socket 被对端回收后复用。
 *   这里重试的是**我这个客户端的脆弱**，不是在掩盖产品的失败：
 *   连续 5 次都失败仍然会抛出去。
 */
const j = async (path, init) => {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, init);
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw new Error(`${path}: ${lastErr?.message ?? 'fetch failed'}（已重试 5 次）`);
};

/*
 * ★★ T-145：等一个 job 到终态。**这个小函数被改了三次，每次都是同一类错。**
 *
 *   第 1 版：打 `GET /api/jobs?id=<id>`（该端点不认 ?id=，返回整份列表），
 *            取 job 写成 `arr.find(...) ?? arr[0]` —— `?? arr[0]` 让它
 *            **拿别人的 succeeded 顶上**：119 MB 的下载报 `succeeded (1.0s)`，
 *            而 1.0s 正是轮询间隔。**假绿。**
 *   第 2 版：改单条端点 + 不再回退，但按 `job.id` 比 —— 每次都说"不认识"。**诚实的红。**
 *   第 3 版：改按 `job.uid` 比 —— 还是"不认识"。
 *   第 4 版（本版）：字段其实叫 **`jobId`**。
 *
 *   ★ 第 3 版为什么会错，值得单独记：`packages/shared/src/jobs.ts:182` 的注释写的是
 *     「This is D-02 `jobs.uid` — the ONLY job identifier the API exposes」。
 *     **那句话说的是数据库列名，字段名在下一行**（`jobId: string`）。
 *     我读了注释、没读那一行 —— 一条准确但指向别处的注释，同样能把人带偏。
 *
 *   三个名字都收，但**绝不回退到"随便哪个 job"**：认不出就如实报认不出。
 */
async function waitForJob(jobId, timeoutSec = 900) {
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const jr = await j(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (jr.status !== 200) return `轮询 /api/jobs/${jobId} 得到 HTTP ${jr.status}`;
    const job = jr.body?.job ?? jr.body;
    const gotId = job?.jobId ?? job?.uid ?? job?.id;
    if (!job || gotId !== jobId) {
      return `端点返回的不是这个 job（要 ${jobId}，拿到 ${gotId}；body keys=${JSON.stringify(Object.keys(job ?? {})).slice(0, 200)}）`;
    }
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
      return `${job.state}${job.error ? ` — ${JSON.stringify(job.error).slice(0, 200)}` : ''}`;
    }
  }
  return `TIMEOUT（${timeoutSec}s 内没到终态）`;
}

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

  /*
   * ★★ T-145 自陈：这一段的第一版**自己就是一个假绿**，而且是本任务在查的那个形状。
   *
   * 它当时打的是 `GET /api/jobs?id=<jobId>` —— 但那个端点**根本不认 `?id=`**
   * （apps/daemon/src/http/rest/jobs.ts:69 直接返回整份列表），
   * 而取 job 那行写的是 `arr.find(x => x.id === jobId) ?? arr[0]` ——
   * **`?? arr[0]` 就是那个洞**：找不到自己那条，就拿列表里的第一条顶上。
   *
   * 第一次真跑的输出是这样的：
   *     whispercpp-cpu-linux-x64   succeeded  (1.0s)
   *     media-tools-linux-x64      succeeded  (1.0s)   ← 119 MB，1.0 秒
   * 1.0s 恰好是我的轮询间隔 —— 也就是说**它第一次轮询就"看到成功了"**。
   * 一个用来查"是不是真的下载了"的脚本，报了一串它根本没等过的成功。
   *
   * → 改成 `GET /api/jobs/<id>`（单条端点，jobs.ts:95 那条正则），
   *   **找不到就如实说找不到，绝不回退到别的 job**。
   *   并且最后用 `/api/backends/installed` 做一次**独立的地面真相核对** ——
   *   判据不是"job 说它成功了"，是"这个包真的在已安装列表里"。
   */
  const installResults = [];
  for (const p of applicable) {
    const t0 = Date.now();
    const r = await j('/api/backends/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    let status = `HTTP ${r.status}`;
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    if (!jobId) {
      status = `HTTP ${r.status} 且没有 jobId：${JSON.stringify(r.body).slice(0, 200)}`;
    } else {
      status = await waitForJob(jobId);
    }
    installResults.push({ id: p.id, status, secs: ((Date.now() - t0) / 1000).toFixed(1) });
    say(`   ${p.id.padEnd(32)} ${status}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  // ★ 地面真相：不信 job 的自述，直接问"到底装上了哪些"。
  const inst = await j('/api/backends/installed');
  const instArr = Array.isArray(inst.body) ? inst.body : (inst.body?.packs ?? inst.body?.installed ?? []);
  const installedIds = new Set(instArr.map((x) => x.id ?? x.packId));
  say(`   （/api/backends/installed 返回 ${instArr.length} 条）`);
  say();
  say('   ── 独立核对：/api/backends/installed 怎么说 ──');
  for (const p of applicable) {
    say(`   ${p.id.padEnd(32)} ${installedIds.has(p.id) ? '✅ 真的在已安装列表里' : '❌ 不在已安装列表里'}`);
  }

  /* ─────────────────── 3b. 拉模型（T-145 第二轮补上的覆盖缺口）──────────────── */

  hdr('3b. 拉 ASR / VAD 模型');
  say('   ★ 上一轮这一步是**没有的**，于是 selfcheck 的 model.asr 是 fail(required)。');
  say('     那个红当时两种读法都成立：「产品的冷启动确实不含模型」与「我的审计没覆盖模型下载」。');
  say('     现在把这条路也走一遍 —— 走完之后那个红要么变绿，要么变成一个有名有姓的产品结论。');
  say();
  /*
   * ★ T-145：`/api/models/catalog` 返回的是**分组**结构，不是扁平的 models 数组：
   *     { catalogVersion, source, fetchedAt, stale, hardwareSnapshotId,
   *       groups: [ { groupId, role, tags, variants: [ …真正的模型条目… ] } ] }
   *   我第一版按 `body.models` 取，于是**拿到 0 个模型然后照常往下走** ——
   *   打印「目录里一个 required-core 的 asr/vad 模型都没有」，
   *   而那句话读起来像个产品结论，其实只是我 unwrap 错了。
   *   （这是本任务里同一个形状的第三次：工具安静地返回空集，被读成"没有"。）
   *   → 现在展平 groups→variants，且**空集会当场出声**（见下面的 hardFact）。
   *   `tags` 挂在 group 上，variant 上不一定有，两处都收。
   */
  const mcat = await j('/api/models/catalog');
  const groups = mcat.body?.groups ?? [];
  const models = groups.flatMap((g) =>
    (g.variants ?? []).map((v) => ({ ...v, role: v.role ?? g.role, tags: v.tags ?? g.tags ?? [] })),
  );
  say(`   /api/models/catalog：${groups.length} 个分组，展平后 ${models.length} 个模型条目`);
  if (models.length === 0) {
    // ★ 空集必须出声。上一版就是在这里安静地走过去的。
    say(`   ⚠️ 展平后是空的 —— 先怀疑 unwrap 写错了，别当成"目录里没有模型"。`);
    say(`      原始 top-level keys: ${JSON.stringify(Object.keys(mcat.body ?? {}))}`);
  }
  const wanted = models.filter((m) => {
    const tags = m.tags ?? [];
    return (m.role === 'vad' || m.role === 'asr') && tags.includes('required-core');
  });
  const CAP = Number(arg('--model-cap-mb', '250')) * 1024 * 1024;
  const sizeOf = (m) => (m.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  const pick = wanted.filter((m) => sizeOf(m) <= CAP);
  const skipped = wanted.filter((m) => sizeOf(m) > CAP);
  say(
    `   目录里 role in {asr,vad} 且 required-core 的模型 ${wanted.length} 个；` +
      `体积 <= ${(CAP / 1024 / 1024) | 0} MB 的 ${pick.length} 个`,
  );
  for (const m of skipped) say(`     [skip] ${(sizeOf(m) / 1024 / 1024).toFixed(0)} MB 超上限：${m.id}`);
  if (wanted.length === 0) {
    say('   目录里一个 required-core 的 asr/vad 模型都没有 —— 这本身就是个结论，记下来。');
    for (const m of models.slice(0, 10)) say(`     （目录里有：${m.id} role=${m.role} tags=${JSON.stringify(m.tags ?? [])}）`);
  }

  /*
   * ★ T-146：`required-core` 里**一个 ASR 模型都没有**（T-145 §7.3 实测的产品结论：
   *   照着 required-core 装完仍然不能转写）。所以要做可行性证明，必须**显式**再挑一个。
   *   挑最小的那个：这一步证的是"这条路走得通"，不是"跑得多快"。
   */
  if (TRANSCRIBE) {
    const asr = models
      .filter((m) => m.role === 'asr' && !pick.some((p) => p.id === m.id))
      .map((m) => ({ m, bytes: sizeOf(m) }))
      .filter((x) => x.bytes > 0)
      .sort((a, b) => a.bytes - b.bytes)[0];
    if (!asr) {
      // 空集必须出声（本仓同一形状已发生三次）。
      say('   ⚠️ --transcribe：目录里挑不出任何 role=asr 的模型 —— 先怀疑 unwrap，再怀疑目录。');
    } else {
      say(
        `   --transcribe：另挑最小的 ASR 模型 ${asr.m.id}（${(asr.bytes / 1024 / 1024).toFixed(0)} MB）`,
      );
      pick.push(asr.m);
    }
  }
  say();

  for (const m of pick) {
    const t0 = Date.now();
    const r = await j('/api/models/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m.id }),
    });
    let status = `HTTP ${r.status}`;
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    if (!jobId) {
      status = `HTTP ${r.status} 且没有 jobId：${JSON.stringify(r.body).slice(0, 200)}`;
    } else {
      status = await waitForJob(jobId);
    }
    say(`   ${String(m.id).padEnd(34)} ${status}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  const minst = await j('/api/models/installed');
  const minstArr = Array.isArray(minst.body) ? minst.body : (minst.body?.models ?? minst.body?.installed ?? []);
  say();
  say(`   ── 独立核对：/api/models/installed 返回 ${minstArr.length} 条 ──`);
  for (const m of minstArr.slice(0, 12)) say(`     ${m.id ?? m.modelId ?? JSON.stringify(m).slice(0, 60)}`);


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

  /* ─────────── 7. ★ 可行性证明：真的转写一次，判据是拿到非空文本 ─────────── */

  if (TRANSCRIBE) {
    hdr('7. ★ 可行性证明：走产品真实路径转写一次，判据是**非空文本**');
    /*
     * 样本用 whisper.cpp submodule 自带的 `samples/jfk.wav`（352,078 B，约 11 秒英语）。
     * 它随 `submodules: recursive` 一起 checkout，**不需要联网另取**，也不需要造音频。
     */
    const sample = join(REPO, 'vendor', 'whisper.cpp', 'samples', 'jfk.wav');
    if (!existsSync(sample)) {
      say(`   ✘ 样本不存在：${sample} —— submodule 没 checkout？`);
      exitCode = 1;
    } else {
      /*
       * `importRoots` = [dataDir, ...OPENMEMO_IMPORT_ROOTS]（apps/daemon/src/main.ts:782），
       * 所以样本必须先落进数据目录，否则 403 PATH_NOT_ALLOWED。
       */
      const dest = join(DATA_DIR, 'jfk.wav');
      copyFileSync(sample, dest);
      say(`   样本：${dest}（${statSync(dest).size} B）`);

      const t0 = Date.now();
      const imp = await j('/api/notes/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: dest, title: 'jfk (CI 可行性证明)', language: 'en' }),
      });
      say(`   POST /api/notes/import → HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 300)}`);

      const noteUid = imp.body?.noteUid;
      const jobUid = imp.body?.jobUid;
      if (imp.status !== 202 || !noteUid || !jobUid) {
        say('   ✘ 导入没有排上队 —— 后面的转写无从谈起。');
        exitCode = 1;
      } else {
        const st = await waitForJob(jobUid, 1200);
        say(`   转写 job：${st}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

        const tr = await j(`/api/notes/${encodeURIComponent(noteUid)}/transcript`);
        const segs = tr.body?.segments ?? [];
        const text = segs.map((s) => String(s.text ?? '')).join(' ').replace(/\s+/g, ' ').trim();
        say(`   GET /api/notes/${noteUid}/transcript → HTTP ${tr.status}，${segs.length} 段`);
        say(`   文本（前 300 字）：${text.slice(0, 300) || '(空)'}`);

        /*
         * ★ 判据写死在这里，不靠人看输出：
         *   ① 段数 > 0        —— 没有段就等于没转出来
         *   ② 去空白后长度 ≥ 20 —— 防"一个标点也算文本"的假绿
         * 不断言具体内容：tiny 模型认错词是正常的，**这一步证的是"能跑通"不是"准不准"**。
         */
        if (segs.length === 0 || text.length < 20) {
          say('   ✘ 转写没有产出可用文本 —— 这个平台上"能转写"这件事目前不成立。');
          if (daemonLogs.length) {
            say('   daemon 最后 40 行：');
            say(daemonLogs.join('').split('\n').slice(-40).map((l) => `      ${l}`).join('\n'));
          }
          exitCode = 1;
        } else {
          say(`   ✔ 拿到 ${segs.length} 段、共 ${text.length} 字符的非空文本 —— 这条路走得通。`);
        }
      }
    }
  }
} catch (e) {
  say('');
  say(`✘ 冷启动审计中断：${e.message}`);
  // ★ `fetch failed` 通常意味着 daemon 死了。第一版到这里就结束了，
  //   于是"为什么死的"完全看不到。把它最后的输出打出来。
  if (proc) {
    say('   daemon 进程状态：exitCode=' + proc.exitCode + ' signal=' + proc.signalCode);
  }
  if (daemonLogs.length) {
    say('   daemon 最后 60 行输出：');
    say(daemonLogs.join('').split('\n').slice(-60).map((l) => `      ${l}`).join('\n'));
  }
  exitCode = 1;
} finally {
  await stopDaemon();
  hdr('清理');
  say(`   指针文件用的是 ${POINTER}（不是全局的那个）—— 按 PROTOCOL §9。`);
  say(`   数据目录 ${DATA_DIR} 留在 runner 上，随 runner 一起销毁。`);
}

process.exit(exitCode);
