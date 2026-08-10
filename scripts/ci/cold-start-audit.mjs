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
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  accessSync,
  copyFileSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/*
 * ★ `--allow-known-gaps` —— 透传给 `scripts/selfcheck.mjs` 的同名开关（第 5 节
 * `selfCheckJson()` 用）。只在**发布审计**（`--bundle` 指向一个更早冻结下来的
 * build-bundles artifact，而 `selfcheck.mjs` 本身永远是当场用 HEAD 现编的）时
 * 由 workflow 显式传入 —— 那种模式下 CLI 认识的 check id 集合结构性地可能比
 * 老 artifact 新，`meta.sameSource` 会为这类**已登记**的漂移误报。
 * 默认（回归门禁模式：`--bundle` 也是本次现场组装的，理应逐 id 同源）不传，
 * 同源比对仍是无豁免的硬判据 —— 见 `scripts/ci/selfcheck-known-gaps.json` 文件头。
 */
const ALLOW_KNOWN_GAPS = argv.includes('--allow-known-gaps');

/*
 * ★ `--include-optional <role>[,<role>…]` —— 补的是一个**结构性缺口**，不是加个开关。
 *
 * ── 缺口长什么样 ────────────────────────────────────────────────────────────────
 *
 * `last-mile.md` 里有一条挂了很久的「⛔ 未验证」：
 *   「macOS 上 `asr.coreml` 真的从 warn 变成 ok」。
 * 它一直被读成"没人去验"。**不是。是没有入口可验** ——
 * 这个脚本从头到尾没有任何地方能把 `includeOptional` 传给 `/api/models/pull`，
 * 而 CoreML encoder 在清单里是 `optional: true` 的文件
 * （`installer.ts` 的 `selectFiles`：`if (f.optional && !includeOptional.includes(f.role)) return false`）。
 * 也就是说：**在补上这个参数之前，那一项在结构上不可能变绿**，
 * 谁跑多少轮 CI 都一样。这比"没验"糟 —— 它看起来像是"验了没过"。
 *
 * ── 为什么还要额外挑一个"载体模型" ──────────────────────────────────────────────
 *
 * 光把参数透传下去**仍然是个空操作**：本脚本挑 ASR 模型的判据是"最小的那个"
 * （`asr/whisper-tiny-q5_1`，32 MB），而清单里 **只有 large-v3 / large-v3-turbo 那 5 个**
 * 带 `coreml-encoder` 文件（其余 20 个一个都没有，见 `platform-backlog.md` §17：
 * tiny/base/small/medium 的 encoder 因为拿不到 sha256 而**刻意没挂**）。
 * 传了参数、装的却是 tiny —— `asr.coreml` 照样是 warn，而且这次的 warn
 * **看起来像是产品的答案，其实是我挑错了模型**。所以第 8 节会另外挑一个
 * 真的提供该 role 的模型；挑不出来就**当场出声**，不假装跑过。
 *
 * 环境变量兜底是给 workflow 用的：`env:` 赋值不经过 shell，
 * 既没有 `${{ }}` 注入问题，也不用管 Windows runner 默认是 pwsh 还是 bash。
 */
const INCLUDE_OPTIONAL = String(
  arg('--include-optional', '') || process.env.AUDIT_INCLUDE_OPTIONAL || '',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
const HOST_TOOLS = [
  'ffmpeg',
  'ffprobe',
  'yt-dlp',
  'youtube-dl',
  'whisper-cli',
  'sqlite3',
  'python3',
];

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

/*
 * ★★ `--bundle <目录>`（D-17 第二阶段）：把这套判据**原样**指向预编译包。
 *
 * 为什么是加一个开关，而不是另写一个 bundle 版的冷启动脚本：
 * 判据只要有两份实现，就会漂成两条 —— 而这里要证明的恰恰是
 * 「**用户下载的那个东西**跟我们一直在测的那个东西一样能用」。
 * 另写一份的话，绿灯证明的是那份新脚本，不是那个包。
 *
 * 带 `--bundle` 时有三处不同，其余（屏蔽宿主 PATH、真下载、真转写、
 * 非空文本断言）**逐字沿用**：
 *   ① daemon 入口取包里的，不是仓库 dist 里的；
 *   ② 解释器取**包自带的 Node**，不是跑本脚本的这个 —— 否则测的是宿主的 node，
 *      而"用户机器上没有 node"正是这个包存在的理由；
 *   ③ 网页 bundle 与 SQLite 扩展指向包内（与启动脚本设的是同两个变量）。
 */
const BUNDLE = arg('--bundle', null);

const DAEMON = BUNDLE
  ? join(BUNDLE, 'app', 'daemon', 'dist', 'main.js')
  : join(REPO, 'apps', 'daemon', 'dist', 'main.js');
if (!existsSync(DAEMON)) {
  console.error(
    BUNDLE
      ? `✘ 找不到 ${DAEMON} —— --bundle 指向的目录不像一个预编译包`
      : `✘ 找不到 ${DAEMON} —— 先跑 pnpm build:safe`,
  );
  process.exit(2);
}

const NODE_BIN = BUNDLE
  ? join(BUNDLE, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  : process.execPath;
if (BUNDLE && !existsSync(NODE_BIN)) {
  console.error(`✘ 包里没有自带的 Node 运行时：${NODE_BIN}`);
  process.exit(2);
}
if (BUNDLE) {
  say(`   预编译包模式：${BUNDLE}`);
  say(`   解释器 = 包自带的 ${NODE_BIN}（**不是**宿主的 ${process.execPath}）`);
}

const childEnv = {
  ...process.env,
  PATH: PATH_FOR_DAEMON,
  OPENMEMO_AUTH: 'none',
  OPENMEMO_DATA_DIR: DATA_DIR,
  // ★ PROTOCOL §9：绝不碰全局指针。模块级设定，窗口为零。
  OPENMEMO_POINTER_FILE: POINTER,
  ...(BUNDLE
    ? {
        OPENMEMO_WEB_DIST: join(BUNDLE, 'app', 'apps', 'web', 'dist'),
        OPENMEMO_EXT_DIR: join(BUNDLE, 'ext'),
      }
    : {}),
};

let proc = null;
let daemonLogs = [];
async function startDaemon(label) {
  const logs = [];
  daemonLogs = logs;
  proc = spawn(NODE_BIN, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
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
  say(
    logs
      .join('')
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n'),
  );
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

/**
 * 拉一个模型并等到终态。**`includeOptional` 一律带上** —— 目录里没有该 role 的
 * 可选文件时它是无害的空操作（`selectFiles` 按 role + platform 双重筛），
 * 带上它才对得住"这一轮到底问了产品什么"。
 */
async function pullModel(m, timeoutSec = 900) {
  const body = { id: m.id };
  if (INCLUDE_OPTIONAL.length > 0) body.includeOptional = INCLUDE_OPTIONAL;
  const r = await j('/api/models/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
  if (!jobId) return `HTTP ${r.status} 且没有 jobId：${JSON.stringify(r.body).slice(0, 200)}`;
  return await waitForJob(jobId, timeoutSec);
}

/**
 * 跑一次 `scripts/selfcheck.mjs --json`。
 *
 * 提成函数是因为第 8 节要**再跑一次** —— 装完可选文件之后必须重新问一遍，
 * 否则拿到的还是装之前那份报告。
 * （`selfcheck.mjs` 每次都 `new ArtifactStore(storeRoot)` 现读磁盘、无缓存，
 *   所以不需要重启 daemon 就能看到新装的模型。）
 */
function selfCheckJson() {
  const sc = spawnSync(
    process.execPath,
    [
      join(REPO, 'scripts', 'selfcheck.mjs'),
      '--data-dir',
      DATA_DIR,
      '--daemon',
      BASE,
      '--json',
      ...(ALLOW_KNOWN_GAPS ? ['--allow-known-gaps'] : []),
    ],
    { env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  let report = null;
  try {
    report = JSON.parse(sc.stdout);
  } catch {
    /* 调用方负责出声 —— 这里安静地吞掉才是 bug */
  }
  return { sc, report, checks: report?.checks ?? report?.results ?? [] };
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
  const bootLine = bootLogs
    .join('')
    .split('\n')
    .find((l) => l.includes('tokenizer='));
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
  const instArr = Array.isArray(inst.body)
    ? inst.body
    : (inst.body?.packs ?? inst.body?.installed ?? []);
  const installedIds = new Set(instArr.map((x) => x.id ?? x.packId));
  say(`   （/api/backends/installed 返回 ${instArr.length} 条）`);
  say();
  say('   ── 独立核对：/api/backends/installed 怎么说 ──');
  for (const p of applicable) {
    say(
      `   ${p.id.padEnd(32)} ${installedIds.has(p.id) ? '✅ 真的在已安装列表里' : '❌ 不在已安装列表里'}`,
    );
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
  /*
   * ★ T-149：这里原来筛的是 `tags.includes('required-core')`。**那个标签已经从清单里删掉了。**
   *   它一共标着 2 个模型、**全是 VAD、零个 ASR** —— 也就是说「照着"必需核心"装完仍然
   *   不能转写」（D-11 §7.3 第 1 条就是这么发现的）。而且它**没有任何产品消费者**：
   *   daemon 只把 tags 原样透传，网页只读 `recommended-default`，这个脚本是它唯一的消费方。
   *   一个没人执行、名字却是承诺的标签，改对了也只是换成"没人兑现的承诺"，所以删掉。
   *   定性全文见 `coordination/inbox/catalog-truth.md`。
   *
   *   改成**按 role 筛**：这一步要的是"流水线要用到的辅助权重"，那是 role 的事，不是标签的事。
   *   两个 VAD 都收（各 1–2 MB）—— **同时装上正是 T-148 那个 bug 的现场**
   *   （目录顺序里 onnx 在前，先装的赢槽位），保留它才守得住那条修复别退回去。
   */
  const wanted = models.filter((m) => m.role === 'vad');
  const CAP = Number(arg('--model-cap-mb', '250')) * 1024 * 1024;
  const sizeOf = (m) => (m.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  const pick = wanted.filter((m) => sizeOf(m) <= CAP);
  const skipped = wanted.filter((m) => sizeOf(m) > CAP);
  say(
    `   目录里 role=vad 的模型 ${wanted.length} 个；` +
      `体积 <= ${(CAP / 1024 / 1024) | 0} MB 的 ${pick.length} 个`,
  );
  for (const m of skipped)
    say(`     [skip] ${(sizeOf(m) / 1024 / 1024).toFixed(0)} MB 超上限：${m.id}`);
  if (wanted.length === 0) {
    // 空集必须出声（本仓同一形状已发生四次）：先怀疑 unwrap，再怀疑目录。
    say('   ⚠️ 目录里一个 role=vad 的模型都没有 —— 先怀疑 unwrap 写错了，别当成"目录里没有 VAD"。');
    for (const m of models.slice(0, 10))
      say(`     （目录里有：${m.id} role=${m.role} tags=${JSON.stringify(m.tags ?? [])}）`);
  }

  /*
   * ★ T-146：**目录里没有任何"装完就能转写"的成套集合**（上面那段说的就是这件事）。
   *   所以要做可行性证明，必须**显式**再挑一个 ASR。
   *   挑最小的那个：这一步证的是"这条路走得通"，不是"跑得多快"。
   */
  if (TRANSCRIBE) {
    /*
     * ★ 必须挑 **whisper.cpp 能加载的**那种，不能只按"最小"挑。
     *
     * 第一次真跑挑到的是 `asr/sherpa-streaming-zh-14m`（24 MB，确实最小）——
     * 但它是 sherpa 的中文流式 onnx 模型，而样本 `jfk.wav` 是英语，
     * 且本轮要证的正是 **whisper.cpp + ffmpeg 这条链**。
     * 挑错引擎的话，这一步就算绿了也证明不了它该证明的东西。
     */
    const forWhisper = (m) =>
      (m.engines ?? []).includes('whisper.cpp') || /^asr\/whisper-/.test(String(m.id ?? ''));
    const asr = models
      .filter((m) => m.role === 'asr' && forWhisper(m) && !pick.some((p) => p.id === m.id))
      .map((m) => ({ m, bytes: sizeOf(m) }))
      .filter((x) => x.bytes > 0)
      .sort((a, b) => a.bytes - b.bytes)[0];
    if (!asr) {
      // 空集必须出声（本仓同一形状已发生三次）。
      say(
        '   ⚠️ --transcribe：目录里挑不出任何 whisper.cpp 能加载的 asr 模型 —— 先怀疑 unwrap，再怀疑目录。',
      );
      for (const m of models.filter((x) => x.role === 'asr').slice(0, 8)) {
        say(`      （role=asr 的有：${m.id} engines=${JSON.stringify(m.engines ?? null)}）`);
      }
    } else {
      say(
        `   --transcribe：另挑最小的 ASR 模型 ${asr.m.id}（${(asr.bytes / 1024 / 1024).toFixed(0)} MB）`,
      );
      pick.push(asr.m);
    }
  }
  say();

  if (INCLUDE_OPTIONAL.length > 0) {
    say(`   （本轮 --include-optional=${INCLUDE_OPTIONAL.join(',')}，每次 pull 都会带上）`);
  }
  for (const m of pick) {
    const t0 = Date.now();
    const status = await pullModel(m);
    say(`   ${String(m.id).padEnd(34)} ${status}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  const minst = await j('/api/models/installed');
  const minstArr = Array.isArray(minst.body)
    ? minst.body
    : (minst.body?.models ?? minst.body?.installed ?? []);
  say();
  say(`   ── 独立核对：/api/models/installed 返回 ${minstArr.length} 条 ──`);
  for (const m of minstArr.slice(0, 12))
    say(`     ${m.id ?? m.modelId ?? JSON.stringify(m).slice(0, 60)}`);

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
  const { sc, report, checks } = selfCheckJson();
  if (!report) {
    say('   ✘ selfcheck 的 JSON 解析不了，原样输出：');
    say((sc.stdout || '').slice(0, 4000));
    say((sc.stderr || '').slice(0, 4000));
  }

  if (report) {
    say(`   selfcheck exit=${sc.status}  共 ${checks.length} 项`);
    say();
    say('   id                                 status  required  detail');
    say('   ' + '-'.repeat(88));
    for (const c of checks) {
      say(
        `   ${String(c.id).padEnd(34)} ${String(c.status).padEnd(7)} ${String(c.required ?? '').padEnd(9)} ${String(
          c.detail ?? c.message ?? '',
        )
          .replace(/\s+/g, ' ')
          .slice(0, 100)}`,
      );
    }

    /*
     * ★ `hw.probe` 与 `asr.coreml` 的 detail 在上面那张表里被截到 100 字符 ——
     *   而这两条**最值钱的信息恰好在后面**：探针失败时是「耗时 + stderr 尾部」，
     *   CoreML 失败时是「到底缺哪个 .mlmodelc」。截断之后它们读起来都像
     *   "有一句话，但看不清" —— 等于没有。这里整条打出来，不截。
     */
    for (const id of ['hw.probe', 'asr.coreml']) {
      const c = checks.find((x) => x.id === id);
      say();
      if (!c) {
        say(`   ★ ${id}：本轮报告里**没有这一项**`);
        if (id === 'asr.coreml') {
          say(`     （checkCoreMl() 第一行就是 platform!=='darwin' || arch!=='arm64' → return，`);
          say(`       所以这在 ${process.platform}/${process.arch} 上是预期的，不是缺陷）`);
        }
      } else {
        say(`   ★ ${id} = ${c.status}（required=${c.required}）`);
        say(`     ${String(c.detail ?? c.message ?? '').replace(/\s+/g, ' ')}`);
      }
    }

    /* ── 6. 三分类表 —— 用产品自己的判据，不另发明 ── */
    hdr('6. ★ 三分类：产品自己下的 / 借宿主的 / 装不上');
    const tools = checks.filter((c) => String(c.id).startsWith('tool.'));
    const own = tools.filter((c) => c.status === 'ok');
    const borrowed = tools.filter(
      (c) => c.status === 'warn' && /PATH/i.test(String(c.detail ?? '')),
    );
    const missing = tools.filter(
      (c) => c.status === 'fail' || (c.status === 'warn' && !/PATH/i.test(String(c.detail ?? ''))),
    );
    say(
      `   ✅ 产品自己下载并校验的 (${own.length})：      ${own.map((c) => c.id).join(', ') || '(无)'}`,
    );
    say(
      `   ⚠️ 借宿主 PATH 的       (${borrowed.length})：      ${borrowed.map((c) => c.id).join(', ') || '(无)'}`,
    );
    say(
      `   ❌ 装不上/不可用        (${missing.length})：      ${missing.map((c) => c.id).join(', ') || '(无)'}`,
    );
    say();
    const cn = checks.find((c) => c.id === 'ext.chineseSearch');
    if (cn) {
      say(`   ★ ext.chineseSearch = ${cn.status}（required=${cn.required}）`);
      say(
        `     ${String(cn.detail ?? cn.message ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 300)}`,
      );
      say('     ← 这一条才是「libsimple 真的装上了」的判据。');
      say('       T-093 的事故形态是：7 个包全 succeeded、sha256 全过，而这里是 fail。');
    } else {
      say('   ⚠️ 报告里没有 ext.chineseSearch 这一项 —— 判据本身不见了，这比它红更值得查。');
    }
    if (sc.status !== 0) exitCode = 1;
  } else {
    exitCode = 1;
  }

  /* ────── 6b. ★ 探针深挖：分辨「10 秒太短」/「初始化会挂」/「真有 bug」 ────── */

  /*
   * ── 这一节要回答的问题 ────────────────────────────────────────────────────────
   *
   * darwin-arm64 上 `hw.probe` 报 `probe timed out after 10000ms`，而
   * `platform-backlog.md` 把成因列成了三条**没有分开**的候选：
   *   ① 10 秒对这台虚拟化 runner 太短    ② Metal 在虚拟化 macOS 上初始化会挂
   *   ③ 探针真有 bug
   * 上一位判断"不许调大 `PROBE_TIMEOUT_MS`，改大只会把『挂了』伪装成『慢』"——
   * 这条判断是对的，**所以这里也不改它**。
   *
   * ── 但"不改常量"不等于"不能做实验" ──────────────────────────────────────────
   *
   * ① 和 ②/③ 的区别是**可判定的**：给它一个远大于 10 秒的窗口，
   *    · 在 10s 与 120s 之间返回  → 它只是**慢**，① 成立（而且给出了真实耗时，
   *      下一步该谈的是常量取值，那时才有据可依）；
   *    · 120s 仍然不返回          → 它是**挂了**，① 被证伪，剩 ②/③；
   *    · 崩溃/信号退出            → 既不是慢也不是挂，直接落到 ③（或驱动故障）。
   *
   * 关键在于**这个放宽只发生在审计脚本里，产品常量一个字没动**：
   * 调的是 `runProbe()` 的 `timeoutMs` 入参（它本来就接受），
   * `PROBE_TIMEOUT_MS` 仍然是 ADR-003 定死的 10 秒。
   * 而且刻意调的是**产品自己那个函数**，不是我另写一个 spawn ——
   * 自己写一个就等于换了环境变量、换了参数、换了解析，测的就不是同一件事了。
   *
   * 这一节**只观测，绝不改 exitCode**：它是用来查的，不是判据。
   */
  try {
    hdr('6b. ★ 探针深挖：同一个 runProbe()，只把超时放宽 —— 分辨「慢」还是「挂」');
    const distUrl = (rel) => pathToFileURL(join(REPO, rel)).href;
    const rt = await import(distUrl('packages/runtime/dist/index.js'));
    const pl = await import(distUrl('packages/pipeline/dist/index.js'));
    const STORE_ROOT = process.env.OPENMEMO_MODELS ?? join(DATA_DIR, 'models');
    const probePath = await pl.findInBackendPacks(
      STORE_ROOT,
      IS_WIN ? 'openmemo-probe.exe' : 'openmemo-probe',
    );

    if (!probePath) {
      say('   ⚠️ 这台机器上找不到 openmemo-probe —— 深挖无从谈起。');
      say(`      找过的 storeRoot：${STORE_ROOT}`);
      say('      （若 hw.probe 报的是"未安装"，这一条与它一致，不是新问题。）');
    } else {
      const backendDir = dirname(probePath);
      say(`   探针：${probePath}`);
      say(`   后端目录：${backendDir}`);
      /*
       * 先把后端目录摊开。「加载哪个后端时停住的」这个问题，
       * 得先知道**这里到底有哪些后端**才谈得下去（macOS 上关心的是 metal）。
       */
      try {
        const { readdirSync } = await import('node:fs');
        const libs = readdirSync(backendDir).filter((f) => /ggml|metal|vulkan|cuda|blas/i.test(f));
        say(`   目录里与 ggml 后端有关的文件（${libs.length}）：${libs.join(', ') || '(无)'}`);
      } catch (e) {
        say(`   （列目录失败：${e.message}）`);
      }

      /*
       * 第一发：**完全按产品的默认参数**跑，先确认自检那个结论在这里复现得出来。
       * 复现不出来的话，后面那一发放宽超时就没有对照意义了。
       */
      say();
      say(`   ── 第 1 发：产品默认超时 ${rt.PROBE_TIMEOUT_MS}ms（复现自检看到的那个结论）──`);
      const r1 = await rt.runProbe({ probePath, backendDir });
      say(
        `   ok=${r1.ok}  耗时=${r1.durationMs}ms  ${r1.ok ? '' : `kind=${r1.kind}  message=${r1.message}`}`,
      );
      say(`   stdout: ${r1.ok ? JSON.stringify(r1.output).slice(0, 400) : '(失败，无有效 JSON)'}`);
      say('   ── stderr 全文（这正是此前日志里完全没有的东西）──');
      say(
        r1.stderr
          ? r1.stderr
              .split('\n')
              .map((l) => `      ${l}`)
              .join('\n')
          : '      (空)',
      );

      /*
       * 第二发：只有第一发失败才有必要 —— 成功的话"慢还是挂"这个问题本身不存在。
       */
      if (r1.ok) {
        say();
        say('   ✔ 默认超时下探针就成功了 —— 本平台不存在"慢还是挂"的问题，跳过第 2 发。');
      } else {
        const LONG_MS = 120_000;
        say();
        say(`   ── 第 2 发：超时放宽到 ${LONG_MS}ms（产品常量未改，只改本次调用的入参）──`);
        const t0 = Date.now();
        const r2 = await rt.runProbe({ probePath, backendDir, timeoutMs: LONG_MS });
        const wall = Date.now() - t0;
        say(
          `   ok=${r2.ok}  耗时=${r2.durationMs}ms（墙钟 ${wall}ms）  ${r2.ok ? '' : `kind=${r2.kind}  message=${r2.message}`}`,
        );
        say(
          `   stdout: ${r2.ok ? JSON.stringify(r2.output).slice(0, 400) : '(失败，无有效 JSON)'}`,
        );
        say('   ── stderr 全文 ──');
        say(
          r2.stderr
            ? r2.stderr
                .split('\n')
                .map((l) => `      ${l}`)
                .join('\n')
            : '      (空)',
        );

        /*
         * ★ 结论只从上面这两发的实际输出里读，不引入任何假设。
         *   三条候选各自对应一个**可观测**的形态，对不上就明说对不上。
         */
        say();
        say('   ── 定性（只依据上面两发的实测输出）──');
        if (r2.ok) {
          say(`   ✔ 放宽后成功了，用时 ${r2.durationMs}ms。`);
          say(`     → 「10 秒太短」成立；「初始化会挂」被证伪 —— 它是**慢**，不是挂。`);
          say(`     → 下一步该谈的是 PROBE_TIMEOUT_MS 取值，而且现在有实测数字了。`);
        } else if (r2.kind === 'timeout') {
          say(`   ✘ 放宽到 ${LONG_MS}ms 仍然超时（${r2.durationMs}ms）。`);
          say('     → 「10 秒太短」被证伪：这不是慢，是**卡住不返回**。');
          say(
            '     → 剩下「初始化会挂」与「真有 bug」两条，二者要靠上面的 stderr 停在哪一行来分。',
          );
          say('       stderr 为空 = 连第一个后端都没打印出来就停了（更像加载期就挂住）。');
        } else {
          say(`   ✘ 放宽后不是超时，而是 ${r2.kind}：${r2.message}`);
          say('     → 「10 秒太短」与「初始化挂住」都被证伪 —— 这是崩溃/执行失败那一类。');
        }
      }
    }
  } catch (e) {
    // 观测步骤没有资格让整个审计变红（与第 7 节里 job.error 全文那段同理）。
    say(`   ⚠️ 探针深挖本身失败了：${e.message}`);
    say('      （这一节只观测，不改红绿；但它失败本身也是个信息，所以照报。）');
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
      say(
        `   POST /api/notes/import → HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 300)}`,
      );

      const noteUid = imp.body?.noteUid;
      const jobUid = imp.body?.jobUid;
      if (imp.status !== 202 || !noteUid || !jobUid) {
        say('   ✘ 导入没有排上队 —— 后面的转写无从谈起。');
        exitCode = 1;
      } else {
        const st = await waitForJob(jobUid, 1200);
        say(`   转写 job：${st}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

        /*
         * ★ `waitForJob` 把 error 截到 200 字符 —— 对轮询摘要够用，对**定位**远远不够：
         *   第一次真跑拿到的是 `whisper-vad-speech-segments exited with code 2\nload_backend: l`
         *   ——正好在最关键的那个字上断了。所以这里再取一次完整的。
         *   （一个用来看的步骤不该有能力决定红绿，所以它只打印、不改 exitCode。）
         */
        const full = await j(`/api/jobs/${encodeURIComponent(jobUid)}`);
        const fullErr = (full.body?.job ?? full.body)?.error;
        if (fullErr) {
          say('   ── job.error 全文 ──');
          for (const line of JSON.stringify(fullErr, null, 2).slice(0, 4000).split('\n')) {
            say(`      ${line}`);
          }
        }

        const tr = await j(`/api/notes/${encodeURIComponent(noteUid)}/transcript`);
        const segs = tr.body?.segments ?? [];
        const text = segs
          .map((s) => String(s.text ?? ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
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
            say(
              daemonLogs
                .join('')
                .split('\n')
                .slice(-40)
                .map((l) => `      ${l}`)
                .join('\n'),
            );
          }
          exitCode = 1;
        } else {
          say(`   ✔ 拿到 ${segs.length} 段、共 ${text.length} 字符的非空文本 —— 这条路走得通。`);
        }

        /*
         * ★ T-148：**"转出字来了"还不够，要知道它是用哪种切分转出来的。**
         *
         * VAD 跑不起来时产品现在会退回固定窗口继续跑（此前是整单转写死）。
         * 那个降级如果不报出来，这一节就会变成一盏新的假绿灯：
         * 文本有了、判据过了，而系统在悄悄用较差的切分。
         *
         * 红绿规则刻意分两档：
         *   · `rejected` 非空 = 装了一份 whisper.cpp 用不了的 VAD 权重 → **红**
         *     （这正是 run 31039460495 那次事故的状态）
         *   · 单纯没装 VAD → 只打印。那是合法的降级，报红就是假红灯。
         */
        const health = await j('/api/health');
        const vad = health.body?.pipeline?.vad;
        if (!vad) {
          say('   ⚠️ /api/health 没有 pipeline.vad —— 切分方式无从判断（daemon 版本对不上？）');
        } else if (vad.chunking === 'vad') {
          say(`   ✔ 切分方式 = VAD（按静音切分），权重 ${vad.model}`);
        } else {
          say(`   ⚠️ 切分方式 = 固定窗口：${vad.reasonZh}`);
          if ((vad.rejected ?? []).length > 0) {
            say(`   ✘ 装上的 VAD 权重 whisper.cpp 加载不了：${vad.rejected.join(', ')}`);
            exitCode = 1;
          }
        }
      }
    }
  }

  /* ────── 8. ★ 可选文件（includeOptional）：CoreML encoder 到底装不装得上 ────── */

  /*
   * ── 为什么这一节放在转写**之后** ────────────────────────────────────────────
   *
   * 这里要装的载体模型是 `whisper-large-v3-turbo`（574 MB 权重 + 1.17 GB encoder）——
   * 清单里带 `coreml-encoder` 的最小的一个。如果在第 3b 节就装上它，
   * 第 7 节的转写就**可能**改用它：ASR 权重的选取顺序是
   * 「环境变量 > active.json > 任意已装记录（readdir 原序）」
   * （`apps/daemon/src/pipeline/setup.ts:330-337`）——
   * 而 `active.json` 是"先装的赢"（`rest/models.ts:494` 的 `!state.active[role]`）。
   * 也就是说：**先装 tiny 就轮不到它**，但那是靠顺序侥幸成立的，不是保证。
   *
   * 而 macOS runner 上 tiny 转 11 秒音频已经要 **111.8s**（虚拟化 3 核 M1，
   * 同一轮 Linux 只要 2.1s）。同一台机器上换成 turbo，转写有很大概率撞上
   * `waitForJob` 的上限，把一个**本来会绿的可行性证明**拖成红。
   *
   * 所以顺序上就把它排在转写后面：**不依赖任何选取顺序的侥幸**，
   * 第 7 节看到的仍然只有 tiny 一个 ASR。判据照 PROTOCOL 的老规矩 ——
   * 不是"记得别装早了"，是"装早了也不会有后果"（这里是结构上不可能装早）。
   */
  hdr('8. ★ 可选文件（--include-optional）—— asr.coreml 这一项到底是什么状态');

  if (INCLUDE_OPTIONAL.length === 0) {
    say('   本轮没传 --include-optional / AUDIT_INCLUDE_OPTIONAL，跳过。');
    say('   ⚠️ 这意味着 asr.coreml 在本轮**没有被检验过** —— 它的状态不是"好"，是"没问"。');
  } else {
    say(`   本轮请求的可选 role：${INCLUDE_OPTIONAL.join(', ')}`);

    /*
     * 清单里的可选文件带 `platforms: [{os, arch}]`（CoreML encoder 是 darwin/arm64）。
     * 按当前平台先筛一遍：Linux/Windows 上**根本不该**为此多下 1.7 GB。
     */
    const platformMatches = (f) => {
      const ps = f.platforms ?? [];
      if (ps.length === 0) return true;
      return ps.some(
        (p) => (!p.os || p.os === process.platform) && (!p.arch || p.arch === process.arch),
      );
    };
    const hitsOf = (m) =>
      (m.files ?? []).filter(
        (f) => f.optional === true && INCLUDE_OPTIONAL.includes(f.role) && platformMatches(f),
      );
    const sizeWith = (m, hits) =>
      (m.files ?? []).reduce(
        (n, f) => n + (f.optional === true && !hits.includes(f) ? 0 : (f.sizeBytes ?? 0)),
        0,
      );

    const carriers = models
      .map((m) => ({ m, hits: hitsOf(m) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => ({ ...x, bytes: sizeWith(x.m, x.hits) }))
      .sort((a, b) => a.bytes - b.bytes);

    if (carriers.length === 0) {
      /*
       * ★ 空集必须出声（本仓同一形状已经发生过四次），而且要把
       *   「本平台没有」与「清单里根本没有」分开 —— 这两句话的处置完全不同。
       */
      say(`   ⓘ 本平台（${process.platform}/${process.arch}）没有任何模型提供这些 role。`);
      const anyPlatform = models.filter((m) =>
        (m.files ?? []).some((f) => f.optional === true && INCLUDE_OPTIONAL.includes(f.role)),
      );
      if (anyPlatform.length === 0) {
        say('   ⚠️ 而且**整个清单里**都没有这个 role 的可选文件 —— 先怀疑 role 名写错了，');
        say('      再怀疑清单。（清单里出现过的可选 role：');
        const seen = new Set();
        for (const m of models)
          for (const f of m.files ?? []) if (f.optional === true) seen.add(f.role);
        say(`      ${[...seen].join(', ') || '(一个都没有)'}）`);
      } else {
        say(`   清单里有 ${anyPlatform.length} 个模型提供它，但都限定了别的平台 —— 这是预期的：`);
        for (const m of anyPlatform.slice(0, 6)) {
          const f = (m.files ?? []).find(
            (x) => x.optional === true && INCLUDE_OPTIONAL.includes(x.role),
          );
          say(
            `     ${String(m.id).padEnd(34)} ${f?.role} → ${JSON.stringify(f?.platforms ?? null)}`,
          );
        }
        say('   → 本平台跳过，不下载。这一格的答案只能由对应平台的那一格给出。');
      }
    } else {
      const best = carriers[0];
      say(`   清单里能在本平台提供这些 role 的模型 ${carriers.length} 个，挑最小的：`);
      for (const c of carriers.slice(0, 6)) {
        say(
          `     ${String(c.m.id).padEnd(34)} ${(c.bytes / 1024 / 1024).toFixed(0)} MB  (${c.hits.map((h) => h.role).join(',')})`,
        );
      }
      say();
      say(`   → 装 ${best.m.id}（含可选文件共 ${(best.bytes / 1024 / 1024).toFixed(0)} MB）`);
      const t0 = Date.now();
      // 1.7 GB 的下载 + 解包，900s 不够；这一步单独给更长的窗口。
      const status = await pullModel(best.m, 2400);
      say(
        `   ${String(best.m.id).padEnd(34)} ${status}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );

      /*
       * ★ 重新问一次 selfcheck。**必须重跑** —— 第 5 节那份报告是装之前的。
       *   `selfcheck.mjs` 每次现读磁盘（`new ArtifactStore(storeRoot)`，无缓存），
       *   所以不需要重启 daemon。
       */
      say();
      say('   ── 重跑 selfcheck（装完之后再问一次）──');
      const again = selfCheckJson();
      if (!again.report) {
        say('   ✘ 第二次 selfcheck 的 JSON 解析不了，原样输出：');
        say((again.sc.stdout || '').slice(0, 2000));
        say((again.sc.stderr || '').slice(0, 2000));
      } else {
        const cm = again.checks.find((c) => c.id === 'asr.coreml');
        say();
        if (!cm) {
          say('   ★ asr.coreml：报告里**没有这一项**。');
          say(`     checkCoreMl() 在 ${process.platform}/${process.arch} 上第一行就 return，`);
          say('     所以这个平台产生不出这一项 —— 是预期，不是缺陷。');
        } else {
          say(`   ★★ asr.coreml = ${cm.status}（required=${cm.required}）`);
          say(`      ${String(cm.detail ?? '').replace(/\s+/g, ' ')}`);
          if (cm.remediation)
            say(`      remediation: ${String(cm.remediation).replace(/\s+/g, ' ')}`);
          say();
          /*
           * ★ 三档各自意味着什么，直接写在输出里 —— 免得下一个人再去翻 selfcheck.ts。
           *   **不把 warn 说成"差不多绿了"**：warn 就是没启用 ANE。
           */
          if (cm.status === 'ok') {
            say('      → ANE 真的就绪了。这一格闭环：encoder 装得上、目录结构对。');
          } else if (cm.status === 'warn') {
            say('      → **仍然是 warn**，ANE 没启用。可选文件没落到 checkCoreMl() 要找的位置，');
            say('        或者这个载体模型的 encoder 压根没装上（看上面那行 pull 的状态）。');
          } else {
            say('      → **fail**：目录在、但里面没有 coremldata.bin —— 就是那个"多一层同名目录"');
            say('        的空壳形态，whisper 会静默回退到 Metal/CPU。');
          }
        }

        /*
         * ★★ T-168 ④：**这一份报告也要参与红绿。**
         *
         * 在此之前，第 8 节整节都是"只打印"—— `exitCode` 只由第 5 节那一发
         * （`sc.status`，见本文件 6 节末尾）决定。而第 5 节是**装可选文件之前**跑的，
         * 那时 `asr.coreml` 必然是 `warn`（encoder 还没装）。
         *
         * 于是有一条谁都没看见的缝：**把 `asr.coreml` 标成 required 也不会让审计变红**，
         * 因为唯一会看到它 `fail` 的那一发报告，压根没有被计入退出码。
         * 「装了 encoder 之后坏没坏」正是本节存在的理由，它却是本节唯一不影响结论的东西。
         *
         * 判据用**产品自己的**：`selfcheck.mjs` 的退出码 = `status==='fail' && required`。
         * 审计不在这里另立一套规矩（比如单独 `if (cm.status==='fail')`）——
         * 那会变成两处判据，改一处的人不会知道还有另一处。
         *
         * 只在真的装了可选文件的那一格生效：`carriers.length === 0` 的平台
         * （Linux/Windows）根本走不到这里。
         */
        if (again.sc.status !== 0) {
          say();
          say(
            '   ✘ 装完可选文件之后，selfcheck 判定**不健康**（退出码 ' +
              String(again.sc.status) +
              '）。',
          );
          say('     本节因此让整个审计变红 —— 判据是产品自己的 required 语义，不是审计另立的。');
          const bad = (again.checks ?? []).filter((c) => c.status === 'fail' && c.required);
          for (const c of bad) {
            say(
              `     · ${String(c.id).padEnd(24)} ${String(c.detail ?? '')
                .replace(/\s+/g, ' ')
                .slice(0, 200)}`,
            );
          }
          exitCode = 1;
        }

        /* 装完之后 by-name/asr 下到底多了什么，摊开给下一个人看。 */
        try {
          const { readdirSync } = await import('node:fs');
          const asrDir = join(
            process.env.OPENMEMO_MODELS ?? join(DATA_DIR, 'models'),
            'by-name',
            'asr',
          );
          say();
          say(`   by-name/asr 目录实况（${asrDir}）：`);
          for (const e of readdirSync(asrDir)) say(`     ${e}`);
        } catch (e) {
          say(`   （列 by-name/asr 失败：${e.message}）`);
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
    say(
      daemonLogs
        .join('')
        .split('\n')
        .slice(-60)
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  exitCode = 1;
} finally {
  await stopDaemon();
  hdr('清理');
  say(`   指针文件用的是 ${POINTER}（不是全局的那个）—— 按 PROTOCOL §9。`);
  say(`   数据目录 ${DATA_DIR} 留在 runner 上，随 runner 一起销毁。`);
}

process.exit(exitCode);
