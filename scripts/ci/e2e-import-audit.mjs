#!/usr/bin/env node
/**
 * e2e-import-audit.mjs — F1（链接导入）与 F2（本地媒体导入）的**端到端**验收。
 *
 * ## 为什么要有这个脚本
 *
 * 用户下载 v0.2.0 预编译包在真机上用，打不开。他的原话：
 *
 *   > 「你应该派多路 agent 去在 CI 中运行一遍把各个流程跑通才能给我交付的啊！」
 *
 * 他是对的。在此之前 CI 验的是「产品能不能被脚本驱动着转出一段文本」
 * （`cold-start-audit.mjs` 第 7 节），而交付的是「**人要用手打开并使用它**」。
 * 中间那一段 —— 网页发的那个 multipart、`/media` 上那个 Range 请求 ——
 * **一条都没测过**。
 *
 * 所以本脚本的判据不是"数据库里有记录"，是：
 *
 *   **`/media` 的 Range 请求真的返回可播放的字节，而且那些字节与导入的文件逐字节相同。**
 *
 * sha256 往返（导进去的文件 == `/media` 吐出来的文件）是这里最值钱的一条断言：
 * 它同时否掉了「落库了但文件丢了」「归档时截断了」「Range 算错了偏移」三种形态，
 * 而这三种在"数据库里有一行"的判据下**全都是绿的**。
 *
 * ## 它验什么、不验什么（这一段是结论的一部分，不是免责声明）
 *
 * **F2 走的是网页真正走的那条路**：`POST /api/notes/upload`，multipart/form-data，
 * 字段名 `file` —— 与 `apps/web/src/features/capture/upload.ts:69` 同一个形状。
 * 不是 `/api/notes/import` 传路径（那是"选文件夹"那条路，另外单独覆盖一例）。
 *
 * **F1 在 CI 里只能验到 yt-dlp 那一段，验不了真外网。** 详见第 11 节的长注释：
 * 产品自己的 SSRF 防线（`argGuard.ts:validateHttpUrl`）拒绝一切私有/回环地址，
 * 这是**正确的安全行为**，代价是"在 CI 里喂一个本地 HTTP 服务"这件事
 * 必须靠一个解析到回环的**公网形状主机名**才做得到。
 *
 * ## 安全边界（PROTOCOL §9 / §9-bis）
 *
 * · 数据目录一律 `mkdtemp`，`OPENMEMO_POINTER_FILE` 一律重定向到临时目录 ——
 *   本脚本**绝不写** `~/.local/share/openmemo/datadir.json`。
 * · 端口用 198xx 段，避开 :10000（用户的 demo）、17650、以及冷启动审计的 197xx。
 * · **本脚本不修改 hosts 文件、不加 IP 别名、不动任何机器级状态。**
 *   第 11 节需要的那条主机名解析由 workflow 在**一次性 runner** 上准备；
 *   解析不到时本脚本如实报 SKIPPED 并说明原因，而不是自己去改。
 *   判据照 PROTOCOL §9-bis：把它 `kill -9` 在最坏的那一行，机器上什么都不会留下。
 * · 不用 `pkill`。只 kill 自己 spawn 出来的那个 pid。
 */
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  accessSync,
  readdirSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  spawnDaemon,
  killTree,
  killTreeHard,
  launcherName,
  assertPortFree,
} from './launcher-spawn.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const PORT = Number(arg('--port', '19800'));
const FIXTURE_PORT = Number(arg('--fixture-port', '19801'));
/*
 * `.test` 是 RFC 6761 保留给测试用的 TLD —— 永远不会被真的解析到公网上去。
 *
 * ★ 为什么不能用 `localhost` / `127.0.0.1` / `*.local`：产品的 SSRF 防线
 *   （`packages/pipeline/src/subprocess/argGuard.ts:isPrivateOrReservedHost`）
 *   把它们**全部**拒掉，而那是正确的 —— daemon 自己就绑在 127.0.0.1 上，
 *   放行回环等于把自己变成 confused deputy。所以这里必须是一个**公网形状**的名字。
 *   （顺带一条观测：该函数挡掉了 `.localhost`，但没挡 RFC 6761 的另外三个
 *     `.test` / `.example` / `.invalid`。本脚本正是靠这个缝进去的。风险很低
 *     —— 这三个 TLD 在公网上解析不出东西 —— 但它是个事实，记在这里。）
 */
const FIXTURE_HOST = arg('--fixture-host', 'openmemo-e2e-fixture.test');
const MASK = !argv.includes('--no-mask');
const SKIP_F1 = argv.includes('--skip-f1');
/** 样本裁到几秒。转写耗时与它成正比，而这一步证的是"通不通"不是"准不准"。 */
const CLIP_SECONDS = arg('--clip-seconds', '5');

/*
 * ★ 数据目录一律 `mkdtemp`（PROTOCOL §9：绝不碰机器级的那个数据目录/指针）。
 *   父目录可以用 `--tmp-root` 换掉 —— 不是为了灵活，是因为**共享开发机的 `/tmp`
 *   是 12G tmpfs 且经常被别的 agent 塞满**（本机实测 100%，本脚本因此在第 3 节
 *   拿到一串 `DISK_FULL` 而无法自检）。CI runner 上用默认值即可。
 */
const ROOT = mkdtempSync(join(arg('--tmp-root', tmpdir()), 'openmemo-e2e-import-'));
const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
const MASK_BIN = join(ROOT, 'maskbin');
const FIXTURE_DIR = join(ROOT, 'fixtures');
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(FIXTURE_DIR, { recursive: true });

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

/** 收集所有失败，最后一次性摊开 —— 一次 CI 跑完要能看到全部问题，不是第一个就退。 */
const failures = [];
/** 人为跳过的用例。§11：跳过不许渲染成成功 —— 结论区必须把它喊出来。 */
const skippedOnPurpose = [];
/** 单次 HTTP 调用的上限（§11：一切外部命令带超时）。轮询靠 waitForJob 的圈数兜。 */
const HTTP_TIMEOUT_MS = Number(arg('--http-timeout-ms', '120000'));
const fail = (step, detail) => {
  failures.push({ step, detail });
  say(`   ✘ [${step}] ${detail}`);
};

/* ═════════════════ 0. 宿主基线 ═════════════════ */

hdr('0. 宿主基线（屏蔽之前）—— 不屏蔽就会被悄悄借走的东西');
const HOST_TOOLS = [
  'ffmpeg',
  'ffprobe',
  'yt-dlp',
  'youtube-dl',
  'whisper-cli',
  'sqlite3',
  'python3',
];
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

/* ═════════════════ 1. 屏蔽宿主同名工具 ═════════════════ */

let PATH_FOR_DAEMON = process.env.PATH ?? '';
if (MASK) {
  hdr('1. 屏蔽宿主工具（PATH 最前面放同名假二进制）');
  mkdirSync(MASK_BIN, { recursive: true });
  for (const t of HOST_TOOLS) {
    if (IS_WIN) {
      writeFileSync(
        join(MASK_BIN, `${t}.cmd`),
        `@echo off\r\necho E2E-IMPORT-AUDIT: host '${t}' was invoked - MASKED shim 1>&2\r\nexit /b 127\r\n`,
      );
    }
    const shim = join(MASK_BIN, t);
    writeFileSync(
      shim,
      `#!/bin/sh\necho "E2E-IMPORT-AUDIT: host '${t}' was invoked — MASKED shim, not a real tool" >&2\nexit 127\n`,
    );
    try {
      chmodSync(shim, 0o755);
    } catch {
      /* Windows 上 chmod 是空操作 */
    }
  }
  PATH_FOR_DAEMON = `${MASK_BIN}${delimiter}${PATH_FOR_DAEMON}`;
  say(`   已屏蔽 ${HOST_TOOLS.length} 个名字：${MASK_BIN}`);
  say('   ⚠️ shim 能通过 access(X_OK)，所以"产品会不会去借"照常发生 —— 借到的一执行就带标记失败。');
} else {
  hdr('1. 未屏蔽宿主工具（--no-mask）—— 这一轮的"能用"不能当证据');
}

/* ═════════════════ 2. 起 daemon（用包自带的 Node）═════════════════ */

/*
 * ★★ `--bundle <目录>`：判据必须指向**用户下载的那个东西**。
 *
 *   与 `cold-start-audit.mjs` 逐字沿用同一套：daemon 入口取包里的、解释器取包自带的
 *   Node（宿主上没有 node 正是这个包存在的理由）、网页 bundle 与 SQLite 扩展指向包内。
 */
const BUNDLE = arg('--bundle', null);

/*
 * ★★ **从启动器起 daemon，不再直接起 `dist/main.js`。**
 *
 * 完成度审计查出第四类「CI 结构上看不见」：CI 直接起入口，而用户双击的是
 * `start.cmd` / `OpenMemo.command` / `start.sh`。**凡是只有启动器才做的事，
 * CI 结构上都看不见** —— `OPENMEMO_WEB_DIST` / `OPENMEMO_EXT_DIR` /
 * **`OPENMEMO_BUNDLED_PROBE_DIR`** / 工作目录 / macOS quarantine 那一整套。
 *
 * `[grep 实测]` 探针那个变量此前**四条 e2e 腿一条都没引用过**，
 * 所以探针进包那条修复在启动器路径上是 `[未验证]` —— 而它恰恰只通过启动器生效。
 *
 * 入口与收尾都收进 `./launcher-spawn.mjs`：**这条腿的源码里不再出现 daemon 入口路径**，
 * 于是"又绕回去直接起 main.js"这件事可以被一条没有判断空间的守卫钉住。
 */

const childEnv = {
  ...process.env,
  PATH: PATH_FOR_DAEMON,
  // 与产品默认一致：`authRequired()` 只在 OPENMEMO_AUTH==='token' 时为真，
  // 也就是说**不设**就是不鉴权 —— 这里显式写出来只为确定性，不是放宽。
  OPENMEMO_AUTH: 'none',
  OPENMEMO_DATA_DIR: DATA_DIR,
  // ★ PROTOCOL §9：绝不碰全局指针。
  OPENMEMO_POINTER_FILE: POINTER,
  /*
   * ⚠️ **这里不再预设 OPENMEMO_WEB_DIST / OPENMEMO_EXT_DIR / OPENMEMO_BUNDLED_PROBE_DIR。**
   *   它们归启动器设 —— 预设了就等于又把启动器架空一次，而那正是本轮要修的东西。
   *   （`launcher-spawn.mjs` 的 `assertNoLauncherOverrides()` 会当场拦下。）
   */
};

/**
 * PROTOCOL §11：**探测前先证明这个端口是空的。**
 *
 * 这条协议里点名的三个实例，有一个就是这条腿：健康检查连上了同端口的一个游离
 * daemon，**0.5 秒就报「就绪」**，而它自己拉起的那个已经因端口冲突死了
 * （exit 4）。后面整整一节都在跟别人的进程说话，拿到一串 `DISK_FULL`——
 * 那串错误看起来像产品有毛病，其实是我连错了进程。
 *
 * 此前我修的是**事后**认人（比 `/api/health` 的 pid）。那能抓住，但抓得太晚：
 * 端口被占时该做的是**当场判失败**，而不是先跑起来再检查。所以这里补事前那一半。
 */
/*
 * `assertPortFree` 改用共享实现（裁决 R-2）。本腿原来是"只 bind 不问 HTTP" ——
 * 判据够强，但少一层"谁在占"的诊断信息；共享版把两者都给了。
 */

let proc = null;
let viaLauncher = false;
let daemonLogs = [];
async function startDaemon(label) {
  await assertPortFree(PORT, { label: `启动 [${label}] daemon 之前` });
  const logs = [];
  daemonLogs = logs;
  const started = spawnDaemon({
    bundleDir: BUNDLE,
    repoRoot: REPO,
    args: ['--data-dir', DATA_DIR, '--port', String(PORT)],
    env: childEnv,
  });
  proc = started.proc;
  viaLauncher = started.viaLauncher;
  say(`   [${label}] 起法：${started.note}`);
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/health`);
      /*
       * ★ 只看 res.ok 不够：daemon 在路由表挂上之前 `/api/health` 回的是
       *   **503 + ready:false**，其它路由回 503 SERVICE_STARTING（不是 404）。
       *   在那个窗口里发请求，拿到的错误会看起来像"接口不存在"。
       */
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.ready !== false) {
          /*
           * ★★ 「端口上有东西应答」≠「我起的那个 daemon 起来了」。
           *
           * `[本机实测]` 这一条是被咬出来的，不是想出来的：上一轮跑剩的一个 daemon
           * 还占着 19800，本脚本的健康检查**当场就绿了（0.5s）**，而我 spawn 的那个
           * 因为端口冲突以 exit 4 死了。于是后面整整一节都在跟**别人的 daemon**
           * 说话 —— 它的数据目录我已经 rm 掉了，在一个装满的 tmpfs 上，
           * 于是拿到一串 `DISK_FULL`。那串错误看起来像产品有毛病，
           * 其实是我连错了进程。**假的红灯和假的绿灯一样贵。**
           *
           * 产品自己早就把答案摆在这个端点上了（`server.ts:151-175` 的注释写着
           * 这几个身份字段就是给 EADDRINUSE 之后认人用的）：比 `pid`。
           */
          /*
           * ★★ Windows 上 `proc.pid` 是 **cmd.exe** 的，不是 daemon 的
           *   —— `start.cmd` 没有 exec，node.exe 是它的子进程。
           *   所以那边不能比 pid，否则会把一次正确的启动判成"别人的 daemon"。
           *
           *   POSIX 上启动器最后是 `exec`，shell 把自己换成 node，pid 相同，照比。
           *
           *   两边都比 `dataDir`：它是本轮 `mkdtemp` 出来的**唯一**路径，
           *   别的 daemon 不可能报出同一个 —— 在 Windows 上这就是身份证明本身，
           *   §11 要的"绿灯能追溯到我这次启动的东西"由它承担。
           */
          const canComparePid = !IS_WIN || !viaLauncher;
          if (canComparePid && body?.pid !== undefined && body.pid !== proc.pid) {
            say(`   [${label}] ✘ 端口 ${PORT} 上应答的不是我起的那个 daemon。`);
            say(`      我 spawn 的 pid=${proc.pid}，应答方 pid=${body.pid}`);
            say(`      应答方 dataDir=${body.dataDir}`);
            say(`      本次要的 dataDir=${DATA_DIR}`);
            say('      → 换个 --port，或先收拾掉那个进程。**绝不用 pkill -f**（PROTOCOL）。');
            throw new Error(`port ${PORT} occupied by a foreign daemon (pid=${body.pid})`);
          }
          if (body?.dataDir !== undefined && body.dataDir !== DATA_DIR) {
            say(`   [${label}] ✘ 应答方的 dataDir 不是本次这个：${body.dataDir} ≠ ${DATA_DIR}`);
            throw new Error('daemon answered with a different dataDir');
          }
          say(
            `   [${label}] daemon 就绪（${((i + 1) * 0.5).toFixed(1)}s，pid=${body.pid ?? '?'}，version=${body.version ?? '?'}）`,
          );
          return logs;
        }
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  say(`   [${label}] ✘ daemon 没起来。它的输出：`);
  say(tail(logs, 80));
  throw new Error('daemon did not start');
}
/**
 * PROTOCOL §11：**按 pid 收整棵进程树**，且**绝不用 `pkill -f`**
 * （模式匹配会打到别人的进程，那是另一种越界）。
 *
 * Windows 上 `child.kill()` 只结束直接子进程，孙子进程会留下来继续占着端口 ——
 * 于是下一轮的健康检查又会连上一个"不是我起的"的东西。用 `taskkill /T` 收整棵树。
 */
async function stopDaemon() {
  if (!proc) return;
  const pid = proc.pid;
  /*
   * PROTOCOL §11：按 pid 收**整棵进程树**，绝不 `pkill -f`（模式匹配会打到别人的进程；
   * Manager 2026-08-08 裁决：`pkill -0 -f` 做存在性探测同样不行 —— 这条明线不开例外）。
   * 三个平台的收法不一样，具体见 `launcher-spawn.mjs`：**统一意图，不统一拼写。**
   */
  say(`   收尾：${killTree(pid)}`);
  for (let i = 0; i < 30 && proc.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (proc.exitCode === null) killTreeHard(pid);
  proc = null;
  await new Promise((r) => setTimeout(r, 400));
}

function tail(logs, n) {
  return logs
    .join('')
    .split('\n')
    .slice(-n)
    .map((l) => `      ${l}`)
    .join('\n');
}

/* ── HTTP 小工具 ─────────────────────────────────────────────────────────── */

/*
 * ★ 带重试。冷启动审计里出现过 `fetch failed` 而 daemon 是活着的 ——
 *   Node 全局 fetch 的 keep-alive socket 被对端回收后复用。重试的是**客户端的脆弱**，
 *   不是掩盖产品失败：连续 5 次都失败仍然抛出去。
 */
const j = async (path, init) => {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // §11：一切外部调用带超时。没有超时的步骤既会拖死整条腿，
      // 又会在被杀时把孙子进程留下来 —— 两个后果它一个人全占。
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const text = await res.text();
      try {
        return { status: res.status, headers: res.headers, body: JSON.parse(text) };
      } catch {
        return { status: res.status, headers: res.headers, body: text };
      }
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw new Error(`${path}: ${lastErr?.message ?? 'fetch failed'}（已重试 5 次）`);
};

/** 取二进制（`/media` 用）。返回 Buffer + 状态 + 头。 */
const jbin = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/*
 * ★ 等 job 到终态。字段名是 **`jobId`** —— `cold-start-audit.mjs:349-372` 记着
 *   这个名字被写错过三次的全过程。三个名字都收，但**绝不回退到"随便哪个 job"**。
 */
async function waitForJob(jobId, timeoutSec = 1800) {
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const jr = await j(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (jr.status !== 200) return { state: 'error', text: `轮询得到 HTTP ${jr.status}` };
    const job = jr.body?.job ?? jr.body;
    const gotId = job?.jobId ?? job?.uid ?? job?.id;
    if (!job || gotId !== jobId) {
      return {
        state: 'error',
        text: `端点返回的不是这个 job（要 ${jobId}，拿到 ${gotId}；keys=${JSON.stringify(Object.keys(job ?? {})).slice(0, 200)}）`,
      };
    }
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
      return {
        state: job.state,
        text: `${job.state}${job.error ? ` — ${JSON.stringify(job.error).slice(0, 400)}` : ''}`,
        job,
      };
    }
    /*
     * `blocked` 不是终态，但它**永远不会自己好** —— 缺 ASR 模型/缺工具时 job 就停在这。
     * 一直轮询到超时的话，日志里只有一句 TIMEOUT，看不出是缺东西。当场说清楚。
     */
    if (job.state === 'blocked') {
      return { state: 'blocked', text: `blocked（blockedCode=${job.blockedCode ?? 'null'}）`, job };
    }
  }
  return { state: 'timeout', text: `TIMEOUT（${timeoutSec}s 内没到终态）` };
}

async function jobErrorFull(jobUid) {
  const full = await j(`/api/jobs/${encodeURIComponent(jobUid)}`);
  const err = (full.body?.job ?? full.body)?.error;
  if (!err) return null;
  return JSON.stringify(err, null, 2).slice(0, 6000);
}

/**
 * `media.ready` 的 SSE 事件收集器。
 *
 * ★ 为什么非要收这个：`hasVideo` 这个契约字段此前是**写死的 `false`**，
 *   导入一个 mp4 也报"没有视频"。它一度被判成"零读者可以删"，而那个判断错了 ——
 *   真读者在 `apps/daemon/scripts/e2e-f2.mjs:185` 与 `packages/shared/openapi.yaml`，
 *   `grep` 只扫 `.ts/.tsx` 时看不见。有读者的契约字段必须给真值，
 *   而"真值"只有在**真的导入一个带视频的文件**时才验得出来。
 */
const mediaReady = new Map();
let sseAbort = null;
async function startSse() {
  sseAbort = new AbortController();
  const res = await fetch(`${BASE}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: sseAbort.signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) {
          const ev = /^event:\s*(.+)$/m.exec(f)?.[1]?.trim();
          const dataLine = /^data:\s*(.+)$/m.exec(f)?.[1];
          if (ev !== 'media.ready' || dataLine === undefined) continue;
          try {
            const d = JSON.parse(dataLine);
            if (d?.noteUid) mediaReady.set(d.noteUid, d);
          } catch {
            /* 半个帧，忽略 */
          }
        }
      }
    } catch {
      /* abort 或断流 */
    }
  })();
}

let exitCode = 0;
let fixtureServer = null;
/** 命中记录：谁真的来取过 fixture（判断"是不是 yt-dlp 去取的"唯一硬证据）。 */
const fixtureHits = [];

try {
  hdr('2. 冷启动（全新临时数据目录）');
  if (BUNDLE) {
    say(`   预编译包：${BUNDLE}`);
    // 起法由启动器决定（它自己去找 runtime/node）——这条腿不再自己拼解释器路径。
    say(`   入口 = 启动器 ${launcherName()}（用户双击的就是它），由它 exec 包自带的 Node`);
  } else {
    say(`   ⚠️ 源码树模式（没传 --bundle）—— 这一轮证明不了"用户下载的那个包能用"。`);
  }
  say(`   数据目录：${DATA_DIR}`);
  say(`   指针文件：${POINTER}（不是全局的那个）`);
  await startDaemon('cold');

  /* ═════════════════ 3. 装后端包 ═════════════════ */

  hdr('3. 安装目录里判定为「适用于本机」的后端包（真下载、真校验）');
  const cat = await j('/api/backends/catalog');
  const packs = cat.body?.packs ?? cat.body?.items ?? [];
  const applicable = packs.filter((p) => p.applicable === true);
  say(
    `   目录共 ${packs.length} 个包，适用 ${applicable.length} 个：${applicable.map((p) => p.id).join(', ')}`,
  );

  /*
   * ★ 失败重试一次 —— 但**只对产品自己标了 `retryable:true` 的**。
   *
   *   `[本机实测]` 一轮里 `whispercpp-cpu-linux-x64` 拿到
   *   `{"code":"PROVIDER_UNREACHABLE","retryable":true}`（下载源抖动）。
   *   重试的是网络抖动，不是掩盖产品失败：`retryable:false` 的（比如 DISK_FULL、
   *   CHECKSUM_MISMATCH）**一次都不重试**，那些重试一万遍也还是那个答案。
   */
  async function installPack(id) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      const r = await j('/api/backends/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
      if (!jobId) {
        return `HTTP ${r.status} 且没有 jobId：${JSON.stringify(r.body).slice(0, 200)}`;
      }
      const st = await waitForJob(jobId);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (st.state === 'succeeded' || attempt === 2) return `${st.text}  (${secs}s)`;
      if (st.job?.error?.retryable !== true) return `${st.text}  (${secs}s)  [不可重试]`;
      say(`   ${String(id).padEnd(32)} ${st.text}  (${secs}s)  → 产品标了 retryable，重试一次`);
    }
    return 'unreachable';
  }

  for (const p of applicable) {
    say(`   ${p.id.padEnd(32)} ${await installPack(p.id)}`);
  }

  // ★ 地面真相：不信 job 的自述，直接问"到底装上了哪些"。
  const inst = await j('/api/backends/installed');
  const instArr = Array.isArray(inst.body)
    ? inst.body
    : (inst.body?.packs ?? inst.body?.installed ?? []);
  const installedIds = new Set(instArr.map((x) => x.id ?? x.packId));
  say(`   /api/backends/installed 返回 ${instArr.length} 条：${[...installedIds].join(', ')}`);

  /*
   * ★★ 必需的包没装上，**当场就红**，不要等到四步之后。
   *
   * `[本机实测]` 这一条是被咬出来的：一轮里 whispercpp 包因为下载源抖动没装上，
   * 而产品在找不到 `whisper-cli` 时会**回退到 PATH**（`tools.ts:850` 的
   * `findInBackendPacks(...) ?? fromPath(...)`）。PATH 上放着本脚本的屏蔽 shim，
   * 于是六个用例**全部**失败在
   *   `maskbin/whisper-cli exited with code 127`
   * —— 那一串错误读起来像「转写坏了」，实际是「后端包没装上」。
   * 真正的原因在 60 行之前，而且当时打印过、被淹没了。
   *
   * 这正是本仓反复栽的那个形状：**失败发生的地方与失败显形的地方隔得太远**。
   * 所以在这里立一道闸：缺哪个就说哪个，并说明它会以什么面目在后面爆炸。
   */
  const REQUIRED_PACK_PREFIXES = [
    { prefix: 'media-tools-', why: 'ffmpeg/ffprobe —— 造样本、抽音轨、归一化全靠它' },
    {
      prefix: 'whispercpp-',
      why: 'whisper-cli/whisper-vad —— 没有它转写必失败，而资产要转写成功才落库',
    },
    { prefix: 'ytdlp-', why: 'yt-dlp —— F1 链接导入的取回方' },
  ];
  const missingRequired = REQUIRED_PACK_PREFIXES.filter(
    (r) => ![...installedIds].some((id) => String(id).startsWith(r.prefix)),
  );
  for (const m of missingRequired) {
    fail('3.后端包', `必需的 ${m.prefix}* 没装上 —— ${m.why}`);
  }
  if (missingRequired.length > 0) {
    say('');
    say('   ⚠️ 上面这些包没装上，后面的失败会以**别的面目**出现：');
    say('      产品找不到 whisper-cli 时会回退到 PATH，而 PATH 上是本脚本的屏蔽 shim，');
    say('      于是所有转写都会报 `exited with code 127`。**那不是转写坏了，是这里没装上。**');
  }

  /*
   * ★ F1 的**前置条件**：yt-dlp 是一个独立的包（`ytdlp-<os>-<arch>`）。
   *   它没装上的话，registry 里 YtDlpSource 的 `isAvailable()` 返回 false，
   *   链接导入会以 `422 NO_MEDIA_SOURCE` 结束 —— 那个错误读起来像"这个链接不支持"，
   *   而真正的原因是"组件没装"。所以这里当场把它挑明。
   */
  const ytdlpPack = [...installedIds].find((id) => String(id).startsWith('ytdlp-'));
  if (!ytdlpPack) {
    say('   ⚠️ 已安装列表里没有 ytdlp-* 包 —— F1 走不到 yt-dlp 那一段。');
    say(
      `      目录里有的 ytdlp 包：${
        packs
          .filter((p) => String(p.id).startsWith('ytdlp-'))
          .map((p) => `${p.id}(applicable=${p.applicable})`)
          .join(', ') || '(一个都没有)'
      }`,
    );
  } else {
    say(`   ✔ 站点解析器已安装：${ytdlpPack}`);
  }

  /* ═════════════════ 4. 拉模型 ═════════════════ */

  hdr('4. 拉 VAD + 最小的 whisper.cpp ASR 模型');
  /*
   * ★ 为什么导入流程非要 ASR 模型不可（这一点很容易被读错）：
   *   媒体资产（`media_assets` 那几行、`/media/asset/<uid>` 能播的那个东西）是在
   *   **`pipeline.run()` 返回之后**才落库的（`apps/daemon/src/jobs/runners/transcribe.ts:334-349`），
   *   而 `pipeline.run()` 里面包含转写。也就是说：**转写不成功就没有可播放的资产**。
   *   所以"能播放"这条判据在结构上必须把 ASR 一起跑通，不能只跑到"下载完"。
   */
  const mcat = await j('/api/models/catalog');
  const groups = mcat.body?.groups ?? [];
  const models = groups.flatMap((g) =>
    (g.variants ?? []).map((v) => ({ ...v, role: v.role ?? g.role, tags: v.tags ?? g.tags ?? [] })),
  );
  say(`   /api/models/catalog：${groups.length} 组，展平后 ${models.length} 个条目`);
  if (models.length === 0) {
    say(
      `   ⚠️ 展平后是空的 —— 先怀疑 unwrap 写错了。top-level keys: ${JSON.stringify(Object.keys(mcat.body ?? {}))}`,
    );
  }
  const sizeOf = (m) => (m.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  const pick = models.filter((m) => m.role === 'vad' && sizeOf(m) <= 250 * 1024 * 1024);
  const forWhisper = (m) =>
    (m.engines ?? []).includes('whisper.cpp') || /^asr\/whisper-/.test(String(m.id ?? ''));
  const asr = models
    .filter((m) => m.role === 'asr' && forWhisper(m))
    .map((m) => ({ m, bytes: sizeOf(m) }))
    .filter((x) => x.bytes > 0)
    .sort((a, b) => a.bytes - b.bytes)[0];
  if (!asr) {
    fail('4.模型', '目录里挑不出任何 whisper.cpp 能加载的 asr 模型 —— 先怀疑 unwrap，再怀疑目录');
    for (const m of models.filter((x) => x.role === 'asr').slice(0, 8)) {
      say(`      （role=asr 的有：${m.id} engines=${JSON.stringify(m.engines ?? null)}）`);
    }
  } else {
    say(`   挑中 ASR：${asr.m.id}（${(asr.bytes / 1024 / 1024).toFixed(0)} MB）`);
    pick.push(asr.m);
  }
  for (const m of pick) {
    const t0 = Date.now();
    const r = await j('/api/models/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m.id }),
    });
    const jobId = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    const st = jobId
      ? (await waitForJob(jobId)).text
      : `HTTP ${r.status} 且没有 jobId：${JSON.stringify(r.body).slice(0, 200)}`;
    say(`   ${String(m.id).padEnd(34)} ${st}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  /* ═════════════════ 5. 重启 ═════════════════ */

  hdr('5. 重启 daemon（materializeSqliteExtensions 只在启动时跑）');
  await stopDaemon();
  await startDaemon('warm');
  await startSse();
  const h1 = await j('/api/health');
  const ext = h1.body?.db?.extensions ?? {};
  say(`   tokenizer=${ext.tokenizer}  libsimple=${ext.libsimple}  sqliteVec=${ext.sqliteVec}`);

  /* ═════════════════ 6. 找到产品自己那份 ffmpeg ═════════════════ */

  hdr('6. 定位产品自己下载的 ffmpeg（造样本要用它，且必须证明不是宿主那个）');
  const STORE_ROOT = process.env.OPENMEMO_MODELS ?? join(DATA_DIR, 'models');
  function findUnder(root, name) {
    const want = IS_WIN ? `${name}.exe` : name;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === want) {
          try {
            accessSync(full, fsConstants.X_OK);
            return full;
          } catch {
            /* 不可执行就当没找到 */
          }
        }
      }
    }
    return null;
  }
  const PRODUCT_FFMPEG = findUnder(STORE_ROOT, 'ffmpeg');
  const PRODUCT_YTDLP = findUnder(STORE_ROOT, 'yt-dlp');
  say(`   storeRoot: ${STORE_ROOT}`);
  say(`   ffmpeg   : ${PRODUCT_FFMPEG ?? '(没找到)'}`);
  say(`   yt-dlp   : ${PRODUCT_YTDLP ?? '(没找到)'}`);
  if (!PRODUCT_FFMPEG) {
    fail('6.ffmpeg', `storeRoot 里找不到 ffmpeg —— 后面造不出样本。storeRoot=${STORE_ROOT}`);
  } else if (!PRODUCT_FFMPEG.startsWith(STORE_ROOT)) {
    fail('6.ffmpeg', `找到的 ffmpeg 不在 storeRoot 底下（${PRODUCT_FFMPEG}）—— 这就是"借宿主的"`);
  } else {
    say('   ✔ ffmpeg 在 storeRoot 底下 = 产品自己下载并校验的那一份。');
  }

  /* ═════════════════ 7. 造样本（多容器 / 多编码）═════════════════ */

  hdr('7. 用产品自己的 ffmpeg 造样本 —— 多容器 / 多编码各一个');
  const SAMPLE = join(REPO, 'vendor', 'whisper.cpp', 'samples', 'jfk.wav');
  if (!existsSync(SAMPLE)) {
    fail('7.样本', `源样本不存在：${SAMPLE} —— submodule 没 checkout？`);
  }

  function runSync(bin, args, timeoutMs = 120000) {
    return new Promise((res) => {
      const p = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.on('close', (code) => {
        clearTimeout(t);
        res({ code, out, err });
      });
      p.on('error', (e) => {
        clearTimeout(t);
        res({ code: -1, out, err: String(e) });
      });
    });
  }

  /*
   * 四个样本，覆盖章程 F2 说的"多种容器/编码"：
   *   · wav  — PCM，只有音轨（不转码，最便宜的对照）
   *   · mp3  — MPEG 容器 + libmp3lame，只有音轨
   *   · m4a  — MP4 容器 + AAC，只有音轨（与 mp4 同容器、不同"有没有视频"）
   *   · mp4  — MP4 容器 + H.264 视频 + AAC 音轨，**带视频**
   * 视频轨用 ffmpeg 自己的 testsrc 合成，不需要另找素材。
   */
  const FIXTURE_SPECS = [
    {
      name: 'f2-audio.wav',
      args: (i, o) => ['-y', '-t', CLIP_SECONDS, '-i', i, '-c:a', 'pcm_s16le', o],
      what: 'PCM / WAV / 仅音轨',
    },
    {
      name: 'f2-audio.mp3',
      args: (i, o) => ['-y', '-t', CLIP_SECONDS, '-i', i, '-c:a', 'libmp3lame', '-b:a', '64k', o],
      what: 'MP3 / MPEG / 仅音轨',
    },
    {
      name: 'f2-audio.m4a',
      args: (i, o) => ['-y', '-t', CLIP_SECONDS, '-i', i, '-c:a', 'aac', '-b:a', '64k', o],
      what: 'AAC / MP4 / 仅音轨',
    },
    {
      name: 'f2-video.mp4',
      args: (i, o) => [
        '-y',
        '-t',
        CLIP_SECONDS,
        '-i',
        i,
        '-f',
        'lavfi',
        '-t',
        CLIP_SECONDS,
        '-i',
        'testsrc=size=160x120:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-shortest',
        o,
      ],
      what: 'H.264+AAC / MP4 / **带视频**',
    },
  ];

  const fixtures = [];
  if (PRODUCT_FFMPEG && existsSync(SAMPLE)) {
    for (const spec of FIXTURE_SPECS) {
      const out = join(FIXTURE_DIR, spec.name);
      const r = await runSync(PRODUCT_FFMPEG, spec.args(SAMPLE, out));
      if (r.code !== 0 || !existsSync(out)) {
        fail('7.样本', `造 ${spec.name} 失败（exit=${r.code}）：${r.err.slice(-800)}`);
        continue;
      }
      const buf = readFileSync(out);
      fixtures.push({
        ...spec,
        path: out,
        bytes: buf.length,
        sha: sha256(buf),
        head: buf.subarray(0, 16),
      });
      say(`   ✔ ${spec.name.padEnd(16)} ${String(buf.length).padStart(9)} B  ${spec.what}`);
      say(`      sha256=${sha256(buf)}  magic=${buf.subarray(0, 12).toString('hex')}`);
    }
  }
  if (fixtures.length === 0) fail('7.样本', '一个样本都没造出来 —— F2 无从谈起');

  /* ═════════════════ 8. 播放断言（F1/F2 共用）═════════════════ */

  /**
   * 这是整个脚本的**判据本体**。
   *
   * 判"能播放"不是看数据库里有没有行，是：
   *   ① `/api/notes/:uid` 里有 role=original 且 state=ready 的资产，带 url
   *   ② 整体 GET → 200 + Content-Length 对 + Content-Type 对
   *   ③ **sha256 往返**：吐出来的字节与导进去的文件逐字节相同
   *   ④ `Range: bytes=0-N` → **206** + Content-Range/Content-Length 对 + 字节与文件头相同
   *   ⑤ `Range: bytes=-N`（后缀）→ 206 + 字节与文件尾相同
   *   ⑥ 不可满足的 Range → **416** + `Content-Range: bytes * /size`
   *   ⑦ audio16k 那份也要能取到（播放器的波形/时间轴走的是它）
   *
   * ③ 是最值钱的一条：它同时否掉"落库了但文件丢了"「归档时截断了」「Range 偏移算错了」
   * —— 而这三种在"数据库里有一行"的判据下全是绿的。
   *
   * @param expectSha 期望的 sha256；F1 那边 yt-dlp 可能改容器，传 null 表示只验形状不验相等。
   */
  async function assertPlayable(tag, noteUid, expectSha, expectBytes) {
    const nd = await j(`/api/notes/${encodeURIComponent(noteUid)}`);
    if (nd.status !== 200) {
      fail(
        tag,
        `GET /api/notes/${noteUid} → HTTP ${nd.status}：${JSON.stringify(nd.body).slice(0, 400)}`,
      );
      return false;
    }
    const assets = nd.body?.assets ?? [];
    say(
      `   资产 ${assets.length} 个：${assets.map((a) => `${a.role}(${a.state},${a.bytes ?? '?'}B,${a.mime ?? 'mime=null'})`).join(' ')}`,
    );
    const orig = assets.find((a) => a.role === 'original');
    if (!orig) {
      fail(tag, `没有 role='original' 的资产 —— 媒体没落库。note.status=${nd.body?.status}`);
      return false;
    }
    if (orig.state !== 'ready') {
      fail(tag, `role='original' 的 state=${orig.state}（不是 ready）`);
      return false;
    }
    if (!orig.url) {
      fail(tag, `role='original' 没有 url 字段 —— 网页拿不到播放地址`);
      return false;
    }

    let ok = true;

    // ② + ③ 整体 GET
    const full = await jbin(orig.url);
    const ctype = full.headers.get('content-type');
    const clen = full.headers.get('content-length');
    const aranges = full.headers.get('accept-ranges');
    say(
      `   GET ${orig.url} → ${full.status}  ${full.buf.length} B  Content-Type=${ctype}  Content-Length=${clen}  Accept-Ranges=${aranges}`,
    );
    if (full.status !== 200) {
      fail(
        tag,
        `整体 GET 期望 200，拿到 ${full.status}：${full.buf.subarray(0, 400).toString('utf8')}`,
      );
      ok = false;
    }
    if (full.buf.length === 0) {
      fail(tag, `整体 GET 返回 0 字节 —— 有记录但没有可播放的内容`);
      ok = false;
    }
    if (aranges !== 'bytes') {
      fail(tag, `Accept-Ranges 期望 'bytes'，拿到 ${aranges} —— 播放器无法拖动进度条`);
      ok = false;
    }
    if (clen !== null && Number(clen) !== full.buf.length) {
      fail(tag, `Content-Length=${clen} 与实收 ${full.buf.length} 不符`);
      ok = false;
    }
    const gotSha = sha256(full.buf);
    if (expectSha !== null) {
      if (gotSha !== expectSha) {
        fail(
          tag,
          `★ sha256 往返不符：导入 ${expectSha}（${expectBytes} B），/media 吐出 ${gotSha}（${full.buf.length} B）`,
        );
        ok = false;
      } else {
        say(
          `   ✔ sha256 往返一致（${gotSha.slice(0, 16)}… / ${full.buf.length} B）—— 导进去的字节原样播得出来`,
        );
      }
    } else {
      say(
        `   ⓘ 本例不比对 sha256（yt-dlp 可能改容器）；实收 sha256=${gotSha.slice(0, 16)}… ${full.buf.length} B`,
      );
    }

    const size = full.buf.length;

    // ④ 前缀 Range
    const N = Math.min(1024, size);
    const r1 = await jbin(orig.url, { headers: { Range: `bytes=0-${N - 1}` } });
    const cr1 = r1.headers.get('content-range');
    say(`   Range bytes=0-${N - 1} → ${r1.status}  Content-Range=${cr1}  收到 ${r1.buf.length} B`);
    if (r1.status !== 206) {
      fail(tag, `前缀 Range 期望 206，拿到 ${r1.status} —— 播放器的分段请求会失败`);
      ok = false;
    }
    if (cr1 !== `bytes 0-${N - 1}/${size}`) {
      fail(tag, `Content-Range 期望 'bytes 0-${N - 1}/${size}'，拿到 '${cr1}'`);
      ok = false;
    }
    if (r1.buf.length !== N || !r1.buf.equals(full.buf.subarray(0, N))) {
      fail(tag, `前缀 Range 的字节与整体 GET 的前 ${N} 字节不同（收到 ${r1.buf.length} B）`);
      ok = false;
    }

    // ⑤ 后缀 Range
    const r2 = await jbin(orig.url, { headers: { Range: `bytes=-${N}` } });
    say(
      `   Range bytes=-${N} → ${r2.status}  Content-Range=${r2.headers.get('content-range')}  收到 ${r2.buf.length} B`,
    );
    if (r2.status !== 206) {
      fail(tag, `后缀 Range 期望 206，拿到 ${r2.status}`);
      ok = false;
    } else if (!r2.buf.equals(full.buf.subarray(size - N))) {
      fail(tag, `后缀 Range 的字节与文件尾 ${N} 字节不同`);
      ok = false;
    }

    // ⑥ 不可满足的 Range
    const r3 = await jbin(orig.url, { headers: { Range: `bytes=${size + 100}-` } });
    say(
      `   Range bytes=${size + 100}- → ${r3.status}  Content-Range=${r3.headers.get('content-range')}`,
    );
    if (r3.status !== 416) {
      fail(tag, `越界 Range 期望 416，拿到 ${r3.status}`);
      ok = false;
    }

    // ⑦ audio16k
    const a16 = assets.find((a) => a.role === 'audio16k');
    if (!a16) {
      fail(tag, `没有 role='audio16k' 的资产 —— 波形/时间轴联动（F5）没有素材`);
      ok = false;
    } else {
      const ra = await jbin(a16.url);
      say(
        `   GET audio16k → ${ra.status}  ${ra.buf.length} B  Content-Type=${ra.headers.get('content-type')}`,
      );
      if (ra.status !== 200 || ra.buf.length === 0) {
        fail(tag, `audio16k 取不到（HTTP ${ra.status}，${ra.buf.length} B）`);
        ok = false;
      }
    }

    // 转写文本（次要判据：证明这一单确实走完了整条流水线）
    const tr = await j(`/api/notes/${encodeURIComponent(noteUid)}/transcript`);
    const segs = tr.body?.segments ?? [];
    const text = segs
      .map((s) => String(s.text ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    say(`   转写：${segs.length} 段 / ${text.length} 字符 — ${text.slice(0, 120) || '(空)'}`);

    return ok;
  }

  /* ═════════════════ 9. F2：网页真正走的那条路（multipart 上传）═════════════════ */

  hdr('9. ★ F2 本地媒体导入 —— 走网页真正发的那个请求（multipart 上传）');
  say('   网页用的是 POST /api/notes/upload，FormData 字段名 `file`');
  say('   （apps/web/src/features/capture/upload.ts:69）—— 不是传路径的那条。');
  say('   浏览器读不到真实路径，所以"传路径"那条 API 网页根本用不上。');
  say('');

  /** 手写 multipart/form-data —— 不引依赖，且这样才知道网页那一串字节到底长什么样。 */
  function multipart(fileName, fileBuf, fields = {}) {
    const boundary = `----OpenMemoE2E${Math.random().toString(36).slice(2)}`;
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      fileBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  const results = [];
  for (const fx of fixtures) {
    say('');
    say(`   ── ${fx.name}（${fx.what}）─────────────────────────────────`);
    const buf = readFileSync(fx.path);
    const mp = multipart(fx.name, buf, { language: 'en' });
    const t0 = Date.now();
    const up = await j('/api/notes/upload', {
      method: 'POST',
      headers: { 'content-type': mp.contentType },
      body: mp.body,
    });
    say(
      `   POST /api/notes/upload (${buf.length} B) → HTTP ${up.status} ${JSON.stringify(up.body).slice(0, 300)}`,
    );
    if (up.status !== 202 || !up.body?.noteUid || !up.body?.jobUid) {
      fail(
        `F2:${fx.name}`,
        `上传没排上队：HTTP ${up.status} ${JSON.stringify(up.body).slice(0, 500)}`,
      );
      results.push({ name: fx.name, what: fx.what, ok: false, note: '上传失败' });
      continue;
    }
    const st = await waitForJob(up.body.jobUid);
    say(`   转写 job：${st.text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (st.state !== 'succeeded') {
      const fullErr = await jobErrorFull(up.body.jobUid);
      if (fullErr) {
        say('   ── job.error 全文 ──');
        for (const l of fullErr.split('\n')) say(`      ${l}`);
      }
      say('   ── daemon 最后 40 行 ──');
      say(tail(daemonLogs, 40));
      fail(`F2:${fx.name}`, `job 没成功：${st.text}`);
      results.push({ name: fx.name, what: fx.what, ok: false, note: st.state });
      continue;
    }
    let ok = await assertPlayable(`F2:${fx.name}`, up.body.noteUid, fx.sha, fx.bytes);
    /*
     * ★ `media.ready.hasVideo` 必须说真话：带视频的 mp4 → true，纯音轨 → false。
     *   事件是异步来的，给它一点时间；**收不到就如实说收不到，不当成通过**。
     */
    const wantVideo = fx.name === 'f2-video.mp4';
    let ready = null;
    for (let i = 0; i < 20 && !ready; i++) {
      ready = mediaReady.get(up.body.noteUid) ?? null;
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) {
      say(`   ⚠️ 没收到 media.ready（noteUid=${up.body.noteUid}）—— hasVideo 本例未验证`);
    } else if (ready.hasVideo !== wantVideo) {
      fail(
        `F2:${fx.name}`,
        `media.ready.hasVideo=${ready.hasVideo}，期望 ${wantVideo}（${fx.what}）—— 契约字段在说谎`,
      );
      ok = false;
    } else {
      say(`   ✔ media.ready.hasVideo=${ready.hasVideo}（与"${fx.what}"相符）`);
    }
    results.push({ name: fx.name, what: fx.what, ok, note: ok ? '可播放' : '播放断言失败' });
  }

  /* ═════════════════ 10. F2b：传绝对路径那条（桌面"选文件"路径）═════════════════ */

  hdr('10. F2b：POST /api/notes/import 传绝对路径（"选文件夹"那条路，与上传并存）');
  if (fixtures.length > 0) {
    const fx = fixtures[0];
    /*
     * `importRoots = [dataDir, ...OPENMEMO_IMPORT_ROOTS]`，所以样本必须落进数据目录，
     * 否则 403 PATH_NOT_ALLOWED。这一条**本身**就是要验的东西：
     * Windows 上 `resolve()` 给的是 `C:\...`，而旧代码用 `root + '/'` 拼前缀比对，
     * 结果一个明明在 dataDir 里的文件被判成越界（notes.ts:120-141 记着这次事故）。
     */
    const dest = join(DATA_DIR, `f2b-${fx.name}`);
    writeFileSync(dest, readFileSync(fx.path));
    const imp = await j('/api/notes/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: dest, title: 'F2b 绝对路径导入', language: 'en' }),
    });
    say(
      `   POST /api/notes/import {input:"${dest}"} → HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 300)}`,
    );
    if (imp.status !== 202) {
      fail('F2b', `传绝对路径被拒：HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 500)}`);
      results.push({
        name: 'F2b 绝对路径',
        what: '传路径导入',
        ok: false,
        note: `HTTP ${imp.status}`,
      });
    } else {
      const st = await waitForJob(imp.body.jobUid);
      say(`   转写 job：${st.text}`);
      if (st.state !== 'succeeded') {
        const fullErr = await jobErrorFull(imp.body.jobUid);
        if (fullErr) say(`   job.error 全文：\n${fullErr}`);
        fail('F2b', `job 没成功：${st.text}`);
        results.push({ name: 'F2b 绝对路径', what: '传路径导入', ok: false, note: st.state });
      } else {
        const ok = await assertPlayable('F2b', imp.body.noteUid, fx.sha, fx.bytes);
        results.push({
          name: 'F2b 绝对路径',
          what: '传路径导入',
          ok,
          note: ok ? '可播放' : '播放断言失败',
        });
      }
    }
  } else {
    say('   （没有样本，跳过）');
  }

  /* ═════════════════ 11. F1：链接导入 ═════════════════ */

  hdr('11. ★ F1 链接导入 —— 本地起 HTTP 服务喂真媒体文件，让 yt-dlp 去取');

  /*
   * ── 为什么不能直接喂 `http://127.0.0.1:PORT/x.mp4` ──────────────────────────────
   *
   * 产品自己的 SSRF 防线会拒掉它，而且**这是正确行为**：
   *   `packages/pipeline/src/subprocess/argGuard.ts:isPrivateOrReservedHost`
   *   把 localhost / *.localhost / *.local / *.internal / 127/8 / 10/8 / 192.168/16 /
   *   169.254/16（云元数据）等等全部判为私有 → `validateHttpUrl` 返回 `private_address`。
   *   daemon 自己就绑在 127.0.0.1 上，放行回环等于把产品变成 confused deputy。
   *   **所以这里不能改产品，也不该改产品。**
   *
   * ── 那怎么在不出网的前提下真验这条链路 ──────────────────────────────────────
   *
   * 用一个**公网形状**的主机名（`.test`，RFC 6761 保留给测试，永远不会真的解析到公网），
   * 由 workflow 在一次性 runner 的 hosts 文件里指向 127.0.0.1。于是：
   *
   *   · `validateHttpUrl` 只做**字面**判断 → `openmemo-e2e-fixture.test` 通过 ✔
   *   · DirectHttpSource（score 80）先被试 → 它调 `assertHostNotPrivate()`，
   *     那个会**真的解 DNS** → 解到 127.0.0.1 → 判私有 → 拒绝 → 落到下一个候选
   *   · YtDlpSource（score 10）→ 只做字面判断 → **yt-dlp 真的被 spawn，真的发 HTTP，
   *     真的把字节下下来**
   *
   *   这恰好就是 registry 文档里写的那条 fallback 链（`registry.ts:90-105`：
   *   「先试 DirectHttp，不是直链才落到 yt-dlp」）—— 我们走的是产品设计好的那条路，
   *   不是绕过它。
   *
   * ── 因此，这一节**验到了什么** ─────────────────────────────────────────────────
   *
   *   ✔ 粘链接 → `POST /api/notes/import` → registry 解析 → yt-dlp 子进程真的起来 →
   *     真的建 TCP 连接、发 HTTP GET、把一个**真的媒体文件**下下来 →
   *     ffmpeg 抽音轨 → 落库 → `/media` 的 Range 请求吐出可播放字节
   *   ✔ fixture 服务器会记下每一个请求的 User-Agent —— "到底是不是 yt-dlp 去取的"
   *     这件事有**硬证据**，不是推断
   *
   * ── 以及**验不了什么**（这一段同样是结论）─────────────────────────────────────
   *
   *   ✘ 真 DNS 解析到公网主机、TLS/https 那一段
   *   ✘ yt-dlp 的**站点解析器**（YouTube/Bilibili 的页面解析、签名解密、限速、
   *     年龄/地区/同意墙）—— 这里喂的是直链，走的是 yt-dlp 的 generic 提取器。
   *     **这一段在 CI 上结构性地验不了**：它要求真的访问那些站点，
   *     而那既不可靠（反爬、地区差异）也不合适（CI 去抓视频站）。
   *   ✘ DirectHttpSource 这条**许可证干净**的适配器 —— 它的 `assertHostNotPrivate()`
   *     会解 DNS，本地 fixture 必然被它判私有。也就是说：**用回环 fixture 验 F1，
   *     就只能验到 yt-dlp 那一支，验不到直链那一支。** 二者互斥，不是我漏了。
   */

  if (SKIP_F1) {
    /*
     * PROTOCOL §11「**跳过不许渲染成成功**」。
     *
     * 显式传 `--skip-f1` 是人的选择，不是静默的漏测，所以允许它继续；
     * 但**必须在结论里显形**，不能让一条少跑了 F1 的腿看起来跟跑全了一样绿。
     * 下面第 13 节的总表会把它标成"⊘ 跳过"，而 `skippedOnPurpose` 让结论区
     * 单独再喊一遍 —— 判据是"绿灯要能追溯到它到底验了什么"。
     */
    say('   ⚠️ --skip-f1：本轮**跳过 F1**。这一轮的绿灯不包含链接导入。');
    skippedOnPurpose.push('F1 链接导入（--skip-f1）');
    results.push({
      name: 'F1 链接导入',
      what: 'yt-dlp 取回',
      ok: null,
      note: 'SKIPPED(--skip-f1)',
    });
  } else {
    // ★ 先确认那条主机名解析得到回环。**解析不到就如实报，绝不自己去改 hosts。**
    let resolved = null;
    try {
      resolved = await lookup(FIXTURE_HOST);
    } catch (e) {
      resolved = null;
      say(`   DNS 解析 ${FIXTURE_HOST} 失败：${e.message}`);
    }
    const loopback = resolved && (resolved.address === '127.0.0.1' || resolved.address === '::1');
    say(`   ${FIXTURE_HOST} → ${resolved ? resolved.address : '(解析不到)'}`);

    if (!loopback) {
      /*
       * ★ PROTOCOL §11：这是**非自愿**的跳过 —— 环境没准备好，不是人做的决定。
       *   以前这里只 push 一条 `ok:null` 然后照常 exit 0，也就是
       *   「跳过渲染成了成功」：workflow 里那条 hosts 步骤哪天悄悄坏掉，
       *   这条腿会**继续报绿**，而 F1 一次都没跑过。现在当场判失败。
       */
      fail(
        'F1',
        `fixture 主机名 ${FIXTURE_HOST} 没有指向回环（实测解析到 ${resolved ? resolved.address : '(解析不到)'}）——` +
          ' F1 一次都没跑。这是环境没准备好，不是"本轮不需要"，所以判失败而不是跳过。',
      );
      say('   ⚠️ F1 未执行：这台机器上没有把 fixture 主机名指向回环。');
      say('      本脚本**刻意不去改** hosts 文件 —— 那是机器级状态，改了被 kill 就留在那儿了');
      say('      （PROTOCOL §9-bis）。准备工作由 workflow 在一次性 runner 上做。');
      say(`      需要的一行：127.0.0.1 ${FIXTURE_HOST}`);
      results.push({
        name: 'F1 链接导入',
        what: 'yt-dlp 取回',
        ok: false,
        note: '未执行（主机名没指向回环）→ 判失败，见 §11',
      });
    } else if (!PRODUCT_YTDLP) {
      fail('F1', `storeRoot 里找不到 yt-dlp（${STORE_ROOT}）—— 站点解析器没装上，F1 走不通`);
      results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: 'yt-dlp 没装上' });
    } else if (fixtures.length === 0) {
      fail('F1', '没有样本可喂');
      results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: '没有样本' });
    } else {
      // 喂**带视频的 mp4** —— 它同时覆盖"链接导入"与"从视频里抽音轨"这两件事。
      const served = fixtures.find((f) => f.name === 'f2-video.mp4') ?? fixtures[0];
      const servedBuf = readFileSync(served.path);
      say(`   fixture 文件：${served.name}（${servedBuf.length} B，${served.what}）`);

      fixtureServer = createServer((req, res) => {
        fixtureHits.push({
          method: req.method,
          url: req.url,
          ua: req.headers['user-agent'] ?? '(no UA)',
          range: req.headers.range ?? null,
        });
        say(
          `   [fixture] ${req.method} ${req.url}  UA=${req.headers['user-agent'] ?? '(none)'}  Range=${req.headers.range ?? '-'}`,
        );
        if (!String(req.url).startsWith('/clip.mp4')) {
          res.writeHead(404).end('not found');
          return;
        }
        const total = servedBuf.length;
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (m) {
          const start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
          const end =
            m[1] === '' ? total - 1 : m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
          if (start >= total || start < 0) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
            return;
          }
          const slice = servedBuf.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
          });
          res.end(req.method === 'HEAD' ? undefined : slice);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
        });
        res.end(req.method === 'HEAD' ? undefined : servedBuf);
      });
      /*
       * ★ 绑到**解析出来的那个地址**，不是写死 127.0.0.1。
       *   主机名可能解到 `::1`（本机实测 `localtest.me` 就是），
       *   那时候绑 127.0.0.1 会让 yt-dlp 连 `[::1]:PORT` 吃闭门羹 ——
       *   而错误长得像"产品取不回来"，其实是 fixture 绑错了地址。
       */
      const bindAddr = resolved.address;
      await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, bindAddr, r));
      say(`   fixture 服务器绑在 ${bindAddr}:${FIXTURE_PORT}（对外用 ${FIXTURE_HOST}）`);

      const link = `http://${FIXTURE_HOST}:${FIXTURE_PORT}/clip.mp4`;
      say(`   粘的链接：${link}`);

      /*
       * 先打一次 `/api/notes/probe` —— 这正是网页粘上链接后**立刻**发的那个请求
       * （出标题/时长/缩略图的那一步）。它失败不阻断导入，但它的报错内容是
       * 用户第一眼看到的东西，所以照样记下来。
       */
      const pr = await j('/api/notes/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: link }),
      });
      say(`   POST /api/notes/probe → HTTP ${pr.status} ${JSON.stringify(pr.body).slice(0, 500)}`);
      /*
       * ★ `adapterId` 是**产品自己说的**「这条链接是谁解析的」—— 比任何外部推断都硬。
       *   本机实测这里返回 `"yt-dlp"`，也就是 registry 的 fallback 链确实走到了
       *   GPL 适配器那一支（DirectHttp 先被试、因为 assertHostNotPrivate 解到回环而拒绝）。
       */
      const probeAdapter = pr.body?.adapterId ?? null;
      say(`   ★ 产品说这条链接的解析者是：adapterId=${probeAdapter ?? '(没给)'}`);

      const t0 = Date.now();
      const imp = await j('/api/notes/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: link, title: 'F1 链接导入（CI fixture）', language: 'en' }),
      });
      say(
        `   POST /api/notes/import → HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 300)}`,
      );

      if (imp.status !== 202 || !imp.body?.noteUid || !imp.body?.jobUid) {
        fail(
          'F1',
          `链接导入没排上队：HTTP ${imp.status} ${JSON.stringify(imp.body).slice(0, 500)}`,
        );
        results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: '导入被拒' });
      } else {
        const st = await waitForJob(imp.body.jobUid);
        say(`   转写 job：${st.text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

        say('');
        say(`   ── fixture 服务器收到 ${fixtureHits.length} 个请求（这是"谁去取的"的硬证据）──`);
        for (const h of fixtureHits)
          say(`      ${h.method} ${h.url}  UA=${h.ua}  Range=${h.range ?? '-'}`);
        /*
         * ★★ **不要用 User-Agent 判断取回方。**
         *
         * 第一版就是这么写的（`/yt-dlp|youtube-?dl|python/i`），而本机实测打脸：
         * yt-dlp **默认伪装成浏览器**，而且每次还换一个版本号 ——
         * 实收四条分别是 Chrome/150、145、146、146。也就是说那条断言
         * 会稳定地说"取回方不像 yt-dlp"，**而它明明就是 yt-dlp**。
         * 一条永远给错答案的证据比没有证据更糟。
         *
         * 改用**产品自己的答案**：`/api/notes/probe` 的 `adapterId`。
         * UA 照旧全文打印 —— 它仍然是"到底有没有人来取过"的硬证据，
         * 只是不再拿它回答"是谁"。
         */
        if (fixtureHits.length === 0) {
          fail('F1', '★ fixture 服务器一个请求都没收到 —— 产品根本没去取这个链接');
        } else if (probeAdapter === 'yt-dlp') {
          say(`   ✔ 产品报告 adapterId=yt-dlp，且 fixture 真的被取了 ${fixtureHits.length} 次`);
          say('     —— F1 走的确实是站点解析器那一支（registry fallback 链按设计生效）。');
          say('     ⚠️ UA 全是 Chrome：yt-dlp 默认伪装浏览器且轮换版本号，**UA 不能用来认它**。');
        } else {
          say(
            `   ⓘ 产品报告的解析者是 ${probeAdapter ?? '(没给)'}，不是 yt-dlp —— 见上面 UA 与 probe 原文。`,
          );
        }
        // 顺带记一笔：yt-dlp 对直链是不是原样存盘（观测，不作判据）。
        say(`   ⓘ 喂进去的 fixture sha256=${served.sha}（${servedBuf.length} B）`);

        if (st.state !== 'succeeded') {
          const fullErr = await jobErrorFull(imp.body.jobUid);
          if (fullErr) {
            say('   ── job.error 全文 ──');
            for (const l of fullErr.split('\n')) say(`      ${l}`);
          }
          say('   ── daemon 最后 60 行 ──');
          say(tail(daemonLogs, 60));
          fail('F1', `job 没成功：${st.text}`);
          results.push({ name: 'F1 链接导入', what: 'yt-dlp 取回', ok: false, note: st.state });
        } else {
          /*
           * sha256 传 null：yt-dlp 对直链一般是原样存盘，但 `-f bestaudio/best`
           * 在某些情况下会让它重新封装。**不拿一个可能变化的东西当判据** ——
           * 这里验的是"能不能播"，不是"字节有没有变"。实际 sha 照样打出来。
           */
          const ok = await assertPlayable('F1', imp.body.noteUid, null, null);
          results.push({
            name: 'F1 链接导入',
            what: 'yt-dlp 取回',
            ok,
            note: ok ? '可播放' : '播放断言失败',
          });
        }
      }
    }
  }

  /* ═════════════════ 12. 借宿主工具几个 ═════════════════ */

  hdr('12. ★ 借宿主工具几个（借了就是失败）');
  /*
   * 判据用产品自己的：`/api/selfcheck` 里 `tool.*` 那几项 ——
   *   · ok   = 路径在 storeRoot 底下 = 产品自己下载并校验的
   *   · warn + detail 里提到 PATH = **借的宿主**
   * 不另发明一套。（`selfcheck.ts:390-434`）
   */
  const scr = await j('/api/selfcheck');
  const checks = scr.body?.checks ?? scr.body?.results ?? [];
  const tools = checks.filter((c) => String(c.id).startsWith('tool.'));
  const own = tools.filter((c) => c.status === 'ok');
  const borrowed = tools.filter((c) => c.status === 'warn' && /PATH/i.test(String(c.detail ?? '')));
  const missing = tools.filter(
    (c) => c.status === 'fail' || (c.status === 'warn' && !/PATH/i.test(String(c.detail ?? ''))),
  );
  say(`   /api/selfcheck 共 ${checks.length} 项，其中 tool.* ${tools.length} 项`);
  for (const c of tools) {
    say(
      `     ${String(c.id).padEnd(24)} ${String(c.status).padEnd(6)} ${String(c.detail ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 110)}`,
    );
  }
  say('');
  say(`   ✅ 产品自己下载并校验的 (${own.length})：${own.map((c) => c.id).join(', ') || '(无)'}`);
  say(
    `   ⚠️ **借宿主 PATH 的 (${borrowed.length})**：${borrowed.map((c) => c.id).join(', ') || '(无)'}`,
  );
  say(`   ❌ 装不上/不可用 (${missing.length})：${missing.map((c) => c.id).join(', ') || '(无)'}`);
  if (borrowed.length > 0) {
    fail(
      '12.借用',
      `借了宿主 ${borrowed.length} 个工具：${borrowed.map((c) => c.id).join(', ')} —— 用户机器上不一定有`,
    );
  } else if (tools.length === 0) {
    say('   ⚠️ 一个 tool.* 都没有 —— 判据本身不见了，这比它红更值得查。');
  } else {
    say('   ✔ 一个都没借。');
  }

  /* ═════════════════ 13. 总表 ═════════════════ */

  hdr('13. 总表');
  say('   用例                        形态                              结果');
  say('   ' + '-'.repeat(88));
  for (const r of results) {
    const mark = r.ok === null ? '⊘ 跳过' : r.ok ? '✔ 通过' : '✘ 失败';
    say(`   ${String(r.name).padEnd(26)} ${String(r.what).padEnd(32)} ${mark}  ${r.note}`);
  }
} catch (e) {
  say('');
  say(`✘ E2E 导入审计中断：${e.message}`);
  say(e.stack ?? '');
  if (proc) say(`   daemon 状态：exitCode=${proc.exitCode} signal=${proc.signalCode}`);
  if (daemonLogs.length) {
    say('   daemon 最后 60 行：');
    say(tail(daemonLogs, 60));
  }
  failures.push({ step: 'fatal', detail: e.message });
} finally {
  try {
    sseAbort?.abort();
  } catch {
    /* 已经断了 */
  }
  if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
  await stopDaemon();
  hdr('结论');
  if (failures.length === 0) {
    if (skippedOnPurpose.length > 0) {
      say('   ✔ 已执行的用例全部通过，但**本轮不是全量**：');
      for (const t of skippedOnPurpose) say(`     ⊘ 跳过：${t}`);
      say('     （PROTOCOL §11：跳过不许渲染成成功 —— 这盏绿灯只覆盖上面跑过的那些。）');
    } else {
      say('   ✔ 全部通过。');
    }
  } else {
    exitCode = 1;
    say(`   ✘ ${failures.length} 处失败：`);
    for (const f of failures) say(`     · [${f.step}] ${f.detail}`);
  }
  say('');
  say(`   指针文件用的是 ${POINTER}（不是全局的那个）—— PROTOCOL §9。`);
  say(`   临时根目录 ${ROOT} 留在 runner 上，随 runner 一起销毁。`);
}

process.exit(exitCode);
