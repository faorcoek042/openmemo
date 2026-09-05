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
  readFileSync,
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
import {
  absenceAnnotation,
  absentMutations,
  assertOk,
  classifyMutationThrow,
  extractMutationIds,
  mutationAnnotation,
} from './mutation-verdict.mjs';
/*
 * ★★ 判据本体在 `e2e-notes-assertions.mjs` —— **纯函数，能被喂输入**。
 *
 * 抽出来之前它们是这份文件里 115 处内联 `ok()`/`eq()`，而这份文件顶层执行、
 * 结尾 `process.exit()` ⇒ **import 不进来 ⇒ 没有任何东西能给它们喂一份"本该判红"
 * 的输入**。`e2e-runtime-audit.mjs` 正是这样让一条判据烂了三周
 * （`/先安装 CPU/` 那条正则，文案一改它就再也没匹配过任何东西）。
 *
 * 现在每一条都在 `selftest-e2e-notes.mjs` 里过「坏输入必须判红 + 好输入必须判绿」。
 * ⚠️ 这一轮**只搬家，不改判什么** —— 抽出过程中发现的两条空转已登记在
 * `checkDeletedNoteWritesRejected()` / `classifyToolChecks()` 的注释里，判据没动。
 */
import {
  checkAbsentFromList,
  checkAppShell,
  checkChineseSearchFindsSample,
  checkDeletedNoteWritesRejected,
  checkDeletionInvisible,
  checkExportEnvelope,
  checkFolderCreated,
  checkFolderFilter,
  checkLlmEndpointCalled,
  checkMindmapEditPersisted,
  checkMindmapJobSucceeded,
  checkMindmapProvenance,
  checkNoTimestamp,
  checkNoteCreated,
  checkNoteGone,
  checkOffsetBeyondTotal,
  checkRefQuoteVerbatim,
  checkRefTimestamps,
  checkRejection,
  checkSearchModes,
  checkSearchablePremise,
  checkSegmentHit,
  checkSeekWithinDuration,
  checkSettingsRoundTrip,
  checkSilentDegradation,
  checkStarApplied,
  checkStarredIsFilter,
  checkStarredPagination,
  checkTimestampFidelity,
  checkTitleRoundTrip,
  checkTokenizerDegraded,
  checkTokenizerSelfReport,
  checkToolProbesUsable,
  checkTopicRefPresent,
  checkUnknownDurationIsZero,
  classifyToolChecks,
  nodesWithNonce,
  parseOutlineIndices,
  uidsOfNotePage,
  CHINESE_SEARCH_CHECK_ID,
  ERROR_CODES,
  EXPORT_EXPECTATIONS,
} from './e2e-notes-assertions.mjs';

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
/**
 * ★ 覆盖面上报（照抄 browser / runtime 腿的同名 flag）。
 *
 * 本腿此前**没有**这个 flag，`e2e-notes.yml` 的 attest 作业写死 `--undecided 0`，
 * 论证是「这条腿结构上不产生未决」。那句话**从本轮起不再成立** ——
 * `mutation()` 现在会为「腿自己炸了」产出 `MUT-UNKNOWN`。
 * 那段论证自己预言过这一天（「只要有人给 results 加一个新状态…这个 0 就变成假话」），
 * 所以这里接上真数：写一个 `{ unknowns: N }` 的小文件，由 attest 作业跨平台求和。
 * **「恒为 0」是一句会过期的话；一条真的去数的管道不会。**
 */
const UNDECIDED_OUT = arg('--undecided-out', null);

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

/**
 * 断言：`cond` 为真，否则抛。**只吃布尔**，不吃对象 —— 见 PROTOCOL §8。
 *
 * ★ 抛的是**专用类型** `AssertionFailed`（`mutation-verdict.mjs`），不是裸 `Error` ——
 *   那是 `mutation()` 分得开「断言按设计判红」和「这条腿自己炸了」的唯一依据。
 */
function ok(cond, msg, got) {
  assertOk(cond, msg, got, brief);
}
function eq(actual, expected, msg) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  ok(a === e, `${msg} —— 期望 ${brief(e)}，实得 ${brief(a)}`);
}

/**
 * `e2e-notes-assertions.mjs` 的 `{ ok, reason }` → 本文件的 `AssertionFailed`。
 *
 * ★ **判据模块里一律不抛**（纯函数，好喂输入、好写证明），抛在这里。
 *   经由 `ok()` ⇒ 抛的仍然是 `AssertionFailed` ⇒ `mutation()` 仍然分得开
 *   「断言按设计判红」和「这条腿自己炸了」。这条接线断掉的表现是
 *   **所有变异悄悄全变 MUT-UNKNOWN 而整条腿照样绿**，所以文件末尾那条
 *   「至少一条 MUT-OK」的地板正是它的看门狗。
 */
function judge(verdict) {
  ok(verdict?.ok === true, String(verdict?.reason ?? '判据没给理由 —— 它自己坏了'));
  return verdict;
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
 * **变异证明**：那条断言必须**按设计**判红。判决走 `mutation-verdict.mjs` 里
 * 唯一的那一份（有正反证明），按**抛出的类型**分四档：
 *
 *   · 什么都没抛        ⇒ `MUT-BAD`      变异体存活 —— 假绿灯，**计入 failed**
 *   · `AssertionFailed` ⇒ `MUT-OK`       断言按设计判红
 *   · `Undecided`       ⇒ `MUT-UNKNOWN`  前提没构造出来（本腿今天没有这种调用点）
 *   · **其它任何抛出**  ⇒ `MUT-UNKNOWN`  **这条腿自己炸了**，什么都没证明
 *
 * ## 为什么本腿也要这一档（它此前是两态的）
 *
 * 这 10 条变异里有 3 条是 `async` 的，中间跑真 HTTP（`F5-a5`、`F5-d1`、`F5-e4`）。
 * daemon 抖一下、端口被抢、`fetch failed` —— 老实现会把这些一律记成「如期变红」。
 * `[实测语料 30 轮 e2e-notes / 727 次 MUT-OK]` 本腿**一次都没被咬过**（全是 A 类），
 * 但 browser 腿的 `B10` 被这个坑咬了 **72 个 job 腿 / 25 轮 / 4 个 UTC 日
 * （2026-08-09 → 08-12，跨度 3 天 15 小时）**，三平台全中
 * （linux 25 · darwin 24 · win32 23），而它被堵住靠的是一次**无关的**修复
 * （`ced454d`）顺手改对了导航。**这里是提前上锁。**
 *
 * ⚠️ **纳入条件写出来，免得下一个人拿另一个口径去对**：`workflow=e2e-browser`
 * 的**全部 41 个 run**（`schedule` + `workflow_dispatch` 都算）下的**全部 117 个
 * `真浏览器点按钮` job 腿**，117 份日志全部拉到、无过期；其中 114 腿印了 B10 判决行，
 * 全是 `MUT-OK`，按 detail 分类得 B 类（Playwright 超时等"腿炸了"）72、A 类 42。
 * ⚠️ **别写「×3」**：25 轮里有 2 轮不是三格全中（一轮 2 格、一轮 1 格），
 * 23×3+2+1 = 72 —— 早先那句「22 轮 / 63 腿」两个数都是错的，且它俩自己就对不上。
 *
 * ⚠️ `MUT-UNKNOWN` **不计入 failed**（否则一次 HTTP 抖动会让整条腿红 ——
 * 一条会随机变红的门，教给人的还是那句「别信这盏灯」）。所以它必须**响**：
 * 打 `::warning` 注解、进「本轮无从判断」清单、并**真的被数进凭证的覆盖面**。
 */
async function mutation(id, fn) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  const verdict = classifyMutationThrow(threw, brief);
  results.push({ id, status: verdict.status, detail: verdict.detail, mutKind: verdict.kind });
  say(`   ${verdict.mark} [变异] ${id} —— ${verdict.text}`);
  const annotation = mutationAnnotation(id, verdict);
  if (annotation) say(annotation);
  if (verdict.status === 'MUT-BAD') failed += 1;
  return verdict.status === 'MUT-OK';
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
  /*
   * `[12] 正文` 里的编号。**只收行首的**，避免把正文里的方括号也当编号。
   * 解析器抽进了 `e2e-notes-assertions.mjs`：它对不上产品的 prompt 格式时，
   * 整条 F4 会以「产品坏了」的形状变红，而真正坏的是夹具 ——
   * 抽出来之后 `selftest-e2e-notes.mjs` 能正面钉住那个格式（含对着
   * `buildUserPrompt()` 源码的契约守卫）。
   */
  const idx = parseOutlineIndices(promptText);
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
    judge(
      checkSettingsRoundTrip({
        status: st.status,
        settings: st.body?.settings,
        providerId: PROVIDER_ID,
        baseUrl: LLM_BASE_URL,
      }),
    );
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
    judge(
      checkMindmapJobSucceeded({ postStatus: gen.status, jobUid: mmJobUid, jobState: genState }),
    );
    return `jobUid=${mmJobUid}`;
  });

  await check('F4-a3 产品真的向那个 HTTP 端点发了请求（不是凭空造图）', () => {
    judge(checkLlmEndpointCalled({ chatCalls: llmState.chatCalls, calls: llmState.calls }));
    return `chat/completions 真请求 ${llmState.chatCalls} 次 · 能力探测 ${llmState.probeCalls} 次 · /models ${llmState.modelsCalls} 次`;
  });

  const mm = await j(`/api/notes/${encodeURIComponent(subject.uid)}/mindmap`);
  const doc = mm.body?.doc;
  const nodeList = Object.values(doc?.nodes ?? {});
  await check('F4-a4 GET 回来的导图带 llm 出处，且节点里有 nonce', () => {
    judge(
      checkMindmapProvenance({
        status: mm.status,
        generatedBy: mm.body?.mindmap?.generatedBy,
        nodes: nodeList,
        nonce: NONCE,
        providerId: PROVIDER_ID,
      }),
    );
    const hit = nodesWithNonce(nodeList, NONCE);
    return `nodeCount=${mm.body?.mindmap?.nodeCount} 带 nonce 的节点 ${hit.length} 个`;
  });

  /*
   * 变异：nonce 换成一个从未出现过的串，**同一个 `nodesWithNonce()`** 必须查不到。
   * 换的是输入，不是谓词 —— 另写一个谓词的话，被证明有区分力的就不是 F4-a4 用的那个了。
   */
  await mutation('F4-a4 的证伪能力（换一个没用过的 nonce 必须查不到）', () => {
    const bogus = 'E2EMMDEADBEEF00';
    const hit = nodesWithNonce(nodeList, bogus);
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
  await check('F4-a5 节点 refs 的时间戳 = 从转写稿独立算出来的真值（非循环）', () => {
    judge(
      checkTopicRefPresent({
        node: topicNode,
        label: `会议主题 ${NONCE}`,
        nodeTexts: nodeList.map((n) => n.text),
        expectedSeg,
        expectedIdx: topicIdx,
      }),
    );
    const ref = topicNode.refs[0];
    say(
      `     期望值来自 trSegs[${topicIdx}]：startMs=${expectedStartMs} endMs=${expectedEndMs}` +
        `（**不是**从导图里读的）`,
    );
    judge(checkRefTimestamps({ ref, seg: expectedSeg }));
    // quote 必须是原文逐字 —— 这是重转写后重定位的唯一依据（generate.ts 的设计约束）
    judge(checkRefQuoteVerbatim({ ref, segments: trSegs, transcriptUid: subject.transcriptUid }));
    return `startMs=${expectedStartMs} endMs=${expectedEndMs}`;
  });

  // 变异：把同一个比对函数喂一个整体平移 1 秒的段落 —— 必须红。
  await mutation('F4-a5 的证伪能力（把段落整体平移 1 秒，同一个比对函数必须红）', () => {
    ok(!!topicNode && !!expectedSeg, 'F4-a5 本身就没跑成，变异无从谈起');
    judge(
      checkRefTimestamps({
        ref: topicNode.refs[0],
        seg: {
          startMs: Number(expectedSeg.startMs) + 1000,
          endMs: Number(expectedSeg.endMs) + 1000,
        },
      }),
    );
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
    judge(
      checkMindmapEditPersisted({
        patchStatus: patched.status,
        patchRevision: patched.body?.revision,
        patchMindmapUid: patched.body?.mindmapUid,
        revisionBefore: revBefore,
        rereadStatus: mmAfter.status,
        rootText: mmAfter.body?.doc?.nodes?.[rootKey]?.text,
        editMark: EDIT_MARK,
        generatedBy: mmAfter.body?.mindmap?.generatedBy,
      }),
    );
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
    judge(
      checkRejection({
        status: bad.status,
        body: bad.body,
        expectStatus: 400,
        expectCode: ERROR_CODES.invalidMindmap,
        label: '非法 doc 的 PATCH',
      }),
    );
    return `HTTP 400 ${ERROR_CODES.invalidMindmap}`;
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

  /*
   * 四种导出各自的 `content-type` 与「时间戳带不带得走」——
   * 抽进 `e2e-notes-assertions.mjs` 的 `EXPORT_EXPECTATIONS`，
   * 由 `selftest-e2e-notes.mjs` 对着 `content.ts` 的 `exportMindmap()` 逐格核。
   */
  const EXPECT = EXPORT_EXPECTATIONS;
  const exported = {};
  for (const fmt of Object.keys(EXPECT)) {
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

  for (const fmt of Object.keys(EXPECT)) {
    await check(`F4-c1(${fmt}) 200 + content-type 正确 + 正文里有 nonce`, () => {
      judge(
        checkExportEnvelope({
          fmt,
          status: exported[fmt].status,
          contentType: exported[fmt].headers['content-type'],
          body: bodyOf(fmt),
          nonce: NONCE,
        }),
      );
      return `${bodyOf(fmt).length} 字符`;
    });
  }

  await check('F4-c2 时间戳只有 md 与 json 带得走（今天仍然成立）', () => {
    judge(
      checkTimestampFidelity({
        bodies: Object.fromEntries(Object.keys(EXPECT).map((f) => [f, bodyOf(f)])),
        timecode: TS_TEXT,
        ms: TS_MS,
      }),
    );
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
    judge(checkNoTimestamp({ body: bodyOf('md'), label: 'md', timecode: TS_TEXT, ms: TS_MS }));
  });

  await check('F4-c3 未知 format 被拒（400 BAD_FORMAT），不是静默回落到 md', async () => {
    const r = await j(
      `/api/notes/${encodeURIComponent(subject.uid)}/export?what=mindmap&format=xyzzy`,
    );
    judge(
      checkRejection({
        status: r.status,
        body: r.body,
        expectStatus: 400,
        expectCode: ERROR_CODES.badFormat,
        label: '未知 format',
      }),
    );
    return `HTTP 400 ${ERROR_CODES.badFormat}`;
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
    judge(checkNoteCreated({ status: created.status, noteUid: newUid }));
    return `noteUid=${newUid}`;
  });

  await check('F5-a2 PATCH 改标题 → GET 读得回来', async () => {
    const t2 = `E2E 改过的标题 ${NONCE}`;
    const p = await j(`/api/notes/${encodeURIComponent(newUid)}`, jsonReq({ title: t2 }, 'PATCH'));
    const g = await j(`/api/notes/${encodeURIComponent(newUid)}`);
    judge(
      checkTitleRoundTrip({
        patchStatus: p.status,
        getStatus: g.status,
        title: g.body?.title,
        expectTitle: t2,
      }),
    );
    return t2;
  });

  // 媒体未加载完这一档的**服务端半条链**（见第 10 节）：现在就把它取下来。
  const freshDetail = await j(`/api/notes/${encodeURIComponent(newUid)}`);

  /*
   * 🔴 **这条检查的名字比它做的事多一半**（登记，本轮不改判据）：
   *   id 说「PUT /star **与 PUT /folder** 各自生效」，而函数体里**一个字都没提 folder**。
   *   `PUT /folder` 真正被验到是在第 8 节的 F5-b1（建文件夹 → 移入 → 按 folder 筛）。
   *   ⇒ 把 `PUT /folder` 整条路由弄坏，这一格照样绿，而总表上它的名字仍然写着 folder。
   *   本仓四种失效形态里的第④种：**注释型断言 —— 声称一件从没发生的事**。
   *
   * ⚠️ 只改名字不动判据是最小修法，但 id 会进凭证与总表，改它要跟 attest 那侧对一遍，
   *   不在这一轮的范围（这一轮是让判据可测）。已上报。
   */
  await check('F5-a3 PUT /star 与 PUT /folder 各自生效', async () => {
    const s = await j(
      `/api/notes/${encodeURIComponent(newUid)}/star`,
      jsonReq({ starred: true }, 'PUT'),
    );
    const g = await j(`/api/notes/${encodeURIComponent(newUid)}`);
    judge(
      checkStarApplied({
        putStatus: s.status,
        putStarred: s.body?.starred,
        rereadStarred: g.body?.starred,
      }),
    );
    return 'starred=true';
  });

  // 删之前先埋一个只属于这条笔记的词，好验"删完搜不到"。
  const DEL_WORD = `删除样本${NONCE}`;
  await j(`/api/notes/${encodeURIComponent(newUid)}`, jsonReq({ bodyText: DEL_WORD }, 'PATCH'));
  const beforeDel = await j(`/api/search?q=${encodeURIComponent(DEL_WORD)}&limit=20`);

  let deletedGet = null;
  await check('F5-a4 DELETE 之后：列表里没有了、搜索也搜不到了', async () => {
    /*
     * 前提：删之前**搜得到** —— 否则"删完搜不到"是恒真的。
     * ⚠️ 这一格必须在 DELETE **之前**判：前提不成立时不该把笔记删掉，
     *    否则后面 F5-a5 / F5-a6 会在一个半拉状态上判红，指错方向。
     */
    const before = (beforeDel.body?.hits ?? []).filter((h) => h.noteUid === newUid);
    judge(checkSearchablePremise({ hits: beforeDel.body?.hits, noteUid: newUid }));

    const d = await j(`/api/notes/${encodeURIComponent(newUid)}`, { method: 'DELETE' });
    const l = await j('/api/notes?limit=200');
    const after = await j(`/api/search?q=${encodeURIComponent(DEL_WORD)}&limit=20`);
    judge(
      checkDeletionInvisible({
        deleteStatus: d.status,
        deleteOk: d.body?.ok,
        listUids: uidsOfNotePage(l),
        afterHits: after.body?.hits,
        noteUid: newUid,
      }),
    );

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
    judge(checkNoteGone({ status: deletedGet.status, body: deletedGet.body }));
    return `HTTP 404 ${ERROR_CODES.noteNotFound}`;
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
      const star = await j(
        `/api/notes/${encodeURIComponent(newUid)}/star`,
        jsonReq({ starred: true }, 'PUT'),
      );
      const exp = await j(`/api/notes/${encodeURIComponent(newUid)}/export?what=mindmap&format=md`);
      /*
       * 🔴 `exportStatus` 那一格今天**证明不了任何东西**（登记在
       *    `checkDeletedNoteWritesRejected()` 的注释里，判据没动）：
       *    这条哑笔记从来没生成过导图，`content.ts` 对"笔记在、导图不在"也回 404
       *    （`NO_MINDMAP`）。把软删守卫从导出路由整个抽掉，这一格照样绿。
       */
      judge(
        checkDeletedNoteWritesRejected({
          patchStatus: patch.status,
          starStatus: star.status,
          exportStatus: exp.status,
        }),
      );
      return 'PATCH / PUT star / export 全是 404';
    },
  );

  /*
   * 变异：**同一个 `checkNoteGone()`** 拿去量一条**活着的**笔记 —— 必须红。
   * 否则"删掉的回 404"可能只是因为这个 uid 从来就不存在（拼错也 404）。
   */
  await mutation('F5-a5 的证伪能力（拿活着的笔记去量"必须 404"，必须红）', async () => {
    const alive = await j(`/api/notes/${encodeURIComponent(subject.uid)}`);
    judge(checkNoteGone({ status: alive.status, body: alive.body }));
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
  let folderList = null;
  await check('F5-b1 ?folder=<uid> 只返回该文件夹里的笔记（文件夹外的一条都不带）', async () => {
    judge(checkFolderCreated({ status: folderRes.status, folderUid }));
    folderList = await j(`/api/notes?folder=${encodeURIComponent(folderUid)}&limit=200`);
    // 主角笔记（jfk）在根目录，绝不该出现在这个文件夹里。
    judge(
      checkFolderFilter({
        page: folderList,
        insiderUid: inFolderUid,
        outsiderUid: subject.uid,
        expectTotal: 1,
      }),
    );
    return `folder=${folderUid} total=${folderList.body?.total}`;
  });

  await mutation('F5-b1 的证伪能力（同一个"不在结果里"谓词量文件夹内那条，必须红）', () => {
    judge(
      checkAbsentFromList({
        page: folderList,
        uid: inFolderUid,
        label: '文件夹内那条笔记',
      }),
    );
  });

  await check('F5-b2 不存在的 folder uid 被拒（400），不是静默回落到"全部"', async () => {
    const l = await j('/api/notes?folder=00000000000000000000000000');
    judge(
      checkRejection({
        status: l.status,
        body: l.body,
        expectStatus: 400,
        expectCode: ERROR_CODES.badQueryParam,
        label: '未知 folder',
      }),
    );
    return `HTTP 400 ${ERROR_CODES.badQueryParam}`;
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
    judge(checkStarredPagination({ pages, pageSize: PAGE, oldestStarredUid: oldestStarred }));
    const total = Number(page1.body?.total);
    return `total=${total}，翻 ${pages.length} 页覆盖 ${seen.size} 条，含最早那条`;
  });

  /*
   * 变异：只看第一页（老 bug 的行为）时，最早那条**必须**不在 —— 证明边界真的跨过了。
   * 用的是 `checkStarredPagination()` 内部同一个 `uidsOfNotePage()`。
   */
  await mutation('F5-c1 的证伪能力（只看第一页时，最早那条星标笔记必须查不到）', () => {
    const firstPageUids = new Set(uidsOfNotePage(page1));
    eq(firstPageUids.has(oldestStarred), true, '最早那条星标笔记在第 1 页里');
  });

  await check('F5-c2 starred 筛的是"筛"，不是把全部都返回', async () => {
    const all = await j('/api/notes?limit=1');
    const totalAll = Number(all.body?.total);
    const totalStar = Number(page1.body?.total);
    judge(checkStarredIsFilter({ totalAll, totalStarred: totalStar, minUnstarred: 3 }));
    return `全量 ${totalAll} · 星标 ${totalStar}`;
  });

  /*
   * ⚠️ 这一条**刻意只钉状态码、不钉错误码**，与抽出前逐字一致
   *   （`expectCode: null`）。要不要连 `BAD_QUERY_PARAM` 一起钉是「改判什么」，
   *   不在这一轮。
   */
  await check('F5-c3 ?starred=0 被拒（400），不是被读成"未加星的"', async () => {
    const r = await j('/api/notes?starred=0');
    judge(
      checkRejection({
        status: r.status,
        body: r.body,
        expectStatus: 400,
        expectCode: null,
        label: '?starred=0',
      }),
    );
    return 'HTTP 400';
  });

  await check('F5-c4 offset 越过 total 时返回空页而不是报错或绕回第一页', async () => {
    const total = Number(page1.body?.total);
    const r = await j(`/api/notes?starred=1&limit=50&offset=${total + 100}`);
    judge(
      checkOffsetBeyondTotal({
        status: r.status,
        notes: r.body?.notes,
        hasMore: r.body?.hasMore,
      }),
    );
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
    judge(checkChineseSearchFindsSample({ responses: cnHits, words: CN_WORDS, noteUid: cnUid }));
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
    judge(checkSearchModes({ modes: m, expectTokenizer: 'simple', requireKeyword: true }));
    return JSON.stringify(m);
  });

  await check('F5-d3 /api/health 与 /api/selfcheck 也说分词器是 simple', async () => {
    const h = await j('/api/health');
    const e = h.body?.db?.extensions ?? {};
    const sc = await j('/api/selfcheck');
    const checks = sc.body?.checks ?? sc.body?.results ?? [];
    judge(
      checkTokenizerSelfReport({
        healthExtensions: e,
        selfcheckChecks: checks,
        expectTokenizer: 'simple',
      }),
    );
    const cn = checks.find((c) => c.id === CHINESE_SEARCH_CHECK_ID);
    return `tokenizer=${e.tokenizer} ${CHINESE_SEARCH_CHECK_ID}=${cn.status} · ${brief(cn.detail)}`;
  });

  /*
   * 变异：**同一个 `checkChineseSearchFindsSample()`** 拿去量一个语料里没有的两字词，
   * 必须红 —— 证明搜索不是"什么都返回"，也证明这条判据不是恒真。
   */
  await mutation('F5-d1 的证伪能力（语料里没有的两字词必须搜不到）', async () => {
    const absent = '紫檀';
    const r = await j(`/api/search?q=${encodeURIComponent(absent)}&limit=50`);
    judge(
      checkChineseSearchFindsSample({
        responses: { [absent]: r },
        words: [absent],
        noteUid: cnUid,
      }),
    );
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
    /*
     * ⚠️ 这里原本写的是「这一节改用降级判据」——**那是一句假话，代码里没有那个降级判据**。
     *   实际发生的是：下面 F5-e1 第一行 `ok(!!probeWord, …)` 当场抛，F5-e2 的
     *   `ok(!!segHit, …)` 跟着抛，两条**都判红**。`degraded[]` 也一条都不会多。
     *
     *   这条差别要紧：读日志的人看到"改用降级判据"会以为这一节体面地降级了，
     *   于是把随后那两条红归给产品；而真实成因是**夹具**——这台机器上的转写稿里
     *   一个 4 字母以上的英文词都没有。把话说准，红的时候才不会查错方向。
     *
     *   ⚠️ 也**不要**顺手把它改成"跳过"或第三态：本腿的口径是"前提构造不出来 =
     *   当场判红"（见文件头 §75 与第 3 节 `!subject` 那一处），这条口径正是
     *   e2e-notes.yml 里 `--undecided 0` 成立的全部依据。要改口径先改那边的论证。
     */
    say('   ⚠️ 转写稿里挑不出一个 4 字母以上的英文词 —— **下面 F5-e1／F5-e2 会判红**。');
    say('     那是夹具的前提没造出来（这台机器的转写稿里没有英文长词），不是产品坏了；');
    say('     本腿的口径是「前提构造不出来当场判红」，不假装跳过、也不记成未决。');
  }

  await check('F5-e1 segment 命中带得回可用的 startMs（?t= 的取值来源）', () => {
    judge(checkSegmentHit({ probeWord, hit: segHit, hits: searchForT?.body?.hits }));
    return `startMs=${segHit.startMs} seq=${segHit.seq}`;
  });

  await check(
    'F5-e2 越界边界：startMs 不超过这条笔记的 durationMs（夹取的上界存在且为正）',
    async () => {
      const d = await j(`/api/notes/${encodeURIComponent(subject.uid)}`);
      const dur = Number(d.body?.durationMs ?? 0);
      // 上界必须是正数：parseSeekParam 明写 durationMs<=0 时**不夹取**，
      // 也就是说上界一旦是 0，"越界夹到末尾"这条产品行为在结构上不可能发生。
      judge(checkSeekWithinDuration({ hit: segHit, durationMs: dur }));
      return `startMs=${segHit.startMs} ≤ durationMs=${dur}`;
    },
  );

  await check('F5-e3 媒体未加载完边界：时长未知时服务端如实回 0，不编一个数', () => {
    // freshDetail 是第 7 节刚导入、转写还没做完时取的那一份。
    judge(
      checkUnknownDurationIsZero({
        status: freshDetail.status,
        durationMs: freshDetail.body?.durationMs,
      }),
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
    const html = typeof r.body === 'string' ? r.body : r.text;
    judge(checkAppShell({ status: r.status, html }));
    return `HTTP 200，${html.length} 字符的应用外壳`;
  });

  /*
   * 变异：**同一个 `checkAppShell()`** 量一条用**非导航**请求（裸 fetch）打来的深链，
   * 必须红 —— 证明上面那个 200 是 SPA 兜底给的，而不是"什么路径都回 200"。
   */
  await mutation('F5-e4 的证伪能力（非导航请求打同一条深链，不该拿到应用外壳）', async () => {
    const r = await j(`/notes/${encodeURIComponent(subject.uid)}?t=0`);
    judge(checkAppShell({ status: r.status, html: typeof r.body === 'string' ? r.body : r.text }));
  });

  /* ───────────────── 12. 借了宿主几个 ───────────────── */

  hdr('12. 借宿主工具几个 —— 用产品自己的判据（GET /api/selfcheck）');
  const sc = await j('/api/selfcheck');
  const checks = sc.body?.checks ?? sc.body?.results ?? [];
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
  judge(checkToolProbesUsable({ status: sc.status, checks }));
  /*
   * 🔴 `borrowed` 那一档是**拿散文当判据**（`/PATH/i.test(detail)`）——
   *    已登记在 `classifyToolChecks()` 的注释里，判据没动。
   *    daemon 那句中文改一个词，这一档就恒为 0，而末尾那句
   *    「本轮结论：借了宿主 0 个」会朝着"更干净"的方向说假话，没有东西会红。
   */
  const { own, borrowed, missing } = classifyToolChecks(checks);
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
      judge(checkTokenizerDegraded({ extensions: me }));
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

    /*
     * ★★ 全脚本最值钱的一条：**把 F5-d1 那条断言原样搬过来量变异体，要求它红。**
     *
     * 抽出来之后这句"原样"第一次是字面意义上的 —— 两边调的是同一个
     * `checkChineseSearchFindsSample()`。抽出来之前那是两段抄写，
     * 而两段抄写只要有一段被改动，这条证明就悄悄变成了"证明另一条断言有牙齿"。
     */
    await mutation('★ F5-d1 的证伪能力（没有 libsimple 时，同一条断言必须红）', () => {
      judge(checkChineseSearchFindsSample({ responses: mutHits, words: CN_WORDS, noteUid: mnUid }));
    });

    await check('MUT-1 静默：没有 libsimple 时搜索仍然 HTTP 200，只是 0 条（不报错）', () => {
      judge(checkSilentDegradation({ responses: mutHits, words: CN_WORDS }));
      /*
       * ⚠️ 这句 detail 里的「0 条本样本命中」**不是这一格断言的** ——
       *   它由上一条变异（`★ F5-d1 的证伪能力`）判到 MUT-OK 来保证。
       *   这一格只钉"HTTP 200 + 一个错都不报"，也就是那个**静默**本身。
       */
      return '四个词全是 HTTP 200，一个错都不报（0 条本样本命中由上一条变异保证）—— 这就是那个静默';
    });

    // ★ 同一次键名收口（T-200 A-2）：变异实例退化时 modes.tokenizer 应如实报 'trigram'。
    await check('MUT-2 变异实例上 modes.tokenizer 如实报 trigram', () => {
      const m = mutHits[CN_WORDS[0]].body?.modes ?? {};
      judge(checkSearchModes({ modes: m, expectTokenizer: 'trigram' }));
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

/*
 * ★★ 缺席检测：**声明了 N 条变异，这一轮只出现了 M 行**。
 *
 * 上面那条地板只管「一条 MUT-OK 都没有」。它管不到「10 条里跑了 6 条」——
 * 而那正是整轮被掐断时的样子：`[CI 实测 run 31634339688 linux：10 条变异 0 行]` 变异 0 行，
 * 总表只是短了几行，**没有一个字说少的那几条去哪了**。
 *
 * N 从**这个脚本自己的源码**里数（`await mutation('<id>'` 的调用点就是注册表，
 * 不另立第二份清单 —— 那只是把一个漂移换成另一个）。缺席的补成
 * `MUT-UNKNOWN`(absent) 进总表 ⇒ 进「无从判断」⇒ **进凭证的覆盖面**。
 * 于是「这一轮少验了几条」第一次说得出口。
 *
 * ⚠️ 两条一起：
 *   · 正常轮 ⇒ 一条都不缺 ⇒ 这一段等于不存在，**不许因此变红**；
 *   · 掐断/绕过 ⇒ 缺席逐条列出 + `::warning`，但**仍然不计入 failed**
 *     （掐断本身已经红过一次了，重复计只是复述同一件事）。
 * ⚠️ 扫描非空地板：扫出 0 个调用点 = 提取器坏了，而它坏掉的表现恰恰是
 *   "从此永远没有缺席"。**那要当场红。**
 */
const declaredMutations = extractMutationIds(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
if (declaredMutations.length === 0) {
  failed += 1;
  say('');
  say('   ✘ 从本脚本源码里一条 `await mutation(...)` 都没扫到 —— **提取器坏了**。');
  say('     它坏掉的表现是"从此永远不报缺席"，所以这里当场红，而不是安静地少一项检查。');
}
const absent = absentMutations(declaredMutations, results);
for (const id of absent) {
  results.push({
    id,
    status: 'MUT-UNKNOWN',
    mutKind: 'absent',
    detail: '【这一轮根本没跑到】声明了但一行都没有 —— 整轮被掐断，或被分支绕过',
  });
}
if (absent.length > 0) {
  say('');
  say(
    `   ？ 本轮声明 ${declaredMutations.length} 条变异，其中 ${absent.length} 条**一行都没有**：`,
  );
  for (const id of absent) say(`     · ${id}`);
  say('     它们既没证明这条断言有牙齿，也没证明它没有 —— 已计入下面的「无从判断」。');
  const ann = absenceAnnotation(absent, declaredMutations.length);
  if (ann) say(ann);
}

hdr('汇总');
say('   id                                                                  结果');
say('   ' + '-'.repeat(88));
for (const r of results) {
  say(`   ${String(r.id).padEnd(66)} ${r.status}`);
}
say('');
const pass = results.filter((r) => r.status === 'PASS').length;
const mut = results.filter((r) => r.status === 'MUT-OK').length;
const undec = results.filter((r) => r.status === 'MUT-UNKNOWN' || r.status === 'UNDECIDED');
say(
  `   断言通过 ${pass} 条 · 变异证明 ${mut} 条 · 失败 ${failed} 条 · 无从判断 ${undec.length} 条`,
);

/* ═══════════════════════════════════════════════════════════════════════════════
 * ★ 「这条腿结构上不产生未决」那句话的看门狗（#77 notes 腿）—— **那句话已经过期了**
 *
 * ## 它**曾经**为什么成立（原文保留，因为它当时是对的）
 *
 * `e2e-notes.yml` 的 attest 作业据此写死 `--undecided 0`（凭证的覆盖面那一格）。
 * 那句话在 #77 到 #64 之间**为真**，理由是本文件是**两态**的：每一处「前提在这台
 * runner 上构造不出来」都当场判 FAIL，从不留成第三态 ——
 *   · 第 3 节没有带转写稿的笔记 → `throw`（红）
 *   · 转写稿是空的 → `ok()` 抛（红）
 *   · 第 11 节挑不出探针词 → F5-e1／F5-e2 抛（红）
 * 而判红的 run 里 `needs: [e2e]` 会让 attest 作业直接不跑，凭证根本不会发出来。
 *
 * 当时还写了这么一句预言：
 *
 *   > ⚠️ **「恒为 0」是一句会过期的话**。下一个人只要往 `results` 里推一个新状态
 *   > （`'SKIP'` / `'UNDECIDED'` / `'DEGRADED'` …），yml 里那个 `0` **不会跟着变**，
 *   > 于是它从「我们查过」悄悄变成「我们以为查过」。
 *
 * ## **什么时候起不再成立**：本轮（#64 的后续），`mutation()` 开始产出 `MUT-UNKNOWN`
 *
 * `mutation()` 现在按抛出的类型分档，「这条腿自己炸了」判 `MUT-UNKNOWN` 而不再
 * 冒充「如期变红」。**那正是上面预言的那个新状态。** 于是：
 *   · 写死的 `--undecided 0` 变成一句假话 ⇒ 已改成**真的去数**
 *     （`--undecided-out` → `sum-undecided.mjs` → `emit-e2e-attestation --undecided`）；
 *   · `MUT-UNKNOWN` 进 `KNOWN_STATUSES` —— **不是给看门狗开例外**，
 *     是把它守着的那段论证换成了新的那一段。
 *
 * ## 这根桩今天守什么
 *
 * 换了宾语，判据没松：**再出现任何计划外的 status 仍然当场红**。只不过要检查的
 * 那件事从「`--undecided 0` 还成立吗」变成了「新状态该不该被数进 `undec`」——
 * 因为现在 `undec` 是一条**真管道**，漏一个状态名，凭证的覆盖面就又开始少数东西。
 * 靠注释维持的约定，下一个人一定会破坏；靠一条会红的断言维持的约定，不会。
 * ═══════════════════════════════════════════════════════════════════════════════ */
const KNOWN_STATUSES = new Set(['PASS', 'FAIL', 'MUT-OK', 'MUT-BAD', 'MUT-UNKNOWN', 'ABORTED']);
const unexpectedStatuses = [...new Set(results.map((r) => r.status))].filter(
  (s) => !KNOWN_STATUSES.has(s),
);
if (unexpectedStatuses.length > 0) {
  failed += 1;
  say('');
  say(`   ✘ 总表里出现了计划外的状态：${unexpectedStatuses.join(', ')}`);
  say('     凭证的覆盖面那一格现在是**真数出来的**（--undecided-out → sum-undecided.mjs），');
  say('     数的是 `undec` 那一句里列举的状态名。多出一个状态 = 那句列举**可能已经漏了它**：');
  say('     如果新状态表示「这条断言没能被评估」，它必须进 `undec`，否则凭证会少数东西 ——');
  say('     那正是这条管道当初要消灭的东西（`null` vs `0`：没查 vs 查过了确实没有）。');
  say('     请连同 e2e-notes.yml 里那段论证一起更新，别只把这个名字加进 KNOWN_STATUSES。');
}
/*
 * ★ 覆盖面落盘。**不看 failed** —— 这是覆盖面计数不是判定，红也要如实落盘。
 *
 * ⚠️ 🔴 **`unknowns` 是一个把两件事加在一起的整数**（已知限制，2026-08-17 登记）：
 *   · 「这条**断言**没能被评估」（`UNDECIDED`）；
 *   · 「这条**变异**什么都没证明」（`MUT-UNKNOWN`：前提没构造出来 / 腿炸了 / 根本没跑到）。
 *   两者的**补救完全不同**：crash 那支要去修**测试**，premise 那支是这台机器没条件。
 *   控制台把它们分开列了（见上面两段），**而这个整数把它们加成了一个数**。
 *   拆开要动凭证 schema 更多，不在这一轮 —— 但别让下一个人以为它是单一含义的。
 *
 * ★ `unverified` 是**同一份文件里的另一格**：哪几条变异什么都没证明。
 *   它喂给 `collect-unverified-mutations.mjs`，最终变成凭证的
 *   `mutations: ran|ran-unverified` + `unverifiedMutations`。
 *   ⚠️ 与 `unknowns` **不是同一个集合**：`unknowns` 还含断言级的 `UNDECIDED`。
 */
const unverifiedMut = results.filter((r) => r.status === 'MUT-UNKNOWN').map((r) => String(r.id));
if (UNDECIDED_OUT) {
  mkdirSync(dirname(UNDECIDED_OUT), { recursive: true });
  writeFileSync(
    UNDECIDED_OUT,
    `${JSON.stringify({ unknowns: undec.length, unverified: unverifiedMut }, null, 2)}\n`,
  );
  say(
    `   覆盖面已写到 ${UNDECIDED_OUT}（unknowns=${undec.length}` +
      ` · 其中变异未验证 ${unverifiedMut.length} 条）`,
  );
}
if (undec.length > 0) {
  say('');
  say('   ？ 本轮无从判断（这一轮没验到，别当成绿）：');
  for (const r of undec) say(`     · ${r.id} —— ${r.detail}`);
}
/*
 * ★ 「这条腿自己炸了」单独再列一次：它和「前提没构造出来」同为 MUT-UNKNOWN、
 *   同样不计入 failed，但**下一步不同** —— 前者要去修**测试**，后者是这台机器
 *   本来就没条件。混着列，"测试坏了"会被当成"没条件"而永远没人去修。
 */
const crashed = results.filter((r) => r.mutKind === 'crash');
if (crashed.length > 0) {
  say('');
  say(`   ⚠️ 其中 ${crashed.length} 条是**这条腿自己炸了**，不是"这台机器没条件"：`);
  for (const r of crashed) say(`     · ${r.id} —— ${r.detail}`);
  say('     这些要去修**测试**（选择器 / 超时预算 / 端口），不是去修产品，也不是等下一轮。');
}
/*
 * ★ 变异地板（照抄 browser 腿，理由逐字相同）：**这一轮至少要有一条变异判到 MUT-OK。**
 *
 * `MUT-UNKNOWN` 刻意不计入 failed，所以「`ok()` 不再抛 `AssertionFailed` 了」
 * （改错 import、有人换回裸 `Error`）的表现是**10 条变异悄悄全变 UNKNOWN，
 * 整条腿照样绿** —— 一种比它替换掉的那个更安静的假绿。
 * 单元证明（`selftest-mutation-verdict.mjs`）证的是判据本身，**证不到接线**。
 *
 * 取"至少 1 条"而不是"10 条"：个别变异在某台 runner 上炸掉是可以容忍的，
 * 钉死条数会造出一盏为合法情况常亮的灯。`[实测语料 30 轮]` 每格都是 10 条 MUT-OK，
 * 地板离现状很远。整轮被掐断时让路 —— 那时 `failed` 已经因为中断加过一次。
 */
const abortedRun = results.some((r) => r.status === 'ABORTED');
const mutTotal = results.filter((r) => String(r.status).startsWith('MUT-')).length;
if (!abortedRun && mut === 0) {
  failed += 1;
  say('');
  say(`   ✘ 这一轮登记了 ${mutTotal} 条变异，**没有一条**判到 MUT-OK。`);
  say('     变异证明不计入失败的那两档（前提没构造出来 / 腿炸了）把整套证明吃光了 ——');
  say('     多半是 `ok()` → `AssertionFailed` → `MUT-OK` 这条接线断了，');
  say('     而它断掉的表现恰恰是"什么都不说"。先看上面每条变异各自是哪一档。');
  if (mutTotal === 0) {
    say('     （登记数是 0：变异那几段**根本没跑到**，而缺席在总表里只表现为少几行。）');
  }
}
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
