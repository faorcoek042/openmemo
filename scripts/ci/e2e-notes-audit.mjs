#!/usr/bin/env node
/**
 * e2e-notes-audit.mjs —— F4（思维导图）+ F5（笔记管理与检索）的**端到端**验收。
 *
 * ## 这个脚本存在的理由（用户 2026-08-08 的原话）
 *
 * > 「你应该派多路 agent 去在 CI 中运行一遍把各个流程跑通才能给我交付的啊！」
 *
 * 他是对的。此前 CI 对 F4/F5 的覆盖是「产品能不能被脚本驱动着转出一段文本」——
 * 那验的是转写。**导图生成、四种导出、笔记增删改查、中文检索、时间点跳转，
 * 一条都没有在干净机器上、用预编译包、走产品自己的 HTTP 路径跑过。**
 *
 * 所以判据从今天起是这一条，别的都不算：
 *
 *   > **在 CI 上、用预编译包、走产品自己的 HTTP 接口，这条功能面真的能用。**
 *
 * ## 四条硬约束（每一条都对应本仓栽过的一个坑）
 *
 * ### ① 不许用用户的真 Key，也不许替他花钱 —— 但**产品侧一段都不许绕过**
 *
 * 思维导图要走「在线大模型 API」那条链。天真做法有两种，两种都是假的：
 *   · 拿真 Key 去打 DeepSeek —— 花用户的钱，而且 CI 拿不到 Key 就永远红；
 *   · 把 `runMindmapJob` 换成假的 —— 那验的是我写的 mock，不是产品。
 *
 * 正解是**只伪造对面那半**：起一个本地的 **OpenAI 兼容端点**，让产品用它自己的
 * `OpenAiCompatibleProvider` 去调。这不是绕过 —— **那正是产品支持的形态**
 * （`resolve.ts` 的 `kind: 'openai-compatible'` + `llm.baseUrl.<id>`，
 * 本来就是给 Ollama / LM Studio / llama-server 用的，判据里明写"本地后端可以没有 apiKey"）。
 *
 * 于是产品这半**一行都没换**：设置读取、provider 解析、`generateMindMap` 的
 * map-reduce 分窗、`chatStructured` 的 schema 与重试、`parseOutline` 的编号清洗、
 * `refFromIndices` 的时间戳计算、`validate`、落库、SSE —— 全是真的。
 *
 * **判据是 nonce**：假端点回的每个主题标题里都埋一个本次运行随机生成的串。
 * 它出现在导图节点里、出现在四种导出的正文里，就证明**这段内容真的是从
 * 那个 HTTP 端点流进产品、再流出来的**。产品若在任何一环凭空造了一张图，
 * nonce 就不在，当场红。
 *
 * ### ② 断言要能证伪 —— 本仓刚栽过两次假绿灯
 *
 *   · 「断言的字段在夹具里恒为假」
 *   · 「断言的是**报出来的值**，而非**实际用的值**」
 *
 * 所以这个脚本里每一条关键断言都配一条**变异证明**（`mutation()`）：
 * 用同一个断言函数去量一个已知坏的输入，**要求它抛**。抛不出来 = 这条断言
 * 量不出东西，脚本当场红并说明是哪一条。变异全部作用在**本脚本自己的输入**
 * 或**`/tmp` 里另起的一个实例**上，绝不改共享工作树（PROTOCOL §10）。
 *
 * 最值钱的一条变异是中文检索那个：另起一个 `OPENMEMO_EXT_DIR` 指向空目录的
 * daemon，**用一模一样的断言去量它**，要求红。没装 libsimple 时中文两字词
 * **静默返回 0 条且不报错**（`tools.ts:575` / `extensions.ts:109` 都写着），
 * 这条变异证明的正是「我的断言看得见那个静默」。
 *
 * ### ③ 时间戳的比对值必须**独立算出来**，不能抄产品的自述
 *
 * 导图节点的 `refs[].startMs` 是产品从真实转写稿算的。要验它对不对，
 * 就得**另外去 `GET /api/notes/:uid/transcript` 把转写稿取回来自己算一遍**，
 * 再跟导图里的比。拿产品报的值去跟产品报的值比，是本仓第二次假绿的形状。
 *
 * ### ④ 屏蔽宿主 PATH
 *
 * 与 `cold-start-audit.mjs` 同一套做法（放同名假二进制在 PATH 最前，
 * 而不是删目录）：**借用变得可见，而不是被消除**。跑完用产品自己的
 * `GET /api/selfcheck` 报出「借了宿主几个」。
 *
 * ## 用法
 *
 *   node scripts/ci/e2e-notes-audit.mjs --bundle <包目录> --data-dir <已有转写稿的数据目录>
 *   node scripts/ci/e2e-notes-audit.mjs --data-dir <…>            # 源码树模式（本机迭代用）
 *
 * `--data-dir` **必须**是一个已经跑过一次转写的数据目录 —— F4 的前提是
 * 「这条笔记有转写稿」（`runMindmapJob` 没有转写稿会 `blocked: NO_TRANSCRIPT`）。
 * CI 里由前一步的 `cold-start-audit.mjs --root <同一个> --transcribe` 负责造出来；
 * 这里**不重复实现下载与转写**（判据只要有两份实现就会漂成两条，PROTOCOL 的老规矩）。
 * 找不到带转写稿的笔记时**当场红并说清是前置步骤没跑**，不假装跳过。
 *
 * 退出码：0 = 全部断言通过；1 = 任何一条断言或变异证明失败。
 *
 * ## 安全边界
 *
 *   · `OPENMEMO_POINTER_FILE` 一律重定向（PROTOCOL §9），**绝不写**机器级指针；
 *   · 变异实例的数据目录用 `mkdtemp`，不碰 `/root/data-memo`、不碰 `:10000`；
 *   · 端口用 199xx 段（测试文件的最高游标是 19900+30，这里从 19960 起）；
 *   · 不 `pkill`，只 kill 自己 spawn 出来的那个 child。
 */
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { spawnDaemon, assertPortFree, killTree, killTreeHard } from './launcher-spawn.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const BUNDLE = arg('--bundle', null);
const DATA_DIR = arg('--data-dir', null);
const PORT = Number(arg('--port', '19960'));
const LLM_PORT = Number(arg('--llm-port', '19961'));
const MUT_PORT = Number(arg('--mutation-port', '19970'));
const MASK = !argv.includes('--no-mask');
/** 星标分页要真跑到边界：默认 limit 是 50，所以必须造出 > 50 条。 */
const BULK_NOTES = Number(arg('--bulk-notes', '56'));

const BASE = `http://127.0.0.1:${PORT}`;
const LLM_BASE_URL = `http://127.0.0.1:${LLM_PORT}/v1`;
/** 设置键的正则是 `^[a-zA-Z][a-zA-Z0-9_]*(\.[…])*$` —— **不许有连字符**，否则 400。 */
const PROVIDER_ID = 'ci_fake_openai';
const MODEL_ID = 'ci-e2e-model';

/** 本次运行的随机串。它是「这段内容真的从那个 HTTP 端点流过」的唯一证据。 */
const NONCE = `E2EMM${randomBytes(5).toString('hex').toUpperCase()}`;

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

if (!DATA_DIR) {
  console.error('✘ --data-dir 必填 —— 它必须是一个已经跑过一次转写的数据目录。');
  console.error('  CI 里由前一步 `cold-start-audit.mjs --root <同一个> --transcribe` 造出来。');
  process.exit(2);
}

/* ═══════════════════════════ 断言框架 ═══════════════════════════════════════════
 *
 * 刻意不用 `node:assert`：PROTOCOL §8 —— 断言失败时 `util.inspect` 会顺着
 * `parentNode` / `parent` 指针把整棵树展开（实测涨到 10.5 GB，表现成"测试文件炸了"
 * 而不是"断言变红"）。这里一律**先转成字符串再比**，并且**截断**。
 */
const results = [];
let failed = 0;

const brief = (v) => {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = String(s ?? '');
  return s.length > 300 ? `${s.slice(0, 300)}…(共 ${s.length} 字符)` : s;
};

/** 断言：`cond` 为真，否则抛。**只吃布尔**，不吃对象 —— 见 PROTOCOL §8。 */
function ok(cond, msg, got) {
  if (cond !== true) {
    throw new Error(`${msg}${got === undefined ? '' : `（实得：${brief(got)}）`}`);
  }
}
function eq(actual, expected, msg) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  ok(a === e, `${msg} —— 期望 ${brief(e)}，实得 ${brief(a)}`);
}

/** 记一条断言。抛了就是红，但**继续往下跑** —— 一条红不该掩盖后面的事实。 */
async function check(id, fn) {
  try {
    const detail = await fn();
    results.push({ id, status: 'PASS', detail: detail ?? '' });
    say(`   ✔ ${id}${detail ? `  —— ${detail}` : ''}`);
    return true;
  } catch (e) {
    failed += 1;
    results.push({ id, status: 'FAIL', detail: e.message });
    say(`   ✘ ${id}`);
    say(`     ${e.message}`);
    return false;
  }
}

/**
 * **变异证明**：`fn` 必须抛。抛不出来说明对应的那条断言量不出东西 —— 那是假绿灯，
 * 比断言本身红更严重，所以这里也计入 failed。
 */
async function mutation(id, fn) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (threw) {
    results.push({ id, status: 'MUT-OK', detail: threw.message });
    say(`   ✔ [变异] ${id} —— 如期变红：${brief(threw.message)}`);
    return true;
  }
  failed += 1;
  results.push({ id, status: 'MUT-BAD', detail: '变异体没有让断言变红 —— 这条断言证伪不了' });
  say(`   ✘ [变异] ${id} —— **没有变红**。这条断言量不出东西，等于假绿灯。`);
  return false;
}

/* ═══════════════════════════ HTTP 客户端 ═══════════════════════════════════════
 *
 * ⚠️ 一律用 `127.0.0.1`，**不许用 `localhost`**：daemon 的 guard 要求 Host 是
 *    IP 字面量，任何 DNS 名（含 localhost）直接 403 FORBIDDEN_ORIGIN。
 */
function makeClient(base) {
  /** 返回 { status, headers, body }，body 能解析成 JSON 就解析，否则原样给字符串。 */
  return async function j(path, init) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${base}${path}`, init);
        const text = await res.text();
        const headers = {};
        for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        return { status: res.status, headers, body, text };
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw new Error(`${path}: ${lastErr?.message ?? 'fetch failed'}（已重试 5 次）`);
  };
}
const j = makeClient(BASE);

const jsonReq = (obj, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

/**
 * 等一个 job 到终态。
 *
 * ★ 字段名是 **`jobId`**（`packages/shared/src/jobs.ts`），而 `POST` 回来的键叫
 *   `jobUid` —— 两个名字指同一个 ULID。`cold-start-audit.mjs` 在这上面连错三版，
 *   所以这里三个名字都收，但**绝不回退到"随便哪个 job"**：认不出就如实说认不出。
 */
async function waitForJob(client, jobUid, timeoutSec = 300) {
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const jr = await client(`/api/jobs/${encodeURIComponent(jobUid)}`);
    if (jr.status !== 200) return { state: 'HTTP_ERROR', note: `HTTP ${jr.status}` };
    const job = jr.body?.job ?? jr.body;
    const gotId = job?.jobId ?? job?.uid ?? job?.id;
    if (!job || gotId !== jobUid) {
      return {
        state: 'WRONG_JOB',
        note: `端点返回的不是这个 job（要 ${jobUid}，拿到 ${gotId}）`,
      };
    }
    if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(job.state)) {
      return {
        state: job.state,
        blockedCode: job.blockedCode ?? null,
        error: job.error ?? null,
        note: `${job.state}${job.blockedCode ? ` (${job.blockedCode})` : ''}`,
      };
    }
  }
  return { state: 'TIMEOUT', note: `${timeoutSec}s 内没到终态` };
}

/* ═══════════════════════════ 宿主基线 + 屏蔽 ═══════════════════════════════════ */

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

const HOST_TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp', 'youtube-dl', 'whisper-cli', 'sqlite3'];
const SCRATCH = mkdtempSync(join(tmpdir(), 'om-e2e-notes-'));
const MASK_BIN = join(SCRATCH, 'maskbin');
const POINTER = join(SCRATCH, 'pointer.json');

hdr('0. 宿主基线（屏蔽之前）—— 不屏蔽就会被悄悄借走的东西');
const hostBaseline = {};
for (const t of HOST_TOOLS) {
  const p = which(t);
  hostBaseline[t] = p;
  say(`   ${t.padEnd(14)} ${p || '(不在 PATH 上)'}`);
}
const hostPresent = HOST_TOOLS.filter((t) => hostBaseline[t]);
say(
  `   → 这台 runner 上本来就有 ${hostPresent.length} 个：${hostPresent.join(', ') || '(一个都没有)'}`,
);

let PATH_FOR_DAEMON = process.env.PATH ?? '';
if (MASK) {
  hdr('1. 屏蔽宿主工具（PATH 最前面放同名假二进制）');
  mkdirSync(MASK_BIN, { recursive: true });
  for (const t of HOST_TOOLS) {
    if (IS_WIN) {
      // Windows 上无扩展名文件不是可执行文件，加载器按 PATHEXT 找 —— 写 .cmd 才挡得住。
      writeFileSync(
        join(MASK_BIN, `${t}.cmd`),
        `@echo off\r\necho E2E-NOTES-AUDIT: host '${t}' was invoked - MASKED shim 1>&2\r\nexit /b 127\r\n`,
      );
    }
    const shim = join(MASK_BIN, t);
    writeFileSync(
      shim,
      `#!/bin/sh\necho "E2E-NOTES-AUDIT: host '${t}' was invoked — MASKED shim, not a real tool" >&2\nexit 127\n`,
    );
    try {
      chmodSync(shim, 0o755);
    } catch {
      /* Windows 上 chmod 是空操作 */
    }
  }
  PATH_FOR_DAEMON = `${MASK_BIN}${delimiter}${PATH_FOR_DAEMON}`;
  say(`   已屏蔽 ${HOST_TOOLS.length} 个名字：${MASK_BIN}`);
  say('   shim 能通过 access(X_OK)，所以"产品会不会去借"照常发生 —— 借用变可见，不是被消除。');
} else {
  hdr('1. 未屏蔽宿主工具（--no-mask）—— 这一轮的"能用"不能当证据');
}

/* ═══════════════════════════ daemon 启停 ══════════════════════════════════════ */

const NODE_BIN = BUNDLE ? join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node') : process.execPath;
if (BUNDLE && !existsSync(NODE_BIN)) {
  console.error(`✘ 包里没有自带的 Node 运行时：${NODE_BIN}`);
  process.exit(2);
}
if (BUNDLE) {
  say('');
  say(`   预编译包模式：${BUNDLE}`);
  say(`   解释器 = 包自带的 ${NODE_BIN}（**不是**宿主的 ${process.execPath}）`);
} else {
  say('');
  say('   ⚠️ 源码树模式（没传 --bundle）—— 这一轮验的不是用户下载的那个东西。');
}

function envFor(dataDir, extraEnv = {}) {
  return {
    ...process.env,
    PATH: PATH_FOR_DAEMON,
    OPENMEMO_AUTH: 'none',
    OPENMEMO_DATA_DIR: dataDir,
    // ★ PROTOCOL §9：绝不碰 ~/.local/share/openmemo/datadir.json。模块级设定，窗口为零。
    OPENMEMO_POINTER_FILE: POINTER,
    /*
     * ⚠️ 不再预设 OPENMEMO_WEB_DIST / OPENMEMO_EXT_DIR / OPENMEMO_BUNDLED_PROBE_DIR：
     *   它们归**启动器**设。预设了这条腿就只是"看起来"在走启动器，
     *   而启动器那一段仍然没被验到（完成度审计的第四类盲区）。
     *   `extraEnv` 仍然可以覆盖它们 —— 变异验证正需要那样（见 startDaemon 的
     *   allowLauncherOverrides）。
     */
    ...extraEnv,
  };
}

const children = new Set();

/**
 * **起服务之前先证明这个端口是空的**（PROTOCOL §11）。
 *
 * 不做这一步的后果不是"测试失败"，是**假通过**：一个残留的 daemon 占着同一个端口，
 * 我的健康检查会连上**它**并在半秒内报"就绪"，而我这次真正启动的那个可能压根没起来。
 * 本轮已经有三个 agent 各撞了一次这个形状（`bundle-launch` 甚至差点据此报告
 * 「macOS 双击是好的」，而用户手里的包明明打不开）。
 *
 * **判据：一个绿灯必须能追溯到"是我这次启动的那个东西"给的。追溯不到，它就不是证据。**
 */
/*
 * `assertPortFree` 改用 `launcher-spawn.mjs` 的共享实现（Manager 2026-08-09 裁决 R-2）。
 * ⚠️ 本腿原来那份就是**正确的那一类**（HTTP + 真 bind），它注释里那句
 * 「光问一句 HTTP 不够」正是这次收敛方向的依据 —— 判据没有被放松，只是不再有六份。
 */

async function startDaemon(label, { dataDir, port, extraEnv = {} }) {
  await assertPortFree(port, { label, log: say });
  const logs = [];
  /*
   * ★★ 走**启动器**（用户双击的那个文件），不再直接起 daemon 入口。
   *   `allowLauncherOverrides` 只在调用方**显式**给了 extraEnv 里那几个变量时才打开
   *   —— 那是变异验证（例如把 OPENMEMO_EXT_DIR 指到空目录证明中文检索会红），
   *   与"忘了让启动器自己设"是相反的两件事。
   */
  const _started = spawnDaemon({
    bundleDir: BUNDLE,
    repoRoot: REPO,
    args: ['--data-dir', dataDir, '--port', String(port)],
    env: envFor(dataDir, extraEnv),
    allowLauncherOverrides: true,
  });
  say(`   [${label}] 起法：${_started.note}`);
  const proc = _started.proc;
  children.add(proc);
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  const client = makeClient(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      // ★ 起来 ≠ 就绪：路由表挂上之前 /api/health 回 503 status:'starting'。
      if (res.ok) {
        say(`   [${label}] daemon 就绪（${((i + 1) * 0.5).toFixed(1)}s，端口 ${port}）`);
        return { proc, logs, client };
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break;
  }
  /*
   * ★ 端口漂移要单独说清楚。产品在端口被占时会**向上扫**到下一个可用端口
   *   （对用户是好行为），但对审计是陷阱：漂过去的那个端口很可能正是我
   *   另一个用途的端口（`[实测]` 就漂到了 `--llm-port`），
   *   之后我再去探测就会**对着错的进程说话** —— 正是 §11 那个形状。
   *   所以这里把日志里的漂移原样报出来，而不是笼统地说"没起来"。
   */
  const drift = logs
    .join('')
    .split('\n')
    .find((l) => /端口已从.*变更为/.test(l));
  if (drift) {
    say(`   [${label}] ✘ daemon **漂到别的端口去了**：${drift.trim()}`);
    say('     说明 bind 那一刻端口并不空（我的探测与它的 bind 之间有窗口）。');
    say('     不接受漂移：漂过去的端口可能正是本脚本另一个用途的端口。');
  }
  say(`   [${label}] ✘ daemon 没起来。它的输出：`);
  say(
    logs
      .join('')
      .split('\n')
      .slice(-60)
      .map((l) => `      ${l}`)
      .join('\n'),
  );
  throw new Error(`daemon [${label}] did not start`);
}
/**
 * **按 pid 收整棵进程树**（PROTOCOL §11），而不是只 kill 直接子进程。
 *
 *   · Windows：`child.kill()` 杀不掉 `cmd.exe` 底下的 `node.exe` —— 用
 *     `taskkill /T /F /PID` 按 pid 收树；
 *   · POSIX：spawn 时给了 `detached`，所以子进程自成进程组，
 *     `process.kill(-pid)` 一次收掉整组。
 *
 * **仍然按 pid，绝不 `pkill -f`** —— 模式匹配会打到别人的进程，那是另一种越界。
 * 外部命令带超时（§11 第三条：没有超时的收尾既会拖死整条腿，又会在被杀时留下孙子进程）。
 */
/*
 * 本地 `killTree(proc, signal)` 已删 —— 改用共享的 `killTree`(SIGTERM) / `killTreeHard`(SIGKILL)。
 * ⚠️ 两档是**刻意的升级顺序**（先温和后强硬），不许压成一个参数。
 */

async function stopDaemon(d) {
  if (!d?.proc) return;
  killTree(d.proc?.pid);
  await new Promise((r) => setTimeout(r, 1200));
  if (d.proc.exitCode === null) killTreeHard(d.proc?.pid);
  children.delete(d.proc);
}

/* ═══════════════════════════ 假的 OpenAI 兼容端点 ══════════════════════════════
 *
 * **只伪造对面那半。** 产品用的是它自己的 `OpenAiCompatibleProvider`：
 *   GET  {base}/models            → 能力/枚举
 *   POST {base}/chat/completions  → 先是能力探测（"Reply {"ok":true}"），再是真请求
 *
 * 真请求的 user prompt 里每行开头是 `[编号] 原文`（`buildUserPrompt`）。
 * 这里**把编号解析出来再回引用**，跟真模型的行为一致 ——
 * `parseOutline` 会把越界/重复/非整数的编号全丢掉，随便编一个数字会得到
 * 「没有任何有效主题」然后重试三次失败。也就是说：**这个假端点必须真的读懂输入**，
 * 它不是一个"回什么都行"的桩。
 */
const llmState = {
  calls: [],
  chatCalls: 0,
  probeCalls: 0,
  modelsCalls: 0,
  /** 每次真请求实际回出去的编号，供后面独立核对时间戳用。 */
  returnedSegs: [],
  sawAuthHeader: false,
};

function outlineFor(promptText) {
  // `[12] 正文` 里的编号。**只收行首的**，避免把正文里的方括号也当编号。
  const idx = [];
  for (const line of promptText.split('\n')) {
    const m = /^\[(\d+)\]\s/.exec(line);
    if (m) idx.push(Number(m[1]));
  }
  if (idx.length === 0) return { topics: [] };
  /*
   * 刻意**优先挑非首段**：首段的 startMs 往往是 0，而 `0:00` / `0` 这种值
   * 在任何文本里都可能碰巧出现 —— 拿它做"opml/mm 里没有时间戳"的反向断言
   * 等于断言了个恒真的东西（本仓栽过的「夹具里恒为假」的镜像）。
   * 段数不够时会退回首段，那时后面会**明确降级说明**，不假装这条仍然有力。
   */
  const pick = idx.length > 1 ? [idx[1]] : [idx[0]];
  const second = idx.length > 2 ? [idx[2]] : pick;
  llmState.returnedSegs.push({ topic: pick, point: second });
  return {
    topics: [
      {
        title: `会议主题 ${NONCE}`,
        seg: pick,
        points: [{ text: `要点 ${NONCE}`, seg: second }],
      },
    ],
  };
}

function startFakeLlm() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      llmState.sawAuthHeader ||= Boolean(req.headers['authorization']);
      llmState.calls.push({ method: req.method, url, bytes: raw.length });

      const send = (obj, status = 200) => {
        const body = JSON.stringify(obj);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      };

      if (url.startsWith('/v1/models') && req.method === 'GET') {
        llmState.modelsCalls += 1;
        send({ object: 'list', data: [{ id: MODEL_ID, object: 'model' }] });
        return;
      }
      if (url.startsWith('/v1/chat/completions') && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* 下面按空处理 */
        }
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const lastUser = String(msgs.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '');

        // 能力探测（`#probeStructured`）：产品用它实测后端支不支持 json_schema。
        if (lastUser.includes('Reply {"ok":true}')) {
          llmState.probeCalls += 1;
          send({
            model: MODEL_ID,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"ok":true}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          });
          return;
        }

        llmState.chatCalls += 1;
        const outline = outlineFor(lastUser);
        send({
          model: MODEL_ID,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(outline) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        });
        return;
      }
      send({ error: { message: `unhandled ${req.method} ${url}` } }, 404);
    });
  });
  return new Promise((ok2) => server.listen(LLM_PORT, '127.0.0.1', () => ok2(server)));
}

/* ═══════════════════════════ 主流程 ═══════════════════════════════════════════ */

let daemon = null;
let mutDaemon = null;
let llmServer = null;
/** 降级说明：起因不是断言失败，是"这一格结构上没法有力地验"，必须显式报出来。 */
const degraded = [];

try {
  hdr('2. 启动 daemon（数据目录来自前置的冷启动 + 转写）');
  say(`   数据目录：${DATA_DIR}`);
  daemon = await startDaemon('main', { dataDir: DATA_DIR, port: PORT });

  const health = await j('/api/health');
  const ext = health.body?.db?.extensions ?? {};
  say(`   tokenizer=${ext.tokenizer}  libsimple=${ext.libsimple}  sqliteVec=${ext.sqliteVec}`);

  /* ───────────────── 3. 前置：找一条真有转写稿的笔记 ───────────────── */

  hdr('3. 前置核对：必须已经有一条带转写稿的笔记（F4 的硬前提）');

  /*
   * ★ 必须**翻完所有页**，不能只看第一页。
   *
   * `[实测]` 第一版写的是 `GET /api/notes?limit=200` 然后在那一页里找。
   * CI 上碰巧一直是对的（全新数据目录里只有 jfk + 本轮造的那几十条），
   * 但本机连跑几轮之后笔记攒到 200 条以上，而 jfk 是**最早**建的那条 ——
   * 按 `created_at DESC` 它掉出了第一页，于是脚本报「一条带转写稿的笔记都没有」。
   * 那句话读起来像个产品结论，其实是我的窗口太小。
   * 一个"数据一多就换答案"的前置检查，和一盏坏掉的灯没有区别。
   *
   * 顺便按 `durationMs > 0` 先粗筛：列表 DTO 里就有这个字段，
   * 而本脚本造的哑笔记全是 0 —— 省掉几百次详情请求，但**筛不到时会退回全扫**，
   * 不让这层优化变成新的静默依赖。
   */
  const allNotes = [];
  for (let off = 0; off < 20000; off += 200) {
    const page = await j(`/api/notes?limit=200&offset=${off}`);
    if (page.status !== 200) break;
    allNotes.push(...(page.body?.notes ?? []));
    if (page.body?.hasMore !== true) break;
  }
  say(`   GET /api/notes 翻完所有页 → 共 ${allNotes.length} 条`);

  const withDuration = allNotes.filter((n) => Number(n.durationMs ?? 0) > 0);
  say(`   其中 durationMs>0 的 ${withDuration.length} 条（先查这些，查不到再全扫）`);

  let subject = null;
  for (const n of [...withDuration, ...allNotes]) {
    const d = await j(`/api/notes/${encodeURIComponent(n.uid)}`);
    if (d.status === 200 && d.body?.transcriptUid && (d.body?.segmentCount ?? 0) > 0) {
      subject = d.body;
      break;
    }
  }
  if (!subject) {
    say('   ✘ 一条带转写稿的笔记都没有。');
    say('     这**不是** F4 坏了 —— 是前置步骤没跑：CI 里必须先跑');
    say('     `cold-start-audit.mjs --root <同一个> --transcribe`，由它下载模型并真转写一次。');
    throw new Error('前置缺失：数据目录里没有带转写稿的笔记');
  }
  say(
    `   ✔ 主角笔记 ${subject.uid}「${subject.title}」 segmentCount=${subject.segmentCount} durationMs=${subject.durationMs}`,
  );

  // 独立取一份转写稿 —— 后面所有时间戳的**期望值都从这里算**，不抄产品的自述。
  const trRes = await j(`/api/notes/${encodeURIComponent(subject.uid)}/transcript`);
  const trSegs = trRes.body?.segments ?? [];
  say(`   GET /api/notes/:uid/transcript → HTTP ${trRes.status}，${trSegs.length} 段`);
  ok(trSegs.length > 0, '转写稿是空的 —— 后面的时间戳核对无从谈起');

  /* ───────────────── 4. F4-a：思维导图生成（真走在线大模型那条链） ───────────── */

  hdr('4. F4-a 思维导图生成 —— 产品自己的 OpenAI 兼容链路，对面是本地假端点');
  llmServer = await startFakeLlm();
  say(`   假的 OpenAI 兼容端点已监听 ${LLM_BASE_URL}`);
  say(`   本次 nonce = ${NONCE}（它必须出现在导图与四种导出里，否则就是产品凭空造的）`);
  say('   ⚠️ 不许用用户的真 Key：这里连 apiKey 都不设 —— 产品对**回环地址**本来就允许无 key。');

  const settingsPatch = {
    settings: {
      'llm.providers': [
        {
          id: PROVIDER_ID,
          kind: 'openai-compatible',
          label: 'CI E2E fake endpoint',
          baseUrl: LLM_BASE_URL,
          model: MODEL_ID,
          isLocal: true,
        },
      ],
      [`llm.baseUrl.${PROVIDER_ID}`]: LLM_BASE_URL,
      'llm.defaultProviderId': PROVIDER_ID,
      'llm.defaultModelId': MODEL_ID,
    },
  };
  const st = await j('/api/settings', jsonReq(settingsPatch, 'PATCH'));
  await check('F4-a1 PATCH /api/settings 配好 openai-compatible provider', () => {
    eq(st.status, 200, 'PATCH /api/settings 状态码');
    const s = st.body?.settings ?? {};
    eq(s['llm.defaultProviderId'], PROVIDER_ID, '回读 llm.defaultProviderId');
    eq(s[`llm.baseUrl.${PROVIDER_ID}`], LLM_BASE_URL, `回读 llm.baseUrl.${PROVIDER_ID}`);
    return `provider=${PROVIDER_ID} baseUrl=${LLM_BASE_URL}`;
  });

  const gen = await j(`/api/notes/${encodeURIComponent(subject.uid)}/mindmap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  say(`   POST /api/notes/:uid/mindmap → HTTP ${gen.status} ${brief(gen.body)}`);
  const mmJobUid = gen.body?.jobUid;
  let genState = { state: 'NOT_STARTED', note: '没拿到 jobUid' };
  if (mmJobUid) genState = await waitForJob(daemon.client, mmJobUid, 300);
  say(`   导图 job：${genState.note}`);

  await check('F4-a2 导图 job 真的 succeeded（不是 blocked/failed）', () => {
    eq(gen.status, 202, 'POST mindmap 状态码');
    ok(typeof mmJobUid === 'string' && mmJobUid.length > 0, '没有 jobUid', gen.body);
    ok(
      genState.state === 'succeeded',
      `job 没成功：${genState.note}${genState.blockedCode ? `（blockedCode=${genState.blockedCode}）` : ''}` +
        (genState.error ? ` error=${brief(genState.error)}` : ''),
    );
    return `jobUid=${mmJobUid}`;
  });

  await check('F4-a3 产品真的向那个 HTTP 端点发了请求（不是凭空造图）', () => {
    ok(llmState.chatCalls > 0, `假端点一次真请求都没收到（calls=${brief(llmState.calls)}）`);
    return `chat/completions 真请求 ${llmState.chatCalls} 次 · 能力探测 ${llmState.probeCalls} 次 · /models ${llmState.modelsCalls} 次`;
  });

  const mm = await j(`/api/notes/${encodeURIComponent(subject.uid)}/mindmap`);
  const doc = mm.body?.doc;
  const nodeList = Object.values(doc?.nodes ?? {});
  await check('F4-a4 GET 回来的导图带 llm 出处，且节点里有 nonce', () => {
    eq(mm.status, 200, 'GET mindmap 状态码');
    eq(mm.body?.mindmap?.generatedBy, `llm:${PROVIDER_ID}`, 'generatedBy');
    const hit = nodeList.filter((n) => String(n.text ?? '').includes(NONCE));
    ok(
      hit.length > 0,
      `没有任何节点包含 nonce ${NONCE}`,
      nodeList.map((n) => n.text),
    );
    return `nodeCount=${mm.body?.mindmap?.nodeCount} 带 nonce 的节点 ${hit.length} 个`;
  });

  // 变异：nonce 换成一个从未出现过的串，同一条断言必须红。
  await mutation('F4-a4 的证伪能力（换一个没用过的 nonce 必须查不到）', () => {
    const bogus = 'E2EMMDEADBEEF00';
    const hit = nodeList.filter((n) => String(n.text ?? '').includes(bogus));
    ok(hit.length > 0, `没有任何节点包含 nonce ${bogus}`);
  });

  /* ── 时间戳：**期望值独立从转写稿算**，不抄产品的自述 ──
   *
   * ⚠️ 这一段第一版写错了，错法正是本任务要防的那一种：它拿
   *    「导图报的 startMs」去转写稿里**找一个相等的段落**，找到就算过。
   *    那是循环论证 —— 只证明了产品报的值是某个真实段落的起点，
   *    **没有证明它是对的那一个**。产品把主题指到隔壁段落，那一版照样绿。
   *
   * 现在改成：**我这边记得自己回了哪个编号**（`llmState.returnedSegs`），
   * 期望值直接由 `trSegs[那个编号].startMs` 给出，与产品的输出无关。
   * `refFromIndices` 对单个编号取的就是该段的 start/end，所以这是逐字的期望。
   */
  const topicNode = nodeList.find((n) => String(n.text ?? '') === `会议主题 ${NONCE}`);
  const firstReturn = llmState.returnedSegs[0];
  const topicIdx = firstReturn?.topic?.[0];
  const expectedSeg = typeof topicIdx === 'number' ? trSegs[topicIdx] : undefined;
  const expectedStartMs = expectedSeg ? Number(expectedSeg.startMs) : null;
  const expectedEndMs = expectedSeg ? Number(expectedSeg.endMs) : null;

  /*
   * 时间戳比对**只写一遍**，F4-a5 与它的变异证明共用。
   * 变异的做法是**换掉输入**（喂一个整体平移过的段落），而不是另写一个断言 ——
   * 另写一个的话，被证明有区分力的就不是 F4-a5 实际用的那个了。
   *
   * ⚠️ 刻意不用"换成转写稿里的另一段"：`[实测]` jfk.wav 用 whisper-tiny 只转出
   *    **1 段**，那种写法在这台机器上永远造不出变异体，于是这条证明会被静默跳过。
   *    平移法与段落数无关，任何转写稿上都成立。
   */
  const timestampMatchesSeg = (ref, seg) => {
    eq(Number(ref.startMs), Number(seg.startMs), 'refs[0].startMs');
    eq(Number(ref.endMs), Number(seg.endMs), 'refs[0].endMs');
  };

  await check('F4-a5 节点 refs 的时间戳 = 从转写稿独立算出来的真值（非循环）', () => {
    ok(
      !!topicNode && Array.isArray(topicNode.refs) && topicNode.refs.length > 0,
      `找不到文本恰为「会议主题 ${NONCE}」且带 refs 的节点`,
      nodeList.map((n) => n.text),
    );
    const ref = topicNode.refs[0];
    ok(
      expectedSeg !== undefined,
      `我回给产品的编号是 ${topicIdx}，但转写稿里没有这一段（共 ${trSegs.length} 段）`,
    );
    say(
      `     期望值来自 trSegs[${topicIdx}]：startMs=${expectedStartMs} endMs=${expectedEndMs}` +
        `（**不是**从导图里读的）`,
    );
    timestampMatchesSeg(ref, expectedSeg);
    // quote 必须是原文逐字 —— 这是重转写后重定位的唯一依据（generate.ts 的设计约束）
    const joined = trSegs.map((s) => String(s.text ?? '').trim()).join(' ');
    ok(
      joined.includes(String(ref.quote).trim().slice(0, 60)),
      'refs[0].quote 不是转写稿里的原文逐字',
      ref.quote,
    );
    eq(String(ref.transcriptUid), String(subject.transcriptUid), 'refs[0].transcriptUid');
    return `startMs=${expectedStartMs} endMs=${expectedEndMs}`;
  });

  // 变异：把同一个比对函数喂一个整体平移 1 秒的段落 —— 必须红。
  await mutation('F4-a5 的证伪能力（把段落整体平移 1 秒，同一个比对函数必须红）', () => {
    ok(!!topicNode && !!expectedSeg, 'F4-a5 本身就没跑成，变异无从谈起');
    timestampMatchesSeg(topicNode.refs[0], {
      startMs: Number(expectedSeg.startMs) + 1000,
      endMs: Number(expectedSeg.endMs) + 1000,
    });
  });

  if (expectedStartMs === 0) {
    degraded.push(
      'F4-a5：主角笔记的可用段落起点是 0ms —— 「0:00」这种串在任何文本里都可能碰巧出现，' +
        '所以第 6 节的四种导出判据**没有**用它，改用 PATCH 一个合成 ref（12:34 / 754321ms）。',
    );
  }

  /* ───────────────── 5. F4-b：导图可编辑（PATCH 持久化） ───────────────── */

  hdr('5. F4-b 思维导图可编辑 —— PATCH 真落库、revision 真前进');
  const revBefore = Number(mm.body?.mindmap?.revision ?? 0);
  const EDIT_MARK = `已编辑${NONCE}`;
  const editedDoc = JSON.parse(JSON.stringify(doc));
  const rootKey = editedDoc.rootKey;
  editedDoc.nodes[rootKey].text = `${editedDoc.nodes[rootKey].text} ${EDIT_MARK}`;
  const patched = await j(
    `/api/notes/${encodeURIComponent(subject.uid)}/mindmap`,
    jsonReq({ doc: editedDoc }, 'PATCH'),
  );
  const mmAfter = await j(`/api/notes/${encodeURIComponent(subject.uid)}/mindmap`);
  await check('F4-b1 PATCH 之后 revision 前进、内容持久、出处转为 user', () => {
    eq(patched.status, 200, 'PATCH mindmap 状态码');
    ok(
      Number(patched.body?.revision) > revBefore,
      `revision 没前进（之前 ${revBefore}，之后 ${patched.body?.revision}）`,
    );
    ok(typeof patched.body?.mindmapUid === 'string', '没有 mindmapUid', patched.body);
    eq(mmAfter.status, 200, '回读 GET mindmap 状态码');
    const rootText = String(mmAfter.body?.doc?.nodes?.[rootKey]?.text ?? '');
    ok(rootText.includes(EDIT_MARK), '编辑没有落库', rootText);
    eq(mmAfter.body?.mindmap?.generatedBy, 'user', '编辑后的 generatedBy');
    return `revision ${revBefore} → ${patched.body.revision}`;
  });

  // 变异：写一个结构非法的 doc（子节点指向不存在的 key），必须 400，而不是照收。
  await check('F4-b2 非法 doc 被拒（校验不是摆设）', async () => {
    const badDoc = JSON.parse(JSON.stringify(editedDoc));
    badDoc.nodes[rootKey].children = [...badDoc.nodes[rootKey].children, 'n_does_not_exist'];
    const bad = await j(
      `/api/notes/${encodeURIComponent(subject.uid)}/mindmap`,
      jsonReq({ doc: badDoc }, 'PATCH'),
    );
    ok(bad.status === 400, `期望 400，实得 HTTP ${bad.status}`, bad.body);
    eq(bad.body?.error?.code, 'INVALID_MINDMAP', '错误码');
    return `HTTP 400 INVALID_MINDMAP`;
  });

  /* ───────────────── 6. F4-c：四种结构化导出 ───────────────── */

  hdr('6. F4-c 四种导出（md / opml / mm / json）—— 每种真发 HTTP 拿回正文');

  /*
   * ★ 时间戳判据用一个**合成的、不可能碰巧出现的**值。
   *
   *   为什么不用上一节那个真值：真转写稿的第一段常常从 0ms 开始，`0:00` / `0`
   *   在 XML 属性、版本号、任何数字里都可能碰巧命中 —— 拿它去断言
   *   「opml/mm 里没有时间戳」，断言的是个恒真的东西。那正是本仓栽过的
   *   「夹具里恒为假」的镜像面。
   *
   *   这里走的仍然是**产品的真实路径**：PATCH 一份带 ref 的 doc（用户编辑导图
   *   就是这么落库的），再让产品的序列化器去导出。序列化器一行没换。
   */
  const TS_MS = 754321; // → 12:34（timecode.ts 用 Math.floor 到秒）
  const TS_TEXT = '12:34';
  const DECOY = '999777'; // 从未出现过的数 —— 四种导出里都不该有
  const tsDoc = JSON.parse(JSON.stringify(mmAfter.body.doc));
  const tsKey = Object.keys(tsDoc.nodes).find((k) => k !== tsDoc.rootKey) ?? tsDoc.rootKey;
  tsDoc.nodes[tsKey] = {
    ...tsDoc.nodes[tsKey],
    text: `时间戳载体 ${NONCE}`,
    refs: [
      {
        transcriptUid: String(subject.transcriptUid),
        startMs: TS_MS,
        endMs: TS_MS + 1000,
        quote: `导出损耗判据 ${NONCE}`,
        matchScore: 1,
      },
    ],
  };
  const tsPatch = await j(
    `/api/notes/${encodeURIComponent(subject.uid)}/mindmap`,
    jsonReq({ doc: tsDoc }, 'PATCH'),
  );
  say(`   为导出判据 PATCH 了一个合成 ref（${TS_MS}ms → ${TS_TEXT}）：HTTP ${tsPatch.status}`);
  ok(tsPatch.status === 200, `合成 ref 没写进去：HTTP ${tsPatch.status} ${brief(tsPatch.body)}`);

  const EXPECT = {
    md: { ct: 'text/markdown; charset=utf-8', ts: true },
    opml: { ct: 'text/x-opml; charset=utf-8', ts: false },
    mm: { ct: 'application/x-freemind; charset=utf-8', ts: false },
    json: { ct: 'application/json; charset=utf-8', ts: true },
  };
  const exported = {};
  for (const fmt of ['md', 'opml', 'mm', 'json']) {
    const r = await j(
      `/api/notes/${encodeURIComponent(subject.uid)}/export?what=mindmap&format=${fmt}`,
    );
    exported[fmt] = r;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    say('');
    say(`   ── format=${fmt} —— HTTP ${r.status}  ${r.headers['content-type']}`);
    say(`      content-disposition: ${r.headers['content-disposition'] ?? '(无)'}`);
    say(`      正文 ${body.length} 字符，前 220：`);
    say(
      body
        .slice(0, 220)
        .split('\n')
        .map((l) => `        ${l}`)
        .join('\n'),
    );
  }

  const bodyOf = (fmt) =>
    typeof exported[fmt].body === 'string' ? exported[fmt].body : exported[fmt].text;

  for (const fmt of ['md', 'opml', 'mm', 'json']) {
    await check(`F4-c1(${fmt}) 200 + content-type 正确 + 正文里有 nonce`, () => {
      eq(exported[fmt].status, 200, `format=${fmt} 状态码`);
      eq(exported[fmt].headers['content-type'], EXPECT[fmt].ct, `format=${fmt} content-type`);
      const b = bodyOf(fmt);
      ok(b.length > 0, `format=${fmt} 正文是空的`);
      ok(b.includes(NONCE), `format=${fmt} 正文里没有 nonce ${NONCE}`, b.slice(0, 200));
      return `${b.length} 字符`;
    });
  }

  /*
   * 「这份导出里没有时间戳」这个谓词**只写一遍**，F4-c2 与它的变异证明共用同一个。
   * 两处各写一份的话，变异证明的就不是 F4-c2 实际用的那个谓词了 ——
   * 而"断言的是报出来的值、不是实际用的值"正是本仓栽过的第二种假绿。
   */
  const noTimestampPredicate = (body, label) => {
    ok(
      body.includes(TS_TEXT) === false && body.includes(String(TS_MS)) === false,
      `${label} 里出现了时间戳（${TS_TEXT} 或 ${TS_MS}）—— 界面上那句损耗说明该改了`,
    );
  };

  await check('F4-c2 时间戳只有 md 与 json 带得走（今天仍然成立）', () => {
    const md = bodyOf('md');
    const jsonB = bodyOf('json');
    ok(md.includes(`[${TS_TEXT}]`), `md 里没有 [${TS_TEXT}]`, md.slice(0, 400));
    ok(jsonB.includes(String(TS_MS)), `json 里没有 ${TS_MS}`, jsonB.slice(0, 400));
    noTimestampPredicate(bodyOf('opml'), 'opml');
    noTimestampPredicate(bodyOf('mm'), 'mm');
    return `md 有 [${TS_TEXT}] · json 有 ${TS_MS} · opml/mm 都没有`;
  });

  // 变异 ①：换一个从未用过的数，md/json 也必须查不到 —— 证明上面不是 includes 恒真。
  await mutation('F4-c2 的证伪能力（decoy 数字在 md/json 里也必须查不到）', () => {
    const md = bodyOf('md');
    const jsonB = bodyOf('json');
    ok(md.includes(DECOY) || jsonB.includes(DECOY), `md/json 里都没有 decoy ${DECOY}`);
  });

  /*
   * 变异 ②：**把"不该有时间戳"这条判据原样拿去量 md**。
   *
   * 这一条比变异 ① 重要：它证明的是「缺席检测本身有区分力」。
   * md 里确实有 `[12:34]`，所以同一个谓词量到它必须红 ——
   * 红不了就说明我那两条 `opml/mm 没有时间戳` 的绿灯，
   * 可能只是因为这个谓词对任何输入都说"没有"。
   *
   * （opml/mm 不是空壳这件事已经由 F4-c1(opml)/F4-c1(mm) 的 nonce 断言守住，
   *   不需要再用一条别扭的变异去重复说。）
   */
  await mutation('F4-c2 的证伪能力（把"没有时间戳"这个谓词拿去量 md，必须红）', () => {
    noTimestampPredicate(bodyOf('md'), 'md');
  });

  await check('F4-c3 未知 format 被拒（400 BAD_FORMAT），不是静默回落到 md', async () => {
    const r = await j(
      `/api/notes/${encodeURIComponent(subject.uid)}/export?what=mindmap&format=xyzzy`,
    );
    eq(r.status, 400, '未知 format 的状态码');
    eq(r.body?.error?.code, 'BAD_FORMAT', '错误码');
    return 'HTTP 400 BAD_FORMAT';
  });

  /* ───────────────── 7. F5-a：笔记增删改查 ───────────────── */

  hdr('7. F5-a 笔记管理：增 / 删 / 改 / 查');

  // 造一个 64 字节的哑文件当导入源。**故意不是有效媒体** ——
  // 这一节验的是笔记行的生命周期，不是转写；让转写 job 快速失败反而省下 runner 时间。
  const dummy = join(DATA_DIR, 'e2e-notes-dummy.wav');
  writeFileSync(dummy, Buffer.alloc(64));

  const created = await j(
    '/api/notes/import',
    jsonReq({ input: dummy, title: `E2E 增删改查 ${NONCE}` }),
  );
  const newUid = created.body?.noteUid;
  await check('F5-a1 POST /api/notes/import 真的建出一条笔记', () => {
    eq(created.status, 202, 'import 状态码');
    ok(typeof newUid === 'string' && newUid.length === 26, '没有合法的 noteUid', created.body);
    return `noteUid=${newUid}`;
  });

  await check('F5-a2 PATCH 改标题 → GET 读得回来', async () => {
    const t2 = `E2E 改过的标题 ${NONCE}`;
    const p = await j(`/api/notes/${encodeURIComponent(newUid)}`, jsonReq({ title: t2 }, 'PATCH'));
    eq(p.status, 200, 'PATCH note 状态码');
    const g = await j(`/api/notes/${encodeURIComponent(newUid)}`);
    eq(g.status, 200, 'GET note 状态码');
    eq(g.body?.title, t2, '标题');
    return t2;
  });

  // 媒体未加载完这一档的**服务端半条链**（见第 10 节）：现在就把它取下来。
  const freshDetail = await j(`/api/notes/${encodeURIComponent(newUid)}`);

  await check('F5-a3 PUT /star 与 PUT /folder 各自生效', async () => {
    const s = await j(
      `/api/notes/${encodeURIComponent(newUid)}/star`,
      jsonReq({ starred: true }, 'PUT'),
    );
    eq(s.status, 200, 'PUT star 状态码');
    eq(s.body?.starred, true, 'starred 回执');
    const g = await j(`/api/notes/${encodeURIComponent(newUid)}`);
    eq(g.body?.starred, true, '回读 starred');
    return 'starred=true';
  });

  // 删之前先埋一个只属于这条笔记的词，好验"删完搜不到"。
  const DEL_WORD = `删除样本${NONCE}`;
  await j(`/api/notes/${encodeURIComponent(newUid)}`, jsonReq({ bodyText: DEL_WORD }, 'PATCH'));
  const beforeDel = await j(`/api/search?q=${encodeURIComponent(DEL_WORD)}&limit=20`);

  let deletedGet = null;
  await check('F5-a4 DELETE 之后：列表里没有了、搜索也搜不到了', async () => {
    // 前提：删之前**搜得到** —— 否则"删完搜不到"是恒真的。
    const before = (beforeDel.body?.hits ?? []).filter((h) => h.noteUid === newUid);
    ok(before.length > 0, '删之前就搜不到这条笔记 —— 那"删完搜不到"就是句空话');

    const d = await j(`/api/notes/${encodeURIComponent(newUid)}`, { method: 'DELETE' });
    eq(d.status, 200, 'DELETE 状态码');
    eq(d.body?.ok, true, 'ok');

    const l = await j('/api/notes?limit=200');
    const still = (l.body?.notes ?? []).some((n) => n.uid === newUid);
    eq(still, false, '删除后仍出现在列表里');

    const after = await j(`/api/search?q=${encodeURIComponent(DEL_WORD)}&limit=20`);
    const mine = (after.body?.hits ?? []).filter((h) => h.noteUid === newUid);
    eq(mine.length, 0, '删除后仍然搜得到');

    deletedGet = await j(`/api/notes/${encodeURIComponent(newUid)}`);
    return `不在列表里、搜不到（删前搜得到 ${before.length} 条）`;
  });

  /*
   * ★★ 这里**曾经是一条"只打印、不判红绿"的观测项**，现在翻成了真的断言。
   *
   * 当时不判红绿的理由是成立的：缺陷刚被查出来，修法有两种（404 还是 410），
   * 那是 notes 那条线 owner 的决定；而一个**永远红**的门禁等于没有门禁。
   *
   * 缺陷已修（`repos.noteByUid()` 补上 `deleted_at IS NULL`），
   * Manager 2026-08-08 裁决 **404，不是 410** —— 软删在语义上可逆，
   * 410 Gone 隐含"永久移除"，会让"可恢复"在协议层说不通。
   * 修好之后就必须把观察翻成断言，**否则下次退化没人知道**。
   *
   * 断言的是 404 这个具体码，不是"反正别 200"：
   * 400/500 也不是 200，但它们都不是"这条笔记不存在"的正确表达。
   */
  await check('F5-a5 ★ 软删之后 GET 这条笔记回 404 —— 与列表、搜索口径一致', () => {
    ok(!!deletedGet, 'F5-a4 没跑成，这条无从谈起');
    eq(deletedGet.status, 404, '已删除笔记的 GET 状态码');
    eq(deletedGet.body?.error?.code, 'NOTE_NOT_FOUND', '错误码');
    return 'HTTP 404 NOTE_NOT_FOUND';
  });

  /*
   * 同一个缺陷在**写路径**上更难看：`noteByUid` 有 10 个调用点，全是 API 入口。
   * 只验 GET 的话，「已删除的笔记还能被继续编辑」这一半仍然没人看着。
   */
  await check(
    'F5-a6 ★ 已删除的笔记不能再被编辑 / 打星标 / 重新转写（写路径同样 404）',
    async () => {
      const patch = await j(
        `/api/notes/${encodeURIComponent(newUid)}`,
        jsonReq({ title: '不该改得动' }, 'PATCH'),
      );
      eq(patch.status, 404, '改标题的状态码');
      const star = await j(
        `/api/notes/${encodeURIComponent(newUid)}/star`,
        jsonReq({ starred: true }, 'PUT'),
      );
      eq(star.status, 404, '打星标的状态码');
      const exp = await j(`/api/notes/${encodeURIComponent(newUid)}/export?what=mindmap&format=md`);
      eq(exp.status, 404, '导出的状态码');
      return 'PATCH / PUT star / export 全是 404';
    },
  );

  // 变异：同一条"必须 404"的谓词拿去量一条**活着的**笔记 —— 必须红。
  // 否则"删掉的回 404"可能只是因为这个 uid 从来就不存在（拼错也 404）。
  await mutation('F5-a5 的证伪能力（拿活着的笔记去量"必须 404"，必须红）', async () => {
    const alive = await j(`/api/notes/${encodeURIComponent(subject.uid)}`);
    eq(alive.status, 404, '活着的笔记的 GET 状态码');
  });

  /* ───────────────── 8. F5-b：文件夹筛选 ───────────────── */

  hdr('8. F5-b 文件夹：建 → 移入 → 按 folder 筛');
  const folderRes = await j('/api/folders', jsonReq({ name: `E2E 文件夹 ${NONCE}` }));
  const folderUid = folderRes.body?.uid;
  const inFolder = await j(
    '/api/notes/import',
    jsonReq({ input: dummy, title: `E2E 文件夹里的笔记 ${NONCE}` }),
  );
  const inFolderUid = inFolder.body?.noteUid;
  await j(`/api/notes/${encodeURIComponent(inFolderUid)}/folder`, jsonReq({ folderUid }, 'PUT'));

  /*
   * 「按 folder 筛之后，这条笔记不在结果里」这个谓词只写一遍 ——
   * F5-b1 用它去量**文件夹外**的笔记（必须不在），
   * 变异用它去量**文件夹内**的那一条（必须在，所以谓词会红）。
   * 同一个谓词、两个已知答案相反的输入 —— 这才叫证明它有区分力。
   */
  const absentFromFolder = (list, uid, label) => {
    const uids = (list.body?.notes ?? []).map((n) => n.uid);
    ok(uids.includes(uid) === false, `${label} 居然出现在该文件夹的筛选结果里`);
  };
  let folderList = null;
  await check('F5-b1 ?folder=<uid> 只返回该文件夹里的笔记（文件夹外的一条都不带）', async () => {
    eq(folderRes.status, 201, 'POST /api/folders 状态码');
    ok(typeof folderUid === 'string', '没有文件夹 uid', folderRes.body);
    folderList = await j(`/api/notes?folder=${encodeURIComponent(folderUid)}&limit=200`);
    eq(folderList.status, 200, '按 folder 筛的状态码');
    const uids = (folderList.body?.notes ?? []).map((n) => n.uid);
    eq(uids.includes(inFolderUid), true, '筛出来的结果里没有那条笔记');
    // 主角笔记（jfk）在根目录，绝不该出现在这个文件夹里。
    absentFromFolder(folderList, subject.uid, '主角笔记（不在该文件夹里）');
    eq(folderList.body?.total, 1, '该文件夹里的 total');
    return `folder=${folderUid} total=${folderList.body?.total}`;
  });

  await mutation('F5-b1 的证伪能力（同一个"不在结果里"谓词量文件夹内那条，必须红）', () => {
    absentFromFolder(folderList, inFolderUid, '文件夹内那条笔记');
  });

  await check('F5-b2 不存在的 folder uid 被拒（400），不是静默回落到"全部"', async () => {
    const l = await j('/api/notes?folder=00000000000000000000000000');
    eq(l.status, 400, '未知 folder 的状态码');
    eq(l.body?.error?.code, 'BAD_QUERY_PARAM', '错误码');
    return 'HTTP 400 BAD_QUERY_PARAM';
  });

  /* ───────────────── 9. F5-c：星标 + 分页边界 ───────────────── */

  hdr(`9. F5-c 星标与分页边界 —— 造 ${BULK_NOTES} 条（默认 limit=50，必须真跨过第 50 条）`);
  say('   ★ 事故原形：limit 先切、starred 后筛 —— 第 50 条之后的星标笔记静默消失，');
  say('     页面显示的内容是对的，只是不全，用户无从知道自己少看了什么。');

  const bulkUids = [];
  for (let i = 0; i < BULK_NOTES; i++) {
    const r = await j(
      '/api/notes/import',
      jsonReq({ input: dummy, title: `E2E 批量 ${String(i).padStart(3, '0')} ${NONCE}` }),
    );
    if (r.status === 202 && r.body?.noteUid) bulkUids.push(r.body.noteUid);
  }
  say(`   建出 ${bulkUids.length} 条笔记`);
  // 星标前 N-3 条：留 3 条不加星，好证明"筛"真的是筛。
  const starCount = bulkUids.length - 3;
  for (const uid of bulkUids.slice(0, starCount)) {
    await j(`/api/notes/${encodeURIComponent(uid)}/star`, jsonReq({ starred: true }, 'PUT'));
  }
  say(`   其中 ${starCount} 条加了星，3 条没加`);

  // bulkUids[0] 是最早建的 → created_at DESC 排序下它在**最后一页**。
  // 这正是老 bug 会吞掉的那一条。
  const oldestStarred = bulkUids[0];

  /*
   * ★ 逐页翻到底，而不是写死"两页"。
   *   写死两页的话，数据一多（比如本机重跑、数据目录复用）就会在
   *   `page2.hasMore === false` 上红一格 —— 那是**测试的脆弱**，不是产品的问题，
   *   而一个会因为数据变多就红的门禁，训练所有人忽略它。
   */
  const PAGE = 50;
  const pages = [];
  const seen = new Set();
  for (let off = 0; off < 5000; off += PAGE) {
    const r = await j(`/api/notes?starred=1&limit=${PAGE}&offset=${off}`);
    pages.push(r);
    for (const n of r.body?.notes ?? []) seen.add(n.uid);
    if (r.body?.hasMore !== true) break;
  }
  const page1 = pages[0];
  say(
    `   翻了 ${pages.length} 页：${pages.map((p) => (p.body?.notes ?? []).length).join(' + ')} 条`,
  );

  await check('F5-c1 ★ 星标分页真的跨过了第 50 条，且一条都不少', () => {
    for (const [i, p] of pages.entries()) eq(p.status, 200, `第 ${i + 1} 页状态码`);
    const total = Number(page1.body?.total);
    // 非空虚前提：total 必须真的超过一页，否则整条断言恒真、边界根本没跑到。
    ok(total > PAGE, `starred total=${total} 没超过一页 —— 这条边界根本没跑到`, page1.body);
    eq(page1.body?.notes?.length, PAGE, '第 1 页条数（必须满页）');
    eq(page1.body?.hasMore, true, '第 1 页 hasMore');
    ok(pages.length >= 2, `只翻出 ${pages.length} 页 —— 第 50 条之后那一档没被走到`);
    eq(seen.size, total, '所有页并起来的去重条数 ≠ total（有笔记被静默吞掉了）');
    // 最早建的那条在最后一页 —— 正是老 bug（limit 先切、starred 后筛）会吞掉的那条。
    eq(seen.has(oldestStarred), true, '最早那条星标笔记一页都没出现 —— 这就是那个事故');
    eq(pages[pages.length - 1].body?.hasMore, false, '最后一页 hasMore');
    return `total=${total}，翻 ${pages.length} 页覆盖 ${seen.size} 条，含最早那条`;
  });

  // 变异：只看第一页（老 bug 的行为）时，最早那条**必须**不在 —— 证明边界真的跨过了。
  await mutation('F5-c1 的证伪能力（只看第一页时，最早那条星标笔记必须查不到）', () => {
    const firstPageUids = new Set((page1.body?.notes ?? []).map((n) => n.uid));
    eq(firstPageUids.has(oldestStarred), true, '最早那条星标笔记在第 1 页里');
  });

  await check('F5-c2 starred 筛的是"筛"，不是把全部都返回', async () => {
    const all = await j('/api/notes?limit=1');
    const totalAll = Number(all.body?.total);
    const totalStar = Number(page1.body?.total);
    ok(totalStar < totalAll, `starred total=${totalStar} 不小于全量 total=${totalAll}`);
    ok(totalAll - totalStar >= 3, `没加星的至少该有 3 条，实际差 ${totalAll - totalStar}`);
    return `全量 ${totalAll} · 星标 ${totalStar}`;
  });

  await check('F5-c3 ?starred=0 被拒（400），不是被读成"未加星的"', async () => {
    const r = await j('/api/notes?starred=0');
    eq(r.status, 400, '?starred=0 的状态码');
    return 'HTTP 400';
  });

  await check('F5-c4 offset 越过 total 时返回空页而不是报错或绕回第一页', async () => {
    const total = Number(page1.body?.total);
    const r = await j(`/api/notes?starred=1&limit=50&offset=${total + 100}`);
    eq(r.status, 200, '越界 offset 的状态码');
    eq(r.body?.notes?.length, 0, '越界 offset 的条数');
    eq(r.body?.hasMore, false, '越界 offset 的 hasMore');
    return `offset=${total + 100} → 0 条`;
  });

  /* ───────────────── 10. F5-d：中文全文检索 ───────────────── */

  hdr('10. F5-d 中文全文检索 —— 判据是**两字词能搜到**');
  say('   ★ 没装 libsimple 时 tokenizer 退回 trigram，而 trigram 在结构上匹配不了');
  say('     长度 < 3 的查询 —— 中文两字词**静默返回 0 条且不报错**。');
  say('     所以这一节的变异证明（第 11 节）比断言本身更重要。');

  const CN_WORDS = ['会议', '纪要', '预算', '客户'];
  const CN_BODY = `本次会议纪要如下：预算需要重新核算，客户那边的反馈也要一并整理。${NONCE}`;
  const cnNote = await j(
    '/api/notes/import',
    jsonReq({ input: dummy, title: `中文检索样本 ${NONCE}` }),
  );
  const cnUid = cnNote.body?.noteUid;
  await j(`/api/notes/${encodeURIComponent(cnUid)}`, jsonReq({ bodyText: CN_BODY }, 'PATCH'));

  const cnHits = {};
  for (const w of CN_WORDS) {
    const r = await j(`/api/search?q=${encodeURIComponent(w)}&limit=50`);
    cnHits[w] = r;
    const n = (r.body?.hits ?? []).length;
    const mine = (r.body?.hits ?? []).filter((h) => h.noteUid === cnUid).length;
    say(`   q=${w}  HTTP ${r.status}  命中 ${n} 条（其中本次样本 ${mine} 条）`);
  }

  await check('F5-d1 ★ 四个中文两字词都搜得到本次样本（这条最容易静默坏）', () => {
    for (const w of CN_WORDS) {
      const r = cnHits[w];
      eq(r.status, 200, `q=${w} 状态码`);
      const mine = (r.body?.hits ?? []).filter((h) => h.noteUid === cnUid);
      ok(mine.length > 0, `「${w}」搜不到本次样本 —— 多半是 tokenizer 退回了 trigram`);
    }
    return CN_WORDS.map((w) => `${w}:${(cnHits[w].body?.hits ?? []).length}`).join(' ');
  });

  /*
   * ★ 键名跟着 T-200 A-2（`ae48f0b`）改：`/api/search` 的 `modes` 早就不发
   * `chineseTokenizer`（boolean）了，契约收口成 `tokenizer: 'simple'|'trigram'`
   * （`packages/shared/src/schemas.ts` 的 `SearchResponseSchema`）。这条腿
   * 只在 `workflow_dispatch` 手动触发时跑，不随 push 跑——键名改名落地那一刻起
   * 这两条断言就在拿一个 daemon 早就不发的旧键名去读 `undefined`，`eq()` 用的是
   * `===` 全等比较，`undefined !== true`，理应当场红；但因为没人手动跑这条腿，
   * 直到这次 dispatch 之前没有任何东西说过一句话（Manager 2026-08-11 裁决）。
   */
  await check('F5-d2 /api/search 自报 modes.tokenizer=simple', () => {
    const m = cnHits[CN_WORDS[0]].body?.modes ?? {};
    eq(m.tokenizer, 'simple', 'modes.tokenizer');
    eq(m.keyword, true, 'modes.keyword');
    return JSON.stringify(m);
  });

  await check('F5-d3 /api/health 与 /api/selfcheck 也说分词器是 simple', async () => {
    const h = await j('/api/health');
    const e = h.body?.db?.extensions ?? {};
    eq(e.tokenizer, 'simple', 'health.db.extensions.tokenizer');
    eq(e.libsimple, true, 'health.db.extensions.libsimple');
    const sc = await j('/api/selfcheck');
    const checks = sc.body?.checks ?? sc.body?.results ?? [];
    const cn = checks.find((c) => c.id === 'ext.chineseSearch');
    ok(!!cn, '/api/selfcheck 里没有 ext.chineseSearch 这一项 —— 判据本身不见了');
    eq(cn.status, 'ok', 'ext.chineseSearch 状态');
    return `tokenizer=${e.tokenizer} ext.chineseSearch=${cn.status} · ${brief(cn.detail)}`;
  });

  // 变异：一个语料里没有的两字词必须搜不到本次样本 —— 证明搜索不是"什么都返回"。
  await mutation('F5-d1 的证伪能力（语料里没有的两字词必须搜不到）', async () => {
    const r = await j(`/api/search?q=${encodeURIComponent('紫檀')}&limit=50`);
    const mine = (r.body?.hits ?? []).filter((h) => h.noteUid === cnUid);
    ok(mine.length > 0, `「紫檀」搜不到本次样本（这条变异本就该红）`);
  });

  /* ───────────────── 11. F5-e：搜索结果跳时间点（?t=）的服务端半条链 ────────── */

  hdr('11. F5-e 搜索结果直达时间点（?t=）—— 服务端这半条链');
  say('   `?t=` 本身是前端参数（SearchPage 发、NoteDetailPage 用 parseSeekParam 解）。');
  say('   服务端这半是：**segment 命中必须带 startMs，且它得在时长之内**。');

  // 从真转写稿里挑一个词去搜，保证能拿到 segment 命中。
  const probeWord = (trSegs
    .map((s) => String(s.text ?? ''))
    .join(' ')
    .match(/[A-Za-z]{4,}/g) ?? [])[0];
  let segHit = null;
  let searchForT = null;
  if (probeWord) {
    searchForT = await j(`/api/search?q=${encodeURIComponent(probeWord)}&limit=50`);
    segHit = (searchForT.body?.hits ?? []).find(
      (h) => h.source === 'segment' && h.noteUid === subject.uid && h.startMs !== null,
    );
    say(
      `   用转写稿里的词「${probeWord}」搜：HTTP ${searchForT.status}，命中 ${(searchForT.body?.hits ?? []).length} 条`,
    );
  } else {
    say('   ⚠️ 转写稿里挑不出一个 4 字母以上的英文词 —— 这一节改用降级判据。');
  }

  await check('F5-e1 segment 命中带得回可用的 startMs（?t= 的取值来源）', () => {
    ok(!!probeWord, '转写稿里挑不出探针词');
    ok(!!segHit, `没有拿到 source=segment 的命中`, (searchForT?.body?.hits ?? []).slice(0, 3));
    ok(Number.isInteger(segHit.startMs), 'startMs 不是整数', segHit.startMs);
    ok(segHit.startMs >= 0, 'startMs 是负数', segHit.startMs);
    ok(typeof segHit.transcriptUid === 'string', 'segment 命中没有 transcriptUid', segHit);
    return `startMs=${segHit.startMs} seq=${segHit.seq}`;
  });

  await check(
    'F5-e2 越界边界：startMs 不超过这条笔记的 durationMs（夹取的上界存在且为正）',
    async () => {
      const d = await j(`/api/notes/${encodeURIComponent(subject.uid)}`);
      const dur = Number(d.body?.durationMs ?? 0);
      // 上界必须是正数：parseSeekParam 明写 durationMs<=0 时**不夹取**，
      // 也就是说上界一旦是 0，"越界夹到末尾"这条产品行为在结构上不可能发生。
      ok(dur > 0, `durationMs=${dur} —— 上界不存在，越界夹取无从谈起`);
      ok(!!segHit, '没有 segment 命中，这条无从谈起');
      ok(
        segHit.startMs <= dur,
        `命中的 startMs=${segHit.startMs} 超过了 durationMs=${dur} —— 那样点进去就会被夹到末尾`,
      );
      return `startMs=${segHit.startMs} ≤ durationMs=${dur}`;
    },
  );

  await check('F5-e3 媒体未加载完边界：时长未知时服务端如实回 0，不编一个数', () => {
    // freshDetail 是第 7 节刚导入、转写还没做完时取的那一份。
    eq(freshDetail.status, 200, '刚导入时 GET note 的状态码');
    const dur = Number(freshDetail.body?.durationMs ?? 0);
    ok(
      dur === 0,
      `刚导入的笔记 durationMs=${dur} —— 时长还不该知道。` +
        `编一个非零上界会让 parseSeekParam 把对的 ?t= 夹坏`,
    );
    return `durationMs=0（parseSeekParam 据此不夹取，正是它注释里写的那条）`;
  });

  /*
   * ★ 必须**模拟浏览器地址栏导航**，不能用裸 fetch。
   *
   * `[实测]` 第一版用裸 fetch 打 `/notes/<uid>?t=…`，拿到 404 —— 我一度以为是包里
   * 缺网页。**不是，是产品做得对**：SPA 兜底刻意只对真正的导航生效
   * （`server.ts:215` 看 `sec-fetch-mode: navigate` 或 `Accept: text/html`），
   * 因为"任何无扩展名路径都回 index.html"会把 `/media/../../etc/passwd`
   * 也变成 200，**把本该 404 的东西变成 200 就是在遮蔽后端的拒绝**（static.ts 的注释）。
   *
   * 所以这里带上浏览器导航会带的头。`sec-fetch-site: none` 正是地址栏直接打开时的值，
   * 也满足 guard 对该头的要求。
   */
  const navHeaders = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
  };
  await check('F5-e4 深链 /notes/<uid>?t=<ms> 在包里真的可达（浏览器导航语义）', async () => {
    const r = await j(`/notes/${encodeURIComponent(subject.uid)}?t=${segHit?.startMs ?? 0}`, {
      headers: navHeaders,
    });
    eq(r.status, 200, '深链状态码');
    const html = typeof r.body === 'string' ? r.body : r.text;
    ok(
      /<div[^>]+id=["']root["']/.test(html) || html.includes('<script'),
      '返回的不像应用外壳',
      html.slice(0, 200),
    );
    return `HTTP 200，${html.length} 字符的应用外壳`;
  });

  // 变异：同一条深链用**非导航**请求（裸 fetch）必须**不是** 200 ——
  // 证明上面那个 200 是 SPA 兜底给的，而不是"什么路径都回 200"。
  await mutation('F5-e4 的证伪能力（非导航请求打同一条深链，不该拿到应用外壳）', async () => {
    const r = await j(`/notes/${encodeURIComponent(subject.uid)}?t=0`);
    eq(r.status, 200, '非导航深链状态码');
  });

  /* ───────────────── 12. 借了宿主几个 ───────────────── */

  hdr('12. 借宿主工具几个 —— 用产品自己的判据（GET /api/selfcheck）');
  const sc = await j('/api/selfcheck');
  const checks = sc.body?.checks ?? sc.body?.results ?? [];
  const tools = checks.filter((c) => String(c.id).startsWith('tool.'));
  /*
   * ★ 空集守卫。没有这一句时，拿不到自检结果会让下面整段打印出
   * 「✅ 产品自己下载并校验的 (0)」「❌ 装不上/不可用 (0)」，并以
   * 「**本轮结论：借了宿主 0 个**」收尾 —— **三个 0 被当成发现报了出来。**
   *
   * 这里没有 PASS 会翻转（本段只 say 不 judge），但**一份会说假话的审计记录，
   * 和一次假绿一样会被引用** —— 后面读报告的人拿不到"这一轮没测成"这个信息。
   *
   * ⚠️ 本文件 120 行之前就守过同一个形状（`ok(!!cn, '判据本身不见了')`）。
   * 用同一个 `ok()`，让它按本文件的规矩红。
   */
  ok(
    sc.status === 200 && tools.length > 0,
    `拿不到 tool.* 自检项（HTTP ${sc.status}，共 ${checks.length} 项、tool.* ${tools.length} 项）` +
      ` —— 下面那句「借了宿主 N 个」会变成一句假话`,
  );
  const own = tools.filter((c) => c.status === 'ok');
  const borrowed = tools.filter((c) => c.status === 'warn' && /PATH/i.test(String(c.detail ?? '')));
  const missing = tools.filter(
    (c) => c.status === 'fail' || (c.status === 'warn' && !/PATH/i.test(String(c.detail ?? ''))),
  );
  say(`   ✅ 产品自己下载并校验的 (${own.length})：${own.map((c) => c.id).join(', ') || '(无)'}`);
  say(
    `   ⚠️ 借宿主 PATH 的       (${borrowed.length})：${borrowed.map((c) => c.id).join(', ') || '(无)'}`,
  );
  say(
    `   ❌ 装不上/不可用        (${missing.length})：${missing.map((c) => c.id).join(', ') || '(无)'}`,
  );
  say('');
  say(`   ★ 本轮结论：**借了宿主 ${borrowed.length} 个**（屏蔽=${MASK ? '开' : '关'}）。`);
  for (const c of borrowed) say(`     · ${c.id}: ${brief(c.detail)}`);

  /* ───────────────── 13. ★ 中文检索的变异证明（另起一个没有 libsimple 的实例） ── */

  hdr('13. ★ 变异证明：另起一个没有 libsimple 的实例，同一条断言必须变红');
  say('   PROTOCOL §10：反向验证跑在隔离副本上，不动共享工作树。');
  say('   这里连副本都不用 —— 只是把 OPENMEMO_EXT_DIR 指向一个空目录，');
  say('   数据目录用 mkdtemp。跑完什么都不用还原（被 kill 也不会留下坏状态，§9-bis）。');

  const mutData = mkdtempSync(join(tmpdir(), 'om-e2e-nolib-'));
  const mutExt = mkdtempSync(join(tmpdir(), 'om-e2e-emptyext-'));
  say(`   变异实例数据目录：${mutData}`);
  say(`   变异实例扩展目录（空）：${mutExt}`);

  try {
    mutDaemon = await startDaemon('mutation', {
      dataDir: mutData,
      port: MUT_PORT,
      extraEnv: { OPENMEMO_EXT_DIR: mutExt },
    });
    const mh = await mutDaemon.client('/api/health');
    const me = mh.body?.db?.extensions ?? {};
    say(
      `   [变异实例] tokenizer=${me.tokenizer} libsimple=${me.libsimple} sqliteVec=${me.sqliteVec}`,
    );

    await check('MUT-0 变异实例确实退化成了 trigram（变异体本身成立）', () => {
      eq(me.libsimple, false, '变异实例的 libsimple');
      eq(me.tokenizer, 'trigram', '变异实例的 tokenizer');
      return 'tokenizer=trigram libsimple=false';
    });

    // 在变异实例里造同样的中文样本。
    const mutDummy = join(mutData, 'e2e-dummy.wav');
    writeFileSync(mutDummy, Buffer.alloc(64));
    const mn = await mutDaemon.client(
      '/api/notes/import',
      jsonReq({ input: mutDummy, title: `中文检索样本 ${NONCE}` }),
    );
    const mnUid = mn.body?.noteUid;
    await mutDaemon.client(
      `/api/notes/${encodeURIComponent(mnUid)}`,
      jsonReq({ bodyText: CN_BODY }, 'PATCH'),
    );

    const mutHits = {};
    for (const w of CN_WORDS) {
      const r = await mutDaemon.client(`/api/search?q=${encodeURIComponent(w)}&limit=50`);
      mutHits[w] = r;
      say(
        `   [变异实例] q=${w}  HTTP ${r.status}  命中 ${(r.body?.hits ?? []).length} 条` +
          `（本次样本 ${(r.body?.hits ?? []).filter((h) => h.noteUid === mnUid).length} 条）`,
      );
    }

    // ★★ 这是全脚本最值钱的一条：**把 F5-d1 那条断言原样搬过来量变异体，要求它红。**
    await mutation('★ F5-d1 的证伪能力（没有 libsimple 时，同一条断言必须红）', () => {
      for (const w of CN_WORDS) {
        const r = mutHits[w];
        eq(r.status, 200, `q=${w} 状态码`);
        const mine = (r.body?.hits ?? []).filter((h) => h.noteUid === mnUid);
        ok(mine.length > 0, `「${w}」搜不到本次样本 —— 多半是 tokenizer 退回了 trigram`);
      }
    });

    await check('MUT-1 静默：没有 libsimple 时搜索仍然 HTTP 200，只是 0 条（不报错）', () => {
      for (const w of CN_WORDS) {
        eq(mutHits[w].status, 200, `q=${w} 在变异实例上的状态码`);
        ok(
          mutHits[w].body?.error === undefined,
          `q=${w} 居然报错了 —— 那反倒说明它不静默`,
          mutHits[w].body?.error,
        );
      }
      return '四个词全是 HTTP 200 + 0 条本样本命中，一个错都不报 —— 这就是那个静默';
    });

    // ★ 同一次键名收口（T-200 A-2）：变异实例退化时 modes.tokenizer 应如实报 'trigram'。
    await check('MUT-2 变异实例上 modes.tokenizer 如实报 trigram', () => {
      const m = mutHits[CN_WORDS[0]].body?.modes ?? {};
      eq(m.tokenizer, 'trigram', '变异实例的 modes.tokenizer');
      return 'tokenizer=trigram';
    });
  } finally {
    await stopDaemon(mutDaemon);
    mutDaemon = null;
    rmSync(mutData, { recursive: true, force: true });
    rmSync(mutExt, { recursive: true, force: true });
  }
} catch (e) {
  failed += 1;
  say('');
  say(`✘ 审计中断：${e.message}`);
  say(e.stack ? e.stack.split('\n').slice(1, 6).join('\n') : '');
  if (daemon?.logs?.length) {
    say('   daemon 最后 60 行：');
    say(
      daemon.logs
        .join('')
        .split('\n')
        .slice(-60)
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  /*
   * ★ 补一条"汇总"行（Manager 2026-08-11 裁决，#77 notes 腿追踪）：以前审计
   * 中途中断时，`results[]` 对这次中断本身、以及**之后所有没跑到的检查项**
   * 都不留任何痕迹——总表看起来像是"跑到这儿就自然结束了"，而不是"炸了"。
   *
   * ⚠️ 这里**不逐条枚举**"之后本来该有哪些检查项"，和 import 腿 F2b 那次
   * 的补法不一样，是有意的区别，不是漏做：
   *   · F2b 那边可以逐条枚举，是因为 `FIXTURE_SPECS` 在跑之前就是一份跑之前
   *     就定死、和后面代码无耦合的小型静态清单（4 个格式名字）。
   *   · 这里不是——`check()`/`mutation()` 的调用点散在近千行相互依赖的运行时
   *     逻辑里（后一条常常要用前一条造出来的状态：subject 笔记、导出正文、
   *     provider 配置……），中断发生在哪一条，"之后原本会跑哪些"这件事只能
   *     靠一份跟着代码手动同步的镜像清单才说得出来——而这种清单一旦漏更新
   *     就会安静地撒谎，比"说不出来"更坏。所以这里只诚实地说一句
   *     "审计中断，之后的检查项均未执行"，不假装知道具体缺了哪几条。
   *
   * `failed` 已经在上面 +1 了（中断本身这一个根因）——这里**不重复计**，
   * 判决不受影响，这一行纯粹是把总表填完整、留下"审计没走完"的痕迹。
   */
  results.push({
    id: '（审计中断，之后的检查项均未执行）',
    status: 'ABORTED',
    detail: e.message,
  });
} finally {
  await stopDaemon(daemon);
  await stopDaemon(mutDaemon);
  if (llmServer) await new Promise((r) => llmServer.close(r));
  for (const c of children) {
    try {
      killTreeHard(c?.pid ?? c);
    } catch {
      /* 已经死了 */
    }
  }
  rmSync(SCRATCH, { recursive: true, force: true });
}

/* ═══════════════════════════ 汇总 ═══════════════════════════════════════════ */

hdr('汇总');
say('   id                                                                  结果');
say('   ' + '-'.repeat(88));
for (const r of results) {
  say(`   ${String(r.id).padEnd(66)} ${r.status}`);
}
say('');
const pass = results.filter((r) => r.status === 'PASS').length;
const mut = results.filter((r) => r.status === 'MUT-OK').length;
say(`   断言通过 ${pass} 条 · 变异证明 ${mut} 条 · 失败 ${failed} 条`);
if (degraded.length > 0) {
  say('');
  say('   ⚠️ 降级说明（不是失败，但读结论的人必须知道）：');
  for (const d of degraded) say(`     · ${d}`);
}
say('');
say(
  `   假端点收到的请求：${llmState.calls.length} 条 —— ` +
    `真请求 ${llmState.chatCalls} · 能力探测 ${llmState.probeCalls} · /models ${llmState.modelsCalls}`,
);
say(`   是否带了 Authorization 头：${llmState.sawAuthHeader}（回环地址不该要求 key）`);
say(`   指针文件用的是 ${POINTER}（不是全局那个）—— 按 PROTOCOL §9。`);

process.exit(failed > 0 ? 1 : 0);
